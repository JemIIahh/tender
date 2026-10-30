import { expect, expectTypeOf, test, vi } from "vitest";
import {
  ApiError,
  fetchJson,
  ListTasksResponseSchema,
  type StartResponse,
  StartResponseSchema,
  TaskOutcomeSchema,
} from "../src/index";

// `fetchJson` and the response schemas, over a fake `fetch`. The API's own test
// (packages/api/test/schemas.test.ts) holds every schema to what its route really sends; these
// tests are about what `fetchJson` does with an answer, and a few shapes a route can only send
// after the indexer has been repaired from the chain.

const URL_OF_LIST = "http://api.test/v1/tasks";
const HASH = "ab".repeat(32);

/** A task as `GET /v1/tasks` lists it. */
const TASK = {
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
  is_team_poster: false,
  parent: null,
  outcome_kind: null,
};
const PAGE = { tasks: [TASK], next_cursor: "7" };

interface Call {
  /** What `this` was when `fetch` was called. */
  self: unknown;
  url: unknown;
  init: unknown;
}

/** A `fetch` that answers every call with `status` and the text `body`, and notes the calls. */
function answering(status: number, body: string) {
  const calls: Call[] = [];
  const impl = function (this: unknown, url: unknown, init: unknown) {
    calls.push({ self: this, url, init });
    return Promise.resolve(new Response(body, { status }));
  };
  return { fetch: impl as typeof fetch, calls };
}

