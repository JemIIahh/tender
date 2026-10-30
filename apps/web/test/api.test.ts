import { ApiError } from "@tender/shared";
import { afterEach, expect, test, vi } from "vitest";
import { api } from "../lib/api";

// The web app's data layer over a fake `fetch`. The shared tests (packages/shared/test/api.test.ts)
// hold `fetchJson` and the schemas to the API's answers; these hold each function to the request it
// makes and to what it does with the answer. vitest.config.ts gives the config an API URL of
// http://api.test.

const BASE = "http://api.test/v1";
const HASH = "ab".repeat(32);
const POSTER = "poster.test.near";
const TOKEN = "bearer-token-from-sign-in";

const TASK = {
  id: "7",
  title: "Extract invoice totals",
  category: "extraction",
  tags: ["extraction", "json"],
  token: "token.test.near",
  reward: "1000003",
  phase: "open",
  poster: POSTER,
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
const TASK_PAGE = { tasks: [TASK], next_cursor: null };
const TASK_DETAIL = {
  task: {
    ...TASK,
    brief_uri: `http://api.test/v1/blobs/${HASH}`,
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
  funders: [{ account: POSTER, amount: "1000003" }],
  children: [],
  scorecard: null,
};

const AGENT = {
  account: "alice.test.near",
  asp: null,
  name: "Alice",
  tags: ["coding"],
  profile_uri: `http://api.test/v1/blobs/${HASH}`,
  profile_hash: HASH,
  registered_height: "120",
  entries: 3,
  reveals: 2,
  wins: 1,
  earned: { "token.test.near": "950000" },
  picks_made: 0,
  voids_after_reveals: 0,
  is_team: true,
};
const AGENT_PAGE = { agents: [AGENT], next_cursor: null };
const AGENT_DETAIL = {
  agent: AGENT,
  recent_entries: [
    { task_id: "7", title: "Extract invoice totals", phase: "open", revealed: false, won: false },
  ],
};

const ENTRIES = {
  entries: [
    {
      task_id: "7",
      title: null,
      phase: "revealing",
      revealed: true,
      won: false,
      entry_index: 0,
      committed_height: "130",
      content_hash: HASH,
      uri: `http://api.test/v1/blobs/${HASH}`,
    },
  ],
};

const SCORECARD = {
  version: 1,
  task_id: "7",
  verifier: "judge.test.near",
  kind: "exact",
  criteria_hash: HASH,
  heldout_commitment: null,
  heldout: null,
  tie_break: "score desc, committed_at_block asc, account asc",
  entries: [],
  winners: [],
  generated_at: "2026-10-30T08:00:00.000Z",
  judge: { software: "tender-judge/1", model: null },
};

const HEALTH = {
  ok: true,
  network: "testnet",
  contract: "tender.test.near",
  indexed_height: "100",
  chain_final_height: "102",
  lag_blocks: "2",
};

interface Call {
  url: string;
  init: RequestInit;
  /** The body of a request that has one, as JSON. */
  body?: unknown;
}

/** A `fetch` that answers every call with `status` and `body` as JSON, and notes the calls. */
function fakeApi(body: unknown, status = 200): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const text = typeof init.body === "string" ? init.body : undefined;
    calls.push({ url, init, body: text === undefined ? undefined : JSON.parse(text) });
    return new Response(JSON.stringify(body), { status });
  });
  return calls;
}

const headersOf = (call: Call | undefined) => new Headers(call?.init.headers);

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---- Reads ------------------------------------------------------------------------------------

test("list_tasks_asks_for_the_page_with_its_filter", async () => {
  const calls = fakeApi(TASK_PAGE);

  const page = await api.listTasks({
    phase: "open",
    tag: "coding",
    poster: POSTER,
    verifier: "judge.test.near",
    parent: 3n,
    limit: 10,
    cursor: "5",
  });

  expect(page).toEqual(TASK_PAGE);
  expect(calls).toHaveLength(1);
  const url = new URL(calls[0]?.url ?? "");
  expect(`${url.origin}${url.pathname}`).toBe(`${BASE}/tasks`);
  expect(Object.fromEntries(url.searchParams)).toEqual({
    phase: "open",
    tag: "coding",
    poster: POSTER,
    verifier: "judge.test.near",
    parent: "3",
    limit: "10",
    cursor: "5",
  });
});

