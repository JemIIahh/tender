import { isIPv4, isIPv6 } from "node:net";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, Env, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { rateLimiter } from "hono-rate-limiter";
import type { ErrorBody } from "./format";

// How the API tells a caller to come back later.
//
// A few routes cost the API something for anyone who asks: a challenge is a row in the database, a
// sign-in is a question to the chain, a Telegram link is a nonce, an MCP request is a server and a
// transport that may wait 30 seconds for an answer, a health check reads the chain, a start is a
// row and an alert. Each is held to a number of requests in a window, counted per client address
// or per signed-in account in this process's memory, which is enough because one services process
// runs per database (P03-R25). Past the limit the answer is a 429 with `Retry-After`, the seconds
// until the caller's window ends.
//
// An upload is a row that stays for good, so the two upload routes are held to the bytes of the new
// rows they store as well (`uploadBudget`): so many a day for each account, past which its uploads
// are 429s, and so many an hour for all accounts together, one pool for held-out documents and one
// for the rest, past which that route's uploads are 503s until the hour is over. An entrant's
// result for a task it can still reveal in comes from a budget of its own instead of the pool, so
// that throwaway accounts that fill the pool cannot keep the task's other entrants from revealing.
// The team's accounts are held to none of these.
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

/**
 * The routes that have a limit, all in one place. `ApiDeps.rateLimits` replaces any of them; tests
 * use small ones.
 */
export interface RateLimits {
  /** `POST /v1/auth/challenge`, per client address. */
  challenge: RateLimit;
  /** `POST /v1/auth/verify`, per client address. */
  verify: RateLimit;
  /** `POST /v1/telegram/link`, per signed-in account. */
  telegramLink: RateLimit;
  /** `POST /mcp`, per client address: every request, whatever tool it calls. */
  mcp: RateLimit;
  /** `GET /v1/health`, per client address. Its read of the chain is shared too (`health.ts`). */
  health: RateLimit;
  /**
   * `POST /v1/tasks/:id/start`, per signed-in account: each new start is a row and a Telegram
   * alert to the task's watchers.
   */
  start: RateLimit;
  /** `POST /v1/blobs` and `POST /v1/heldout` together, per signed-in account: every request. */
  upload: RateLimit;
  /**
   * The bytes of the new rows that those two routes store, per signed-in account: `limit` counts
   * bytes. This and the two below hold every account but the team's.
   */
  uploadBytes: RateLimit;
  /** The bytes of the new rows `POST /v1/heldout` stores, for all accounts together. */
  heldoutBytesTotal: RateLimit;
  /** The bytes of the new rows `POST /v1/blobs` stores, for all accounts together. */
  blobBytesTotal: RateLimit;
  /**
   * Every write to a task's question board (ask, answer, hide, clarify), per signed-in account. A
   * write that the board's own limits refuse still takes a lock on the events table, so this holds
   * an account that keeps asking to the cost of one that does not. The limits on what a board
   * keeps are `BOARD_LIMITS`, in `@tender/shared`.
   */
  board: RateLimit;
  /** `POST /v1/connect/codes`, per signed-in account: the codes an owner makes. */
  connectCreate: RateLimit;
  /** `GET /v1/connect/codes/:id`, per signed-in account: an owner's page asking how a code stands. */
  connectRead: RateLimit;
  /**
   * Every connect route but the owner's read, per client address: the codes made there, and the
   * lookups, attachments and last words of the agents, which no account signs.
   */
  connectClient: RateLimit;
  /** Every listing and every change of a service (`POST /v1/services`, `POST /v1/services/:id`), per signed-in account. */
  services: RateLimit;
  /**
   * `POST /v1/gas-gift`, per client address. A gift is once per login and per account, and the
   * day's total has a cap of its own; this only keeps one address from making the API verify
   * tokens and ask the chain over and over.
   */
  gasGift: RateLimit;
}

const HOUR_MS = 60 * 60_000;
const MIB = 1024 * 1024;

