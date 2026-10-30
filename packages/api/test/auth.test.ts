import { Buffer } from "node:buffer";
import { format } from "node:util";
import type { AuthErrorCode, KeyPermission } from "@tender/client";
import type { Db } from "@tender/db";
import { FIXTURE_ACCOUNTS, FIXTURE_BRIEF, FIXTURE_CONTRACT } from "@tender/indexer/testing";
import { canonicalJson, sha256Hex } from "@tender/shared";
import { Hono } from "hono";
import { Account, KeyPair, KeyPairSigner, type Provider } from "near-api-js";
import * as nearNep413 from "near-api-js/nep413";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { type ChallengeResponse, requireAuth, type SignInResponse } from "../src/auth";
import { handleError } from "../src/format";
import { type ApiDeps, type ChainReader, createApp, type ErrorBody } from "../src/index";
import type { AuthVariables } from "../src/routes/blobs";
import { fakeClient, resetDb, TEST_NOW, testDeps } from "./helpers";

// NEP-413 sign-in. Every test signs with near-api-js itself, as a wallet or an agent would, so
// none of them leans on the serializer in `@tender/client` that the API verifies with. The chain
// is a stub: `viewAccessKey` answers what each test needs. The clock is a variable, so a test can
// move time across an expiry.

const { alice, bob } = FIXTURE_ACCOUNTS;
const MS = 1_000_000n;
const SECOND = 1_000n * MS;
const MINUTE = 60n * SECOND;
const HOUR = 60n * MINUTE;
const WEB = "https://tender.example";

/** What every refusal of a token says, whatever was wrong with it. */
const UNAUTHORIZED: ErrorBody = {
  error: "unauthorized",
  message: "sign in with a bearer token from POST /v1/auth/verify",
};

/** What a refused sign-in says: fixed text per code, none of it from the request. */
const REFUSALS: Record<AuthErrorCode, string> = {
  bad_nonce: "that challenge was not issued, is used already or has expired",
  wrong_recipient: "the message was signed for another recipient",
  bad_signature: "the signature is not that key's signature of the sign-in message and challenge",
  key_not_found: "that key is not on that account",
  key_not_allowed:
    "that key may not sign in: use a full-access key, or a function-call key limited to the Tender contract",
};

interface VerifyBody {
  account_id: string;
  public_key: string;
  signature: string;
  nonce: string;
  message: string;
  recipient: string;
}

let deps: ApiDeps;
let nowNs = TEST_NOW;

beforeAll(async () => {
  deps = await testDeps({ now: () => nowNs });
});

afterAll(() => deps.db.close());

beforeEach(async () => {
  await resetDb(deps.db);
  nowNs = TEST_NOW;
});