test("list_tasks_leaves_out_what_the_filter_leaves_out", async () => {
  const calls = fakeApi(TASK_PAGE);

  await api.listTasks();
  await api.listTasks({});
  await api.listTasks({ phase: "settled", tag: undefined });

  expect(calls.map((c) => c.url)).toEqual([
    `${BASE}/tasks`,
    `${BASE}/tasks`,
    `${BASE}/tasks?phase=settled`,
  ]);
});

test("reads_send_a_get_with_no_body_and_no_credentials", async () => {
  const calls = fakeApi(TASK_PAGE);

  await api.listTasks();

  expect(calls[0]?.init.method ?? "GET").toBe("GET");
  expect(calls[0]?.init.body).toBeUndefined();
  expect(headersOf(calls[0]).has("authorization")).toBe(false);
});

test("get_task_reads_one_task_by_a_bigint_or_a_string_id", async () => {
  const calls = fakeApi(TASK_DETAIL);

  expect(await api.getTask(7n)).toEqual(TASK_DETAIL);
  expect(await api.getTask("7")).toEqual(TASK_DETAIL);

  expect(calls.map((c) => c.url)).toEqual([`${BASE}/tasks/7`, `${BASE}/tasks/7`]);
});

test("get_task_keeps_an_id_from_the_address_inside_its_path", async () => {
  const calls = fakeApi({ error: "not_found", message: "no such task" }, 404);

  expect(await api.getTask("../health?x=1#y")).toBeNull();

  expect(calls[0]?.url).toBe(`${BASE}/tasks/..%2Fhealth%3Fx%3D1%23y`);
});

test("reads_of_one_thing_give_null_when_the_api_has_none", async () => {
  fakeApi({ error: "not_found", message: "no such thing" }, 404);

  expect(await api.getTask(99n)).toBeNull();
  expect(await api.getAgent("nobody.near")).toBeNull();
  expect(await api.getScorecard(99n)).toBeNull();
});

test("reads_of_one_thing_throw_for_any_other_failure", async () => {
  fakeApi({ error: "internal", message: "internal error" }, 500);

  for (const read of [
    () => api.getTask(7n),
    () => api.getAgent("alice.test.near"),
    () => api.getScorecard(7n),
  ]) {
    const error = await read().catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(500);
    expect(error.body).toEqual({ error: "internal", message: "internal error" });
  }
});

test("a_list_that_is_not_found_is_an_error_and_not_an_empty_page", async () => {
  fakeApi({ error: "not_found", message: "no such route" }, 404);

  for (const read of [
    () => api.listTasks(),
    () => api.listAgents(),
    () => api.listEntries("alice.test.near"),
    () => api.health(),
  ]) {
    await expect(read()).rejects.toMatchObject({ name: "ApiError", status: 404 });
  }
});

test("list_agents_asks_for_the_page_with_its_filter", async () => {
  const calls = fakeApi(AGENT_PAGE);

  expect(
    await api.listAgents({ tag: "coding", asp: "asp.test.near", limit: 5, cursor: "a.near" }),
  ).toEqual(AGENT_PAGE);

  const url = new URL(calls[0]?.url ?? "");
  expect(url.pathname).toBe("/v1/agents");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    tag: "coding",
    asp: "asp.test.near",
    limit: "5",
    cursor: "a.near",
  });
});

test("get_agent_reads_one_agent", async () => {
  const calls = fakeApi(AGENT_DETAIL);

  expect(await api.getAgent("alice.test.near")).toEqual(AGENT_DETAIL);

  expect(calls[0]?.url).toBe(`${BASE}/agents/alice.test.near`);
});

test("list_entries_asks_for_one_account", async () => {
  const calls = fakeApi(ENTRIES);

  expect(await api.listEntries("alice.test.near")).toEqual(ENTRIES);

  expect(calls[0]?.url).toBe(`${BASE}/entries?account=alice.test.near`);
});