export const DEFAULT_RATE_LIMITS: Readonly<RateLimits> = Object.freeze({
  challenge: { limit: 30, windowMs: 60_000 },
  verify: { limit: 30, windowMs: 60_000 },
  telegramLink: { limit: 10, windowMs: 10 * 60_000 },
  // 5 a second: an agent browsing the board makes a call or two a second at most, and a client that
  // shares an address with others (a proxy left at 0 hops) has room beside them.
  mcp: { limit: 300, windowMs: 60_000 },
  // A monitor asks every few seconds, and each tab of the web app asks with its other reads; 5 a
  // second leaves room for many of them behind one address.
  health: { limit: 300, windowMs: 60_000 },
  // An agent starts a task when it takes one on: a few an hour. 30 a minute is room for a burst.
  start: { limit: 30, windowMs: 60_000 },
  upload: { limit: 60, windowMs: HOUR_MS },
  uploadBytes: { limit: 8 * MIB, windowMs: 24 * HOUR_MS },
  heldoutBytesTotal: { limit: 128 * MIB, windowMs: HOUR_MS },
  blobBytesTotal: { limit: 256 * MIB, windowMs: HOUR_MS },
  // A poster who answers a full board of 200 questions in one sitting makes 30 a minute for seven
  // minutes; an agent asking makes a few an hour, and the board's own limits hold it to that.
  board: { limit: 30, windowMs: 60_000 },
  // An owner adds an agent or two at a sitting; ten codes in ten minutes leaves room for mistakes.
  connectCreate: { limit: 10, windowMs: 10 * 60_000 },
  // The page asks every 2 seconds while it waits on the agent: 30 a minute, with room for two tabs.
  connectRead: { limit: 120, windowMs: 60_000 },
  // An agent looks a code up, attaches its key and says it registered: a few calls each. A code is
  // 130 random bits, so this is about load, not guessing.
  connectClient: { limit: 60, windowMs: 10 * 60_000 },
  // A provider that lists its agents' services, or pauses all of them, makes a few writes a minute.
  services: { limit: 30, windowMs: 60_000 },
  // A person asks once, as their first login finishes, and maybe again after a failure. 30 in ten
  // minutes leaves room for the people behind one address.
  gasGift: { limit: 30, windowMs: 10 * 60_000 },
});

/** The limits in `over` where it has them, and the defaults for the rest. */
export function rateLimitsOf(over: Partial<RateLimits> | undefined): RateLimits {
  return {
    challenge: over?.challenge ?? DEFAULT_RATE_LIMITS.challenge,
    verify: over?.verify ?? DEFAULT_RATE_LIMITS.verify,
    telegramLink: over?.telegramLink ?? DEFAULT_RATE_LIMITS.telegramLink,
    mcp: over?.mcp ?? DEFAULT_RATE_LIMITS.mcp,
    health: over?.health ?? DEFAULT_RATE_LIMITS.health,
    start: over?.start ?? DEFAULT_RATE_LIMITS.start,
    upload: over?.upload ?? DEFAULT_RATE_LIMITS.upload,
    uploadBytes: over?.uploadBytes ?? DEFAULT_RATE_LIMITS.uploadBytes,
    heldoutBytesTotal: over?.heldoutBytesTotal ?? DEFAULT_RATE_LIMITS.heldoutBytesTotal,
    blobBytesTotal: over?.blobBytesTotal ?? DEFAULT_RATE_LIMITS.blobBytesTotal,
    board: over?.board ?? DEFAULT_RATE_LIMITS.board,
    connectCreate: over?.connectCreate ?? DEFAULT_RATE_LIMITS.connectCreate,
    connectRead: over?.connectRead ?? DEFAULT_RATE_LIMITS.connectRead,
    connectClient: over?.connectClient ?? DEFAULT_RATE_LIMITS.connectClient,
    services: over?.services ?? DEFAULT_RATE_LIMITS.services,
    gasGift: over?.gasGift ?? DEFAULT_RATE_LIMITS.gasGift,
  };
}

const RATE_LIMITED: ErrorBody = {
  error: "rate_limited",
  message: "too many requests, try again later",
};

/** `Retry-After` for a wait of `ms`: whole seconds, at least 1. */
function retryAfter(ms: number): { "Retry-After": string } {
  return { "Retry-After": String(Math.max(1, Math.ceil(ms / 1000))) };
}

/**
 * The 429 of a caller over its limit. `Retry-After` is the whole seconds until the caller's window
 * ends, at least 1, from what the limiter left on the context (`rateLimit`).
 */
function tooMany(c: Context, windowMs: number): Response {
  const info: unknown = c.get("rateLimit");
  const resetTime = (info as { resetTime?: unknown } | undefined)?.resetTime;
  const ms = resetTime instanceof Date ? resetTime.getTime() - Date.now() : windowMs;
  return c.json(RATE_LIMITED, 429, retryAfter(ms));
}

