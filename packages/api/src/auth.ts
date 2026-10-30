import { randomBytes } from "node:crypto";
import {
  AuthError,
  type AuthErrorCode,
  type KeyPermission,
  keyKindOf,
  type Nep413Result,
  verifyNep413,
} from "@tender/client";
import { canonicalBase, SIGN_IN_MESSAGE, sha256Hex } from "@tender/shared";
import type { Context } from "hono";
import { withinDeadline } from "./deadline";
import { type ApiDeps, nowNs } from "./deps";
import type { ErrorBody } from "./format";
import { unavailableForNow } from "./limits";
import type { RequireAuth } from "./routes/blobs";

// NEP-413 sign-in. A user or an agent asks for a challenge, signs it with an access key of its
// account, and trades the signature for a bearer token, which the routes that need an account
// ask for. `verifyNep413` decides whether a key may sign in (a full-access key, or a function-call
// key limited to the Tender contract); this file decides what the API does with the answer.
//
// The state is two tables. A challenge is a nonce that is spent once. A token is stored as the
// SHA-256 of what was handed out, so a copy of the database cannot be used to sign in. Both
// expire by the clock in `deps`, and the database's own is never read, so a test moves time.
//
// A token also lasts only as long as the key that signed in: `requireAuth` asks the chain again
// whether that key is still on the account and may still sign in, so a key that is removed takes
// its tokens with it, within a minute, and not at the end of their 12 hours.
//
// Each question to the chain has 5 seconds. A chain that does not answer in time, or whose call
// fails, is a 503 with `Retry-After: 5` for the caller to try again later, at sign-in and at the
// check of a token alike, and not a request that waits for the RPC client to give up on its own,
// which takes minutes.

const NONCE_BYTES = 32;
const TOKEN_BYTES = 32;
/** A base64url token of `TOKEN_BYTES` bytes, without padding. */
const TOKEN_CHARS = Math.ceil((TOKEN_BYTES * 4) / 3);

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
/** How long a challenge or a token stays in its table after it expires, until a new challenge. */
const KEEP_EXPIRED_MS = 60 * 60 * 1000;

/** The kind of key that signed in: whatever `verifyNep413` reports. */
export type KeyKind = Nep413Result["keyKind"];

/** `POST /v1/auth/challenge`. `nonce` is 32 random bytes in base64; `expires_at` is ISO 8601. */
export interface ChallengeResponse {
  nonce: string;
  /** What the wallet signs. */
  message: string;
  /** Whom the wallet signs it for: this API, by its public URL (`canonicalBase`). */
  recipient: string;
  expires_at: string;
}

/** `POST /v1/auth/verify`. `token` is 32 random bytes in base64url, shown once. */
export interface SignInResponse {
  token: string;
  expires_at: string;
  key_kind: KeyKind;
}

/**
 * The body of `POST /v1/auth/verify`: a sign-in as `verifyNep413` takes it, with `signature` and
 * `nonce` in base64.
 */
export interface SignInRequest {
  account_id: string;
  public_key: string;
  signature: string;
  nonce: string;
  message: string;
  recipient: string;
}

/** `ns` nanoseconds since the epoch, moved by `plusMs`, as ISO 8601 in UTC to the millisecond. */
function isoAt(ns: bigint, plusMs = 0): string {
  return new Date(Number(ns / 1_000_000n) + plusMs).toISOString();
}

// ---- Challenges -------------------------------------------------------------------------------

/**
 * Issues a challenge. Nothing identifies the caller, so anyone can ask. A challenge is good for 5
 * minutes and its row is kept for an hour after that. The same transaction deletes the challenges
 * and tokens that expired more than an hour ago, so the tables do not grow with the calls.
 *
 * It names this API as its recipient, by `deps.publicUrl` (`canonicalBase`: scheme, host and
 * path, so two APIs under paths of one host are two), so that what a client signs is good here
 * and nowhere else: a server that passes this challenge on to a client of another API gets
 * nothing, as the client signs only for the base it called, and `signIn` accepts only a
 * signature for this one. A public URL that `canonicalBase` refuses is a fault of ours.
 */