test("get_scorecard_reads_the_scorecard_of_a_task", async () => {
  const calls = fakeApi(SCORECARD);

  expect(await api.getScorecard(7n)).toEqual(SCORECARD);
  expect(await api.getScorecard("7")).toEqual(SCORECARD);

  expect(calls.map((c) => c.url)).toEqual([`${BASE}/scorecards/7`, `${BASE}/scorecards/7`]);
});

test("health_reads_the_index_lag_and_throws_when_the_chain_is_unavailable", async () => {
  fakeApi(HEALTH);
  expect(await api.health()).toEqual(HEALTH);

  const unavailable = {
    ok: false,
    error: "chain_unavailable",
    message: "the final block height of the chain could not be read",
    network: "testnet",
    contract: "tender.test.near",
    indexed_height: "100",
  };
  fakeApi(unavailable, 503);
  const error = await api.health().catch((e) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect(error.status).toBe(503);
  expect(error.body).toEqual(unavailable);
});

test("an_answer_that_does_not_fit_its_schema_is_an_error", async () => {
  // A reward is a u128 as a decimal string, never a number or a decimal.
  fakeApi({ ...TASK_PAGE, tasks: [{ ...TASK, reward: 1.5 }] });

  const error = await api.listTasks().catch((e) => e);

  expect(error).toBeInstanceOf(ApiError);
  expect(error.message).toContain("tasks.0.reward");
});

// ---- Writes -----------------------------------------------------------------------------------

test("auth_challenge_posts_and_reads_the_challenge", async () => {
  const challenge = {
    nonce: btoa("n".repeat(32)),
    message: "Sign in to Tender",
    recipient: "tender.test.near",
    expires_at: "2026-10-30T08:05:00.000Z",
  };
  const calls = fakeApi(challenge);

  expect(await api.authChallenge()).toEqual(challenge);

  expect(calls[0]?.url).toBe(`${BASE}/auth/challenge`);
  expect(calls[0]?.init.method).toBe("POST");
  expect(headersOf(calls[0]).has("authorization")).toBe(false);
});

test("auth_verify_posts_the_signed_challenge_in_the_apis_names", async () => {
  const signedIn = {
    token: TOKEN,
    expires_at: "2026-10-30T20:00:00.000Z",
    key_kind: "full_access",
  };
  const calls = fakeApi(signedIn);

  const result = await api.authVerify({
    accountId: "alice.test.near",
    publicKey: "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp",
    signature: btoa("s".repeat(64)),
    nonce: btoa("n".repeat(32)),
    message: "Sign in to Tender",
    recipient: "tender.test.near",
  });

  expect(result).toEqual(signedIn);
  expect(calls[0]?.url).toBe(`${BASE}/auth/verify`);
  expect(calls[0]?.init.method).toBe("POST");
  expect(headersOf(calls[0]).get("content-type")).toBe("application/json");
  expect(headersOf(calls[0]).has("authorization")).toBe(false);
  expect(calls[0]?.body).toEqual({
    account_id: "alice.test.near",
    public_key: "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp",
    signature: btoa("s".repeat(64)),
    nonce: btoa("n".repeat(32)),
    message: "Sign in to Tender",
    recipient: "tender.test.near",
  });
});

test("upload_blob_sends_the_token_and_the_bytes_as_base64", async () => {
  const stored = { sha256: HASH, uri: `http://api.test/v1/blobs/${HASH}` };
  const calls = fakeApi(stored);
  const bytes = new TextEncoder().encode('{"version":1,"title":"é"}');

  const result = await api.uploadBlob(TOKEN, {
    kind: "brief",
    contentType: "application/json",
    bytes,
  });

  expect(result).toEqual(stored);
  expect(calls[0]?.url).toBe(`${BASE}/blobs`);
  expect(calls[0]?.init.method).toBe("POST");
  expect(headersOf(calls[0]).get("authorization")).toBe(`Bearer ${TOKEN}`);
  expect(headersOf(calls[0]).get("content-type")).toBe("application/json");
  // No task: a brief has none, and the API refuses a key it does not know.
  expect(calls[0]?.body).toEqual({
    kind: "brief",
    content_type: "application/json",
    content_base64: Buffer.from(bytes).toString("base64"),
  });
});

test("upload_blob_names_the_task_of_a_result_as_a_decimal_string", async () => {
  const calls = fakeApi({ sha256: HASH, uri: `http://api.test/v1/blobs/${HASH}` });

  await api.uploadBlob(TOKEN, {
    kind: "result",
    contentType: "text/plain",
    bytes: new Uint8Array([0, 1, 2, 254, 255]),
    taskId: 18446744073709551615n,
  });

  expect(calls[0]?.body).toEqual({
    kind: "result",
    content_type: "text/plain",
    content_base64: "AAEC/v8=",
    task_id: "18446744073709551615",
  });
});

test("upload_blob_encodes_the_largest_result_the_api_keeps", async () => {
  const calls = fakeApi({ sha256: HASH, uri: `http://api.test/v1/blobs/${HASH}` });
  const bytes = new Uint8Array(262_144).map((_, i) => (i * 31) % 256);

  await api.uploadBlob(TOKEN, { kind: "result", contentType: "text/plain", bytes, taskId: 1n });

  const sent = calls[0]?.body as { content_base64: string };
  expect(sent.content_base64).toBe(Buffer.from(bytes).toString("base64"));
});

test("upload_heldout_sends_the_commitment_and_the_bytes", async () => {
  const calls = fakeApi({ ok: true });
  const bytes = new TextEncoder().encode('{"cases":[]}');

  expect(await api.uploadHeldout(TOKEN, HASH, bytes)).toBeUndefined();

  expect(calls[0]?.url).toBe(`${BASE}/heldout`);
  expect(calls[0]?.init.method).toBe("POST");
  expect(headersOf(calls[0]).get("authorization")).toBe(`Bearer ${TOKEN}`);
  expect(calls[0]?.body).toEqual({
    commitment: HASH,
    content_base64: Buffer.from(bytes).toString("base64"),
  });
});

test("start_posts_to_the_task_with_the_token", async () => {
  const calls = fakeApi({ ok: true, working_count: 2 });

  expect(await api.start(TOKEN, 7n)).toEqual({ ok: true, working_count: 2 });

  expect(calls[0]?.url).toBe(`${BASE}/tasks/7/start`);
  expect(calls[0]?.init.method).toBe("POST");
  expect(headersOf(calls[0]).get("authorization")).toBe(`Bearer ${TOKEN}`);
});

test("telegram_link_posts_with_the_token", async () => {
  const link = {
    url: "https://t.me/tender_test_bot?start=abc",
    expires_at: "2026-10-30T08:10:00.000Z",
  };
  const calls = fakeApi(link);

  expect(await api.telegramLink(TOKEN)).toEqual(link);

  expect(calls[0]?.url).toBe(`${BASE}/telegram/link`);
  expect(calls[0]?.init.method).toBe("POST");
  expect(headersOf(calls[0]).get("authorization")).toBe(`Bearer ${TOKEN}`);
});

test("a_refused_write_throws_with_the_apis_error_body", async () => {
  const refusal = {
    error: "not_open",
    message: "only an open task can be started, and this one is judging",
  };
  fakeApi(refusal, 409);

  const error = await api.start(TOKEN, 7n).catch((e) => e);

  expect(error).toBeInstanceOf(ApiError);
  expect(error.status).toBe(409);
  expect(error.body).toEqual(refusal);
});

// ---- Waiting ----------------------------------------------------------------------------------

/** A `fetch` that never answers, and gives up the way the platform's does when it is aborted. */
function silentApi(): void {
  vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => {
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });
  });
}

test("a_read_gives_up_when_the_api_does_not_answer", async () => {
  silentApi();
  vi.useFakeTimers();
  try {
    const pending = api.listTasks().catch((e) => e);
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await pending).name).toBe("TimeoutError");
  } finally {
    vi.useRealTimers();
  }
});

test("a_write_gives_up_when_the_api_does_not_answer", async () => {
  silentApi();
  vi.useFakeTimers();
  try {
    const pending = api.telegramLink(TOKEN).catch((e) => e);
    await vi.advanceTimersByTimeAsync(120_000);
    expect((await pending).name).toBe("TimeoutError");
  } finally {
    vi.useRealTimers();
  }
});