/**
 * The middleware that holds a route to `limit`, counting the requests of each `keyOf(c)` in a
 * window of their own, kept in memory (hono-rate-limiter's `MemoryStore`). Every request counts,
 * the refused ones included, except one that `skip` lets through, which is not counted at all. It
 * sets no `RateLimit-*` headers: a 429 says what a caller needs, which is when to come back.
 */
export function rateLimit<E extends Env>(
  limit: RateLimit,
  keyOf: (c: Context<E>) => string,
  skip: (c: Context<E>) => boolean = () => false,
): MiddlewareHandler<E> {
  return rateLimiter<E>({
    limit: limit.limit,
    windowMs: limit.windowMs,
    keyGenerator: keyOf,
    skip,
    standardHeaders: false,
    handler: (c) => tooMany(c, limit.windowMs),
  });
}

// ---- Bytes ------------------------------------------------------------------------------------

/**
 * The bytes each key has spent, in a window of `limit.windowMs` that begins with the first bytes it
 * spends and holds at most `limit.limit` of them, kept in this process's memory. The windows are
 * kept in the order they began, which is the order they end in while the wall clock runs forward,
 * so the ones that are over are dropped from the front and the map holds only the keys that spent
 * something lately. A clock that steps back breaks that order and leaves an ended window behind a
 * live one, so a window is read only if it has not ended (`live`): one that has is no window.
 */
class ByteWindows {
  readonly #windows = new Map<string, { spent: number; endsAt: number }>();

  constructor(readonly limit: RateLimit) {}

  /**
   * How many milliseconds `key` has to wait before it may spend `bytes`: 0 when it may now. A limit
   * that is not a number has room for nothing.
   */
  wait(key: string, bytes: number, now: number): number {
    for (const [ended, window] of this.#windows) {
      if (window.endsAt > now) break;
      this.#windows.delete(ended);
    }
    const window = this.#live(key, now);
    if ((window?.spent ?? 0) + bytes <= this.limit.limit) return 0;
    return window === undefined ? this.limit.windowMs : window.endsAt - now;
  }

  /**
   * `key`'s window if it has not ended by `now`. One that has (`endsAt <= now`) is no window: it is
   * dropped, as the front of the map is, so that it neither reads as room nor takes more bytes.
   * The clock stepping back can leave it behind a window that ends later, out of reach of the
   * pruning at the front.
   */
  #live(key: string, now: number): { spent: number; endsAt: number } | undefined {
    const window = this.#windows.get(key);
    if (window === undefined || window.endsAt > now) return window;
    this.#windows.delete(key);
    return undefined;
  }

  /**
   * Takes `bytes` from `key`'s window, which `wait` has said has room for them, and gives back the
   * function that returns them to that window, once. Bytes returned after the window is over go
   * nowhere: the next window begins empty whatever was taken from the last.
   */
  spend(key: string, bytes: number, now: number): () => void {
    let window = this.#live(key, now);
    if (window === undefined) {
      window = { spent: 0, endsAt: now + this.limit.windowMs };
      this.#windows.set(key, window);
    }
    window.spent += bytes;
    const taken = window;
    let returned = false;
    return () => {
      if (returned) return;
      returned = true;
      taken.spent -= bytes;
    };
  }
}

/** The two upload routes, which draw on pools of their own. */
export type UploadRoute = "heldout" | "blobs";

const UPLOADED_TOO_MUCH: ErrorBody = {
  error: "rate_limited",
  message: "this account has uploaded too many bytes, try again later",
};

/** What a route whose pool is used up answers. */
const POOL_USED_UP: Record<UploadRoute, ErrorBody> = {
  heldout: {
    error: "unavailable",
    message: "the API is taking no more held-out documents for now, try again later",
  },
  blobs: {
    error: "unavailable",
    message: "the API is taking no more uploads for now, try again later",
  },
};

/** Stops the request with `status`, `body` and the `Retry-After` of `ms`. `app.onError` sends it. */
function refuseFor(status: 429 | 503, body: ErrorBody, ms: number): never {
  throw new HTTPException(status, {
    res: Response.json(body, { status, headers: retryAfter(ms) }),
    message: body.message,
  });
}