afterEach(() => {
  // A test that fails halfway leaves its fake timers and its spies behind.
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---- Helpers ----------------------------------------------------------------------------------

/** A time in nanoseconds as the API writes one: ISO 8601, to the millisecond, in UTC. */
const isoOf = (ns: bigint) => new Date(Number(ns / MS)).toISOString();

const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/** The whole API, over the shared database. `over` replaces any of the deps. */
function appWith(over: Partial<ApiDeps> = {}): Hono {
  return createApp({ ...deps, ...over });
}

/** A chain whose every key has `permission`, or no key at all for null. */
function chainWith(permission: KeyPermission | null) {
  return fakeClient({
    viewAccessKey: async () => (permission === null ? null : { permission }),
  });
}

const functionCallTo = (receiver_id: string): KeyPermission => ({
  FunctionCall: { receiver_id, method_names: [] },
});

interface Reply<T> {
  status: number;
  body: T;
  headers: Headers;
}

/** Posts `body` as JSON (text is sent as it is), or nothing for `undefined`. */
async function post<T = unknown>(
  app: Hono,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Reply<T>> {
  const res = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined || typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T, headers: res.headers };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** `POST /v1/auth/challenge`, which answers 200. */
async function challenge(app: Hono): Promise<ChallengeResponse> {
  const reply = await post<ChallengeResponse>(app, "/v1/auth/challenge");
  expect(reply.status).toBe(200);
  return reply.body;
}

interface SignOptions {
  /** The account the body names. Default: alice. */
  account?: string;
  /** What is signed, and sent as `message`. Default: the challenge's own. */
  message?: string;
  /** What is signed, and sent as `recipient`. Default: the challenge's own. */
  recipient?: string;
  /** Replaces body fields after signing, which makes the body say what was not signed. */
  over?: Partial<VerifyBody>;
}

/** The body of `POST /v1/auth/verify` for `key` signing `ch`, signed by near-api-js. */
async function signChallenge(
  key: KeyPair,
  ch: Pick<ChallengeResponse, "nonce" | "message" | "recipient">,
  options: SignOptions = {},
): Promise<VerifyBody> {
  const account = options.account ?? alice;
  const message = options.message ?? ch.message;
  const recipient = options.recipient ?? ch.recipient;
  // Signing a NEP-413 message is local: the account's provider is never called.
  const signerAccount = new Account(account, {} as unknown as Provider, new KeyPairSigner(key));
  const signed = await nearNep413.signMessage({
    signerAccount,
    payload: { message, recipient, nonce: Uint8Array.from(Buffer.from(ch.nonce, "base64")) },
  });
  return {
    account_id: account,
    public_key: signed.publicKey.toString(),
    signature: toBase64(signed.signature),
    nonce: ch.nonce,
    message,
    recipient,
    ...options.over,
  };
}

/** A whole sign-in: a challenge, signed by a fresh key (or `key`) and verified, which must work. */
async function signIn(app: Hono, options: SignOptions & { key?: KeyPair } = {}) {
  const key = options.key ?? KeyPair.fromRandom("ed25519");
  const ch = await challenge(app);
  const reply = await post<SignInResponse>(
    app,
    "/v1/auth/verify",
    await signChallenge(key, ch, options),
  );
  expect(reply.status).toBe(200);
  return { ...reply.body, key, challenge: ch };
}

/** A route behind `requireAuth` alone, which says who the request is signed in as. */
function probe(over: Partial<ApiDeps> = {}): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.onError(handleError);
  app.get("/whoami", requireAuth({ ...deps, ...over }), (c) =>
    c.json({ account: c.var.account, key_kind: c.var.keyKind }),
  );
  return app;
}

function whoami(app: Hono<{ Variables: AuthVariables }>, authorization?: string) {
  return app.request("/whoami", {
    headers: authorization === undefined ? {} : { authorization },
  });
}

/** Both uploads that need a signed-in account, with bodies that are valid. */
const BRIEF_BYTES = canonicalJson(FIXTURE_BRIEF);
const HELDOUT_BYTES = canonicalJson({ exact: { expected: ["42"] } });
const UPLOADS: Array<[string, unknown]> = [
  [
    "/v1/blobs",
    {
      kind: "brief",
      content_type: "application/json",
      content_base64: toBase64(BRIEF_BYTES),
    },
  ],
  [
    "/v1/heldout",
    { commitment: sha256Hex(HELDOUT_BYTES), content_base64: toBase64(HELDOUT_BYTES) },
  ],
];

async function tokenRows() {
  return await deps.db.query<{
    token_sha256: string;
    account: string;
    public_key: string;
    key_kind: string;
    expires_at: Date;
  }>("select token_sha256, account, public_key, key_kind, expires_at from auth_tokens");
}

async function challengeRows() {
  return await deps.db.query<{ nonce: string; expires_at: Date; used: boolean }>(
    "select nonce, expires_at, used from auth_challenges order by nonce",
  );
}

async function blobCount(): Promise<number> {
  const [row] = await deps.db.query<{ n: number }>("select count(*)::int as n from blobs");
  return row?.n ?? 0;
}

/** `whoami` with `token` when the clock says `at`. */
function whoamiAt(app: Hono<{ Variables: AuthVariables }>, token: string, at: bigint) {
  nowNs = at;
  return whoami(app, `Bearer ${token}`);
}

/**
 * A chain that changes under a running API. Every key on it has `permission` (null: no key), it
 * records each lookup, `failing` makes the lookups throw, and `hanging` makes them wait for
 * `settle`, which a test calls when it wants the lookup to end: after the API gave up on it, or
 * just before.
 */
interface LiveChain {
  permission: KeyPermission | null;
  failing: boolean;
  hanging: boolean;
  lookups: Array<[string, string]>;
  /** Resolves when the chain is next asked about a key. */
  asked(): Promise<void>;
  /** Lets the lookups that wait go on: as they would have answered, or failing with `failure`. */
  settle(failure?: Error): void;
  client: ChainReader;
}

function liveChain(permission: KeyPermission | null = "FullAccess"): LiveChain {
  const askers: Array<() => void> = [];
  const waiting: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  const chain: LiveChain = {
    permission,
    failing: false,
    hanging: false,
    lookups: [],
    asked: () =>
      new Promise((resolve) => {
        askers.push(resolve);
      }),
    settle: (failure) => {
      for (const lookup of waiting.splice(0)) {
        if (failure === undefined) lookup.resolve();
        else lookup.reject(failure);
      }
    },
    client: fakeClient({
      viewAccessKey: async (account, key) => {
        chain.lookups.push([account, key]);
        for (const resolve of askers.splice(0)) resolve();
        if (chain.hanging) {
          await new Promise<void>((resolve, reject) => {
            waiting.push({ resolve, reject });
          });
        }
        if (chain.failing) throw new Error("rpc down at https://marker-rpc.example/?key=secret");
        return chain.permission === null ? null : { permission: chain.permission };
      },
    }),
  };
  return chain;
}

/** What a request gets when the chain cannot say whether the key is there. */
const UNAVAILABLE: ErrorBody = {
  error: "unavailable",
  message: "cannot check your key right now",
};

/**
 * Sends `request` to an API whose chain hangs, and lets the 5 seconds it is given go by: the chain
 * is asked, with one timer running on the question; 1 ms before the bound the request is still
 * waiting, and at the bound it is answered. Only `setTimeout` and `clearTimeout` are faked, so the
 * clock of the API and the database go on as they were. The timers are real again when this
 * returns.
 */
async function waitOutTheDeadline<T>(chain: LiveChain, request: () => T | Promise<T>): Promise<T> {
  chain.hanging = true;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const reached = chain.asked();
  let answered = false;
  const pending = Promise.resolve(request()).then((reply) => {
    answered = true;
    return reply;
  });
  await reached;
  expect(vi.getTimerCount()).toBe(1);

  await vi.advanceTimersByTimeAsync(4_999);
  expect(answered).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  const reply = await pending;
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  return reply;
}

/**
 * Ends the lookups that waited, by failing them now that nobody waits for them, and says which
 * rejections Node found that nothing handles. It reports those once the microtasks after the
 * failure have run, so this waits a turn of the event loop.
 */
async function unhandledAfterLateFailure(chain: LiveChain): Promise<unknown[]> {
  const unhandled: unknown[] = [];
  const note = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", note);
  try {
    chain.settle(new Error("the chain failed, late"));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("unhandledRejection", note);
  }
  return unhandled;
}

// ---- Sign-in ----------------------------------------------------------------------------------

test("challenge_then_verify_issues_token", async () => {
  const app = appWith();
  const key = KeyPair.fromRandom("ed25519");

  const issued = await post<ChallengeResponse>(app, "/v1/auth/challenge");
  expect(issued.status).toBe(200);
  expect(issued.headers.get("cache-control")).toBe("no-store");
  expect(issued.body).toEqual({
    nonce: expect.any(String),
    message: "Sign in to Tender",
    // The API's own host: `testDeps` serves at `http://api.test`.
    recipient: "api.test",
    expires_at: isoOf(TEST_NOW + 5n * MINUTE),
  });
  // The nonce is 32 random bytes in the one base64 spelling that `btoa` writes.
  const raw = Buffer.from(issued.body.nonce, "base64");
  expect(raw.length).toBe(32);
  expect(raw.toString("base64")).toBe(issued.body.nonce);
  expect(await challengeRows()).toEqual([
    { nonce: issued.body.nonce, expires_at: new Date(isoOf(TEST_NOW + 5n * MINUTE)), used: false },
  ]);

  const verified = await post<SignInResponse>(
    app,
    "/v1/auth/verify",
    await signChallenge(key, issued.body),
  );
  expect(verified.status).toBe(200);
  expect(verified.headers.get("cache-control")).toBe("no-store");
  const { token, expires_at, key_kind } = verified.body;
  expect(Object.keys(verified.body).sort()).toEqual(["expires_at", "key_kind", "token"]);
  // The token is 32 random bytes as base64url, and lives 12 hours.
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(Buffer.from(token, "base64url").length).toBe(32);
  expect(expires_at).toBe(isoOf(TEST_NOW + 12n * HOUR));
  expect(key_kind).toBe("full_access");

  // The challenge is spent, and the database holds the hash of the token and nothing else of it.
  expect((await challengeRows()).map((row) => row.used)).toEqual([true]);
  const rows = await tokenRows();
  expect(rows).toEqual([
    {
      token_sha256: sha256Hex(token),
      account: alice,
      public_key: key.getPublicKey().toString(),
      key_kind: "full_access",
      expires_at: new Date(expires_at),
    },
  ]);
  expect(JSON.stringify(rows)).not.toContain(token);

  // The token signs requests in as the account that proved itself.
  const who = await whoami(probe(), `Bearer ${token}`);
  expect(await who.json()).toEqual({ account: alice, key_kind: "full_access" });
  const upload = await post<{ sha256: string }>(app, "/v1/blobs", UPLOADS[0]?.[1], bearer(token));
  expect(upload.status).toBe(200);
  const [blob] = await deps.db.query<{ uploader: string }>(
    "select uploader from blobs where sha256 = $1",
    [upload.body.sha256],
  );
  expect(blob?.uploader).toBe(alice);
});

test("every_challenge_is_its_own", async () => {
  const app = appWith();
  const first = await challenge(app);
  const second = await challenge(app);
  expect(first.nonce).not.toBe(second.nonce);
  expect((await challengeRows()).map((row) => row.nonce).sort()).toEqual(
    [first.nonce, second.nonce].sort(),
  );
});

test("the_challenge_names_the_host_of_the_public_url", async () => {
  // Whom a sign-in is signed for is this API, by the host of its public URL: in lower case, with
  // the port only if it is not the default of the scheme, and nothing else of the URL. A client
  // signs a challenge only if that is the host it called, so a challenge that is passed on to a
  // client of another host is not signed, and what is signed for another host is not taken here.
  const named: Array<[string, string]> = [
    ["http://api.test", "api.test"],
    ["https://api.tender.example", "api.tender.example"],
    ["https://API.Tender.Example/", "api.tender.example"],
    ["https://api.tender.example:443", "api.tender.example"],
    ["https://api.tender.example:8443/base", "api.tender.example:8443"],
    ["http://127.0.0.1:8787", "127.0.0.1:8787"],
    ["http://localhost:80", "localhost"],
    ["http://[::1]:8787", "[::1]:8787"],
  ];
  for (const [publicUrl, recipient] of named) {
    const app = appWith({ publicUrl });

    const ch = await challenge(app);
    expect(ch.recipient, publicUrl).toBe(recipient);
    const taken = await post<SignInResponse>(
      app,
      "/v1/auth/verify",
      await signChallenge(KeyPair.fromRandom("ed25519"), ch),
    );
    expect(taken.status, publicUrl).toBe(200);

    // The same challenge, signed for the host of another API, is refused.
    const other = recipient === "api.test" ? "api.other.example" : "api.test";
    const refused = await post<ErrorBody>(
      app,
      "/v1/auth/verify",
      await signChallenge(KeyPair.fromRandom("ed25519"), await challenge(app), {
        recipient: other,
      }),
    );
    expect(refused.status, publicUrl).toBe(401);
    expect(refused.body.error, publicUrl).toBe("wrong_recipient");
  }
});

test("a_public_url_with_no_host_is_a_fault_and_stores_no_challenge", async () => {
  // Without a host there is no one to sign for. That is the deployment's fault, and so a 500 that
  // is seen, and not a challenge for a recipient that is nothing.
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  for (const publicUrl of ["", "api.test", "/v1", "file:///api"]) {
    const failed = await post<ErrorBody>(appWith({ publicUrl }), "/v1/auth/challenge");
    expect(failed.status, publicUrl).toBe(500);
    expect(failed.body, publicUrl).toEqual({ error: "internal", message: "internal error" });
  }
  expect(log).toHaveBeenCalled();
  expect(await challengeRows()).toEqual([]);
});

test("nonce_replay_rejected", async () => {
  const app = appWith();
  const key = KeyPair.fromRandom("ed25519");
  const ch = await challenge(app);
  const body = await signChallenge(key, ch);

  const first = await post<SignInResponse>(app, "/v1/auth/verify", body);
  expect(first.status).toBe(200);

  // The very same request again, and a new signature over the same nonce: both are replays.
  for (const replay of [body, await signChallenge(key, ch)]) {
    const again = await post<ErrorBody>(app, "/v1/auth/verify", replay);
    expect(again.status).toBe(401);
    expect(again.body).toEqual({ error: "bad_nonce", message: REFUSALS.bad_nonce });
    expect(again.headers.get("www-authenticate")).toBe("Bearer");
  }
  expect(await tokenRows()).toHaveLength(1);
});

test("parallel_verifies_issue_one_token", async () => {
  // Both requests pass the signature and key checks before either spends the nonce: they wait
  // in the lookup until both are there, so the spend is what has to let one of them through. The
  // wait ends by itself after 2 s, so that a request that never gets there fails the count below
  // and does not hang the test.
  let arrived = 0;
  let release: () => void = () => undefined;
  const both = new Promise<void>((resolve) => {
    release = resolve;
    setTimeout(resolve, 2_000);
  });
  const client = fakeClient({
    viewAccessKey: async () => {
      arrived += 1;
      if (arrived === 2) release();
      await both;
      return { permission: "FullAccess" };
    },
  });
  const app = appWith({ client });
  const ch = await challenge(app);
  // Two accounts, each with a key of its own, sign the one challenge.
  const bodies = [
    await signChallenge(KeyPair.fromRandom("ed25519"), ch, { account: alice }),
    await signChallenge(KeyPair.fromRandom("ed25519"), ch, { account: bob }),
  ];

  const replies = await Promise.all(bodies.map((body) => post(app, "/v1/auth/verify", body)));

  // Both got as far as the lookup. Had the second been turned away before it, at the read of the
  // challenge, the answers below would be the same and no race would have been run.
  expect(arrived).toBe(2);
  expect(replies.map((reply) => reply.status).sort()).toEqual([200, 401]);
  const refused = replies.find((reply) => reply.status === 401);
  expect(refused?.body).toEqual({ error: "bad_nonce", message: REFUSALS.bad_nonce });
  const rows = await tokenRows();
  expect(rows).toHaveLength(1);
  const winner = replies.find((reply) => reply.status === 200)?.body as SignInResponse;
  expect(rows[0]?.token_sha256).toBe(sha256Hex(winner.token));
});

test("expired_challenge_rejected", async () => {
  const app = appWith();
  const key = KeyPair.fromRandom("ed25519");

  // A challenge lives 5 minutes, up to but not including the instant it expires.
  const early = await challenge(app);
  const late = await challenge(app);
  const earlyBody = await signChallenge(key, early);
  const lateBody = await signChallenge(key, late);

  nowNs = TEST_NOW + 5n * MINUTE - 1n;
  const ok = await post(app, "/v1/auth/verify", earlyBody);
  expect(ok.status).toBe(200);

  nowNs = TEST_NOW + 5n * MINUTE;
  const expired = await post<ErrorBody>(app, "/v1/auth/verify", lateBody);
  expect(expired.status).toBe(401);
  expect(expired.body).toEqual({ error: "bad_nonce", message: REFUSALS.bad_nonce });
  expect(expired.headers.get("www-authenticate")).toBe("Bearer");

  nowNs = TEST_NOW + 2n * HOUR;
  const muchLater = await post<ErrorBody>(app, "/v1/auth/verify", lateBody);
  expect(muchLater.status).toBe(401);
  expect(muchLater.body.error).toBe("bad_nonce");
  expect(await tokenRows()).toHaveLength(1);
});

test("function_call_key_for_tender_accepted", async () => {
  const lookups: Array<[string, string]> = [];
  const client = fakeClient({
    viewAccessKey: async (account, key) => {
      lookups.push([account, key]);
      return {
        permission: { FunctionCall: { receiver_id: FIXTURE_CONTRACT, method_names: ["x"] } },
      };
    },
  });
  const app = appWith({ client });
  const key = KeyPair.fromRandom("ed25519");

  const ch = await challenge(app);
  const reply = await post<SignInResponse>(
    app,
    "/v1/auth/verify",
    await signChallenge(key, ch, { account: bob }),
  );

  expect(reply.status).toBe(200);
  expect(reply.body.key_kind).toBe("function_call");
  // The key was looked up on the account that claimed it, in its canonical spelling.
  expect(lookups).toEqual([[bob, key.getPublicKey().toString()]]);
  const [row] = await tokenRows();
  expect(row).toMatchObject({ account: bob, key_kind: "function_call" });
  // Requests signed in with it see the kind of the key.
  const who = await whoami(probe({ client }), `Bearer ${reply.body.token}`);
  expect(await who.json()).toEqual({ account: bob, key_kind: "function_call" });
});

test("function_call_key_for_other_contract_rejected", async () => {
  const app = appWith({ client: chainWith(functionCallTo("other.test.near")) });
  const ch = await challenge(app);

  const reply = await post<ErrorBody>(
    app,
    "/v1/auth/verify",
    await signChallenge(KeyPair.fromRandom("ed25519"), ch),
  );

  expect(reply.status).toBe(401);
  expect(reply.body).toEqual({ error: "key_not_allowed", message: REFUSALS.key_not_allowed });
  expect(await tokenRows()).toEqual([]);
});

// ---- Refusals ---------------------------------------------------------------------------------

test("every_auth_error_is_a_fixed_401", async () => {
  const key = KeyPair.fromRandom("ed25519");
  const stranger = KeyPair.fromRandom("ed25519");
  // Marks that must never come back in an answer: the account, and the text that was signed.
  const account = "marker-account.test.near";
  const message = "marker message";

  /** One refused sign-in: what it sends, on which chain, and the code it must get. */
  interface Case {
    code: AuthErrorCode;
    app?: Hono;
    send: (ch: ChallengeResponse) => Promise<unknown>;
  }
  const cases: Record<string, Case> = {
    "a nonce that was never issued": {
      code: "bad_nonce",
      send: async (ch) => {
        const other = toBase64(crypto.getRandomValues(new Uint8Array(32)));
        return signChallenge(key, { ...ch, nonce: other }, { account });
      },
    },
    "a nonce that is not 32 bytes in canonical base64": {
      code: "bad_nonce",
      send: async (ch) => ({ ...(await signChallenge(key, ch, { account })), nonce: "abc" }),
    },
    // As long as a nonce is, with one character of it a NUL, which a database cannot store.
    "a nonce with a NUL in it": {
      code: "bad_nonce",
      send: async (ch) => ({
        ...(await signChallenge(key, ch, { account })),
        nonce: `${ch.nonce.slice(0, 42)}\u0000=`,
      }),
    },
    // The nonce of a live challenge, with more after it.
    "a nonce of the wrong length": {
      code: "bad_nonce",
      send: async (ch) => ({
        ...(await signChallenge(key, ch, { account })),
        nonce: `${ch.nonce}AAAA`,
      }),
    },
    "another recipient": {
      code: "wrong_recipient",
      send: (ch) => signChallenge(key, ch, { account, recipient: "evil" }),
    },
    // The challenge is this API's and the signature is good, but it is for another API: a host that
    // is not this one, however close the spelling.
    "another API's host": {
      code: "wrong_recipient",
      send: (ch) => signChallenge(key, ch, { account, recipient: "api.other.example" }),
    },
    "the recipient every API used to have": {
      code: "wrong_recipient",
      send: (ch) => signChallenge(key, ch, { account, recipient: "tender" }),
    },
    "this host with a port it does not have": {
      code: "wrong_recipient",
      send: (ch) => signChallenge(key, ch, { account, recipient: "api.test:8443" }),
    },
    "this host in capitals": {
      code: "wrong_recipient",
      send: (ch) => signChallenge(key, ch, { account, recipient: "API.TEST" }),
    },
    "this host as a URL": {
      code: "wrong_recipient",
      send: (ch) => signChallenge(key, ch, { account, recipient: "http://api.test" }),
    },
    "another message, signed correctly": {
      code: "bad_signature",
      send: (ch) => signChallenge(key, ch, { account, message }),
    },
    "a message that was not signed": {
      code: "bad_signature",
      send: (ch) => signChallenge(key, ch, { account, over: { message } }),
    },
    "another key's signature": {
      code: "bad_signature",
      send: async (ch) => ({
        ...(await signChallenge(key, ch, { account })),
        public_key: stranger.getPublicKey().toString(),
      }),
    },
    "a key that is not on the account": {
      code: "key_not_found",
      app: appWith({ client: chainWith(null) }),
      send: (ch) => signChallenge(key, ch, { account }),
    },
    "an account id that is no account id": {
      code: "key_not_found",
      send: (ch) => signChallenge(key, ch, { account: "Not An Account" }),
    },
    "a key that may not sign in": {
      code: "key_not_allowed",
      app: appWith({ client: chainWith(functionCallTo("other.test.near")) }),
      send: (ch) => signChallenge(key, ch, { account }),
    },
    "a key that is not ed25519": {
      code: "key_not_allowed",
      send: async (ch) => ({
        ...(await signChallenge(key, ch, { account })),
        public_key: "secp256k1:marker-key",
      }),
    },
  };

  const seen = new Map<AuthErrorCode, Set<string>>();
  for (const [name, { code, app = appWith(), send }] of Object.entries(cases)) {
    const reply = await post<ErrorBody>(app, "/v1/auth/verify", await send(await challenge(app)));
    expect(reply.status, name).toBe(401);
    expect(reply.headers.get("www-authenticate"), name).toBe("Bearer");
    expect(reply.body, name).toEqual({ error: code, message: REFUSALS[code] });
    // None of the request is in the answer.
    for (const marker of [account, "marker", "evil", "Not An Account", "abc"]) {
      expect(JSON.stringify(reply.body), name).not.toContain(marker);
    }
    seen.set(code, (seen.get(code) ?? new Set<string>()).add(reply.body.message));
  }
  // The same code always says the same thing, and every code of the verifier is covered.
  expect([...seen.keys()].sort()).toEqual(Object.keys(REFUSALS).sort());
  for (const messages of seen.values()) expect(messages.size).toBe(1);
  expect(await tokenRows()).toEqual([]);
});

test("chain_failure_is_a_503_and_keeps_the_challenge", async () => {
  // A chain that is down is not the caller's fault, and a sign-in is not given on a guess: the
  // answer is the 503 that a token check gets, with nothing of the fault in it, and the same
  // challenge works when the chain is back.
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const down = fakeClient({
    viewAccessKey: async () => {
      throw new Error("rpc down at https://marker-rpc.example/?key=secret");
    },
  });
  const key = KeyPair.fromRandom("ed25519");
  const ch = await challenge(appWith());
  const body = await signChallenge(key, ch);

  const failed = await post<ErrorBody>(appWith({ client: down }), "/v1/auth/verify", body);
  expect(failed.status).toBe(503);
  expect(failed.body).toEqual(UNAVAILABLE);
  expect(failed.headers.get("www-authenticate")).toBeNull();
  expect(JSON.stringify(failed.body)).not.toContain("marker-rpc");
  expect(log).toHaveBeenCalled();
  expect(await tokenRows()).toEqual([]);
  expect((await challengeRows()).map((row) => row.used)).toEqual([false]);

  const retried = await post<SignInResponse>(appWith(), "/v1/auth/verify", body);
  expect(retried.status).toBe(200);
});

test("a_fault_that_is_not_the_chains_is_a_500_and_keeps_the_challenge", async () => {
  // Only the call to the chain is the chain's to fail. Anything else that goes wrong in a sign-in
  // is a fault of ours and stays a 500, so that it is seen and not told to be tried again. Here
  // the answer of the chain cannot be read: its `permission` throws when `verifyNep413` reads it,
  // after the lookup has ended.
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const unreadable = fakeClient({
    viewAccessKey: async () => ({
      get permission(): KeyPermission {
        throw new Error("marker fault of ours");
      },
    }),
  });
  const key = KeyPair.fromRandom("ed25519");
  const ch = await challenge(appWith());
  const body = await signChallenge(key, ch);

  const failed = await post<ErrorBody>(appWith({ client: unreadable }), "/v1/auth/verify", body);
  expect(failed.status).toBe(500);
  expect(failed.body).toEqual({ error: "internal", message: "internal error" });
  expect(JSON.stringify(failed.body)).not.toContain("marker");
  expect(log).toHaveBeenCalled();
  expect(await tokenRows()).toEqual([]);
  expect((await challengeRows()).map((row) => row.used)).toEqual([false]);

  const retried = await post<SignInResponse>(appWith(), "/v1/auth/verify", body);
  expect(retried.status).toBe(200);
});

test("malformed_verify_body_is_400", async () => {
  const app = appWith();
  const ch = await challenge(app);
  const good = await signChallenge(KeyPair.fromRandom("ed25519"), ch);
  const { signature: _signature, ...withoutSignature } = good;

  const bad: Array<[string, unknown, string]> = [
    ["not JSON", "{", "body is not valid JSON"],
    ["an empty body", "", "body is not valid JSON"],
    ["a list", [], "the request body does not fit its schema"],
    ["null", "null", "the request body does not fit its schema"],
    ["an empty object", {}, "the request body does not fit its schema"],
    ["no signature", withoutSignature, "the request body does not fit its schema"],
    ["a number for the account", { ...good, account_id: 5 }, "the request body does not fit"],
    ["an unknown key", { ...good, callback_url: "https://x.example" }, "does not fit its schema"],
  ];
  for (const [name, body, message] of bad) {
    const reply = await post<ErrorBody>(app, "/v1/auth/verify", body);
    expect(reply.status, name).toBe(400);
    expect(reply.body.error, name).toBe("bad_request");
    expect(reply.body.message, name).toContain(message);
  }
  // The faults of a body that does not fit are listed.
  const empty = await post<ErrorBody>(app, "/v1/auth/verify", {});
  expect(empty.body.issues?.map((issue) => issue.path[0]).sort()).toEqual([
    "account_id",
    "message",
    "nonce",
    "public_key",
    "recipient",
    "signature",
  ]);

  // A body this large is no sign-in, and is not read.
  const huge = await post<ErrorBody>(app, "/v1/auth/verify", {
    ...good,
    message: "x".repeat(9000),
  });
  expect(huge.status).toBe(413);
  expect(huge.body.error).toBe("payload_too_large");

  // None of it spent the challenge.
  expect((await post(app, "/v1/auth/verify", good)).status).toBe(200);
});

// ---- Tokens -----------------------------------------------------------------------------------

test("bearer_required_on_protected_routes", async () => {
  const app = appWith();
  const { token } = await signIn(app);
  const refused: Array<[string, string | undefined]> = [
    ["no header", undefined],
    ["an empty header", ""],
    ["the scheme alone", "Bearer"],
    ["another scheme", `Basic ${Buffer.from("alice:secret").toString("base64")}`],
    ["a token without a scheme", token],
    ["a token under another scheme", `Token ${token}`],
    ["a token that is too long", `Bearer ${token}A`],
    ["a token that is too short", `Bearer ${token.slice(1)}`],
    ["a token with more after it", `Bearer ${token} more`],
    ["a token that is not base64url", `Bearer ${"!".repeat(43)}`],
    ["a token that was never issued", `Bearer ${"A".repeat(43)}`],
    [
      "a token that differs in its last letter",
      `Bearer ${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`,
    ],
  ];

  for (const [path, body] of UPLOADS) {
    for (const [name, authorization] of refused) {
      const headers: Record<string, string> = authorization === undefined ? {} : { authorization };
      const reply = await post<ErrorBody>(app, path, body, headers);
      expect(reply.status, `${path}: ${name}`).toBe(401);
      expect(reply.body, `${path}: ${name}`).toEqual(UNAUTHORIZED);
      expect(reply.headers.get("www-authenticate"), `${path}: ${name}`).toBe("Bearer");
    }
    // The scheme is case-insensitive, as RFC 7235 has it.
    for (const scheme of ["Bearer", "bearer", "BEARER"]) {
      const reply = await post(app, path, body, { authorization: `${scheme} ${token}` });
      expect(reply.status, `${path}: ${scheme}`).toBe(200);
    }
  }
  // Nothing was stored for a request that was refused.
  expect(await blobCount()).toBe(2);

  // Not even a body that is too large or not JSON gets further than the refusal.
  const junk = await post<ErrorBody>(app, "/v1/blobs", "x".repeat(500_000));
  expect(junk.status).toBe(401);
  expect(junk.body).toEqual(UNAUTHORIZED);

  // What needs no account stays open: reads, and the sign-in itself.
  for (const path of ["/v1/health", "/v1/tasks", "/v1/agents"]) {
    expect((await app.request(path)).status, path).toBe(200);
  }
  expect((await post(app, "/v1/auth/challenge")).status).toBe(200);
});

test("token_expires_after_12h", async () => {
  const app = probe();
  const { token } = await signIn(appWith());
  const check = async (at: bigint) => {
    nowNs = at;
    return await whoami(app, `Bearer ${token}`);
  };

  // It works as often as it is shown, up to but not including the 12th hour.
  expect((await check(TEST_NOW)).status).toBe(200);
  expect((await check(TEST_NOW + 6n * HOUR)).status).toBe(200);
  expect((await check(TEST_NOW + 12n * HOUR - 1n)).status).toBe(200);

  for (const at of [TEST_NOW + 12n * HOUR, TEST_NOW + 13n * HOUR]) {
    const expired = await check(at);
    expect(expired.status).toBe(401);
    expect(await expired.json()).toEqual(UNAUTHORIZED);
    expect(expired.headers.get("www-authenticate")).toBe("Bearer");
  }

  // The 12 hours run from the sign-in, not from the first challenge or from the epoch.
  nowNs = TEST_NOW + 7n * HOUR;
  const later = await signIn(appWith());
  expect(later.expires_at).toBe(isoOf(TEST_NOW + 19n * HOUR));
  nowNs = TEST_NOW + 18n * HOUR;
  expect((await whoami(app, `Bearer ${later.token}`)).status).toBe(200);
});

test("the_token_is_never_logged_or_echoed", async () => {
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation(() => undefined),
  );
  const app = appWith();
  const { token } = await signIn(app);

  // Used, sent where it does not belong, met by a database that fails, and refused once expired.
  const used = await post(app, "/v1/blobs", UPLOADS[0]?.[1], bearer(token));
  const misplaced = await post(app, "/v1/auth/verify", { token }, bearer(token));
  vi.spyOn(deps.db, "query").mockRejectedValueOnce(new Error("database down"));
  const failed = await post(app, "/v1/blobs", UPLOADS[0]?.[1], bearer(token));
  nowNs = TEST_NOW + 13n * HOUR;
  const expired = await post(app, "/v1/blobs", UPLOADS[0]?.[1], bearer(token));

  expect(used.status).toBe(200);
  expect(misplaced.status).toBe(400);
  // A failing database is not a reason to sign in again: it is the API's fault, not the caller's.
  expect(failed.status).toBe(500);
  expect(failed.body).toEqual({ error: "internal", message: "internal error" });
  expect(expired.status).toBe(401);
  for (const reply of [used, misplaced, failed, expired]) {
    expect(JSON.stringify(reply.body)).not.toContain(token);
    expect(JSON.stringify([...reply.headers])).not.toContain(token);
  }
  // The failure was logged, and the log has no token in it.
  expect(spies.some((spy) => spy.mock.calls.length > 0)).toBe(true);
  for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain(token);
});

test("a_token_of_an_unknown_kind_signs_nothing_in", async () => {
  // A row that something else wrote, with a kind this code has never heard of.
  const token = "B".repeat(43);
  await deps.db.query(
    `insert into auth_tokens (token_sha256, account, public_key, key_kind, expires_at)
     values ($1, $2, 'ed25519:x', 'delegate', $3::timestamptz)`,
    [sha256Hex(token), alice, isoOf(TEST_NOW + HOUR)],
  );

  const reply = await whoami(probe(), `Bearer ${token}`);

  expect(reply.status).toBe(401);
  expect(await reply.json()).toEqual(UNAUTHORIZED);
});

// ---- A token lives as long as its key ---------------------------------------------------------

test("a_token_stops_working_within_a_minute_of_its_key_going", async () => {
  const chain = liveChain();
  const app = probe({ client: chain.client });
  const { token, key } = await signIn(appWith({ client: chain.client }));
  chain.lookups.length = 0;

  // While the key is there the token works. The key is asked about on the account the token was
  // issued to, in its canonical spelling.
  expect((await whoamiAt(app, token, TEST_NOW)).status).toBe(200);
  expect(chain.lookups).toEqual([[alice, key.getPublicKey().toString()]]);

  // The key goes. The last check was good, so the token lives until a minute after it.
  chain.permission = null;
  expect((await whoamiAt(app, token, TEST_NOW + MINUTE - 1n)).status).toBe(200);
  const refused = await whoamiAt(app, token, TEST_NOW + MINUTE);
  expect(refused.status).toBe(401);
  expect(await refused.json()).toEqual(UNAUTHORIZED);
  expect(refused.headers.get("www-authenticate")).toBe("Bearer");
  expect(await tokenRows()).toEqual([]);

  // A token that is gone costs the chain nothing.
  const asked = chain.lookups.length;
  expect((await whoamiAt(app, token, TEST_NOW + MINUTE + SECOND)).status).toBe(401);
  expect(chain.lookups.length).toBe(asked);
});

test("a_checked_key_is_not_asked_about_again_within_a_minute", async () => {
  const chain = liveChain();
  const app = probe({ client: chain.client });
  const { token } = await signIn(appWith({ client: chain.client }));
  chain.lookups.length = 0;

  // One lookup answers the minute after it, up to but not including its end. Then the next
  // request asks again.
  const times = [
    0n,
    SECOND,
    MINUTE - 1n,
    MINUTE,
    MINUTE + 30n * SECOND,
    2n * MINUTE - 1n,
    2n * MINUTE,
  ];
  const asked: number[] = [];
  for (const at of times) {
    expect((await whoamiAt(app, token, TEST_NOW + at)).status, `${at}`).toBe(200);
    asked.push(chain.lookups.length);
  }
  expect(asked).toEqual([1, 1, 1, 2, 2, 2, 3]);

  // A clock that goes back does not stretch the minute: a check from the future is no check.
  expect((await whoamiAt(app, token, TEST_NOW)).status).toBe(200);
  expect(chain.lookups.length).toBe(4);
});

test("a_burst_of_requests_on_one_token_asks_the_chain_once", async () => {
  const chain = liveChain();
  const { token } = await signIn(appWith({ client: chain.client }));
  chain.lookups.length = 0;

  // The lookup is held until a second one is made, which is what this test is against, or for
  // 150 ms, which is how long the one lookup that is right takes.
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
    setTimeout(resolve, 150);
  });
  const slow = fakeClient({
    viewAccessKey: async (account, key) => {
      chain.lookups.push([account, key]);
      if (chain.lookups.length > 1) release();
      await held;
      return { permission: "FullAccess" };
    },
  });
  const app = probe({ client: slow });

  const replies = await Promise.all(
    Array.from({ length: 6 }, () => whoami(app, `Bearer ${token}`)),
  );

  expect(replies.map((reply) => reply.status)).toEqual([200, 200, 200, 200, 200, 200]);
  expect(chain.lookups.length).toBe(1);
});

