import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { TenderError, toTxResult } from "@tender/client";
import { GasGiftResponseSchema } from "@tender/shared";
import {
  type CryptoKey,
  createLocalJWKSet,
  createRemoteJWKSet,
  exportJWK,
  exportSPKI,
  generateKeyPair,
  type JWK,
  SignJWT,
} from "jose";
import {
  InvalidNonceError,
  InvalidSignatureError,
  NotEnoughBalanceError,
  ShardCongestedError,
  TransactionExpiredError,
} from "near-api-js/rpc-errors";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { GasGift } from "../src/deps";
import {
  type ApiDeps,
  createApp,
  type ErrorBody,
  GAS_GIFT_POOL_MARGIN,
  PRIVY_ISSUER,
  privyJwksUrl,
  readPrivyKey,
} from "../src/index";
import { resetDb, TEST_NOW, testDeps } from "./helpers";

// `POST /v1/gas-gift`: the login's token, the account, the once-per-login-and-per-account rule, the
// daily cap, the claim that two calls at once cannot both win, and a failed transfer letting its
// claim go. The key pair the login signs with is made here, as `jose` makes one, and the key set
// the route checks tokens against is a local one of it (`privyKeys`), or one served by a small HTTP
// server of the test's own: Privy is never called. The chain is a fake: what an account holds is a
// map, and a transfer is a function the test controls. `scripts/serve.sandbox.test.ts` sends a real
// gift on a local chain.

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
/** The error the client throws for a final outcome whose failure is `failure`. */
function outcomeFailure(failure: object): Error {
  try {
    toTxResult(
      { status: { Failure: failure }, transaction: { hash: "TX" }, receipts_outcome: [] },
      "tender.test.near",
    );
  } catch (thrown) {
    return thrown as Error;
  }
  throw new Error("toTxResult took a failure as a success");
}

/** The gift account of the tests' gift: what it holds is its entry in `balances`. */
const GIFT_ACCOUNT = "gift.testnet";

let deps: ApiDeps;
let nowNs = TEST_NOW;
let signingKey: CryptoKey;
let pem: string;
/** The public half of `signingKey`, as the app's key set lists it. */
let publicJwk: JWK;
/** The `kid` of `signingKey` in the key set. */
const KID = "key-one";
/** What each account holds, for the fake chain; an account not in it holds nothing. */
const balances = new Map<string, bigint>();
/** Every transfer the fake chain was asked for, in order. */
let transfers: Array<{ to: string; amount: bigint }> = [];

beforeAll(async () => {
  deps = await testDeps({ network: "testnet", now: () => nowNs });
  const pair = await generateKeyPair("ES256", { extractable: true });
  signingKey = pair.privateKey;
  pem = await exportSPKI(pair.publicKey);
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: "ES256", use: "sig" };
});

afterAll(() => deps.db.close());

