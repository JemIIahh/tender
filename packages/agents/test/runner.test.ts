import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TenderError, type TxResult } from "@tender/client";
import { createStateStore, type Draft, type StateStore } from "@tender/mcp";
import {
  type AccountEntry,
  ApiError,
  computeCommitment,
  type EntryView,
  type ListTasksFilter,
  type ListTasksResponse,
  STORAGE_BYTE_COST,
  type StorageView,
  sha256Hex,
  type TenderApi,
} from "@tender/shared";
import { afterEach, expect, type Mock, test, vi } from "vitest";
import {
  type AgentChain,
  AgentMemory,
  agentTick,
  type RunAgentOptions,
  runAgent,
} from "../src/runner";
import type { Solver, TaskContext } from "../src/types";
import {
  ACCOUNT,
  entryView,
  OTHER,
  picked,
  type TaskSpec,
  TOKEN,
  taskDetailResponse,
  taskEntry,
  taskSpec,
  taskSummary,
  voided,
} from "./helpers";

// The agent runner against fakes. The API and the chain are fakes the test steers (a `World` of
// tasks that the test moves from window to window by hand), and the draft store is the real one in
// a temp directory of the test's own, because what the runner promises about a crash is a promise
// about files: the tests read them the way another process would. A "restart" is a new run (no
// memory) on the same directory.

const ANSWER = new TextEncoder().encode('{"pattern":"^a$","flags":""}');
const ANSWER_BASE64 = Buffer.from(ANSWER).toString("base64");
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** The 1 KiB of contract storage that the runner asks for before it commits, in yoctoNEAR. */
const ONE_KIB = STORAGE_BYTE_COST * 1024n;
/** Room for every entry that a test makes in one tick, with the reveals each one owes. */
const ROOMY: StorageView = {
  total: `${ONE_KIB * 64n}`,
  available: `${ONE_KIB * 64n}`,
  used_bytes: "0",
};

const tx = (txHash = "tx-1"): TxResult => ({
  txHash,
  events: [],
  returnValue: undefined,
  receipts: [],
});

/** The tasks the fake API knows, which the test moves on by changing their fields. */
class World {
  readonly tasks = new Map<number, TaskSpec>();
  /** How many tasks a page of `listTasks` holds. */
  pageSize = 50;

  add(spec: Partial<TaskSpec> & { id: number }): TaskSpec {
    const task = taskSpec(spec);
    this.tasks.set(task.id, task);
    return task;
  }

  /** What `GET /v1/tasks` gives: the tasks in the phase with the tag, newest first, a page of them. */
  page(filter: ListTasksFilter): ListTasksResponse {
    const matching = [...this.tasks.values()]
      .filter((task) => filter.phase === undefined || task.phase === filter.phase)
      .filter((task) => filter.tag === undefined || task.tags.includes(filter.tag))
      .sort((a, b) => b.id - a.id);
    const after = filter.cursor === undefined ? undefined : Number(filter.cursor);
    const rest = after === undefined ? matching : matching.filter((task) => task.id < after);
    const page = rest.slice(0, this.pageSize);
    const last = page.at(-1);
    const more = rest.length > page.length && last !== undefined;
    return { tasks: page.map(taskSummary), next_cursor: more ? String(last.id) : null };
  }

  /** What `GET /v1/entries` gives for `account`: its entries, as the index has them. */
  entriesOf(account: string): AccountEntry[] {
    return [...this.tasks.values()].flatMap((spec) =>
      (spec.entries ?? [])
        .filter((entry) => entry.account === account)
        .map((entry) => ({
          task_id: String(spec.id),
          title: `Task ${spec.id}`,
          phase: spec.phase,
          revealed: entry.revealed,
          won: false,
          entry_index: entry.entry_index,
          committed_height: entry.committed_height,
          content_hash: entry.content_hash,
          uri: entry.uri,
        })),
    );
  }
}

const unexpected = (method: string) => () => {
  throw new Error(`unexpected call to api.${method}`);
};

/** A store that lives in memory, for the tests that fake the clock and so cannot wait on a disk. */
function memoryState(): StateStore {
  const drafts = new Map<string, Draft>();
  return {
    async saveDraft(draft) {
      drafts.set(draft.taskId, draft);
    },
    async getDraft(taskId) {
      return drafts.get(taskId) ?? null;
    },
    async markRevealed(taskId, uri) {
      const draft = drafts.get(taskId);
      if (draft === undefined) throw new Error(`no draft for task ${taskId}`);
      drafts.set(taskId, { ...draft, revealedUri: uri });
    },
    async markDead(taskId, reason) {
      const draft = drafts.get(taskId);
      if (draft === undefined) throw new Error(`no draft for task ${taskId}`);
      // A draft that is dead already keeps its first reason, as in the real store.
      if (draft.dead === undefined) {
        drafts.set(taskId, { ...draft, dead: { reason, at: new Date().toISOString() } });
      }
    },
    async listDrafts() {
      return [...drafts.values()];
    },
  };
}

const dirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Harness {
  /** The state directory of the agent. */
  dir: string;
  world: World;
  /** The tags of the agent. */
  tags: string[];
  state: StateStore;
  memory: AgentMemory;
  logs: string[];
  listTasks: Mock<TenderApi["listTasks"]>;
  getTask: Mock<TenderApi["getTask"]>;
  listEntries: Mock<TenderApi["listEntries"]>;
  start: Mock<TenderApi["start"]>;
  upload: Mock<TenderApi["uploadBlob"]>;
  commit: Mock<AgentChain["commit"]>;
  reveal: Mock<AgentChain["reveal"]>;
  storage: Mock<AgentChain["storageBalanceOf"]>;
  getEntry: Mock<AgentChain["getEntry"]>;
  /** What the fake chain holds of the agent: its entry in each task a commit has landed for. */
  entries: Map<string, EntryView>;
  solve: Mock<Solver["solve"]>;
  client: AgentChain;
  api: TenderApi;
  solver: Solver;
  /** One tick of the agent, with what it remembers from the ticks before. */
  tick(): Promise<void>;
  /** The options of `runAgent`, bar the signal. */
  options(): Omit<RunAgentOptions, "signal">;
  /** The process dies and starts again: no memory, the same directory. */
  restart(): void;
}

/**
 * The agent, its fakes and its directory. `scripted` is whether the solver says it answers from
 * files, which decides whether the runner asks it before `start` or after (default: it does).
 */
async function harness(
  answer: (ctx: TaskContext) => Uint8Array | null | Promise<Uint8Array | null> = () => ANSWER,
  { scripted = true }: { scripted?: boolean } = {},
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "tender-agent-"));
  dirs.push(dir);
  const world = new World();
  const logs: string[] = [];

  const listTasks = vi.fn<TenderApi["listTasks"]>(async (filter = {}) => world.page(filter));
  const getTask = vi.fn<TenderApi["getTask"]>(async (id) => {
    const spec = world.tasks.get(Number(id));
    return spec === undefined ? null : taskDetailResponse(spec);
  });
  const listEntries = vi.fn<TenderApi["listEntries"]>(async (account) => ({
    entries: world.entriesOf(account),
  }));
  const start = vi.fn<TenderApi["start"]>(async () => ({ ok: true, working_count: 1 }));
  const upload = vi.fn<TenderApi["uploadBlob"]>(async (blob) => {
    // Stored by hash, so the same bytes are the same blob however often they are sent.
    const sha256 = sha256Hex(blob.bytes);
    return { sha256, uri: `https://api.test/v1/blobs/${sha256}` };
  });
  const api: TenderApi = {
    listTasks,
    getTask,
    start,
    uploadBlob: upload,
    listAgents: unexpected("listAgents"),
    getAgent: unexpected("getAgent"),
    listEntries,
    health: unexpected("health"),
    getScorecard: unexpected("getScorecard"),
    getBlob: unexpected("getBlob"),
    uploadHeldout: unexpected("uploadHeldout"),
    telegramLink: unexpected("telegramLink"),
    signIn: unexpected("signIn"),
  };

  // A commit that goes through leaves an entry on the chain, which `getEntry` then shows. One that
  // fails or never returns leaves none.
  const entries = new Map<string, EntryView>();
  const commit = vi.fn<AgentChain["commit"]>(async (taskId, commitment) => {
    entries.set(String(taskId), entryView(taskId, commitment));
    return tx("commit-tx");
  });
  const reveal = vi.fn<AgentChain["reveal"]>(async () => tx("reveal-tx"));
  const storage = vi.fn<AgentChain["storageBalanceOf"]>(async () => ROOMY);
  const getEntry = vi.fn<AgentChain["getEntry"]>(
    async (taskId) => entries.get(String(taskId)) ?? null,
  );
  const client: AgentChain = {
    accountId: ACCOUNT,
    commit,
    reveal,
    storageBalanceOf: storage,
    getEntry,
  };

  const solve = vi.fn<Solver["solve"]>(async (ctx) => answer(ctx));
  const solver: Solver = { name: "test", scripted, solve };

  const h: Harness = {
    dir,
    world,
    tags: ["regex"],
    state: createStateStore(dir),
    memory: new AgentMemory(),
    logs,
    listTasks,
    getTask,
    listEntries,
    start,
    upload,
    commit,
    reveal,
    storage,
    getEntry,
    entries,
    solve,
    client,
    api,
    solver,
    tick: () =>
      agentTick({
        name: "alice",
        client,
        api,
        state: h.state,
        tags: h.tags,
        solver,
        log: (line) => logs.push(line),
        memory: h.memory,
      }),
    options: () => ({
      name: "alice",
      client,
      api,
      state: h.state,
      tags: h.tags,
      solver,
      log: (line) => logs.push(line),
      pollMs: 1,
    }),
    restart() {
      h.state = createStateStore(dir);
      h.memory = new AgentMemory();
    },
  };
  return h;
}

/** The ids of the tasks the calls of a mock were made for, lowest first. */
const idsOf = (mock: {
  mock: { calls: ReadonlyArray<readonly [bigint, ...unknown[]]> };
}): bigint[] => mock.mock.calls.map(([id]) => id).sort((a, b) => Number(a - b));

// ---- Entering ---------------------------------------------------------------------------------

test("commits_once_per_task", async () => {
  const h = await harness();
  h.tags = ["regex", "coding"];
  // Listed under both of the agent's tags, and entered once.
  h.world.add({ id: 7, tags: ["regex", "coding"] });

  await h.tick();
  await h.tick();
  expect(idsOf(h.commit)).toEqual([7n]);
  expect(idsOf(h.start)).toEqual([7n]);
  expect(h.solve).toHaveBeenCalledTimes(1);
  expect(h.logs).toContain("alice: committed to task 7 tx=commit-tx");

  // A restart forgets what the run knew, and the draft remembers: the task is not entered again
  // (a second commit would have a new salt and replace the one the draft opens).
  const draft = await h.state.getDraft("7");
  h.restart();
  await h.tick();
  expect(idsOf(h.commit)).toEqual([7n]);
  expect(h.solve).toHaveBeenCalledTimes(1);
  expect(h.start).toHaveBeenCalledTimes(1);
  expect(await h.state.getDraft("7")).toEqual(draft);
});

test("draft_saved_before_commit", async () => {
  const h = await harness();
  h.world.add({ id: 7 });
  // What another process would find on disk at the moment the commit is sent: a crash right there
  // leaves exactly this.
  const found: Array<Draft | null> = [];
  h.commit.mockImplementation(async () => {
    found.push(await createStateStore(h.dir).getDraft("7"));
    return tx();
  });

  await h.tick();

  expect(found).toHaveLength(1);
  const onDisk = found[0];
  if (onDisk === null || onDisk === undefined) throw new Error("no draft on disk at the commit");
  expect(onDisk).toMatchObject({
    taskId: "7",
    contentBase64: ANSWER_BASE64,
    contentHash: sha256Hex(ANSWER),
  });
  // The commit is in flight, so the draft does not say it went through.
  expect(onDisk.committedAt).toBeUndefined();
  expect(onDisk.revealedUri).toBeUndefined();

  // The commitment on chain is the one the salt in the draft opens.
  expect(h.commit).toHaveBeenCalledWith(7n, onDisk.commitment);
  expect(onDisk.commitment).toBe(computeCommitment(7n, ACCOUNT, onDisk.contentHash, onDisk.salt));
  expect(onDisk.salt).toMatch(/^[0-9a-f]{64}$/);

  // Once the commit has gone through, the draft says so and is otherwise the same.
  expect(await h.state.getDraft("7")).toEqual({
    ...onDisk,
    committedAt: expect.stringMatching(ISO),
  });
});

