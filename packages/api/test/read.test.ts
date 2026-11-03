import type { TenderClient } from "@tender/client";
import { type BlobKind, putBlob, setBlobPublic } from "@tender/db";
import { applyBlock } from "@tender/indexer";
import {
  BOB_ENTRY,
  blockOf,
  eventLine,
  FIXTURE_ACCOUNTS,
  FIXTURE_BRIEF,
  FIXTURE_BRIEF_HASH,
  FIXTURE_CONTRACT,
  FIXTURE_OPTIONS,
  FIXTURE_PROFILE_HASH,
  FIXTURE_TOKEN,
  fixtureData,
  lifecycleBlocks,
  putFixtureBlobs,
} from "@tender/indexer/testing";
import {
  type Brief,
  canonicalJson,
  type Phase,
  type PublicCriteria,
  phaseAt,
  type Scorecard,
  sha256Hex,
  type TenderEvent,
} from "@tender/shared";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import {
  type AccountEntriesResponse,
  type AgentDetailResponse,
  type ApiDeps,
  type ChainReader,
  createApp,
  type HealthResponse,
  type ListAgentsResponse,
  type ListTasksResponse,
  type TaskDetailResponse,
  type TaskSummary,
} from "../src/index";
import { fakeClient, resetDb, seedLifecycle, TEST_NOW, testDeps } from "./helpers";

// One PGlite database serves the whole file and is emptied before each test. All data is written
// by the indexer from the captured event logs (`@tender/indexer/testing`), the way production data
// is; the few rows no event writes (`working`, `judge_status`) are set with SQL. The clock is a
// variable, so a test can move a task through its phases.

const { poster, judge, alice, bob, carol } = FIXTURE_ACCOUNTS;
const SECOND = 1_000_000_000n;
const U64_MAX = 2n ** 64n - 1n;

/** The winners of the captured `picked` event, as a scorecard names them: account and share. */
const PICKED_WINNERS = fixtureData("picked").winners.map(({ account, bps }) => ({ account, bps }));

let deps: ApiDeps;
let nowNs = TEST_NOW;
let nextHeight = 100n;

beforeAll(async () => {
  deps = await testDeps({ now: () => nowNs });
});

afterAll(() => deps.db.close());

beforeEach(async () => {
  await resetDb(deps.db);
  nowNs = TEST_NOW;
  // The lifecycle's blocks occupy heights 60 to 90 and a block applied at a height already used
  // would be skipped, so every extra block gets a height of its own above them.
  nextHeight = 100n;
});

/** Applies one block of its own in which each of `lines` has a receipt. */
function apply(...lines: string[]): Promise<number> {
  return applyBlock(deps.db, blockOf(nextHeight++, lines), FIXTURE_OPTIONS);
}

function appWith(over: Partial<ApiDeps> = {}): Hono {
  return createApp({ ...deps, ...over });
}

interface Reply<T> {
  status: number;
  body: T;
  headers: Headers;
}

async function get<T>(path: string, app: Hono = appWith()): Promise<Reply<T>> {
  const res = await app.request(path);
  return { status: res.status, body: (await res.json()) as T, headers: res.headers };
}

// ---- Data -------------------------------------------------------------------------------------

/** The fields of a `task_created` event, which `taskLine` replaces in the captured line. */
type TaskCreated = Extract<TenderEvent, { event: "task_created" }>["data"];
type TaskWindows = Pick<
  TaskCreated,
  "created_at" | "commit_deadline" | "reveal_deadline" | "pick_deadline" | "fallback_deadline"
>;

type OpenPhase = Exclude<Phase, "settled">;
const PHASE_ORDER: OpenPhase[] = ["open", "revealing", "judging", "fallback", "expired"];

/**
 * Deadlines 60 seconds apart that put a task in `phase` at `TEST_NOW`, 30 seconds from the nearest
 * deadline on either side.
 */
function windowsFor(phase: OpenPhase): TaskWindows {
  const commit = TEST_NOW + (60n * BigInt(1 - PHASE_ORDER.indexOf(phase)) - 30n) * SECOND;
  return {
    created_at: String(commit - 100n * SECOND),
    commit_deadline: String(commit),
    reveal_deadline: String(commit + 60n * SECOND),
    pick_deadline: String(commit + 120n * SECOND),
    fallback_deadline: String(commit + 180n * SECOND),
  };
}

/** A `task_created` line: the captured one with the given fields replaced. */
function taskLine(id: number, over: Partial<TaskCreated> = {}): string {
  return eventLine("task_created", { id: String(id), ...over });
}

/** Stores a public brief of kind `brief` and returns its hash. */
async function putBrief(over: Partial<Brief> = {}): Promise<string> {
  return putBlob(deps.db, {
    kind: "brief",
    contentType: "application/json",
    bytes: canonicalJson({ ...FIXTURE_BRIEF, ...over }),
    isPublic: true,
  });
}

/**
 * The lifecycle's task 1 (settled, poster, judge, tags extraction, regex and json) and five open
 * ones, one in each phase that is not `settled` at `TEST_NOW`:
 *
 * | id | phase     | poster | verifier | tags             | parent |
 * | -- | --------- | ------ | -------- | ---------------- | ------ |
 * | 2  | open      | carol  | judge    | coding, rust     |        |
 * | 3  | revealing | poster | bob      | research         |        |
 * | 4  | judging   | carol  | judge    | coding, rust     |        |
 * | 5  | fallback  | poster | judge    | research         | 2      |
 * | 6  | expired   | poster | judge    | none: no brief   |        |
 */
async function seedBoard(): Promise<void> {
  await seedLifecycle(deps.db);
  const coding = await putBrief({
    title: "Fix the parser",
    category: "coding",
    tags: ["coding", "rust"],
  });
  const research = await putBrief({
    title: "Survey rollups",
    category: "research",
    tags: ["research"],
  });
  await apply(
    taskLine(2, { brief_hash: coding, poster: carol, verifier: judge, ...windowsFor("open") }),
    taskLine(3, { brief_hash: research, poster, verifier: bob, ...windowsFor("revealing") }),
    taskLine(4, { brief_hash: coding, poster: carol, verifier: judge, ...windowsFor("judging") }),
    taskLine(5, {
      brief_hash: research,
      poster,
      verifier: judge,
      parent: "2",
      ...windowsFor("fallback"),
    }),
    // The captured brief hash names no stored blob: the task has no title, category or tags.
    taskLine(6, { poster, verifier: judge, ...windowsFor("expired") }),
  );
}