test("an_rpc_failure_is_a_503_and_not_a_pass", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const chain = liveChain();
  const app = appWith({ client: chain.client });
  const { token } = await signIn(app);
  const upload = UPLOADS[0]?.[1];

  // The chain cannot say whether the key is there: the request is not served, and the answer says
  // nothing of why. It is not a 401, since nothing is wrong with the token.
  chain.failing = true;
  const failed = await post<ErrorBody>(app, "/v1/blobs", upload, bearer(token));
  expect(failed.status).toBe(503);
  expect(failed.body).toEqual(UNAVAILABLE);
  expect(failed.headers.get("www-authenticate")).toBeNull();
  expect(JSON.stringify(failed.body)).not.toContain("marker-rpc");
  expect(log).toHaveBeenCalled();
  expect(await blobCount()).toBe(0);
  // The token is not held against its key for the chain's fault, and works again when it is back.
  expect(await tokenRows()).toHaveLength(1);
  chain.failing = false;
  expect((await post(app, "/v1/blobs", upload, bearer(token))).status).toBe(200);

  // A check a minute old is no check: with the chain down again the token does not pass. Within
  // the minute nothing is asked, so the chain being down changes nothing.
  chain.failing = true;
  nowNs = TEST_NOW + MINUTE - 1n;
  expect((await post(app, "/v1/blobs", upload, bearer(token))).status).toBe(200);
  nowNs = TEST_NOW + MINUTE;
  const stale = await post<ErrorBody>(app, "/v1/blobs", upload, bearer(token));
  expect(stale.status).toBe(503);
  expect(stale.body.error).toBe("unavailable");
});