test("skips_rejected_and_unmatched_tags", async () => {
  const h = await harness();
  h.tags = ["regex", "json"];
  h.world.add({
    id: 1,
    judgeStatus: "rejected",
    judgeReason: "the criteria schema cannot be\ncompiled\u001b[31m(red)",
  });
  h.world.add({ id: 2, tags: ["poetry"] });
  h.world.add({ id: 3, judgeStatus: "accepted" });
  h.world.add({ id: 4, tags: ["json"], judgeStatus: null });
  h.world.add({ id: 5, tags: ["regex", "json"], judgeStatus: "pending" });

  await h.tick();
  await h.tick();

  // One listing for each tag, by the API's own filter, a page of the most it gives.
  expect(h.listTasks.mock.calls).toEqual([
    [{ phase: "open", tag: "regex", limit: 50 }],
    [{ phase: "open", tag: "json", limit: 50 }],
    [{ phase: "open", tag: "regex", limit: 50 }],
    [{ phase: "open", tag: "json", limit: 50 }],
  ]);
  // The tasks of other tags are not looked at, and the rejected one is not even fetched.
  expect(new Set(idsOf(h.getTask))).toEqual(new Set([3n, 4n, 5n]));
  expect(idsOf(h.start)).toEqual([3n, 4n, 5n]);
  expect(idsOf(h.commit)).toEqual([3n, 4n, 5n]);

  // The Judge's reason is logged once, on one line: the newline and the escape character of a
  // stranger's text are not passed on, whatever printable text came after them.
  const skips = h.logs.filter((line) => line.includes("skipping"));
  expect(skips).toEqual([
    "alice: skipping task 1, the Judge rejected it: the criteria schema cannot be compiled [31m(red)",
  ]);
  expect(h.logs.filter((line) => /\p{Cc}/u.test(line))).toEqual([]);
});

test("a_long_reason_is_cut_at_200_code_points", async () => {
  const h = await harness();
  h.world.add({ id: 1, judgeStatus: "rejected", judgeReason: "é".repeat(300) });

  await h.tick();

  expect(h.logs).toEqual([`alice: skipping task 1, the Judge rejected it: ${"é".repeat(200)}…`]);
});

test("a_task_without_reason_is_skipped_all_the_same", async () => {
  const h = await harness();
  h.world.add({ id: 1, judgeStatus: "rejected", judgeReason: null });

  await h.tick();

  expect(h.logs).toContain("alice: skipping task 1, the Judge rejected it");
  expect(h.start).not.toHaveBeenCalled();
});

test("null_solution_marks_seen", async () => {
  // A scripted solver is asked before `start`, so a task it has no answer to is never announced.
  // Any other is asked after it, and the announcement has been made.
  for (const scripted of [true, false]) {
    const h = await harness(() => null, { scripted });
    h.world.add({ id: 7 });

    await h.tick();
    await h.tick();

    expect(h.solve, `scripted ${scripted}`).toHaveBeenCalledTimes(1);
    expect(h.start, `scripted ${scripted}`).toHaveBeenCalledTimes(scripted ? 0 : 1);
    expect(h.commit, `scripted ${scripted}`).not.toHaveBeenCalled();
    // Nothing was committed to, so nothing is kept.
    expect(await h.state.listDrafts(), `scripted ${scripted}`).toEqual([]);
    expect(h.logs.filter((line) => line === "alice: no answer for task 7")).toHaveLength(1);
  }
});

test("a_solver_that_throws_is_logged_and_not_asked_again", async () => {
  // A scripted solver and a model, each failing from inside a promise and failing at once.
  for (const scripted of [true, false]) {
    for (const atOnce of [false, true]) {
      const what = `scripted ${scripted}, ${atOnce ? "at once" : "in a promise"}`;
      const h = await harness(undefined, { scripted });
      h.world.add({ id: 7 });
      const failure = new TypeError("the model said https://llm.test/?key=SECRET is down");
      h.solve.mockImplementation(() => {
        if (atOnce) throw failure;
        return Promise.reject(failure);
      });

      await h.tick();
      await h.tick();

      expect(h.solve, what).toHaveBeenCalledTimes(1);
      // A scripted solver is asked before `start`, which then has nothing to announce.
      expect(h.start, what).toHaveBeenCalledTimes(scripted ? 0 : 1);
      expect(h.commit, what).not.toHaveBeenCalled();
      expect(h.logs, what).toEqual(["ERROR alice: the test solver failed on task 7 (TypeError)"]);
      expect(h.logs.join("\n"), what).not.toContain("SECRET");
    }
  }
});

test("hands_the_solver_the_task_its_brief_and_its_criteria", async () => {
  const h = await harness();
  const task = h.world.add({ id: 7 });

  await h.tick();

  const [ctx] = h.solve.mock.calls[0] ?? [];
  expect(ctx?.task).toEqual(taskDetailResponse(task).task);
  expect(ctx?.brief).toEqual(taskDetailResponse(task).brief);
  expect(ctx?.criteria).toEqual(taskDetailResponse(task).criteria);
});

test("a_scripted_solver_is_asked_before_start_and_start_goes_out_only_for_an_answer", async () => {
  // The solver has an answer for task 2 and none for task 1: a stranger's task is not announced.
  const h = await harness((ctx) => (ctx.task.id === "2" ? ANSWER : null));
  h.world.add({ id: 1 });
  h.world.add({ id: 2 });

  await h.tick();
  await h.tick();

  expect(idsOf(h.start)).toEqual([2n]);
  expect(idsOf(h.commit)).toEqual([2n]);
  // Each task is asked once, the task with no answer included: it is seen all the same.
  expect(h.solve).toHaveBeenCalledTimes(2);
  expect(h.logs).toContain("alice: no answer for task 1");
  // Task 2 is the newest and goes first: solve, then start, then commit.
  const order = (mock: { mock: { invocationCallOrder: number[] } }) =>
    mock.mock.invocationCallOrder[0] ?? 0;
  expect(order(h.solve)).toBeLessThan(order(h.start));
  expect(order(h.start)).toBeLessThan(order(h.commit));
});

test("a_model_solver_is_asked_after_start", async () => {
  const h = await harness(undefined, { scripted: false });
  h.world.add({ id: 7 });

  await h.tick();

  expect(idsOf(h.commit)).toEqual([7n]);
  expect(h.start.mock.invocationCallOrder[0]).toBeLessThan(
    h.solve.mock.invocationCallOrder[0] ?? 0,
  );
});

test("a_scripted_task_whose_start_fails_is_asked_again_next_tick", async () => {
  const h = await harness();
  h.world.add({ id: 7 });
  h.start.mockRejectedValueOnce(new ApiError(503, { error: "unavailable", message: "x" }));

  await h.tick();
  expect(h.logs).toContain("ERROR alice: task 7 failed (ApiError 503 unavailable)");
  expect(h.commit).not.toHaveBeenCalled();

  // Asking a scripted solver costs nothing, so the task is asked and started again.
  await h.tick();
  expect(idsOf(h.commit)).toEqual([7n]);
  expect(h.solve).toHaveBeenCalledTimes(2);
  expect(h.start).toHaveBeenCalledTimes(2);

  await h.tick();
  expect(h.solve).toHaveBeenCalledTimes(2);
});

// A solver that never settles, such as a model call stuck on a hung socket, is given up on.
test("a_solver_that_does_not_answer_in_time_is_given_up_on", async () => {
  for (const scripted of [true, false]) {
    const what = `scripted ${scripted}`;
    const h = await harness(() => new Promise<Uint8Array | null>(() => {}), { scripted });
    h.state = memoryState();
    h.world.add({ id: 7 });
    vi.useFakeTimers();

    const ticking = h.tick();
    await vi.advanceTimersByTimeAsync(119_999);
    expect(h.logs, what).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await ticking;

    // Like a null answer, but said: nothing is committed to, and the timer is gone.
    expect(h.logs, what).toEqual(["ERROR alice: the test solver took over 120000 ms on task 7"]);
    expect(h.commit, what).not.toHaveBeenCalled();
    expect(h.start, what).toHaveBeenCalledTimes(scripted ? 0 : 1);
    expect(vi.getTimerCount(), what).toBe(0);

    // The task is seen: the solver is not asked a second time in the run.
    await h.tick();
    expect(h.solve, what).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  }
});

test("the_time_a_solver_has_is_an_option", async () => {
  const h = await harness(() => new Promise<Uint8Array | null>(() => {}));
  h.state = memoryState();
  h.world.add({ id: 7 });
  vi.useFakeTimers();

  const ticking = agentTick({ ...h.options(), solveTimeoutMs: 50, memory: h.memory });
  await vi.advanceTimersByTimeAsync(49);
  expect(h.logs).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  await ticking;

  expect(h.logs).toEqual(["ERROR alice: the test solver took over 50 ms on task 7"]);
});

test("an_answer_that_comes_after_the_limit_is_dropped_and_so_is_a_late_failure", async () => {
  // The first solver answers late; the second fails late. Neither is committed to, and the late
  // failure is not an unhandled rejection (which would fail the run).
  for (const how of ["answers", "fails"] as const) {
    let finish: () => void = () => {};
    const h = await harness(
      () =>
        new Promise<Uint8Array | null>((resolve, reject) => {
          finish = how === "answers" ? () => resolve(ANSWER) : () => reject(new Error("late"));
        }),
    );
    h.state = memoryState();
    h.world.add({ id: 7 });
    vi.useFakeTimers();

    const ticking = h.tick();
    await vi.advanceTimersByTimeAsync(120_000);
    await ticking;
    finish();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(h.commit, how).not.toHaveBeenCalled();
    expect(h.logs, how).toEqual(["ERROR alice: the test solver took over 120000 ms on task 7"]);
    vi.useRealTimers();
  }
});

test("the_timer_of_a_solve_is_cleared_however_the_solver_ends", async () => {
  const h = await harness();
  h.state = memoryState();
  for (const id of [1, 2, 3]) h.world.add({ id });
  // Task 1 answers, task 2 fails in a promise and task 3 fails at once.
  h.solve.mockImplementation((ctx) => {
    if (ctx.task.id === "3") throw new TypeError("at once");
    return ctx.task.id === "2" ? Promise.reject(new TypeError("later")) : Promise.resolve(ANSWER);
  });
  vi.useFakeTimers();

  await h.tick();

  expect(idsOf(h.commit)).toEqual([1n]);
  expect(h.logs.filter((line) => line.startsWith("ERROR"))).toEqual([
    "ERROR alice: the test solver failed on task 3 (TypeError)",
    "ERROR alice: the test solver failed on task 2 (TypeError)",
  ]);
  expect(vi.getTimerCount()).toBe(0);
});

test("skips_commit_when_storage_low", async () => {
  const h = await harness();
  h.world.add({ id: 7 });
  h.storage.mockResolvedValue({
    total: "20000000000000000000",
    available: "10000000000000000000",
    used_bytes: "1",
  });

  await h.tick();
  await h.tick();

  // The account is the agent's own, and it is looked at once: the task is seen.
  expect(h.storage.mock.calls).toEqual([[ACCOUNT]]);
  expect(h.logs).toContain(`WARN storage low account=${ACCOUNT} available=10000000000000000000`);
  expect(h.logs.filter((line) => line.startsWith("WARN"))).toHaveLength(1);
  // No commit, and none of what leads up to it: no announcement on the board, no model call.
  expect(h.commit).not.toHaveBeenCalled();
  expect(h.start).not.toHaveBeenCalled();
  expect(h.solve).not.toHaveBeenCalled();
  expect(await h.state.listDrafts()).toEqual([]);
});

test("an_account_that_never_deposited_has_no_storage", async () => {
  const h = await harness();
  h.world.add({ id: 7 });
  h.storage.mockResolvedValue(null);

  await h.tick();

  expect(h.logs).toContain(`WARN storage low account=${ACCOUNT} available=0`);
  expect(h.commit).not.toHaveBeenCalled();
});

test("storage_for_a_kibibyte_is_enough_and_one_yocto_less_is_not", async () => {
  const h = await harness();
  h.world.add({ id: 1 });
  h.world.add({ id: 2 });
  // The runner checks the tasks newest first: 2 gets a balance a yocto short, then 1 gets enough.
  h.storage
    .mockResolvedValueOnce({ total: `${ONE_KIB}`, available: `${ONE_KIB - 1n}`, used_bytes: "0" })
    .mockResolvedValueOnce({ total: `${ONE_KIB}`, available: `${ONE_KIB}`, used_bytes: "0" });

  await h.tick();

  expect(idsOf(h.commit)).toEqual([1n]);
  expect(h.logs).toContain(`WARN storage low account=${ACCOUNT} available=${ONE_KIB - 1n}`);
});

/** What `n` bytes of contract storage cost, in yoctoNEAR. */
const bytes = (n: bigint) => STORAGE_BYTE_COST * n;
/** A balance with `n` bytes of contract storage free. */
const free = (n: bigint, less = 0n): StorageView => ({
  total: `${bytes(n)}`,
  available: `${bytes(n) - less}`,
  used_bytes: "0",
});
/** What each reveal still owed adds to the 1 KiB a new entry needs: 36 bytes and a 256-byte URI. */
const OWED = 292n;

/**
 * An agent that owes two reveals. Task 1 is open and task 2 is in its window, and neither is
 * revealed (the reveal of task 2 fails). Three drafts owe nothing: task 3 is revealed, the window
 * of task 4 has passed and task 5 is settled.
 */
async function owingTwoReveals(): Promise<Harness> {
  const h = await harness();
  const [, two, three, four, five] = [1, 2, 3, 4, 5].map((id) => h.world.add({ id }));
  await h.tick();
  if (two === undefined || three === undefined || four === undefined || five === undefined) {
    throw new Error("the tasks are missing");
  }
  two.phase = "revealing";
  three.phase = "revealing";
  four.phase = "judging";
  Object.assign(five, { phase: "settled", outcome: picked(5, OTHER) });
  h.reveal.mockImplementation(async (taskId) => {
    if (taskId === 2n) throw new Error("rpc down");
    return tx("reveal-tx");
  });
  await h.tick();
  expect(idsOf(h.reveal)).toEqual([2n, 3n]);
  return h;
}

