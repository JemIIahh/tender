import {
  type AccountEntriesResponse,
  type AgentDetailResponse,
  type AgentSummary,
  ApiError,
  type BlobUploadResponse,
  type HealthResponse,
  type ListAgentsResponse,
  type ListTasksResponse,
  type Scorecard,
  type StartResponse,
  sha256Hex,
  type TaskDetailResponse,
  type TaskSummary,
  type TelegramLinkResponse,
} from "@tender/shared";
import { KeyPair, type Provider } from "near-api-js";
import * as nearNep413 from "near-api-js/nep413";
import { afterEach, expect, test, vi } from "vitest";
import { ApiClient } from "../src/index";

// `ApiClient` over a fake API. The fake's `fetch` notes each call (with the `this` it was called
// with) and answers it from the routes a test gives it. Its sign-in is the real protocol: it
// issues a nonce, and accepts a verify only if the signature holds, which near-api-js checks. That
// is its own NEP-413, not the serializer of `@tender/client` that the client signs with, so the
// two are held against each other. The clock is a field, so that a test can move the time of the
// API and of the client together. The round trip against the real app is
// packages/api/test/apiclient.test.ts.

const BASE = "http://api.test";
const ACCOUNT = "alice.test.near";
const KEY = KeyPair.fromRandom("ed25519");
const SIGNER = { accountId: ACCOUNT, privateKey: KEY.toString() };
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const START = Date.UTC(2026, 9, 30, 12, 0, 0);
const HASH = "ab".repeat(32);
const U64_MAX = 2n ** 64n - 1n;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---- Answers ----------------------------------------------------------------------------------

const TASK: TaskSummary = {
  id: "7",
  title: "Extract invoice totals",
  category: "extraction",
  tags: ["extraction", "json"],
  token: "token.test.near",
  reward: "1000003",
  phase: "open",
  poster: "poster.test.near",
  verifier: "judge.test.near",
  created_at: "1793307169820229000",
  commit_deadline: "1793307289820229000",
  reveal_deadline: "1793307409820229000",
  pick_deadline: "1793307529820229000",
  fallback_deadline: "1793307649820229000",
  commit_count: 2,
  reveal_count: 0,
  working_count: 1,
  judge_status: null,
  judge_reason: null,
  is_team_poster: false,
  parent: null,
  outcome_kind: null,
};
const TASKS_PAGE: ListTasksResponse = { tasks: [TASK], next_cursor: "7" };
const TASK_RESPONSE: TaskDetailResponse = {
  task: {
    ...TASK,
    brief_uri: `${BASE}/v1/blobs/${HASH}`,
    brief_hash: HASH,
    criteria_hash: HASH,
    heldout_commitment: null,
    max_entries: 0,
    max_winners: 1,
    invited: [],
    fee_bps: 500,
    outcome: null,
  },
  brief: null,
  criteria: null,
  entries: [],
  funders: [],
  children: [],
  scorecard: null,
};
const AGENT: AgentSummary = {
  account: ACCOUNT,
  asp: null,
  name: "Alice Extractor",
  tags: ["extraction"],
  profile_uri: `${BASE}/v1/blobs/${HASH}`,
  profile_hash: HASH,
  registered_height: "65",
  entries: 1,
  reveals: 1,
  wins: 1,
  earned: { "token.test.near": "1000003" },
  picks_made: 0,
  voids_after_reveals: 0,
  is_team: false,
};
const AGENTS_PAGE: ListAgentsResponse = { agents: [AGENT], next_cursor: null };
const AGENT_RESPONSE: AgentDetailResponse = {
  agent: AGENT,
  recent_entries: [
    { task_id: "7", title: "Extract invoice totals", phase: "open", revealed: false, won: false },
  ],
};
const ENTRIES: AccountEntriesResponse = { entries: [] };
const HEALTH: HealthResponse = {
  ok: true,
  network: "sandbox",
  contract: "tender.test.near",
  indexed_height: "90",
  chain_final_height: "100",
  lag_blocks: "10",
};
const SCORECARD: Scorecard = {
  version: 1,
  task_id: "3",
  verifier: "judge.test.near",
  kind: "exact",
  criteria_hash: HASH,
  heldout_commitment: null,
  heldout: null,
  tie_break: "score desc, committed_at_block asc, account asc",
  entries: [
    {
      account: ACCOUNT,
      content_hash: HASH,
      uri: "ipfs://alice-work",
      committed_at_block: "65",
      score: 100,
      passed: true,
      reasons: ["matches the expected value"],
    },
  ],
  winners: [{ account: ACCOUNT, bps: 10_000 }],
  generated_at: "2026-10-30T10:00:00Z",
  judge: { software: "tender-judge/1", model: null },
};
const STARTED: StartResponse = { ok: true, working_count: 3 };
const LINK: TelegramLinkResponse = {
  url: "https://t.me/tender_test_bot?start=abc",
  expires_at: "2026-10-30T12:10:00.000Z",
};
const UPLOADED: BlobUploadResponse = { sha256: HASH, uri: `${BASE}/v1/blobs/${HASH}` };
const BLOB = new TextEncoder().encode("the bytes of a brief");
const BLOB_HASH = sha256Hex(BLOB);

