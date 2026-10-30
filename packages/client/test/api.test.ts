import { getEventListeners } from "node:events";
import {
  type AccountEntriesResponse,
  type AgentDetailResponse,
  type AgentSummary,
  ApiError,
  type BlobUploadResponse,
  type HealthResponse,
  type ListAgentsResponse,
  type ListTasksResponse,
  MAX_RESULT_BYTES,
  type Scorecard,
  type StartResponse,
  sha256Hex,
  type TaskDetailResponse,
  type TaskSummary,
  type TelegramLinkResponse,
} from "@tender/shared";
import { KeyPair, KeyPairEd25519, type Provider } from "near-api-js";
import * as nearNep413 from "near-api-js/nep413";
import { afterEach, expect, test, vi } from "vitest";
import { ApiClient, type ApiClientOptions, ApiTimeoutError } from "../src/index";

// `ApiClient` over a fake API. The fake's `fetch` notes each call (with the `this` it was called
// with) and answers it from the routes a test gives it. Its sign-in is the real protocol: it
// issues a nonce and names its own base URL as the recipient, and accepts a verify only if the
// recipient is that and the signature holds, which near-api-js checks. That is its own
// NEP-413, not the serializer of `@tender/client` that the client signs with, so the two are held
// against each other. The clock is a field, so that a test can move the time of the
// API and of the client together. The round trip against the real app is
// packages/api/test/apiclient.test.ts.

const BASE = "https://api.test";
/** Whom a sign-in to `BASE` is signed for: the API's own base URL, as it spells it. */
const RECIPIENT = "https://api.test";
const ACCOUNT = "alice.test.near";
const KEY = KeyPair.fromRandom("ed25519");
const SIGNER = { accountId: ACCOUNT, privateKey: KEY.toString() };
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const START = Date.UTC(2026, 9, 30, 12, 0, 0);
const HASH = "ab".repeat(32);
const U64_MAX = 2n ** 64n - 1n;

