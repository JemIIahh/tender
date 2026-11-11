import { createPublicKey } from "node:crypto";
import { GasGiftRequestSchema, type GasGiftResponse } from "@tender/shared";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { type CryptoKey, importSPKI, jwtVerify } from "jose";
import { withinDeadline } from "../deadline";
import { type ApiDeps, type GasGift, nowNs } from "../deps";
import { badRequest, type ErrorBody, fail, issuesOf, readJson } from "../format";
import { clientKey, rateLimit, rateLimitsOf, unavailableForNow } from "../limits";

// The gas gift (owner decision of 2026-11-11; the wire form is the "Gas gift" block of
// `@tender/shared`'s `api.ts`, the table migration 0012).
//
//   POST /v1/gas-gift   bearer: the email login's access token; body: { account_id }
//
// The web app's email login (Privy) makes each person a NEAR implicit account, which holds no NEAR
// and is not on chain until someone sends it some. This route sends it a little testnet NEAR from
// the team's gift account, once per login and once per account, up to a total a day. It runs on
// testnet (and on the sandbox, for tests) only, and only with the gift set up (`ApiDeps.gasGift`).
//
// THE TOKEN. The bearer is the login's own access token, a JWT that Privy signs with ES256 for the
// app: it is verified with the app's verification key, for the issuer `privy.io` and the audience
// of the app's id, and its `sub` is the login's user id (`did:privy:...`). It is not a Tender
// sign-in, which an account that holds no NEAR cannot do yet. Every fault of a token gets the same
// 401, which names none of them, and no token is ever logged.
//
// The order of the checks, and the first fault is the answer:
//
//   503  `gift_off`: no gift is set up here, or this is mainnet;
//   429  `rate_limited`: over the client address's limit;
//   413  `payload_too_large`: a body over 4 KiB;
//   401  `unauthorized`: no token, or one that does not verify;
//   400  `bad_request` for a body that is not `{ account_id }`, and `not_implicit` for an account
//        that is not 64 lowercase hex characters;
//   409  `already_given`: this login, or this account, has had its gift (or it is on its way);
//   503  `unavailable`: the chain cannot say what the account holds right now (`Retry-After: 5`);
//   200  `not_needed`: the account holds `minBalance` or more already;
//   429  `daily_limit`: the gifts of this UTC day would go past the cap (`Retry-After`: the seconds
//        to the next UTC day);
//   502  `transfer_failed`: the transfer was not made. Its claim is let go, so asking again works.
//   200  `sent`, with the amount and the transfer's hash, once the transfer has executed.
//
// THE CLAIM. A gift's row is written before the transfer is sent, in a transaction that locks the
// table, checks the login, the account and the day's total, and inserts it: of two calls at once,
// one claims and the other is `already_given`, and the day's total can never pass the cap. A
// transfer that fails deletes the row. A row still `claimed` after `STALE_CLAIM_MS` belongs to a
// process that died mid-gift: the next claim deletes it, so that the login is not shut out.
//
// What the route does not know: which account the login's wallet is. The token says who logged in,
// not which account they hold, so a login can name any implicit account, once. The daily cap bounds
// what many logins can take together.

/** What the gift is unless `GAS_GIFT_AMOUNT` says otherwise: 0.1 NEAR. */
export const DEFAULT_GAS_GIFT_AMOUNT = 100_000_000_000_000_000_000_000n;
/** Below this the account gets a gift, unless `GAS_GIFT_MIN_BALANCE` says otherwise: 0.05 NEAR. */
export const DEFAULT_GAS_GIFT_MIN_BALANCE = 50_000_000_000_000_000_000_000n;
/** What all gifts of one UTC day may add up to, unless `GAS_GIFT_DAILY_CAP` says otherwise: 2 NEAR. */
export const DEFAULT_GAS_GIFT_DAILY_CAP = 2_000_000_000_000_000_000_000_000n;

/** The issuer of every token of the login, as Privy's documentation gives it. */
export const PRIVY_ISSUER = "privy.io";

/** How far the clocks of Privy and of this API may be apart, in seconds. */
const CLOCK_TOLERANCE_S = 30;

/** A body over this is refused as it arrives, never parsed: the body is one account id. */
const MAX_BODY_BYTES = 4_096;

/** The longest token read: one of the login's is under 1 KiB. */
const MAX_TOKEN_CHARS = 8_192;