const UNAUTHORIZED = {
  error: "unauthorized",
  message: "sign in with a bearer token from POST /v1/auth/verify",
};

// ---- The fake API -----------------------------------------------------------------------------

interface Call {
  /** What `this` was when `fetch` was called. */
  self: unknown;
  method: string;
  url: URL;
  headers: Headers;
  body: string | undefined;
}

type Handler = (call: Call) => Response | Promise<Response>;

interface VerifyBody {
  account_id: string;
  public_key: string;
  signature: string;
  nonce: string;
  message: string;
  recipient: string;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const refusal = (error: string) => ({ error, message: "refused" });

/** The `index`th of `items`, which the test knows is there. */
function nth<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`expected an item at index ${index}`);
  return item;
}

/** A promise that a test settles when it chooses. */
function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve: () => resolve() };
}

/**
 * Whether `body` is a sign-in that NEP-413 accepts, by near-api-js's own check of the signature.
 * The chain is a stub that says every key is a full-access key.
 */
async function signatureHolds(body: VerifyBody): Promise<boolean> {
  const provider = {
    viewAccessKey: async () => ({ permission: "FullAccess" }),
  } as unknown as Provider;
  try {
    await nearNep413.verifyMessage({
      signerAccountId: body.account_id,
      signerPublicKey: body.public_key,
      payload: {
        message: body.message,
        recipient: body.recipient,
        nonce: Uint8Array.from(Buffer.from(body.nonce, "base64")),
      },
      signature: Uint8Array.from(Buffer.from(body.signature, "base64")),
      provider,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * A stand-in for the API. Sign-in is answered by the fake itself: it knows `ACCOUNT` and `KEY`,
 * and hands out `token-1`, `token-2` and so on, each good for 12 hours from `clock.now`. Any other
 * route is answered by the handlers given to `on`; the latest one that matches wins, and a route
 * that none matches is a 404. A handler for a route named exactly (`"POST /v1/auth/challenge"`)
 * takes the place of the fake's own answer. `signedIn(handler)` is a handler that answers 401 to a
 * request that carries no token the fake has issued and not revoked.
 */
function fakeApi() {
  const routes: Array<[string | RegExp, Handler]> = [];
  const live = new Set<string>();
  const nonces = new Set<string>();

  async function challenge(): Promise<Response> {
    api.challenges++;
    await api.beforeChallenge?.();
    const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
    nonces.add(nonce);
    return json({
      nonce,
      message: "Sign in to Tender",
      recipient: "tender",
      expires_at: new Date(api.clock.now + 5 * MINUTE).toISOString(),
    });
  }

  async function verify(call: Call): Promise<Response> {
    api.verifies++;
    if (api.refuseSignIns) return json(refusal("key_not_found"), 401);
    const body = JSON.parse(call.body ?? "null") as VerifyBody;
    if (!nonces.delete(body.nonce)) return json(refusal("bad_nonce"), 401);
    if (body.account_id !== ACCOUNT || body.public_key !== KEY.getPublicKey().toString()) {
      return json(refusal("key_not_found"), 401);
    }
    if (!(await signatureHolds(body))) return json(refusal("bad_signature"), 401);
    const token = `token-${api.tokens.length + 1}`;
    api.tokens.push(token);
    live.add(token);
    return json({
      token,
      expires_at: new Date(api.clock.now + 12 * HOUR).toISOString(),
      key_kind: "full_access",
    });
  }

  const api = {
    calls: [] as Call[],
    /** The tokens handed out, in order. */
    tokens: [] as string[],
    clock: { now: START },
    challenges: 0,
    verifies: 0,
    /** Answers every verify with a 401. */
    refuseSignIns: false,
    /** Runs when a challenge is asked for, before it is answered. */
    beforeChallenge: undefined as (() => Promise<void>) | undefined,
    fetch: undefined as unknown as typeof fetch,

    on(route: string | RegExp, handler: Handler): void {
      routes.unshift([route, handler]);
    },
    signedIn(handler: Handler): Handler {
      return (call) => {
        const token = /^Bearer (.+)$/.exec(call.headers.get("Authorization") ?? "")?.[1];
        return token !== undefined && live.has(token) ? handler(call) : json(UNAUTHORIZED, 401);
      };
    },
    revoke(token: string): void {
      live.delete(token);
    },
    /** The calls to `path`, in order. */
    to(path: string): Call[] {
      return api.calls.filter((call) => call.url.pathname === path);
    },
  };

  api.fetch = async function (this: unknown, input: string | URL | Request, init?: RequestInit) {
    const call: Call = {
      self: this,
      method: init?.method ?? "GET",
      url: new URL(String(input)),
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    api.calls.push(call);
    const route = `${call.method} ${call.url.pathname}`;
    // A route a test names exactly is its own, a sign-in route too; a pattern is not.
    const named = routes.find(([match]) => match === route);
    if (named) return await named[1](call);
    if (route === "POST /v1/auth/challenge") return await challenge();
    if (route === "POST /v1/auth/verify") return await verify(call);
    const found = routes.find(([match]) =>
      typeof match === "string" ? match === route : match.test(route),
    );
    return found
      ? await found[1](call)
      : json({ error: "not_found", message: "no such route" }, 404);
  } as typeof fetch;

  return api;
}

type FakeApi = ReturnType<typeof fakeApi>;

/** Every route of the API with a good answer, for the id 7 and the account `ACCOUNT`. */
function serveBoard(api: FakeApi): void {
  api.on("GET /v1/health", () => json(HEALTH));
  api.on(/^GET \/v1\/tasks$/, () => json(TASKS_PAGE));
  api.on(/^GET \/v1\/tasks\/\d+$/, () => json(TASK_RESPONSE));
  api.on(/^GET \/v1\/agents$/, () => json(AGENTS_PAGE));
  api.on(/^GET \/v1\/agents\/[^/]+$/, () => json(AGENT_RESPONSE));
  api.on("GET /v1/entries", () => json(ENTRIES));
  api.on(/^GET \/v1\/scorecards\/\d+$/, () => json(SCORECARD));
  api.on(`GET /v1/blobs/${BLOB_HASH}`, () => new Response(BLOB));
  api.on(
    "POST /v1/blobs",
    api.signedIn(() => json(UPLOADED)),
  );
  api.on(
    "POST /v1/heldout",
    api.signedIn(() => json({ ok: true })),
  );
  api.on(
    /^POST \/v1\/tasks\/\d+\/start$/,
    api.signedIn(() => json(STARTED)),
  );
  api.on(
    "POST /v1/telegram/link",
    api.signedIn(() => json(LINK)),
  );
}

/** A client of `api` that signs in as `ACCOUNT` and tells the time by the fake's clock. */
function clientOf(api: FakeApi): ApiClient {
  return new ApiClient({
    baseUrl: BASE,
    signer: SIGNER,
    fetchImpl: api.fetch,
    now: () => api.clock.now,
  });
}

/** What the promise rejected with: the test fails if it resolved. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to reject, and it resolved");
}

async function apiError(promise: Promise<unknown>): Promise<ApiError> {
  const error = await rejection(promise);
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

const FILE = { kind: "brief", contentType: "application/json", bytes: BLOB } as const;

// ---- Requests ---------------------------------------------------------------------------------

test("requests_go_to_the_paths_and_queries_of_the_api", async () => {
  const api = fakeApi();
  serveBoard(api);
  // A trailing slash on the base URL is dropped, and there is no `/v1` in it.
  const client = new ApiClient({ baseUrl: `${BASE}//`, signer: SIGNER, fetchImpl: api.fetch });

  await client.listTasks();
  await client.listTasks({});
  await client.listTasks({ limit: 5 });
  await client.listTasks({
    phase: "revealing",
    tag: "regex-json",
    poster: "poster.test.near",
    verifier: "judge.test.near",
    parent: U64_MAX,
    limit: 50,
    cursor: "123",
  });
  await client.listAgents();
  await client.listAgents({ tag: "extraction", asp: "asp.test.near", limit: 1, cursor: ACCOUNT });
  await client.listEntries(ACCOUNT);
  await client.health();
  await client.getTask(7n);
  await client.getScorecard(3n);
  await client.getAgent(ACCOUNT);
  await client.getBlob(BLOB_HASH);

  expect(api.calls.map((call) => [call.method, call.url.href])).toEqual([
    ["GET", `${BASE}/v1/tasks`],
    ["GET", `${BASE}/v1/tasks`],
    ["GET", `${BASE}/v1/tasks?limit=5`],
    [
      "GET",
      `${BASE}/v1/tasks?phase=revealing&tag=regex-json&poster=poster.test.near&verifier=judge.test.near&parent=18446744073709551615&limit=50&cursor=123`,
    ],
    ["GET", `${BASE}/v1/agents`],
    ["GET", `${BASE}/v1/agents?tag=extraction&asp=asp.test.near&limit=1&cursor=alice.test.near`],
    ["GET", `${BASE}/v1/entries?account=alice.test.near`],
    ["GET", `${BASE}/v1/health`],
    ["GET", `${BASE}/v1/tasks/7`],
    ["GET", `${BASE}/v1/scorecards/3`],
    ["GET", `${BASE}/v1/agents/alice.test.near`],
    ["GET", `${BASE}/v1/blobs/${BLOB_HASH}`],
  ]);
  // The reads are public: no sign-in, and no token sent.
  expect(api.challenges).toBe(0);
  expect(api.calls.every((call) => call.headers.get("Authorization") === null)).toBe(true);
});

test("a_null_cursor_is_no_cursor", async () => {
  const api = fakeApi();
  serveBoard(api);
  const client = clientOf(api);

  // The `next_cursor` of the last page is null, and a caller hands it back as it is. That asks for
  // the first page, as no cursor does: it is not sent, as the text "null" or as anything else.
  await client.listTasks({ cursor: null });
  await client.listTasks({ limit: 5, cursor: null });
  await client.listAgents({ cursor: null });
  await client.listAgents({ tag: "extraction", cursor: null });
  const page = await client.listAgents();
  expect(page.next_cursor).toBeNull();
  await client.listAgents({ cursor: page.next_cursor });
  // A cursor that is there goes out.
  await client.listTasks({ cursor: "123" });
  await client.listAgents({ cursor: ACCOUNT });

  expect(api.calls.map((call) => call.url.href)).toEqual([
    `${BASE}/v1/tasks`,
    `${BASE}/v1/tasks?limit=5`,
    `${BASE}/v1/agents`,
    `${BASE}/v1/agents?tag=extraction`,
    `${BASE}/v1/agents`,
    `${BASE}/v1/agents`,
    `${BASE}/v1/tasks?cursor=123`,
    `${BASE}/v1/agents?cursor=alice.test.near`,
  ]);
});

test("ids_above_two_to_the_53_go_out_as_exact_decimal_strings", async () => {
  const api = fakeApi();
  serveBoard(api);
  const client = clientOf(api);

  await client.getTask(U64_MAX);
  await client.getScorecard(U64_MAX);
  await client.start(U64_MAX);
  await client.uploadBlob({ ...FILE, kind: "result", taskId: U64_MAX });

  const paths = api.calls.filter((call) => !call.url.pathname.includes("/auth/"));
  expect(paths.map((call) => call.url.pathname)).toEqual([
    "/v1/tasks/18446744073709551615",
    "/v1/scorecards/18446744073709551615",
    "/v1/tasks/18446744073709551615/start",
    "/v1/blobs",
  ]);
  expect(JSON.parse(nth(paths, 3).body ?? "null").task_id).toBe("18446744073709551615");
});

test("text_in_a_path_cannot_leave_its_segment", async () => {
  const api = fakeApi();
  serveBoard(api);
  const client = clientOf(api);

  await client.getAgent("a/b?c=d#e");
  await client.getBlob("../auth/challenge");

  expect(api.calls.map((call) => call.url.pathname + call.url.search)).toEqual([
    "/v1/agents/a%2Fb%3Fc%3Dd%23e",
    "/v1/blobs/..%2Fauth%2Fchallenge",
  ]);

  // What cannot be put in a path rejects, as every other failure does, and sends nothing.
  const before = api.calls.length;
  expect(await rejection(client.getAgent("\ud800"))).toBeInstanceOf(URIError);
  expect(api.calls).toHaveLength(before);
});

test("uploads_send_the_bytes_as_base64_and_the_task_as_a_decimal_string", async () => {
  const api = fakeApi();
  serveBoard(api);
  const client = clientOf(api);
  // The most a result can be, which is not a multiple of the chunk the base64 is made in, and far
  // more than a call can take as arguments.
  const bytes = Uint8Array.from({ length: 262_144 }, (_, i) => (i * 7 + 3) % 256);

  expect(
    await client.uploadBlob({ kind: "brief", contentType: "application/json", bytes }),
  ).toEqual(UPLOADED);
  await client.uploadBlob({ kind: "result", contentType: "text/plain", bytes, taskId: 12n });
  expect(await client.uploadHeldout(HASH, BLOB)).toBeUndefined();

  const uploads = api.calls.filter((call) => !call.url.pathname.includes("/auth/"));
  expect(uploads.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
    "POST /v1/blobs",
    "POST /v1/blobs",
    "POST /v1/heldout",
  ]);
  const [brief, result, heldout] = uploads.map((call) => JSON.parse(call.body ?? "null"));
  const base64 = Buffer.from(bytes).toString("base64");
  // A task id that is not given is left out of the body: the API takes a decimal string, or no key.
  expect(brief).toEqual({
    kind: "brief",
    content_type: "application/json",
    content_base64: base64,
  });
  expect(result).toEqual({
    kind: "result",
    content_type: "text/plain",
    content_base64: base64,
    task_id: "12",
  });
  expect(heldout).toEqual({
    commitment: HASH,
    content_base64: Buffer.from(BLOB).toString("base64"),
  });
  for (const call of uploads) {
    expect(call.headers.get("Authorization")).toBe("Bearer token-1");
    expect(call.headers.get("Content-Type")).toBe("application/json");
  }
});

test("start_and_telegram_link_are_posts_with_a_token_and_no_body", async () => {
  const api = fakeApi();
  serveBoard(api);
  const client = clientOf(api);

  expect(await client.start(7n)).toEqual(STARTED);
  expect(await client.telegramLink()).toEqual(LINK);

  for (const call of [nth(api.to("/v1/tasks/7/start"), 0), nth(api.to("/v1/telegram/link"), 0)]) {
    expect(call.method).toBe("POST");
    expect(call.headers.get("Authorization")).toBe("Bearer token-1");
    expect(call.body).toBeUndefined();
  }
});

// ---- Signing in -------------------------------------------------------------------------------

test("sign_in_sends_a_signature_that_nep413_accepts", async () => {
  const api = fakeApi();
  const client = clientOf(api);

  // The fake accepts the verify only if near-api-js finds the signature good, so this passing is
  // the proof; what follows is what was sent.
  expect(await client.signIn()).toBe("token-1");
  expect(api.calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
    "POST /v1/auth/challenge",
    "POST /v1/auth/verify",
  ]);
  const verify = nth(api.calls, 1);
  expect(verify.headers.get("Content-Type")).toBe("application/json");
  expect(verify.headers.get("Authorization")).toBeNull();
  const sent = JSON.parse(verify.body ?? "null") as VerifyBody;
  expect(Object.keys(sent).sort()).toEqual([
    "account_id",
    "message",
    "nonce",
    "public_key",
    "recipient",
    "signature",
  ]);
  expect(sent.account_id).toBe(ACCOUNT);
  expect(sent.public_key).toBe(KEY.getPublicKey().toString());
  expect(sent.message).toBe("Sign in to Tender");
  expect(sent.recipient).toBe("tender");

  // The check is not vacuous: the same signature is refused for anything else.
  expect(await signatureHolds(sent)).toBe(true);
  expect(await signatureHolds({ ...sent, message: "Sign in to Elsewhere" })).toBe(false);
  expect(await signatureHolds({ ...sent, recipient: "elsewhere" })).toBe(false);
  const other = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  expect(await signatureHolds({ ...sent, nonce: other })).toBe(false);
});

test("a_token_is_kept_between_calls", async () => {
  // With the clock the client has by default.
  const api = fakeApi();
  api.clock.now = Date.now();
  serveBoard(api);
  const client = new ApiClient({ baseUrl: BASE, signer: SIGNER, fetchImpl: api.fetch });

  await client.start(7n);
  await client.telegramLink();
  await client.start(7n);
  expect(await client.signIn()).toBe("token-1");

  expect(api.challenges).toBe(1);
  expect(api.verifies).toBe(1);
});

test("the_token_is_replaced_five_minutes_before_it_expires", async () => {
  const api = fakeApi();
  serveBoard(api);
  const client = clientOf(api);
  const expiry = START + 12 * HOUR;

  await client.start(7n);
  expect(api.tokens).toEqual(["token-1"]);

  // A millisecond before the last five minutes: still the same token, signIn() included.
  api.clock.now = expiry - 5 * MINUTE - 1;
  await client.start(7n);
  expect(await client.signIn()).toBe("token-1");
  expect(api.challenges).toBe(1);

  // A millisecond into them: a new sign-in, whose token lasts 12 hours from now.
  api.clock.now = expiry - 5 * MINUTE + 1;
  await client.start(7n);
  expect(api.challenges).toBe(2);
  expect(nth(api.to("/v1/tasks/7/start"), 2).headers.get("Authorization")).toBe("Bearer token-2");

  api.clock.now += 11 * HOUR;
  await client.start(7n);
  expect(await client.signIn()).toBe("token-2");
  expect(api.challenges).toBe(2);
  api.clock.now += HOUR;
  expect(await client.signIn()).toBe("token-3");
  expect(api.challenges).toBe(3);
});

test("concurrent_sign_ins_make_one_challenge", async () => {
  const api = fakeApi();
  serveBoard(api);
  const client = clientOf(api);
  const release = deferred();
  api.beforeChallenge = () => release.promise;

  // The first sign-in is under way, its challenge not yet answered ...
  const first = client.signIn();
  await vi.waitFor(() => expect(api.challenges).toBe(1));
  // ... and whatever asks for a token meanwhile joins it.
  const joined = [client.signIn(), client.signIn()];
  const started = client.start(7n);
  const linked = client.telegramLink();
  release.resolve();

  expect(await Promise.all([first, ...joined])).toEqual(["token-1", "token-1", "token-1"]);
  expect(await started).toEqual(STARTED);
  expect(await linked).toEqual(LINK);
  expect(api.challenges).toBe(1);
  expect(api.verifies).toBe(1);
  expect(api.tokens).toEqual(["token-1"]);
});

test("a_sign_in_that_fails_does_not_stick", async () => {
  const api = fakeApi();
  serveBoard(api);
  const client = clientOf(api);

  // The key is refused. Nothing is sent after the sign-in: there is no token to send it with, and
  // a refused sign-in is not tried a second time.
  api.refuseSignIns = true;
  const refused = await apiError(client.start(7n));
  expect(refused.status).toBe(401);
  expect(refused.body).toEqual(refusal("key_not_found"));
  expect(api.challenges).toBe(1);
  expect(api.to("/v1/tasks/7/start")).toHaveLength(0);

  // The next call starts over.
  api.refuseSignIns = false;
  expect(await client.start(7n)).toEqual(STARTED);
  expect(api.challenges).toBe(2);
});

test("reauths_once_on_401", async () => {
  const api = fakeApi();
  serveBoard(api);
  const client = clientOf(api);
  const starts = () => api.to("/v1/tasks/7/start").map((call) => call.headers.get("Authorization"));

  await client.start(7n);
  expect(api.tokens).toEqual(["token-1"]);

  // The API forgets the token, as it does when the key behind it is removed. The call that finds
  // out signs in again and is sent again, and the caller sees only the answer.
  api.revoke("token-1");
  expect(await client.start(7n)).toEqual(STARTED);
  expect(api.challenges).toBe(2);
  expect(starts()).toEqual(["Bearer token-1", "Bearer token-1", "Bearer token-2"]);

  // The new token is kept.
  await client.start(7n);
  expect(api.challenges).toBe(2);
  expect(starts().at(-1)).toBe("Bearer token-2");
});

test("a_second_401_is_thrown_and_the_refused_token_is_dropped", async () => {
  const api = fakeApi();
  api.on(/^POST \/v1\/tasks\/7\/start$/, () => json(UNAUTHORIZED, 401));
  const client = clientOf(api);
  const sentWith = () =>
    api.to("/v1/tasks/7/start").map((call) => call.headers.get("Authorization"));

  const error = await apiError(client.start(7n));
  expect(error.status).toBe(401);
  expect(error.body).toEqual(UNAUTHORIZED);
  // Sent, refused, signed in again, sent once more, refused: and that is all.
  expect(sentWith()).toEqual(["Bearer token-1", "Bearer token-2"]);
  expect(api.challenges).toBe(2);

  // Neither refused token is tried again: the next call signs in first.
  await apiError(client.start(7n));
  expect(sentWith()).toEqual([
    "Bearer token-1",
    "Bearer token-2",
    "Bearer token-3",
    "Bearer token-4",
  ]);
  expect(api.challenges).toBe(4);
});

test("concurrent_refusals_sign_in_once", async () => {
  const api = fakeApi();
  serveBoard(api);
  const client = clientOf(api);
  await client.start(7n);
  api.revoke("token-1");

  // Two calls with the old token, which the API refuses at the same time.
  const bothArrived = deferred();
  let arrived = 0;
  api.on(/^POST \/v1\/tasks\/7\/start$/, async (call) => {
    if (call.headers.get("Authorization") !== "Bearer token-1") return json(STARTED);
    if (++arrived === 2) bothArrived.resolve();
    await bothArrived.promise;
    return json(UNAUTHORIZED, 401);
  });
  const results = await Promise.all([client.start(7n), client.start(7n)]);

  // One new sign-in served both.
  expect(results).toEqual([STARTED, STARTED]);
  expect(api.tokens).toEqual(["token-1", "token-2"]);
  expect(api.challenges).toBe(2);
});

test("a_late_refusal_does_not_drop_the_token_another_call_signed_in_for", async () => {
  const api = fakeApi();
  serveBoard(api);
  const client = clientOf(api);
  await client.start(7n);
  api.revoke("token-1");

  // Two calls with the old token. The API refuses the first one at once; the second is held until
  // the first has signed in again and is refused only then, so it finds the new token in place.
  let refusals = 0;
  api.on(/^POST \/v1\/tasks\/7\/start$/, async (call) => {
    if (call.headers.get("Authorization") !== "Bearer token-1") return json(STARTED);
    if (++refusals === 2) {
      await vi.waitFor(() => expect(api.tokens).toHaveLength(2));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return json(UNAUTHORIZED, 401);
  });
  const results = await Promise.all([client.start(7n), client.start(7n)]);

  expect(results).toEqual([STARTED, STARTED]);
  // One sign-in for both, not one for each.
  expect(api.challenges).toBe(2);
  expect(api.tokens).toEqual(["token-1", "token-2"]);
});

test("no_signer_gives_a_clear_error_and_sends_nothing", async () => {
  const api = fakeApi();
  serveBoard(api);
  const client = new ApiClient({ baseUrl: BASE, fetchImpl: api.fetch });

  const needSigner: Array<[string, () => Promise<unknown>]> = [
    ["signIn", () => client.signIn()],
    ["uploadBlob", () => client.uploadBlob(FILE)],
    ["uploadHeldout", () => client.uploadHeldout(HASH, BLOB)],
    ["start", () => client.start(7n)],
    ["telegramLink", () => client.telegramLink()],
  ];
  for (const [name, call] of needSigner) {
    const error = await rejection(call());
    expect(error, name).toBeInstanceOf(Error);
    expect(error, name).not.toBeInstanceOf(ApiError);
    expect((error as Error).message, name).toMatch(/no signer/);
  }
  expect(api.calls).toHaveLength(0);

  // The public methods need none.
  expect(await client.health()).toEqual(HEALTH);
  expect(await client.getBlob(BLOB_HASH)).toEqual(BLOB);
  expect(api.calls).toHaveLength(2);
});

test("a_malformed_key_fails_when_the_client_is_made", () => {
  const signer = { accountId: ACCOUNT, privateKey: "nonsense" };
  expect(() => new ApiClient({ baseUrl: BASE, signer })).toThrow("Invalid encoded key format");
});

// ---- Answers that are not the good one --------------------------------------------------------

test("null_on_404_and_api_error_otherwise", async () => {
  const lookups: Array<[string, (client: ApiClient) => Promise<unknown>]> = [
    ["getTask", (client) => client.getTask(7n)],
    ["getAgent", (client) => client.getAgent(ACCOUNT)],
    ["getScorecard", (client) => client.getScorecard(3n)],
    ["getBlob", (client) => client.getBlob(BLOB_HASH)],
  ];
  const others: Array<[string, (client: ApiClient) => Promise<unknown>]> = [
    ["listTasks", (client) => client.listTasks()],
    ["listAgents", (client) => client.listAgents()],
    ["listEntries", (client) => client.listEntries(ACCOUNT)],
    ["health", (client) => client.health()],
    ["uploadBlob", (client) => client.uploadBlob(FILE)],
    ["uploadHeldout", (client) => client.uploadHeldout(HASH, BLOB)],
    ["start", (client) => client.start(7n)],
    ["telegramLink", (client) => client.telegramLink()],
  ];
  const answering = (status: number, body: string) => {
    const api = fakeApi();
    api.on(/./, () => new Response(body, { status }));
    return clientOf(api);
  };
  const NOT_FOUND = JSON.stringify({ error: "not_found", message: "no such thing" });

  for (const [name, call] of lookups) {
    expect(await call(answering(404, NOT_FOUND)), name).toBeNull();
    // Nothing but a 404 is null. The error holds what failed: a JSON body parsed, else the text.
    for (const status of [400, 403, 409, 413, 429, 500, 502, 503]) {
      const error = await apiError(call(answering(status, NOT_FOUND)));
      expect(error.status, `${name} ${status}`).toBe(status);
      expect(error.body, `${name} ${status}`).toEqual(JSON.parse(NOT_FOUND));
    }
    const html = await apiError(call(answering(502, "<html>Bad Gateway</html>")));
    expect(html.status, name).toBe(502);
    expect(html.body, name).toBe("<html>Bad Gateway</html>");
  }
  // These have no null to give, so a 404 is an error like any other.
  for (const [name, call] of others) {
    const error = await apiError(call(answering(404, NOT_FOUND)));
    expect(error.status, name).toBe(404);
    expect(error.body, name).toEqual(JSON.parse(NOT_FOUND));
  }
});

test("an_answer_that_does_not_fit_its_schema_is_an_api_error", async () => {
  const api = fakeApi();
  api.on(/^GET \/v1\/tasks\/7$/, () => json({ task: "not a task" }));
  api.on(/^GET \/v1\/tasks$/, () => new Response("not json"));
  const client = clientOf(api);

  const wrong = await apiError(client.getTask(7n));
  expect(wrong.status).toBe(200);
  expect(wrong.message).toContain("does not fit its schema");
  const notJson = await apiError(client.listTasks());
  expect(notJson.status).toBe(200);
  expect(notJson.message).toContain("is not JSON");
});

test("a_429_is_an_api_error_and_is_not_retried", async () => {
  const limited = () => json({ error: "rate_limited", message: "slow down" }, 429);

  // A read.
  const reads = fakeApi();
  reads.on(/./, limited);
  const read = await apiError(clientOf(reads).listTasks());
  expect(read.status).toBe(429);
  expect(read.body).toEqual({ error: "rate_limited", message: "slow down" });
  expect(reads.calls).toHaveLength(1);

  // A call that acts as the account: signed in once, sent once.
  const writes = fakeApi();
  writes.on(/./, limited);
  expect((await apiError(clientOf(writes).start(7n))).status).toBe(429);
  expect(writes.to("/v1/tasks/7/start")).toHaveLength(1);
  expect(writes.challenges).toBe(1);

  // The sign-in itself.
  const signIns = fakeApi();
  signIns.on("POST /v1/auth/challenge", limited);
  expect((await apiError(clientOf(signIns).signIn())).status).toBe(429);
  expect(signIns.calls).toHaveLength(1);
});

interface Failure {
  name: string;
  /** The routes that answer with the secret in the answer. */
  routes: Array<[string, Handler]>;
  call: (client: ApiClient) => Promise<unknown>;
  /** Whether the error holds the answer as its body, and so the secret is in it. */
  holdsAnswer: boolean;
}

test("a_failure_is_never_logged_and_puts_no_answer_in_a_message", async () => {
  // An `ApiError` holds the body of the answer for the caller to read, and for a sign-in that can
  // be the bearer token. The client must not log a body, nor build a message out of one.
  const SECRET = "s3cret-token-that-must-not-be-printed";
  const wrong =
    (status: number, body: string): Handler =>
    () =>
      new Response(body, { status });
  const failures: Failure[] = [
    {
      name: "a sign-in whose answer does not fit",
      routes: [["POST /v1/auth/verify", () => json({ token: SECRET, key_kind: "full_access" })]],
      call: (client) => client.signIn(),
      holdsAnswer: true,
    },
    {
      name: "a sign-in whose answer is not JSON",
      routes: [["POST /v1/auth/verify", wrong(200, `token=${SECRET}`)]],
      call: (client) => client.signIn(),
      holdsAnswer: true,
    },
    {
      name: "a sign-in that is refused",
      routes: [
        ["POST /v1/auth/verify", () => json({ error: "key_not_found", message: SECRET }, 401)],
      ],
      call: (client) => client.signIn(),
      holdsAnswer: true,
    },
    {
      name: "a call as the account, answered with what does not fit",
      routes: [["POST /v1/tasks/7/start", () => json({ ok: true, working_count: SECRET })]],
      call: (client) => client.start(7n),
      holdsAnswer: true,
    },
    {
      name: "a call as the account, answered with a 500",
      routes: [["POST /v1/tasks/7/start", wrong(500, SECRET)]],
      call: (client) => client.start(7n),
      holdsAnswer: true,
    },
    {
      name: "a read, answered with a 502",
      routes: [["GET /v1/tasks", wrong(502, SECRET)]],
      call: (client) => client.listTasks(),
      holdsAnswer: true,
    },
    {
      name: "a blob, answered with a 500",
      routes: [[`GET /v1/blobs/${HASH}`, wrong(500, SECRET)]],
      call: (client) => client.getBlob(HASH),
      holdsAnswer: true,
    },
    {
      name: "a blob whose bytes are not the ones asked for",
      routes: [[`GET /v1/blobs/${HASH}`, wrong(200, SECRET)]],
      call: (client) => client.getBlob(HASH),
      holdsAnswer: false,
    },
  ];
  const logs = (["log", "info", "warn", "error", "debug", "trace"] as const).map((level) =>
    vi.spyOn(console, level),
  );

  for (const { name, routes, call, holdsAnswer } of failures) {
    const api = fakeApi();
    for (const [route, handler] of routes) api.on(route, handler);
    const error = await apiError(call(clientOf(api)));

    expect(error.message, name).not.toContain(SECRET);
    expect(error.stack ?? "", name).not.toContain(SECRET);
    // The caller can still read the answer, so what is checked above is not an empty thing.
    expect(JSON.stringify(error.body).includes(SECRET), name).toBe(holdsAnswer);
  }
  for (const log of logs) expect(log.mock.calls).toEqual([]);
});

// ---- get_blob ---------------------------------------------------------------------------------

test("a_blob_whose_bytes_do_not_hash_to_the_hash_asked_for_throws", async () => {
  const api = fakeApi();
  api.on(`GET /v1/blobs/${BLOB_HASH}`, () => new Response(BLOB));
  api.on(`GET /v1/blobs/${HASH}`, () => new Response(BLOB));
  api.on(`GET /v1/blobs/${sha256Hex(new Uint8Array())}`, () => new Response(new Uint8Array()));
  const client = clientOf(api);

  expect(await client.getBlob(BLOB_HASH)).toEqual(BLOB);
  expect(await client.getBlob(sha256Hex(new Uint8Array()))).toEqual(new Uint8Array());

  // Bytes that are served under a hash they do not have are never handed over.
  const error = await apiError(client.getBlob(HASH));
  expect(error.status).toBe(200);
  expect(error.message).toContain("do not match");
  expect(error.message).toContain(HASH);
  expect(error.message).toContain(BLOB_HASH);
});

// ---- fetch ------------------------------------------------------------------------------------

/** One call of every method, which signs in on the way. */
async function callEveryMethod(client: ApiClient): Promise<void> {
  await client.listTasks();
  await client.getTask(7n);
  await client.listAgents();
  await client.getAgent(ACCOUNT);
  await client.listEntries(ACCOUNT);
  await client.health();
  await client.getScorecard(3n);
  await client.getBlob(BLOB_HASH);
  await client.uploadBlob(FILE);
  await client.uploadHeldout(HASH, BLOB);
  await client.start(7n);
  await client.telegramLink();
  await client.signIn();
}

test("fetch_is_never_called_with_a_foreign_this", async () => {
  // A browser's `fetch` throws "Illegal invocation" when it is called as a method of anything but
  // the window. So a `fetchImpl` that sits on an object is not called through it ...
  const given = fakeApi();
  serveBoard(given);
  const holder = { fetch: given.fetch };
  await callEveryMethod(
    new ApiClient({ baseUrl: BASE, signer: SIGNER, fetchImpl: holder.fetch, now: () => START }),
  );
  expect(given.calls.length).toBeGreaterThan(13);
  expect(given.calls.map((call) => call.self)).toEqual(given.calls.map(() => undefined));

  // ... nor is the global one, which a client without a `fetchImpl` calls.
  const viaGlobal = fakeApi();
  serveBoard(viaGlobal);
  vi.stubGlobal("fetch", viaGlobal.fetch);
  await callEveryMethod(new ApiClient({ baseUrl: BASE, signer: SIGNER, now: () => START }));
  expect(viaGlobal.calls.length).toBeGreaterThan(13);
  expect(viaGlobal.calls.map((call) => call.self)).toEqual(viaGlobal.calls.map(() => undefined));
});

test("the_clock_is_called_as_a_function_of_its_own", async () => {
  const api = fakeApi();
  serveBoard(api);
  const seen: unknown[] = [];
  const holder = {
    now(this: unknown) {
      seen.push(this);
      return START;
    },
  };

  const client = new ApiClient({
    baseUrl: BASE,
    signer: SIGNER,
    fetchImpl: api.fetch,
    now: holder.now,
  });
  // The clock is asked when there is a token to judge: at the second call, not at the first.
  await client.start(7n);
  await client.start(7n);

  expect(seen.length).toBeGreaterThan(0);
  expect(seen).toEqual(seen.map(() => undefined));
});