beforeEach(async () => {
  await resetDb(deps.db);
  nowNs = TEST_NOW;
  balances.clear();
  // The gift account's pool: enough for every gift of a day, unless a test says otherwise.
  balances.set(GIFT_ACCOUNT, 10n * NEAR);
  transfers = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The gift as `serve` would make it, with the fake chain, and `over` on top. */
function giftWith(over: Partial<GasGift> = {}): GasGift {
  return {
    account: GIFT_ACCOUNT,
    privyAppId: APP_ID,
    privyKeys: createLocalJWKSet({ keys: [publicJwk] }),
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
    /** The `kid` in its header: `KID` unless given, and none for null. */
    kid?: string | null;
  } = {},
): Promise<string> {
  const kid = o.kid === undefined ? KID : o.kid;
  const jwt = new SignJWT({ sid: "session-for-tests" })
    .setProtectedHeader(
      kid === null ? { alg: "ES256", typ: "JWT" } : { alg: "ES256", typ: "JWT", kid },
    )
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
    ["a kid the key set does not have", `Bearer ${await tokenFor({ kid: "key-unknown" })}`],
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

/**
 * A transfer that waits until the test lets it go (`release`), so that calls are in flight at once,
 * and `atOnce`, which sends calls together and lets the transfers go only once every call has been
 * answered or reached its transfer: so each one was decided while the others were in flight.
 */
function heldTransfers(app: () => App) {
  let release: () => void = () => undefined;
  const transfer: GasGift["transfer"] = async (to, amount) => {
    transfers.push({ to, amount });
    await new Promise<void>((resolve) => {
      const before = release;
      release = () => {
        before();
        resolve();
      };
    });
    return { txHash: `tx-${transfers.length}` };
  };
  async function atOnce(calls: Array<[string, string]>) {
    const before = transfers.length;
    let answered = 0;
    const replies = calls.map(([sub, accountId]) =>
      ask(app(), sub, accountId).then((reply) => {
        answered += 1;
        return reply;
      }),
    );
    while (answered + transfers.length - before < calls.length) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    release();
    return await Promise.all(replies);
  }
  return { transfer, atOnce };
}

const statusesOf = (replies: ReadonlyArray<{ status: number }>) =>
  replies.map((reply) => reply.status).sort();

test("of_calls_at_once_for_one_login_or_one_account_only_one_sends", async () => {
  const held = heldTransfers(() => app);
  const app = appWith(giftWith({ transfer: held.transfer }));
  // One login, three accounts: one gift. The others are told it is on its way: a 503 to try again
  // in 30 s, and never `already_given`, which would say the login has had its gift.
  const one = await held.atOnce([
    [USER, "a1".repeat(32)],
    [USER, "a2".repeat(32)],
    [USER, "a3".repeat(32)],
  ]);
  expect(statusesOf(one)).toEqual([200, 503, 503]);
  for (const reply of one.filter((r) => r.status === 503)) {
    expect((reply.body as ErrorBody).error).toBe("unavailable");
    expect(reply.headers.get("retry-after")).toBe("30");
  }
  expect(transfers).toHaveLength(1);
  // Once it is sent, asking again is `already_given`.
  expect((await ask(app, USER, "a2".repeat(32))).status).toBe(409);
  // One account, three logins: one gift.
  const other = await held.atOnce([
    ["did:privy:b1", ACCOUNT],
    ["did:privy:b2", ACCOUNT],
    ["did:privy:b3", ACCOUNT],
  ]);
  expect(statusesOf(other)).toEqual([200, 503, 503]);
  expect(transfers).toHaveLength(2);
  expect(await rows()).toHaveLength(2);
});

test("of_two_logins_at_once_for_the_last_gift_under_the_cap_one_gets_it", async () => {
  const held = heldTransfers(() => app);
  const app = appWith(giftWith({ dailyCap: 2n * AMOUNT, transfer: held.transfer }));
  // One gift of the day's two is out.
  const first = held.atOnce([["did:privy:a", "a1".repeat(32)]]);
  expect(statusesOf(await first)).toEqual([200]);
  // Two other logins, for two other accounts, at once: the table's lock decides, and the claim of
  // the one counts against the other.
  const race = await held.atOnce([
    ["did:privy:b", "a2".repeat(32)],
    ["did:privy:c", "a3".repeat(32)],
  ]);
  expect(statusesOf(race)).toEqual([200, 429]);
  expect(race.map((r) => (r.body as Partial<ErrorBody>).error)).toContain("daily_limit");
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
    ["an app id of spaces", appWith(giftWith({ privyAppId: "  " }))],
    // A verification key is not needed, but one that is set must be one.
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

test("a_transfer_refused_for_certain_lets_its_claim_go_so_that_a_retry_works", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  let fail = true;
  const app = appWith(
    giftWith({
      transfer: async (to, amount) => {
        transfers.push({ to, amount });
        // The node refused it for a reason in its signed bytes alone: no copy of them can run.
        if (fail) throw new InvalidSignatureError("TX", "BLOCK");
        return { txHash: "tx-after-retry" };
      },
    }),
  );
  const token = `Bearer ${await tokenFor()}`;
  const failed = await post<ErrorBody>(app, token);
  expect(failed.status).toBe(502);
  expect(failed.body.error).toBe("transfer_failed");
  expect(failed.body.message).toContain("could not be sent");
  expect(await rows()).toEqual([]);
  // Logged by name, never with the error's text, nor the token.
  const logged = errors.mock.calls.map((call) => call.join(" ")).join("\n");
  expect(logged).toContain("was refused (");
  expect(logged).not.toContain(token.slice(7));

  fail = false;
  const retry = await post(app, token);
  expect(retry.status).toBe(200);
  expect(retry.body).toMatchObject({ status: "sent", tx_hash: "tx-after-retry" });
  expect(transfers).toHaveLength(2);
});

test("a_transfer_that_timed_out_keeps_its_claim_since_the_near_may_still_arrive", async () => {
  const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  let timeOut = true;
  const app = appWith(
    giftWith({
      transfer: async (to, amount) => {
        transfers.push({ to, amount });
        if (timeOut) {
          throw new TenderError(
            "E_TIMEOUT",
            "TenderClient.transfer timed out at https://rpc.example/?apikey=s3cret-rpc-key",
          );
        }
        return { txHash: `tx-${transfers.length}` };
      },
    }),
  );
  const token = `Bearer ${await tokenFor()}`;
  const timedOut = await post<ErrorBody>(app, token);
  expect(timedOut.status).toBe(502);
  expect(timedOut.body.error).toBe("transfer_failed");
  expect(timedOut.body.message).toContain("may still arrive");
  // The claim is kept: it counts against the day, and no second gift goes out meanwhile.
  expect(await rows()).toEqual([
    {
      privy_user: USER,
      account_id: ACCOUNT,
      amount: `${AMOUNT}`,
      status: "claimed",
      tx_hash: null,
    },
  ]);
  const logged = warnings.mock.calls.map((call) => call.join(" ")).join("\n");
  expect(logged).toContain("WARN api: the gas gift to");
  expect(logged).toContain("may still land (TenderError E_TIMEOUT)");
  expect(logged).not.toContain("s3cret");

  // Asked for again, by the login for another account or by another login for the account: it
  // may be on its way, which is a 503 to try again, and not `already_given`.
  for (const [sub, accountId] of [
    [USER, OTHER_ACCOUNT],
    [OTHER_USER, ACCOUNT],
    [USER, ACCOUNT],
  ] as const) {
    const again = await ask(app, sub, accountId);
    expect(again.status, `${sub} ${accountId}`).toBe(503);
    expect((again.body as ErrorBody).error).toBe("unavailable");
    expect(again.headers.get("retry-after")).toBe("30");
  }
  expect(transfers).toHaveLength(1);

  // Ten minutes on, with nothing in flight, the claim is let go: had the NEAR landed, the account
  // would hold it and get `not_needed`; it did not, so the gift is sent.
  timeOut = false;
  nowNs += 11n * 60n * SECOND_NS;
  const later = await ask(app);
  expect(later.status).toBe(200);
  expect(transfers).toHaveLength(2);
});

test("a_transfer_answered_with_a_refusal_not_in_its_signed_bytes_keeps_its_claim", async () => {
  // None of these is a property of the signed bytes alone, so none says for certain that no copy
  // of the transfer ran: near-api-js sends the same bytes again after an HTTP 408, 500 or 503, and a
  // used nonce or an expired block can answer that second copy while the first was taken; a lack of
  // NEAR (as an emptied gift pool gives) and a congested shard are the chain's state at that moment.
  // The NEAR may still arrive, so the claim is kept.
  const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  for (const [what, error] of [
    ["a used nonce", new InvalidNonceError(7, 7, "TX", "BLOCK")],
    [
      "a signer short of NEAR",
      new NotEnoughBalanceError(1n, AMOUNT, "gift.testnet", "TX", "BLOCK"),
    ],
    ["an expired block", new TransactionExpiredError("TX", "BLOCK")],
    ["a congested shard", new ShardCongestedError(1, 0, "TX", "BLOCK")],
    // A copy included and found invalid when applied, which says nothing of another copy.
    [
      "an outcome that is an InvalidTxError InvalidNonce",
      outcomeFailure({ InvalidTxError: { InvalidNonce: { tx_nonce: 7, ak_nonce: 7 } } }),
    ],
  ] as const) {
    await resetDb(deps.db);
    transfers = [];
    warnings.mockClear();
    const app = appWith(
      giftWith({
        transfer: async (to, amount) => {
          transfers.push({ to, amount });
          throw error;
        },
      }),
    );
    const reply = await ask(app);
    expect(reply.status, what).toBe(502);
    expect((reply.body as ErrorBody).error, what).toBe("transfer_failed");
    expect((reply.body as ErrorBody).message, what).toContain("may still arrive");
    expect(await rows(), what).toEqual([
      {
        privy_user: USER,
        account_id: ACCOUNT,
        amount: `${AMOUNT}`,
        status: "claimed",
        tx_hash: null,
      },
    ]);
    const logged = warnings.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(logged, what).toContain(`may still land (${error.name}`);
    // Asked for again meanwhile: on its way, or may be; never a second transfer.
    expect((await ask(app, USER, OTHER_ACCOUNT)).status, what).toBe(503);
    expect(transfers, what).toHaveLength(1);
  }
});

test("a_transfer_that_ran_and_failed_on_chain_lets_its_claim_go", async () => {
  // An `ActionError`: the transaction ran, its receipt failed, and its NEAR comes back.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  let fail = true;
  const app = appWith(
    giftWith({
      transfer: async (to, amount) => {
        transfers.push({ to, amount });
        if (fail) {
          throw outcomeFailure({ ActionError: { index: 0, kind: { LackBalanceForState: {} } } });
        }
        return { txHash: "tx-after-retry" };
      },
    }),
  );
  const failed = await ask(app);
  expect(failed.status).toBe(502);
  expect((failed.body as ErrorBody).message).toContain("could not be sent");
  expect(await rows()).toEqual([]);
  fail = false;
  expect((await ask(app)).status).toBe(200);
  expect(transfers).toHaveLength(2);
});

test("a_transfer_with_no_answer_in_time_is_recorded_when_its_outcome_comes", async () => {
  const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const outcomes: Array<{ settle: () => void; fail: (error: unknown) => void }> = [];
  const app = appWith(
    giftWith({
      transferWaitMs: 50,
      transfer: (to, amount) => {
        transfers.push({ to, amount });
        return new Promise((resolve, reject) => {
          outcomes.push({
            settle: () => resolve({ txHash: `tx-${transfers.length}` }),
            fail: reject,
          });
        });
      },
    }),
  );
  const token = `Bearer ${await tokenFor()}`;
  const first = await post(app, token);
  expect(first.status).toBe(502);
  expect((first.body as ErrorBody).message).toContain("may still arrive");
  // The operator is told as the answer goes out, by the account alone: never the token or a key.
  const warned = warnings.mock.calls.map((call) => call.join(" ")).join("\n");
  expect(warned).toContain(
    `WARN api: the gas gift to ${ACCOUNT} gave no answer within 0.05 s and may still land`,
  );
  expect(warned).not.toContain(token.slice(7));
  expect(warned).not.toMatch(/ed25519:|PRIVATE/);
  // However long the transfer stays in flight, its claim is never let go, so no second goes out.
  nowNs += 30n * 60n * SECOND_NS;
  expect((await ask(app, USER, OTHER_ACCOUNT)).status).toBe(503);
  expect(transfers).toHaveLength(1);

  // It lands: the row says so, and the login has had its gift.
  outcomes[0]?.settle();
  await vi.waitFor(async () => expect((await rows())[0]?.status).toBe("sent"));
  expect(await rows()).toEqual([
    { privy_user: USER, account_id: ACCOUNT, amount: `${AMOUNT}`, status: "sent", tx_hash: "tx-1" },
  ]);
  expect((await ask(app, USER, OTHER_ACCOUNT)).status).toBe(409);

  // Another that is refused for certain after its answer: its claim is let go when that comes.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const second = await ask(app, OTHER_USER, OTHER_ACCOUNT);
  expect(second.status).toBe(502);
  outcomes[1]?.fail(new InvalidSignatureError("TX", "BLOCK"));
  await vi.waitFor(async () => expect(await rows()).toHaveLength(1));
});

test("a_transfer_changes_only_its_own_row", async () => {
  const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const later = (minutes: number) =>
    new Date(Number(nowNs / 1_000_000n) + minutes * 60_000).toISOString();
  // While the first transfer is in flight, its row is replaced by another claim of the same login
  // (as if it had been let go and claimed again): the outcome must not touch the newer row.
  const app = appWith(
    giftWith({
      transfer: async (to, amount) => {
        transfers.push({ to, amount });
        await deps.db.query("delete from gas_gifts");
        await deps.db.query(
          `insert into gas_gifts (privy_user, account_id, amount, status, created_at)
           values ($1, $2, $3, 'claimed', $4::timestamptz)`,
          [USER, OTHER_ACCOUNT, `${AMOUNT}`, later(1)],
        );
        if (transfers.length === 1) {
          throw new InvalidSignatureError("TX", "BLOCK");
        }
        return { txHash: "tx-unrecorded" };
      },
    }),
  );
  const newer = {
    privy_user: USER,
    account_id: OTHER_ACCOUNT,
    amount: `${AMOUNT}`,
    status: "claimed",
    tx_hash: null,
  };
  // Refused: the delete is of its own row, which is gone; the newer claim stays.
  expect((await ask(app)).status).toBe(502);
  expect(await rows()).toEqual([newer]);

  // Sent: the update finds no row of its own, and says so. The NEAR went, so the answer is `sent`.
  await deps.db.query("delete from gas_gifts");
  const sent = await ask(app);
  expect(sent.status).toBe(200);
  expect(await rows()).toEqual([newer]);
  const logged = warnings.mock.calls.map((call) => call.join(" ")).join("\n");
  expect(logged).toContain(
    "was sent (tx-unrecorded), but its claim was gone, so it is not recorded",
  );
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
  // Nine minutes on, it may still be on its way: try again later.
  const early = await ask(app);
  expect(early.status).toBe(503);
  expect((early.body as ErrorBody).error).toBe("unavailable");
  nowNs += 2n * 60n * SECOND_NS;
  // Eleven, and no transfer of it in flight here: the claim is let go.
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

// ---- The login's keys ---------------------------------------------------------------------------

test("the_default_key_set_is_the_one_privy_publishes_for_the_app_fetched_once", async () => {
  expect(privyJwksUrl(APP_ID)).toBe(
    "https://auth.privy.io/api/v1/apps/tender-app-for-tests/jwks.json",
  );
  // No key set given and no key set: the route fetches the app's published one. The fetch is the
  // test's, so nothing leaves the machine.
  const fetched: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    fetched.push(input instanceof Request ? input.url : String(input));
    return Response.json({ keys: [publicJwk] });
  });
  const app = appWith(giftWith({ privyKeys: undefined }));
  expect((await ask(app, USER, ACCOUNT)).status).toBe(200);
  expect((await ask(app, OTHER_USER, OTHER_ACCOUNT)).status).toBe(200);
  // Kept for the next token: one fetch for both.
  expect(fetched).toEqual([privyJwksUrl(APP_ID)]);
});

test("a_set_verification_key_is_used_in_place_of_the_key_set", async () => {
  const keySet = vi.fn(async () => {
    throw new Error("the key set must not be asked");
  });
  // On one line with escapes, as a host keeps it; a token with no kid is fine with one key.
  const app = appWith(
    giftWith({ privyVerificationKey: pem.trim().replaceAll("\n", "\\n"), privyKeys: keySet }),
  );
  expect((await post(app, `Bearer ${await tokenFor({ kid: null })}`)).status).toBe(200);
  const other = await generateKeyPair("ES256");
  expect((await post(app, `Bearer ${await tokenFor({ key: other.privateKey })}`)).status).toBe(401);
  expect(keySet).not.toHaveBeenCalled();
});

test("an_empty_verification_key_is_unset_and_the_key_set_is_used", async () => {
  for (const [what, key] of [
    ["empty", ""],
    ["spaces", "  "],
  ]) {
    await resetDb(deps.db);
    const reply = await ask(appWith(giftWith({ privyVerificationKey: key })));
    expect(reply.status, what).toBe(200);
  }
});

test("a_token_without_a_kid_is_checked_against_each_key_that_fits", async () => {
  // Privy publishes more than one key; a token that names none of them is tried with each.
  const second = await generateKeyPair("ES256", { extractable: true });
  const keys = [
    { ...publicJwk, kid: undefined },
    { ...(await exportJWK(second.publicKey)), alg: "ES256", use: "sig" },
  ];
  const app = appWith(giftWith({ privyKeys: createLocalJWKSet({ keys }) }));
  const bySecond = await tokenFor({ kid: null, key: second.privateKey });
  expect((await post(app, `Bearer ${bySecond}`)).status).toBe(200);
  const other = await generateKeyPair("ES256");
  const byNeither = await tokenFor({ kid: null, key: other.privateKey, sub: OTHER_USER });
  expect((await post(app, `Bearer ${byNeither}`, { account_id: OTHER_ACCOUNT })).status).toBe(401);
});

/** HTTP servers of the tests' own, on ports the system picks, closed after each test. */
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

/** A key set served at `/jwks.json` of a local server, as `answer` says, and the URL to it. */
async function servedKeySet(answer: (res: ServerResponse) => void) {
  const server = createServer((_req, res) => answer(res));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return new URL(`http://127.0.0.1:${port}/jwks.json`);
}

test("a_key_set_that_cannot_be_fetched_is_a_503_and_not_a_401", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const token = await tokenFor();
  const json = (status: number, body: string) => (res: ServerResponse) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body);
  };
  const closed = await servedKeySet(json(200, "{}"));
  const gone = servers.pop();
  gone?.closeAllConnections();
  await new Promise((resolve) => gone?.close(resolve));
  const cases: Array<[string, URL]> = [
    ["an answer that is not 200", await servedKeySet(json(500, "{}"))],
    ["an answer that is not JSON", await servedKeySet(json(200, "<html>"))],
    ["JSON that is no key set", await servedKeySet(json(200, '{"keys": "none"}'))],
    ["a server that is not there", closed],
    ["a server that does not answer", await servedKeySet(() => undefined)],
  ];
  for (const [what, url] of cases) {
    const keys = createRemoteJWKSet(url, { timeoutDuration: 300 });
    const reply = await post<ErrorBody>(appWith(giftWith({ privyKeys: keys })), `Bearer ${token}`);
    expect(reply.status, what).toBe(503);
    expect(reply.body.error, what).toBe("unavailable");
    expect(reply.headers.get("retry-after"), what).toBe("5");
  }
  expect(transfers).toEqual([]);
  expect(await rows()).toEqual([]);
  // Said by the kind of failure alone: never the token, and never the key set's address.
  const logged = errors.mock.calls.map((call) => call.join(" ")).join("\n");
  expect(logged).toContain("cannot fetch the login's key set");
  expect(logged).not.toContain(token);
  expect(logged).not.toContain("127.0.0.1");

  // What is wrong with a token before any key is looked for is a 401 all the same.
  const nowhere = createRemoteJWKSet(closed, { timeoutDuration: 300 });
  const hmac = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .sign(new TextEncoder().encode("a shared secret of thirty-two bytes!"));
  const app = appWith(giftWith({ privyKeys: nowhere }));
  expect((await post(app, `Bearer ${hmac}`)).status).toBe(401);
  expect((await post(app, "Bearer not-a-token")).status).toBe(401);
});

test("a_key_set_served_over_http_verifies_and_knows_no_other_kid", async () => {
  let fetches = 0;
  const url = await servedKeySet((res) => {
    fetches += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ keys: [publicJwk] }));
  });
  const app = appWith(giftWith({ privyKeys: createRemoteJWKSet(url) }));
  expect((await ask(app)).status).toBe(200);
  // A kid the set does not have, just after a fetch: a token's fault, a 401, and no new fetch.
  const unknown = await tokenFor({ kid: "key-unknown", sub: OTHER_USER });
  expect((await post(app, `Bearer ${unknown}`, { account_id: OTHER_ACCOUNT })).status).toBe(401);
  expect(fetches).toBe(1);
});