afterEach(() => {
  vi.useRealTimers();
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
  /** What the request said to do with a redirect: `fetch` follows one unless it is told not to. */
  redirect: RequestRedirect | undefined;
  /** The signal that cancels the request: the client gives each its own. */
  signal: AbortSignal | undefined;
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
 * names `recipient` in its challenges, takes a sign-in for that only, and hands
 * out `token-1`, `token-2` and so on, each good for 12 hours from `clock.now`. Any other
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
      recipient: api.recipient,
      expires_at: new Date(api.clock.now + 5 * MINUTE).toISOString(),
      ...api.tamper?.(api.challenges),
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
    // As the real API does: only a signature for its own base URL is taken.
    if (body.recipient !== api.recipient) return json(refusal("wrong_recipient"), 401);
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
    /** Whom the fake names in its challenges and holds a sign-in to: its own base URL. */
    recipient: RECIPIENT,
    challenges: 0,
    verifies: 0,
    /** Answers every verify with a 401. */
    refuseSignIns: false,
    /** Runs when a challenge is asked for, before it is answered. */
    beforeChallenge: undefined as (() => Promise<void>) | undefined,
    /** Fields to put in place of the ones of the `count`th challenge, as a server of its own would. */
    tamper: undefined as ((count: number) => Record<string, unknown> | undefined) | undefined,
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
      redirect: init?.redirect,
      signal: init?.signal ?? undefined,
    };
    api.calls.push(call);
    const route = `${call.method} ${call.url.pathname}`;
    // A route a test names exactly is its own, a sign-in route too; a pattern is not.
    const named = routes.find(([match]) => match === route);
    if (named) return await named[1](call);
    // The sign-in is the fake's own wherever the API is mounted: the path may have a prefix.
    const signIn = /^POST .*(\/v1\/auth\/(?:challenge|verify))$/.exec(route)?.[1];
    if (signIn === "/v1/auth/challenge") return await challenge();
    if (signIn === "/v1/auth/verify") return await verify(call);
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

/**
 * A client of `api` that signs in as `ACCOUNT` and tells the time by the fake's clock, with the
 * options of `over` laid over those.
 */
function clientOf(api: FakeApi, over: Partial<ApiClientOptions> = {}): ApiClient {
  return new ApiClient({
    baseUrl: BASE,
    signer: SIGNER,
    fetchImpl: api.fetch,
    now: () => api.clock.now,
    ...over,
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

/** What `fn` threw: the test fails if it returned. */
function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw, and it returned");
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

test("the_base_url_is_normalized", async () => {
  // The client adds `/v1`, so a base that has it, or a slash, or both, is the same base.
  const cases: Array<[string, string]> = [
    ["https://api.test", "https://api.test/v1/health"],
    ["https://api.test/", "https://api.test/v1/health"],
    ["https://api.test//", "https://api.test/v1/health"],
    ["https://api.test/v1", "https://api.test/v1/health"],
    ["https://api.test/v1/", "https://api.test/v1/health"],
    ["http://localhost:8787/v1", "http://localhost:8787/v1/health"],
    // A path the API is mounted under is kept.
    ["https://api.test/tender", "https://api.test/tender/v1/health"],
    ["https://api.test/tender/v1/", "https://api.test/tender/v1/health"],
    // Only a whole last segment is `/v1`, and the host is not a segment.
    ["https://api.test/v10", "https://api.test/v10/v1/health"],
    ["https://api.test/xv1", "https://api.test/xv1/v1/health"],
    ["https://v1", "https://v1/v1/health"],
  ];
  for (const [baseUrl, expected] of cases) {
    const api = fakeApi();
    // Whatever the path in front of it, the answer is a good one: it is the request that is checked.
    api.on(/^GET .*\/health$/, () => json(HEALTH));
    await new ApiClient({ baseUrl, fetchImpl: api.fetch }).health();
    expect(nth(api.calls, 0).url.href, baseUrl).toBe(expected);
  }

  // A client that signs in goes to the same places, the sign-in included.
  const api = fakeApi();
  serveBoard(api);
  await new ApiClient({ baseUrl: `${BASE}/v1/`, signer: SIGNER, fetchImpl: api.fetch }).start(7n);
  expect(api.calls.map((call) => call.url.pathname)).toEqual([
    "/v1/auth/challenge",
    "/v1/auth/verify",
    "/v1/tasks/7/start",
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
  // Whom it is signed for is the API's own base URL, which is `BASE`.
  expect(sent.recipient).toBe(RECIPIENT);

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

// ---- Who the key signs for --------------------------------------------------------------------

/** What the client says when it refuses a challenge: the field, and nothing the server sent. */
const REFUSED = {
  message:
    "refusing to sign the API's sign-in challenge: its message is not that of a Tender sign-in",
  recipient:
    "refusing to sign the API's sign-in challenge: its recipient is not this client's baseUrl",
  nonce: "refusing to sign the API's sign-in challenge: its nonce is not that of a Tender sign-in",
};

test("only_a_challenge_that_is_this_apis_own_is_signed", async () => {
  // The server at `baseUrl` chooses the message, the recipient and the nonce, and the key signs
  // them. Unless they are those of a sign-in to this API, it must not get a signature of its own
  // choosing. The signature is watched: a refusal has to come before it.
  const sign = vi.spyOn(KeyPairEd25519.prototype, "sign");
  const bytes = (length: number) => Buffer.alloc(length, 1).toString("base64");
  const wrong: Array<[string, Record<string, string>, keyof typeof REFUSED]> = [
    // The recipient is `BASE`, spelled as the API spells it: `https://api.test`.
    ["another API", { recipient: "https://evil.test" }, "recipient"],
    ["the recipient every API used to have", { recipient: "tender" }, "recipient"],
    ["the host alone", { recipient: "api.test" }, "recipient"],
    ["the base in capitals", { recipient: "https://API.TEST" }, "recipient"],
    ["the base with a space", { recipient: "https://api.test " }, "recipient"],
    ["the base with a trailing slash", { recipient: "https://api.test/" }, "recipient"],
    [
      "the base with a port the URL does not have",
      { recipient: "https://api.test:8443" },
      "recipient",
    ],
    ["the base over http", { recipient: "http://api.test" }, "recipient"],
    ["the base with the version it sits under", { recipient: "https://api.test/v1" }, "recipient"],
    ["a path on the same host", { recipient: "https://api.test/other" }, "recipient"],
    ["a host that ends with it", { recipient: "https://evil.api.test" }, "recipient"],
    ["a host that starts with it", { recipient: "https://api.test.evil.example" }, "recipient"],
    ["the base with something in front", { recipient: "xhttps://api.test" }, "recipient"],
    [
      "the base after another address",
      { recipient: "https://evil.test/https://api.test" },
      "recipient",
    ],
    ["no recipient", { recipient: "" }, "recipient"],
    ["another message", { message: "Send 1000 NEAR to evil.near" }, "message"],
    ["the message in other letters", { message: "sign in to tender" }, "message"],
    ["the message with a space", { message: "Sign in to Tender " }, "message"],
    ["no message", { message: "" }, "message"],
    ["a nonce of 31 bytes", { nonce: bytes(31) }, "nonce"],
    ["a nonce of 33 bytes", { nonce: bytes(33) }, "nonce"],
    ["a nonce without its padding", { nonce: bytes(32).replace(/=+$/, "") }, "nonce"],
    ["a nonce in base64url", { nonce: `${"-".repeat(43)}=` }, "nonce"],
    ["a nonce with a space", { nonce: ` ${"A".repeat(42)}=` }, "nonce"],
    [
      "a nonce in a spelling of the bytes that is not the one",
      { nonce: `${"A".repeat(42)}B=` },
      "nonce",
    ],
    ["no nonce", { nonce: "" }, "nonce"],
  ];

  for (const [name, fields, field] of wrong) {
    const api = fakeApi();
    serveBoard(api);
    api.tamper = () => fields;

    // Through a call that acts as the account, so that nothing is sent after the refusal either.
    const error = await rejection(clientOf(api).start(7n));
    expect(error, name).toBeInstanceOf(Error);
    expect(error, name).not.toBeInstanceOf(ApiError);
    // It names the field, and none of what the server put in it.
    expect((error as Error).message, name).toBe(REFUSED[field]);
    expect(api.verifies, name).toBe(0);
    expect(api.to("/v1/tasks/7/start"), name).toHaveLength(0);
  }
  expect(sign).not.toHaveBeenCalled();

  // A challenge for this API is signed by the same client: the watch sees it.
  const api = fakeApi();
  serveBoard(api);
  expect(await clientOf(api).signIn()).toBe("token-1");
  expect(sign).toHaveBeenCalledTimes(1);
});

test("a_refused_challenge_leaves_nothing_behind", async () => {
  const api = fakeApi();
  serveBoard(api);
  // The first challenge is not Tender's, and the second is.
  api.tamper = (count) => (count === 1 ? { recipient: "evil.near" } : undefined);
  const client = clientOf(api);

  await rejection(client.signIn());
  expect(await client.signIn()).toBe("token-1");
  expect(api.challenges).toBe(2);
});

test("a_challenge_relayed_from_another_api_is_not_signed", async () => {
  // A server that is not the API asks the real API for a challenge and passes it on. Its message
  // and nonce are good, and its recipient is the real API's base URL. If the client signed it, the
  // server could present the signature to the real API as the client's own sign-in.
  const sign = vi.spyOn(KeyPairEd25519.prototype, "sign");
  const real = fakeApi();
  const relayed = () => real.fetch(`${BASE}/v1/auth/challenge`, { method: "POST" });
  const clientAt = (baseUrl: string, via: FakeApi) =>
    new ApiClient({ baseUrl, signer: SIGNER, fetchImpl: via.fetch, now: () => real.clock.now });

  // Passed on as it comes, it names the real API, and this client called another host.
  const passive = fakeApi();
  passive.on("POST /v1/auth/challenge", relayed);
  const error = await rejection(clientAt("https://evil.test", passive).start(7n));
  expect(error).not.toBeInstanceOf(ApiError);
  expect((error as Error).message).toBe(REFUSED.recipient);
  expect(sign).not.toHaveBeenCalled();
  expect(real.challenges).toBe(1);
  expect(real.verifies).toBe(0);
  expect(passive.verifies).toBe(0);
  expect(passive.to("/v1/tasks/7/start")).toHaveLength(0);

  // Naming itself instead, the server gets the client to sign for the server's own base URL. The
  // real API takes a signature for its own base URL only, so what the server passes on to it is
  // refused, and no token is made.
  const active = fakeApi();
  active.on("POST /v1/auth/challenge", async () => {
    const challenge = await (await relayed()).json();
    return json({ ...challenge, recipient: "https://evil.test" });
  });
  active.on("POST /v1/auth/verify", (call) =>
    real.fetch(`${BASE}/v1/auth/verify`, { method: "POST", body: call.body }),
  );
  const refused = await apiError(clientAt("https://evil.test", active).start(7n));
  expect(refused.status).toBe(401);
  expect(refused.body).toEqual(refusal("wrong_recipient"));
  expect(sign).toHaveBeenCalledTimes(1);
  expect(real.verifies).toBe(1);
  expect(real.tokens).toEqual([]);
});

test("a_challenge_of_another_path_on_the_same_host_is_not_signed", async () => {
  // Two APIs can be served under paths of one host. The one at /other is relayed to a client of
  // the one at /tender: the host is the same, and the base URL is not.
  const sign = vi.spyOn(KeyPairEd25519.prototype, "sign");
  const clientAt = (baseUrl: string, api: FakeApi) =>
    new ApiClient({ baseUrl, signer: SIGNER, fetchImpl: api.fetch, now: () => api.clock.now });

  for (const baseUrl of ["https://host.example/tender", "https://host.example/tender/v1/"]) {
    const relayed = fakeApi();
    relayed.recipient = "https://host.example/other";
    const error = await rejection(clientAt(baseUrl, relayed).signIn());
    expect(error, baseUrl).not.toBeInstanceOf(ApiError);
    expect((error as Error).message, baseUrl).toBe(REFUSED.recipient);
    expect(relayed.verifies, baseUrl).toBe(0);
    expect(sign).not.toHaveBeenCalled();

    // The challenge of the API at this path is signed, and so is the same one under the version.
    const own = fakeApi();
    own.recipient = "https://host.example/tender";
    expect(await clientAt(baseUrl, own).signIn(), baseUrl).toBe("token-1");
    const verify = own.calls.find((call) => call.url.pathname.endsWith("/auth/verify"));
    expect(verify?.url.pathname, baseUrl).toBe("/tender/v1/auth/verify");
    expect(JSON.parse(verify?.body ?? "null").recipient, baseUrl).toBe(own.recipient);
    sign.mockClear();
  }
});

test("the_recipient_is_the_base_url", async () => {
  // Whom the API names, for the URL a client calls it at: the scheme and host in lower case, the
  // port only if it is not the default of the scheme, and the path without a trailing slash or a
  // final /v1. Nothing else of the URL is part of it.
  const named: Array<[string, string]> = [
    ["https://api.test", "https://api.test"],
    ["https://api.test/v1/", "https://api.test"],
    ["https://API.Test", "https://api.test"],
    ["https://api.test:443", "https://api.test"],
    ["https://api.test:8443/tender", "https://api.test:8443/tender"],
    ["https://host.example/tender/v1", "https://host.example/tender"],
    ["https://someone:secret@api.test", "https://api.test"],
    ["http://localhost", "http://localhost"],
    ["http://localhost:8787", "http://localhost:8787"],
    ["HTTP://LOCALHOST:80", "http://localhost"],
    ["http://127.0.0.1:3000/v1", "http://127.0.0.1:3000"],
    ["http://[::1]:8787", "http://[::1]:8787"],
    ["https://bücher.example", "https://xn--bcher-kva.example"],
  ];
  const clientAt = (baseUrl: string, api: FakeApi) =>
    new ApiClient({ baseUrl, signer: SIGNER, fetchImpl: api.fetch, now: () => api.clock.now });

  for (const [baseUrl, recipient] of named) {
    const api = fakeApi();
    api.recipient = recipient;
    expect(await clientAt(baseUrl, api).signIn(), baseUrl).toBe("token-1");
    // What was signed, and sent, is that.
    const verify = api.calls.find((call) => call.url.pathname.endsWith("/auth/verify"));
    expect(JSON.parse(verify?.body ?? "null").recipient, baseUrl).toBe(recipient);
  }

  // Any other spelling is refused, with nothing signed: not the wrong port, nor the default one
  // written out, nor capitals, nor a path that is not the base's, nor a host where a base belongs.
  const sign = vi.spyOn(KeyPairEd25519.prototype, "sign");
  const other: Array<[string, string]> = [
    ["https://api.test:8443/tender", "https://api.test"],
    ["https://api.test:8443", "https://api.test:8444"],
    ["https://api.test", "https://api.test:443"],
    ["https://api.test/tender", "https://api.test"],
    ["https://api.test", "https://api.test/tender"],
    ["https://api.test", "https://api.test/"],
    ["https://api.test", "https://api.test/v1"],
    ["https://api.test", "api.test"],
    ["https://api.test", "http://api.test"],
    ["https://api.test", "https://api.test."],
    ["https://API.Test", "https://API.Test"],
    ["http://localhost:8787", "http://localhost"],
    ["http://[::1]:8787", "http://[::1]"],
  ];
  for (const [baseUrl, recipient] of other) {
    const api = fakeApi();
    api.recipient = recipient;
    const error = await rejection(clientAt(baseUrl, api).signIn());
    expect((error as Error).message, `${baseUrl} named as ${recipient}`).toBe(REFUSED.recipient);
    expect(api.verifies, `${baseUrl} named as ${recipient}`).toBe(0);
  }
  expect(sign).not.toHaveBeenCalled();
});

test("a_signer_needs_https_unless_the_host_is_this_machine", async () => {
  const refused = [
    "http://example.com",
    "http://api.test:8787",
    "http://192.168.1.10:8787",
    "http://0.0.0.0:8787",
    "http://[::ffff:127.0.0.1]:8787",
    // Names that start or end like a local one, or hide it in the user, the path or the query.
    "http://localhost.example.com",
    "http://127.0.0.1.example.com",
    "http://notlocalhost",
    "http://localhost@example.com",
    "http://example.com/localhost",
    "http://example.com/?127.0.0.1",
    // Local, but not http.
    "ftp://localhost",
    "ws://127.0.0.1:8787",
    // Not an absolute URL.
    "localhost:8787",
    "api.example",
    "",
  ];
  const accepted = [
    "https://api.example",
    "https://api.example/v1/",
    "https://api.example:8443/tender",
    "https://localhost:8787",
    "http://localhost",
    "http://localhost:8787",
    "http://127.0.0.1:3000",
    "http://[::1]:8787",
    "HTTP://LOCALHOST:8787",
  ];

  for (const baseUrl of refused) {
    const error = thrown(() => new ApiClient({ baseUrl, signer: SIGNER }));
    expect(error, baseUrl).toBeInstanceOf(Error);
    expect((error as Error).message, baseUrl).toMatch(/baseUrl/);
  }
  for (const baseUrl of accepted) {
    expect(() => new ApiClient({ baseUrl, signer: SIGNER }), baseUrl).not.toThrow();
  }
  // The message does not quote the URL, which can hold a password.
  const quoted = thrown(
    () => new ApiClient({ baseUrl: "http://user:hunter2@example.com", signer: SIGNER }),
  );
  expect((quoted as Error).message).not.toContain("hunter2");

  // Without a signer nothing secret is sent, and the public reads go over plain http.
  const api = fakeApi();
  serveBoard(api);
  const open = new ApiClient({ baseUrl: "http://example.com", fetchImpl: api.fetch });
  expect(await open.health()).toEqual(HEALTH);
  expect(nth(api.calls, 0).url.href).toBe("http://example.com/v1/health");
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

const CHUNK = 16_384;
/** More than a client that does not stop at the cap would read. */
const GOES_ON = 4 * MAX_RESULT_BYTES;

/**
 * A body of `total` bytes of zeroes in chunks of 16 KiB, and then it ends. `seen` says how many
 * were pulled out of it and whether the reader cancelled it. A client that does not stop at the
 * cap reads all of `total`.
 */
function zeroes(total: number) {
  const seen = { pulled: 0, cancelled: false };
  const chunk = new Uint8Array(CHUNK);
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const size = Math.min(CHUNK, total - seen.pulled);
      if (size <= 0) {
        controller.close();
        return;
      }
      seen.pulled += size;
      controller.enqueue(chunk.subarray(0, size));
    },
    cancel() {
      seen.cancelled = true;
    },
  });
  return { body, seen };
}

test("a_blob_of_the_most_the_api_stores_is_read_however_it_comes", async () => {
  const api = fakeApi();
  const client = clientOf(api);
  const bytes = Uint8Array.from({ length: MAX_RESULT_BYTES }, (_, i) => (i * 5 + 1) % 256);
  const hash = sha256Hex(bytes);
  const inPieces = () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let at = 0; at < bytes.length; at += 10_000) {
          controller.enqueue(bytes.slice(at, at + 10_000));
        }
        controller.close();
      },
    });

  // In one piece, with its length declared, and in pieces with none: the cap itself is allowed.
  const answers = [
    () => new Response(bytes),
    () => new Response(bytes, { headers: { "Content-Length": String(bytes.length) } }),
    () => new Response(inPieces()),
  ];
  for (const answer of answers) {
    api.on(`GET /v1/blobs/${hash}`, answer);
    const got = await client.getBlob(hash);
    // Compared natively: `toEqual` takes a third of a second on this many bytes, and three of those
    // run past the test timeout on a busy machine.
    expect(got?.length).toBe(bytes.length);
    expect(got && Buffer.compare(got, bytes)).toBe(0);
  }

  // An answer with no body at all is an empty blob.
  const empty = sha256Hex(new Uint8Array());
  api.on(`GET /v1/blobs/${empty}`, () => new Response(null));
  expect(await client.getBlob(empty)).toEqual(new Uint8Array());
});

test("a_blob_over_the_cap_is_refused_and_not_read_to_its_end", async () => {
  const api = fakeApi();
  const client = clientOf(api);
  const tooBig = `the blob ${HASH} is larger than the API allows, which is ${MAX_RESULT_BYTES} bytes`;
  const refused = (answer: () => Response) => {
    api.on(`GET /v1/blobs/${HASH}`, answer);
    return apiError(client.getBlob(HASH));
  };

  // One byte over the cap.
  const one = await refused(() => new Response(new Uint8Array(MAX_RESULT_BYTES + 1)));
  expect(one.status).toBe(200);
  expect(one.message).toBe(tooBig);

  // A body that goes on, with no length declared: given up on once it passes the cap, and cancelled.
  const endless = zeroes(GOES_ON);
  expect((await refused(() => new Response(endless.body))).message).toBe(tooBig);
  expect(endless.seen.cancelled).toBe(true);
  expect(endless.seen.pulled).toBeLessThan(2 * MAX_RESULT_BYTES);

  // A length declared over the cap: refused before the body is read. The stream has been started
  // on, one chunk ahead of anyone reading it, and no more.
  const declared = zeroes(GOES_ON);
  const headers = { "Content-Length": String(MAX_RESULT_BYTES + 1) };
  expect((await refused(() => new Response(declared.body, { headers }))).message).toBe(tooBig);
  expect(declared.seen.cancelled).toBe(true);
  expect(declared.seen.pulled).toBeLessThanOrEqual(2 * CHUNK);

  // A length that lies: what is read decides, and not what the header says.
  const lying = zeroes(GOES_ON);
  const small = { "Content-Length": "10" };
  expect((await refused(() => new Response(lying.body, { headers: small }))).message).toBe(tooBig);
  expect(lying.seen.cancelled).toBe(true);
  expect(lying.seen.pulled).toBeLessThan(2 * MAX_RESULT_BYTES);

  // An answer that is an error is read up to the cap too, and keeps its status.
  const failing = zeroes(GOES_ON);
  const error = await refused(() => new Response(failing.body, { status: 500 }));
  expect(error.status).toBe(500);
  expect(error.message).toBe(tooBig);
  expect(failing.seen.cancelled).toBe(true);
  expect(failing.seen.pulled).toBeLessThan(2 * MAX_RESULT_BYTES);
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

test("every_request_refuses_a_redirect", async () => {
  // The API never redirects. A server at `baseUrl` that does would, if `fetch` followed it, send
  // what a request holds (the signature of a sign-in, a brief, the bearer token) to a place of its
  // choosing, and `fetch` follows unless it is told not to. What a redirect then comes to is
  // shown against real servers in redirects.test.ts; here it is every request that is told.
  const api = fakeApi();
  serveBoard(api);
  await callEveryMethod(clientOf(api));

  expect(api.calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
    "GET /v1/tasks",
    "GET /v1/tasks/7",
    "GET /v1/agents",
    `GET /v1/agents/${ACCOUNT}`,
    "GET /v1/entries",
    "GET /v1/health",
    "GET /v1/scorecards/3",
    `GET /v1/blobs/${BLOB_HASH}`,
    "POST /v1/auth/challenge",
    "POST /v1/auth/verify",
    "POST /v1/blobs",
    "POST /v1/heldout",
    "POST /v1/tasks/7/start",
    "POST /v1/telegram/link",
  ]);
  expect(api.calls.map((call) => call.redirect)).toEqual(api.calls.map(() => "error"));
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

// ---- Timeouts ---------------------------------------------------------------------------------

// What a request that is not answered comes to. The stand-in answers nothing, and does not look at
// the signal it is given either, as a `fetch` of someone else's might not: the caller is let go
// of by the client, not by the stand-in. The clock of `setTimeout` is the test's, so that none of
// this waits, or depends on how busy the machine is. (Against a real server and a real `fetch`
// it is timeouts.test.ts.)

/** An answer that never comes. */
const unanswered = () => new Promise<Response>(() => undefined);

/** Every request but the two of the sign-in. */
const NOT_THE_SIGN_IN = /^(?:GET|POST) \/v1\/(?!auth\/)/;

function fakeTimers(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
}

/**
 * The milliseconds on the clock of `setTimeout` that it takes for `promise` to settle, which are
 * moved a millisecond at a time: the work that comes before (a sign-in) runs between the steps.
 * It fails if `promise` is still not settled after `limit` of them.
 */
async function msUntilSettled(promise: Promise<unknown>, limit: number): Promise<number> {
  let settled = false;
  const note = () => {
    settled = true;
  };
  promise.then(note, note);
  let elapsed = 0;
  while (!settled && elapsed < limit) {
    await vi.advanceTimersByTimeAsync(1);
    elapsed++;
  }
  if (!settled) throw new Error(`the call was still out after ${limit} ms`);
  return elapsed;
}

/** Every call of the client that sends a request of its own, by the name of its method. */
const CALLS: Array<[string, (client: ApiClient) => Promise<unknown>]> = [
  ["listTasks", (client) => client.listTasks()],
  ["getTask", (client) => client.getTask(7n)],
  ["listAgents", (client) => client.listAgents()],
  ["getAgent", (client) => client.getAgent(ACCOUNT)],
  ["listEntries", (client) => client.listEntries(ACCOUNT)],
  ["health", (client) => client.health()],
  ["getScorecard", (client) => client.getScorecard(3n)],
  ["getBlob", (client) => client.getBlob(BLOB_HASH)],
  ["uploadBlob", (client) => client.uploadBlob(FILE)],
  ["uploadHeldout", (client) => client.uploadHeldout(HASH, BLOB)],
  ["start", (client) => client.start(7n)],
  ["telegramLink", (client) => client.telegramLink()],
];

test("every_request_gives_up_when_its_time_is_out_and_the_error_names_the_method", async () => {
  fakeTimers();
  const timeoutMs = 50;
  for (const [name, call] of CALLS) {
    const api = fakeApi();
    api.on(NOT_THE_SIGN_IN, unanswered);

    const outcome = rejection(call(clientOf(api, { timeoutMs })));
    const took = await msUntilSettled(outcome, 10 * timeoutMs);
    const error = await outcome;

    // It was the method's own request that never came, after a sign-in that went through, and the
    // time it took is the time it was given: the sign-in takes none of it.
    expect(error, name).toBeInstanceOf(ApiTimeoutError);
    expect(error, name).not.toBeInstanceOf(ApiError);
    expect((error as Error).message, name).toBe(`ApiClient.${name} timed out after 50 ms`);
    expect((error as ApiTimeoutError).name, name).toBe("ApiTimeoutError");
    expect((error as ApiTimeoutError).method, name).toBe(name);
    expect((error as ApiTimeoutError).timeoutMs, name).toBe(timeoutMs);
    expect(took, name).toBeGreaterThanOrEqual(timeoutMs);
    expect(took, name).toBeLessThan(timeoutMs + 20);
    const sent = api.calls.filter((sent) => !sent.url.pathname.includes("/auth/"));
    expect(sent, name).toHaveLength(1);
  }
});

test("a_sign_in_that_never_comes_is_a_timeout_of_the_sign_in", async () => {
  fakeTimers();
  for (const route of ["POST /v1/auth/challenge", "POST /v1/auth/verify"]) {
    const api = fakeApi();
    api.on(route, unanswered);

    const outcome = rejection(clientOf(api, { timeoutMs: 50 }).start(7n));
    await msUntilSettled(outcome, 500);
    const error = await outcome;

    expect(error, route).toBeInstanceOf(ApiTimeoutError);
    expect((error as Error).message, route).toBe("ApiClient.signIn timed out after 50 ms");
    // The call itself was not sent, as it had no token to send.
    expect(api.to("/v1/tasks/7/start"), route).toHaveLength(0);
  }
});

test("calls_that_wait_for_a_sign_in_that_never_comes_all_fail_with_it", async () => {
  fakeTimers();
  const api = fakeApi();
  serveBoard(api);
  // The first challenge is never answered, and the ones after it are.
  let asked = 0;
  api.beforeChallenge = () =>
    ++asked === 1 ? new Promise<void>(() => undefined) : Promise.resolve();
  const client = clientOf(api, { timeoutMs: 1_000 });

  const calls = [client.start(7n), client.telegramLink(), client.uploadBlob(FILE)].map(rejection);
  await vi.advanceTimersByTimeAsync(1_000);
  for (const error of await Promise.all(calls)) {
    expect(error).toBeInstanceOf(ApiTimeoutError);
    expect((error as Error).message).toBe("ApiClient.signIn timed out after 1000 ms");
  }
  // They shared the one sign-in, and so the one request that was out of time.
  expect(api.challenges).toBe(1);

  // Nothing of it stuck: the next call signs in again, and goes through.
  expect(await client.start(7n)).toEqual(STARTED);
  expect(api.challenges).toBe(2);
});

test("the_time_is_30_seconds_unless_it_is_set", async () => {
  fakeTimers();
  const api = fakeApi();
  api.on("GET /v1/health", unanswered);

  let settled = false;
  const outcome = rejection(clientOf(api).health());
  outcome.then(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(29_999);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(settled).toBe(true);
  const error = (await outcome) as ApiTimeoutError;
  expect(error).toBeInstanceOf(ApiTimeoutError);
  expect(error.message).toBe("ApiClient.health timed out after 30000 ms");
  expect(error.timeoutMs).toBe(30_000);

  // A time that is set is the time the request has.
  settled = false;
  const patient = rejection(clientOf(api, { timeoutMs: 5_000 }).health());
  patient.then(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(4_999);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(settled).toBe(true);
  expect(((await patient) as Error).message).toBe("ApiClient.health timed out after 5000 ms");
});

test("a_request_that_is_answered_in_time_is_answered", async () => {
  fakeTimers();
  const api = fakeApi();
  // The answers come after a wait on the same clock: the first 49 ms into the 50 a request has,
  // the second 51 ms in.
  const waits = [49, 51];
  api.on(
    "GET /v1/health",
    () =>
      new Promise<Response>((resolve) => {
        setTimeout(() => resolve(json(HEALTH)), waits.shift());
      }),
  );
  const client = clientOf(api, { timeoutMs: 50 });

  const early = client.health();
  await vi.advanceTimersByTimeAsync(49);
  expect(await early).toEqual(HEALTH);
  expect(vi.getTimerCount()).toBe(0);

  const late = rejection(client.health());
  await vi.advanceTimersByTimeAsync(50);
  expect(await late).toBeInstanceOf(ApiTimeoutError);
});

test("a_request_is_told_to_stop_when_its_time_is_out", async () => {
  fakeTimers();
  const api = fakeApi();
  // A stand-in that does look at its signal: it fails with the reason the signal aborts with, as
  // `fetch` does.
  api.on(
    "GET /v1/health",
    (call) =>
      new Promise<Response>((_, reject) => {
        call.signal?.addEventListener("abort", () => reject(call.signal?.reason), { once: true });
      }),
  );

  const outcome = rejection(clientOf(api, { timeoutMs: 1_000 }).health());
  await vi.advanceTimersByTimeAsync(1_000);
  const error = await outcome;

  expect(error).toBeInstanceOf(ApiTimeoutError);
  const call = nth(api.to("/v1/health"), 0);
  expect(call.signal?.aborted).toBe(true);
  expect(call.signal?.reason).toBe(error);
});

test("every_request_has_a_signal_of_its_own_and_an_answered_one_is_not_aborted", async () => {
  const api = fakeApi();
  serveBoard(api);
  await callEveryMethod(clientOf(api));

  const signals = api.calls.map((call) => call.signal);
  expect(api.calls).toHaveLength(14);
  for (const signal of signals) expect(signal).toBeInstanceOf(AbortSignal);
  expect(new Set(signals).size).toBe(signals.length);
  // A request that was answered is not cancelled afterwards, and nothing is left listening to it.
  expect(signals.map((signal) => signal?.aborted)).toEqual(signals.map(() => false));
  for (const signal of signals) {
    expect(signal && getEventListeners(signal, "abort")).toHaveLength(0);
  }
});

test("no_timer_is_left_behind_however_a_request_ends", async () => {
  fakeTimers();
  const api = fakeApi();
  serveBoard(api);
  const client = clientOf(api);

  await callEveryMethod(client);
  expect(vi.getTimerCount(), "after answers").toBe(0);

  api.on(/^GET \/v1\/tasks$/, () => json(UNAUTHORIZED, 401));
  await rejection(client.listTasks());
  expect(vi.getTimerCount(), "after an error status").toBe(0);

  api.on("GET /v1/health", () => {
    throw new Error("the network is down");
  });
  await rejection(client.health());
  expect(vi.getTimerCount(), "after a fetch that fails").toBe(0);

  api.on("GET /v1/entries", unanswered);
  const outcome = rejection(client.listEntries(ACCOUNT));
  await vi.advanceTimersByTimeAsync(30_000);
  expect(await outcome).toBeInstanceOf(ApiTimeoutError);
  expect(vi.getTimerCount(), "after a timeout").toBe(0);
});

test("a_request_sent_again_after_a_401_has_a_time_of_its_own", async () => {
  fakeTimers();
  const api = fakeApi();
  // The first request is refused, as a token that was revoked is, and the one sent after the new
  // sign-in is not answered.
  let sent = 0;
  api.on(/^POST \/v1\/tasks\/\d+\/start$/, () =>
    ++sent === 1 ? json(UNAUTHORIZED, 401) : new Promise<Response>(() => undefined),
  );
  const outcome = rejection(clientOf(api, { timeoutMs: 50 }).start(7n));
  await msUntilSettled(outcome, 500);
  const error = await outcome;

  expect(error).toBeInstanceOf(ApiTimeoutError);
  expect((error as Error).message).toBe("ApiClient.start timed out after 50 ms");
  expect(api.to("/v1/tasks/7/start")).toHaveLength(2);
  expect(api.challenges).toBe(2);
});

test("a_request_that_is_out_of_time_is_not_sent_again_and_the_token_stays", async () => {
  fakeTimers();
  const api = fakeApi();
  serveBoard(api);
  let hang = true;
  api.on(
    /^POST \/v1\/tasks\/\d+\/start$/,
    api.signedIn(() => (hang ? unanswered() : json(STARTED))),
  );
  const client = clientOf(api, { timeoutMs: 50 });

  const outcome = rejection(client.start(7n));
  await msUntilSettled(outcome, 500);
  expect(await outcome).toBeInstanceOf(ApiTimeoutError);
  // Sent once, on the one token: a timeout is no 401, and the request is not sent again.
  expect(api.to("/v1/tasks/7/start")).toHaveLength(1);
  expect(api.tokens).toEqual(["token-1"]);

  // The token is still the client's: the next call is sent on it, with no sign-in.
  hang = false;
  expect(await client.start(7n)).toEqual(STARTED);
  expect(api.tokens).toEqual(["token-1"]);
  expect(api.challenges).toBe(1);
  expect(api.to("/v1/tasks/7/start")).toHaveLength(2);
});

test("an_answer_that_comes_after_the_time_is_out_is_dropped", async () => {
  fakeTimers();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const api = fakeApi();
    const late = deferred();
    // A stand-in that goes on after the time is out, and fails then: nothing is left to hear it.
    api.on("GET /v1/health", async () => {
      await late.promise;
      throw new Error("the connection was reset");
    });
    const outcome = rejection(clientOf(api, { timeoutMs: 50 }).health());
    await vi.advanceTimersByTimeAsync(50);
    expect(await outcome).toBeInstanceOf(ApiTimeoutError);

    late.resolve();
    // Unhandled rejections are reported when the turn is over, which is a real one.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  expect(unhandled).toEqual([]);
});

test("the_signal_of_the_client_ends_a_call_with_its_own_reason", async () => {
  fakeTimers();
  const reason = new Error("shutting down");

  // Already aborted: nothing is sent, and nothing is started that has to be put away.
  const before = fakeApi();
  serveBoard(before);
  const refused = await rejection(clientOf(before, { signal: AbortSignal.abort(reason) }).health());
  expect(refused).toBe(reason);
  expect(before.calls).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);

  // Aborted while a request is waiting: the call fails with that reason, which is no timeout, the
  // request is told to stop, and nothing is left running.
  const api = fakeApi();
  api.on("GET /v1/health", unanswered);
  const stopped = new AbortController();
  const outcome = rejection(clientOf(api, { signal: stopped.signal, timeoutMs: 60_000 }).health());
  await vi.advanceTimersByTimeAsync(10);
  expect(api.calls).toHaveLength(1);
  stopped.abort(reason);
  expect(await outcome).toBe(reason);
  expect(nth(api.calls, 0).signal?.aborted).toBe(true);
  expect(nth(api.calls, 0).signal?.reason).toBe(reason);
  expect(vi.getTimerCount()).toBe(0);

  // A client that has seen its signal abort refuses what it is asked after.
  const later = await rejection(clientOf(api, { signal: stopped.signal }).health());
  expect(later).toBe(reason);
  expect(api.calls).toHaveLength(1);

  // A token that is held does not get a call past it: the client has been told to stop.
  const held = fakeApi();
  serveBoard(held);
  const ending = new AbortController();
  const holder = clientOf(held, { signal: ending.signal });
  expect(await holder.signIn()).toBe("token-1");
  ending.abort(reason);
  expect(await rejection(holder.signIn())).toBe(reason);
  expect(await rejection(holder.start(7n))).toBe(reason);
  expect(held.to("/v1/tasks/7/start")).toHaveLength(0);
});

test("the_signal_of_the_client_ends_the_calls_in_flight_and_a_sign_in_they_share", async () => {
  fakeTimers();
  const reason = new Error("shutting down");
  const api = fakeApi();
  api.on("POST /v1/auth/challenge", unanswered);
  const stopped = new AbortController();
  const client = clientOf(api, { signal: stopped.signal });

  const calls = [client.start(7n), client.telegramLink()].map(rejection);
  await vi.advanceTimersByTimeAsync(10);
  stopped.abort(reason);

  expect(await Promise.all(calls)).toEqual([reason, reason]);
  // They shared the one sign-in, which was cancelled with them.
  expect(api.to("/v1/auth/challenge")).toHaveLength(1);
  expect(nth(api.to("/v1/auth/challenge"), 0).signal?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

test("a_client_with_a_signal_puts_no_listener_on_it_for_its_requests", async () => {
  fakeTimers();
  const api = fakeApi();
  api.on(NOT_THE_SIGN_IN, unanswered);
  const stopped = new AbortController();
  const client = clientOf(api, { signal: stopped.signal, timeoutMs: 1_000 });
  const listeners = () => getEventListeners(stopped.signal, "abort").length;
  const before = listeners();

  // Many requests at once, as an agent makes them: they do not each hang a listener on the
  // signal, which Node reports as a leak from the eleventh.
  const outcomes = Array.from({ length: 25 }, () => rejection(client.getTask(7n)));
  await vi.advanceTimersByTimeAsync(10);
  expect(api.calls).toHaveLength(25);
  expect(listeners()).toBe(before);

  await vi.advanceTimersByTimeAsync(1_000);
  for (const error of await Promise.all(outcomes)) expect(error).toBeInstanceOf(ApiTimeoutError);
  // It was the time that was out, and the signal of the client is as it was.
  expect(stopped.signal.aborted).toBe(false);
  expect(listeners()).toBe(before);
  expect(vi.getTimerCount()).toBe(0);
});

test("the_time_is_a_number_of_milliseconds_that_a_timer_can_keep", () => {
  const MAX = 2 ** 31 - 1;
  const refused: unknown[] = [
    0,
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    MAX + 1,
    "30000",
    null,
    true,
  ];
  for (const timeoutMs of refused) {
    const error = thrown(() => new ApiClient({ baseUrl: BASE, timeoutMs: timeoutMs as number }));
    expect(error, String(timeoutMs)).toBeInstanceOf(RangeError);
    expect((error as Error).message, String(timeoutMs)).toBe(
      `ApiClient: timeoutMs must be a number of milliseconds from 1 to ${MAX}, not ${String(timeoutMs)}`,
    );
  }
  for (const timeoutMs of [1, 30_000, 60.5, MAX, undefined]) {
    expect(() => new ApiClient({ baseUrl: BASE, timeoutMs }), String(timeoutMs)).not.toThrow();
  }
});