const ids = (tasks: Array<{ id: string }>) => tasks.map((t) => t.id);

// ---- Health -----------------------------------------------------------------------------------

test("health_reports_lag", async () => {
  await seedLifecycle(deps.db);
  const client = fakeClient({ finalHeight: async () => 100n });

  const lagging = await get<HealthResponse>("/v1/health", appWith({ client }));
  expect(lagging.status).toBe(200);
  expect(lagging.body).toEqual({
    ok: true,
    network: "sandbox",
    contract: FIXTURE_CONTRACT,
    indexed_height: "90",
    chain_final_height: "100",
    lag_blocks: "10",
  });

  // Caught up, and an index that is ahead of the node the API asks: the lag is never negative.
  for (const final of [90n, 80n]) {
    const caughtUp = appWith({ client: fakeClient({ finalHeight: async () => final }) });
    const { body } = await get<HealthResponse>("/v1/health", caughtUp);
    expect(body).toMatchObject({ indexed_height: "90", chain_final_height: String(final) });
    expect(body.lag_blocks).toBe("0");
  }

  // Nothing indexed yet: the whole chain is the lag, not an unset field a monitor could misread.
  await resetDb(deps.db);
  const { body: empty } = await get<HealthResponse>("/v1/health", appWith({ client }));
  expect(empty).toMatchObject({
    indexed_height: "0",
    chain_final_height: "100",
    lag_blocks: "100",
  });
});

test("health_503_when_chain_unreachable", async () => {
  await seedLifecycle(deps.db);
  const client = fakeClient({
    finalHeight: async () => {
      throw new Error("connect ECONNREFUSED https://rpc.example/?apiKey=secret");
    },
  });
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const res = await get<Record<string, unknown>>("/v1/health", appWith({ client }));
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ ok: false, error: "chain_unavailable", indexed_height: "90" });
    // The error text can carry an endpoint with a key in it: it stays out of the response and the log.
    expect(JSON.stringify(res.body)).not.toContain("secret");
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
  } finally {
    log.mockRestore();
  }
});

test("internal_errors_are_500_without_details", async () => {
  const broken = {
    ...deps.db,
    query: async () => {
      throw new Error("relation tasks is broken, password=secret");
    },
  };
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const res = await get<{ error: string }>("/v1/tasks", appWith({ db: broken }));
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal");
    expect(JSON.stringify(res.body)).not.toContain("secret");
    expect(log).toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
});

// ---- Task list --------------------------------------------------------------------------------

test("tasks_list_filters_and_paginates", async () => {
  await seedBoard();

  const all = await get<ListTasksResponse>("/v1/tasks");
  expect(all.status).toBe(200);
  expect(ids(all.body.tasks)).toEqual(["6", "5", "4", "3", "2", "1"]);
  expect(all.body.next_cursor).toBeNull();

  const filtered = async (query: string) =>
    ids((await get<ListTasksResponse>(`/v1/tasks?${query}`)).body.tasks);

  // The phase is the one the clock gives each task; task 1 has an outcome.
  expect(await filtered("phase=open")).toEqual(["2"]);
  expect(await filtered("phase=revealing")).toEqual(["3"]);
  expect(await filtered("phase=judging")).toEqual(["4"]);
  expect(await filtered("phase=fallback")).toEqual(["5"]);
  expect(await filtered("phase=expired")).toEqual(["6"]);
  expect(await filtered("phase=settled")).toEqual(["1"]);
  nowNs = TEST_NOW + 60n * SECOND; // every task is one phase later than it was
  expect(await filtered("phase=open")).toEqual([]);
  expect(await filtered("phase=revealing")).toEqual(["2"]);
  expect(await filtered("phase=judging")).toEqual(["3"]);
  expect(await filtered("phase=fallback")).toEqual(["4"]);
  expect(await filtered("phase=expired")).toEqual(["6", "5"]);
  nowNs = TEST_NOW;

  expect(await filtered("tag=coding")).toEqual(["4", "2"]);
  expect(await filtered("tag=rust")).toEqual(["4", "2"]);
  expect(await filtered("tag=research")).toEqual(["5", "3"]);
  expect(await filtered("tag=extraction")).toEqual(["1"]);
  expect(await filtered("tag=nothing")).toEqual([]);
  expect(await filtered(`poster=${carol}`)).toEqual(["4", "2"]);
  expect(await filtered(`poster=${poster}`)).toEqual(["6", "5", "3", "1"]);
  expect(await filtered(`verifier=${bob}`)).toEqual(["3"]);
  expect(await filtered(`verifier=${judge}`)).toEqual(["6", "5", "4", "2", "1"]);
  expect(await filtered("parent=2")).toEqual(["5"]);
  expect(await filtered("parent=3")).toEqual([]);
  expect(await filtered("tag=coding&phase=open")).toEqual(["2"]);
  expect(await filtered(`poster=${poster}&verifier=${judge}&phase=expired`)).toEqual(["6"]);
  // An empty filter is no filter.
  expect(await filtered("tag=&phase=&poster=")).toEqual(["6", "5", "4", "3", "2", "1"]);

  // Pages run from the newest id down, and the cursor is the last id of the page before.
  const first = await get<ListTasksResponse>("/v1/tasks?limit=2");
  expect(ids(first.body.tasks)).toEqual(["6", "5"]);
  expect(first.body.next_cursor).toBe("5");
  const second = await get<ListTasksResponse>("/v1/tasks?limit=2&cursor=5");
  expect(ids(second.body.tasks)).toEqual(["4", "3"]);
  expect(second.body.next_cursor).toBe("3");
  const third = await get<ListTasksResponse>("/v1/tasks?limit=2&cursor=3");
  expect(ids(third.body.tasks)).toEqual(["2", "1"]);
  expect(third.body.next_cursor).toBeNull();
  // A page that ends exactly at the last task has no next page.
  const exact = await get<ListTasksResponse>("/v1/tasks?limit=3&cursor=4");
  expect(ids(exact.body.tasks)).toEqual(["3", "2", "1"]);
  expect(exact.body.next_cursor).toBeNull();
  // Filters and the cursor work together.
  const paged = await get<ListTasksResponse>(`/v1/tasks?poster=${poster}&limit=2&cursor=6`);
  expect(ids(paged.body.tasks)).toEqual(["5", "3"]);
  expect(paged.body.next_cursor).toBe("3");
});