/** What `fetchJson` rejected with: the test fails if it resolved. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected fetchJson to reject, and it resolved");
}

async function apiError(promise: Promise<unknown>): Promise<ApiError> {
  const error = await rejection(promise);
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

test("fetch_json_parses_a_valid_body", async () => {
  const { fetch, calls } = answering(200, JSON.stringify(PAGE));

  const page = await fetchJson(URL_OF_LIST, ListTasksResponseSchema, undefined, fetch);
  expect(page).toEqual(PAGE);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.url).toBe(URL_OF_LIST);

  // The result is typed by the schema.
  const started = await fetchJson(
    URL_OF_LIST,
    StartResponseSchema,
    undefined,
    answering(200, '{"ok":true,"working_count":3}').fetch,
  );
  expectTypeOf(started).toEqualTypeOf<StartResponse>();
  expect(started).toEqual({ ok: true, working_count: 3 });
});

test("fetch_json_hands_url_and_init_to_fetch_as_they_are", async () => {
  const { fetch, calls } = answering(200, '{"ok":true,"working_count":1}');
  const url = new URL("http://api.test/v1/tasks/7/start");
  const init = { method: "POST", headers: { authorization: "Bearer token" } };

  await fetchJson(url, StartResponseSchema, init, fetch);
  expect(calls[0]?.url).toBe(url);
  expect(calls[0]?.init).toBe(init);
});

test("fetch_json_calls_fetch_as_a_function_of_its_own", async () => {
  // A browser's `fetch` throws "Illegal invocation" when it is called as a method of anything but
  // the window, so the one that is passed in is never called through the object it came from.
  const { fetch, calls } = answering(200, '{"ok":true,"working_count":1}');
  const holder = { fetch };
  await fetchJson(URL_OF_LIST, StartResponseSchema, undefined, holder.fetch);
  expect(calls[0]?.self).toBeUndefined();

  // Nor is the global one, which is what is called without `fetchImpl`.
  const global = answering(200, '{"ok":true,"working_count":1}');
  vi.stubGlobal("fetch", global.fetch);
  try {
    await fetchJson(URL_OF_LIST, StartResponseSchema);
  } finally {
    vi.unstubAllGlobals();
  }
  expect(global.calls).toHaveLength(1);
  expect(global.calls[0]?.self).toBeUndefined();
});

test("fetch_json_throws_api_error_with_status_and_json_body_for_a_non_2xx", async () => {
  const bodies: Array<[number, unknown, string | null]> = [
    [404, { error: "not_found", message: "no such task" }, "not_found"],
    [409, { error: "not_open", message: "only an open task can be started" }, "not_open"],
    [
      400,
      {
        error: "bad_request",
        message: "the request body does not fit its schema",
        issues: [{ path: ["kind"], message: "Invalid option", code: "invalid_value" }],
      },
      "bad_request",
    ],
    // JSON, but not our error body: the status is all the message has.
    [500, { detail: "boom" }, null],
    [500, null, null],
  ];
  for (const [status, body, code] of bodies) {
    const { fetch } = answering(status, JSON.stringify(body));
    const error = await apiError(fetchJson(URL_OF_LIST, ListTasksResponseSchema, undefined, fetch));
    expect(error.status, `${status}`).toBe(status);
    expect(error.body, `${status}`).toEqual(body);
    expect(error.name).toBe("ApiError");
    expect(error).toBeInstanceOf(Error);
    expect(error.message, `${status}`).toContain(String(status));
    if (code === null) expect(error.message).not.toContain("(");
    else expect(error.message, `${status}`).toContain(code);
  }
});

test("fetch_json_keeps_a_text_body_as_text", async () => {
  for (const [status, text] of [
    [502, "Bad Gateway"],
    [503, "<html><body>upstream down</body></html>"],
    [500, ""],
  ] as const) {
    const { fetch } = answering(status, text);
    const error = await apiError(fetchJson(URL_OF_LIST, ListTasksResponseSchema, undefined, fetch));
    expect(error.status).toBe(status);
    expect(error.body).toBe(text);
    expect(error.message).toContain(String(status));
  }
});

test("fetch_json_throws_api_error_for_a_2xx_that_fails_the_schema", async () => {
  // The first path that fails is named, with the status of the answer; the body is what came.
  const cases: Array<[string, unknown, string]> = [
    [
      "a field of a task has the wrong type",
      { ...PAGE, tasks: [{ ...TASK, phase: "later" }] },
      "tasks.0.phase",
    ],
    [
      "a field of a task is missing",
      { ...PAGE, tasks: [TASK, { ...TASK, title: undefined }] },
      "tasks.1.title",
    ],
    ["the cursor is missing", { tasks: [] }, "next_cursor"],
    ["the answer is not an object", [], "the body"],
    ["the answer is null", null, "the body"],
  ];
  for (const [what, body, path] of cases) {
    const { fetch } = answering(200, JSON.stringify(body));
    const error = await apiError(fetchJson(URL_OF_LIST, ListTasksResponseSchema, undefined, fetch));
    expect(error.status, what).toBe(200);
    expect(error.body, what).toEqual(JSON.parse(JSON.stringify(body)));
    expect(error.message, what).toContain(path);
    expect(error.message, what).toContain("200");
  }

  // A 2xx with a body that is not JSON at all is refused the same way, and the text is kept.
  const html = answering(200, "<html>captive portal</html>");
  const error = await apiError(
    fetchJson(URL_OF_LIST, ListTasksResponseSchema, undefined, html.fetch),
  );
  expect(error.status).toBe(200);
  expect(error.body).toBe("<html>captive portal</html>");
  expect(error.message).toContain("not JSON");
});

test("fetch_json_lets_a_network_error_through_unchanged", async () => {
  for (const failure of [
    new TypeError("fetch failed"),
    new DOMException("The operation was aborted.", "AbortError"),
  ]) {
    const refusing = (() => Promise.reject(failure)) as typeof fetch;
    const error = await rejection(
      fetchJson(URL_OF_LIST, ListTasksResponseSchema, undefined, refusing),
    );
    expect(error).toBe(failure);
    expect(error).not.toBeInstanceOf(ApiError);
  }
});

/** `GET /v1/tasks` answered with one task that has `patch` applied. */
const withTask = (patch: Record<string, unknown>) => ({
  ...PAGE,
  tasks: [{ ...TASK, ...patch }],
});

/** The message of the error that `fetchJson` throws when `body` is the answer to `GET /v1/tasks`. */
async function refusalOf(body: unknown): Promise<string> {
  const { fetch } = answering(200, JSON.stringify(body));
  const error = await apiError(fetchJson(URL_OF_LIST, ListTasksResponseSchema, undefined, fetch));
  return error.message;
}