test("storage_must_also_cover_the_reveals_the_agent_owes", async () => {
  // Two reveals are owed: 1 KiB and two URIs' worth is what the next entry needs.
  const enough = await owingTwoReveals();
  enough.world.add({ id: 6 });
  enough.storage.mockResolvedValue(free(1024n + 2n * OWED));
  await enough.tick();
  expect(idsOf(enough.commit)).toContain(6n);

  // A yocto less and it is turned down, with the balance said.
  const short = await owingTwoReveals();
  short.world.add({ id: 6 });
  short.storage.mockResolvedValue(free(1024n + 2n * OWED, 1n));
  await short.tick();
  expect(idsOf(short.commit)).not.toContain(6n);
  expect(short.logs).toContain(
    `WARN storage low account=${ACCOUNT} available=${bytes(1024n + 2n * OWED) - 1n}`,
  );
});

test("a_commit_made_in_the_tick_is_a_reveal_owed_by_the_next_task_of_the_tick", async () => {
  const h = await harness();
  h.world.add({ id: 1 });
  h.world.add({ id: 2 });
  // Room for one entry, and for a second only if the first owed nothing.
  h.storage.mockResolvedValue(free(1024n + OWED, 1n));

  await h.tick();

  // Newest first: task 2 is entered, and then task 1 needs 1024 + 292 bytes.
  expect(idsOf(h.commit)).toEqual([2n]);
  expect(h.logs.filter((line) => line.startsWith("WARN"))).toEqual([
    `WARN storage low account=${ACCOUNT} available=${bytes(1024n + OWED) - 1n}`,
  ]);
});

test("a_draft_given_up_owes_no_reveal", async () => {
  const h = await harness();
  h.world.add({ id: 7 });
  await crashInsideTheCommit(h);
  h.restart();
  // The contract refuses the resend for good, in a task that is still open. The draft is dead,
  // and the storage that a new entry needs is 1 KiB and nothing for the draft's reveal.
  h.commit.mockRejectedValueOnce(new TenderError("E_AUTH", "E_AUTH: the poster may not enter"));
  h.world.add({ id: 8 });
  h.storage.mockResolvedValue(free(1024n));

  await h.tick();

  expect(h.logs).toContain(
    "ERROR alice: commit to task 7 refused for good (TenderError E_AUTH), the draft is dead",
  );
  expect(idsOf(h.commit)).toEqual([7n, 7n, 8n]);
});

test("a_draft_still_waiting_for_its_commit_owes_a_reveal", async () => {
  const h = await harness();
  h.world.add({ id: 7 });
  await crashInsideTheCommit(h);
  h.restart();
  // The resend fails the way a node that is down does: the draft is neither on the chain nor dead,
  // and it will be sent again, so its reveal is owed like any other.
  h.commit.mockRejectedValueOnce(new Error("fetch failed"));
  h.world.add({ id: 8 });
  h.storage.mockResolvedValue(free(1024n));

  await h.tick();

  expect(idsOf(h.commit)).toEqual([7n, 7n]);
  expect(h.logs).toContain(`WARN storage low account=${ACCOUNT} available=${bytes(1024n)}`);
});

test("a_resend_leaves_room_for_the_reveals_of_the_drafts_that_come_after_it", async () => {
  // Task 7: its commit never went out. Tasks 8 and 9 come after it in the pass: committed, and
  // their reveals owed (review N2).
  const h = await harness();
  for (const id of [7, 8, 9]) h.world.add({ id });
  const committedAt = new Date().toISOString();
  await h.state.saveDraft(draftFor(7));
  for (const id of [8, 9]) await h.state.saveDraft(draftFor(id, { committedAt }));
  // The resend makes an entry: a kibibyte, and the two reveals owed besides. A yocto short and it
  // waits, though nothing but task 7 was ahead of it when the pass reached it.
  h.storage.mockResolvedValue(free(1024n + 2n * OWED, 1n));

  await h.tick();

  expect(h.commit).not.toHaveBeenCalled();
  expect(h.logs).toEqual([
    `WARN storage low account=${ACCOUNT} available=${bytes(1024n + 2n * OWED) - 1n}`,
  ]);

  h.storage.mockResolvedValue(free(1024n + 2n * OWED));
  await h.tick();
  expect(idsOf(h.commit)).toEqual([7n]);
});

test("a_resend_is_not_held_back_by_drafts_that_owe_no_reveal", async () => {
  const h = await harness();
  const [, , nine] = [7, 8, 9].map((id) => h.world.add({ id }));
  if (nine === undefined) throw new Error("the tasks are missing");
  // Task 8 is revealed and the window of task 9 has passed: neither owes a reveal, and the draft
  // being sent again owes its own, which the kibibyte of the entry covers.
  nine.phase = "judging";
  const committedAt = new Date().toISOString();
  await h.state.saveDraft(draftFor(7));
  await h.state.saveDraft(draftFor(8, { committedAt, revealedUri: "https://api.test/v1/blobs/x" }));
  await h.state.saveDraft(draftFor(9, { committedAt }));
  h.storage.mockResolvedValue(free(1024n));

  await h.tick();

  expect(idsOf(h.commit)).toEqual([7n]);
  expect(h.logs).toEqual(["alice: committed to task 7 tx=commit-tx (sent again)"]);
});

test("a_start_that_fails_is_tried_again_and_costs_no_model_call", async () => {
  // The solver is a model here: `start` comes first, and a task that cannot be started costs no
  // call.
  const h = await harness(undefined, { scripted: false });
  h.world.add({ id: 7 });
  h.start.mockRejectedValueOnce(new ApiError(503, { error: "unavailable", message: "x" }));

  await h.tick();
  expect(h.logs).toContain("ERROR alice: task 7 failed (ApiError 503 unavailable)");
  expect(h.solve).not.toHaveBeenCalled();

  await h.tick();
  expect(h.solve).toHaveBeenCalledTimes(1);
  expect(idsOf(h.commit)).toEqual([7n]);
});

test("a_task_the_index_cannot_show_yet_is_looked_at_again", async () => {
  const h = await harness();
  const task = h.world.add({ id: 7, documents: false });

  await h.tick();
  expect(h.start).not.toHaveBeenCalled();
  expect(h.storage).not.toHaveBeenCalled();

  // The brief and the criteria turn up, and then the task is entered.
  task.documents = true;
  await h.tick();
  expect(idsOf(h.commit)).toEqual([7n]);
});

test("a_task_that_is_no_longer_open_is_not_started", async () => {
  const h = await harness();
  const task = h.world.add({ id: 7 });
  // The listing says open, and by the time the task is fetched its commit window has ended.
  h.listTasks.mockResolvedValueOnce({ tasks: [taskSummary(task)], next_cursor: null });
  task.phase = "revealing";

  await h.tick();

  expect(h.getTask).toHaveBeenCalledTimes(1);
  expect(h.start).not.toHaveBeenCalled();
  expect(h.commit).not.toHaveBeenCalled();
});

test("one_task_that_fails_does_not_stop_the_others", async () => {
  const h = await harness();
  h.world.add({ id: 1 });
  h.world.add({ id: 2 });
  h.world.add({ id: 3 });
  h.getTask.mockImplementation(async (id) => {
    if (id === 2n) throw new TypeError("fetch failed");
    const spec = h.world.tasks.get(Number(id));
    return spec === undefined ? null : taskDetailResponse(spec);
  });

  await h.tick();

  expect(idsOf(h.commit)).toEqual([1n, 3n]);
  expect(h.logs).toContain("ERROR alice: task 2 failed (TypeError)");
});

test("a_listing_that_fails_does_not_stop_the_other_tags", async () => {
  const h = await harness();
  h.tags = ["regex", "json"];
  h.world.add({ id: 1, tags: ["json"] });
  h.listTasks.mockRejectedValueOnce(new ApiError(500, "boom"));

  await h.tick();

  expect(h.logs).toContain(
    "ERROR alice: listing the open tasks tagged regex failed (ApiError 500)",
  );
  expect(idsOf(h.commit)).toEqual([1n]);
});

test("follows_the_cursor_through_every_page", async () => {
  const h = await harness();
  h.world.pageSize = 2;
  for (const id of [1, 2, 3, 4, 5]) h.world.add({ id });

  await h.tick();

  expect(h.listTasks.mock.calls).toEqual([
    [{ phase: "open", tag: "regex", limit: 50 }],
    [{ phase: "open", tag: "regex", limit: 50, cursor: "4" }],
    [{ phase: "open", tag: "regex", limit: 50, cursor: "2" }],
  ]);
  expect(idsOf(h.commit)).toEqual([1n, 2n, 3n, 4n, 5n]);
});

test("a_cursor_that_never_ends_does_not_end_the_tick_for_good", async () => {
  const h = await harness();
  h.listTasks.mockResolvedValue({ tasks: [], next_cursor: "1" });

  await h.tick();

  expect(h.listTasks).toHaveBeenCalledTimes(10);
});

// ---- What the API says is checked -------------------------------------------------------------

test("a_listing_that_ignores_the_tag_is_not_trusted", async () => {
  const h = await harness();
  h.world.add({ id: 1 });
  h.world.add({ id: 2, tags: ["poetry"] });
  h.world.add({ id: 3, tags: ["poetry", "coding"] });
  // An API that ignores the tag it was asked for gives every open task.
  h.listTasks.mockImplementation(async () => ({
    tasks: [...h.world.tasks.values()].map(taskSummary),
    next_cursor: null,
  }));

  await h.tick();

  // Only the task with the tag is looked at, started and answered, and the others are counted.
  expect(idsOf(h.getTask)).toEqual([1n]);
  expect(idsOf(h.start)).toEqual([1n]);
  expect(idsOf(h.commit)).toEqual([1n]);
  expect(h.logs).toContain("WARN alice: the API listed 2 tasks without the tag regex, skipped");

  h.world.tasks.delete(3);
  h.logs.length = 0;
  await h.tick();
  expect(h.logs).toEqual(["WARN alice: the API listed 1 task without the tag regex, skipped"]);
});

test("a_page_is_cut_to_the_50_tasks_asked_for", async () => {
  const h = await harness();
  for (let id = 1; id <= 60; id++) h.world.add({ id });
  // An API that gives 60 in a page, whatever limit it was asked for. Newest first: 60 down to 1.
  h.listTasks.mockImplementationOnce(async () => ({
    tasks: [...h.world.tasks.values()].sort((a, b) => b.id - a.id).map(taskSummary),
    next_cursor: null,
  }));

  await h.tick();

  const entered = idsOf(h.commit);
  expect(entered).toHaveLength(50);
  expect(entered[0]).toBe(11n);
  expect(entered.at(-1)).toBe(60n);
});

test("an_id_that_is_not_a_task_id_is_skipped_with_a_warning", async () => {
  const h = await harness();
  const task = h.world.add({ id: 7 });
  // `BigInt` reads each of the first five as 7, and the sixth is more than a u64. The last one
  // carries an escape sequence, which the log must not pass on.
  const spelled = ["07", " 7 ", "0x7", "+7", "7\n", "18446744073709551616", "7\u001b[31m"];
  h.listTasks.mockResolvedValueOnce({
    tasks: spelled.map((id) => ({ ...taskSummary(task), id })),
    next_cursor: null,
  });

  await h.tick();

  expect(h.getTask).not.toHaveBeenCalled();
  expect(h.start).not.toHaveBeenCalled();
  expect(h.solve).not.toHaveBeenCalled();
  expect(await h.state.listDrafts()).toEqual([]);
  const warnings = h.logs.filter((line) => line.startsWith("WARN"));
  expect(warnings).toHaveLength(spelled.length);
  expect(warnings[0]).toBe("WARN alice: skipping a listed task whose id is not a task id (07)");
  expect(warnings[1]).toBe("WARN alice: skipping a listed task whose id is not a task id (7)");
  expect(warnings.at(-1)).toBe(
    "WARN alice: skipping a listed task whose id is not a task id (7 [31m)",
  );
  expect(h.logs.filter((line) => /\p{Cc}/u.test(line))).toEqual([]);
});

test("a_detail_for_another_task_is_not_acted_on", async () => {
  const h = await harness();
  h.world.add({ id: 7 });
  // The brief and the criteria are those of task 8: the solver would answer one task and the
  // agent would enter another.
  h.getTask.mockImplementationOnce(async () => taskDetailResponse(taskSpec({ id: 8 })));

  await h.tick();

  expect(h.logs).toEqual(["WARN alice: skipping task 7, the API answered with another task"]);
  expect(h.start).not.toHaveBeenCalled();
  expect(h.solve).not.toHaveBeenCalled();
  expect(h.commit).not.toHaveBeenCalled();

  // Nothing is remembered of it: the API may answer right the next time.
  await h.tick();
  expect(idsOf(h.commit)).toEqual([7n]);
});

