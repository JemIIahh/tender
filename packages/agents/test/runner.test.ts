import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TenderError, type TxResult } from "@tender/client";
import { createStateStore, type Draft, type StateStore } from "@tender/mcp";
import {
  ApiError,
  computeCommitment,
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
  OTHER,
  picked,
  type TaskSpec,
  TOKEN,
  taskDetailResponse,
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
const ROOMY: StorageView = {
  total: `${ONE_KIB * 2n}`,
  available: `${ONE_KIB * 2n}`,
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
  start: Mock<TenderApi["start"]>;
  upload: Mock<TenderApi["uploadBlob"]>;
  commit: Mock<AgentChain["commit"]>;
  reveal: Mock<AgentChain["reveal"]>;
  storage: Mock<AgentChain["storageBalanceOf"]>;
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

async function harness(
  answer: (ctx: TaskContext) => Uint8Array | null | Promise<Uint8Array | null> = () => ANSWER,
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
    listEntries: unexpected("listEntries"),
    health: unexpected("health"),
    getScorecard: unexpected("getScorecard"),
    getBlob: unexpected("getBlob"),
    uploadHeldout: unexpected("uploadHeldout"),
    telegramLink: unexpected("telegramLink"),
    signIn: unexpected("signIn"),
  };

  const commit = vi.fn<AgentChain["commit"]>(async () => tx("commit-tx"));
  const reveal = vi.fn<AgentChain["reveal"]>(async () => tx("reveal-tx"));
  const storage = vi.fn<AgentChain["storageBalanceOf"]>(async () => ROOMY);
  const client: AgentChain = {
    accountId: ACCOUNT,
    commit,
    reveal,
    storageBalanceOf: storage,
  };

  const solve = vi.fn<Solver["solve"]>(async (ctx) => answer(ctx));
  const solver: Solver = { name: "test", scripted: true, solve };

  const h: Harness = {
    dir,
    world,
    tags: ["regex"],
    state: createStateStore(dir),
    memory: new AgentMemory(),
    logs,
    listTasks,
    getTask,
    start,
    upload,
    commit,
    reveal,
    storage,
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

test("a_commit_that_fails_leaves_its_draft_and_is_not_sent_again", async () => {
  const h = await harness();
  h.world.add({ id: 7 });
  h.commit.mockRejectedValueOnce(new TenderError("E_PHASE", "E_PHASE: task 7 is not open"));

  await h.tick();
  const draft = await h.state.getDraft("7");
  expect(draft).toMatchObject({ taskId: "7", contentHash: sha256Hex(ANSWER) });
  expect(draft?.committedAt).toBeUndefined();
  expect(h.logs).toContain("ERROR alice: commit to task 7 failed (TenderError E_PHASE)");

  // Neither this run nor the next one enters the task again: the draft's salt is not replaced
  // by another commit, and the solver is not paid for twice.
  await h.tick();
  h.restart();
  await h.tick();
  expect(h.commit).toHaveBeenCalledTimes(1);
  expect(h.solve).toHaveBeenCalledTimes(1);
  expect(await h.state.getDraft("7")).toEqual(draft);
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

  // One listing for each tag, by the API's own filter.
  expect(h.listTasks.mock.calls).toEqual([
    [{ phase: "open", tag: "regex" }],
    [{ phase: "open", tag: "json" }],
    [{ phase: "open", tag: "regex" }],
    [{ phase: "open", tag: "json" }],
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
  const h = await harness(() => null);
  h.world.add({ id: 7 });

  await h.tick();
  await h.tick();

  expect(h.solve).toHaveBeenCalledTimes(1);
  expect(h.start).toHaveBeenCalledTimes(1);
  expect(h.commit).not.toHaveBeenCalled();
  // Nothing was committed to, so nothing is kept.
  expect(await h.state.listDrafts()).toEqual([]);
  expect(h.logs.filter((line) => line === "alice: no answer for task 7")).toHaveLength(1);
});

test("a_solver_that_throws_is_logged_and_not_asked_again", async () => {
  const h = await harness(() => {
    throw new TypeError("the model said https://llm.test/?key=SECRET is down");
  });
  h.world.add({ id: 7 });

  await h.tick();
  await h.tick();

  expect(h.solve).toHaveBeenCalledTimes(1);
  expect(h.commit).not.toHaveBeenCalled();
  expect(h.logs).toContain("ERROR alice: the test solver failed on task 7 (TypeError)");
  expect(h.logs.join("\n")).not.toContain("SECRET");
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

test("a_start_that_fails_is_tried_again_and_costs_no_model_call", async () => {
  const h = await harness();
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
    [{ phase: "open", tag: "regex" }],
    [{ phase: "open", tag: "regex", cursor: "4" }],
    [{ phase: "open", tag: "regex", cursor: "2" }],
  ]);
  expect(idsOf(h.commit)).toEqual([1n, 2n, 3n, 4n, 5n]);
});

test("a_cursor_that_never_ends_does_not_end_the_tick_for_good", async () => {
  const h = await harness();
  h.listTasks.mockResolvedValue({ tasks: [], next_cursor: "1" });

  await h.tick();

  expect(h.listTasks).toHaveBeenCalledTimes(10);
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

test("refuses_a_client_without_a_signer_and_a_poll_interval_setTimeout_cannot_keep", async () => {
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
  // Nothing ran for any of them.
  expect(h.logs).toEqual([]);
  expect(h.listTasks).not.toHaveBeenCalled();
});