test("tasks_list_default_and_maximum_page_size", async () => {
  const lines = Array.from({ length: 55 }, (_, i) => taskLine(i + 1));
  await apply(...lines);

  const byDefault = await get<ListTasksResponse>("/v1/tasks");
  expect(byDefault.body.tasks).toHaveLength(20);
  expect(byDefault.body.next_cursor).toBe("36");

  // Asking for more than the maximum gets the maximum, and the cursor leads to the rest.
  const capped = await get<ListTasksResponse>("/v1/tasks?limit=1000");
  expect(capped.status).toBe(200);
  expect(capped.body.tasks).toHaveLength(50);
  expect(capped.body.next_cursor).toBe("6");
  const rest = await get<ListTasksResponse>("/v1/tasks?limit=1000&cursor=6");
  expect(ids(rest.body.tasks)).toEqual(["5", "4", "3", "2", "1"]);
  expect(rest.body.next_cursor).toBeNull();
});

test("tasks_list_rejects_bad_query", async () => {
  for (const query of [
    "phase=bogus",
    "limit=0",
    "limit=-1",
    "limit=ten",
    "limit=1.5",
    "cursor=abc",
    "cursor=01",
    "parent=x",
    "parent=18446744073709551616",
    "poster=NOT AN ACCOUNT",
    "verifier=UPPER.near",
    "tag=Has_Underscore",
  ]) {
    const res = await get<{ error: string; message: string }>(`/v1/tasks?${query}`);
    expect(res.status, query).toBe(400);
    expect(res.body.error, query).toBe("bad_request");
    expect(res.body.message, query).toEqual(expect.any(String));
  }
});

test("task_summary_labels_team_posters_and_counts_workers", async () => {
  await seedBoard();
  await deps.db.query("insert into working (task_id, account) values (2, $1), (2, $2)", [
    alice,
    bob,
  ]);
  await deps.db.query("update tasks set judge_status = 'accepted' where id = 2");

  const app = appWith({ teamAccounts: [carol] });
  const { body } = await get<ListTasksResponse>("/v1/tasks", app);
  const byId = new Map(body.tasks.map((t) => [t.id, t]));

  expect(byId.get("2")).toMatchObject({
    poster: carol,
    is_team_poster: true,
    working_count: 2,
    judge_status: "accepted",
  });
  expect(byId.get("4")?.is_team_poster).toBe(true);
  for (const id of ["1", "3", "5", "6"]) {
    expect(byId.get(id), id).toMatchObject({ is_team_poster: false, working_count: 0 });
    expect(byId.get(id)?.judge_status, id).toBeNull();
  }

  // The label comes from this deployment's list at the time of the request, and from nothing the
  // indexer stored: alice's agent row says the team runs her, and the list does not.
  await deps.db.query("update agents set is_team = true where account = $1", [alice]);
  await apply(taskLine(7, { poster: alice, ...windowsFor("open") }));
  const second = await get<ListTasksResponse>("/v1/tasks?limit=1", appWith());
  expect(second.body.tasks[0]).toMatchObject({ id: "7", poster: alice, is_team_poster: false });
  // A poster that runs under a provider the team runs is the team's too (alice.test.near under
  // test.near), whether or not it ever registered as an agent.
  const underTeam = await get<ListTasksResponse>(
    "/v1/tasks",
    appWith({ teamAccounts: ["test.near"] }),
  );
  for (const task of underTeam.body.tasks) {
    expect(task.is_team_poster, `task ${task.id} of ${task.poster}`).toBe(true);
  }

  // A task whose brief the index could not read is still listed, without title, category or tags.
  expect(byId.get("6")).toMatchObject({ title: null, category: null, tags: [] });
  expect(byId.get("1")).toMatchObject({
    title: FIXTURE_BRIEF.title,
    category: "extraction",
    tags: FIXTURE_BRIEF.tags,
    outcome_kind: "picked",
  });
  expect(byId.get("2")).toMatchObject({ outcome_kind: null, parent: null });
  expect(byId.get("5")).toMatchObject({ parent: "2" });
});

// ---- Task detail ------------------------------------------------------------------------------

