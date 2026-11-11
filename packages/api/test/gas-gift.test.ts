import { generateKeyPairSync } from "node:crypto";
import { GasGiftResponseSchema } from "@tender/shared";
import { type CryptoKey, exportSPKI, generateKeyPair, SignJWT } from "jose";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { GasGift } from "../src/deps";
import { type ApiDeps, createApp, type ErrorBody, PRIVY_ISSUER, readPrivyKey } from "../src/index";
import { resetDb, TEST_NOW, testDeps } from "./helpers";

// `POST /v1/gas-gift`: the login's token, the account, the once-per-login-and-per-account rule, the
// daily cap, the claim that two calls at once cannot both win, and a failed transfer letting its
// claim go. The key pair the login signs with is made here, as `jose` makes one, and the chain is
// a fake: what an account holds is a map, and a transfer is a function the test controls.
// `scripts/serve.sandbox.test.ts` sends a real gift on a local chain.

const SECOND_NS = 1_000_000_000n;
const DAY_NS = 24n * 60n * 60n * SECOND_NS;
const APP_ID = "tender-app-for-tests";
const USER = "did:privy:user-one";
const OTHER_USER = "did:privy:user-two";
const ACCOUNT = "ab".repeat(32);
const OTHER_ACCOUNT = "cd".repeat(32);
const NEAR = 10n ** 24n;
const AMOUNT = NEAR / 10n;
const MIN_BALANCE = NEAR / 20n;

let deps: ApiDeps;
let nowNs = TEST_NOW;
let signingKey: CryptoKey;
let pem: string;
/** What each account holds, for the fake chain; an account not in it holds nothing. */
const balances = new Map<string, bigint>();
/** Every transfer the fake chain was asked for, in order. */
let transfers: Array<{ to: string; amount: bigint }> = [];

beforeAll(async () => {
  deps = await testDeps({ network: "testnet", now: () => nowNs });
  const pair = await generateKeyPair("ES256", { extractable: true });
  signingKey = pair.privateKey;
  pem = await exportSPKI(pair.publicKey);
});

afterAll(() => deps.db.close());