test("a_u64_given_as_a_json_number_is_refused", async () => {
  // R19: a u64 or a u128 is a decimal string, since a JSON number loses digits above 2^53.
  for (const [field, value] of [
    ["id", 7],
    ["reward", 1_000_003],
    ["created_at", 1_793_307_169_820_229_000],
    ["commit_deadline", 1_793_307_289_820_229_000],
    ["parent", 3],
  ] as const) {
    expect(await refusalOf(withTask({ [field]: value })), field).toContain(`tasks.0.${field}`);
  }
  expect(await refusalOf({ ...PAGE, next_cursor: 7 })).toContain("next_cursor");

  // And the other way round: a count is a JSON integer, not text.
  expect(await refusalOf(withTask({ commit_count: "2" }))).toContain("tasks.0.commit_count");
  expect(await refusalOf(withTask({ working_count: 1.5 }))).toContain("tasks.0.working_count");
});

test("a_u64_or_u128_as_text_must_be_a_canonical_decimal_in_range", async () => {
  // No sign, point, exponent, space or leading zero, and not empty.
  for (const text of ["007", "-1", "1.5", "1e3", "0x10", " 7", ""]) {
    for (const field of ["id", "reward", "created_at", "reveal_deadline", "parent"]) {
      expect(await refusalOf(withTask({ [field]: text })), `${field} ${text}`).toContain(
        `tasks.0.${field}`,
      );
    }
    expect(await refusalOf({ ...PAGE, next_cursor: text })).toContain("next_cursor");
  }

  // A u64 stops at 2^64 - 1, and a u128 goes on to 2^128 - 1.
  const pastU64 = "18446744073709551616";
  const pastU128 = "340282366920938463463374607431768211456";
  expect(await refusalOf(withTask({ id: pastU64 }))).toContain("tasks.0.id");
  expect(await refusalOf(withTask({ reward: pastU128 }))).toContain("tasks.0.reward");
  const rich = withTask({ reward: pastU64 });
  const { fetch } = answering(200, JSON.stringify(rich));
  expect(await fetchJson(URL_OF_LIST, ListTasksResponseSchema, undefined, fetch)).toEqual(rich);
});

test("an_unknown_key_is_stripped_not_refused", async () => {
  // The API may add a field to a response; a client that predates it keeps working, and does not
  // pass the field on.
  const body = {
    ...PAGE,
    new_top_level: true,
    tasks: [{ ...TASK, new_field: { nested: 1 } }],
  };
  const { fetch } = answering(200, JSON.stringify(body));

  const page = await fetchJson(URL_OF_LIST, ListTasksResponseSchema, undefined, fetch);
  expect(page).toEqual(PAGE);
  expect(page).not.toHaveProperty("new_top_level");
  expect(page.tasks[0]).not.toHaveProperty("new_field");
});

test("task_outcome_accepts_the_shapes_the_index_stores", () => {
  const picked = {
    kind: "picked",
    task_id: "1",
    by: "judge.test.near",
    winners: [{ account: "alice.test.near", bps: 10_000, amount: "950000" }],
    fee: "50000",
    scorecard_hash: HASH,
    scorecard_uri: "http://api.test/v1/blobs/ab",
  };
  const voided = {
    kind: "voided",
    task_id: "2",
    reason: "no_award",
    by: "judge.test.near",
    refunds: [{ account: "poster.test.near", amount: "1000000" }],
    scorecard_hash: HASH,
    scorecard_uri: "ipfs://scorecard",
  };
  // `void_task` has no account behind it and no scorecard.
  const expired = {
    ...voided,
    reason: "expired",
    by: null,
    scorecard_hash: null,
    scorecard_uri: null,
  };
  // An outcome the index took from the chain's view, which has no `by` and no `refunds`.
  const reconciledPick = { ...picked, by: null, by_source: "reconcile" };
  const { refunds: _refunds, ...withoutRefunds } = voided;
  const reconciledVoid = { ...withoutRefunds, by: null, by_source: "reconcile" };

  for (const outcome of [picked, voided, expired, reconciledPick, reconciledVoid]) {
    expect(TaskOutcomeSchema.parse(outcome), outcome.kind).toEqual(outcome);
  }

  // A pick keeps its scorecard, and a kind is one of the two.
  const { scorecard_hash: _hash, ...noScorecard } = picked;
  expect(TaskOutcomeSchema.safeParse(noScorecard).success).toBe(false);
  expect(TaskOutcomeSchema.safeParse({ ...picked, scorecard_hash: null }).success).toBe(false);
  expect(TaskOutcomeSchema.safeParse({ ...voided, kind: "settled" }).success).toBe(false);
  expect(TaskOutcomeSchema.safeParse({ ...picked, fee: 50_000 }).success).toBe(false);
});