test("task_detail_includes_entries_brief_and_children", async () => {
  await seedLifecycle(deps.db);
  // carol tops task 1 up, and a task names task 1 as its parent.
  await apply(eventLine("task_topped_up"), taskLine(2, { parent: "1" }));

  const res = await get<TaskDetailResponse>("/v1/tasks/1", appWith({ teamAccounts: [alice] }));
  expect(res.status).toBe(200);
  const { task, brief, criteria, entries, funders, children, scorecard } = res.body;

  expect(task).toEqual({
    id: "1",
    title: FIXTURE_BRIEF.title,
    category: "extraction",
    tags: FIXTURE_BRIEF.tags,
    token: FIXTURE_TOKEN,
    reward: "1500003",
    phase: "settled",
    poster,
    verifier: judge,
    created_at: "1793307169820229000",
    commit_deadline: "1793307289820229000",
    reveal_deadline: "1793307409820229000",
    pick_deadline: "1793307529820229000",
    fallback_deadline: "1793307649820229000",
    commit_count: 2,
    reveal_count: 2,
    working_count: 0,
    judge_status: null,
    judge_reason: null,
    is_team_poster: false,
    parent: null,
    outcome_kind: "picked",
    brief_uri: "ipfs://brief",
    brief_hash: FIXTURE_BRIEF_HASH,
    criteria_hash: "262d517bffd06484e2341b4a379c7f4fa4be9284a9a82631c03420953d60bd67",
    heldout_commitment: "d391004a5653e0189e4a61d3455ed579db58d2af8aed81c8edf78b08d20fe432",
    max_entries: 2,
    max_winners: 2,
    invited: [alice, bob],
    fee_bps: 500,
    // As the event logged it, `by` included: it tells a verifier's pick from a poster's fallback.
    outcome: {
      kind: "picked",
      task_id: "1",
      by: judge,
      winners: [
        { account: alice, bps: 7000, amount: "665003" },
        { account: bob, bps: 3000, amount: "285000" },
      ],
      fee: "50000",
      scorecard_hash: "8fad3e916b98df98caa7f0e95f9920cc0b3fc997b0518b6490157602bb072af8",
      scorecard_uri: "ipfs://scorecard",
    },
  });

  expect(brief).toEqual(FIXTURE_BRIEF);
  expect(criteria).toBeNull(); // no criteria blob is stored
  expect(scorecard).toBeNull(); // the scorecard hash names no stored blob

  expect(entries).toEqual([
    {
      account: alice,
      entry_index: 0,
      committed_height: "65",
      content_hash: "5e3733317e9e90ee43195e1f3014d77fd85422caa8de4b8a6c6466295f56d517",
      uri: "ipfs://alice-work",
      revealed: true,
      is_team: true,
    },
    {
      account: bob,
      entry_index: 1,
      committed_height: "66",
      content_hash: BOB_ENTRY.contentHash,
      uri: BOB_ENTRY.uri,
      revealed: true,
      is_team: false,
    },
  ]);
  // The poster first, as the contract lists its funders, then the top-ups.
  expect(funders).toEqual([
    { account: poster, amount: "1000003" },
    { account: carol, amount: "500000" },
  ]);
  expect(children).toEqual(["2"]);

  // A task nobody has built on has no children, and an entry that is only committed is not revealed.
  await apply(
    taskLine(3, { invited: [], ...windowsFor("open") }),
    eventLine("committed", { task_id: "3", account: carol, block_height: "130" }),
  );
  const open = (await get<TaskDetailResponse>("/v1/tasks/3")).body;
  expect(open.children).toEqual([]);
  expect(open.task).toMatchObject({ phase: "open", outcome: null, outcome_kind: null });
  expect(open.entries).toEqual([
    {
      account: carol,
      entry_index: 0,
      committed_height: "130",
      content_hash: null,
      uri: null,
      revealed: false,
      is_team: false,
    },
  ]);
});

test("task_children_in_numeric_order", async () => {
  await seedLifecycle(deps.db);
  // Created out of order, with ids that sort differently as text ("10", "100", "9"): the children
  // come back by id as a number, neither as they were created nor as text.
  await apply(
    taskLine(100, { parent: "1" }),
    taskLine(9, { parent: "1" }),
    taskLine(10, { parent: "1" }),
  );

  const res = await get<TaskDetailResponse>("/v1/tasks/1");
  expect(res.status).toBe(200);
  expect(res.body.children).toEqual(["9", "10", "100"]);
});

test("task_pages_and_account_lists_have_a_bound", async () => {
  // Entries cost nothing to make on testnet, so a page lists at most 500 of them, in entrant
  // order; the task's commit_count says how many there are in all.
  await apply(taskLine(2, { invited: [], max_entries: 0, ...windowsFor("open") }));
  await deps.db.query(
    `insert into entries (task_id, account, entry_index, commitment, committed_height)
     select 2, 'sybil' || g || '.test.near', g, 'c', 1000 + g from generate_series(0, 500) g`,
  );
  await deps.db.query("update tasks set commit_count = 501 where id = 2");
  // 501 tasks that name task 2 as their parent, as copies of it.
  await deps.db.query(
    `insert into tasks (id, poster, token, reward, fee_bps, brief_uri, brief_hash, criteria_hash,
                        verifier, created_at, commit_deadline, reveal_deadline, pick_deadline,
                        fallback_deadline, max_entries, max_winners, invited, parent, created_height)
     select 1000 + g, poster, token, reward, fee_bps, brief_uri, brief_hash, criteria_hash,
            verifier, created_at, commit_deadline, reveal_deadline, pick_deadline,
            fallback_deadline, max_entries, max_winners, invited, 2, created_height
       from tasks, generate_series(1, 501) g
      where id = 2`,
  );

  const page = (await get<TaskDetailResponse>("/v1/tasks/2")).body;
  expect(page.entries).toHaveLength(500);
  expect(page.entries.at(-1)?.entry_index).toBe(499);
  expect(page.task.commit_count).toBe(501);
  // The children are the first 500, oldest first; the list of tasks pages through all of them.
  expect(page.children).toHaveLength(500);
  expect([page.children[0], page.children.at(-1)]).toEqual(["1001", "1500"]);
  const last = await get<ListTasksResponse>("/v1/tasks?parent=2&limit=1");
  expect(last.body.tasks[0]?.id).toBe("1501");

  // An account's list is its newest 500 entries, newest commit first.
  await deps.db.query(
    `insert into entries (task_id, account, entry_index, commitment, committed_height)
     select 1000 + g, 'busy.test.near', 0, 'c', 5000 + g from generate_series(1, 501) g`,
  );
  const busy = (await get<AccountEntriesResponse>("/v1/entries?account=busy.test.near")).body;
  expect(busy.entries).toHaveLength(500);
  expect([busy.entries[0]?.task_id, busy.entries.at(-1)?.task_id]).toEqual(["1501", "1002"]);
});

