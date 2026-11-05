import { randomBytes } from "node:crypto";
import {
  AttachConnectKeyRequestSchema,
  CONNECT_CODE_ALPHABET,
  CONNECT_CODE_CHARS,
  CONNECT_CODE_PREFIX,
  CONNECT_CODE_TTL_MS,
  CONNECT_KEEP_MS,
  type ConnectCodeCreated,
  ConnectCodeRequestSchema,
  type ConnectCodeState,
  type ConnectImplicitAgents,
  type ConnectLookup,
  type ConnectRegistered,
  type ConnectState,
  CreateConnectCodeRequestSchema,
  connectFingerprint,
  implicitAccountOf,
  readAgentName,
  sha256Hex,
} from "@tender/shared";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";
import type { AuthVariables, RequireAuth } from "../auth";
import { type ApiDeps, nowNs } from "../deps";
import { badRequest, type ErrorBody, fail, issuesOf, notFound, readJson } from "../format";
import { clientKey, RETRY_SOON, rateLimit, rateLimitsOf } from "../limits";

// "Connect your agent" (owner decision of 2026-11-04; the wire forms and the rules on text are in
// `@tender/shared`'s `connect.ts`, the table in `@tender/db`'s migration 0008).
//
//   POST /v1/connect/codes          signed in, with a full-access key: a code for `<name>.<you>`
//   GET  /v1/connect/codes/:id      signed in as the code's owner: how the code stands
//   POST /v1/connect/codes/:id/implicit
//                                   signed in as the code's owner, with a full-access key: the
//                                    agent gets the implicit account of its key instead of
//                                    `<name>.<you>` (the owner's wallet refused the sub-account)
//   GET  /v1/connect/implicit       signed in: the owner's agents set up as implicit accounts
//   POST /v1/connect/lookup         the code in the body: what it is for (the agent's first look)
//   POST /v1/connect/attach         the code and a public key in the body: the agent's key, once
//   POST /v1/connect/contest        the code in the body: the agent saw a key that is not its own
//   POST /v1/connect/registered     the code in the body: the agent has registered, and the index
//                                    shows it
//
// THE ACCOUNT. A code is for `<name>.<owner>` (`account_kind` `sub_account`) until its owner, with a
// key attached and no contest and no registration yet, chooses the implicit account of that key
// (`implicit`). The API works out that account from the key it holds; nothing in the request names
// it. The choice is made once and kept. A row with `implicit` and no contest is never deleted: it
// is the owner's only record of the agent, since the chain gives an implicit account no provider.
//
// CONTESTED. A code takes one key. When a second, different key tries it (an attach with another
// key, or the agent saying with `contest` that the key attached is not its own), someone else has
// the code: the row records `contested_at`, every read says `contested`, and the owner's page
// creates and funds nothing for it. Nothing secret is sent to contest a code.
//
// A code is the credential of the four routes no account signs, so it travels in a body and never
// in a path, where logs keep it, and only its SHA-256 is stored. Every answer is `no-store`. What a
// code allows is little: one public key, attached once, within 30 minutes, to an account that only
// the owner's wallet can create. Each refusal says what to do next.
//
// The order of the checks, and the first fault is the answer:
//
//   429  over the client's limit (every route but the owner's read), then for the signed-in routes
//        401 not signed in and 429 over the account's own limit;
//   413  `payload_too_large` for a body over 16 KiB, which is refused as it arrives (middleware,
//        before the route itself looks at the key);
//   403  `full_access_required`: a code is made only by an account's own key;
//   400  the body is not what the route takes: a string with an invisible or control character is
//        refused first, in the question board's words, then its shape, then the account the name
//        makes under the owner's (`readAgentName`, in the words the web page uses);
//   404  no such code (or not the caller's: the answer is the same);
//   409  `already_attached` (another key has the code; the code is marked contested), `not_attached`,
//        `not_registered`, `contested`, `already_registered` (an agent registered with the code's
//        sub-account, so it is too late to choose another);
//   410  `code_expired`: no key came in the 30 minutes.