/** `Bearer <JWT>`: three base64url parts. The scheme is case-insensitive. */
const BEARER = /^bearer +([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i;

/** A login's user id, as the `sub` of its token: `did:privy:` and printable characters. */
const PRIVY_USER = /^did:privy:[\x21-\x7e]{1,200}$/;

/** An implicit account: the 64 lowercase hex characters of an ed25519 public key. */
const IMPLICIT = /^[0-9a-f]{64}$/;

/** How long the chain has to say what an account holds. */
const BALANCE_DEADLINE_MS = 5_000;

/** How long a claim may wait for its transfer before it counts as left by a process that died. */
const STALE_CLAIM_MS = 10 * 60_000;

const DAY_MS = 24 * 60 * 60_000;

/** An answer is for one caller and one moment: no cache keeps it. */
const NOT_CACHED = { "Cache-Control": "no-store" };

/**
 * `text`, the verification key as Privy's dashboard shows it, as an SPKI PEM with real line breaks:
 * a host that keeps a setting on one line keeps it with `\n` (or `\r\n`) escapes, and those are
 * turned into line breaks. Null unless the PEM is an ES256 public key: an EC key on P-256.
 */
export function readPrivyKey(text: string): string | null {
  const pem = text
    .trim()
    .replaceAll("\\r\\n", "\n")
    .replaceAll("\\n", "\n")
    .replaceAll("\r\n", "\n");
  if (!pem.startsWith("-----BEGIN PUBLIC KEY-----")) return null;
  try {
    const key = createPublicKey({ key: pem, format: "pem" });
    const ok =
      key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1";
    return ok ? pem : null;
  } catch {
    return null;
  }
}

/** Whether `gift` has all a gift needs: the first that is missing turns the route off. */
function usable(gift: GasGift | undefined): gift is GasGift {
  return (
    gift !== undefined &&
    gift.account !== "" &&
    gift.privyAppId !== "" &&
    readPrivyKey(gift.privyVerificationKey) !== null &&
    gift.amount > 0n &&
    gift.minBalance >= 0n &&
    gift.dailyCap >= gift.amount
  );
}

/** The name of what went wrong, and its code when it has one: never its text, which can hold a URL. */
function kindOf(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const { code } = error as { code?: unknown };
  return typeof code === "string" ? `${error.name} ${code}` : error.name;
}

/** `ms` milliseconds since the epoch, as ISO 8601 in UTC. */
function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

export function gasGiftRoutes(deps: ApiDeps): Hono {
  const app = new Hono();
  const limits = rateLimitsOf(deps.rateLimits);
  const perClient = rateLimit(limits.gasGift, (c) => clientKey(c, deps.trustedProxyHops ?? 0));
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
  const gift = deps.network !== "mainnet" && usable(deps.gasGift) ? deps.gasGift : undefined;
  const nowMs = () => Number(nowNs(deps) / 1_000_000n);

  /** The verification key as a PEM, read once: `usable` has found it good when the gift is on. */
  const pem = gift === undefined ? null : readPrivyKey(gift.privyVerificationKey);
  /** The verification key, imported once. A failed import is tried again by the next request. */
  let imported: Promise<CryptoKey> | undefined;
  const verificationKey = (pem: string): Promise<CryptoKey> => {
    imported ??= importSPKI(pem, "ES256").catch((error: unknown) => {
      imported = undefined;
      throw error;
    });
    return imported;
  };

  /**
   * The login's user id from `Authorization: Bearer <token>`, or null for anything that is not a
   * good token: none, malformed, signed by another key or with another algorithm, for another app
   * or issuer, expired or not yet valid, or without a user. Which of them it was is not said.
   */
  async function loginOf(on: GasGift, header: string | undefined): Promise<string | null> {
    const token = BEARER.exec(header ?? "")?.[1];
    if (token === undefined || token.length > MAX_TOKEN_CHARS) return null;
    if (pem === null) return null;
    // Outside the `try`: a key that cannot be imported is a fault of ours, not of the token.
    const key = await verificationKey(pem);
    try {
      const { payload } = await jwtVerify(token, key, {
        algorithms: ["ES256"],
        issuer: PRIVY_ISSUER,
        audience: on.privyAppId,
        clockTolerance: CLOCK_TOLERANCE_S,
        currentDate: new Date(nowMs()),
        requiredClaims: ["sub", "exp"],
      });
      return typeof payload.sub === "string" && PRIVY_USER.test(payload.sub) ? payload.sub : null;
    } catch {
      return null;
    }
  }

  /** The account the body names, once it is an implicit one: a 400 otherwise. */
  function accountOf(body: unknown): string {
    const named =
      typeof body === "object" && body !== null && !Array.isArray(body)
        ? (body as { account_id?: unknown }).account_id
        : undefined;
    if (typeof named === "string" && !IMPLICIT.test(named)) {
      return fail(
        400,
        "not_implicit",
        "the gift goes only to the account an email login makes: 64 lowercase hex characters",
      );
    }
    const parsed = GasGiftRequestSchema.safeParse(body);
    if (!parsed.success) {
      return badRequest("the body does not fit its schema", issuesOf(parsed.error));
    }
    return parsed.data.account_id;
  }

  /**
   * Whether the login or the account has a gift, sent or on its way. A claim older than
   * `STALE_CLAIM_MS` is not on its way: `claim` deletes it.
   */
  async function given(login: string, account: string): Promise<boolean> {
    const rows = await deps.db.query(
      `select 1 from gas_gifts
        where (privy_user = $1 or account_id = $2)
          and (status = 'sent' or created_at >= $3::timestamptz)
        limit 1`,
      [login, account, isoAt(nowMs() - STALE_CLAIM_MS)],
    );
    return rows.length > 0;
  }

  /**
   * Claims the gift for the login and the account, in one transaction that locks the table, so
   * that no two claims are decided at once: `claimed`, or why not.
   */
  async function claim(
    on: GasGift,
    login: string,
    account: string,
  ): Promise<"claimed" | "already_given" | "daily_limit"> {
    const now = nowMs();
    const dayStart = Math.floor(now / DAY_MS) * DAY_MS;
    return await deps.db.tx(async (tx) => {
      await tx.query("lock table gas_gifts in share row exclusive mode");
      await tx.query(
        "delete from gas_gifts where status = 'claimed' and created_at < $1::timestamptz",
        [isoAt(now - STALE_CLAIM_MS)],
      );
      const taken = await tx.query(
        "select 1 from gas_gifts where privy_user = $1 or account_id = $2 limit 1",
        [login, account],
      );
      if (taken.length > 0) return "already_given";
      const [day] = await tx.query<{ total: string }>(
        "select coalesce(sum(amount), 0)::text as total from gas_gifts where created_at >= $1::timestamptz",
        [isoAt(dayStart)],
      );
      if (BigInt(day?.total ?? "0") + on.amount > on.dailyCap) return "daily_limit";
      await tx.query(
        `insert into gas_gifts (privy_user, account_id, amount, status, created_at)
         values ($1, $2, $3, 'claimed', $4::timestamptz)`,
        [login, account, `${on.amount}`, isoAt(now)],
      );
      return "claimed";
    });
  }

  /** The answer to a login or an account that has had its gift. */
  function alreadyGiven(): never {
    return fail(
      409,
      "already_given",
      "this login or this account has had its testnet NEAR already: a gift is once per login and once per account",
    );
  }

  /** The answer when the day's gifts are used up: come back at the next UTC day. */
  function dailyLimit(): never {
    const now = nowMs();
    const wait = Math.max(1, Math.ceil((Math.floor(now / DAY_MS + 1) * DAY_MS - now) / 1000));
    const body: ErrorBody = {
      error: "daily_limit",
      message: "today's testnet NEAR for new accounts is given out: try again tomorrow (UTC)",
    };
    throw new HTTPException(429, {
      res: Response.json(body, { status: 429, headers: { "Retry-After": String(wait) } }),
      message: body.message,
    });
  }

  /** The 401 for a call without a good token of the login, whatever is wrong with it. */
  function unauthorized(c: Context): Response {
    const body: ErrorBody = {
      error: "unauthorized",
      message: "log in again with your email or Google account, then try again",
    };
    return c.json(body, 401, { "WWW-Authenticate": "Bearer" });
  }

  app.post(
    "/gas-gift",
    async (c, next) => {
      if (gift !== undefined) return next();
      const body: ErrorBody = {
        error: "gift_off",
        message: "this API gives no testnet NEAR to new accounts",
      };
      return c.json(body, 503);
    },
    perClient,
    tooLarge,
    async (c) => {
      // Set: the first middleware answers when it is not.
      const on = gift as GasGift;
      const login = await loginOf(on, c.req.header("Authorization"));
      if (login === null) return unauthorized(c);
      const account = accountOf(await readJson(c));

      if (await given(login, account)) return alreadyGiven();

      let balance: bigint;
      try {
        balance = await withinDeadline(BALANCE_DEADLINE_MS, on.balanceOf(account));
      } catch (error) {
        console.error(`api: cannot read the NEAR balance of ${account} (${kindOf(error)})`);
        return unavailableForNow("cannot read the account's balance right now");
      }
      if (balance >= on.minBalance) {
        const body: GasGiftResponse = { status: "not_needed", balance: `${balance}` };
        return c.json(body, 200, NOT_CACHED);
      }

      const claimed = await claim(on, login, account);
      if (claimed === "already_given") return alreadyGiven();
      if (claimed === "daily_limit") return dailyLimit();

      let txHash: string;
      try {
        ({ txHash } = await on.transfer(account, on.amount));
      } catch (error) {
        console.error(`api: the gas gift to ${account} was not sent (${kindOf(error)})`);
        await deps.db.query("delete from gas_gifts where privy_user = $1 and status = 'claimed'", [
          login,
        ]);
        return fail(
          502,
          "transfer_failed",
          "the testnet NEAR could not be sent just now: try again in a minute",
        );
      }
      await deps.db.query(
        `update gas_gifts set status = 'sent', tx_hash = $2, sent_at = $3::timestamptz
          where privy_user = $1`,
        [login, txHash, isoAt(nowMs())],
      );
      const body: GasGiftResponse = { status: "sent", amount: `${on.amount}`, tx_hash: txHash };
      return c.json(body, 200, NOT_CACHED);
    },
  );

  return app;
}