test("task_detail_returns_the_documents_the_task_points_at", async () => {
  const criteria: PublicCriteria = {
    kind: "exact",
    version: 1,
    min_score: 60,
    split: "winner_take_all",
    has_heldout: true,
    normalize: ["trim"],
  };
  const criteriaHash = await putBlob(deps.db, {
    kind: "criteria",
    contentType: "application/json",
    bytes: canonicalJson(criteria),
    isPublic: true,
  });
  const scorecard: Scorecard = {
    version: 1,
    task_id: "3",
    verifier: judge,
    kind: "exact",
    criteria_hash: criteriaHash,
    heldout_commitment: null,
    heldout: null,
    tie_break: "score desc, committed_at_block asc, account asc",
    entries: [
      {
        account: alice,
        content_hash: sha256Hex("alice work"),
        uri: "ipfs://alice-work",
        committed_at_block: "65",
        score: 100,
        passed: true,
        reasons: ["matches the expected value"],
      },
    ],
    winners: PICKED_WINNERS,
    generated_at: "2026-10-30T10:00:00Z",
    judge: { software: "tender-judge/1", model: null },
  };
  const scorecardHash = await putBlob(deps.db, {
    kind: "scorecard",
    contentType: "application/json",
    bytes: canonicalJson(scorecard),
    isPublic: true,
  });

  await apply(
    taskLine(3, { criteria_hash: criteriaHash, ...windowsFor("judging") }),
    eventLine("picked", { task_id: "3", scorecard_hash: scorecardHash }),
  );
  const { body } = await get<TaskDetailResponse>("/v1/tasks/3");
  expect(body.criteria).toEqual(criteria);
  expect(body.scorecard).toEqual(scorecard);
  expect(body.task).toMatchObject({ phase: "settled", criteria_hash: criteriaHash });
});

test("task_detail_reads_only_public_blobs_of_the_matching_kind", async () => {
  const criteria: PublicCriteria = {
    kind: "exact",
    version: 1,
    min_score: 60,
    split: "equal",
    has_heldout: false,
    normalize: [],
  };
  const scorecard = (taskId: string): Scorecard => ({
    version: 1,
    task_id: taskId,
    verifier: judge,
    kind: "exact",
    criteria_hash: sha256Hex("criteria"),
    heldout_commitment: null,
    heldout: null,
    tie_break: "score desc, committed_at_block asc, account asc",
    entries: [],
    winners: PICKED_WINNERS,
    generated_at: "2026-10-30T10:00:00Z",
    judge: { software: "tender-judge/1", model: null },
  });
  const store = (kind: BlobKind, document: unknown, isPublic: boolean) =>
    putBlob(deps.db, {
      kind,
      contentType: "application/json",
      bytes: canonicalJson(document),
      isPublic,
    });

  // Valid documents that must not be served: a held-out blob (private by nature) and a result
  // blob that happen to hold criteria, a criteria blob nobody has made public, and a brief that
  // is still private. The hashes come from the chain, where the poster chose them.
  const asHeldout = await store("heldout", { ...criteria, min_score: 50 }, false);
  const asResult = await store("result", { ...criteria, min_score: 51 }, true);
  const privateCriteria = await store("criteria", { ...criteria, min_score: 61 }, false);
  const privateBrief = await store("brief", { ...FIXTURE_BRIEF, title: "Not yet public" }, false);
  // Task 3 settles with the scorecard of another task, task 4 with a private scorecard of its own.
  const foreignScorecard = await store("scorecard", scorecard("9"), true);
  const privateScorecard = await store("scorecard", scorecard("4"), false);

  await apply(
    taskLine(1, { criteria_hash: asHeldout, brief_hash: privateBrief, ...windowsFor("open") }),
    taskLine(2, { criteria_hash: asResult, ...windowsFor("open") }),
    taskLine(3, { criteria_hash: privateCriteria, ...windowsFor("judging") }),
    taskLine(4, windowsFor("judging")),
    eventLine("picked", { task_id: "3", scorecard_hash: foreignScorecard }),
    eventLine("picked", { task_id: "4", scorecard_hash: privateScorecard }),
  );

  for (const id of ["1", "2", "3", "4"]) {
    const { body } = await get<TaskDetailResponse>(`/v1/tasks/${id}`);
    expect(body.criteria, `criteria of task ${id}`).toBeNull();
    expect(body.scorecard, `scorecard of task ${id}`).toBeNull();
  }
  expect((await get<TaskDetailResponse>("/v1/tasks/1")).body.brief).toBeNull();

  // Making a blob public is what lets the API serve it, and only when it is of the right kind.
  await setBlobPublic(deps.db, privateBrief, true);
  await setBlobPublic(deps.db, privateCriteria, true);
  await setBlobPublic(deps.db, privateScorecard, true);
  expect((await get<TaskDetailResponse>("/v1/tasks/1")).body.brief?.title).toBe("Not yet public");
  expect((await get<TaskDetailResponse>("/v1/tasks/3")).body.criteria?.min_score).toBe(61);
  expect((await get<TaskDetailResponse>("/v1/tasks/4")).body.scorecard?.task_id).toBe("4");
  // Public now, but it is the scorecard of task 9.
  expect((await get<TaskDetailResponse>("/v1/tasks/3")).body.scorecard).toBeNull();
});

test("task_detail_keeps_who_voided_a_task", async () => {
  await apply(taskLine(2, windowsFor("expired")), taskLine(3, windowsFor("judging")));
  // `void_task` has no account behind it; an empty pick has one.
  await apply(
    eventLine("voided", {
      task_id: "2",
      reason: "expired",
      by: null,
      scorecard_hash: null,
      scorecard_uri: null,
    }),
    eventLine("voided", { task_id: "3" }),
  );
  const expired = await get<TaskDetailResponse>("/v1/tasks/2");
  expect(expired.body.task).toMatchObject({ phase: "settled", outcome_kind: "voided" });
  expect(expired.body.task.outcome).toMatchObject({
    kind: "voided",
    reason: "expired",
    by: null,
    scorecard_hash: null,
  });
  const noAward = await get<TaskDetailResponse>("/v1/tasks/3");
  expect(noAward.body.task.outcome).toMatchObject({
    kind: "voided",
    reason: "no_award",
    by: judge,
  });
});

test("unknown_task_404", async () => {
  await seedLifecycle(deps.db);
  for (const path of [
    "/v1/tasks/999",
    "/v1/tasks/0",
    "/v1/tasks/abc",
    "/v1/tasks/18446744073709551616",
    "/v1/agents/nobody.test.near",
    "/v1/agents/NOT_AN_ACCOUNT",
    "/v1/nothing",
  ]) {
    const res = await get<{ error: string }>(path);
    expect(res.status, path).toBe(404);
    expect(res.body.error, path).toBe("not_found");
  }
  expect((await get("/v1/tasks/1")).status).toBe(200);
});

// ---- Phase ------------------------------------------------------------------------------------