/**
 * Stops the request with a 429 (`rate_limited`) and a `Retry-After` of `seconds`, for a limit that
 * a route works out itself, such as the board's per-hour counts, which only the database can
 * decide. `app.onError` sends it.
 */
export function rateLimitedFor(message: string, seconds: number): never {
  return refuseFor(429, { error: "rate_limited", message }, seconds * 1000);
}

/** The one key of a pool's own window. */
const POOL = "pool";

/**
 * The budget of its own that an entrant's result is charged to (`uploadBudget`): the entrant's,
 * for one task, while it can still reveal there.
 */
export interface EntrantAllowance {
  /** The task and the account, as one key. */
  key: string;
  /** The most bytes of new rows the entrant may store for the task: what a result may have. */
  bytes: number;
  /** The task's reveal deadline, after which the allowance is gone, in nanoseconds. */
  untilNs: bigint;
  /** The time of the request, by the API's clock, in nanoseconds. */
  nowNs: bigint;
}

/**
 * The bytes of new rows that the upload routes of one app may still store, in this process's
 * memory and by the wall clock: `limits.uploadBytes` for each signed-in account, and for all
 * accounts together `limits.heldoutBytesTotal` of held-out documents and `limits.blobBytesTotal` of
 * the rest. The two pools are apart, so a flood of results or briefs cannot stop a held-out
 * document, which a poster has to send within minutes of posting. The team's accounts
 * (`teamAccounts`) are held to none of them.
 *
 * A result whose uploader has a commitment on its task that is not revealed yet, while the task
 * takes reveals, is charged to that entrant's allowance for the task (`own`, `EntrantAllowance`)
 * instead of the pool: the bytes the task's brief lets a result have, kept until the reveal
 * deadline. So no flood of other uploads, from however many accounts, can keep an entrant from
 * uploading the result it reveals. Each allowance is bounded by the chain: one for each entry,
 * which costs its entrant storage and, on an open task, a bond. Past it, the result is the pool's
 * like any other upload. The account's own budget holds either way.
 *
 * Only a new row costs anything: bytes that are stored already, and an upload that is refused,
 * store none. `reserve(account, route, bytes)` is called once an upload is found good and its bytes
 * are not stored yet. It takes them from the account's budget and from the route's pool, or stops
 * the request: with a 429 (`rate_limited`) when the account has no room for them, and else with a
 * 503 (`unavailable`) when the pool has none, each with the `Retry-After` of the window that is
 * full. Nothing is taken unless both have room. It gives back the function that returns the bytes,
 * for an upload that stores no row after all: another upload stored the same bytes meanwhile, or
 * the store failed.
 */
export function uploadBudget(limits: RateLimits, teamAccounts: readonly string[]) {
  const team = new Set(teamAccounts);
  const perAccount = new ByteWindows(limits.uploadBytes);
  const pools: Record<UploadRoute, ByteWindows> = {
    heldout: new ByteWindows(limits.heldoutBytesTotal),
    blobs: new ByteWindows(limits.blobBytesTotal),
  };
  /** What each entrant has spent of its allowance for a task, by `EntrantAllowance.key`. */
  const entrants = new Map<string, { spent: number; untilNs: bigint }>();
  return {
    reserve(
      account: string,
      route: UploadRoute,
      bytes: number,
      own?: EntrantAllowance,
    ): () => void {
      if (team.has(account)) return () => {};
      const now = Date.now();
      const pool = pools[route];
      const accountWait = perAccount.wait(account, bytes, now);
      if (accountWait > 0) refuseFor(429, UPLOADED_TOO_MUCH, accountWait);
      if (own !== undefined) {
        // The allowances whose reveals are over are gone.
        for (const [key, held] of entrants) if (held.untilNs <= own.nowNs) entrants.delete(key);
        const held = entrants.get(own.key) ?? { spent: 0, untilNs: own.untilNs };
        if (own.nowNs < own.untilNs && held.spent + bytes <= own.bytes) {
          held.spent += bytes;
          entrants.set(own.key, held);
          const returnToAccount = perAccount.spend(account, bytes, now);
          let returned = false;
          return () => {
            if (returned) return;
            returned = true;
            returnToAccount();
            held.spent -= bytes;
          };
        }
      }
      const poolWait = pool.wait(POOL, bytes, now);
      if (poolWait > 0) refuseFor(503, POOL_USED_UP[route], poolWait);
      const returnToAccount = perAccount.spend(account, bytes, now);
      const returnToPool = pool.spend(POOL, bytes, now);
      return () => {
        returnToAccount();
        returnToPool();
      };
    },
  };
}