export async function createChallenge(deps: ApiDeps): Promise<ChallengeResponse> {
  // First, so that a public URL that is no base is a fault before a challenge is stored.
  const recipient = canonicalBase(deps.publicUrl);
  const now = nowNs(deps);
  const nonce = randomBytes(NONCE_BYTES).toString("base64");
  const expiresAt = isoAt(now, CHALLENGE_TTL_MS);
  const expiredBefore = isoAt(now, -KEEP_EXPIRED_MS);
  await deps.db.tx(async (tx) => {
    await tx.query("delete from auth_challenges where expires_at < $1::timestamptz", [
      expiredBefore,
    ]);
    await tx.query("delete from auth_tokens where expires_at < $1::timestamptz", [expiredBefore]);
    await tx.query("insert into auth_challenges (nonce, expires_at) values ($1, $2::timestamptz)", [
      nonce,
      expiresAt,
    ]);
  });
  return { nonce, message: SIGN_IN_MESSAGE, recipient, expires_at: expiresAt };
}

// ---- Asking the chain -------------------------------------------------------------------------

/**
 * How long the chain has to say whether a key is on an account, in milliseconds. The RPC client
 * retries a node that does not answer for minutes, and nobody should wait that long to be told to
 * come back later.
 */
const KEY_LOOKUP_DEADLINE_MS = 5_000;

/**
 * The chain could not say whether a key is on an account: its call failed, or gave no answer
 * within `KEY_LOOKUP_DEADLINE_MS`. `cause` is the call's own error, or `withinDeadline`'s
 * `NoAnswerInTime`. It is the one error `lookUpKey` throws, so that whoever asked can tell a
 * chain that is not answering from a fault of our own. It is not to be logged whole: see
 * `logLookupFailure`.
 */
class KeyLookupFailed extends Error {
  constructor(cause: unknown) {
    super("the chain could not say whether the key is there", { cause });
    this.name = "KeyLookupFailed";
  }
}

/**
 * `deps.client.viewAccessKey`, with `KEY_LOOKUP_DEADLINE_MS` to answer (`withinDeadline`). It
 * rejects with a `KeyLookupFailed` if the call fails, and if the deadline comes first.
 */
async function lookUpKey(
  deps: ApiDeps,
  account: string,
  publicKey: string,
): Promise<{ permission: KeyPermission } | null> {
  try {
    // Called as a method, because a `TenderClient` reads its own fields.
    return await withinDeadline(
      KEY_LOOKUP_DEADLINE_MS,
      deps.client.viewAccessKey(account, publicKey),
    );
  } catch (error) {
    throw new KeyLookupFailed(error);
  }
}

/**
 * Logs that the chain could not be asked about the key of `whose`, with the name of what went
 * wrong and nothing else. The text of an RPC error can name an endpoint with a key in it, and so
 * can the `cause` of a `KeyLookupFailed`, which is the error: neither is logged, and
 * `routes/health.ts` logs only the name in the same way. A thing that is thrown and is no error
 * has no name, and gives its type.
 */
function logLookupFailure(whose: string, error: unknown): void {
  const cause = error instanceof KeyLookupFailed ? error.cause : error;
  const kind = cause instanceof Error ? cause.name : typeof cause;
  console.error(`api: cannot check the key of ${whose} (${kind})`);
}

/**
 * The answer to a request that needs the chain to say something about a key, and it cannot: a 503
 * that says to try again in 5 seconds.
 */
function unavailable(): never {
  return unavailableForNow("cannot check your key right now");
}

/**
 * What a sign-in does with the failure of its lookup: a chain that could not say is a 503, and as
 * nothing was spent the challenge is still good. A failure that is not the chain's is ours, and
 * goes on as it is, to be a 500.
 */