beforeEach(async () => {
  await resetDb(deps.db);
  nowNs = TEST_NOW;
  balances.clear();
  transfers = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The gift as `serve` would make it, with the fake chain, and `over` on top. */
function giftWith(over: Partial<GasGift> = {}): GasGift {
  return {
    account: "gift.testnet",
    privyAppId: APP_ID,
    privyVerificationKey: pem,
    amount: AMOUNT,
    minBalance: MIN_BALANCE,
    dailyCap: 2n * NEAR,
    balanceOf: async (accountId) => balances.get(accountId) ?? 0n,
    transfer: async (to, amount) => {
      transfers.push({ to, amount });
      return { txHash: `tx-${transfers.length}` };
    },
    ...over,
  };
}

const appWith = (gift: GasGift | undefined = giftWith(), over: Partial<ApiDeps> = {}) =>
  createApp({ ...deps, gasGift: gift, ...over });

type App = ReturnType<typeof createApp>;

const nowSeconds = () => Number(nowNs / SECOND_NS);

/** A token as the login issues one, for `USER` and this app, good for an hour; `o` changes it. */
async function tokenFor(
  o: {
    sub?: string | null;
    aud?: string;
    iss?: string;
    iat?: number;
    exp?: number | null;
    key?: CryptoKey;
  } = {},
): Promise<string> {
  const jwt = new SignJWT({ sid: "session-for-tests" })
    .setProtectedHeader({ alg: "ES256", typ: "JWT" })
    .setIssuer(o.iss ?? PRIVY_ISSUER)
    .setAudience(o.aud ?? APP_ID)
    .setIssuedAt(o.iat ?? nowSeconds() - 60);
  if (o.exp !== null) jwt.setExpirationTime(o.exp ?? nowSeconds() + 3600);
  if (o.sub !== null) jwt.setSubject(o.sub ?? USER);
  return jwt.sign(o.key ?? signingKey);
}

interface Reply<T> {
  status: number;
  body: T;
  headers: Headers;
}

/** Posts to the route with `authorization` as it is (none when undefined) and `body` as JSON. */
async function post<T = unknown>(
  app: App,
  authorization: string | undefined,
  body: unknown = { account_id: ACCOUNT },
  raw?: string,
): Promise<Reply<T>> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (authorization !== undefined) headers.Authorization = authorization;
  const res = await app.request("/v1/gas-gift", {
    method: "POST",
    headers,
    body: raw ?? JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T, headers: res.headers };
}

/** Asks for the gift as `sub`, for `accountId`, with a good token. */
async function ask(app: App, sub = USER, accountId = ACCOUNT) {
  return post(app, `Bearer ${await tokenFor({ sub })}`, { account_id: accountId });
}

async function rows() {
  return deps.db.query<{
    privy_user: string;
    account_id: string;
    amount: string;
    status: string;
    tx_hash: string | null;
  }>(
    "select privy_user, account_id, amount::text as amount, status, tx_hash from gas_gifts order by created_at, privy_user",
  );
}

test("a_good_token_gets_the_gift_and_the_row_records_it", async () => {
  const reply = await ask(appWith());
  expect(reply.status).toBe(200);
  expect(GasGiftResponseSchema.parse(reply.body)).toEqual({
    status: "sent",
    amount: `${AMOUNT}`,
    tx_hash: "tx-1",
  });
  expect(reply.headers.get("cache-control")).toBe("no-store");
  expect(transfers).toEqual([{ to: ACCOUNT, amount: AMOUNT }]);
  expect(await rows()).toEqual([
    { privy_user: USER, account_id: ACCOUNT, amount: `${AMOUNT}`, status: "sent", tx_hash: "tx-1" },
  ]);
});

test("every_fault_of_the_token_is_the_same_401_and_sends_nothing", async () => {
  const app = appWith();
  const other = await generateKeyPair("ES256");
  const hmac = new TextEncoder().encode("a shared secret of thirty-two bytes!");
  const cases: Array<[string, string | undefined]> = [
    ["no token", undefined],
    ["another scheme", `Basic ${Buffer.from("a:b").toString("base64")}`],
    ["not a JWT", "Bearer not-a-token"],
    ["a bad signature", `Bearer ${await tokenFor({ key: other.privateKey })}`],
    ["a wrong audience", `Bearer ${await tokenFor({ aud: "another-app" })}`],
    ["a wrong issuer", `Bearer ${await tokenFor({ iss: "auth.example" })}`],
    // Past the 30 s that the clocks may be apart.
    ["an expired token", `Bearer ${await tokenFor({ exp: nowSeconds() - 31 })}`],
    ["no expiry", `Bearer ${await tokenFor({ exp: null })}`],
    ["no user", `Bearer ${await tokenFor({ sub: null })}`],
    ["a user that is not the login's", `Bearer ${await tokenFor({ sub: "alice.testnet" })}`],
    [
      "another algorithm",
      `Bearer ${await new SignJWT({})
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer(PRIVY_ISSUER)
        .setAudience(APP_ID)
        .setSubject(USER)
        .setExpirationTime(nowSeconds() + 3600)
        .sign(hmac)}`,
    ],
    ["a token too long to read", `Bearer ${"a".repeat(5000)}.${"b".repeat(5000)}.c`],
  ];
  const bodies = new Set<string>();
  for (const [what, authorization] of cases) {
    const reply = await post<ErrorBody>(app, authorization);
    expect(reply.status, what).toBe(401);
    expect(reply.body.error, what).toBe("unauthorized");
    expect(reply.headers.get("www-authenticate"), what).toBe("Bearer");
    bodies.add(JSON.stringify(reply.body));
  }
  // The answer does not say which check failed.
  expect(bodies.size).toBe(1);
  expect(transfers).toEqual([]);
  expect(await rows()).toEqual([]);

  // Within the 30 s, a token that just ran out is still good: the clocks may be apart that much.
  const late = await post(app, `Bearer ${await tokenFor({ exp: nowSeconds() - 20 })}`);
  expect(late.status).toBe(200);
});

test("only_an_implicit_account_gets_a_gift", async () => {
  const app = appWith();
  const authorization = `Bearer ${await tokenFor()}`;
  for (const accountId of [
    "alice.testnet",
    "AB".repeat(32),
    "a".repeat(63),
    "a".repeat(65),
    `0x${"ab".repeat(20)}`,
    `${"ab".repeat(31)}zz`,
  ]) {
    const reply = await post<ErrorBody>(app, authorization, { account_id: accountId });
    expect(reply.status, accountId).toBe(400);
    expect(reply.body.error, accountId).toBe("not_implicit");
  }
  // A body that names no account is a plain bad request.
  for (const [body, raw] of [
    [{}],
    [{ account_id: 5 }],
    [[ACCOUNT]],
    [undefined, "{not json"],
  ] as const) {
    const reply = await post<ErrorBody>(app, authorization, body, raw);
    expect(reply.status, JSON.stringify(body)).toBe(400);
    expect(reply.body.error).toBe("bad_request");
  }
  // The token is checked before the body.
  expect((await post(app, undefined, { account_id: "alice.testnet" })).status).toBe(401);
  // A body too large is refused as it comes.
  expect(
    (await post(app, authorization, { account_id: ACCOUNT, pad: "x".repeat(5000) })).status,
  ).toBe(413);
  expect(transfers).toEqual([]);
});

test("an_account_that_holds_enough_already_gets_nothing", async () => {
  const app = appWith();
  balances.set(ACCOUNT, MIN_BALANCE);
  const reply = await ask(app);
  expect(reply.status).toBe(200);
  expect(GasGiftResponseSchema.parse(reply.body)).toEqual({
    status: "not_needed",
    balance: `${MIN_BALANCE}`,
  });
  expect(transfers).toEqual([]);
  expect(await rows()).toEqual([]);

  // A yoctoNEAR below it does get one.
  balances.set(ACCOUNT, MIN_BALANCE - 1n);
  expect((await ask(app)).body).toMatchObject({ status: "sent" });
});

test("a_gift_is_once_per_login_and_once_per_account", async () => {
  const app = appWith();
  expect((await ask(app, USER, ACCOUNT)).status).toBe(200);
  // The same login, for another account.
  const again = await ask(app, USER, OTHER_ACCOUNT);
  expect(again.status).toBe(409);
  expect((again.body as ErrorBody).error).toBe("already_given");
  // Another login, for the same account: the account holds the gift now, and is not asked first.
  balances.set(ACCOUNT, AMOUNT);
  const twice = await ask(app, OTHER_USER, ACCOUNT);
  expect(twice.status).toBe(409);
  expect((twice.body as ErrorBody).error).toBe("already_given");
  expect(transfers).toHaveLength(1);
});

test("of_calls_at_once_for_one_login_or_one_account_only_one_sends", async () => {
  let release: () => void = () => undefined;
  const app = appWith(
    giftWith({
      transfer: async (to, amount) => {
        transfers.push({ to, amount });
        // Each transfer waits until the test lets it go, so that every call is in flight at once.
        await new Promise<void>((resolve) => {
          const before = release;
          release = () => {
            before();
            resolve();
          };
        });
        return { txHash: `tx-${transfers.length}` };
      },
    }),
  );
  /**
   * Sends all of `calls` at once, and lets the transfers go only once every call has either been
   * answered or reached its transfer: so each one was decided while the others were in flight.
   */
  async function atOnce(calls: Array<[string, string]>) {
    const before = transfers.length;
    let answered = 0;
    const replies = calls.map(([sub, accountId]) =>
      ask(app, sub, accountId).then((reply) => {
        answered += 1;
        return reply;
      }),
    );
    while (answered + transfers.length - before < calls.length) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    release();
    return (await Promise.all(replies)).map((reply) => reply.status).sort();
  }
  // One login, three accounts: one gift.
  expect(
    await atOnce([
      [USER, "a1".repeat(32)],
      [USER, "a2".repeat(32)],
      [USER, "a3".repeat(32)],
    ]),
  ).toEqual([200, 409, 409]);
  expect(transfers).toHaveLength(1);
  // One account, three logins: one gift.
  expect(
    await atOnce([
      ["did:privy:b1", ACCOUNT],
      ["did:privy:b2", ACCOUNT],
      ["did:privy:b3", ACCOUNT],
    ]),
  ).toEqual([200, 409, 409]);
  expect(transfers).toHaveLength(2);
  expect(await rows()).toHaveLength(2);
});

test("the_days_gifts_stop_at_the_cap_until_the_next_utc_day", async () => {
  const app = appWith(giftWith({ dailyCap: 2n * AMOUNT }));
  expect((await ask(app, "did:privy:a", "a1".repeat(32))).status).toBe(200);
  // One that holds enough takes nothing from the day.
  balances.set("a2".repeat(32), NEAR);
  expect((await ask(app, "did:privy:b", "a2".repeat(32))).body).toMatchObject({
    status: "not_needed",
  });
  expect((await ask(app, "did:privy:c", "a3".repeat(32))).status).toBe(200);
  const over = await ask(app, "did:privy:d", "a4".repeat(32));
  expect(over.status).toBe(429);
  expect((over.body as ErrorBody).error).toBe("daily_limit");
  // TEST_NOW (1793307200 s) is 20:53:20 UTC, so the next UTC day is 11200 s away.
  expect(over.headers.get("retry-after")).toBe("11200");
  expect(transfers).toHaveLength(2);

  nowNs = TEST_NOW + DAY_NS;
  expect((await ask(app, "did:privy:d", "a4".repeat(32))).status).toBe(200);
});

test("the_gift_is_off_without_its_settings_and_on_mainnet", async () => {
  const token = `Bearer ${await tokenFor()}`;
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const ed = generateKeyPairSync("ed25519");
  const offs: Array<[string, App]> = [
    ["no gift", createApp({ ...deps, gasGift: undefined })],
    ["no account", appWith(giftWith({ account: "" }))],
    ["no app id", appWith(giftWith({ privyAppId: "" }))],
    ["no key", appWith(giftWith({ privyVerificationKey: "" }))],
    ["a key that is no PEM", appWith(giftWith({ privyVerificationKey: "not a key" }))],
    [
      "an RSA key",
      appWith(
        giftWith({
          privyVerificationKey: rsa.publicKey.export({ type: "spki", format: "pem" }).toString(),
        }),
      ),
    ],
    [
      "an Ed25519 key",
      appWith(
        giftWith({
          privyVerificationKey: ed.publicKey.export({ type: "spki", format: "pem" }).toString(),
        }),
      ),
    ],
    ["no amount", appWith(giftWith({ amount: 0n }))],
    ["a cap below one gift", appWith(giftWith({ dailyCap: AMOUNT - 1n }))],
    ["mainnet", appWith(giftWith(), { network: "mainnet" })],
  ];
  for (const [what, app] of offs) {
    for (const authorization of [token, undefined]) {
      const reply = await post<ErrorBody>(app, authorization);
      expect(reply.status, what).toBe(503);
      expect(reply.body.error, what).toBe("gift_off");
      // A setting is the cause: asking again soon changes nothing.
      expect(reply.headers.get("retry-after"), what).toBeNull();
    }
  }
  expect(transfers).toEqual([]);
});

test("a_failed_transfer_lets_its_claim_go_so_that_a_retry_works", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  let fail = true;
  const app = appWith(
    giftWith({
      transfer: async (to, amount) => {
        transfers.push({ to, amount });
        if (fail) throw new Error("rpc https://rpc.example/?apikey=s3cret-rpc-key refused it");
        return { txHash: "tx-after-retry" };
      },
    }),
  );
  const token = `Bearer ${await tokenFor()}`;
  const failed = await post<ErrorBody>(app, token);
  expect(failed.status).toBe(502);
  expect(failed.body.error).toBe("transfer_failed");
  expect(await rows()).toEqual([]);
  // Logged by name, never with the error's text, nor the token.
  const logged = errors.mock.calls.map((call) => call.join(" ")).join("\n");
  expect(logged).toContain("was not sent (Error)");
  expect(logged).not.toContain("s3cret");
  expect(logged).not.toContain(token.slice(7));

  fail = false;
  const retry = await post(app, token);
  expect(retry.status).toBe(200);
  expect(retry.body).toMatchObject({ status: "sent", tx_hash: "tx-after-retry" });
  expect(transfers).toHaveLength(2);
});

test("a_balance_the_chain_cannot_give_is_a_503_to_try_again", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const app = appWith(
    giftWith({
      balanceOf: async () => {
        throw new Error("node down");
      },
    }),
  );
  const reply = await ask(app);
  expect(reply.status).toBe(503);
  expect((reply.body as ErrorBody).error).toBe("unavailable");
  expect(reply.headers.get("retry-after")).toBe("5");
  expect(transfers).toEqual([]);
  expect(await rows()).toEqual([]);
});