test("after_a_failed_fetch_the_key_set_rests_5_s_and_the_failure_is_logged_once", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const said = () =>
    errors.mock.calls.filter((call) => call.join(" ").includes("cannot fetch the login's key set"))
      .length;
  let fetches = 0;
  let good = false;
  const url = await servedKeySet((res) => {
    fetches += 1;
    // Slow enough that calls made together share the one fetch.
    setTimeout(() => {
      res.writeHead(good ? 200 : 500, { "content-type": "application/json" });
      res.end(good ? JSON.stringify({ keys: [publicJwk] }) : "{}");
    }, 100);
  });
  const app = appWith(giftWith({ privyKeys: createRemoteJWKSet(url) }));
  const token = `Bearer ${await tokenFor()}`;

  // A burst while the key set's server fails: one fetch, one line, and a 503 for each.
  const burst = await Promise.all([post(app, token), post(app, token), post(app, token)]);
  expect(statusesOf(burst)).toEqual([503, 503, 503]);
  expect(fetches).toBe(1);
  expect(said()).toBe(1);

  // Within 5 s of the failure: a 503 at once, with no fetch and no line.
  nowNs += 4n * SECOND_NS;
  expect((await post(app, token)).status).toBe(503);
  expect(fetches).toBe(1);
  expect(said()).toBe(1);

  // Past it: fetched again, and a new failure is said again.
  nowNs += 2n * SECOND_NS;
  expect((await post(app, token)).status).toBe(503);
  expect(fetches).toBe(2);
  expect(said()).toBe(2);

  // Once the server answers again, the next call past the rest gets its gift.
  good = true;
  nowNs += 6n * SECOND_NS;
  expect((await post(app, token)).status).toBe(200);
  expect(fetches).toBe(3);
  expect(said()).toBe(2);
});

