import { createPublicKey } from "node:crypto";
import { sendRefused } from "@tender/client";
import { GasGiftRequestSchema, type GasGiftResponse } from "@tender/shared";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import {
  type CryptoKey,
  createRemoteJWKSet,
  errors,
  importSPKI,
  type JWTVerifyGetKey,
  type JWTVerifyOptions,
  jwtVerify,
} from "jose";
import { NoAnswerInTime, withinDeadline } from "../deadline";
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
// app: it is verified for the issuer `privy.io` and the audience of the app's id, and its `sub` is
// the login's user id (`did:privy:...`). The key is the one of the token's `kid` among the keys
// Privy publishes for the app (`privyJwksUrl`), which `jose` fetches and keeps for 10 minutes, and
// fetches again for a `kid` it does not know (at most once in 30 seconds), so a key Privy rotates
// in is found. `PRIVY_VERIFICATION_KEY`, when it is set, is the one key used instead, and nothing
// is fetched. It is not a Tender sign-in, which an account that holds no NEAR cannot do yet. Every
// fault of a token gets the same 401, which names none of them; a key set that cannot be fetched
// is a 503, since the token may be good. No token is ever logged.
//
// The order of the checks, and the first fault is the answer:
//
//   503  `gift_off`: no gift is set up here, or this is mainnet;
//   429  `rate_limited`: over the client address's limit;
//   413  `payload_too_large`: a body over 4 KiB;
//   401  `unauthorized`: no token, or one that does not verify;
//   503  `unavailable`: the app's key set cannot be fetched right now (`Retry-After: 5`);
//   400  `bad_request` for a body that is not `{ account_id }`, and `not_implicit` for an account
//        that is not 64 lowercase hex characters;
//   409  `already_given`: this login, or this account, has had its gift;
//   503  `unavailable` with `Retry-After: 30`: a gift for this login or this account is claimed and
//        its transfer is on its way, or its outcome is not known yet (see THE CLAIM);
//   503  `unavailable`: the chain cannot say what the account holds right now (`Retry-After: 5`);
//   200  `not_needed`: the account holds `minBalance` or more already;
//   503  `gift_off`: the gift account holds less than one gift and `GAS_GIFT_POOL_MARGIN` (its pool
//        is empty), so nothing is claimed; a `WARN api:` line says so, once in `POOL_WARN_MS`;
//   429  `daily_limit`: the gifts of this UTC day would go past the cap (`Retry-After`: the seconds
//        to the next UTC day);
//   502  `transfer_failed`: the transfer was refused for certain (`sendRefused`: it ran and a
//        receipt of it failed on chain, an `ActionError`, or the node refused it for a reason in
//        its signed bytes alone), and its claim is let go, so asking again works; or its outcome is
//        not known, and the NEAR may still arrive: its claim is kept, as THE CLAIM says, and a
//        `WARN api:` line says `may still land`. Unknown is a timeout, no answer within
//        `TRANSFER_WAIT_MS`, and every refusal that is not a property of the signed bytes alone: a
//        used nonce, a gift account short of NEAR (its balance is the chain's state at that
//        moment), an expired block, a congested or stuck shard, a final outcome whose failure is an
//        `InvalidTxError` (that copy was included and found invalid, which says nothing of another
//        copy), and any other error. The pool is read before each claim, but that read is a check
//        before sending, not a guarantee: it is of the last final block, which can lag a gift that
//        has just executed, so calls close together can still meet an empty pool here, and so can a
//        call after another spend from the gift account. Such a call keeps its claim until it goes
//        stale, counted against the day meanwhile;
//   200  `sent`, with the amount and the transfer's hash, once the transfer has executed.
//
// THE CLAIM. A gift's row is written before the transfer is sent, in a transaction that locks the
// table, checks the login, the account and the day's total, and inserts it: of two calls at once
// for the same login or the same account, one claims, and the other is told the gift is on its way
// (503 `unavailable`). The day's total counts every claim as well as every gift sent, so the claims
// and the sent gifts of a day never pass the cap. The row is this request's own (its login, account
// and time), and only it is changed: to `sent` once the transfer has executed, or deleted when the
// transfer was refused for certain. A transfer whose outcome is unknown keeps its claim, so that no
// second gift goes out while the first may land; the outcome is recorded whenever it comes, even
// after the answer. A claim is let go by the next claim once it is older than `STALE_CLAIM_MS` and
// its transfer is not in flight in this process: one left by a process that died mid-gift, or one
// whose transfer ended with its outcome unknown. A transfer can go uncounted in two ways: one whose
// outcome was unknown and that lands after its claim is let go, and one that was sent but whose
// `sent` could not be written (the database failed: the answer is a 500, or a 502 if the 60 s wait
// had already run out, and the claim is let go in time). Its account then holds the NEAR, so it
// gets `not_needed` if asked for again; its login could still ask for another account.
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

