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
  type ConnectLookup,
  type ConnectRegistered,
  type ConnectState,
  CreateConnectCodeRequestSchema,
  connectFingerprint,
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
// `@tender/shared`'s `connect.ts`, the table in `@tender/db`'s migration 0007).
//
//   POST /v1/connect/codes          signed in, with a full-access key: a code for `<name>.<you>`
//   GET  /v1/connect/codes/:id      signed in as the code's owner: how the code stands
//   POST /v1/connect/lookup         the code in the body: what it is for (the agent's first look)
//   POST /v1/connect/attach         the code and a public key in the body: the agent's key, once
//   POST /v1/connect/registered     the code in the body: the agent has registered, and the index
//                                    shows it
//
// A code is the credential of the three routes no account signs, so it travels in a body and never
// in a path, where logs keep it, and only its SHA-256 is stored. Every answer is `no-store`. What a
// code allows is little: one public key, attached once, within 30 minutes, to an account that only
// the owner's wallet can create. Each refusal says what to do next.
//
// The order of the checks, and the first fault is the answer:
//
//   429  over the client's limit (every route but the owner's read), then for the signed-in routes
//        401 not signed in and 429 over the account's own limit;
//   403  `full_access_required`: a code is made only by an account's own key;
//   413  `payload_too_large` for a body over 16 KiB, which is refused as it arrives;
//   400  the body is not what the route takes: a string with an invisible or control character is
//        refused first, in the question board's words, then its shape, then the account the name
//        makes under the owner's (`readAgentName`, in the words the web page uses);
//   404  no such code (or not the caller's: the answer is the same);
//   409  `already_attached` (another key has the code), `not_attached`, `not_registered`;
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
}

/** The columns of a `CodeRow`, for a `select` or a `returning`. */
const COLUMNS =
  "id, owner, name, account_id, created_at, expires_at, public_key, attached_at, registered_at";

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

  /** What the agent is told of a code: what it is for, where, and how it stands. */
  function lookupOf(row: CodeRow): ConnectLookup {
    return {
      owner: row.owner,
      name: row.name,
      account_id: row.account_id,
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
      // Rows that have been kept their day after expiry go, so the table does not grow with use.
      await tx.query("delete from connect_codes where expires_at < $1::timestamptz", [
        isoAt(now, -CONNECT_KEEP_MS),
      ]);
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

  app.get("/connect/codes/:id", requireAuth, perReader, async (c) => {
    const id = c.req.param("id");
    const [row] = ID_SHAPE.test(id)
      ? await deps.db.query<CodeRow>(
          `select ${COLUMNS} from connect_codes where id = $1 and owner = $2`,
          [id, c.var.account],
        )
      : [];
    // Another owner's code is answered as no code at all.
    if (row === undefined) return notFound("no such connect code");
    const body: ConnectCodeState = {
      id: row.id,
      owner: row.owner,
      name: row.name,
      account_id: row.account_id,
      state: stateOf(row, nowMs()),
      created_at: row.created_at.toISOString(),
      expires_at: row.expires_at.toISOString(),
      public_key: row.public_key,
      fingerprint: row.public_key === null ? null : connectFingerprint(row.public_key),
      attached_at: row.attached_at?.toISOString() ?? null,
      registered_at: row.registered_at?.toISOString() ?? null,
      agent: await agentOf(row.account_id),
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

  app.post("/connect/registered", perClient, tooLarge, async (c) => {
    const { code } = await bodyOf(c, ConnectCodeRequestSchema);
    const row = await requireCode(code);
    if (row.public_key === null) {
      return fail(409, "not_attached", "no key is attached to this code, so nothing registered");
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