test("a_function_call_key_whose_scope_changed_is_refused", async () => {
  const chain = liveChain(functionCallTo(FIXTURE_CONTRACT));
  const app = probe({ client: chain.client });
  const { token } = await signIn(appWith({ client: chain.client }));

  const before = await whoamiAt(app, token, TEST_NOW);
  expect(await before.json()).toEqual({ account: alice, key_kind: "function_call" });

  // The key is taken off the account and put back, limited to another contract.
  chain.permission = functionCallTo("other.test.near");
  const after = await whoamiAt(app, token, TEST_NOW + MINUTE);
  expect(after.status).toBe(401);
  expect(await after.json()).toEqual(UNAUTHORIZED);
  expect(await tokenRows()).toEqual([]);
});

test("a_token_never_carries_more_than_its_key_has_or_had", async () => {
  const tender = functionCallTo(FIXTURE_CONTRACT);
  // The key when the token is issued, the key a minute later, and what the token is then: its
  // kind, or null for refused. A token is the lower of the two kinds, and refused when the key
  // no longer qualifies.
  const cases: Array<[KeyPermission, KeyPermission | null, string | null]> = [
    ["FullAccess", "FullAccess", "full_access"],
    ["FullAccess", tender, "function_call"],
    [tender, "FullAccess", "function_call"],
    [tender, tender, "function_call"],
    ["FullAccess", functionCallTo("other.test.near"), null],
    ["FullAccess", null, null],
    [tender, null, null],
  ];

  for (const [issued, later, expected] of cases) {
    const name = `${JSON.stringify(issued)}, then ${JSON.stringify(later)}`;
    await resetDb(deps.db);
    nowNs = TEST_NOW;
    const chain = liveChain(issued);
    const { token } = await signIn(appWith({ client: chain.client }));

    chain.permission = later;
    const reply = await whoamiAt(probe({ client: chain.client }), token, TEST_NOW + MINUTE);

    if (expected === null) expect(reply.status, name).toBe(401);
    else expect(await reply.json(), name).toEqual({ account: alice, key_kind: expected });
  }
});

