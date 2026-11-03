import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { FIXTURE_ACCOUNTS } from "@tender/indexer/testing";
import { sha256Hex } from "@tender/shared";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { Account, KeyPair, KeyPairSigner, type Provider } from "near-api-js";
import * as nearNep413 from "near-api-js/nep413";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { ChallengeResponse } from "../src/auth";
import { handleError } from "../src/format";
import { type ApiDeps, clientKey, createApp, type ErrorBody } from "../src/index";
import { rateLimitsOf, uploadBudget } from "../src/limits";
import { healthRoutes } from "../src/routes/health";
import { fakeClient, resetDb, TEST_NOW, testDeps } from "./helpers";

// The limits of the routes that cost something for anyone who asks, the address a request is
// counted under, and the `Retry-After` of the answers that say to come back later. The limits
// are injected small (`ApiDeps.rateLimits`); requests made with `app.request()` have no
// connection, and so share one client address, which is what lets a test count them.

const { alice, bob } = FIXTURE_ACCOUNTS;
const BOT = "tender_test_bot";
const RATE_LIMITED: ErrorBody = {
  error: "rate_limited",
  message: "too many requests, try again later",
};

let deps: ApiDeps;

beforeAll(async () => {
  deps = await testDeps({ telegramBotUsername: BOT });
});

afterAll(() => deps.db.close());

beforeEach(() => resetDb(deps.db));

afterEach(() => {
  vi.restoreAllMocks();
});

function appWith(over: Partial<ApiDeps> = {}): Hono {
  return createApp({ ...deps, ...over });
}