/** As the question board's writes: a body over this is refused as it arrives, never parsed. */
const MAX_BODY_BYTES = 16_384;

/** A code is a secret until it is used, and an answer is for one caller: no cache keeps either. */
const NOT_CACHED = { "Cache-Control": "no-store" };

/** The bytes of a code's id: 16, which is 22 characters of base64url. */
const ID_BYTES = 16;
const ID_SHAPE = /^[A-Za-z0-9_-]{22}$/;

/** A row of `connect_codes`, with its times as the database gives them. */
interface CodeRow {
  id: string;
  owner: string;
  name: string;
  account_id: string;
  created_at: Date;
  expires_at: Date;
  public_key: string | null;
  attached_at: Date | null;
  registered_at: Date | null;
  contested_at: Date | null;
  account_kind: "sub_account" | "implicit";
}

/** The columns of a `CodeRow`, for a `select` or a `returning`. */
const COLUMNS =
  "id, owner, name, account_id, created_at, expires_at, public_key, attached_at, registered_at, " +
  "contested_at, account_kind";

/** How many implicit agents `GET /v1/connect/implicit` lists, newest first. */
const MAX_IMPLICIT_AGENTS = 100;

/** `ns` nanoseconds since the epoch, moved by `plusMs`, as ISO 8601 in UTC to the millisecond. */
function isoAt(ns: bigint, plusMs = 0): string {
  return new Date(Number(ns / 1_000_000n) + plusMs).toISOString();
}

/** A new code: the prefix and 26 characters of the alphabet, each from 5 random bits. */
function newCode(): string {
  const bytes = randomBytes(CONNECT_CODE_CHARS);
  let code = CONNECT_CODE_PREFIX;
  // 32 divides 256, so each character is uniform.
  for (const byte of bytes) code += CONNECT_CODE_ALPHABET[byte % CONNECT_CODE_ALPHABET.length];
  return code;
}

/** Where a row stands at `nowMs`. */
function stateOf(row: CodeRow, nowMs: number): ConnectState {
  if (row.contested_at !== null) return "contested";
  if (row.registered_at !== null) return "registered";
  if (row.public_key !== null) return "attached";
  return row.expires_at.getTime() > nowMs ? "waiting" : "expired";
}

/** The body of a request, once it fits `schema`: a 400 with the faults otherwise. */
async function bodyOf<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  const parsed = schema.safeParse(await readJson(c));
  if (!parsed.success) {
    return badRequest("the body does not fit its schema", issuesOf(parsed.error));
  }
  return parsed.data;
}

/** A 409 that says to come back in a few seconds: the index has not caught up yet. */
function notYet(error: string, message: string): never {
  const body: ErrorBody = { error, message };
  throw new HTTPException(409, {
    res: Response.json(body, { status: 409, headers: RETRY_SOON }),
    message,
  });
}