function unavailableIfLookupFailed(error: unknown): never {
  if (!(error instanceof KeyLookupFailed)) throw error;
  logLookupFailure("a sign-in", error);
  return unavailable();
}

// ---- Sign-in ----------------------------------------------------------------------------------

/**
 * Trades a signed challenge for a token, or throws the `AuthError` that says why not. Any other
 * error is not the caller's: the database failed, or there is a fault of ours. The exception is a
 * chain that cannot say whether the key is there, because its call failed or gave no answer in 5
 * seconds: that is thrown as the 503 (`unavailable`) that tells the caller to try again.
 *
 * `verifyNep413` does not look at `message`, so it is held to the one the challenge carries here.
 * It is held to the recipient the challenge names, which is this API's base URL
 * (`canonicalBase` of `deps.publicUrl`): a signature made for another is `wrong_recipient`.
 *
 * The challenge has to be live before the key is looked up, because that lookup is a call to the
 * chain, and one is not spent on a nonce that was never issued or has run out. That first look
 * does not spend it. Spending is `issueToken`'s, in the transaction that stores the token, and it
 * comes last: a sign-in that fails on the way, such as one the chain could not answer, leaves its
 * challenge to try again until it expires.
 */
export async function signIn(deps: ApiDeps, request: SignInRequest): Promise<SignInResponse> {
  if (request.message !== SIGN_IN_MESSAGE) throw new AuthError("bad_signature");
  await requireLiveChallenge(deps, request.nonce);

  const proved = await verifyNep413(
    {
      accountId: request.account_id,
      publicKey: request.public_key,
      signature: request.signature,
      message: request.message,
      nonce: request.nonce,
      recipient: request.recipient,
    },
    {
      viewAccessKey: (account, key) => lookUpKey(deps, account, key),
      contractId: deps.contractId,
      expectedRecipient: canonicalBase(deps.publicUrl),
    },
  ).catch(unavailableIfLookupFailed);

  const issued = await issueToken(deps, request.nonce, proved);
  if (issued === null) throw new AuthError("bad_nonce");
  return issued;
}

/**
 * A nonce as `createChallenge` writes it: `NONCE_BYTES` (32) bytes in base64, which is 43
 * characters and a `=`.
 */
const NONCE_SHAPE = /^[A-Za-z0-9+/]{43}=$/;

/**
 * Throws `bad_nonce` unless `nonce` is a challenge that is unused and unexpired. Spends none. The
 * nonce is the caller's text and is checked for its shape before the database sees it, which
 * refuses some text (a NUL) with an error that would be a 500: no such nonce was ever issued.
 */
async function requireLiveChallenge(deps: ApiDeps, nonce: string): Promise<void> {
  if (!NONCE_SHAPE.test(nonce)) throw new AuthError("bad_nonce");
  const rows = await deps.db.query(
    "select 1 from auth_challenges where nonce = $1 and not used and expires_at > $2::timestamptz",
    [nonce, isoAt(nowNs(deps))],
  );
  if (rows.length === 0) throw new AuthError("bad_nonce");
}

/**
 * Spends the challenge and stores a new token, in one transaction. The spend is a single guarded
 * statement: only one of any number of calls with the same nonce gets its row back, whatever
 * order they run in, and only that one stores a token. Null for the others, and for a challenge
 * that ran out while the key was looked up.
 */
async function issueToken(
  deps: ApiDeps,
  nonce: string,
  proved: Nep413Result,
): Promise<SignInResponse | null> {
  const now = nowNs(deps);
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const expiresAt = isoAt(now, TOKEN_TTL_MS);
  return await deps.db.tx(async (tx) => {
    const spent = await tx.query(
      `update auth_challenges set used = true
        where nonce = $1 and not used and expires_at > $2::timestamptz
        returning nonce`,
      [nonce, isoAt(now)],
    );
    if (spent.length === 0) return null;
    await tx.query(
      `insert into auth_tokens (token_sha256, account, public_key, key_kind, expires_at)
       values ($1, $2, $3, $4, $5::timestamptz)`,
      [sha256Hex(token), proved.accountId, proved.publicKey, proved.keyKind, expiresAt],
    );
    return { token, expires_at: expiresAt, key_kind: proved.keyKind };
  });
}