/**
 * Where Privy publishes the keys that sign the access tokens of the app `appId`: a JSON Web Key
 * Set of ES256 keys, each with its `kid`.
 */
export function privyJwksUrl(appId: string): string {
  return `https://auth.privy.io/api/v1/apps/${encodeURIComponent(appId)}/jwks.json`;
}

/** How long a fetch of the key set may take before the call is a 503. */
const JWKS_TIMEOUT_MS = 5_000;

/**
 * After a fetch of the key set fails, how long the calls get a 503 at once, with no new fetch:
 * while the login's server is down, a burst of calls makes one fetch, and one log line.
 */
const KEYS_RETRY_MS = 5_000;

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

/**
 * What the gift account must hold beyond one gift before a gift is claimed: 0.01 NEAR. The account
 * keeps its own storage staked, about 0.002 NEAR for a plain account with one key (10^19
 * yoctoNEAR a byte), and pays the transfer's gas, well under 0.001 NEAR on testnet even at the
 * higher price the node takes up front; short of either, the node refuses the transfer. 0.01 NEAR
 * covers both several times over, and is a tenth of one gift at the default.
 */
export const GAS_GIFT_POOL_MARGIN = 10_000_000_000_000_000_000_000n;

/** How often, at most, the WARN that the gift's pool is empty is written: 5 minutes. */
const POOL_WARN_MS = 5 * 60_000;

/**
 * How old a claim must be before the next claim lets it go, if its transfer is no longer in flight
 * in this process: well past `TRANSFER_WAIT_MS` and the client's own 120 s for a send.
 */
const STALE_CLAIM_MS = 10 * 60_000;

/**
 * How long a request waits for its transfer, the wait for the gift account's turn in the client's
 * queue included, before it answers that the NEAR may still arrive. Its outcome is recorded when
 * it comes. `GasGift.transferWaitMs` changes it for tests.
 */
const TRANSFER_WAIT_MS = 60_000;

/** When a claimed gift is asked for again, how many seconds to wait before asking once more. */
const HELD_RETRY_S = 30;

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

/** `gift.privyVerificationKey` when it is set: empty, or only spaces, is unset. */
function setKeyOf(gift: GasGift): string | undefined {
  const text = gift.privyVerificationKey;
  return text === undefined || text.trim() === "" ? undefined : text;
}

/**
 * Whether `gift` has all a gift needs: the first that is missing turns the route off. A
 * verification key is not needed, but one that is set must be an ES256 public key.
 */
function usable(gift: GasGift | undefined): gift is GasGift {
  if (gift === undefined) return false;
  const key = setKeyOf(gift);
  return (
    gift.account !== "" &&
    gift.privyAppId.trim() !== "" &&
    (key === undefined || readPrivyKey(key) !== null) &&
    gift.amount > 0n &&
    gift.minBalance >= 0n &&
    gift.dailyCap >= gift.amount
  );
}