// ---- The gift's pool ----------------------------------------------------------------------------

test("an_empty_pool_answers_gift_off_and_claims_nothing", async () => {
  const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  balances.set(GIFT_ACCOUNT, 0n);
  const app = appWith();
  const reply = await ask(app);
  expect(reply.status).toBe(503);
  expect((reply.body as ErrorBody).error).toBe("gift_off");
  expect((reply.body as ErrorBody).message).toContain("the gift pool is empty");
  // Refilling changes it, not waiting: no Retry-After, as for any gift_off.
  expect(reply.headers.get("retry-after")).toBeNull();
  expect(await rows()).toEqual([]);
  expect(transfers).toEqual([]);
  const logged = warnings.mock.calls.map((call) => call.join(" ")).join("\n");
  expect(logged).toContain(
    `WARN api: the gas gift's pool is empty: ${GIFT_ACCOUNT} holds 0 yoctoNEAR`,
  );
  expect(logged).not.toMatch(/ed25519:|PRIVATE/);

  // What does not need the pool is answered as before: an account that holds enough.
  balances.set(OTHER_ACCOUNT, NEAR);
  expect((await ask(app, OTHER_USER, OTHER_ACCOUNT)).body).toMatchObject({ status: "not_needed" });

  // A gift account that is not on chain holds nothing either.
  balances.delete(GIFT_ACCOUNT);
  expect((await ask(app)).status).toBe(503);
  expect(await rows()).toEqual([]);
});