test("phase_matches_contract_rules_at_boundaries", async () => {
  // Task 1 of the lifecycle, up to but not including its pick, then with it.
  await putFixtureBlobs(deps.db);
  const blocks = lifecycleBlocks();
  const pick = blocks.pop();
  for (const block of blocks) await applyBlock(deps.db, block, FIXTURE_OPTIONS);
  if (!pick) throw new Error("the lifecycle has no pick");

  const { body: start } = await get<TaskDetailResponse>("/v1/tasks/1");
  const windows = {
    commit_deadline: start.task.commit_deadline,
    reveal_deadline: start.task.reveal_deadline,
    pick_deadline: start.task.pick_deadline,
    fallback_deadline: start.task.fallback_deadline,
  };
  const deadlines = Object.values(windows).map(BigInt);
  // One before each deadline, at it and one after, and the two ends of time.
  const moments = [0n, ...deadlines.flatMap((d) => [d - 1n, d, d + 1n]), U64_MAX];

  // SQL and the TypeScript mirror of the contract's rule agree at every moment, in the list and in
  // the detail, and the phase filter selects by the same phase.
  const seen = new Set<Phase>();
  for (const settled of [false, true]) {
    if (settled) await applyBlock(deps.db, pick, FIXTURE_OPTIONS);
    for (const moment of moments) {
      nowNs = moment;
      const expected = phaseAt({ ...windows, settled }, moment);
      seen.add(expected);
      const detail = await get<TaskDetailResponse>("/v1/tasks/1");
      expect(detail.body.task.phase, `detail at ${moment}, settled ${settled}`).toBe(expected);
      const list = await get<ListTasksResponse>("/v1/tasks");
      expect(list.body.tasks[0]?.phase, `list at ${moment}, settled ${settled}`).toBe(expected);
      const filter = await get<ListTasksResponse>(`/v1/tasks?phase=${expected}`);
      expect(ids(filter.body.tasks), `filter at ${moment}, settled ${settled}`).toEqual(["1"]);
    }
  }
  expect([...seen].sort()).toEqual(
    ["open", "revealing", "judging", "fallback", "expired", "settled"].sort(),
  );

  // The brief's own check, spelled out: at the commit deadline the commit window is over.
  const commit = BigInt(windows.commit_deadline);
  await deps.db.query("update tasks set outcome = null, settled_height = null where id = 1");
  nowNs = commit - 1n;
  expect((await get<TaskDetailResponse>("/v1/tasks/1")).body.task.phase).toBe("open");
  nowNs = commit;
  expect((await get<TaskDetailResponse>("/v1/tasks/1")).body.task.phase).toBe("revealing");
});

// ---- Agents -----------------------------------------------------------------------------------

test("team_labels_follow_the_deployments_list_for_agents_entrants_and_posters", async () => {
  // The indexer stored `is_team` for the judge when it read the registration, by the list it had
  // then. The API labels by the list of the request, and by nothing stored.
  await seedLifecycle(deps.db, { teamAccounts: [judge] });
  // carol enters a task without registering as an agent, and so does an account whose parent is a
  // top-level account, which makes no provider.
  await apply(
    taskLine(2, { invited: [], ...windowsFor("open") }),
    eventLine("committed", { task_id: "2", account: carol, block_height: "120" }),
    eventLine("committed", { task_id: "2", account: "dave.near", block_height: "121" }),
  );
  const labels = async (teamAccounts: string[]) => {
    const app = appWith({ teamAccounts });
    const agents = (await get<ListAgentsResponse>("/v1/agents", app)).body.agents;
    const task = (await get<TaskDetailResponse>("/v1/tasks/2", app)).body;
    const agent = (await get<AgentDetailResponse>(`/v1/agents/${judge}`, app)).body.agent;
    return {
      agents: Object.fromEntries(agents.map((a) => [a.account, a.is_team])),
      entrants: Object.fromEntries(task.entries.map((e) => [e.account, e.is_team])),
      poster: task.task.is_team_poster,
      judge: agent.is_team,
    };
  };

  // No list, no labels, whatever was stored.
  expect(await labels([])).toEqual({
    agents: { [alice]: false, [bob]: false, [judge]: false },
    entrants: { [carol]: false, "dave.near": false },
    poster: false,
    judge: false,
  });
  // An account on the list is labelled wherever it shows, an agent or not.
  expect(await labels([judge, carol])).toEqual({
    agents: { [alice]: false, [bob]: false, [judge]: true },
    entrants: { [carol]: true, "dave.near": false },
    poster: false,
    judge: true,
  });
  // So is every account that runs under a provider on the list, by the registry's rule: the
  // fixtures' accounts are all under test.near. A top-level account, such as near, is no provider.
  expect(await labels(["test.near", "near"])).toEqual({
    agents: { [alice]: true, [bob]: true, [judge]: true },
    entrants: { [carol]: true, "dave.near": false },
    poster: true,
    judge: true,
  });
});

test("agents_list_filters_and_paginates", async () => {
  await seedLifecycle(deps.db, { teamAccounts: [judge] });

  const all = await get<ListAgentsResponse>("/v1/agents", appWith({ teamAccounts: [judge] }));
  expect(all.status).toBe(200);
  expect(all.body.next_cursor).toBeNull();
  // Ordered by account, ascending.
  expect(all.body.agents.map((a) => a.account)).toEqual([alice, bob, judge]);

  const [first, second, third] = all.body.agents;
  expect(first).toEqual({
    account: alice,
    asp: "test.near",
    name: "Alice Extractor",
    tags: ["extraction", "regex", "json"],
    profile_uri: "ipfs://alice-profile",
    profile_hash: FIXTURE_PROFILE_HASH,
    registered_height: "60",
    entries: 1,
    reveals: 1,
    wins: 1,
    earned: { [FIXTURE_TOKEN]: "665003" },
    picks_made: 0,
    voids_after_reveals: 0,
    is_team: false,
  });
  // bob's profile is not stored, so he has no name.
  expect(second).toMatchObject({
    account: bob,
    name: null,
    registered_height: "61",
    wins: 1,
    earned: { [FIXTURE_TOKEN]: "285000" },
    is_team: false,
  });
  expect(third).toMatchObject({
    account: judge,
    entries: 0,
    wins: 0,
    earned: {},
    picks_made: 1,
    is_team: true,
  });

  const names = async (query: string) =>
    (await get<ListAgentsResponse>(`/v1/agents?${query}`)).body.agents.map((a) => a.account);
  expect(await names("tag=regex")).toEqual([alice, bob, judge]);
  expect(await names("tag=nothing")).toEqual([]);
  expect(await names("asp=test.near")).toEqual([alice, bob, judge]);
  expect(await names("asp=other.near")).toEqual([]);
  expect(await names("tag=regex&asp=test.near&limit=1")).toEqual([alice]);

  const page1 = await get<ListAgentsResponse>("/v1/agents?limit=2");
  expect(page1.body.agents.map((a) => a.account)).toEqual([alice, bob]);
  expect(page1.body.next_cursor).toBe(bob);
  const page2 = await get<ListAgentsResponse>(`/v1/agents?limit=2&cursor=${bob}`);
  expect(page2.body.agents.map((a) => a.account)).toEqual([judge]);
  expect(page2.body.next_cursor).toBeNull();

  for (const query of ["limit=0", "cursor=NOT AN ACCOUNT", "asp=NOT AN ACCOUNT", "tag=Bad_Tag"]) {
    expect((await get(`/v1/agents?${query}`)).status, query).toBe(400);
  }
});