/**
 * Whether a key set's error is about the token, which no fetch can mend: no key of its `kid` and
 * algorithm (after a fetch, if one was due), more than one that the token does not tell apart, or
 * an algorithm that a key set has no keys for. Anything else, such as a failed or timed-out fetch,
 * an answer that is not 200 or not a key set, means the key set could not be read.
 */
function aboutTheToken(error: unknown): boolean {
  return (
    error instanceof errors.JWKSNoMatchingKey ||
    error instanceof errors.JWKSMultipleMatchingKeys ||
    error instanceof errors.JOSENotSupported
  );
}

/** `token` verified with the first of the keys `several` yields that verifies it, or `several`. */
async function verifiedByOneOf(
  token: string,
  several: InstanceType<typeof errors.JWKSMultipleMatchingKeys>,
  options: JWTVerifyOptions,
): Promise<Awaited<ReturnType<typeof jwtVerify>>> {
  for await (const candidate of several) {
    try {
      return await jwtVerify(token, candidate, options);
    } catch {
      // the next one
    }
  }
  throw several;
}

/** This request's own row of `gas_gifts`: the only one it changes. */
interface Claim {
  login: string;
  account: string;
  /** `created_at` as it was written, ISO 8601. */
  createdAt: string;
}

/** What became of a transfer: sent, refused for certain, or not known. */
type Outcome = { kind: "sent"; txHash: string } | { kind: "refused" } | { kind: "unknown" };