/** The one key of the requests that have no connection to read an address from. */
const NO_CONNECTION = "no-connection";

/**
 * An IPv4 address, as in `1.2.3.4`, and the three places one is looked for: alone with a port, at
 * the end of an IPv6 address, and mapped into one.
 */
const IPV4 = String.raw`\d{1,3}(?:\.\d{1,3}){3}`;
const IPV4_WITH_PORT = new RegExp(`^(${IPV4}):\\d+$`);
const IPV4_AT_END = new RegExp(`(${IPV4})$`);
const IPV4_MAPPED = new RegExp(`^::ffff:(${IPV4})$`, "i");

/**
 * An `X-Forwarded-For` entry as an address alone: some proxies write the port too, as in
 * `1.2.3.4:5678` or `[2001:db8::1]:443`, and each connection would count on its own.
 */
function withoutPort(entry: string): string {
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(entry);
  if (bracketed?.[1] !== undefined) return bracketed[1];
  return IPV4_WITH_PORT.exec(entry)?.[1] ?? entry;
}

/** The eight 16-bit groups of an IPv6 address. An IPv4 address at its end is the last two. */
function groupsOf(address: string): number[] {
  let text = address;
  const tail = IPV4_AT_END.exec(text);
  if (tail?.[1] !== undefined) {
    const [a = 0, b = 0, c = 0, d = 0] = tail[1].split(".").map(Number);
    text = `${text.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", rest] = text.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = rest === undefined || rest === "" ? [] : rest.split(":");
  const zeros = rest === undefined ? [] : Array<string>(8 - left.length - right.length).fill("0");
  return [...left, ...zeros, ...right].map((group) => Number.parseInt(group, 16));
}

/**
 * What a client address is counted as. An IPv4 address is itself, and so is the one an IPv6 socket
 * gives for an IPv4 client (`::ffff:1.2.3.4`). An IPv6 address is its /64, which is what a host
 * is usually given: it could otherwise take a new address, and a new allowance, for each request.
 * Anything else, such as a name that a proxy wrote, is as it is.
 */
function counted(address: string): string {
  // A zone, as in fe80::1%eth0, names the interface, not the client.
  const bare = address.replace(/%.*$/, "");
  const mapped = IPV4_MAPPED.exec(bare)?.[1];
  if (mapped !== undefined) return mapped;
  if (isIPv4(bare) || !isIPv6(bare)) return address;
  const prefix = groupsOf(bare).slice(0, 4);
  return `${prefix.map((group) => group.toString(16)).join(":")}::/64`;
}

/**
 * The client a request comes from, as the rate limits count it. Without a proxy it is the socket's
 * remote address (`@hono/node-server`'s conninfo). Behind `trustedProxyHops` proxies, each of
 * which adds the address it saw to `X-Forwarded-For`, it is read from that header: with `chain`
 * the header's entries followed by the socket's address, the client is
 * `chain[chain.length - 1 - trustedProxyHops]`, or `chain[0]` when the chain is shorter. So the
 * entries a client writes itself, which come before the ones the proxies add, never decide it. A
 * `trustedProxyHops` that is no whole number from 0 counts as 0: the socket's address, which no
 * header can forge.
 *
 * Each entry loses a port it carries, and the address is then counted as `counted` says: an IPv6
 * client by its /64. A request with no connection, such as one made with `app.request()` in a
 * test, has no address: all of them share one key.
 */
export function clientKey(c: Context, trustedProxyHops: number): string {
  const hops =
    Number.isSafeInteger(trustedProxyHops) && trustedProxyHops >= 0 ? trustedProxyHops : 0;
  const bindings = c.env as { incoming?: unknown } | undefined;
  if (bindings?.incoming === undefined) return NO_CONNECTION;
  const socket = getConnInfo(c).remote.address;
  if (socket === undefined) return NO_CONNECTION;
  if (hops === 0) return counted(socket);
  const forwarded = (c.req.header("X-Forwarded-For") ?? "")
    .split(",")
    .map((entry) => withoutPort(entry.trim()))
    .filter((entry) => entry !== "");
  const chain = [...forwarded, socket];
  return counted(chain[chain.length - 1 - hops] ?? chain[0] ?? socket);
}