test("a_slow_read_of_the_token_does_not_make_an_old_answer_look_new", async () => {
  const chain = liveChain();
  const { token } = await signIn(appWith({ client: chain.client }));
  // A database that takes 20 s to read the token when `slow` says so: the clock of the API moves
  // while the read is waited for.
  let slow = false;
  const db: Db = {
    query: async <T>(sql: string, params?: unknown[]) => {
      const rows = await deps.db.query<T>(sql, params);
      if (slow && sql.includes("select") && sql.includes("from auth_tokens")) nowNs += 20n * SECOND;
      return rows;
    },
    exec: (sql) => deps.db.exec(sql),
    tx: (fn) => deps.db.tx(fn),
    close: () => deps.db.close(),
  };
  const app = probe({ client: chain.client, db });
  chain.lookups.length = 0;

  // Checked at +0, the answer is good until +60 s.
  expect((await whoamiAt(app, token, TEST_NOW)).status).toBe(200);
  expect(chain.lookups).toHaveLength(1);

  // A request that starts at +30 s and waits 20 s for the row is served at +50 s, still on it.
  slow = true;
  expect((await whoamiAt(app, token, TEST_NOW + 30n * SECOND)).status).toBe(200);
  expect(chain.lookups).toHaveLength(1);

  // The key goes. A request that starts at +59 s, inside the minute, is served at +79 s, outside
  // it, and so it asks the chain.
  chain.permission = null;
  const refused = await whoamiAt(app, token, TEST_NOW + 59n * SECOND);
  expect(refused.status).toBe(401);
  expect(await refused.json()).toEqual(UNAUTHORIZED);
  expect(chain.lookups).toHaveLength(2);
  expect(await tokenRows()).toEqual([]);
});