test("a_claim_left_by_a_process_that_died_goes_after_ten_minutes", async () => {
  const app = appWith();
  const claimedAt = (minutesAgo: number) =>
    new Date(Number(nowNs / 1_000_000n) - minutesAgo * 60_000).toISOString();
  await deps.db.query(
    `insert into gas_gifts (privy_user, account_id, amount, status, created_at)
     values ($1, $2, $3, 'claimed', $4::timestamptz)`,
    [USER, ACCOUNT, `${AMOUNT}`, claimedAt(9)],
  );
  // Nine minutes on, it may still be on its way.
  expect((await ask(app)).status).toBe(409);
  nowNs += 2n * 60n * SECOND_NS;
  // Eleven: no transfer takes that long, so the claim is let go.
  const reply = await ask(app);
  expect(reply.status).toBe(200);
  expect(await rows()).toEqual([
    { privy_user: USER, account_id: ACCOUNT, amount: `${AMOUNT}`, status: "sent", tx_hash: "tx-1" },
  ]);
});

test("one_address_is_held_to_its_rate_limit", async () => {
  const app = appWith(giftWith(), { rateLimits: { gasGift: { limit: 2, windowMs: 60_000 } } });
  expect((await ask(app, "did:privy:a", "a1".repeat(32))).status).toBe(200);
  expect((await ask(app, "did:privy:b", "a2".repeat(32))).status).toBe(200);
  const third = await ask(app, "did:privy:c", "a3".repeat(32));
  expect(third.status).toBe(429);
  expect((third.body as ErrorBody).error).toBe("rate_limited");
});