export function connectRoutes(
  deps: ApiDeps,
  requireAuth: RequireAuth,
): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const limits = rateLimitsOf(deps.rateLimits);
  type Env = { Variables: AuthVariables };
  const perClient = rateLimit<Env>(limits.connectClient, (c) =>
    clientKey(c, deps.trustedProxyHops ?? 0),
  );
  const perOwner = rateLimit<Env>(limits.connectCreate, (c) => c.var.account);
  const perReader = rateLimit<Env>(limits.connectRead, (c) => c.var.account);
  const tooLarge = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => {
      const body: ErrorBody = {
        error: "payload_too_large",
        message: "the request body is too large",
      };
      return c.json(body, 413);
    },
  });

  const nowMs = () => Number(nowNs(deps) / 1_000_000n);

  /** The row of `code`, or null. The code is looked up by its hash: no code is stored. */
  async function rowOfCode(code: string): Promise<CodeRow | null> {
    const [row] = await deps.db.query<CodeRow>(
      `select ${COLUMNS} from connect_codes where code_sha256 = $1`,
      [sha256Hex(code)],
    );
    return row ?? null;
  }

  /** The row of `code`, or a 404: a code never made, and one deleted, are answered alike. */
  async function requireCode(code: string): Promise<CodeRow> {
    const row = await rowOfCode(code);
    if (row === null) {
      return notFound("no such connect code: ask the owner for a new one on the Add an agent page");
    }
    return row;
  }

  /** Records, once, that a second key tried the code. The first time is the one kept. */
  async function markContested(id: string): Promise<void> {
    await deps.db.query(
      "update connect_codes set contested_at = $2::timestamptz where id = $1 and contested_at is null",
      [id, isoAt(nowNs(deps))],
    );
  }

  /** What the agent is told of a code: what it is for, where, and how it stands. */
  function lookupOf(row: CodeRow): ConnectLookup {
    return {
      owner: row.owner,
      name: row.name,
      account_id: row.account_id,
      account_kind: row.account_kind,
      network: deps.network,
      contract: deps.contractId,
      state: stateOf(row, nowMs()),
      expires_at: row.expires_at.toISOString(),
      fingerprint: row.public_key === null ? null : connectFingerprint(row.public_key),
    };
  }

  /** The agent as the index holds it, or null. */
  async function agentOf(account: string): Promise<ConnectCodeState["agent"]> {
    const [agent] = await deps.db.query<{
      status: "active" | "unregistering" | "retired";
      bond_token: string | null;
      bond_amount: string | null;
    }>(
      "select status, bond_token, bond_amount::text as bond_amount from agents where account = $1",
      [account],
    );
    return agent ?? null;
  }

  // ---- The owner ------------------------------------------------------------------------------

  app.post("/connect/codes", perClient, requireAuth, perOwner, tooLarge, async (c) => {
    const owner = c.var.account;
    // A code lets a key be put on an account the owner's wallet then creates; only the account's
    // own key, which a wallet signs in with, may ask for one. A function-call key, such as an
    // agent's own, may not.
    if (c.var.keyKind !== "full_access") {
      return fail(
        403,
        "full_access_required",
        "sign in with your wallet (a full-access key) to make a connect code",
      );
    }
    const { name } = await bodyOf(c, CreateConnectCodeRequestSchema);
    const reading = readAgentName(name, owner);
    if (!reading.ok) {
      return badRequest("the body does not fit its schema", [
        { path: ["name"], message: reading.message, code: "custom" },
      ]);
    }
    const now = nowNs(deps);
    const code = newCode();
    const created: ConnectCodeCreated = {
      id: randomBytes(ID_BYTES).toString("base64url"),
      code,
      owner,
      name: name.trim(),
      account_id: reading.accountId,
      expires_at: isoAt(now, CONNECT_CODE_TTL_MS),
    };
    await deps.db.tx(async (tx) => {
      // Rows that have been kept their day after expiry go, so the table does not grow with use;
      // an implicit agent's row stays, as it is the owner's only record of it.
      await tx.query(
        `delete from connect_codes where expires_at < $1::timestamptz
          and (account_kind = 'sub_account' or contested_at is not null)`,
        [isoAt(now, -CONNECT_KEEP_MS)],
      );
      await tx.query(
        `insert into connect_codes (id, code_sha256, owner, name, account_id, created_at, expires_at)
         values ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz)`,
        [
          created.id,
          sha256Hex(code),
          owner,
          created.name,
          created.account_id,
          isoAt(now),
          created.expires_at,
        ],
      );
    });
    return c.json(created, 200, NOT_CACHED);
  });

  /** How a row stands, for its owner's page. */
  async function codeStateOf(row: CodeRow): Promise<ConnectCodeState> {
    return {
      id: row.id,
      owner: row.owner,
      name: row.name,
      account_id: row.account_id,
      account_kind: row.account_kind,
      state: stateOf(row, nowMs()),
      created_at: row.created_at.toISOString(),
      expires_at: row.expires_at.toISOString(),
      public_key: row.public_key,
      fingerprint: row.public_key === null ? null : connectFingerprint(row.public_key),
      attached_at: row.attached_at?.toISOString() ?? null,
      registered_at: row.registered_at?.toISOString() ?? null,
      contested_at: row.contested_at?.toISOString() ?? null,
      agent: await agentOf(row.account_id),
    };
  }

  /** The caller's own code `id`, or null: another owner's code is answered as no code at all. */
  async function ownRow(id: string, owner: string): Promise<CodeRow | null> {
    if (!ID_SHAPE.test(id)) return null;
    const [row] = await deps.db.query<CodeRow>(
      `select ${COLUMNS} from connect_codes where id = $1 and owner = $2`,
      [id, owner],
    );
    return row ?? null;
  }

  app.get("/connect/codes/:id", requireAuth, perReader, async (c) => {
    const row = await ownRow(c.req.param("id"), c.var.account);
    if (row === null) return notFound("no such connect code");
    return c.json(await codeStateOf(row), 200, NOT_CACHED);
  });

  app.post("/connect/codes/:id/implicit", requireAuth, perReader, tooLarge, async (c) => {
    // As for a code: only the account's own key, which a wallet signs in with, chooses where the
    // agent's account is.
    if (c.var.keyKind !== "full_access") {
      return fail(
        403,
        "full_access_required",
        "sign in with your wallet (a full-access key) to choose the agent's account",
      );
    }
    const id = c.req.param("id");
    const owner = c.var.account;
    const row = await ownRow(id, owner);
    if (row === null) return notFound("no such connect code");
    if (row.public_key === null) {
      return fail(409, "not_attached", "no key is attached to this code yet, so it has no account");
    }
    if (row.contested_at !== null) {
      return fail(
        409,
        "contested",
        "two different keys tried this code, so it is refused: start over with a new code",
      );
    }
    if (row.account_kind === "implicit") return c.json(await codeStateOf(row), 200, NOT_CACHED);
    if (row.registered_at !== null) {
      return fail(
        409,
        "already_registered",
        `${row.account_id} registered already, so the agent keeps that account`,
      );
    }
    // The account is the key's own, worked out here from the key the row holds.
    const implicit = implicitAccountOf(row.public_key);
    if (implicit === null) throw new Error("a connect code holds a key that is not an ed25519 key");
    // One guarded statement: a contest or a registration that came in between is not overwritten.
    const [moved] = await deps.db.query<CodeRow>(
      `update connect_codes set account_kind = 'implicit', account_id = $3
        where id = $1 and owner = $2 and account_kind = 'sub_account' and public_key is not null
          and contested_at is null and registered_at is null
        returning ${COLUMNS}`,
      [id, owner, implicit],
    );
    if (moved !== undefined) return c.json(await codeStateOf(moved), 200, NOT_CACHED);
    // Something changed in between: answer by what the row says now.
    const now = await ownRow(id, owner);
    if (now === null) return notFound("no such connect code");
    if (now.account_kind === "implicit") return c.json(await codeStateOf(now), 200, NOT_CACHED);
    return fail(
      409,
      now.contested_at !== null ? "contested" : "already_registered",
      now.contested_at !== null
        ? "two different keys tried this code, so it is refused: start over with a new code"
        : `${now.account_id} registered already, so the agent keeps that account`,
    );
  });

  app.get("/connect/implicit", requireAuth, perReader, async (c) => {
    const rows = await deps.db.query<{
      account_id: string;
      name: string;
      created_at: Date;
      status: "active" | "unregistering" | "retired" | null;
      bond_token: string | null;
      bond_amount: string | null;
    }>(
      `select c.account_id, c.name, c.created_at, a.status, a.bond_token,
              a.bond_amount::text as bond_amount
         from connect_codes c left join agents a on a.account = c.account_id
        where c.owner = $1 and c.account_kind = 'implicit' and c.contested_at is null
        order by c.created_at desc, c.id
        limit ${MAX_IMPLICIT_AGENTS}`,
      [c.var.account],
    );
    const body: ConnectImplicitAgents = {
      agents: rows.map((row) => ({
        account_id: row.account_id,
        name: row.name,
        created_at: row.created_at.toISOString(),
        agent:
          row.status === null
            ? null
            : { status: row.status, bond_token: row.bond_token, bond_amount: row.bond_amount },
      })),
    };
    return c.json(body, 200, NOT_CACHED);
  });

  // ---- The agent ------------------------------------------------------------------------------

  app.post("/connect/lookup", perClient, tooLarge, async (c) => {
    const { code } = await bodyOf(c, ConnectCodeRequestSchema);
    return c.json(lookupOf(await requireCode(code)), 200, NOT_CACHED);
  });

  app.post("/connect/attach", perClient, tooLarge, async (c) => {
    const { code, public_key: publicKey } = await bodyOf(c, AttachConnectKeyRequestSchema);
    const now = nowNs(deps);
    // One guarded statement: of any number of attachments of one code, one gets its row back.
    const [taken] = await deps.db.query<CodeRow>(
      `update connect_codes set public_key = $2, attached_at = $3::timestamptz
        where code_sha256 = $1 and public_key is null and expires_at > $3::timestamptz
        returning ${COLUMNS}`,
      [sha256Hex(code), publicKey, isoAt(now)],
    );
    if (taken !== undefined) return c.json(lookupOf(taken), 200, NOT_CACHED);

    const row = await requireCode(code);
    // The same key again is the agent asking twice (its first answer was lost): the same answer.
    if (row.public_key === publicKey) return c.json(lookupOf(row), 200, NOT_CACHED);
    if (row.public_key !== null) {
      // A second, different key: someone else has the code. The owner's page is told.
      await markContested(row.id);
      return fail(
        409,
        "already_attached",
        "this code has another key attached already, and a code takes one key: do not create the " +
          "account; ask the owner for a new code",
      );
    }
    return fail(
      410,
      "code_expired",
      "this code took no key in its 30 minutes and has expired: ask the owner for a new code",
    );
  });

  app.post("/connect/contest", perClient, tooLarge, async (c) => {
    const { code } = await bodyOf(c, ConnectCodeRequestSchema);
    const row = await requireCode(code);
    if (row.public_key === null) {
      return fail(
        409,
        "not_attached",
        "no key is attached to this code, so there is nothing to contest",
      );
    }
    await markContested(row.id);
    return c.json(lookupOf(await requireCode(code)), 200, NOT_CACHED);
  });

  app.post("/connect/registered", perClient, tooLarge, async (c) => {
    const { code } = await bodyOf(c, ConnectCodeRequestSchema);
    const row = await requireCode(code);
    if (row.public_key === null) {
      return fail(409, "not_attached", "no key is attached to this code, so nothing registered");
    }
    if (row.contested_at !== null) {
      return fail(
        409,
        "contested",
        "two different keys tried this code, so the owner's page does not take it: ask the owner for a new code",
      );
    }
    if (row.registered_at === null) {
      // The agent's word is taken only once the index shows it: the page goes by the index.
      const agent = await agentOf(row.account_id);
      if (agent?.status !== "active") {
        return notYet(
          "not_registered",
          `the index does not show ${row.account_id} as an active agent yet: try again in a few seconds`,
        );
      }
      await deps.db.query(
        `update connect_codes set registered_at = $2::timestamptz
          where id = $1 and registered_at is null`,
        [row.id, isoAt(nowNs(deps))],
      );
    }
    const [done] = await deps.db.query<{ registered_at: Date }>(
      "select registered_at from connect_codes where id = $1",
      [row.id],
    );
    if (done === undefined) throw new Error("the connect code went while it was marked");
    const body: ConnectRegistered = {
      account_id: row.account_id,
      state: "registered",
      registered_at: done.registered_at.toISOString(),
    };
    return c.json(body, 200, NOT_CACHED);
  });

  return app;
}