// ---- Refusals ---------------------------------------------------------------------------------

/** Sent with every 401, as RFC 7235 asks: what the caller can sign in with. */
const WWW_AUTHENTICATE = { "WWW-Authenticate": "Bearer" };

/** What each reason for refusing a sign-in says. Fixed text: nothing of the request is in it. */
const REFUSALS: Record<AuthErrorCode, string> = {
  bad_nonce: "that challenge was not issued, is used already or has expired",
  wrong_recipient: "the message was signed for another recipient",
  bad_signature: "the signature is not that key's signature of the sign-in message and challenge",
  key_not_found: "that key is not on that account",
  key_not_allowed:
    "that key may not sign in: use a full-access key, or a function-call key limited to the Tender contract",
};

/** The answer to a sign-in that `verifyNep413` or `signIn` refused: a 401 that names the reason. */
export function refusal(c: Context, code: AuthErrorCode): Response {
  const body: ErrorBody = { error: code, message: REFUSALS[code] };
  return c.json(body, 401, WWW_AUTHENTICATE);
}

// ---- Tokens -----------------------------------------------------------------------------------

const KEY_KINDS: Record<KeyKind, true> = { full_access: true, function_call: true };

const isKeyKind = (value: string): value is KeyKind => Object.hasOwn(KEY_KINDS, value);

/** `Bearer <token>`. The scheme is case-insensitive; a token is exactly as long as a token is. */
const BEARER = new RegExp(`^bearer +([A-Za-z0-9_-]{${TOKEN_CHARS}})$`, "i");

/** How long the chain's answer about the key of a token is good for, before it is asked again. */
const RECHECK_NS = 60n * 1_000_000_000n;

/** An answer is good for a minute from the time it was asked. A clock that went back has none. */
function isFresh(at: bigint, now: bigint): boolean {
  const age = now - at;
  return age >= 0n && age < RECHECK_NS;
}

/** What the chain said about the key of a token. */
type KeyCheck =
  | { status: "qualifies"; keyKind: KeyKind }
  // The key is gone, or is no longer one that may sign in.
  | { status: "revoked" }
  // The chain could not say: it failed, or did not answer in time.
  | { status: "unavailable" };

/**
 * Asks the chain whether the key behind a token still qualifies, by the policy that sign-in
 * applied to it (`keyKindOf`), so that a token lives only as long as its key. The chain is not
 * asked more than once a minute per token: a good answer is kept for a minute, by the clock in
 * `deps`, and requests that come while the chain is being asked share that one question. A key
 * that is removed therefore stops signing in within a minute of its removal, since the last good
 * answer was given before it. An answer is dated from the moment the chain was asked, and from the
 * moment it answered if the clock went back in between, whichever reading is the earlier, so that
 * a minute from its date is never more than a minute from the question. An answer that is not
 * good is not kept: a token whose key is gone is deleted, and a chain that cannot answer, because
 * it failed or because it gave no answer in time, is asked again by the next request.
 */