test("a_detail_for_another_task_does_not_settle_or_reveal_a_draft", async () => {
  const h = await harness();
  const task = h.world.add({ id: 7 });
  await h.tick();
  task.phase = "revealing";
  // The API answers for task 7 with the detail of task 8, which is settled and was lost.
  h.getTask.mockImplementationOnce(async () =>
    taskDetailResponse(taskSpec({ id: 8, phase: "settled", outcome: picked(8, OTHER) })),
  );

  await h.tick();

  expect(h.logs).toContain("WARN alice: task 7 not tended, the API answered with another task");
  expect(h.logs.filter((line) => /: (won|lost|refunded) /.test(line))).toEqual([]);
  expect(h.reveal).not.toHaveBeenCalled();

  // The draft was not given up for the run: the next tick reveals it.
  await h.tick();
  expect(idsOf(h.reveal)).toEqual([7n]);
});

test("a_draft_whose_task_id_is_not_a_task_id_is_not_tended", async () => {
  const h = await harness();
  // A store that does not check ids, as the real one does.
  h.state = memoryState();
  const contentHash = sha256Hex(ANSWER);
  const salt = "a".repeat(64);
  await h.state.saveDraft({
    taskId: "07",
    contentBase64: ANSWER_BASE64,
    contentHash,
    salt,
    commitment: computeCommitment(7n, ACCOUNT, contentHash, salt),
    committedAt: new Date().toISOString(),
  });

  await h.tick();

  expect(h.getTask).not.toHaveBeenCalled();
  expect(h.logs).toEqual(["WARN alice: skipping a draft whose task id is not a task id (07)"]);
});

// ---- Tasks the agent is turned down from ------------------------------------------------------

test("a_task_the_contract_would_refuse_is_skipped_before_start_and_the_solver", async () => {
  const refused: Array<[Partial<TaskSpec>, string]> = [
    [{ poster: ACCOUNT }, "the agent is its poster"],
    [{ verifier: ACCOUNT }, "the agent is its verifier"],
    [{ invited: [OTHER] }, "it takes invited entrants only and the agent is not one"],
    [{ maxEntries: 3, commitCount: 3 }, "it has all the entries it takes"],
    [{ maxEntries: 3, commitCount: 4 }, "it has all the entries it takes"],
  ];
  for (const [spec, why] of refused) {
    const h = await harness(undefined, { scripted: false });
    h.world.add({ id: 7, ...spec });

    await h.tick();
    await h.tick();

    expect(h.logs, why).toEqual([`alice: skipping task 7, ${why}`]);
    // Neither the board nor a model nor the storage view was bothered, and it is seen: not fetched
    // a second time.
    expect(h.start, why).not.toHaveBeenCalled();
    expect(h.solve, why).not.toHaveBeenCalled();
    expect(h.storage, why).not.toHaveBeenCalled();
    expect(h.getTask, why).toHaveBeenCalledTimes(1);
  }
});

test("a_task_the_contract_takes_the_agent_in_is_entered", async () => {
  const h = await harness();
  h.world.add({ id: 1, invited: [OTHER, ACCOUNT] });
  h.world.add({ id: 2, maxEntries: 3, commitCount: 2 });
  h.world.add({ id: 3, maxEntries: 0, commitCount: 99 });
  h.world.add({ id: 4, poster: OTHER });

  await h.tick();

  expect(idsOf(h.commit)).toEqual([1n, 2n, 3n, 4n]);
  expect(h.logs.filter((line) => line.includes("skipping"))).toEqual([]);
});

test("a_task_rejected_since_the_listing_is_skipped_on_the_fresher_detail", async () => {
  const h = await harness();
  const task = h.world.add({ id: 7, judgeStatus: "pending" });
  // The listing is a moment old: it says pending, and by the time the task is fetched it is not.
  h.listTasks.mockResolvedValueOnce({ tasks: [taskSummary(task)], next_cursor: null });
  Object.assign(task, { judgeStatus: "rejected", judgeReason: "the criteria cannot be compiled" });

  await h.tick();
  await h.tick();

  expect(h.logs).toEqual([
    "alice: skipping task 7, the Judge rejected it: the criteria cannot be compiled",
  ]);
  expect(h.start).not.toHaveBeenCalled();
  expect(h.storage).not.toHaveBeenCalled();
  // Seen, as the listing's verdict would have made it: not fetched again.
  expect(h.getTask).toHaveBeenCalledTimes(1);
});

test("format_characters_and_bidi_controls_are_stripped_from_a_reason", async () => {
  const h = await harness();
  // A right-to-left override, an isolate, a zero-width space and a line separator.
  h.world.add({
    id: 1,
    judgeStatus: "rejected",
    judgeReason: "abc\u202Edef\u2066ghi\u200Bjkl\u2028mno",
  });

  await h.tick();

  expect(h.logs).toEqual(["alice: skipping task 1, the Judge rejected it: abc def ghi jkl mno"]);
  expect(h.logs.filter((line) => /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(line))).toEqual([]);
});

// ---- A commit that did not land ---------------------------------------------------------------

/**
 * A draft that `account` would have saved for task `id`, as `commit` makes one, with `overrides`
 * over it. It is written straight to the store, for the tests that need drafts of tasks the agent
 * did not enter itself in the test.
 */
function draftFor(id: number, overrides: Partial<Draft> = {}, account = ACCOUNT): Draft {
  const contentHash = sha256Hex(ANSWER);
  // Any 64 lowercase hex characters will do for a salt.
  const salt = sha256Hex(`the salt of ${account} in task ${id}`);
  return {
    taskId: String(id),
    contentBase64: ANSWER_BASE64,
    contentHash,
    salt,
    commitment: computeCommitment(BigInt(id), account, contentHash, salt),
    ...overrides,
  };
}

/**
 * The process dies inside the commit, before it lands: the call never returns, and the tick is
 * left hanging, as a killed process leaves its work. Returns the draft it left on disk, which does
 * not say that the commit went through.
 */
async function crashInsideTheCommit(h: Harness): Promise<Draft> {
  h.commit.mockImplementationOnce(() => new Promise(() => {}));
  void h.tick();
  await vi.waitFor(() => expect(h.commit).toHaveBeenCalledTimes(1));
  const draft = await createStateStore(h.dir).getDraft("7");
  if (draft === null) throw new Error("the crash left no draft");
  expect(draft.committedAt).toBeUndefined();
  expect(h.entries.size).toBe(0);
  return draft;
}

/**
 * The process dies after the commit has landed, on the way to marking the draft: the chain has the
 * entry, and the draft on disk does not say so. Returns that draft.
 */
async function crashBeforeTheMark(h: Harness): Promise<Draft> {
  const real = h.state;
  let saves = 0;
  // The first save is the draft before the commit. The second is the mark, and never returns.
  h.state = {
    ...real,
    saveDraft: (draft) => (++saves === 2 ? new Promise<void>(() => {}) : real.saveDraft(draft)),
  };
  void h.tick();
  await vi.waitFor(() => expect(saves).toBe(2));
  const draft = await createStateStore(h.dir).getDraft("7");
  if (draft === null) throw new Error("the crash left no draft");
  expect(draft.committedAt).toBeUndefined();
  expect(h.entries.get("7")?.commitment).toBe(draft.commitment);
  return draft;
}

/**
 * The process dies after the commit has landed, inside the call that sent it: the chain has the
 * entry, the call never returns, and the draft on disk does not say that the commit went through.
 * Returns that draft.
 */
async function crashAfterTheCommitLanded(h: Harness): Promise<Draft> {
  h.commit.mockImplementationOnce(async (taskId, commitment) => {
    h.entries.set(String(taskId), entryView(taskId, commitment));
    return new Promise<TxResult>(() => {});
  });
  void h.tick();
  await vi.waitFor(() => expect(h.commit).toHaveBeenCalledTimes(1));
  const draft = await createStateStore(h.dir).getDraft("7");
  if (draft === null) throw new Error("the crash left no draft");
  expect(draft.committedAt).toBeUndefined();
  expect(h.entries.get("7")?.commitment).toBe(draft.commitment);
  return draft;
}

test("crash_after_save_before_commit_resends_the_same_commitment", async () => {
  const h = await harness();
  const task = h.world.add({ id: 7 });
  const saved = await crashInsideTheCommit(h);

  // The next process finds a draft that is not marked committed and asks the chain, which has no
  // entry. The task is open, so the draft's own commitment goes out again, and no solver is asked.
  h.restart();
  await h.tick();

  expect(h.getEntry).toHaveBeenCalledWith(7n, ACCOUNT);
  expect(h.commit).toHaveBeenCalledTimes(2);
  expect(h.commit.mock.calls[1]).toEqual(h.commit.mock.calls[0]);
  expect(h.commit).toHaveBeenLastCalledWith(7n, saved.commitment);
  expect(h.solve).toHaveBeenCalledTimes(1);
  expect(h.start).toHaveBeenCalledTimes(1);
  expect(h.logs).toEqual(["alice: committed to task 7 tx=commit-tx (sent again)"]);
  // The draft is what it was, with the salt and the hash it had, and now it is marked.
  expect(await h.state.getDraft("7")).toEqual({
    ...saved,
    committedAt: expect.stringMatching(ISO),
  });

  // Marked, it is taken at its word: the chain is not asked again and nothing is sent.
  await h.tick();
  expect(h.getEntry).toHaveBeenCalledTimes(1);
  expect(h.commit).toHaveBeenCalledTimes(2);

  // And what the chain holds is what the draft's salt opens.
  task.phase = "revealing";
  await h.tick();
  expect(h.entries.get("7")?.commitment).toBe(
    computeCommitment(7n, ACCOUNT, saved.contentHash, saved.salt),
  );
  expect(h.reveal).toHaveBeenCalledWith(7n, saved.contentHash, saved.salt, expect.any(String));
});

test("already_committed_counts_as_committed", async () => {
  const h = await harness();
  const task = h.world.add({ id: 7 });
  const unmarked = await crashBeforeTheMark(h);

  // The next process asks the chain, which has the entry with the draft's commitment. The commit is
  // not sent a second time (the contract would take it for a replacement), and the draft is marked.
  h.restart();
  await h.tick();

  expect(h.commit).toHaveBeenCalledTimes(1);
  expect(h.logs).toEqual([
    "alice: committed to task 7 tx=commit-tx",
    "alice: the commit to task 7 was on chain already",
  ]);
  expect(await h.state.getDraft("7")).toEqual({
    ...unmarked,
    committedAt: expect.stringMatching(ISO),
  });

  // Nothing about it is an error, in its reveal window either.
  task.phase = "revealing";
  await h.tick();
  expect(h.reveal).toHaveBeenCalledTimes(1);
  expect(h.logs.filter((line) => line.startsWith("ERROR"))).toEqual([]);
});

test("a_commit_found_on_chain_in_the_reveal_window_is_revealed_in_the_same_tick", async () => {
  const h = await harness();
  const task = h.world.add({ id: 7 });
  const unmarked = await crashBeforeTheMark(h);

  // The window moved on while the process was down.
  task.phase = "revealing";
  h.restart();
  await h.tick();

  expect(h.commit).toHaveBeenCalledTimes(1);
  expect(h.reveal).toHaveBeenCalledTimes(1);
  expect(h.reveal).toHaveBeenCalledWith(
    7n,
    unmarked.contentHash,
    unmarked.salt,
    expect.any(String),
  );
  expect(await h.state.getDraft("7")).toMatchObject({
    committedAt: expect.stringMatching(ISO),
    revealedUri: expect.any(String),
  });
});

test("a_commit_that_landed_before_a_crash_is_revealed_though_its_draft_was_never_marked", async () => {
  const h = await harness();
  const task = h.world.add({ id: 7 });
  const saved = await crashAfterTheCommitLanded(h);

  // The next process finds a draft that is not marked, asks the chain, and does not send it again.
  h.restart();
  await h.tick();
  expect(h.commit).toHaveBeenCalledTimes(1);
  expect(h.logs).toEqual(["alice: the commit to task 7 was on chain already"]);
  expect(h.reveal).not.toHaveBeenCalled();

  // Then the window opens, and the draft is uploaded and revealed with its own hash and salt.
  task.phase = "revealing";
  await h.tick();
  const uri = `https://api.test/v1/blobs/${sha256Hex(ANSWER)}`;
  expect(h.upload).toHaveBeenCalledTimes(1);
  expect(h.reveal).toHaveBeenCalledTimes(1);
  expect(h.reveal).toHaveBeenCalledWith(7n, saved.contentHash, saved.salt, uri);
  expect(await h.state.getDraft("7")).toEqual({
    ...saved,
    committedAt: expect.stringMatching(ISO),
    revealedUri: uri,
  });
});

test("a_draft_whose_mark_cannot_be_written_is_revealed_all_the_same", async () => {
  const h = await harness();
  const task = h.world.add({ id: 7 });
  const real = h.state;
  let saves = 0;
  // The first save is the draft before the commit. Every save after it, a mark, fails.
  h.state = {
    ...real,
    saveDraft: async (draft) => {
      if (++saves > 1) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      await real.saveDraft(draft);
    },
  };

  await h.tick();
  const unmarked =
    "ERROR alice: task 7 committed, but its draft could not be marked (Error ENOSPC)";
  expect(h.logs).toEqual(["alice: committed to task 7 tx=commit-tx", unmarked]);
  expect((await real.getDraft("7"))?.committedAt).toBeUndefined();

  // In its window the chain is asked, as the draft does not say. It has the commit, and the reveal
  // goes out though the mark cannot be written, and the disk is complained of each time.
  task.phase = "revealing";
  await h.tick();
  expect(h.commit).toHaveBeenCalledTimes(1);
  expect(h.reveal).toHaveBeenCalledTimes(1);
  expect((await real.getDraft("7"))?.revealedUri).toBeDefined();
  expect(h.logs.filter((line) => line === unmarked)).toHaveLength(2);

  // Revealed, the draft is not asked about again.
  await h.tick();
  expect(h.getEntry).toHaveBeenCalledTimes(1);
  expect(h.reveal).toHaveBeenCalledTimes(1);
});