const post = (app: Hono, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** A token as sign-in would have issued it to `account`, for a full-access key. */
async function tokenFor(account: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await deps.db.query(
    `insert into auth_tokens (token_sha256, account, public_key, key_kind, expires_at)
     values ($1, $2, 'ed25519:test', 'full_access', $3::timestamptz)`,
    [sha256Hex(token), account, new Date(Number(TEST_NOW / 1_000_000n) + 3_600_000).toISOString()],
  );
  return token;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** Expects the 429 of a caller over its limit, with a `Retry-After` within the window. */
async function expectLimited(res: Response, windowSecs: number): Promise<void> {
  expect(res.status).toBe(429);
  expect(await res.json()).toEqual(RATE_LIMITED);
  const retryAfter = Number(res.headers.get("retry-after"));
  expect(Number.isInteger(retryAfter)).toBe(true);
  expect(retryAfter).toBeGreaterThanOrEqual(1);
  expect(retryAfter).toBeLessThanOrEqual(windowSecs);
}

// ---- The limits -------------------------------------------------------------------------------

test("challenge_and_verify_are_limited_per_client_with_a_429_and_retry_after", async () => {
  const app = appWith({
    rateLimits: {
      challenge: { limit: 2, windowMs: 60_000 },
      verify: { limit: 3, windowMs: 60_000 },
    },
  });

  // Two challenges, then the third is refused, and nothing is stored for it.
  expect((await post(app, "/v1/auth/challenge")).status).toBe(200);
  expect((await post(app, "/v1/auth/challenge")).status).toBe(200);
  await expectLimited(await post(app, "/v1/auth/challenge"), 60);
  const [challenges] = await deps.db.query<{ n: number }>(
    "select count(*)::int as n from auth_challenges",
  );
  expect(challenges?.n).toBe(2);

  // The sign-in route counts on its own: refused sign-ins count too, up to its limit of 3.
  for (let i = 0; i < 3; i++) expect((await post(app, "/v1/auth/verify", {})).status).toBe(400);
  await expectLimited(await post(app, "/v1/auth/verify", {}), 60);

  // Each app keeps counts of its own, and the defaults are far above this.
  expect((await post(appWith(), "/v1/auth/challenge")).status).toBe(200);
});

test("telegram_link_is_limited_per_account_with_a_429_and_retry_after", async () => {
  const app = appWith({ rateLimits: { telegramLink: { limit: 2, windowMs: 600_000 } } });
  const aliceToken = await tokenFor(alice);
  const bobToken = await tokenFor(bob);

  for (let i = 0; i < 2; i++) {
    expect((await post(app, "/v1/telegram/link", undefined, bearer(aliceToken))).status).toBe(200);
  }
  await expectLimited(await post(app, "/v1/telegram/link", undefined, bearer(aliceToken)), 600);
  // No nonce is made for the refused one.
  const [nonces] = await deps.db.query<{ n: number }>(
    "select count(*)::int as n from tg_link_nonces where account = $1",
    [alice],
  );
  expect(nonces?.n).toBe(2);

  // Another account has a count of its own, though every request here has the same address.
  expect((await post(app, "/v1/telegram/link", undefined, bearer(bobToken))).status).toBe(200);
  // A request that is not signed in is refused by sign-in, before any count.
  expect((await post(app, "/v1/telegram/link")).status).toBe(401);
});

test("a_limit_lets_the_caller_in_again_once_its_window_is_over", async () => {
  const app = appWith({ rateLimits: { challenge: { limit: 1, windowMs: 300 } } });
  expect((await post(app, "/v1/auth/challenge")).status).toBe(200);
  await expectLimited(await post(app, "/v1/auth/challenge"), 1);
  await new Promise((resolve) => setTimeout(resolve, 350));
  expect((await post(app, "/v1/auth/challenge")).status).toBe(200);
});

/** The answer that `fn` stops its request with, or a failure if it stops nothing. */
function refusalOf(fn: () => void): Response {
  try {
    fn();
  } catch (error) {
    if (error instanceof HTTPException) return error.getResponse();
    throw error;
  }
  throw new Error("expected the request to be refused");
}

test("the_byte_budget_still_limits_a_key_after_the_clock_steps_back", () => {
  const HOUR = 3_600_000;
  const budget = uploadBudget(rateLimitsOf({ uploadBytes: { limit: 100, windowMs: HOUR } }), []);
  const start = Date.UTC(2026, 10, 3, 10, 0, 0);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    // Bob's window opens at 10:00 and ends at 11:00.
    vi.setSystemTime(start);
    budget.reserve(bob, "blobs", 10);
    // The clock steps back to 09:00, and Alice's window opens there and ends at 10:00. The map now
    // holds Bob's window, which ends later, ahead of Alice's, which ends sooner.
    vi.setSystemTime(start - HOUR);
    budget.reserve(alice, "blobs", 60);

    // At 10:30 Alice's window is over and Bob's is not. Alice has her whole allowance again, and
    // no more than it: a window that has ended is neither room nor a place to keep spending.
    vi.setSystemTime(start + HOUR / 2);
    budget.reserve(alice, "blobs", 60);
    const refused = refusalOf(() => budget.reserve(alice, "blobs", 60));
    expect(refused.status).toBe(429);
    // The wait is the new window's: it began at 10:30 and ends at 11:30.
    expect(refused.headers.get("retry-after")).toBe(String(HOUR / 1000));
    // Bob's window is the one he spent in, untouched.
    budget.reserve(bob, "blobs", 90);
    expect(refusalOf(() => budget.reserve(bob, "blobs", 1)).status).toBe(429);

    // Alice's new window ends at 11:30, and a clock that stands at its end has no window for her.
    vi.setSystemTime(start + 1.5 * HOUR);
    budget.reserve(alice, "blobs", 100);
  } finally {
    vi.useRealTimers();
  }
});

// ---- The client address -----------------------------------------------------------------------

/**
 * What `clientKey` makes of a request from `socket` with `forwardedFor`, behind `hops` proxies.
 * A null socket is a request with no connection.
 */
async function keyOf(
  hops: number,
  forwardedFor: string | undefined,
  socket: string | null = "10.0.0.9",
): Promise<string> {
  const app = new Hono();
  app.get("/", (c) => c.text(clientKey(c, hops)));
  const headers: Record<string, string> = {};
  if (forwardedFor !== undefined) headers["x-forwarded-for"] = forwardedFor;
  // The bindings `@hono/node-server` gives a request: its socket is where the address is read.
  const env =
    socket === null
      ? undefined
      : { incoming: { socket: { remoteAddress: socket, remotePort: 4000, remoteFamily: "IPv4" } } };
  return (await app.request("/", { headers }, env)).text();
}

test("client_key_reads_the_socket_and_trusts_only_the_proxies_entries", async () => {
  // No proxy: the socket's address, whatever the header claims.
  expect(await keyOf(0, undefined)).toBe("10.0.0.9");
  expect(await keyOf(0, "6.6.6.6")).toBe("10.0.0.9");

  // One proxy (the socket) appended the address it saw, 1.2.3.4. The client wrote 6.6.6.6 itself.
  expect(await keyOf(1, "1.2.3.4")).toBe("1.2.3.4");
  expect(await keyOf(1, "6.6.6.6, 1.2.3.4")).toBe("1.2.3.4");
  expect(await keyOf(1, "6.6.6.6,7.7.7.7,  1.2.3.4 ")).toBe("1.2.3.4");
  expect(await keyOf(1, " , 1.2.3.4")).toBe("1.2.3.4");

  // Two proxies: the first saw the client and the second saw the first.
  expect(await keyOf(2, "1.2.3.4, 10.0.0.8")).toBe("1.2.3.4");
  expect(await keyOf(2, "6.6.6.6, 1.2.3.4, 10.0.0.8")).toBe("1.2.3.4");

  // A chain shorter than the proxies said: its first entry.
  expect(await keyOf(2, undefined)).toBe("10.0.0.9");
  expect(await keyOf(2, "1.2.3.4")).toBe("1.2.3.4");
  expect(await keyOf(1, "")).toBe("10.0.0.9");

  // No connection at all, as with `app.request()`: one key for every such request.
  const none = await keyOf(1, "1.2.3.4", null);
  expect(await keyOf(0, "5.6.7.8", null)).toBe(none);
  expect(none).not.toBe("1.2.3.4");
});

test("client_key_counts_an_ipv6_client_by_its_64_and_drops_ports", async () => {
  // An IPv6 client is its /64, however its address is written.
  const v6 = "2001:db8:1:2::/64";
  for (const address of [
    "2001:db8:1:2:aaaa:bbbb:cccc:dddd",
    "2001:db8:1:2::1",
    "2001:0db8:0001:0002:0000:0000:0000:0009",
    "2001:DB8:1:2::FFFF",
    "2001:db8:1:2::5%eth0",
  ]) {
    expect(await keyOf(0, undefined, address), address).toBe(v6);
  }
  expect(await keyOf(0, undefined, "2001:db8:1:3::1")).toBe("2001:db8:1:3::/64");
  expect(await keyOf(0, undefined, "::1")).toBe("0:0:0:0::/64");
  expect(await keyOf(0, undefined, "64:ff9b::198.51.100.1")).toBe("64:ff9b:0:0::/64");
  // An IPv4 client of a socket that listens on IPv6 is its IPv4 address, and not the one /64
  // that every such client is in.
  expect(await keyOf(0, undefined, "::ffff:203.0.113.7")).toBe("203.0.113.7");
  expect(await keyOf(0, undefined, "::FFFF:203.0.113.8")).toBe("203.0.113.8");

  // The same for an entry of X-Forwarded-For, which loses a port a proxy wrote.
  expect(await keyOf(1, "1.2.3.4:5678")).toBe("1.2.3.4");
  expect(await keyOf(1, "6.6.6.6, 1.2.3.4:5678")).toBe("1.2.3.4");
  expect(await keyOf(1, "[2001:db8:1:2::7]:443")).toBe(v6);
  expect(await keyOf(1, "[2001:db8:1:2::7]")).toBe(v6);
  expect(await keyOf(1, "2001:db8:1:2::7")).toBe(v6);
  expect(await keyOf(2, "[2001:db8:1:2::7]:443, 10.0.0.8:1234")).toBe(v6);
  // What is no address stays as the proxy wrote it.
  expect(await keyOf(1, "unknown")).toBe("unknown");
});

test("client_key_takes_a_count_of_proxies_that_is_no_whole_number_as_none", async () => {
  // None means the socket's address, which the header cannot change.
  for (const hops of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
    expect(await keyOf(hops, "6.6.6.6, 1.2.3.4"), String(hops)).toBe("10.0.0.9");
  }
});

// ---- Retry-After ------------------------------------------------------------------------------

/** The body of `POST /v1/auth/verify` for a fresh key signing `ch`, as a wallet would. */
async function signedBy(ch: ChallengeResponse): Promise<Record<string, string>> {
  const key = KeyPair.fromRandom("ed25519");
  // Signing a NEP-413 message is local: the account's provider is never called.
  const signerAccount = new Account(alice, {} as unknown as Provider, new KeyPairSigner(key));
  const signed = await nearNep413.signMessage({
    signerAccount,
    payload: {
      message: ch.message,
      recipient: ch.recipient,
      nonce: Uint8Array.from(Buffer.from(ch.nonce, "base64")),
    },
  });
  return {
    account_id: alice,
    public_key: signed.publicKey.toString(),
    signature: Buffer.from(signed.signature).toString("base64"),
    nonce: ch.nonce,
    message: ch.message,
    recipient: ch.recipient,
  };
}

test("transient_503s_carry_retry_after_and_the_telegram_setting_does_not", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const down = fakeClient({
    finalHeight: async () => {
      throw new Error("rpc down");
    },
    viewAccessKey: async () => {
      throw new Error("rpc down");
    },
  });
  const app = appWith({ client: down });

  // The health check, when the chain cannot give its height.
  const health = await app.request("/v1/health");
  expect(health.status).toBe(503);
  expect(health.headers.get("retry-after")).toBe("5");

  // A sign-in, when the chain cannot say whether the key is there.
  const ch = (await (await post(appWith(), "/v1/auth/challenge")).json()) as ChallengeResponse;
  const signIn = await post(app, "/v1/auth/verify", await signedBy(ch));
  expect(signIn.status).toBe(503);
  expect(signIn.headers.get("retry-after")).toBe("5");
  expect(await signIn.json()).toEqual({
    error: "unavailable",
    message: "cannot check your key right now",
  });

  // A signed-in request, when the chain cannot say whether the token's key is still there.
  const token = await tokenFor(alice);
  const recheck = await post(app, "/v1/telegram/link", undefined, bearer(token));
  expect(recheck.status).toBe(503);
  expect(recheck.headers.get("retry-after")).toBe("5");

  // Telegram linking that is not set up is a setting: asking again changes nothing.
  const notSetUp = await post(
    appWith({ telegramBotUsername: undefined }),
    "/v1/telegram/link",
    undefined,
    bearer(token),
  );
  expect(notSetUp.status).toBe(503);
  expect(await notSetUp.json()).toEqual({
    error: "unavailable",
    message: "Telegram linking is not set up",
  });
  expect(notSetUp.headers.get("retry-after")).toBeNull();
});

