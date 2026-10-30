import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, Env, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { rateLimiter } from "hono-rate-limiter";
import type { ErrorBody } from "./format";

// How the API tells a caller to come back later.
//
// A few routes cost the API something for anyone who asks: a challenge is a row in the database, a
// sign-in is a question to the chain, a Telegram link is a nonce. Each is held to a number of
// requests in a window, counted per client address or per signed-in account in this process's
// memory, which is enough because one services process runs per database (P03-R25). Past the
// limit the answer is a 429 with `Retry-After`, the seconds until the caller's window ends.
//
// A 503 that means the chain or the database cannot answer right now carries `Retry-After: 5`
// too: what failed may well be back by then. A 503 that a setting causes, such as Telegram linking
// that is not set up, carries none, since asking again changes nothing.

/** What a 503 that will likely pass carries: try again in 5 seconds. */
export const RETRY_SOON = { "Retry-After": "5" } as const;

/**
 * Stops the request with a 503 that says to try again in 5 seconds, for when the chain or the
 * database cannot answer right now. `app.onError` sends it.
 */
export function unavailableForNow(message: string): never {
  const body: ErrorBody = { error: "unavailable", message };
  throw new HTTPException(503, {
    res: Response.json(body, { status: 503, headers: RETRY_SOON }),
    message,
  });
}

/** At most `limit` requests in each window of `windowMs`, for each client or account counted. */
export interface RateLimit {
  limit: number;
  windowMs: number;
}

/** The routes that have a limit. `ApiDeps.rateLimits` replaces any of them; tests use small ones. */
export interface RateLimits {
  /** `POST /v1/auth/challenge`, per client address. */
  challenge: RateLimit;
  /** `POST /v1/auth/verify`, per client address. */
  verify: RateLimit;
  /** `POST /v1/telegram/link`, per signed-in account. */
  telegramLink: RateLimit;
}

export const DEFAULT_RATE_LIMITS: Readonly<RateLimits> = Object.freeze({
  challenge: { limit: 30, windowMs: 60_000 },
  verify: { limit: 30, windowMs: 60_000 },
  telegramLink: { limit: 10, windowMs: 10 * 60_000 },
});

/** The limits in `over` where it has them, and the defaults for the rest. */
export function rateLimitsOf(over: Partial<RateLimits> | undefined): RateLimits {
  return {
    challenge: over?.challenge ?? DEFAULT_RATE_LIMITS.challenge,
    verify: over?.verify ?? DEFAULT_RATE_LIMITS.verify,
    telegramLink: over?.telegramLink ?? DEFAULT_RATE_LIMITS.telegramLink,
  };
}

const RATE_LIMITED: ErrorBody = {
  error: "rate_limited",
  message: "too many requests, try again later",
};

/**
 * The 429 of a caller over its limit. `Retry-After` is the whole seconds until the caller's window
 * ends, at least 1, from what the limiter left on the context (`rateLimit`).
 */
function tooMany(c: Context, windowMs: number): Response {
  const info: unknown = c.get("rateLimit");
  const resetTime = (info as { resetTime?: unknown } | undefined)?.resetTime;
  const ms = resetTime instanceof Date ? resetTime.getTime() - Date.now() : windowMs;
  return c.json(RATE_LIMITED, 429, { "Retry-After": String(Math.max(1, Math.ceil(ms / 1000))) });
}

/**
 * The middleware that holds a route to `limit`, counting the requests of each `keyOf(c)` in a
 * window of their own, kept in memory (hono-rate-limiter's `MemoryStore`). Every request counts,
 * the refused ones included. It sets no `RateLimit-*` headers: a 429 says what a caller needs,
 * which is when to come back.
 */
export function rateLimit<E extends Env>(
  limit: RateLimit,
  keyOf: (c: Context<E>) => string,
): MiddlewareHandler<E> {
  return rateLimiter<E>({
    limit: limit.limit,
    windowMs: limit.windowMs,
    keyGenerator: keyOf,
    standardHeaders: false,
    handler: (c) => tooMany(c, limit.windowMs),
  });
}

/** The one key of the requests that have no connection to read an address from. */
const NO_CONNECTION = "no-connection";

/**
 * The address a request comes from, as the rate limits count it. Without a proxy it is the
 * socket's remote address (`@hono/node-server`'s conninfo). Behind `trustedProxyHops` proxies,
 * each of which adds the address it saw to `X-Forwarded-For`, it is read from that header: with
 * `chain` the header's entries followed by the socket's address, the client is
 * `chain[chain.length - 1 - trustedProxyHops]`, or `chain[0]` when the chain is shorter. So the
 * entries a client writes itself, which come before the ones the proxies add, never decide it.
 *
 * A request with no connection, such as one made with `app.request()` in a test, has no address:
 * all of them share one key.
 */
export function clientKey(c: Context, trustedProxyHops: number): string {
  const bindings = c.env as { incoming?: unknown } | undefined;
  if (bindings?.incoming === undefined) return NO_CONNECTION;
  const socket = getConnInfo(c).remote.address;
  if (socket === undefined) return NO_CONNECTION;
  if (trustedProxyHops === 0) return socket;
  const forwarded = (c.req.header("X-Forwarded-For") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  const chain = [...forwarded, socket];
  return chain[chain.length - 1 - trustedProxyHops] ?? chain[0] ?? socket;
}