test("a_commit_that_landed_is_revealed_by_a_process_that_comes_back_after_the_commit_window", async () => {
  const h = await harness();
  const task = h.world.add({ id: 7 });
  const saved = await crashAfterTheCommitLanded(h);

  // The commit window closed while the process was down. That ends the sending of commits and
  // nothing else: the chain has the entry, so the draft is not given up.
  task.phase = "revealing";
  h.restart();
  await h.tick();

  expect(h.commit).toHaveBeenCalledTimes(1);
  expect(h.reveal).toHaveBeenCalledTimes(1);
  expect(h.reveal).toHaveBeenCalledWith(7n, saved.contentHash, saved.salt, expect.any(String));
  expect(h.logs.filter((line) => line.startsWith("ERROR"))).toEqual([]);
  expect(await h.state.getDraft("7")).toMatchObject({
    committedAt: expect.stringMatching(ISO),
    revealedUri: expect.any(String),
  });
});

// The refusals of a commit that a second try meets again: the contract's, and the client's own.
const REFUSED_FOR_GOOD = [
  "E_NOT_FOUND",
  "E_PHASE",
  "E_AUTH",
  "E_INVITE",
  "E_HASH",
  "E_FULL",
  "E_ARGS",
];

test("permanent_refusal_marks_the_draft_dead_and_logs_once", async () => {
  for (const code of REFUSED_FOR_GOOD) {
    for (const atResend of [false, true]) {
      // `E_PHASE` is no verdict on a resend: the send before it may have landed just inside the
      // commit window (review N1). Its tests are below.
      if (code === "E_PHASE" && atResend) continue;
      const what = `${code} at the ${atResend ? "resend" : "first send"}`;
      const h = await harness();
      const task = h.world.add({ id: 7 });
      if (atResend) await crashInsideTheCommit(h);
      h.commit.mockRejectedValue(new TenderError(code, `${code}: refused`));
      if (atResend) h.restart();

      await h.tick();
      await h.tick();
      await h.tick();

      // Said once, with its code, and never tried again. No solver was asked a second time.
      const dead = `ERROR alice: commit to task 7 refused for good (TenderError ${code}), the draft is dead`;
      expect(h.logs, what).toEqual([dead]);
      expect(h.commit, what).toHaveBeenCalledTimes(atResend ? 2 : 1);
      expect(h.solve, what).toHaveBeenCalledTimes(1);

      // Nothing is done for it to the end of the task, and the end says nothing of it.
      task.phase = "revealing";
      await h.tick();
      Object.assign(task, { phase: "settled", outcome: picked(7, OTHER) });
      await h.tick();
      expect(h.upload, what).not.toHaveBeenCalled();
      expect(h.reveal, what).not.toHaveBeenCalled();
      expect(h.logs, what).toEqual([dead]);
    }
  }
});

/** The line that says a draft has no commit in view in its reveal window, and is waited for. */
const WAITING =
  "alice: task 7 has no commit of its draft on chain yet, looking again until its reveal window is over";
/** The line that gives a draft up once the reveal window is over with no commit of it in view. */
const GIVEN_UP =
  "ERROR alice: task 7 has no commit of its draft on chain and its reveal window is over, the draft is dead";
/** The line that says the resends of a draft are used up, so that it is only looked for from then. */
const STOPPED =
  "ERROR alice: commit to task 7 did not go through in 5 resends, not sending it again, looking for it until its reveal window is over";

test("past_commit_deadline_without_entry_is_dead", async () => {
  // Past the commit deadline and past the reveal window too (review N1): a commit that had landed
  // would be final long since, so the draft has nothing to wait for.
  for (const phase of ["judging", "fallback", "expired"] as const) {
    const h = await harness();
    const task = h.world.add({ id: 7 });
    await crashInsideTheCommit(h);

    // Both windows close while the process is down: nothing can be sent or revealed for the draft.
    task.phase = phase;
    h.restart();
    await h.tick();
    await h.tick();

    expect(h.logs, phase).toEqual([GIVEN_UP]);
    expect(h.getEntry, phase).toHaveBeenCalledTimes(1);
    expect(h.commit, phase).toHaveBeenCalledTimes(1);
    expect(h.upload, phase).not.toHaveBeenCalled();
    expect(h.reveal, phase).not.toHaveBeenCalled();

    // It stays dead to the end of the task, and the end says nothing of it.
    Object.assign(task, { phase: "settled", outcome: picked(7, OTHER) });
    await h.tick();
    expect(h.logs, phase).toEqual([GIVEN_UP]);
  }
});

test("a_draft_whose_commit_never_landed_is_retired_once_the_reveal_window_closes", async () => {
  const h = await harness();
  const task = h.world.add({ id: 7 });
  await crashInsideTheCommit(h);
  task.phase = "revealing";
  h.restart();

  // The whole reveal window: nothing can be sent now, and the chain is asked every tick, as a
  // commit that has just landed may not show yet. That is said once, and is no error.
  for (let tick = 0; tick < 4; tick++) await h.tick();
  expect(h.getEntry).toHaveBeenCalledTimes(4);
  expect(h.commit).toHaveBeenCalledTimes(1);
  expect(h.logs).toEqual([WAITING]);

  // The window closes. That is the end of the draft, said once, and the chain is not asked again.
  task.phase = "judging";
  await h.tick();
  await h.tick();
  expect(h.logs).toEqual([WAITING, GIVEN_UP]);
  expect(h.getEntry).toHaveBeenCalledTimes(5);
  expect(h.upload).not.toHaveBeenCalled();
  expect(h.reveal).not.toHaveBeenCalled();

  // And it stays dead to the end of the task, whose end says nothing of it.
  Object.assign(task, { phase: "settled", outcome: picked(7, OTHER) });
  await h.tick();
  expect(h.logs).toEqual([WAITING, GIVEN_UP]);
});

test("a_commit_that_landed_but_shows_only_after_some_ticks_is_still_revealed", async () => {
  const h = await harness();
  const task = h.world.add({ id: 7 });
  const saved = await crashAfterTheCommitLanded(h);

  // The commit window closes while the process is down. The commit is on the chain, in a block that
  // is not final: the view of the last final block has no entry for the next two lookups.
  task.phase = "revealing";
  h.restart();
  h.getEntry.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

  await h.tick();
  await h.tick();
  expect(h.getEntry).toHaveBeenCalledTimes(2);
  expect(h.commit).toHaveBeenCalledTimes(1);
  expect(h.reveal).not.toHaveBeenCalled();
  expect(h.logs).toEqual([WAITING]);

  // Then it shows, and the draft is marked and revealed in that tick, with its own hash and salt.
  await h.tick();
  expect(h.logs).toEqual([
    WAITING,
    "alice: the commit to task 7 was on chain already",
    expect.stringMatching(/^alice: revealed task 7 /),
  ]);
  expect(h.reveal).toHaveBeenCalledTimes(1);
  expect(h.reveal).toHaveBeenCalledWith(7n, saved.contentHash, saved.salt, expect.any(String));
  expect(await h.state.getDraft("7")).toMatchObject({
    committedAt: expect.stringMatching(ISO),
    revealedUri: expect.any(String),
  });
});

test("a_resend_that_meets_the_end_of_the_commit_window_is_looked_at_again_not_given_up", async () => {
  const h = await harness();
  const task = h.world.add({ id: 7 });
  const saved = await crashAfterTheCommitLanded(h);

  // The send before the crash landed just inside the window, and is not final. The index still
  // shows the task open, so the draft is sent again, and the contract says the window is over.
  h.restart();
  h.getEntry.mockResolvedValueOnce(null);
  h.commit.mockRejectedValueOnce(new TenderError("E_PHASE", "E_PHASE: past the commit deadline"));
  await h.tick();
  expect(h.commit).toHaveBeenCalledTimes(2);
  expect(h.logs).toEqual(["ERROR alice: commit to task 7 failed (TenderError E_PHASE)"]);

  // The next tick: the index shows the window, the chain shows the entry, and the draft is revealed.
  task.phase = "revealing";
  await h.tick();
  expect(h.commit).toHaveBeenCalledTimes(2);
  expect(h.reveal).toHaveBeenCalledWith(7n, saved.contentHash, saved.salt, expect.any(String));
  expect(h.logs.filter((line) => line.includes("dead"))).toEqual([]);
});

test("a_resend_refused_with_E_PHASE_for_a_commit_that_never_landed_ends_with_the_reveal_window", async () => {
  const h = await harness();
  const task = h.world.add({ id: 7 });
  await crashInsideTheCommit(h);

  // The index is a tick behind the contract: it shows the task open when the window is over.
  h.restart();
  h.commit.mockRejectedValueOnce(new TenderError("E_PHASE", "E_PHASE: past the commit deadline"));
  await h.tick();
  expect(h.logs).toEqual(["ERROR alice: commit to task 7 failed (TenderError E_PHASE)"]);

  task.phase = "revealing";
  await h.tick();
  expect(h.logs.at(-1)).toBe(WAITING);

  task.phase = "judging";
  await h.tick();
  expect(h.logs.at(-1)).toBe(GIVEN_UP);
  expect(h.commit).toHaveBeenCalledTimes(2);
  expect(h.reveal).not.toHaveBeenCalled();
});

test("a_commit_that_fails_for_now_is_sent_again_on_a_later_tick", async () => {
  // A node that is down, a balance that someone can top up, a failure the client cannot name: none
  // of them is known to repeat.
  const failures: Array<[unknown, string]> = [
    [new Error("fetch failed"), "Error"],
    [new TenderError("E_STORAGE", "E_STORAGE: not registered"), "TenderError E_STORAGE"],
    [new TenderError("E_UNKNOWN", "a failure the client cannot name"), "TenderError E_UNKNOWN"],
  ];
  for (const [failure, shown] of failures) {
    const h = await harness();
    h.world.add({ id: 7 });
    h.commit.mockRejectedValueOnce(failure);

    await h.tick();
    const draft = await h.state.getDraft("7");
    expect(draft?.committedAt, shown).toBeUndefined();
    expect(h.logs, shown).toEqual([`ERROR alice: commit to task 7 failed (${shown})`]);

    // The next tick sends the draft's commitment again. No solver is asked a second time.
    await h.tick();
    expect(h.commit.mock.calls[1], shown).toEqual([7n, draft?.commitment]);
    expect(h.solve, shown).toHaveBeenCalledTimes(1);
    expect(h.logs.at(-1), shown).toBe("alice: committed to task 7 tx=commit-tx (sent again)");
    expect(await h.state.getDraft("7"), shown).toEqual({
      ...draft,
      committedAt: expect.stringMatching(ISO),
    });
    await h.tick();
    expect(h.commit, shown).toHaveBeenCalledTimes(2);
  }
});

test("a_commit_that_keeps_failing_is_sent_again_five_times_and_then_only_looked_for", async () => {
  const h = await harness();
  h.world.add({ id: 7 });
  // A node that is down: no code, so nothing in it says the commit will never go through.
  h.commit.mockRejectedValue(new Error("fetch failed"));

  // The send that enters the task, and five resends. The first is not a resend.
  for (let tick = 0; tick < 6; tick++) await h.tick();
  const failed = "ERROR alice: commit to task 7 failed (Error)";
  expect(h.commit).toHaveBeenCalledTimes(6);
  expect(h.logs).toEqual(Array(6).fill(failed));

  // The next tick asks the chain once more, finds nothing, and sends no more, which is said once.
  // It is not the end of the draft (review R1): the last resend may have landed, so the chain is
  // asked on every tick from here on.
  await h.tick();
  expect(h.logs.at(-1)).toBe(STOPPED);
  await h.tick();
  await h.tick();
  expect(h.commit).toHaveBeenCalledTimes(6);
  expect(h.logs.filter((line) => line === STOPPED)).toHaveLength(1);
  expect(h.logs).toHaveLength(7);
  expect(h.logs.filter((line) => line.includes("dead"))).toEqual([]);
  // One lookup for each tick but the first, which entered the task.
  expect(h.getEntry).toHaveBeenCalledTimes(8);

  // The count is the run's: a restart starts it again.
  h.restart();
  await h.tick();
  expect(h.commit).toHaveBeenCalledTimes(7);
});