test("an_answer_is_dated_from_the_question_and_never_from_after_it", async () => {
  const chain = liveChain();
  const { token } = await signIn(appWith({ client: chain.client }));
  // A chain that moves the clock of the API by `drift` while it answers.
  let drift = 0n;
  const client = fakeClient({
    viewAccessKey: (account, key) => {
      nowNs += drift;
      return chain.client.viewAccessKey(account, key);
    },
  });
  /** How many times the chain has been asked, once `app` has served `token` at `at`. */
  const lookupsAfter = async (app: ReturnType<typeof probe>, at: bigint) => {
    expect((await whoamiAt(app, token, at)).status, `${at}`).toBe(200);
    return chain.lookups.length;
  };
  chain.lookups.length = 0;

  // Asked at +0 and answered at +4 s, the answer is good for the minute from the question, up
  // to +60 s, and not for the minute from its arrival.
  drift = 4n * SECOND;
  const forward = probe({ client });
  const seenForward: number[] = [];
  for (const at of [0n, MINUTE - 1n, MINUTE]) {
    seenForward.push(await lookupsAfter(forward, TEST_NOW + at));
  }
  expect(seenForward).toEqual([1, 1, 2]);

  // Asked at +200 s and answered at +100 s, because the clock went back while the chain was
  // answering, the answer is dated by the clock as it now stands: good from +100 s to +160 s.
  chain.lookups.length = 0;
  drift = -100n * SECOND;
  const backward = probe({ client });
  const seenBackward: number[] = [];
  for (const at of [200n * SECOND, 130n * SECOND, 160n * SECOND - 1n, 160n * SECOND]) {
    seenBackward.push(await lookupsAfter(backward, TEST_NOW + at));
  }
  expect(seenBackward).toEqual([1, 1, 1, 2]);
});