test("agent_detail_lists_recent_entries", async () => {
  await seedLifecycle(deps.db);
  // alice commits to a second task, later than her entry in task 1, and bob enters nothing there.
  await apply(
    taskLine(2, { brief_hash: FIXTURE_BRIEF_HASH, ...windowsFor("open") }),
    eventLine("committed", { task_id: "2", account: alice, block_height: "120" }),
  );

  const res = await get<AgentDetailResponse>(`/v1/agents/${alice}`);
  expect(res.status).toBe(200);
  const listed = (await get<ListAgentsResponse>("/v1/agents")).body.agents[0];
  expect(res.body.agent).toEqual(listed);
  expect(res.body.agent.entries).toBe(2);
  // Newest activity first. She won task 1; task 2 is open and unrevealed.
  expect(res.body.recent_entries).toEqual([
    { task_id: "2", title: FIXTURE_BRIEF.title, phase: "open", revealed: false, won: false },
    { task_id: "1", title: FIXTURE_BRIEF.title, phase: "settled", revealed: true, won: true },
  ]);

  const verifier = await get<AgentDetailResponse>(`/v1/agents/${judge}`);
  expect(verifier.body.agent).toMatchObject({ picks_made: 1, wins: 0 });
  expect(verifier.body.recent_entries).toEqual([]);
});

test("agent_detail_marks_only_listed_winners_as_winners", async () => {
  await seedLifecycle(deps.db);
  // Task 2 is settled in alice's favour only; bob entered it and lost.
  await apply(
    taskLine(2, windowsFor("judging")),
    eventLine("committed", { task_id: "2", account: alice, block_height: "120" }),
    eventLine("committed", { task_id: "2", account: bob, block_height: "121" }),
    eventLine("picked", {
      task_id: "2",
      winners: [{ account: alice, bps: 10_000, amount: "950000" }],
    }),
  );
  const wonBy = async (account: string) =>
    (await get<AgentDetailResponse>(`/v1/agents/${account}`)).body.recent_entries.map(
      (e) => `${e.task_id}:${e.won}`,
    );
  expect(await wonBy(alice)).toEqual(["2:true", "1:true"]);
  expect(await wonBy(bob)).toEqual(["2:false", "1:true"]);
});

// ---- Entries ----------------------------------------------------------------------------------

test("entries_by_account", async () => {
  await seedLifecycle(deps.db);
  await apply(
    taskLine(2, { brief_hash: FIXTURE_BRIEF_HASH, ...windowsFor("open") }),
    eventLine("committed", { task_id: "2", account: alice, block_height: "120" }),
  );

  const res = await get<AccountEntriesResponse>(`/v1/entries?account=${alice}`);
  expect(res.status).toBe(200);
  expect(res.body).toEqual({
    entries: [
      {
        task_id: "2",
        title: FIXTURE_BRIEF.title,
        phase: "open",
        entry_index: 0,
        committed_height: "120",
        content_hash: null,
        uri: null,
        revealed: false,
        won: false,
      },
      {
        task_id: "1",
        title: FIXTURE_BRIEF.title,
        phase: "settled",
        entry_index: 0,
        committed_height: "65",
        content_hash: "5e3733317e9e90ee43195e1f3014d77fd85422caa8de4b8a6c6466295f56d517",
        uri: "ipfs://alice-work",
        revealed: true,
        won: true,
      },
    ],
  });

  // An account with no entries has an empty list, whether or not it is an agent.
  const none = await get<AccountEntriesResponse>(`/v1/entries?account=${carol}`);
  expect(none.status).toBe(200);
  expect(none.body).toEqual({ entries: [] });

  for (const path of [
    "/v1/entries",
    "/v1/entries?account=",
    "/v1/entries?account=NOT AN ACCOUNT",
  ]) {
    const bad = await get<{ error: string }>(path);
    expect(bad.status, path).toBe(400);
    expect(bad.body.error, path).toBe("bad_request");
  }
});

// ---- Numbers ----------------------------------------------------------------------------------