test("a_draft_whose_resends_are_used_up_is_retired_once_the_reveal_window_closes", async () => {
  const h = await harness();
  const task = h.world.add({ id: 7 });
  h.commit.mockRejectedValue(new Error("fetch failed"));
  for (let tick = 0; tick < 7; tick++) await h.tick();
  expect(h.logs.at(-1)).toBe(STOPPED);
  expect(h.commit).toHaveBeenCalledTimes(6);

  // The commit window ends. The draft is still looked for, and nothing more is said of it.
  task.phase = "revealing";
  await h.tick();
  await h.tick();
  expect(h.getEntry).toHaveBeenCalledTimes(8);
  expect(h.logs).toHaveLength(7);
  expect(h.commit).toHaveBeenCalledTimes(6);

  // The reveal window ends with no commit in view: now it is dead, once, and let alone.
  task.phase = "judging";
  await h.tick();
  await h.tick();
  expect(h.logs.filter((line) => line.includes("dead"))).toEqual([GIVEN_UP]);
  expect(h.getEntry).toHaveBeenCalledTimes(9);
  expect(h.commit).toHaveBeenCalledTimes(6);
  expect(h.upload).not.toHaveBeenCalled();
  expect(h.reveal).not.toHaveBeenCalled();
});

test("a_fifth_resend_that_lands_but_shows_two_ticks_later_is_still_revealed", async () => {
  const h = await harness();
  const task = h.world.add({ id: 7 });
  // A node that is down for the send that enters the task and for the first four resends.
  h.commit.mockRejectedValue(new Error("fetch failed"));
  for (let tick = 0; tick < 5; tick++) await h.tick();
  expect(h.commit).toHaveBeenCalledTimes(5);

  // The fifth resend lands, but the connection drops before the answer: the call fails, the entry is
  // on the chain, and the view of the last final block does not show it for the next two lookups.
  h.commit.mockImplementationOnce(async (taskId, commitment) => {
    h.entries.set(String(taskId), entryView(taskId, commitment));
    throw new Error("fetch failed");
  });
  await h.tick();
  expect(h.commit).toHaveBeenCalledTimes(6);
  const saved = await h.state.getDraft("7");
  if (saved === null) throw new Error("the draft is missing");
  expect(saved.committedAt).toBeUndefined();
  h.getEntry.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

  // The resends are used up, so nothing is sent, and the draft is not given up either (review R1).
  await h.tick();
  await h.tick();
  expect(h.commit).toHaveBeenCalledTimes(6);
  expect(h.logs.filter((line) => line.includes("dead"))).toEqual([]);

  // Then the entry shows, the draft is marked, and its reveal goes out in its window.
  await h.tick();
  expect(h.logs.at(-1)).toBe("alice: the commit to task 7 was on chain already");
  expect((await h.state.getDraft("7"))?.committedAt).toMatch(ISO);
  task.phase = "revealing";
  await h.tick();
  expect(h.reveal).toHaveBeenCalledTimes(1);
  expect(h.reveal).toHaveBeenCalledWith(7n, saved.contentHash, saved.salt, expect.any(String));
  expect(h.commit).toHaveBeenCalledTimes(6);
  expect(h.logs.filter((line) => line.includes("dead"))).toEqual([]);
});

test("a_commit_that_goes_through_on_the_fifth_resend_is_not_given_up", async () => {
  const h = await harness();
  h.world.add({ id: 7 });
  const down = new Error("fetch failed");
  // The first send and four resends fail, and the fifth resend lands.
  for (let failure = 0; failure < 5; failure++) h.commit.mockRejectedValueOnce(down);

  for (let tick = 0; tick < 6; tick++) await h.tick();

  expect(h.commit).toHaveBeenCalledTimes(6);
  expect(h.logs.at(-1)).toBe("alice: committed to task 7 tx=commit-tx (sent again)");
  expect(h.logs.filter((line) => line.includes("dead"))).toEqual([]);
  expect((await h.state.getDraft("7"))?.committedAt).toMatch(ISO);

  await h.tick();
  expect(h.commit).toHaveBeenCalledTimes(6);
});

test("a_resend_waits_for_storage_and_says_so_once", async () => {
  const h = await harness();
  h.world.add({ id: 7 });
  const saved = await crashInsideTheCommit(h);
  h.restart();
  h.storage.mockResolvedValue({ total: "0", available: "0", used_bytes: "0" });

  await h.tick();
  await h.tick();

  expect(h.commit).toHaveBeenCalledTimes(1);
  expect(h.logs).toEqual([`WARN storage low account=${ACCOUNT} available=0`]);

  // Someone tops the account up, and the next tick sends.
  h.storage.mockResolvedValue(ROOMY);
  await h.tick();
  expect(h.commit).toHaveBeenCalledTimes(2);
  expect(h.commit).toHaveBeenLastCalledWith(7n, saved.commitment);
});

test("a_resend_that_throws_costs_only_its_own_task", async () => {
  const h = await harness();
  for (const id of [7, 8]) h.world.add({ id });
  await h.state.saveDraft(draftFor(7));
  await h.state.saveDraft(draftFor(8));
  // The storage view fails for the first resend, as it does when the node is down.
  h.storage.mockRejectedValueOnce(new Error("rpc down"));

  await h.tick();

  expect(h.logs).toEqual([
    "ERROR alice: task 7 failed (Error)",
    "alice: committed to task 8 tx=commit-tx (sent again)",
  ]);
  expect(idsOf(h.commit)).toEqual([8n]);

  // And the one that failed is sent on the next tick.
  await h.tick();
  expect(idsOf(h.commit)).toEqual([7n, 8n]);
});

test("a_lookup_that_fails_sends_nothing_and_is_tried_again", async () => {
  const h = await harness();
  h.world.add({ id: 7 });
  const saved = await crashInsideTheCommit(h);
  h.restart();
  h.getEntry.mockRejectedValueOnce(new Error("rpc down"));

  await h.tick();

  // Not knowing is neither a reason to send nor a reason to give up.
  expect(h.commit).toHaveBeenCalledTimes(1);
  expect(h.logs).toEqual(["ERROR alice: the entry in task 7 cannot be read (Error)"]);

  await h.tick();
  expect(h.commit).toHaveBeenCalledTimes(2);
  expect(h.commit).toHaveBeenLastCalledWith(7n, saved.commitment);
});

test("a_lookup_that_fails_in_the_reveal_window_holds_the_reveal_back_one_tick", async () => {
  const h = await harness();
  const task = h.world.add({ id: 7 });
  const unmarked = await crashBeforeTheMark(h);
  task.phase = "revealing";
  h.restart();
  h.getEntry.mockRejectedValueOnce(new Error("rpc down"));

  // Whether the commit is on chain is not known, so nothing is revealed yet. The next tick finds out.
  await h.tick();
  expect(h.reveal).not.toHaveBeenCalled();
  await h.tick();
  expect(h.reveal).toHaveBeenCalledTimes(1);
  expect(h.reveal).toHaveBeenCalledWith(
    7n,
    unmarked.contentHash,
    unmarked.salt,
    expect.any(String),
  );
});

test("a_commit_that_is_not_known_to_have_landed_is_not_reported_on", async () => {
  const h = await harness();
  const task = h.world.add({ id: 7 });
  await crashInsideTheCommit(h);
  Object.assign(task, { phase: "settled", outcome: picked(7, OTHER) });
  h.restart();
  h.getEntry.mockRejectedValueOnce(new Error("rpc down"));

  // The chain cannot say whether the agent ever entered, so nothing is said of how it ended.
  await h.tick();
  expect(h.logs).toEqual(["ERROR alice: the entry in task 7 cannot be read (Error)"]);

  // The chain has no entry of the draft, and the commit window is over: dead, and still not
  // reported on, since it is an entry the agent never made.
  await h.tick();
  await h.tick();
  expect(h.logs.filter((line) => /: (won|lost|refunded) /.test(line))).toEqual([]);
  expect(h.logs.filter((line) => line.includes("the draft is dead"))).toHaveLength(1);
});

test("an_entry_with_another_commitment_is_not_the_drafts", async () => {
  // While the task is open, the draft's commitment replaces it, as the contract allows.
  const early = await harness();
  early.world.add({ id: 7 });
  const saved = await crashInsideTheCommit(early);
  early.entries.set("7", entryView(7n, sha256Hex("another commitment")));
  early.restart();
  await early.tick();
  expect(early.commit).toHaveBeenLastCalledWith(7n, saved.commitment);
  expect(early.entries.get("7")?.commitment).toBe(saved.commitment);

  // Past the commit deadline nothing can replace it, and the draft cannot open it. It is not
  // given up while the reveal window is open, as the entry may be what the view still shows of a
  // commit that is in a block but not final (review N1), and it is given up when the window ends.
  const late = await harness();
  const task = late.world.add({ id: 7 });
  await crashInsideTheCommit(late);
  late.entries.set("7", entryView(7n, sha256Hex("another commitment")));
  task.phase = "revealing";
  late.restart();
  await late.tick();
  expect(late.commit).toHaveBeenCalledTimes(1);
  expect(late.reveal).not.toHaveBeenCalled();
  expect(late.logs).toEqual([WAITING]);
  task.phase = "judging";
  await late.tick();
  expect(late.logs).toEqual([WAITING, GIVEN_UP]);
  expect(late.reveal).not.toHaveBeenCalled();
});

test("an_entry_that_shows_the_drafts_commitment_after_another_is_revealed", async () => {
  const h = await harness();
  const task = h.world.add({ id: 7 });
  const saved = await crashAfterTheCommitLanded(h);

  // The view still shows the commitment that the draft's commit replaced.
  h.entries.set("7", entryView(7n, sha256Hex("the commitment before")));
  task.phase = "revealing";
  h.restart();
  await h.tick();
  expect(h.reveal).not.toHaveBeenCalled();
  expect(h.logs).toEqual([WAITING]);

  // The block is final now, and the draft's commitment is the entry's.
  h.entries.set("7", entryView(7n, saved.commitment));
  await h.tick();
  expect(h.reveal).toHaveBeenCalledWith(7n, saved.contentHash, saved.salt, expect.any(String));
  expect(h.logs.filter((line) => line.includes("dead"))).toEqual([]);
});

test("a_draft_that_is_not_the_accounts_is_dead_and_nothing_is_sent_or_revealed_for_it", async () => {
  // A state directory that two accounts share (review N3): the draft for the task is the other
  // one's, or has a salt that does not open its commitment, or its parts make no commitment.
  const foreign: Array<[string, Draft]> = [
    ["another account's", draftFor(7, {}, OTHER)],
    ["a salt that does not open it", draftFor(7, { salt: sha256Hex("another salt") })],
    ["a hash that is not one", draftFor(7, { contentHash: "not a hash" })],
  ];
  for (const [what, made] of foreign) {
    // Unmarked, in a task that is open, it would be sent as this account's. Marked, in the reveal
    // window, it would be uploaded and revealed.
    for (const marked of [false, true]) {
      const label = `${what}, ${marked ? "marked" : "unmarked"}`;
      const h = await harness();
      const task = h.world.add({ id: 7 });
      const draft = marked ? { ...made, committedAt: new Date().toISOString() } : made;
      await h.state.saveDraft(draft);
      if (marked) task.phase = "revealing";

      await h.tick();
      await h.tick();

      const dead = `ERROR alice: the draft saved for task 7 was not made by ${ACCOUNT}, the draft is dead`;
      expect(h.logs, label).toEqual([dead]);
      expect(h.commit, label).not.toHaveBeenCalled();
      expect(h.getEntry, label).not.toHaveBeenCalled();
      expect(h.upload, label).not.toHaveBeenCalled();
      expect(h.reveal, label).not.toHaveBeenCalled();
      // The task is not entered over it either, which would write over the other account's salt.
      expect(h.solve, label).not.toHaveBeenCalled();
      expect(await h.state.getDraft("7"), label).toEqual(draft);
    }
  }
});

// ---- Revealing --------------------------------------------------------------------------------

test("reveals_only_in_window", async () => {
  const h = await harness();
  const task = h.world.add({ id: 7 });
  await h.tick();
  const draft = await h.state.getDraft("7");
  if (draft === null) throw new Error("the commit left no draft");

  // Before the window opens, and after it has closed, nothing is sent or uploaded.
  for (const phase of ["open", "judging", "fallback", "expired"] as const) {
    task.phase = phase;
    await h.tick();
  }
  expect(h.upload).not.toHaveBeenCalled();
  expect(h.reveal).not.toHaveBeenCalled();

  task.phase = "revealing";
  await h.tick();

  // The result goes up as a result of this task, and the reveal names the URI the upload gave.
  const uri = `https://api.test/v1/blobs/${sha256Hex(ANSWER)}`;
  expect(h.upload).toHaveBeenCalledTimes(1);
  expect(h.upload).toHaveBeenCalledWith({
    kind: "result",
    contentType: "text/plain",
    bytes: ANSWER,
    taskId: 7n,
  });
  expect(h.reveal).toHaveBeenCalledTimes(1);
  expect(h.reveal).toHaveBeenCalledWith(7n, draft.contentHash, draft.salt, uri);
  // The upload goes first: the API counts it as the entrant's only until the bytes are served.
  expect(h.upload.mock.invocationCallOrder[0]).toBeLessThan(
    h.reveal.mock.invocationCallOrder[0] ?? 0,
  );
  expect(h.logs).toContain(`alice: revealed task 7 uri=${uri}`);
  expect((await h.state.getDraft("7"))?.revealedUri).toBe(uri);

  // It is done, and a tick in the same window does not do it again.
  await h.tick();
  expect(h.upload).toHaveBeenCalledTimes(1);
  expect(h.reveal).toHaveBeenCalledTimes(1);
  // A draft marked committed is taken at its word: the chain is not asked about it.
  expect(h.getEntry).not.toHaveBeenCalled();
});