function keyChecker(deps: ApiDeps) {
  // Good answers by token hash, the oldest first: a token that is checked again moves to the end,
  // and every good answer drops what has outlived its minute from the front, so the map stays
  // about as large as the set of tokens in use.
  const good = new Map<string, { at: bigint; keyKind: KeyKind }>();
  const asking = new Map<string, Promise<KeyCheck>>();

  async function ask(
    hash: string,
    account: string,
    publicKey: string,
    asked: bigint,
  ): Promise<KeyCheck> {
    let found: { permission: KeyPermission } | null;
    try {
      found = await lookUpKey(deps, account, publicKey);
    } catch (error) {
      logLookupFailure("a signed-in token", error);
      return { status: "unavailable" };
    }
    // The answer is dated from the question, and not from its arrival: the chain may have said it
    // at any time between them, so the earlier time is the one that can be relied on. If the clock
    // went back meanwhile, the reading on arrival is the smaller, and it is the date by the clock
    // as it now stands.
    const arrived = nowNs(deps);
    const at = arrived < asked ? arrived : asked;
    const keyKind = found === null ? null : keyKindOf(found.permission, deps.contractId);
    good.delete(hash);
    if (keyKind === null) return { status: "revoked" };
    good.set(hash, { at, keyKind });
    for (const [oldHash, old] of good) {
      if (isFresh(old.at, arrived)) break;
      good.delete(oldHash);
    }
    return { status: "qualifies", keyKind };
  }

  return (hash: string, account: string, publicKey: string, now: bigint): Promise<KeyCheck> => {
    const kept = good.get(hash);
    if (kept !== undefined && isFresh(kept.at, now)) {
      return Promise.resolve({ status: "qualifies", keyKind: kept.keyKind });
    }
    let check = asking.get(hash);
    if (check === undefined) {
      check = ask(hash, account, publicKey, now).finally(() => asking.delete(hash));
      asking.set(hash, check);
    }
    return check;
  };
}

/** The answer to a request that cannot be signed in, whatever the reason: always this one. */
function unauthorized(c: Context): Response {
  const body: ErrorBody = {
    error: "unauthorized",
    message: "sign in with a bearer token from POST /v1/auth/verify",
  };
  return c.json(body, 401, WWW_AUTHENTICATE);
}

/**
 * The middleware that signs a request in: it reads `Authorization: Bearer <token>`, finds the hash
 * of the token among the tokens that have not expired, and sets `c.var.account` and
 * `c.var.keyKind` for the route. A request that cannot be signed in for whatever reason gets the
 * same 401, so the answer does not tell a token that never existed from one that has run out.
 *
 * A token lives only as long as its key. The key is asked about again, at most once a minute per
 * token (`keyChecker`). When it is gone, or no longer qualifies, the token is deleted and the
 * request is refused as above. When the chain cannot say, because it failed or did not answer in
 * 5 seconds, the request gets a 503 and the token is kept: a token that cannot be checked does not
 * pass, and is not held against its key either. The kind a route sees is the lower of the one the
 * token was issued for and the one the key has now, so a token never gains from a key that is
 * changed, and loses with it.
 *
 * The clock is read twice. The first reading, before the row is read, is the time the request
 * began, and the token must not have expired by it. The check of the key is given a second, after
 * the row is in: a slow read of the row must not make an answer that has gone stale look fresh.
 */
export function requireAuth(deps: ApiDeps): RequireAuth {
  const checkKey = keyChecker(deps);
  return async (c, next) => {
    const now = nowNs(deps);
    const token = BEARER.exec(c.req.header("Authorization") ?? "")?.[1];
    const hash = token === undefined ? undefined : sha256Hex(token);
    const [row] =
      hash === undefined
        ? []
        : await deps.db.query<{ account: string; public_key: string; key_kind: string }>(
            `select account, public_key, key_kind from auth_tokens
              where token_sha256 = $1 and expires_at > $2::timestamptz`,
            [hash, isoAt(now)],
          );
    // A kind this code does not know was written by something else: it signs nothing in.
    if (hash === undefined || !row || !isKeyKind(row.key_kind)) return unauthorized(c);

    const check = await checkKey(hash, row.account, row.public_key, nowNs(deps));
    if (check.status === "unavailable") return unavailable();
    if (check.status === "revoked") {
      await deps.db.query("delete from auth_tokens where token_sha256 = $1", [hash]);
      return unauthorized(c);
    }
    c.set("account", row.account);
    c.set("keyKind", row.key_kind === "full_access" ? check.keyKind : "function_call");
    await next();
  };
}