// ---- A chain that does not answer -------------------------------------------------------------

test("a_key_check_that_gets_no_answer_in_5s_is_a_503", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const chain = liveChain();
  const { token } = await signIn(appWith({ client: chain.client }));
  const app = probe({ client: chain.client });
  chain.lookups.length = 0;

  // The first request on a token asks the chain, which never says. It is refused as it is when
  // the chain fails: not served, and not a 401, since nothing is wrong with the token.
  const refused = await waitOutTheDeadline(chain, () => whoami(app, `Bearer ${token}`));
  expect(refused.status).toBe(503);
  expect(await refused.json()).toEqual(UNAVAILABLE);
  expect(refused.headers.get("www-authenticate")).toBeNull();
  expect(chain.lookups).toHaveLength(1);
  expect(log).toHaveBeenCalledWith(
    "api: cannot check the key of a signed-in token (NoAnswerInTime)",
  );

  // The lookup that was given up on ends on its own, and a failure then is nobody's to handle.
  expect(await unhandledAfterLateFailure(chain)).toEqual([]);

  // The token is not held against its key for the chain's fault. The give-up is not kept either:
  // the next request asks the chain again, and has its answer.
  expect(await tokenRows()).toHaveLength(1);
  chain.hanging = false;
  expect((await whoamiAt(app, token, TEST_NOW)).status).toBe(200);
  expect(chain.lookups).toHaveLength(2);
});