test("a_reveal_survives_a_restart", async () => {
  const h = await harness();
  const task = h.world.add({ id: 7 });
  await h.tick();

  // The process that committed is gone by the time the window opens.
  h.restart();
  task.phase = "revealing";
  await h.tick();

  expect(h.reveal).toHaveBeenCalledTimes(1);
  expect((await h.state.getDraft("7"))?.revealedUri).toMatch(/^https:\/\/api\.test\/v1\/blobs\//);
});

test("a_reveal_that_is_due_goes_out_before_the_tick_asks_a_solver", async () => {
  const h = await harness();
  const seven = h.world.add({ id: 7 });
  await h.tick();

  // Task 7 is in its window and task 8 is new. A solver can take minutes on task 8, and the
  // window of task 7 does not wait for it.
  seven.phase = "revealing";
  h.world.add({ id: 8 });
  const revealsWhenAsked: number[] = [];
  h.solve.mockImplementation(async () => {
    revealsWhenAsked.push(h.reveal.mock.calls.length);
    return ANSWER;
  });
  await h.tick();

  expect(idsOf(h.commit)).toEqual([7n, 8n]);
  expect(idsOf(h.reveal)).toEqual([7n]);
  expect(revealsWhenAsked).toEqual([1]);
});

test("crash_between_upload_and_reveal_retries", async () => {
  const h = await harness();
  const task = h.world.add({ id: 7 });
  await h.tick();
  task.phase = "revealing";

  // The process dies inside the reveal, once the upload is done: it never comes back from it, and
  // nothing after it runs. The tick is left hanging, as a killed process leaves its work.
  h.reveal.mockImplementationOnce(() => new Promise(() => {}));
  void h.tick();
  await vi.waitFor(() => expect(h.reveal).toHaveBeenCalledTimes(1));
  expect(h.upload).toHaveBeenCalledTimes(1);
  const afterCrash = await createStateStore(h.dir).getDraft("7");
  expect(afterCrash?.revealedUri).toBeUndefined();

  // The next process finds the draft unrevealed and does both again, with the same bytes and the
  // same hash and salt, so that the reveal opens the commit that is on chain.
  h.restart();
  await h.tick();

  expect(h.upload).toHaveBeenCalledTimes(2);
  expect(h.upload.mock.calls[1]).toEqual(h.upload.mock.calls[0]);
  expect(h.reveal).toHaveBeenCalledTimes(2);
  expect(h.reveal.mock.calls[1]).toEqual(h.reveal.mock.calls[0]);
  expect((await h.state.getDraft("7"))?.revealedUri).toBe(
    `https://api.test/v1/blobs/${sha256Hex(ANSWER)}`,
  );
});

test("a_step_that_fails_is_retried_from_the_top", async () => {
  const h = await harness();
  const task = h.world.add({ id: 7 });
  await h.tick();
  task.phase = "revealing";

  // The index has not seen the commit yet (the API says 403), and then the node is behind (the
  // contract says E_PHASE). Neither stops the next tick from trying again.
  h.upload.mockRejectedValueOnce(new ApiError(403, { error: "forbidden", message: "x" }));
  await h.tick();
  expect(h.logs).toContain("ERROR alice: upload for task 7 failed (ApiError 403 forbidden)");
  expect(h.reveal).not.toHaveBeenCalled();

  h.reveal.mockRejectedValueOnce(new TenderError("E_PHASE", "E_PHASE: not in its reveal window"));
  await h.tick();
  expect(h.logs).toContain("ERROR alice: reveal of task 7 failed (TenderError E_PHASE)");
  expect((await h.state.getDraft("7"))?.revealedUri).toBeUndefined();

  await h.tick();
  expect(h.reveal).toHaveBeenCalledTimes(2);
  expect((await h.state.getDraft("7"))?.revealedUri).toBeDefined();
});

test("a_reveal_that_was_done_already_marks_the_draft", async () => {
  const h = await harness();
  const task = h.world.add({ id: 7 });
  await h.tick();
  task.phase = "revealing";
  // A crash after the reveal went through left the draft unmarked, and the contract now says so.
  h.reveal.mockRejectedValueOnce(
    new TenderError("E_REVEALED", `E_REVEALED: ${ACCOUNT} has already revealed in task 7`),
  );

  await h.tick();
  const uri = `https://api.test/v1/blobs/${sha256Hex(ANSWER)}`;
  expect((await h.state.getDraft("7"))?.revealedUri).toBe(uri);
  expect(h.logs).toContain(`alice: revealed task 7 (it had been revealed already) uri=${uri}`);
  expect(h.logs.filter((line) => line.startsWith("ERROR"))).toEqual([]);

  await h.tick();
  expect(h.reveal).toHaveBeenCalledTimes(1);
});

test("a_draft_that_cannot_be_marked_is_revealed_on_chain_and_marked_later", async () => {
  const h = await harness();
  const task = h.world.add({ id: 7 });
  await h.tick();
  task.phase = "revealing";
  const markRevealed = vi.spyOn(h.state, "markRevealed");
  markRevealed.mockRejectedValueOnce(Object.assign(new Error("disk full"), { code: "ENOSPC" }));

  await h.tick();
  expect(h.logs).toContain(
    "ERROR alice: task 7 revealed, but its draft could not be marked (Error ENOSPC)",
  );
  expect((await h.state.getDraft("7"))?.revealedUri).toBeUndefined();

  // The next tick sends the reveal again, is told it is done, and marks the draft.
  h.reveal.mockRejectedValueOnce(new TenderError("E_REVEALED", "E_REVEALED: already"));
  await h.tick();
  expect((await h.state.getDraft("7"))?.revealedUri).toBeDefined();
});

test("bytes_the_api_stored_other_than_the_committed_ones_are_not_revealed", async () => {
  const h = await harness();
  const task = h.world.add({ id: 7 });
  await h.tick();
  task.phase = "revealing";
  h.upload.mockResolvedValueOnce({
    sha256: sha256Hex("something else"),
    uri: "https://api.test/v1/blobs/else",
  });

  await h.tick();
  expect(h.reveal).not.toHaveBeenCalled();
  expect(h.logs).toContain("ERROR alice: task 7 not revealed, the API stored other bytes");

  await h.tick();
  expect(h.reveal).toHaveBeenCalledTimes(1);
});

test("a_draft_the_index_does_not_know_is_left_alone", async () => {
  const h = await harness();
  h.world.add({ id: 7 });
  await h.tick();
  h.world.tasks.clear();

  await h.tick();

  expect(h.reveal).not.toHaveBeenCalled();
  expect(h.logs.filter((line) => line.startsWith("ERROR"))).toEqual([]);
});

// ---- Outcomes ---------------------------------------------------------------------------------

test("logs_won_lost_refunded", async () => {
  const h = await harness();
  const won = h.world.add({ id: 1 });
  const lost = h.world.add({ id: 2 });
  const refunded = h.world.add({ id: 3 });
  const missed = h.world.add({ id: 4 });
  await h.tick();
  expect(idsOf(h.commit)).toEqual([1n, 2n, 3n, 4n]);

  // Tasks 1 to 3 are revealed in their window. Task 4 is not: the agent was away.
  for (const task of [won, lost, refunded]) task.phase = "revealing";
  await h.tick();
  expect(idsOf(h.reveal)).toEqual([1n, 2n, 3n]);

  // Then the picks. A task the agent never entered is settled too, and is none of its business.
  Object.assign(won, { phase: "settled", outcome: picked(1, ACCOUNT, "950000") });
  Object.assign(lost, { phase: "settled", outcome: picked(2, OTHER) });
  Object.assign(refunded, { phase: "settled", outcome: voided(3, "no_reveals") });
  Object.assign(missed, { phase: "settled", outcome: picked(4, OTHER) });
  h.world.add({ id: 5, phase: "settled", outcome: picked(5, OTHER) });
  await h.tick();

  const outcomes = h.logs.filter((line) => /: (won|lost|refunded) /.test(line));
  expect(outcomes).toEqual([
    `alice: won task 1 amount=950000 token=${TOKEN}`,
    "alice: lost task 2",
    "alice: refunded task 3 (no_reveals)",
    "alice: lost task 4 (never revealed)",
  ]);

  // Each is said once.
  await h.tick();
  await h.tick();
  expect(h.logs.filter((line) => /: (won|lost|refunded) /.test(line))).toEqual(outcomes);
});

test("never_revealed_is_said_only_when_the_api_and_the_chain_both_say_so", async () => {
  // The agent was away for the reveal windows, or revealed and lost the mark: the draft of no task
  // says it was revealed, and only the API and the chain can tell.
  const h = await harness();
  const tasks = [1, 2, 3, 4].map((id) => h.world.add({ id }));
  await h.tick();
  const uri = "https://api.test/v1/blobs/x";
  const contentHash = sha256Hex(ANSWER);
  // Task 1: the API shows the reveal. Task 2: the chain does, and the API has not caught up.
  // Task 3: neither, though the API shows another entrant's reveal. Task 4: the API has not, and
  // the chain cannot be read.
  const [one, two, three, four] = tasks;
  if (one === undefined || two === undefined || three === undefined || four === undefined) {
    throw new Error("the tasks are missing");
  }
  one.entries = [taskEntry({ revealed: true, uri, content_hash: contentHash })];
  for (const task of [two, four]) task.entries = [taskEntry()];
  three.entries = [
    taskEntry({ account: OTHER, revealed: true, uri, content_hash: contentHash }),
    taskEntry(),
  ];
  const onChain = h.entries.get("2");
  if (onChain === undefined) throw new Error("no entry on chain");
  h.entries.set("2", { ...onChain, uri, content_hash: contentHash });
  h.getEntry.mockImplementation(async (taskId) => {
    if (taskId === 4n) throw new Error("rpc down");
    return h.entries.get(String(taskId)) ?? null;
  });
  for (const task of tasks)
    Object.assign(task, { phase: "settled", outcome: picked(task.id, OTHER) });

  await h.tick();

  expect(h.logs.filter((line) => /: lost /.test(line))).toEqual([
    "alice: lost task 1",
    "alice: lost task 2",
    "alice: lost task 3 (never revealed)",
    // Not known, so not said.
    "alice: lost task 4",
  ]);
  // The chain is asked only where the API does not show the reveal.
  expect(idsOf(h.getEntry)).toEqual([2n, 3n, 4n]);
  expect(h.logs).toContain("ERROR alice: the entry in task 4 cannot be read (Error)");
});

test("never_revealed_is_not_said_of_an_entry_the_keeper_has_cleaned_up", async () => {
  const h = await harness();
  const task = h.world.add({ id: 7 });
  await h.tick();
  expect(h.commit).toHaveBeenCalledTimes(1);

  // The agent was away for the reveal window. The task settles, and the keeper's `cleanup` deletes
  // its entries, revealed or not: the chain has no entry to show whether it was revealed (review N4).
  Object.assign(task, { phase: "settled", outcome: picked(7, OTHER) });
  h.entries.delete("7");
  await h.tick();

  expect(h.getEntry).toHaveBeenCalledWith(7n, ACCOUNT);
  expect(h.logs.filter((line) => /: lost /.test(line))).toEqual(["alice: lost task 7"]);
});

test("a_settled_task_the_agent_never_entered_is_not_reported", async () => {
  const h = await harness();
  const task = h.world.add({ id: 7 });
  Object.assign(task, { phase: "settled", outcome: picked(7, OTHER) });

  await h.tick();

  expect(h.logs).toEqual([]);
});

// ---- Safety -----------------------------------------------------------------------------------

test("an_error_line_names_the_error_and_never_quotes_its_message", async () => {
  const h = await harness();
  const task = h.world.add({ id: 7 });
  await h.tick();
  task.phase = "revealing";
  const secret = "https://rpc.example/?apiKey=SECRET";

  h.upload.mockRejectedValueOnce(new TypeError(`fetch failed ${secret}`));
  await h.tick();
  h.upload.mockRejectedValueOnce(new ApiError(403, { error: "forbidden", message: secret }));
  await h.tick();
  h.reveal.mockRejectedValueOnce(new TenderError("E_STORAGE", `E_STORAGE: ${secret}`));
  await h.tick();
  // A code that is not a code is dropped.
  h.reveal.mockRejectedValueOnce(Object.assign(new Error(secret), { code: `bad ${secret}` }));
  await h.tick();
  h.reveal.mockRejectedValueOnce(secret);
  await h.tick();

  expect(h.logs.filter((line) => line.startsWith("ERROR"))).toEqual([
    "ERROR alice: upload for task 7 failed (TypeError)",
    "ERROR alice: upload for task 7 failed (ApiError 403 forbidden)",
    "ERROR alice: reveal of task 7 failed (TenderError E_STORAGE)",
    "ERROR alice: reveal of task 7 failed (Error)",
    "ERROR alice: reveal of task 7 failed (string)",
  ]);
  expect(h.logs.join("\n")).not.toContain("SECRET");
});

test("an_unreadable_draft_is_named_and_does_not_stop_the_other_tasks", async () => {
  const h = await harness();
  h.world.add({ id: 9 });
  h.world.add({ id: 10 });
  // A draft file that is not a draft: the store refuses to read it, and to guess.
  await mkdir(join(h.dir, "drafts"), { recursive: true });
  const broken = join(h.dir, "drafts", "9.json");
  await writeFile(broken, "not json");

  await h.tick();

  expect(idsOf(h.commit)).toEqual([10n]);
  expect(h.logs).toContain(
    `ERROR alice: the drafts cannot be read (draft file ${broken} is corrupt: it is not valid JSON)`,
  );
  expect(h.logs).toContain("ERROR alice: task 9 failed (Error)");
  // The file is as it was.
  expect(await createStateStore(h.dir).getDraft("10")).not.toBeNull();
});

test("a_corrupt_draft_does_not_hold_back_a_reveal_that_is_due", async () => {
  const h = await harness();
  const damaged = h.world.add({ id: 9 });
  const healthy = h.world.add({ id: 10 });
  await h.tick();

  // Both windows open and the index shows the agent's entries, unrevealed. Then one draft file goes
  // bad, so that the store refuses to list any.
  for (const task of [damaged, healthy]) Object.assign(task, { phase: "revealing" });
  for (const task of [damaged, healthy]) task.entries = [taskEntry()];
  const broken = join(h.dir, "drafts", "9.json");
  await writeFile(broken, "not json");
  // Entries that are none of its business: not in the window yet, revealed already, with no draft.
  h.world.add({ id: 11, tags: ["poetry"], entries: [taskEntry()] });
  h.world.add({
    id: 12,
    tags: ["poetry"],
    phase: "revealing",
    entries: [taskEntry({ revealed: true })],
  });
  h.world.add({ id: 13, tags: ["poetry"], phase: "revealing", entries: [taskEntry()] });
  // And one the API spells as no task id, which is not used to read a file.
  h.listEntries.mockImplementationOnce(async (account) => ({
    entries: [
      ...h.world.entriesOf(account),
      { ...h.world.entriesOf(account)[0], task_id: "07" } as AccountEntry,
    ],
  }));
  const getDraft = vi.spyOn(h.state, "getDraft");
  h.getTask.mockClear();

  await h.tick();

  // The healthy draft is revealed, and the broken one costs only its own task.
  expect(h.listEntries).toHaveBeenCalledWith(ACCOUNT);
  expect(idsOf(h.reveal)).toEqual([10n]);
  expect((await createStateStore(h.dir).getDraft("10"))?.revealedUri).toBeDefined();
  expect(h.logs).toContain(
    `ERROR alice: the drafts cannot be read (draft file ${broken} is corrupt: it is not valid JSON)`,
  );
  expect(h.logs).toContain("ERROR alice: task 9 failed (Error)");
  expect(getDraft.mock.calls.map(([id]) => id)).toEqual(["9", "10", "13"]);
  expect(idsOf(h.getTask)).toEqual([10n]);
});

test("the_entries_are_not_asked_for_while_the_drafts_can_be_read", async () => {
  const h = await harness();
  const task = h.world.add({ id: 7 });
  await h.tick();
  task.phase = "revealing";
  await h.tick();

  expect(h.reveal).toHaveBeenCalledTimes(1);
  expect(h.listEntries).not.toHaveBeenCalled();
});

test("entries_that_cannot_be_listed_leave_the_open_tasks_to_the_tick", async () => {
  const h = await harness();
  h.world.add({ id: 9 });
  h.world.add({ id: 10 });
  await mkdir(join(h.dir, "drafts"), { recursive: true });
  await writeFile(join(h.dir, "drafts", "9.json"), "not json");
  h.listEntries.mockRejectedValue(new ApiError(503, { error: "unavailable", message: "x" }));

  await h.tick();

  expect(h.logs).toContain(
    "ERROR alice: the entries of the account cannot be listed (ApiError 503 unavailable)",
  );
  expect(idsOf(h.commit)).toEqual([10n]);
});

test("an_answer_to_the_entries_that_is_no_list_is_logged_and_the_tick_goes_on", async () => {
  // A `TenderApi` that breaks its own schema (review N5): the body has no list of entries, or is
  // no body at all.
  for (const answer of [{}, { entries: "oops" }, { entries: null }, undefined, null]) {
    const h = await harness();
    h.world.add({ id: 9 });
    h.world.add({ id: 10 });
    await mkdir(join(h.dir, "drafts"), { recursive: true });
    await writeFile(join(h.dir, "drafts", "9.json"), "not json");
    h.listEntries.mockResolvedValue(answer as never);

    // The tick does not throw, and it goes on to the open tasks.
    await h.tick();

    const what = JSON.stringify(answer);
    expect(h.logs, what).toContain(
      "ERROR alice: the entries of the account cannot be listed (TypeError)",
    );
    expect(idsOf(h.commit), what).toEqual([10n]);
  }
});

test("an_entry_that_cannot_be_read_does_not_keep_the_others_from_being_tended", async () => {
  const h = await harness();
  const damaged = h.world.add({ id: 9 });
  const healthy = h.world.add({ id: 10 });
  await h.tick();
  for (const task of [damaged, healthy]) {
    Object.assign(task, { phase: "revealing", entries: [taskEntry()] });
  }
  await writeFile(join(h.dir, "drafts", "9.json"), "not json");
  // The API puts something that is no entry among the entries, ahead of the ones that are.
  h.listEntries.mockImplementationOnce(async (account) => ({
    entries: [null as never, ...h.world.entriesOf(account)],
  }));

  await h.tick();

  expect(h.logs).toContain("ERROR alice: an entry of the account cannot be read (TypeError)");
  expect(idsOf(h.reveal)).toEqual([10n]);
});

test("the_entries_set_the_storage_owed_while_the_drafts_cannot_be_read", async () => {
  const h = await harness();
  h.world.add({ id: 9 });
  await mkdir(join(h.dir, "drafts"), { recursive: true });
  await writeFile(join(h.dir, "drafts", "9.json"), "not json");
  // Two entries of the agent that are not revealed, one open and one in its window, and a third
  // that is.
  h.world.add({ id: 1, tags: ["poetry"], entries: [taskEntry()] });
  h.world.add({ id: 2, tags: ["poetry"], phase: "revealing", entries: [taskEntry()] });
  h.world.add({
    id: 3,
    tags: ["poetry"],
    phase: "revealing",
    entries: [taskEntry({ revealed: true })],
  });
  h.world.add({ id: 10 });
  h.storage.mockResolvedValue(free(1024n + 2n * OWED, 1n));

  await h.tick();

  expect(idsOf(h.commit)).toEqual([]);
  expect(h.logs).toContain(
    `WARN storage low account=${ACCOUNT} available=${bytes(1024n + 2n * OWED) - 1n}`,
  );
});

test("a_client_without_a_signer_cannot_tick", async () => {
  const h = await harness();

  await expect(
    agentTick({ ...h.options(), client: { ...h.client, accountId: undefined } }),
  ).rejects.toThrow(/no signer/);
});

// ---- The loop ---------------------------------------------------------------------------------

test("runs_a_tick_now_and_the_next_one_after_the_default_poll_interval", async () => {
  const h = await harness();
  vi.useFakeTimers();
  const controller = new AbortController();

  // No `pollMs`: 15 s.
  const { pollMs: _, ...options } = h.options();
  const done = runAgent({ ...options, state: memoryState(), signal: controller.signal });

  await vi.advanceTimersByTimeAsync(0);
  expect(h.listTasks).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(14_999);
  expect(h.listTasks).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(h.listTasks).toHaveBeenCalledTimes(2);

  controller.abort();
  await done;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.listTasks).toHaveBeenCalledTimes(2);
});