test("numbers_follow_r19", async () => {
  // R19: a u64 or u128 (ids, amounts, nanosecond times, block heights) is a decimal string, and
  // a u8, u16 or u32 or a database counter is a JSON integer.
  await seedBoard();
  await apply(eventLine("task_topped_up"));
  await deps.db.query("insert into working (task_id, account) values (1, $1)", [alice]);
  const app = appWith({ teamAccounts: [carol] });

  const decimal = (value: unknown, where: string) => {
    expect(typeof value, where).toBe("string");
    expect(String(value), where).toMatch(/^(0|[1-9][0-9]*)$/);
  };
  const integer = (value: unknown, where: string) => {
    expect(typeof value, where).toBe("number");
    expect(Number.isInteger(value), where).toBe(true);
  };
  const decimalOrNull = (value: unknown, where: string) => {
    if (value !== null) decimal(value, where);
  };

  const health = (await get<HealthResponse>("/v1/health", app)).body;
  for (const key of ["indexed_height", "chain_final_height", "lag_blocks"] as const) {
    decimal(health[key], `health.${key}`);
  }

  const summaries = (task: TaskSummary, where: string) => {
    for (const key of [
      "id",
      "reward",
      "created_at",
      "commit_deadline",
      "reveal_deadline",
      "pick_deadline",
      "fallback_deadline",
    ] as const) {
      decimal(task[key], `${where}.${key}`);
    }
    decimalOrNull(task.parent, `${where}.parent`);
    for (const key of ["commit_count", "reveal_count", "working_count"] as const) {
      integer(task[key], `${where}.${key}`);
    }
  };
  const list = (await get<ListTasksResponse>("/v1/tasks", app)).body;
  for (const task of list.tasks) summaries(task, `list[${task.id}]`);
  expect(list.next_cursor).toBeNull();
  const page = (await get<ListTasksResponse>("/v1/tasks?limit=2", app)).body;
  decimal(page.next_cursor, "list.next_cursor");

  const detail = (await get<TaskDetailResponse>("/v1/tasks/1", app)).body;
  summaries(detail.task, "detail.task");
  for (const key of ["fee_bps", "max_entries", "max_winners"] as const) {
    integer(detail.task[key], `detail.task.${key}`);
  }
  expect(detail.task.outcome?.kind).toBe("picked");
  if (detail.task.outcome?.kind === "picked") {
    decimal(detail.task.outcome.fee, "outcome.fee");
    decimal(detail.task.outcome.task_id, "outcome.task_id");
    for (const winner of detail.task.outcome.winners) {
      decimal(winner.amount, "winner.amount");
      integer(winner.bps, "winner.bps");
    }
  }
  expect(detail.entries.length).toBeGreaterThan(0);
  for (const entry of detail.entries) {
    integer(entry.entry_index, "entry.entry_index");
    decimal(entry.committed_height, "entry.committed_height");
  }
  expect(detail.funders.length).toBeGreaterThan(0);
  for (const funder of detail.funders) decimal(funder.amount, "funder.amount");
  for (const child of detail.children) decimal(child, "child");

  const agents = (await get<ListAgentsResponse>("/v1/agents", app)).body;
  expect(agents.agents.length).toBeGreaterThan(0);
  for (const agent of agents.agents) {
    decimal(agent.registered_height, `agent[${agent.account}].registered_height`);
    for (const key of [
      "entries",
      "reveals",
      "wins",
      "picks_made",
      "voids_after_reveals",
    ] as const) {
      integer(agent[key], `agent[${agent.account}].${key}`);
    }
    for (const [token, amount] of Object.entries(agent.earned)) decimal(amount, `earned.${token}`);
  }

  const entries = (await get<AccountEntriesResponse>(`/v1/entries?account=${alice}`, app)).body;
  expect(entries.entries.length).toBeGreaterThan(0);
  for (const entry of entries.entries) {
    decimal(entry.task_id, "entries.task_id");
    integer(entry.entry_index, "entries.entry_index");
    decimal(entry.committed_height, "entries.committed_height");
  }
  const recent = (await get<AgentDetailResponse>(`/v1/agents/${alice}`, app)).body.recent_entries;
  for (const entry of recent) decimal(entry.task_id, "recent_entries.task_id");
});

// ---- CORS -------------------------------------------------------------------------------------

const WEB = "https://tender.example";
const PREFLIGHT_HEADERS = "authorization,content-type,last-event-id";

async function preflight(app: Hono, origin: string, path = "/v1/tasks"): Promise<Response> {
  return await app.request(path, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": PREFLIGHT_HEADERS,
    },
  });
}

test("cors_preflight_allows_web_origin", async () => {
  const app = appWith({ network: "testnet", webOrigins: [`${WEB}/`, "https://other.example"] });

  // The configured origin may send the headers the web app sends (a trailing slash in the
  // configuration does not matter, because a browser's Origin has none).
  const ok = await preflight(app, WEB);
  expect(ok.status).toBe(204);
  expect(ok.headers.get("access-control-allow-origin")).toBe(WEB);
  const allowed = (ok.headers.get("access-control-allow-headers") ?? "").toLowerCase().split(",");
  for (const header of ["authorization", "content-type", "last-event-id"]) {
    expect(allowed, header).toContain(header);
  }
  expect(ok.headers.get("access-control-allow-methods")).toContain("POST");
  expect(
    (await preflight(app, "https://other.example")).headers.get("access-control-allow-origin"),
  ).toBe("https://other.example");

  // Any other origin gets no permission.
  const denied = await preflight(app, "https://evil.example");
  expect(denied.headers.get("access-control-allow-origin")).toBeNull();

  // Every /v1 route carries it, errors included, so the web app can read a 404.
  for (const path of ["/v1/health", "/v1/tasks", "/v1/tasks/999", "/v1/agents", "/v1/entries"]) {
    const res = await app.request(path, { headers: { Origin: WEB } });
    expect(res.headers.get("access-control-allow-origin"), path).toBe(WEB);
  }
  const unknown = await app.request("/v1/tasks/999", { headers: { Origin: WEB } });
  expect(unknown.status).toBe(404);
  expect(unknown.headers.get("access-control-allow-origin")).toBe(WEB);
  const evil = await app.request("/v1/tasks", { headers: { Origin: "https://evil.example" } });
  expect(evil.headers.get("access-control-allow-origin")).toBeNull();

  // No configured origin, no permission: the list is not a wildcard.
  const none = appWith({ network: "mainnet", webOrigins: [] });
  expect((await preflight(none, WEB)).headers.get("access-control-allow-origin")).toBeNull();

  // The sandbox allows every origin.
  const sandbox = appWith({ network: "sandbox", webOrigins: [] });
  const any = await preflight(sandbox, "http://localhost:3001");
  expect(any.status).toBe(204);
  expect(any.headers.get("access-control-allow-origin")).toBe("*");
});

// ---- Types ------------------------------------------------------------------------------------

test("tender_client_satisfies_chain_reader", () => {
  // Compiles only while `TenderClient` has the two methods, as the API reads them.
  const asReader = (client: TenderClient): ChainReader => client;
  expect(asReader).toBeTypeOf("function");
});