test("a_sign_in_that_gets_no_key_answer_in_5s_is_a_503_and_keeps_its_challenge", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const chain = liveChain();
  const app = appWith({ client: chain.client });
  const ch = await challenge(app);
  const body = await signChallenge(KeyPair.fromRandom("ed25519"), ch);

  const refused = await waitOutTheDeadline(chain, () =>
    post<ErrorBody>(app, "/v1/auth/verify", body),
  );
  expect(refused.status).toBe(503);
  expect(refused.body).toEqual(UNAVAILABLE);
  expect(refused.headers.get("www-authenticate")).toBeNull();
  expect(chain.lookups).toHaveLength(1);
  expect(log).toHaveBeenCalledWith("api: cannot check the key of a sign-in (NoAnswerInTime)");

  // Nothing was spent or stored. The lookup that was given up on ends on its own, as above.
  expect(await tokenRows()).toEqual([]);
  expect((await challengeRows()).map((row) => row.used)).toEqual([false]);
  expect(await unhandledAfterLateFailure(chain)).toEqual([]);

  // The very same sign-in works once the chain answers.
  chain.hanging = false;
  const retried = await post<SignInResponse>(app, "/v1/auth/verify", body);
  expect(retried.status).toBe(200);
  expect(await tokenRows()).toHaveLength(1);
});

test("a_lookup_inside_the_deadline_is_used_and_leaves_no_timer_behind", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const chain = liveChain();
  const app = appWith({ client: chain.client });
  const checked = probe({ client: chain.client });
  const body = await signChallenge(KeyPair.fromRandom("ed25519"), await challenge(app));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

  // A chain that takes 4,999 ms is slow, not down: its answer is used, by the sign-in and by the
  // check of the token, and the bound on the question is gone with it.
  const slowly = async <T>(request: () => T | Promise<T>): Promise<T> => {
    chain.hanging = true;
    const reached = chain.asked();
    const pending = request();
    await reached;
    await vi.advanceTimersByTimeAsync(4_999);
    chain.settle();
    return await pending;
  };
  const signed = await slowly(() => post<SignInResponse>(app, "/v1/auth/verify", body));
  expect(signed.status).toBe(200);
  expect(vi.getTimerCount()).toBe(0);
  const who = await slowly(() => whoami(checked, `Bearer ${signed.body.token}`));
  expect(who.status).toBe(200);
  expect(vi.getTimerCount()).toBe(0);

  // A chain that fails at once leaves no timer either.
  chain.hanging = false;
  chain.failing = true;
  nowNs = TEST_NOW + MINUTE;
  expect((await whoami(checked, `Bearer ${signed.body.token}`)).status).toBe(503);
  expect(vi.getTimerCount()).toBe(0);
});

test("a_failed_lookup_logs_the_name_of_the_error_and_not_its_text", async () => {
  // Spies on every level, so that no way of logging gets by.
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation(() => undefined),
  );
  // The text of an RPC error can name an endpoint with a key in it, and so can the error it was
  // caused by. A thing that is thrown and is no error has no name, only a type.
  const failures: Array<[string, () => unknown]> = [
    [
      "TypedError",
      () =>
        Object.assign(
          new Error("rpc down at https://marker-rpc.example/?key=secret", {
            cause: new Error("connect refused: https://marker-rpc.example/?key=secret"),
          }),
          { name: "TypedError" },
        ),
    ],
    ["string", () => "rpc down at https://marker-rpc.example/?key=secret"],
  ];
  const { token } = await signIn(appWith());

  for (const [name, failure] of failures) {
    spies.forEach((spy) => {
      spy.mockClear();
    });
    const down = fakeClient({
      viewAccessKey: () => Promise.reject(failure()),
    });
    const ch = await challenge(appWith());
    const body = await signChallenge(KeyPair.fromRandom("ed25519"), ch);

    const rechecked = await whoami(probe({ client: down }), `Bearer ${token}`);
    const signedIn = await post(appWith({ client: down }), "/v1/auth/verify", body);

    expect([rechecked.status, signedIn.status]).toEqual([503, 503]);
    // One line for each failure, with the name of what went wrong in it and nothing else.
    const lines = spies.flatMap((spy) => spy.mock.calls.map((args) => format(...args)));
    expect(lines).toEqual([
      `api: cannot check the key of a signed-in token (${name})`,
      `api: cannot check the key of a sign-in (${name})`,
    ]);
  }
});

// ---- Housekeeping -----------------------------------------------------------------------------

test("creating_a_challenge_removes_what_expired_over_an_hour_ago", async () => {
  const insertChallenge = (nonce: string, expires: bigint, used: boolean) =>
    deps.db.query(
      "insert into auth_challenges (nonce, expires_at, used) values ($1, $2::timestamptz, $3)",
      [nonce, isoOf(expires), used],
    );
  const insertToken = (hash: string, expires: bigint) =>
    deps.db.query(
      `insert into auth_tokens (token_sha256, account, public_key, key_kind, expires_at)
       values ($1, $2, 'ed25519:x', 'full_access', $3::timestamptz)`,
      [hash, alice, isoOf(expires)],
    );

  await insertChallenge("old-unused", TEST_NOW - HOUR - SECOND, false);
  await insertChallenge("old-used", TEST_NOW - 3n * HOUR, true);
  await insertChallenge("recent-used", TEST_NOW - HOUR + SECOND, true);
  await insertChallenge("recent-unused", TEST_NOW - MINUTE, false);
  await insertChallenge("live", TEST_NOW + MINUTE, false);
  await insertToken("old-token", TEST_NOW - HOUR - SECOND);
  await insertToken("recent-token", TEST_NOW - HOUR + SECOND);
  await insertToken("live-token", TEST_NOW + HOUR);

  const fresh = await challenge(appWith());

  expect((await challengeRows()).map((row) => row.nonce).sort()).toEqual(
    ["live", "recent-unused", "recent-used", fresh.nonce].sort(),
  );
  expect((await tokenRows()).map((row) => row.token_sha256).sort()).toEqual([
    "live-token",
    "recent-token",
  ]);
});

// ---- CORS -------------------------------------------------------------------------------------

test("cors_covers_the_auth_routes", async () => {
  const app = appWith({ network: "testnet", webOrigins: [WEB] });
  for (const path of ["/v1/auth/challenge", "/v1/auth/verify"]) {
    const preflight = await app.request(path, {
      method: "OPTIONS",
      headers: {
        Origin: WEB,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    });
    expect(preflight.status, path).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin"), path).toBe(WEB);
  }
  // The answers, refusals included, can be read by the web app.
  const challenged = await post(app, "/v1/auth/challenge", undefined, { origin: WEB });
  const refused = await post(app, "/v1/auth/verify", {}, { origin: WEB });
  const unauthorized = await post(app, "/v1/blobs", {}, { origin: WEB });
  expect([challenged.status, refused.status, unauthorized.status]).toEqual([200, 400, 401]);
  for (const reply of [challenged, refused, unauthorized]) {
    expect(reply.headers.get("access-control-allow-origin")).toBe(WEB);
  }
});