test("a_pool_of_one_gift_and_its_margin_sends_and_one_yocto_less_does_not", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const app = appWith();
  balances.set(GIFT_ACCOUNT, AMOUNT + GAS_GIFT_POOL_MARGIN - 1n);
  expect((await ask(app)).status).toBe(503);
  expect(await rows()).toEqual([]);

  balances.set(GIFT_ACCOUNT, AMOUNT + GAS_GIFT_POOL_MARGIN);
  const sent = await ask(app);
  expect(sent.status).toBe(200);
  expect(sent.body).toMatchObject({ status: "sent" });
  expect(transfers).toEqual([{ to: ACCOUNT, amount: AMOUNT }]);
});

test("the_warn_that_the_pool_is_empty_is_written_once_in_5_minutes", async () => {
  const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const said = () =>
    warnings.mock.calls.filter((call) => call.join(" ").includes("pool is empty")).length;
  balances.set(GIFT_ACCOUNT, NEAR / 1000n);
  const app = appWith();
  for (const [sub, accountId] of [
    [USER, ACCOUNT],
    [OTHER_USER, OTHER_ACCOUNT],
    ["did:privy:c", "a3".repeat(32)],
  ] as const) {
    expect((await ask(app, sub, accountId)).status).toBe(503);
  }
  expect(said()).toBe(1);
  nowNs += 4n * 60n * SECOND_NS;
  expect((await ask(app)).status).toBe(503);
  expect(said()).toBe(1);
  nowNs += 1n * 60n * SECOND_NS;
  expect((await ask(app)).status).toBe(503);
  expect(said()).toBe(2);
});

test("a_pool_the_chain_cannot_read_is_a_503_to_try_again", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const app = appWith(
    giftWith({
      balanceOf: async (accountId) => {
        if (accountId === GIFT_ACCOUNT) throw new Error("node down");
        return 0n;
      },
    }),
  );
  const reply = await ask(app);
  expect(reply.status).toBe(503);
  expect((reply.body as ErrorBody).error).toBe("unavailable");
  expect(reply.headers.get("retry-after")).toBe("5");
  expect(await rows()).toEqual([]);
});