test("says_who_it_runs_as_and_that_its_solver_is_scripted", async () => {
  const h = await harness();
  const controller = new AbortController();
  controller.abort();

  await runAgent({ ...h.options(), tags: ["regex", "json"], signal: controller.signal });

  // An aborted signal runs no tick, and the first line is all there is.
  expect(h.logs).toEqual([
    `alice: running as ${ACCOUNT}, tags regex, json, test solver (scripted)`,
  ]);
  expect(h.listTasks).not.toHaveBeenCalled();
});

test("stops_at_once_when_aborted_while_it_waits", async () => {
  const h = await harness();
  const controller = new AbortController();

  const done = runAgent({ ...h.options(), pollMs: 600_000, signal: controller.signal });
  await vi.waitFor(() => expect(h.listTasks).toHaveBeenCalledTimes(1));
  controller.abort();

  await done;
  expect(h.listTasks).toHaveBeenCalledTimes(1);
});

test("an_abort_during_a_tick_finishes_the_task_in_hand_and_starts_no_other", async () => {
  const controller = new AbortController();
  const h = await harness(() => {
    controller.abort();
    return ANSWER;
  });
  h.world.add({ id: 1 });
  h.world.add({ id: 2 });

  await runAgent({ ...h.options(), signal: controller.signal });

  // Newest first: task 2 is the one in hand. Its commit goes out and its draft is marked.
  expect(h.solve).toHaveBeenCalledTimes(1);
  expect(idsOf(h.commit)).toEqual([2n]);
  expect((await h.state.getDraft("2"))?.committedAt).toMatch(ISO);
  expect(await h.state.getDraft("1")).toBeNull();
});

test("an_abort_during_the_drafts_leaves_the_others_to_the_next_tick", async () => {
  const h = await harness();
  const one = h.world.add({ id: 1 });
  const two = h.world.add({ id: 2 });
  await h.tick();
  one.phase = "revealing";
  two.phase = "revealing";

  // The first reveal is under way when the abort comes. It is seen through and marked, and the
  // draft behind it waits.
  const controller = new AbortController();
  h.reveal.mockImplementationOnce(async () => {
    controller.abort();
    return tx("reveal-tx");
  });
  await agentTick({ ...h.options(), memory: h.memory, signal: controller.signal });

  expect(idsOf(h.reveal)).toEqual([1n]);
  expect((await h.state.getDraft("1"))?.revealedUri).toBeDefined();
  expect((await h.state.getDraft("2"))?.revealedUri).toBeUndefined();

  await h.tick();
  expect(idsOf(h.reveal)).toEqual([1n, 2n]);
});

test("an_abort_during_the_resends_leaves_the_others_to_the_next_tick", async () => {
  const h = await harness();
  for (const id of [7, 8]) h.world.add({ id });
  await h.state.saveDraft(draftFor(7));
  await h.state.saveDraft(draftFor(8));

  // The first resend is under way when the abort comes. It is seen through and marked, and the
  // draft behind it waits.
  const controller = new AbortController();
  h.commit.mockImplementationOnce(async (taskId, commitment) => {
    h.entries.set(String(taskId), entryView(taskId, commitment));
    controller.abort();
    return tx("commit-tx");
  });
  await agentTick({ ...h.options(), memory: h.memory, signal: controller.signal });

  expect(idsOf(h.commit)).toEqual([7n]);
  expect((await h.state.getDraft("7"))?.committedAt).toBeDefined();
  expect((await h.state.getDraft("8"))?.committedAt).toBeUndefined();

  await h.tick();
  expect(idsOf(h.commit)).toEqual([7n, 8n]);
});

test("an_abort_during_a_listing_skips_the_listings_of_the_other_tags", async () => {
  const h = await harness();
  h.tags = ["regex", "json"];
  const controller = new AbortController();
  h.listTasks.mockImplementationOnce(async (filter = {}) => {
    controller.abort();
    return h.world.page(filter);
  });

  await agentTick({ ...h.options(), signal: controller.signal });

  expect(h.listTasks).toHaveBeenCalledTimes(1);
});

test("a_tick_that_throws_is_logged_and_the_loop_goes_on", async () => {
  const h = await harness();
  const controller = new AbortController();
  let listings = 0;
  const state: StateStore = {
    ...memoryState(),
    // Not a list: the tick throws when it goes through it.
    listDrafts: async () => {
      listings += 1;
      if (listings === 2) controller.abort();
      return undefined as unknown as Draft[];
    },
  };

  await runAgent({ ...h.options(), state, signal: controller.signal });

  expect(listings).toBe(2);
  expect(h.logs.filter((line) => line === "ERROR alice: tick failed (TypeError)")).toHaveLength(2);
});

test("refuses_a_client_without_a_signer_and_a_wait_setTimeout_cannot_keep", async () => {
  const h = await harness();
  // Aborted, so that a call that is not refused ends at once and does not run for good.
  const controller = new AbortController();
  controller.abort();
  const signal = controller.signal;

  await expect(
    runAgent({ ...h.options(), client: { ...h.client, accountId: undefined }, signal }),
  ).rejects.toThrow(/no signer/);
  for (const pollMs of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31]) {
    await expect(runAgent({ ...h.options(), pollMs, signal }), `pollMs ${pollMs}`).rejects.toThrow(
      RangeError,
    );
  }
  for (const solveTimeoutMs of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31]) {
    await expect(
      runAgent({ ...h.options(), solveTimeoutMs, signal }),
      `solveTimeoutMs ${solveTimeoutMs}`,
    ).rejects.toThrow(RangeError);
    await expect(
      agentTick({ ...h.options(), solveTimeoutMs }),
      `solveTimeoutMs ${solveTimeoutMs}`,
    ).rejects.toThrow(RangeError);
  }
  // Nothing ran for any of them.
  expect(h.logs).toEqual([]);
  expect(h.listTasks).not.toHaveBeenCalled();
});