test("health_gives_up_on_the_chain_at_its_deadline", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  // A chain that answers only after 300 ms, with a failure: past the deadline of 20 ms either way.
  const slow = fakeClient({
    finalHeight: () =>
      new Promise<bigint>((_, reject) => setTimeout(() => reject(new Error("late")), 300)),
  });
  const app = new Hono();
  app.onError(handleError);
  app.route("/v1", healthRoutes({ ...deps, client: slow }, { deadlineMs: 20 }));

  const started = Date.now();
  const res = await app.request("/v1/health");
  expect(Date.now() - started).toBeLessThan(250);
  expect(res.status).toBe(503);
  expect(res.headers.get("retry-after")).toBe("5");
  expect(await res.json()).toMatchObject({
    ok: false,
    error: "chain_unavailable",
    indexed_height: "0",
  });
  expect(errors).toHaveBeenCalledWith(
    "api: health: the final height is unavailable (NoAnswerInTime)",
  );

  // The answer that comes after the deadline is dropped, and is no unhandled rejection.
  await new Promise((resolve) => setTimeout(resolve, 350));

  // A chain that answers in time is unaffected by the deadline.
  const quick = new Hono();
  quick.route("/v1", healthRoutes({ ...deps, client: fakeClient() }, { deadlineMs: 1_000 }));
  expect((await quick.request("/v1/health")).status).toBe(200);
});