test("the_verification_key_is_read_with_real_line_breaks_or_with_escapes", () => {
  expect(readPrivyKey(pem)).toBe(pem.trim());
  // As a host keeps a setting on one line.
  expect(readPrivyKey(`  ${pem.trim().replaceAll("\n", "\\n")}  `)).toBe(pem.trim());
  expect(readPrivyKey(pem.replaceAll("\n", "\r\n"))).toBe(pem.trim());
  expect(readPrivyKey("")).toBeNull();
  expect(readPrivyKey(pem.replace("PUBLIC KEY-----\n", "PUBLIC KEY-----\nAAAA"))).toBeNull();
  // A private key is no verification key, whatever its curve.
  const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  expect(
    readPrivyKey(ec.privateKey.export({ type: "pkcs8", format: "pem" }).toString()),
  ).toBeNull();
  // Another curve is not ES256.
  const k1 = generateKeyPairSync("ec", { namedCurve: "secp256k1" });
  expect(readPrivyKey(k1.publicKey.export({ type: "spki", format: "pem" }).toString())).toBeNull();
});

test("the_route_takes_a_browser_call_from_the_web_app", async () => {
  // The login runs in the browser, so the web app calls the route across origins, with the token.
  const app = appWith(giftWith(), { webOrigins: ["https://tender.example"] });
  const res = await app.request("/v1/gas-gift", {
    method: "OPTIONS",
    headers: {
      Origin: "https://tender.example",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization, content-type",
    },
  });
  expect(res.status).toBe(204);
  expect(res.headers.get("access-control-allow-origin")).toBe("https://tender.example");
  expect(res.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("authorization");
});