/** What `loginOf` makes of a bearer token. */
type Login =
  | { kind: "user"; user: string }
  | { kind: "refused" }
  // The app's key set could not be fetched: the token may be good.
  | { kind: "unavailable" };

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

  /** The verification key as a PEM, read once when it is set: `usable` has found it good. */
  const setKey = gift === undefined ? undefined : setKeyOf(gift);
  const pem = setKey === undefined ? null : readPrivyKey(setKey);
  /**
   * The key set tokens are checked against when no verification key is set: the one a test gives,
   * or the app's published one, fetched when the first token comes, and kept as `jose` keeps it.
   */
  const keySet: JWTVerifyGetKey | undefined =
    gift === undefined || pem !== null
      ? undefined
      : (gift.privyKeys ??
        createRemoteJWKSet(new URL(privyJwksUrl(gift.privyAppId.trim())), {
          timeoutDuration: JWKS_TIMEOUT_MS,
        }));
  /** When a fetch of the key set last failed, by the API's clock (ms), within `KEYS_RETRY_MS`. */
  let keysFailedAt: number | undefined;
  /** Whether a failure at `at` is within `KEYS_RETRY_MS` of the last one (a clock gone back: no). */
  const keysResting = (at: number) =>
    keysFailedAt !== undefined && at >= keysFailedAt && at - keysFailedAt < KEYS_RETRY_MS;
  /**
   * `keySet`, with a rest after a failure: for `KEYS_RETRY_MS` after a fetch fails, every call is
   * refused at once as one the key set could not answer, with no new fetch. The failure is logged
   * once, by the kind of error alone: a burst of calls, which share one fetch, writes one line.
   */
  const keys: JWTVerifyGetKey | undefined =
    keySet === undefined
      ? undefined
      : async (protectedHeader, jws) => {
          if (keysResting(nowMs())) {
            throw new Error("the key set could not be fetched a moment ago");
          }
          try {
            return await keySet(protectedHeader, jws);
          } catch (error) {
            if (!aboutTheToken(error)) {
              const at = nowMs();
              if (!keysResting(at)) {
                console.error(
                  `api: cannot fetch the login's key set (${kindOf(error)}); not trying again ` +
                    `for ${KEYS_RETRY_MS / 1000} s`,
                );
              }
              keysFailedAt = at;
            }
            throw error;
          }
        };
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
   * The login's user from `Authorization: Bearer <token>`. `refused` is anything that is not a good
   * token: none, malformed, signed by another key or with another algorithm, for another app or
   * issuer, expired or not yet valid, or without a user; which of them it was is not said.
   * `unavailable` is a key set that could not be fetched, which says nothing of the token: `keys`
   * logs its failure by name, and the token is never logged.
   */
  async function loginOf(on: GasGift, header: string | undefined): Promise<Login> {
    const token = BEARER.exec(header ?? "")?.[1];
    if (token === undefined || token.length > MAX_TOKEN_CHARS) return { kind: "refused" };
    const options: JWTVerifyOptions = {
      algorithms: ["ES256"],
      issuer: PRIVY_ISSUER,
      audience: on.privyAppId.trim(),
      clockTolerance: CLOCK_TOLERANCE_S,
      currentDate: new Date(nowMs()),
      requiredClaims: ["sub", "exp"],
    };
    /** What the key set threw that was not about the token, if it threw such a thing. */
    let unreadable: { error: unknown } | undefined;
    // Outside the `try`: a set key that cannot be imported is a fault of ours, not of the token.
    const key = pem === null ? undefined : await verificationKey(pem);
    try {
      let verified: Awaited<ReturnType<typeof jwtVerify>>;
      if (key !== undefined) {
        verified = await jwtVerify(token, key, options);
      } else if (keys !== undefined) {
        try {
          verified = await jwtVerify(
            token,
            async (protectedHeader, jws) => {
              try {
                return await keys(protectedHeader, jws);
              } catch (error) {
                if (!aboutTheToken(error)) unreadable = { error };
                throw error;
              }
            },
            options,
          );
        } catch (error) {
          // A token with no `kid` that more than one key of the set fits: `jose` leaves trying
          // each of them to the caller. One that none of them verifies is refused.
          if (!(error instanceof errors.JWKSMultipleMatchingKeys)) throw error;
          verified = await verifiedByOneOf(token, error, options);
        }
      } else {
        return { kind: "refused" };
      }
      const { sub } = verified.payload;
      return typeof sub === "string" && PRIVY_USER.test(sub)
        ? { kind: "user", user: sub }
        : { kind: "refused" };
    } catch {
      return unreadable === undefined ? { kind: "refused" } : { kind: "unavailable" };
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

  /** The logins whose transfer is in flight in this process: their claims are never let go. */
  const inFlight = new Set<string>();

  /** A row of `gas_gifts`, as far as a claim reads it. */
  type GiftRow = { privy_user: string; status: string; created_at: Date };

  /** Whether `row` is a claim that the next claim lets go (see THE CLAIM). */
  const letGo = (row: GiftRow, now: number) =>
    row.status === "claimed" &&
    row.created_at.getTime() < now - STALE_CLAIM_MS &&
    !inFlight.has(row.privy_user);

  /**
   * What the rows of the login or the account say: `sent`, when one of them had its gift;
   * `held`, when one is claimed and not to be let go; or `none`.
   */
  function standing(rows: readonly GiftRow[], now: number): "sent" | "held" | "none" {
    if (rows.some((row) => row.status === "sent")) return "sent";
    return rows.some((row) => !letGo(row, now)) ? "held" : "none";
  }

  /** The rows of the login or the account, if any. */
  async function rowsOf(
    db: Pick<ApiDeps["db"], "query">,
    login: string,
    account: string,
  ): Promise<GiftRow[]> {
    return await db.query<GiftRow>(
      "select privy_user, status, created_at from gas_gifts where privy_user = $1 or account_id = $2",
      [login, account],
    );
  }

  /**
   * Claims the gift for the login and the account, in one transaction that locks the table, so
   * that no two claims are decided at once: the claim, or why not. It first lets go of the claims
   * that are due (`letGo`), each by its own login and time.
   */
  async function claim(
    on: GasGift,
    login: string,
    account: string,
  ): Promise<Claim | "sent" | "held" | "daily_limit"> {
    const now = nowMs();
    const dayStart = Math.floor(now / DAY_MS) * DAY_MS;
    return await deps.db.tx(async (tx) => {
      await tx.query("lock table gas_gifts in share row exclusive mode");
      const stale = await tx.query<GiftRow>(
        `select privy_user, status, created_at from gas_gifts
          where status = 'claimed' and created_at < $1::timestamptz`,
        [isoAt(now - STALE_CLAIM_MS)],
      );
      for (const row of stale) {
        if (!letGo(row, now)) continue;
        await tx.query(
          `delete from gas_gifts
            where privy_user = $1 and created_at = $2::timestamptz and status = 'claimed'`,
          [row.privy_user, row.created_at.toISOString()],
        );
      }
      const said = standing(await rowsOf(tx, login, account), now);
      if (said !== "none") return said;
      const [day] = await tx.query<{ total: string }>(
        "select coalesce(sum(amount), 0)::text as total from gas_gifts where created_at >= $1::timestamptz",
        [isoAt(dayStart)],
      );
      if (BigInt(day?.total ?? "0") + on.amount > on.dailyCap) return "daily_limit";
      const createdAt = isoAt(now);
      await tx.query(
        `insert into gas_gifts (privy_user, account_id, amount, status, created_at)
         values ($1, $2, $3, 'claimed', $4::timestamptz)`,
        [login, account, `${on.amount}`, createdAt],
      );
      return { login, account, createdAt };
    });
  }

  /**
   * Sends the gift of `own` and records what became of it in its own row: `sent` with the hash, or
   * the row deleted when the transfer was refused for certain (`sendRefused`). An outcome that is
   * not known leaves the claim as it is. The login is in `inFlight` until the outcome is recorded,
   * however long that takes: a request that stops waiting leaves this running. It rejects only when
   * the database fails as it records.
   */
  function send(on: GasGift, own: Claim): Promise<Outcome> {
    const where =
      "privy_user = $1 and account_id = $2 and created_at = $3::timestamptz and status = 'claimed'";
    const mine = [own.login, own.account, own.createdAt];
    inFlight.add(own.login);
    // Called inside a promise, so that one that throws at once is an outcome like any other.
    return Promise.resolve()
      .then(() => on.transfer(own.account, on.amount))
      .then(
        async ({ txHash }): Promise<Outcome> => {
          const updated = await deps.db.query(
            `update gas_gifts set status = 'sent', tx_hash = $4, sent_at = $5::timestamptz
              where ${where} returning privy_user`,
            [...mine, txHash, isoAt(nowMs())],
          );
          if (updated.length === 0) {
            console.warn(
              `WARN api: the gas gift to ${own.account} was sent (${txHash}), but its claim was ` +
                "gone, so it is not recorded",
            );
          }
          return { kind: "sent", txHash };
        },
        async (error: unknown): Promise<Outcome> => {
          if (sendRefused(error)) {
            console.error(
              `api: the gas gift to ${own.account} was refused (${kindOf(error)}); its claim is let go`,
            );
            await deps.db.query(`delete from gas_gifts where ${where}`, mine);
            return { kind: "refused" };
          }
          console.warn(
            `WARN api: the gas gift to ${own.account} may still land (${kindOf(error)}); its ` +
              `claim is kept until it is ${STALE_CLAIM_MS / 60_000} minutes old`,
          );
          return { kind: "unknown" };
        },
      )
      .finally(() => inFlight.delete(own.login));
  }

  /** The answer to a gift asked for again while it is claimed: it is on its way, or may be. */
  function held(): never {
    const body: ErrorBody = {
      error: "unavailable",
      message:
        "the testnet NEAR for this login or this account is on its way, or may still arrive: " +
        "try again in a minute",
    };
    throw new HTTPException(503, {
      res: Response.json(body, { status: 503, headers: { "Retry-After": String(HELD_RETRY_S) } }),
      message: body.message,
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

  /** When the WARN that the pool is empty was last written, by the API's clock (ms). */
  let poolWarnedAt: number | undefined;

  /**
   * Whether the gift account can pay one more gift and `GAS_GIFT_POOL_MARGIN` for its storage and
   * fees, by its balance at the last final block. A check before the claim, not a guarantee: that
   * block can lag a gift that has just executed, and calls close together, or another spend from
   * the gift account, can still empty the pool before a transfer. An empty pool is said in a WARN,
   * with the account and its balance, once in `POOL_WARN_MS` at most (a clock gone back says it
   * again).
   */
  async function poolCovers(on: GasGift): Promise<boolean> {
    let pool: bigint;
    try {
      pool = await withinDeadline(BALANCE_DEADLINE_MS, on.balanceOf(on.account));
    } catch (error) {
      console.error(`api: cannot read the NEAR balance of ${on.account} (${kindOf(error)})`);
      return unavailableForNow("cannot read the gift pool's balance right now");
    }
    if (pool >= on.amount + GAS_GIFT_POOL_MARGIN) return true;
    const now = nowMs();
    if (poolWarnedAt === undefined || now < poolWarnedAt || now - poolWarnedAt >= POOL_WARN_MS) {
      poolWarnedAt = now;
      console.warn(
        `WARN api: the gas gift's pool is empty: ${on.account} holds ${pool} yoctoNEAR, less ` +
          `than one gift of ${on.amount} and ${GAS_GIFT_POOL_MARGIN} for its storage and fees; ` +
          "calls answer 503 gift_off until it is refilled",
      );
    }
    return false;
  }

  /** The answer when the gift's pool is empty: nothing is claimed, and the web app links elsewhere. */
  function poolEmpty(c: Context): Response {
    const body: ErrorBody = {
      error: "gift_off",
      message: "the testnet NEAR for new accounts has run out for now: the gift pool is empty",
    };
    return c.json(body, 503);
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
      const checked = await loginOf(on, c.req.header("Authorization"));
      if (checked.kind === "unavailable") {
        return unavailableForNow("cannot check your login right now: try again in a few seconds");
      }
      if (checked.kind === "refused") return unauthorized(c);
      const login = checked.user;
      const account = accountOf(await readJson(c));

      const before = standing(await rowsOf(deps.db, login, account), nowMs());
      if (before === "sent") return alreadyGiven();
      if (before === "held") return held();

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
      if (!(await poolCovers(on))) return poolEmpty(c);

      const claimed = await claim(on, login, account);
      if (claimed === "sent") return alreadyGiven();
      if (claimed === "held") return held();
      if (claimed === "daily_limit") return dailyLimit();

      const sending = send(on, claimed);
      let outcome: Outcome;
      try {
        outcome = await withinDeadline(on.transferWaitMs ?? TRANSFER_WAIT_MS, sending);
      } catch (error) {
        // A database that failed as the outcome was recorded is a fault: a 500.
        if (!(error instanceof NoAnswerInTime)) throw error;
        outcome = { kind: "unknown" };
        console.warn(
          `WARN api: the gas gift to ${account} gave no answer within ` +
            `${(on.transferWaitMs ?? TRANSFER_WAIT_MS) / 1000} s and may still land; its claim is ` +
            `kept while its transfer is in flight, and until it is ${STALE_CLAIM_MS / 60_000} ` +
            "minutes old",
        );
        // The outcome is recorded when it comes; only a failure to record it is said then.
        sending.catch((late: unknown) =>
          console.error(
            `api: cannot record the outcome of the gas gift to ${account} (${kindOf(late)})`,
          ),
        );
      }
      if (outcome.kind === "refused") {
        return fail(
          502,
          "transfer_failed",
          "the testnet NEAR could not be sent: the transfer was refused. Try again in a minute",
        );
      }
      if (outcome.kind === "unknown") {
        return fail(
          502,
          "transfer_failed",
          "the testnet NEAR may still arrive: the transfer's outcome is not known yet. Look at the " +
            "account's balance in a few minutes before you ask again",
        );
      }
      const body: GasGiftResponse = {
        status: "sent",
        amount: `${on.amount}`,
        tx_hash: outcome.txHash,
      };
      return c.json(body, 200, NOT_CACHED);
    },
  );

  return app;
}
