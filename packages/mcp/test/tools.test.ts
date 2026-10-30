import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TenderError, type TxResult } from "@tender/client";
import {
  ApiError,
  type BlobUpload,
  type Brief,
  type ConfigView,
  canonicalJson,
  computeCommitment,
  type EntryView,
  NETWORKS,
  type PublicCriteria,
  type Scorecard,
  sha256Hex,
  type TaskDetailResponse,
  type TaskEntry,
  type TaskSummary,
  type TenderApi,
} from "@tender/shared";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createMcpServer, type McpChain, type McpDeps } from "../src/server";
import { createStateStore, type Draft, type StateStore } from "../src/state";

// The tools are driven the way a client drives them: through the SDK's `Client`, over an in-memory
// pair of transports, with a plain object for the chain and another for the API. The state store is
// the real one, in a temp dir, since its files are what the commit-reveal tools live by.

const ACCOUNT = "alice.testnet";
const OTHER = "bob.testnet";
const POSTER = "poster.testnet";
const SALT = "5a".repeat(32);
const USDC =
  NETWORKS.testnet.usdc ??
  (() => {
    throw new Error("testnet has no USDC in NETWORKS");
  })();
/** A token the shared table knows nothing of, so its amounts show as they are. */
const WEIRD = "weird.near";
const BLOBS = "https://api.tender.example/v1/blobs";

/** A time as the contract counts it: nanoseconds since the epoch, as text. */
const ns = (iso: string) => (BigInt(Date.parse(iso)) * 1_000_000n).toString();

const BRIEF: Brief = {
  version: 1,
  title: "Extract the invoice totals",
  summary: "Read the invoice and report what is owed.",
  instructions: "Return the total of each invoice, in cents, as a JSON array.",
  category: "extraction",
  tags: ["invoices"],
  output: { format: "json", max_bytes: 4096 },
};

const CRITERIA: PublicCriteria = {
  version: 1,
  kind: "exact",
  min_score: 80,
  split: "winner_take_all",
  has_heldout: true,
  normalize: ["trim"],
};

const HELDOUT = { exact: { expected: ["[1050]"] } };

const SCORECARD: Scorecard = {
  version: 1,
  task_id: "7",
  verifier: "judge.testnet",
  kind: "exact",
  criteria_hash: "22".repeat(32),
  heldout_commitment: "33".repeat(32),
  heldout: HELDOUT,
  tie_break: "score desc, committed_at_block asc, account asc",
  entries: [
    {
      account: ACCOUNT,
      content_hash: "55".repeat(32),
      uri: `${BLOBS}/mine`,
      committed_at_block: "105",
      score: 100,
      passed: true,
      reasons: ["matches the expected answer"],
    },
  ],
  winners: [{ account: ACCOUNT, bps: 10_000 }],
  generated_at: "2026-11-04T12:00:00.000Z",
  judge: { software: "tender-judge/1", model: null },
};

function makeSummary(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: "7",
    title: BRIEF.title,
    category: "extraction",
    tags: ["invoices"],
    token: USDC,
    reward: "1000000",
    phase: "open",
    poster: POSTER,
    verifier: "judge.testnet",
    created_at: ns("2026-11-04T09:00:00.000Z"),
    commit_deadline: ns("2026-11-04T10:00:00.000Z"),
    reveal_deadline: ns("2026-11-04T11:00:00.000Z"),
    pick_deadline: ns("2026-11-04T12:00:00.000Z"),
    fallback_deadline: ns("2026-11-04T13:00:00.000Z"),
    commit_count: 2,
    reveal_count: 0,
    working_count: 1,
    judge_status: "accepted",
    judge_reason: null,
    is_team_poster: true,
    parent: null,
    outcome_kind: null,
    ...overrides,
  };
}

function makeEntry(account: string, overrides: Partial<TaskEntry> = {}): TaskEntry {
  return {
    account,
    entry_index: 0,
    committed_height: "100",
    content_hash: null,
    uri: null,
    revealed: false,
    is_team: false,
    ...overrides,
  };
}

function makeDetail(
  entries: TaskEntry[],
  task: Partial<TaskDetailResponse["task"]> = {},
): TaskDetailResponse {
  return {
    task: {
      ...makeSummary(),
      brief_uri: `${BLOBS}/brief`,
      brief_hash: "11".repeat(32),
      criteria_hash: "22".repeat(32),
      heldout_commitment: "33".repeat(32),
      max_entries: 0,
      max_winners: 1,
      invited: [],
      fee_bps: 500,
      outcome: null,
      ...task,
    },
    brief: BRIEF,
    criteria: CRITERIA,
    entries,
    funders: [{ account: POSTER, amount: "1000000" }],
    children: ["9"],
    scorecard: null,
  };
}

const CONFIG: ConfigView = {
  owner: "owner.testnet",
  pending_owner: null,
  treasury: "treasury.testnet",
  fee_bps: 500,
  min_window_secs: 60,
  max_window_secs: 604_800,
  paused: false,
  version: 1,
  tokens: [
    { token: USDC, min_reward: "1", max_reward: "1000000000", enabled: true },
    { token: WEIRD, min_reward: "1", max_reward: "1000000000", enabled: true },
    { token: "old.testnet", min_reward: "1", max_reward: "1000000000", enabled: false },
  ],
};

/** An API of which only the named methods exist: calling any other is a failure of the test. */
function fakeApi(methods: Partial<TenderApi>): TenderApi {
  return new Proxy(methods, {
    get: (target, name) =>
      target[name as keyof TenderApi] ??
      (() => {
        throw new Error(`unexpected api.${String(name)}()`);
      }),
  }) as TenderApi;
}

/** A chain of which only the named methods and the three reads below exist, as `fakeApi`. */
function fakeChain(overrides: Partial<McpChain> = {}): McpChain {
  const methods: Partial<McpChain> = {
    getConfig: async () => CONFIG,
    balanceOf: async () => 0n,
    storageBalanceOf: async () => null,
    ...overrides,
  };
  return new Proxy(methods, {
    get: (target, name) =>
      target[name as keyof McpChain] ??
      (() => {
        throw new Error(`unexpected chain.${String(name)}()`);
      }),
  }) as McpChain;
}

/** A draft the way `commit_result` will make one: the hash, the salt and the commitment agree. */
function makeDraft(taskId: string, overrides: Partial<Draft> = {}): Draft {
  const content = `answer for task ${taskId}`;
  const contentHash = sha256Hex(content);
  return {
    taskId,
    contentBase64: Buffer.from(content).toString("base64"),
    contentHash,
    salt: SALT,
    commitment: computeCommitment(BigInt(taskId), ACCOUNT, contentHash, SALT),
    ...overrides,
  };
}

let root: string;
let dir: string;
let state: StateStore;
const closers: Array<() => Promise<void>> = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "tender-mcp-tools-"));
  dir = join(root, "state");
  state = createStateStore(dir);
});

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await rm(root, { recursive: true, force: true });
});

/** A tool's answer: whether it failed, and its text. */
interface Answer {
  isError: boolean;
  text: string;
}

/** A server for `overrides` over an in-memory pair, and a client connected to it. */
async function connect(overrides: Partial<McpDeps> = {}) {
  const server = createMcpServer({
    client: fakeChain(),
    api: fakeApi({}),
    state,
    network: "testnet",
    contractId: "tender.testnet",
    accountId: ACCOUNT,
    keyKind: "function_call",
    defaultToken: USDC,
    ...overrides,
  });
  const mcp = new Client({ name: "test", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), mcp.connect(clientSide)]);
  closers.push(() => mcp.close());

  async function call(name: string, args: Record<string, unknown> = {}): Promise<Answer> {
    const result = await mcp.callTool({ name, arguments: args });
    const [block] = result.content as Array<{ type: string; text: string }>;
    return { isError: result.isError === true, text: block?.text ?? "" };
  }
  /** The JSON a tool answered with, after checking that it did not fail. */
  async function callJson(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const answer = await call(name, args);
    expect(answer.isError, answer.text).toBe(false);
    return JSON.parse(answer.text);
  }
  return { mcp, call, callJson };
}

test("lists_expected_read_tools", async () => {
  const { mcp } = await connect();

  expect(mcp.getServerVersion()).toMatchObject({ name: "tender", version: "1.0.0" });

  const { tools } = await mcp.listTools();
  // The tools that change nothing say so, and a client may run them without asking.
  const reading = tools.filter((tool) => tool.annotations?.readOnlyHint === true);
  expect(reading.map((tool) => tool.name).sort()).toEqual([
    "balance",
    "get_scorecard",
    "get_task",
    "list_tasks",
    "my_entries",
    "task_entries",
  ]);

  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool.inputSchema]));
  expect(Object.keys(byName.list_tasks?.properties ?? {})).toEqual([
    "phase",
    "tag",
    "limit",
    "cursor",
  ]);
  expect(byName.list_tasks?.required).toBeUndefined();
  expect(byName.get_task?.required).toEqual(["task_id"]);
  expect(byName.get_scorecard?.required).toEqual(["task_id"]);
  expect(byName.task_entries?.required).toEqual(["task_id"]);
  expect(byName.my_entries?.properties).toEqual({});
  expect(byName.balance?.properties).toEqual({});

  // The descriptions say what an agent would otherwise have to guess (04-T6 review, minors 1, 2, 7).
  const description = (name: string) => tools.find((tool) => tool.name === name)?.description ?? "";
  expect(description("balance")).toMatch(/function_call/);
  expect(description("balance")).toMatch(/cannot attach a deposit/);
  expect(description("my_entries")).toMatch(/revealed_uri/);
  expect(description("my_entries")).toMatch(/corrupt/);
  expect(description("my_entries")).not.toMatch(/cannot be revealed/);
});

test("lists_expected_write_tools", async () => {
  const { mcp } = await connect();

  const { tools } = await mcp.listTools();
  const writing = tools.filter((tool) => tool.annotations?.readOnlyHint === false);
  expect(writing.map((tool) => tool.name).sort()).toEqual([
    "commit_result",
    "deposit",
    "pick_winners",
    "post_task",
    "register_agent",
    "reveal_result",
    "start_task",
    "withdraw",
  ]);
  // Pooled bounties arrive with the contract's P1 (P04-P9): there is no tool for them yet.
  expect(tools.map((tool) => tool.name)).not.toContain("top_up_task");

  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  expect(byName.commit_result?.inputSchema.required).toEqual(["task_id"]);
  expect(Object.keys(byName.commit_result?.inputSchema.properties ?? {})).toEqual([
    "task_id",
    "content",
    "file_path",
  ]);
  expect(byName.reveal_result?.inputSchema.required).toEqual(["task_id"]);
  expect(byName.start_task?.inputSchema.required).toEqual(["task_id"]);
  expect(byName.deposit?.inputSchema.required).toEqual(["amount"]);
  expect(byName.withdraw?.inputSchema.required).toEqual(["amount"]);
  // The windows are seconds, as the contract takes them (P04-P10).
  const post = byName.post_task?.inputSchema;
  expect(post?.properties).toHaveProperty("commit_secs");
  expect(post?.properties).not.toHaveProperty("commit_minutes");
  expect(post?.required).toEqual(
    expect.arrayContaining([
      "title",
      "criteria",
      "reward",
      "commit_secs",
      "reveal_secs",
      "pick_secs",
      "fallback_secs",
    ]),
  );
  expect(post?.required).not.toContain("heldout");

  // Two servers on one state directory would race on the drafts, and the tools that use them say so.
  for (const name of ["commit_result", "reveal_result"]) {
    expect(byName[name]?.description).toMatch(/state directory/);
    expect(byName[name]?.description).toMatch(/not supported/);
  }
  // The tools that spend or give up money are marked as destructive, and a retry of one is not safe.
  for (const name of ["deposit", "withdraw", "post_task", "pick_winners"]) {
    expect(byName[name]?.annotations).toMatchObject({ destructiveHint: true });
    expect(byName[name]?.annotations).toMatchObject({ idempotentHint: false });
  }
  for (const name of ["commit_result", "reveal_result"]) {
    expect(byName[name]?.annotations).toMatchObject({
      destructiveHint: false,
      idempotentHint: true,
    });
  }
});

test("commit_result_says_where_files_come_from_and_that_a_commit_stays", async () => {
  // What an agent reads is all it has to go on: where file_path may point, and what a commit means.
  const files = await makeFilesDir();
  const describeCommit = async (overrides: Partial<McpDeps>) => {
    const { mcp } = await connect(overrides);
    const { tools } = await mcp.listTools();
    const tool = tools.find((candidate) => candidate.name === "commit_result");
    const file = tool?.inputSchema.properties?.file_path as { description?: string } | undefined;
    return { tool: tool?.description ?? "", file: file?.description ?? "" };
  };

  const allowed = await describeCommit({ filesDir: files });
  expect(allowed.tool).toContain(files);
  expect(allowed.file).toContain(files);

  const refused = await describeCommit({});
  expect(refused.tool).toMatch(/file_path is not available/);
  expect(refused.tool).not.toContain(files);
  expect(refused.file).toMatch(/not available/);

  for (const { tool } of [allowed, refused]) {
    // Once committed, an answer stays: this server does not replace one.
    expect(tool).toMatch(/cannot be changed/);
    expect(tool).toMatch(/ALREADY_COMMITTED/);
    // The task's own limit applies as well as the server's.
    expect(tool).toMatch(/output\.max_bytes/);
  }
});

test("list_tasks_filters_the_board_and_formats_it", async () => {
  const listTasks = vi.fn<TenderApi["listTasks"]>(async () => ({
    tasks: [
      makeSummary({ id: "8", reward: "2500000" }),
      makeSummary({ id: "7", token: WEIRD, reward: "40" }),
    ],
    next_cursor: "7",
  }));
  const { callJson } = await connect({ api: fakeApi({ listTasks }) });

  const board = await callJson("list_tasks", {
    phase: "open",
    tag: "invoices",
    limit: 2,
    cursor: "9",
  });

  expect(listTasks).toHaveBeenCalledWith({ phase: "open", tag: "invoices", limit: 2, cursor: "9" });
  expect(board).toMatchObject({
    next_cursor: "7",
    tasks: [
      {
        id: "8",
        title: BRIEF.title,
        phase: "open",
        // The amount stays as the API has it, so that it can go straight into a write tool, and the
        // readable form sits beside it.
        reward: "2500000",
        reward_formatted: "2.50 USDC",
        // Times are readable, and everything else is as the API has it.
        created_at: "2026-11-04T09:00:00.000Z",
        commit_deadline: "2026-11-04T10:00:00.000Z",
        fallback_deadline: "2026-11-04T13:00:00.000Z",
        commit_count: 2,
        working_count: 1,
        judge_status: "accepted",
        judge_reason: null,
      },
      // A token the table does not know shows the raw amount and the token id.
      { id: "7", token: WEIRD, reward: "40", reward_formatted: "40 weird.near" },
    ],
  });

  // With no filter, none is sent.
  await callJson("list_tasks");
  expect(listTasks).toHaveBeenLastCalledWith({});
});

test("a_time_is_cut_to_the_millisecond_and_never_rounded_up", async () => {
  // The contract counts in nanoseconds. A deadline one nanosecond short of 10:00:00.000 has not
  // passed, so it must not read as if it had, and the milliseconds must be there.
  const justBefore = (BigInt(ns("2026-11-04T10:00:00.000Z")) - 1n).toString();
  const listTasks = async () => ({
    tasks: [makeSummary({ commit_deadline: justBefore })],
    next_cursor: null,
  });
  const { callJson } = await connect({ api: fakeApi({ listTasks }) });

  const board = await callJson("list_tasks");

  expect(board).toMatchObject({ tasks: [{ commit_deadline: "2026-11-04T09:59:59.999Z" }] });
});

test("get_task_merges_own_entry", async () => {
  const draft = makeDraft("7", { committedAt: "2026-11-04T09:30:00.000Z" });
  await state.saveDraft(draft);
  const getTask = vi.fn<TenderApi["getTask"]>(async (id) =>
    id === 7n
      ? makeDetail([
          makeEntry(OTHER, {
            entry_index: 0,
            content_hash: "44".repeat(32),
            uri: `${BLOBS}/bob`,
            revealed: true,
          }),
          makeEntry(ACCOUNT, { entry_index: 1, committed_height: "105" }),
        ])
      : null,
  );
  const { call } = await connect({ api: fakeApi({ getTask }) });

  const answer = await call("get_task", { task_id: "7" });
  expect(getTask).toHaveBeenCalledWith(7n);
  const body = JSON.parse(answer.text);

  // The task: its terms, with the amounts and the times readable, and the entry counts.
  expect(body.task).toMatchObject({
    id: "7",
    phase: "open",
    reward: "1000000",
    reward_formatted: "1.00 USDC",
    commit_deadline: "2026-11-04T10:00:00.000Z",
    commit_count: 2,
    reveal_count: 0,
    max_entries: 0,
    max_winners: 1,
    fee_bps: 500,
    outcome: null,
  });
  expect(body.brief).toEqual(BRIEF);
  expect(body.criteria).toEqual(CRITERIA);
  expect(body.funders).toEqual([
    { account: POSTER, amount: "1000000", amount_formatted: "1.00 USDC" },
  ]);
  expect(body.children).toEqual(["9"]);

  // The caller's own entry is the index's entry and the local draft in one.
  expect(body.own_entry).toEqual({
    status: "committed",
    entry_index: 1,
    committed_height: "105",
    revealed: false,
    content_hash: null,
    uri: null,
    draft: {
      content_hash: draft.contentHash,
      commitment: draft.commitment,
      committed_at: "2026-11-04T09:30:00.000Z",
      revealed_uri: null,
    },
  });

  // Nobody else's entry is listed, and the draft's work and salt are never shown.
  expect(answer.text).not.toContain(OTHER);
  expect(answer.text).not.toContain(SALT);
  expect(answer.text).not.toContain(draft.contentBase64);
});

test("get_task_says_which_state_the_own_entry_is_in", async () => {
  const detail = vi.fn<TenderApi["getTask"]>();
  const { callJson } = await connect({ api: fakeApi({ getTask: detail }) });
  const ownEntry = async () =>
    ((await callJson("get_task", { task_id: "7" })) as { own_entry: Record<string, unknown> })
      .own_entry;

  // Nothing yet: no entry and no draft.
  detail.mockResolvedValue(makeDetail([makeEntry(OTHER)]));
  expect(await ownEntry()).toMatchObject({ status: "none", entry_index: null, draft: null });

  // A draft and no entry in the index: the commit is pending, failed, or not indexed yet.
  await state.saveDraft(makeDraft("7"));
  expect(await ownEntry()).toMatchObject({
    status: "draft_saved",
    entry_index: null,
    draft: { committed_at: null, revealed_uri: null },
  });

  // A draft the contract refused for good: it says so, and why.
  await state.markDead("7", "E_PHASE: task 7 is not open for commits");
  const dead = await ownEntry();
  expect(dead).toMatchObject({
    status: "draft_dead",
    draft: { dead: { reason: "E_PHASE: task 7 is not open for commits" } },
  });
  expect(JSON.stringify(dead)).toMatch(/"at":"\d{4}-\d\d-\d\dT/);

  // An entry the index lists as revealed.
  await state.saveDraft(makeDraft("7"));
  await state.markRevealed("7", `${BLOBS}/mine`);
  detail.mockResolvedValue(
    makeDetail([
      makeEntry(ACCOUNT, {
        entry_index: 3,
        content_hash: "55".repeat(32),
        uri: `${BLOBS}/mine`,
        revealed: true,
      }),
    ]),
  );
  expect(await ownEntry()).toMatchObject({
    status: "revealed",
    entry_index: 3,
    revealed: true,
    content_hash: "55".repeat(32),
    draft: { revealed_uri: `${BLOBS}/mine` },
  });

  // A draft that cannot be read does not fail the task: the answer names the file.
  await writeFile(join(dir, "drafts", "7.json"), "{ not json");
  const broken = await ownEntry();
  expect(broken).toMatchObject({ status: "revealed", draft: null });
  expect(broken.draft_error).toContain(join(dir, "drafts", "7.json"));
  expect(broken.draft_error).toContain("corrupt");
});

test("get_task_shows_judge_reason", async () => {
  const reason = "rubric tasks are off for outside posters unless the poster is the verifier";
  const detail = makeDetail([], { judge_status: "rejected", judge_reason: reason });
  const { callJson } = await connect({ api: fakeApi({ getTask: async () => detail }) });

  // The agent sees why the Judge refused before it spends effort on the task.
  expect(await callJson("get_task", { task_id: "7" })).toMatchObject({
    task: { judge_status: "rejected", judge_reason: reason },
  });
});

test("get_task_formats_the_outcome_of_a_settled_task", async () => {
  const picked = makeDetail([], {
    phase: "settled",
    outcome_kind: "picked",
    outcome: {
      kind: "picked",
      task_id: "7",
      by: "judge.testnet",
      winners: [{ account: ACCOUNT, bps: 10_000, amount: "950000" }],
      fee: "50000",
      scorecard_hash: "66".repeat(32),
      scorecard_uri: `${BLOBS}/card`,
    },
  });
  const voided = makeDetail([], {
    phase: "settled",
    outcome_kind: "voided",
    outcome: {
      kind: "voided",
      task_id: "7",
      reason: "no_reveals",
      by: null,
      refunds: [{ account: POSTER, amount: "1000000" }],
      scorecard_hash: null,
      scorecard_uri: null,
    },
  });
  const getTask = vi.fn<TenderApi["getTask"]>();
  const { callJson } = await connect({ api: fakeApi({ getTask }) });

  getTask.mockResolvedValue(picked);
  expect(await callJson("get_task", { task_id: "7" })).toMatchObject({
    task: {
      outcome: {
        kind: "picked",
        winners: [
          { account: ACCOUNT, bps: 10_000, amount: "950000", amount_formatted: "0.95 USDC" },
        ],
        fee: "50000",
        fee_formatted: "0.05 USDC",
      },
    },
  });

  getTask.mockResolvedValue(voided);
  expect(await callJson("get_task", { task_id: "7" })).toMatchObject({
    task: {
      outcome: {
        kind: "voided",
        reason: "no_reveals",
        refunds: [{ account: POSTER, amount: "1000000", amount_formatted: "1.00 USDC" }],
      },
    },
  });
});

test("a_missing_task_is_an_answer_and_not_an_error", async () => {
  const { call } = await connect({ api: fakeApi({ getTask: async () => null }) });

  expect(await call("get_task", { task_id: "99" })).toEqual({ isError: false, text: "no task 99" });
  expect(await call("task_entries", { task_id: "99" })).toEqual({
    isError: false,
    text: "no task 99",
  });
});

test("task_entries_lists_revealed_entries", async () => {
  // A verifier scores the revealed entries, and so needs them, which `get_task` does not list.
  const entries = [
    makeEntry(OTHER, {
      entry_index: 0,
      committed_height: "100",
      content_hash: "44".repeat(32),
      uri: `${BLOBS}/bob`,
      revealed: true,
    }),
    makeEntry("carol.testnet", { entry_index: 1, committed_height: "101", is_team: true }),
    makeEntry(ACCOUNT, {
      entry_index: 2,
      committed_height: "105",
      content_hash: "55".repeat(32),
      uri: `${BLOBS}/mine`,
      revealed: true,
    }),
  ];
  const getTask = vi.fn<TenderApi["getTask"]>(async (id) =>
    id === 7n ? makeDetail(entries) : null,
  );
  const { callJson } = await connect({ api: fakeApi({ getTask }) });

  // Every entry as the API has it: its account, place, block, and for a revealed one the hash and
  // the uri to read the work at. An unrevealed entry has neither.
  expect(await callJson("task_entries", { task_id: "7" })).toEqual({ task_id: "7", entries });
  expect(getTask).toHaveBeenCalledWith(7n);
});

test("my_entries_includes_unrevealed_drafts", async () => {
  // Task 3 is committed and waits for its reveal, 9 is revealed already, and 12 was saved but its
  // commit has not been confirmed.
  await state.saveDraft(makeDraft("3", { committedAt: "2026-11-04T09:30:00.000Z" }));
  await state.saveDraft(makeDraft("9", { committedAt: "2026-11-04T09:31:00.000Z" }));
  await state.markRevealed("9", `${BLOBS}/nine`);
  await state.saveDraft(makeDraft("12"));
  const entries = [
    {
      task_id: "9",
      title: "Nine",
      phase: "judging" as const,
      revealed: true,
      won: false,
      entry_index: 0,
      committed_height: "90",
      content_hash: "77".repeat(32),
      uri: `${BLOBS}/nine`,
    },
    {
      task_id: "3",
      title: "Three",
      phase: "revealing" as const,
      revealed: false,
      won: false,
      entry_index: 2,
      committed_height: "30",
      content_hash: null,
      uri: null,
    },
  ];
  const listEntries = vi.fn<TenderApi["listEntries"]>(async () => ({ entries }));
  const { call } = await connect({ api: fakeApi({ listEntries }) });

  const answer = await call("my_entries");
  expect(answer.isError).toBe(false);
  expect(listEntries).toHaveBeenCalledWith(ACCOUNT);
  const body = JSON.parse(answer.text);

  expect(body.account).toBe(ACCOUNT);
  expect(body.entries).toEqual(entries);
  // Every draft, by task number: the one waiting for its reveal, the one revealed here (its
  // revealed_uri says so, for the time before the index has caught up), and the unconfirmed one.
  // Nothing in them lets the work out early.
  expect(body.drafts).toEqual([
    {
      task_id: "3",
      content_hash: sha256Hex("answer for task 3"),
      commitment: makeDraft("3").commitment,
      committed_at: "2026-11-04T09:30:00.000Z",
      revealed_uri: null,
    },
    {
      task_id: "9",
      content_hash: sha256Hex("answer for task 9"),
      commitment: makeDraft("9").commitment,
      committed_at: "2026-11-04T09:31:00.000Z",
      revealed_uri: `${BLOBS}/nine`,
    },
    {
      task_id: "12",
      content_hash: sha256Hex("answer for task 12"),
      commitment: makeDraft("12").commitment,
      committed_at: null,
      revealed_uri: null,
    },
  ]);
  expect(body.drafts_error).toBeUndefined();
  expect(answer.text).not.toContain(SALT);
  expect(answer.text).not.toContain(makeDraft("3").contentBase64);
});

test("my_entries_names_a_corrupt_draft_file", async () => {
  await state.saveDraft(makeDraft("3"));
  await state.saveDraft(makeDraft("5"));
  const bad = join(dir, "drafts", "9.json");
  await writeFile(bad, "this is not a draft");
  const row = (taskId: string) => ({
    task_id: taskId,
    title: `Task ${taskId}`,
    phase: "revealing" as const,
    revealed: false,
    won: false,
    entry_index: 0,
    committed_height: "30",
    content_hash: null,
    uri: null,
  });
  const entries = [row("3")];
  const { call } = await connect({ api: fakeApi({ listEntries: async () => ({ entries }) }) });

  // The entries still come, the answer says which file it could not read, and one bad file does not
  // hide the draft of an entry: `listDrafts` stops at the first bad file, so each entry's draft is
  // asked for on its own. (Task 5 has no entry in the list, so its draft cannot be found this way.)
  const answer = await call("my_entries");
  expect(answer.isError).toBe(false);
  const body = JSON.parse(answer.text);
  expect(body.entries).toEqual(entries);
  expect(body.drafts).toEqual([
    {
      task_id: "3",
      content_hash: sha256Hex("answer for task 3"),
      commitment: makeDraft("3").commitment,
      committed_at: null,
      revealed_uri: null,
    },
  ]);
  expect(body.drafts_error).toContain(bad);
  expect(body.drafts_error).toContain("corrupt");

  // A bad file of an entry's own task is named too, and the other drafts of entries still come.
  // `listDrafts` reports the first bad file in task order, which is now 3's.
  const bad3 = join(dir, "drafts", "3.json");
  await writeFile(bad3, "{ also not a draft");
  entries.push(row("5"));
  const both = JSON.parse((await call("my_entries")).text);
  expect(both.drafts.map((draft: { task_id: string }) => draft.task_id)).toEqual(["5"]);
  expect(both.drafts_error).toContain(bad3);
  expect(both.drafts_error).toContain("corrupt");
});

test("my_entries_with_no_state_dir_has_no_drafts", async () => {
  const { callJson } = await connect({
    api: fakeApi({ listEntries: async () => ({ entries: [] }) }),
  });

  expect(await callJson("my_entries")).toEqual({
    account: ACCOUNT,
    entries: [],
    drafts: [],
  });
});

test("balance_formats_amounts", async () => {
  const balances: Record<string, bigint> = { [USDC]: 1_250_000n, [WEIRD]: 500n };
  const balanceOf = vi.fn<McpChain["balanceOf"]>(async (_account, token) => balances[token] ?? 0n);
  const storageBalanceOf = vi.fn<McpChain["storageBalanceOf"]>(async () => ({
    total: "10000000000000000000000",
    available: "4000000000000000000000",
    used_bytes: "600",
  }));
  const { callJson } = await connect({
    client: fakeChain({ balanceOf, storageBalanceOf }),
    keyKind: "full_access",
  });

  expect(await callJson("balance")).toEqual({
    account: ACCOUNT,
    key_kind: "full_access",
    vault: [
      { token: USDC, enabled: true, balance: "1250000", balance_formatted: "1.25 USDC" },
      // A token the table does not know: the raw amount and the token id, decimals not guessed.
      { token: WEIRD, enabled: true, balance: "500", balance_formatted: "500 weird.near" },
      { token: "old.testnet", enabled: false, balance: "0", balance_formatted: "0 old.testnet" },
    ],
    storage: {
      total: "10000000000000000000000",
      total_formatted: "0.01 NEAR",
      available: "4000000000000000000000",
      available_formatted: "0.004 NEAR",
      used_bytes: "600",
    },
  });
  expect(balanceOf).toHaveBeenCalledWith(ACCOUNT, USDC);
  expect(storageBalanceOf).toHaveBeenCalledWith(ACCOUNT);
});

test("balance_of_an_account_that_never_deposited", async () => {
  const { callJson } = await connect({ keyKind: "unknown" });

  expect(await callJson("balance")).toMatchObject({
    key_kind: "unknown",
    vault: [
      { balance: "0", balance_formatted: "0.00 USDC" },
      { balance: "0", balance_formatted: "0 weird.near" },
      {},
    ],
    storage: null,
  });
});

test("get_scorecard_returns_the_scorecard_or_says_there_is_none", async () => {
  const getScorecard = vi.fn<TenderApi["getScorecard"]>();
  const { call } = await connect({ api: fakeApi({ getScorecard }) });

  getScorecard.mockResolvedValue(SCORECARD);
  const found = await call("get_scorecard", { task_id: "7" });
  expect(getScorecard).toHaveBeenCalledWith(7n);
  expect(found.isError).toBe(false);
  expect(JSON.parse(found.text)).toEqual(SCORECARD);

  getScorecard.mockResolvedValue(null);
  expect(await call("get_scorecard", { task_id: "8" })).toEqual({
    isError: false,
    text: "no scorecard for task 8",
  });
});

test("a_task_id_that_is_no_u64_is_refused_before_the_api_is_asked", async () => {
  const api = fakeApi({
    getTask: vi.fn<TenderApi["getTask"]>(async () => null),
    getScorecard: vi.fn<TenderApi["getScorecard"]>(async () => null),
    listTasks: vi.fn<TenderApi["listTasks"]>(async () => ({ tasks: [], next_cursor: null })),
  });
  const { call } = await connect({ api });

  for (const [name, args] of [
    ["get_task", { task_id: "07" }],
    ["get_task", { task_id: "-1" }],
    ["get_task", { task_id: "18446744073709551616" }],
    ["get_scorecard", { task_id: "seven" }],
    ["task_entries", { task_id: "7.5" }],
    ["list_tasks", { limit: 51 }],
    ["list_tasks", { tag: "Not A Tag" }],
    ["list_tasks", { phase: "later" }],
    ["list_tasks", { cursor: "1.5" }],
  ] as const) {
    const answer = await call(name, args);
    expect(answer.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
  }
  expect(api.getTask).not.toHaveBeenCalled();
  expect(api.getScorecard).not.toHaveBeenCalled();
  expect(api.listTasks).not.toHaveBeenCalled();
});

test("a_failing_tool_answers_with_a_code_and_no_url", async () => {
  const getTask = vi.fn<TenderApi["getTask"]>();
  const { call } = await connect({
    api: fakeApi({ getTask }),
    client: fakeChain({
      // near-api-js names the URL it was given in its messages, and a URL can hold a key.
      getConfig: async () => {
        throw new Error("Exceeded 12 attempts for https://rpc.example.com/?apiKey=SECRETKEY.");
      },
    }),
  });

  getTask.mockRejectedValue(new ApiError(503, { error: "unavailable", message: "try later" }));
  expect(await call("get_task", { task_id: "7" })).toEqual({
    isError: true,
    text: "API_ERROR: request failed with status 503 (unavailable)",
  });

  const chain = await call("balance");
  expect(chain.isError).toBe(true);
  expect(chain.text).toBe("ERROR: Exceeded 12 attempts for <url>");
  expect(chain.text).not.toContain("SECRETKEY");

  // A server that hit a failure still answers the next call.
  getTask.mockResolvedValue(null);
  expect(await call("get_task", { task_id: "7" })).toEqual({ isError: false, text: "no task 7" });
});

// ---- The write tools --------------------------------------------------------------------------

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const HEX64 = /^[0-9a-f]{64}$/;
const NEEDS_FULL_ACCESS_KEY =
  "NEEDS_FULL_ACCESS_KEY: this tool moves money; run it with a full-access key or set up a delegate key with caps (docs/MCP.md)";
/** What a key and its base58 body look like to the scrubber. */
const SECRET_KEY = "ed25519:5zQ9fakeKeyMaterialForTheScrubber";
const SECRET_BODY = SECRET_KEY.slice("ed25519:".length);
/** The least storage that lets an account commit and reveal: 1,024 bytes at 10^19 yoctoNEAR each. */
const STORAGE_NEEDED = 1024n * 10n ** 19n;

/** What a fake transaction answers with. */
function tx(txHash: string, rest: Partial<TxResult> = {}): TxResult {
  return { txHash, events: [], returnValue: undefined, receipts: [], ...rest };
}

/** A storage balance with room for many entries. */
const ROOMY = {
  total: "50000000000000000000000",
  available: "40000000000000000000000",
  used_bytes: "1000",
};

/** The `task_created` event of a task that `postTask` made: it carries the deadlines. */
function taskCreated(id: string): TxResult["events"][number] {
  return {
    event: "task_created",
    receiptId: "receipt-1",
    logIndex: 0,
    data: {
      id,
      poster: ACCOUNT,
      token: USDC,
      reward: "1500000",
      fee_bps: 500,
      brief_uri: `${BLOBS}/brief`,
      brief_hash: "11".repeat(32),
      criteria_hash: "22".repeat(32),
      heldout_commitment: "33".repeat(32),
      verifier: "judge.testnet",
      created_at: ns("2026-11-04T09:00:00.000Z"),
      commit_deadline: ns("2026-11-04T10:00:00.000Z"),
      reveal_deadline: ns("2026-11-04T11:00:00.000Z"),
      pick_deadline: ns("2026-11-04T12:00:00.000Z"),
      fallback_deadline: ns("2026-11-04T13:00:00.000Z"),
      max_entries: 0,
      max_winners: 1,
      invited: [],
      parent: null,
    },
  };
}

/** The `deposit` event of a deposit that Tender took. */
function depositTaken(amount: string): TxResult["events"][number] {
  return {
    event: "deposit",
    receiptId: "receipt-1",
    logIndex: 0,
    data: { account: ACCOUNT, token: USDC, amount, sender: ACCOUNT },
  };
}

/** The entry that a commit leaves on chain. */
function entryView(commitment: string): EntryView {
  return {
    task_id: "7",
    account: ACCOUNT,
    index: 0,
    commitment,
    committed_at_block: "100",
    content_hash: null,
    uri: null,
  };
}

/**
 * A chain and an API that take every write and say it went through. A test changes one answer, or
 * reads what was sent: `invocationCallOrder` orders calls across the mocks.
 */
function writeKit() {
  const chain = {
    getConfig: vi.fn<McpChain["getConfig"]>(async () => CONFIG),
    balanceOf: vi.fn<McpChain["balanceOf"]>(async () => 0n),
    storageBalanceOf: vi.fn<McpChain["storageBalanceOf"]>(async () => ROOMY),
    getEntry: vi.fn<McpChain["getEntry"]>(async () => null),
    storageDeposit: vi.fn<McpChain["storageDeposit"]>(async () => tx("TX_STORAGE")),
    commit: vi.fn<McpChain["commit"]>(async () => tx("TX_COMMIT")),
    reveal: vi.fn<McpChain["reveal"]>(async () => tx("TX_REVEAL")),
    postTask: vi.fn<McpChain["postTask"]>(async () => ({
      ...tx("TX_POST", { events: [taskCreated("12")] }),
      taskId: 12n,
    })),
    pick: vi.fn<McpChain["pick"]>(async () => tx("TX_PICK")),
    deposit: vi.fn<McpChain["deposit"]>(async () =>
      tx("TX_DEPOSIT", { events: [depositTaken("2500000")], returnValue: "2500000" }),
    ),
    withdraw: vi.fn<McpChain["withdraw"]>(async () => tx("TX_WITHDRAW", { returnValue: true })),
    registerAgent: vi.fn<McpChain["registerAgent"]>(async () => tx("TX_AGENT")),
  };
  const api = {
    getTask: vi.fn<TenderApi["getTask"]>(async () => makeDetail([])),
    // The API stores the bytes and names them by their hash, as the real one does.
    uploadBlob: vi.fn<TenderApi["uploadBlob"]>(async (blob: BlobUpload) => {
      const sha256 = sha256Hex(blob.bytes);
      return { sha256, uri: `${BLOBS}/${sha256}` };
    }),
    uploadHeldout: vi.fn<TenderApi["uploadHeldout"]>(async () => undefined),
    start: vi.fn<TenderApi["start"]>(async () => ({ ok: true as const, working_count: 3 })),
  };
  return { chain, api };
}

/** A server on a write kit. The key is a function-call key unless the test says otherwise. */
async function connectWrite(overrides: Partial<McpDeps> = {}) {
  const kit = writeKit();
  const session = await connect({ client: kit.chain, api: fakeApi(kit.api), ...overrides });
  return { ...kit, ...session };
}

/** A directory for the files that a test lets the server read, inside the test's own root. */
async function makeFilesDir(): Promise<string> {
  const files = join(root, "files");
  await mkdir(files, { recursive: true });
  return files;
}

/** A task whose brief lets a result have `maxBytes` bytes. */
function detailAllowing(maxBytes: number): TaskDetailResponse {
  return {
    ...makeDetail([]),
    brief: { ...BRIEF, output: { ...BRIEF.output, max_bytes: maxBytes } },
  };
}

/** The draft of `taskId`, which the test expects to be there. */
async function draftOf(taskId: string): Promise<Draft> {
  const draft = await state.getDraft(taskId);
  if (draft === null) throw new Error(`no draft for task ${taskId}`);
  return draft;
}

const bodyOf = (answer: Answer) => JSON.parse(answer.text) as Record<string, unknown>;

/** A promise that the test settles by hand. */
function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Waits, for at most two seconds, until `condition` holds. */
async function until(condition: () => boolean): Promise<void> {
  for (let tries = 0; tries < 400 && !condition(); tries++) {
    await new Promise((done) => setTimeout(done, 5));
  }
  expect(condition()).toBe(true);
}

test("start_task_signals_the_api", async () => {
  const { call, api } = await connectWrite();

  expect(await call("start_task", { task_id: "7" })).toEqual({
    isError: false,
    text: JSON.stringify({ working_count: 3 }, null, 2),
  });
  expect(api.start).toHaveBeenCalledExactlyOnceWith(7n);

  api.start.mockRejectedValue(new ApiError(409, { error: "not_open", message: "closed" }));
  expect(await call("start_task", { task_id: "7" })).toEqual({
    isError: true,
    text: "API_ERROR: request failed with status 409 (not_open)",
  });
});

test("commit_saves_draft_before_sending", async () => {
  // When the commit leaves, the draft is on disk already, with the salt and without `committedAt`:
  // a crash after the send has then left everything the reveal needs.
  let seen: Record<string, unknown> = {};
  const { callJson, chain } = await connectWrite();
  chain.commit.mockImplementation(async () => {
    seen = JSON.parse(await readFile(join(dir, "drafts", "7.json"), "utf8"));
    return tx("TX_COMMIT");
  });
  const before = Date.now();

  const answer = await callJson("commit_result", { task_id: "7", content: "forty-two" });

  const hash = sha256Hex("forty-two");
  expect(seen).toMatchObject({
    taskId: "7",
    contentBase64: Buffer.from("forty-two").toString("base64"),
    contentHash: hash,
  });
  expect(seen).not.toHaveProperty("committedAt");
  // The draft the send found is the one that stayed, with the time of the commit set.
  const draft = await draftOf("7");
  expect(draft.salt).toMatch(HEX64);
  expect(draft.commitment).toBe(computeCommitment(7n, ACCOUNT, hash, draft.salt));
  expect(seen).toMatchObject({ salt: draft.salt, commitment: draft.commitment });
  expect(draft.committedAt).toMatch(ISO);
  expect(Date.parse(draft.committedAt ?? "")).toBeGreaterThanOrEqual(before - 1000);
  expect(Date.parse(draft.committedAt ?? "")).toBeLessThanOrEqual(Date.now() + 1000);
  expect(draft.revealedUri).toBeUndefined();

  expect(chain.commit).toHaveBeenCalledExactlyOnceWith(7n, draft.commitment);
  // The reveal opens when the commit window ends, which the API knows.
  expect(answer).toEqual({
    commitment: draft.commitment,
    content_hash: hash,
    tx_hash: "TX_COMMIT",
    reveal_opens_at: "2026-11-04T10:00:00.000Z",
  });
  // Each commit has a salt of its own, and nothing shows it.
  await callJson("commit_result", { task_id: "8", content: "forty-two" });
  expect((await draftOf("8")).salt).not.toBe(draft.salt);
  expect(JSON.stringify(answer)).not.toContain(draft.salt);
});

test("commit_requires_exactly_one_input", async () => {
  const files = await makeFilesDir();
  const file = join(files, "answer.txt");
  await writeFile(file, "from a file");
  const { call, callJson, chain } = await connectWrite({ filesDir: files });

  // Neither, both, and the empty strings a client may fill an unused field with.
  for (const args of [
    { task_id: "7" },
    { task_id: "7", content: "text", file_path: file },
    { task_id: "7", content: "", file_path: "" },
  ]) {
    const answer = await call("commit_result", args);
    expect(answer.isError, JSON.stringify(args)).toBe(true);
    expect(answer.text).toMatch(/^BAD_INPUT: give exactly one of content and file_path/);
  }
  expect(chain.commit).not.toHaveBeenCalled();
  expect(chain.storageBalanceOf).not.toHaveBeenCalled();
  expect(await state.getDraft("7")).toBeNull();

  // Either one alone does it, and an empty field beside it counts for nothing.
  const fromFile = await callJson("commit_result", { task_id: "7", file_path: file, content: "" });
  expect(fromFile).toMatchObject({ content_hash: sha256Hex("from a file") });
  const fromText = await callJson("commit_result", {
    task_id: "8",
    content: "text",
    file_path: "",
  });
  expect(fromText).toMatchObject({ content_hash: sha256Hex("text") });
  expect((await draftOf("7")).contentBase64).toBe(Buffer.from("from a file").toString("base64"));
});

test("content_over_limit_rejected", async () => {
  const files = await makeFilesDir();
  const { call, callJson, chain, api } = await connectWrite({ filesDir: files });
  const limit = 262_144;
  // The task allows as much as any task may, so that only the server's own limit is in play.
  api.getTask.mockResolvedValue(detailAllowing(limit));

  // One byte over. The limit is on bytes, not characters: an "é" is two.
  for (const content of ["a".repeat(limit + 1), "é".repeat(limit / 2 + 1)]) {
    const answer = await call("commit_result", { task_id: "7", content });
    expect(answer.isError).toBe(true);
    expect(answer.text).toMatch(/^TOO_LARGE: /);
    expect(answer.text).toContain("262144");
  }
  expect(chain.commit).not.toHaveBeenCalled();
  expect(chain.storageBalanceOf).not.toHaveBeenCalled();
  expect(await state.getDraft("7")).toBeNull();

  // Exactly the limit goes through, in text and in a file.
  await callJson("commit_result", { task_id: "7", content: "é".repeat(limit / 2) });
  const file = join(files, "big.bin");
  await writeFile(file, Buffer.alloc(limit, 7));
  await callJson("commit_result", { task_id: "8", file_path: file });
  expect((await draftOf("8")).contentHash).toBe(sha256Hex(Buffer.alloc(limit, 7)));

  // A file one byte over is refused too.
  await writeFile(file, Buffer.alloc(limit + 1, 7));
  const big = await call("commit_result", { task_id: "9", file_path: file });
  expect(big.text).toMatch(/^TOO_LARGE: /);
  expect(await state.getDraft("9")).toBeNull();
});

test("commit_refuses_what_the_task_does_not_allow", async () => {
  // A brief says how big a result may be, and the contract does not know it: work that is too big
  // for its task could be committed and never revealed. So the task's limit is read first.
  const { call, callJson, chain, api } = await connectWrite({ keyKind: "full_access" });
  chain.storageBalanceOf.mockResolvedValue(null);

  // The fixture's brief allows 4,096 bytes. The limit is on bytes, not characters.
  for (const content of ["a".repeat(4097), "é".repeat(2049)]) {
    expect(await call("commit_result", { task_id: "7", content })).toEqual({
      isError: true,
      text: "TOO_LARGE: the task allows at most 4096 bytes",
    });
  }
  expect(api.getTask).toHaveBeenCalledWith(7n);
  // Nothing was spent, saved or sent for it, not even the storage top-up that precedes a commit.
  expect(chain.storageBalanceOf).not.toHaveBeenCalled();
  expect(chain.storageDeposit).not.toHaveBeenCalled();
  expect(chain.commit).not.toHaveBeenCalled();
  expect(await state.getDraft("7")).toBeNull();

  // Exactly as much as the task allows goes through.
  chain.storageBalanceOf.mockResolvedValue(ROOMY);
  await callJson("commit_result", { task_id: "7", content: "a".repeat(4096) });
  expect(chain.commit).toHaveBeenCalledTimes(1);

  // It is this task's limit that counts: another task, another limit.
  api.getTask.mockResolvedValue(detailAllowing(10));
  const small = await call("commit_result", { task_id: "8", content: "12345678901" });
  expect(small).toEqual({ isError: true, text: "TOO_LARGE: the task allows at most 10 bytes" });
  expect(api.getTask).toHaveBeenLastCalledWith(8n);
  await callJson("commit_result", { task_id: "8", content: "1234567890" });
});

test("commit_reads_the_task_limit_before_it_spends_on_storage", async () => {
  const { callJson, chain, api } = await connectWrite({ keyKind: "full_access" });
  chain.storageBalanceOf.mockResolvedValue(null);

  await callJson("commit_result", { task_id: "7", content: "a" });

  const [lookedUp] = api.getTask.mock.invocationCallOrder;
  const [toppedUp] = chain.storageDeposit.mock.invocationCallOrder;
  expect(lookedUp).toBeDefined();
  expect(toppedUp).toBeDefined();
  expect(lookedUp ?? Number.MAX_SAFE_INTEGER).toBeLessThan(toppedUp ?? 0);
});

test("a_task_limit_the_api_cannot_give_is_noted_and_does_not_stop_the_commit", async () => {
  // The brief is the API's to give. When it cannot, the commit goes on as it did before the limit
  // was checked, and the answer says what was not checked, in words that carry nothing the API said.
  const leak = "fetch to https://api.example/?key=URLKEY failed (Bearer abc123.DEF)";
  const cases: Array<[string, (api: ReturnType<typeof writeKit>["api"]) => void, RegExp]> = [
    [
      "the API does not answer",
      (api) => api.getTask.mockRejectedValue(new Error(leak)),
      /size limit could not be checked \(the API did not answer\)/,
    ],
    [
      "the API does not know the task",
      (api) => api.getTask.mockResolvedValue(null),
      /size limit could not be checked \(the API has no brief for this task yet\)/,
    ],
    [
      "the API has no brief yet",
      (api) => api.getTask.mockResolvedValue({ ...makeDetail([]), brief: null }),
      /size limit could not be checked \(the API has no brief for this task yet\)/,
    ],
  ];

  let taskId = 0;
  for (const [why, arrange, note] of cases) {
    taskId++;
    const { callJson, chain, api } = await connectWrite();
    arrange(api);
    const answer = await callJson("commit_result", { task_id: String(taskId), content: "a" });
    expect(answer, why).toMatchObject({ tx_hash: "TX_COMMIT" });
    expect(answer, why).toHaveProperty("note", expect.stringMatching(note));
    expect(JSON.stringify(answer), why).not.toMatch(/URLKEY|abc123|api\.example/);
    expect(chain.commit, why).toHaveBeenCalledTimes(1);
  }

  // A limit that is known leaves no note.
  const known = await connectWrite();
  expect(await known.callJson("commit_result", { task_id: "9", content: "a" })).not.toHaveProperty(
    "note",
  );
});

test("commit_from_a_file_needs_a_readable_regular_file_at_an_absolute_path", async () => {
  const files = await makeFilesDir();
  const { call, chain } = await connectWrite({ filesDir: files });
  await writeFile(join(files, "answer.txt"), "x");

  expect((await call("commit_result", { task_id: "7", file_path: "answer.txt" })).text).toMatch(
    /^BAD_INPUT: file_path must be an absolute path/,
  );
  expect((await call("commit_result", { task_id: "7", file_path: "~/answer.txt" })).text).toMatch(
    /^BAD_INPUT: file_path must be an absolute path/,
  );
  const missing = await call("commit_result", { task_id: "7", file_path: join(files, "gone.txt") });
  expect(missing.isError).toBe(true);
  expect(missing.text).toMatch(/^FILE_UNREADABLE: .*ENOENT/);

  expect(chain.commit).not.toHaveBeenCalled();
  expect(await state.getDraft("7")).toBeNull();
});

test("file_inside_the_files_dir_is_committed", async () => {
  // P04-R1: the directory the user named is the whole of what the tool reads from, and everything
  // under it is fair game, by any way of writing its path that ends up there.
  const files = await makeFilesDir();
  await mkdir(join(files, "sub"));
  await writeFile(join(files, "answer.txt"), "from a file");
  await writeFile(join(files, "sub", "deep.txt"), "deeper");
  // A name that starts with two dots is a name, and not a way up.
  await writeFile(join(files, "..dots"), "dots");
  await symlink(join(files, "answer.txt"), join(files, "sub", "link.txt"));
  const { callJson } = await connectWrite({ filesDir: files });

  const cases: Array<[path: string, content: string]> = [
    [join(files, "answer.txt"), "from a file"],
    [join(files, "sub", "deep.txt"), "deeper"],
    [join(files, "..dots"), "dots"],
    // Up and down again, and a doubled slash: where the path ends up is what counts.
    [`${files}/sub/../answer.txt`, "from a file"],
    [`${files}//answer.txt`, "from a file"],
    // A link that stays inside leads to a file that is inside.
    [join(files, "sub", "link.txt"), "from a file"],
  ];
  let taskId = 0;
  for (const [path, content] of cases) {
    taskId++;
    const answer = await callJson("commit_result", { task_id: String(taskId), file_path: path });
    expect(answer, path).toMatchObject({ content_hash: sha256Hex(content) });
    expect((await draftOf(String(taskId))).contentBase64, path).toBe(
      Buffer.from(content).toString("base64"),
    );
  }
});

test("file_outside_the_files_dir_is_refused", async () => {
  // A prompt-injected agent must not be able to commit and then reveal ~/.ssh or an env file.
  const files = await makeFilesDir();
  const outside = join(root, "outside");
  const lookalike = join(root, "files-evil");
  for (const place of [outside, lookalike]) {
    await mkdir(place);
    await writeFile(join(place, "secret.txt"), "TOP SECRET");
  }
  await symlink(join(outside, "secret.txt"), join(files, "link.txt"));
  await symlink(outside, join(files, "linkdir"), "dir");
  await symlink(`../outside/secret.txt`, join(files, "relative-link.txt"));
  const { call, chain } = await connectWrite({ filesDir: files });

  const refused: Array<[why: string, path: string]> = [
    ["plainly outside", join(outside, "secret.txt")],
    ["up and out with ..", `${files}/../outside/secret.txt`],
    ["up and out after going down", `${files}/linkdir/../outside/secret.txt`],
    ["a name that only starts like the directory's", join(lookalike, "secret.txt")],
    ["a link to a file outside", join(files, "link.txt")],
    ["a link with a relative target", join(files, "relative-link.txt")],
    ["a link to a directory outside", join(files, "linkdir", "secret.txt")],
    ["outside and not there", join(outside, "gone.txt")],
    ["outside, not there, and reached with ..", `${files}/../outside/gone.txt`],
    ["the directory itself", files],
    ["the directory with a dot", `${files}/.`],
    ["the directory above it", `${files}/..`],
  ];
  const texts = new Set<string>();
  for (const [why, path] of refused) {
    const answer = await call("commit_result", { task_id: "7", file_path: path });
    expect(answer.isError, why).toBe(true);
    expect(answer.text, why).toMatch(/^FILE_NOT_ALLOWED: file_path must be a file inside /);
    expect(answer.text, why).toContain(files);
    expect(answer.text, why).not.toContain("TOP SECRET");
    texts.add(answer.text);
  }
  // Outside, a file that is there and one that is not get the same answer, so that the tool is no
  // way to find out what is on the disk.
  expect(texts.size).toBe(1);

  expect(chain.commit).not.toHaveBeenCalled();
  expect(chain.storageBalanceOf).not.toHaveBeenCalled();
  expect(await state.getDraft("7")).toBeNull();
});

test("the_files_dir_may_be_reached_by_another_path_to_the_same_place", async () => {
  // /tmp and /private/tmp are one place, and so are a directory and a link to it. What is compared
  // is where the paths lead, so neither way round turns a file away, and neither lets one in.
  const files = await makeFilesDir();
  await writeFile(join(files, "a.txt"), "alias");
  const alias = join(root, "alias");
  await symlink(files, alias, "dir");

  let taskId = 0;
  for (const [configured, named] of [
    [alias, join(files, "a.txt")],
    [files, join(alias, "a.txt")],
    [alias, join(alias, "a.txt")],
  ] as const) {
    taskId++;
    const { callJson } = await connectWrite({ filesDir: configured });
    const answer = await callJson("commit_result", {
      task_id: String(taskId),
      file_path: named,
    });
    expect(answer, `${configured} ${named}`).toMatchObject({ content_hash: sha256Hex("alias") });
  }

  // A file that is not there is said to be missing, by whichever name the directory has: it is
  // inside, and only the outside is kept dark. (The directory's real name is the one that the
  // alias leads to.)
  const real = await realpath(files);
  for (const [configured, named] of [
    [files, join(files, "gone.txt")],
    [alias, join(real, "gone.txt")],
    [alias, join(alias, "gone.txt")],
    // The directory as it was written may have a doubled slash or a ..; it is read as it leads.
    [`${alias}//`, join(alias, "gone.txt")],
    [`${root}/files/../files`, join(files, "gone.txt")],
  ] as const) {
    const { call } = await connectWrite({ filesDir: configured });
    const missing = await call("commit_result", { task_id: "8", file_path: named });
    expect(missing.text, `${configured} ${named}`).toMatch(/^FILE_UNREADABLE: .*ENOENT/);
  }

  // A link to a directory is a way in only for what it leads to: outside stays outside.
  await mkdir(join(root, "elsewhere"));
  await writeFile(join(root, "elsewhere", "b.txt"), "elsewhere");
  const { call } = await connectWrite({ filesDir: alias });
  const out = await call("commit_result", {
    task_id: "9",
    file_path: join(root, "elsewhere", "b.txt"),
  });
  expect(out.text).toMatch(/^FILE_NOT_ALLOWED: /);
});

test("a_files_dir_written_with_a_slash_or_as_the_root_still_holds_what_it_should", async () => {
  // Segments are compared, not text: a trailing slash changes nothing, `/files-evil` is not under
  // `/files/`, and the root is a directory that holds everything.
  const files = await makeFilesDir();
  await writeFile(join(files, "a.txt"), "slash");
  const lookalike = join(root, "files-evil");
  await mkdir(lookalike);
  await writeFile(join(lookalike, "secret.txt"), "TOP SECRET");

  let taskId = 0;
  for (const configured of [`${files}/`, `${files}//`, "/"]) {
    taskId++;
    const { callJson } = await connectWrite({ filesDir: configured });
    const answer = await callJson("commit_result", {
      task_id: String(taskId),
      file_path: join(files, "a.txt"),
    });
    expect(answer, configured).toMatchObject({ content_hash: sha256Hex("slash") });
  }
  for (const configured of [files, `${files}/`]) {
    const { call } = await connectWrite({ filesDir: configured });
    const refused = await call("commit_result", {
      task_id: "9",
      file_path: join(lookalike, "secret.txt"),
    });
    expect(refused.text, configured).toMatch(/^FILE_NOT_ALLOWED: /);
  }
});

test("a_files_dir_that_is_not_there_reads_nothing_and_says_so", async () => {
  // A directory that was named and does not exist (a typo, a drive that is not mounted) must not
  // turn into "anything goes": the tool says what is wrong with it.
  const nowhere = join(root, "nowhere");
  const { call, callJson, chain } = await connectWrite({ filesDir: nowhere });

  const answer = await call("commit_result", {
    task_id: "7",
    file_path: join(nowhere, "answer.txt"),
  });

  expect(answer.isError).toBe(true);
  expect(answer.text).toMatch(/^FILE_UNREADABLE: .*files are read from .*cannot be used: .*ENOENT/);
  expect(answer.text).toContain(nowhere);
  expect(chain.commit).not.toHaveBeenCalled();
  expect(await state.getDraft("7")).toBeNull();
  // Text does not need the directory.
  expect(await callJson("commit_result", { task_id: "7", content: "inline" })).toMatchObject({
    content_hash: sha256Hex("inline"),
  });
});

test("file_path_is_refused_when_no_files_dir_is_set", async () => {
  // Without TENDER_FILES_DIR the tool reads no file at all, wherever the path points.
  const file = join(root, "answer.txt");
  await writeFile(file, "x");
  const { call, callJson, chain } = await connectWrite();

  for (const path of [file, "answer.txt", "/etc/hosts"]) {
    const answer = await call("commit_result", { task_id: "7", file_path: path });
    expect(answer.isError, path).toBe(true);
    expect(answer.text, path).toMatch(/^FILES_DIR_NOT_SET: .*TENDER_FILES_DIR.*content/);
  }
  expect(chain.commit).not.toHaveBeenCalled();
  expect(chain.storageBalanceOf).not.toHaveBeenCalled();
  expect(await state.getDraft("7")).toBeNull();

  // The text itself is not affected.
  expect(await callJson("commit_result", { task_id: "7", content: "inline" })).toMatchObject({
    content_hash: sha256Hex("inline"),
  });
});

test("a_directory_or_a_fifo_is_not_a_file_to_commit", async () => {
  // Inside the directory and still no file: a folder, and a named pipe that would hang a read.
  const files = await makeFilesDir();
  await mkdir(join(files, "folder"));
  execFileSync("mkfifo", [join(files, "pipe")]);
  const { call, chain } = await connectWrite({ filesDir: files });

  for (const path of [join(files, "folder"), join(files, "pipe")]) {
    const answer = await call("commit_result", { task_id: "7", file_path: path });
    expect(answer.isError, path).toBe(true);
    expect(answer.text, path).toMatch(/^BAD_INPUT: file_path is not a regular file/);
  }
  expect(chain.commit).not.toHaveBeenCalled();
  expect(await state.getDraft("7")).toBeNull();
});

test("commit_checks_storage_buffer", async () => {
  // R22: an entry that runs out of storage cannot reveal, so the buffer is checked before the
  // commit. Exactly 1,024 bytes' worth is enough; one yoctoNEAR less is not.
  const { call, chain } = await connectWrite({ keyKind: "full_access" });
  const view = (available: bigint) => ({
    total: "50000000000000000000000",
    available: available.toString(),
    used_bytes: "1000",
  });

  chain.storageBalanceOf.mockResolvedValue(view(STORAGE_NEEDED));
  expect((await call("commit_result", { task_id: "7", content: "a" })).isError).toBe(false);
  expect(chain.storageDeposit).not.toHaveBeenCalled();
  expect(chain.storageBalanceOf).toHaveBeenCalledWith(ACCOUNT);

  // With a full-access key the shortfall is paid in, and 0.01 NEAR more so that the next entry does
  // not need another top-up, and only then does the commit go (P04-P2).
  chain.storageBalanceOf.mockResolvedValue(view(STORAGE_NEEDED - 1n));
  expect((await call("commit_result", { task_id: "8", content: "b" })).isError).toBe(false);
  expect(chain.storageDeposit).toHaveBeenCalledExactlyOnceWith(1n + 10n ** 22n);
  expect(chain.storageDeposit.mock.invocationCallOrder[0]).toBeLessThan(
    chain.commit.mock.invocationCallOrder[1] ?? 0,
  );

  // An account that never deposited pays for its registration too: (1,024 + 133) bytes.
  chain.storageDeposit.mockClear();
  chain.storageBalanceOf.mockResolvedValue(null);
  expect((await call("commit_result", { task_id: "9", content: "c" })).isError).toBe(false);
  expect(chain.storageDeposit).toHaveBeenCalledExactlyOnceWith(
    11_570_000_000_000_000_000_000n + 10n ** 22n,
  );
});

test("full_access_commit_stops_when_the_storage_top_up_fails", async () => {
  const { call, chain } = await connectWrite({ keyKind: "full_access" });
  chain.storageBalanceOf.mockResolvedValue(null);
  chain.storageDeposit.mockRejectedValue(new Error("not enough NEAR on the account"));

  const answer = await call("commit_result", { task_id: "7", content: "a" });

  expect(answer.isError).toBe(true);
  expect(answer.text).toMatch(/^ERROR: not enough NEAR/);
  expect(chain.commit).not.toHaveBeenCalled();
  expect(await state.getDraft("7")).toBeNull();
});

test("fc_key_commit_with_low_storage_refuses", async () => {
  // A function-call key cannot attach a deposit, so it cannot top its storage up: the tool says so
  // and sends nothing, and leaves no draft behind for a commit that never went.
  const { call, chain } = await connectWrite({ keyKind: "function_call" });

  for (const view of [
    null,
    { total: "10000000000000000000000", available: "0", used_bytes: "1000" },
    {
      total: "50000000000000000000000",
      available: (STORAGE_NEEDED - 1n).toString(),
      used_bytes: "1",
    },
  ]) {
    chain.storageBalanceOf.mockResolvedValue(view);
    const answer = await call("commit_result", { task_id: "7", content: "a" });
    expect(answer.isError).toBe(true);
    expect(answer.text).toMatch(/^STORAGE_LOW: /);
    // It says whom to ask, what to call, and how much is missing.
    expect(answer.text).toContain(ACCOUNT);
    expect(answer.text).toContain(`storage_deposit on the contract with account_id ${ACCOUNT}`);
    expect(answer.text).toContain(view === null ? "11570000000000000000000" : "yoctoNEAR");
  }
  expect(chain.commit).not.toHaveBeenCalled();
  expect(chain.storageDeposit).not.toHaveBeenCalled();
  expect(await state.getDraft("7")).toBeNull();

  // The same for a key the server could not classify.
  const unknown = await connectWrite({ keyKind: "unknown" });
  unknown.chain.storageBalanceOf.mockResolvedValue(null);
  expect((await unknown.call("commit_result", { task_id: "7", content: "a" })).text).toMatch(
    /^STORAGE_LOW: /,
  );
  expect(unknown.chain.commit).not.toHaveBeenCalled();
});

test("commit_after_crash_resends_same_commitment", async () => {
  const { call, callJson, chain } = await connectWrite();

  // The commit does not finish: the draft is saved, and nothing says whether the chain has it.
  chain.commit.mockRejectedValueOnce(new Error("socket hang up"));
  const failed = await call("commit_result", { task_id: "7", content: "forty-two" });
  expect(failed.isError).toBe(true);
  expect(failed.text).toMatch(/^ERROR: socket hang up/);
  // The agent is told what to do about it, and the draft is neither committed nor given up.
  expect(failed.text).toContain("call commit_result again with the same content");
  const saved = await draftOf("7");
  expect(saved.committedAt).toBeUndefined();
  expect(saved.dead).toBeUndefined();

  // Calling again asks the chain, finds no commit, and sends the draft's own commitment: the same
  // salt, the same hash. It does not make a new draft.
  const again = await callJson("commit_result", { task_id: "7", content: "forty-two" });
  expect(chain.getEntry).toHaveBeenCalledExactlyOnceWith(7n, ACCOUNT);
  expect(chain.commit).toHaveBeenCalledTimes(2);
  expect(chain.commit).toHaveBeenNthCalledWith(1, 7n, saved.commitment);
  expect(chain.commit).toHaveBeenNthCalledWith(2, 7n, saved.commitment);
  expect(again).toMatchObject({
    commitment: saved.commitment,
    content_hash: sha256Hex("forty-two"),
    tx_hash: "TX_COMMIT",
  });
  const done = await draftOf("7");
  expect(done).toMatchObject({ salt: saved.salt, commitment: saved.commitment });
  expect(done.committedAt).toMatch(ISO);

  // Once committed, a third call sends nothing: it says the commit is there already.
  const third = await callJson("commit_result", { task_id: "7", content: "forty-two" });
  expect(chain.commit).toHaveBeenCalledTimes(2);
  expect(chain.getEntry).toHaveBeenCalledTimes(1);
  expect(third).toMatchObject({ commitment: saved.commitment, tx_hash: null });
  expect(third).toHaveProperty("note", expect.stringMatching(/already committed/));
  expect(await draftOf("7")).toEqual(done);
});

test("commit_after_a_crash_finds_a_commit_that_landed", async () => {
  // The commit went through, but the draft was never marked: the chain has the entry. Sending
  // again would only move its block forward, and the block breaks ties between equal scores.
  const draft = makeDraft("7");
  await state.saveDraft(draft);
  const { callJson, chain } = await connectWrite();
  chain.getEntry.mockResolvedValue(entryView(draft.commitment));

  const answer = await callJson("commit_result", { task_id: "7", content: "answer for task 7" });

  expect(chain.commit).not.toHaveBeenCalled();
  expect(answer).toMatchObject({ commitment: draft.commitment, tx_hash: null });
  expect(answer).toHaveProperty("note", expect.stringMatching(/on chain already/));
  expect((await draftOf("7")).committedAt).toMatch(ISO);
});

test("a_commit_that_cannot_be_looked_up_is_not_sent_blind", async () => {
  await state.saveDraft(makeDraft("7"));
  const { call, chain } = await connectWrite();
  chain.getEntry.mockRejectedValue(new Error("RPC is down"));

  const answer = await call("commit_result", { task_id: "7", content: "answer for task 7" });

  expect(answer).toEqual({ isError: true, text: expect.stringMatching(/^ERROR: RPC is down/) });
  expect(chain.commit).not.toHaveBeenCalled();
  expect((await draftOf("7")).committedAt).toBeUndefined();
});

test("a_pending_draft_is_finished_whatever_content_is_given_now", async () => {
  // "Never makes a new one": the salt of a commit that may be on chain is not thrown away for new
  // content. The old draft is sent as it is, and the answer says so.
  const { call, callJson, chain } = await connectWrite();
  chain.commit.mockRejectedValueOnce(new Error("socket hang up"));
  await call("commit_result", { task_id: "7", content: "first answer" });
  const saved = await draftOf("7");

  const answer = await callJson("commit_result", { task_id: "7", content: "second answer" });

  expect(chain.commit).toHaveBeenNthCalledWith(2, 7n, saved.commitment);
  expect(answer).toMatchObject({
    commitment: saved.commitment,
    content_hash: sha256Hex("first answer"),
    tx_hash: "TX_COMMIT",
  });
  expect(answer).toHaveProperty("note", expect.stringMatching(/differs/));
  expect(await draftOf("7")).toMatchObject({
    salt: saved.salt,
    contentHash: sha256Hex("first answer"),
  });
});

test("a_committed_draft_is_not_replaced_by_other_content", async () => {
  // The store keeps one draft per task. Committing other content would write over the salt that
  // opens the commitment on chain before the new commit has landed.
  const { call, callJson, chain } = await connectWrite();
  await callJson("commit_result", { task_id: "7", content: "first answer" });
  const committed = await draftOf("7");

  const answer = await call("commit_result", { task_id: "7", content: "second answer" });

  expect(answer.isError).toBe(true);
  expect(answer.text).toMatch(/^ALREADY_COMMITTED: /);
  expect(chain.commit).toHaveBeenCalledTimes(1);
  expect(await draftOf("7")).toEqual(committed);
});

test("a_commit_the_contract_refuses_for_good_retires_the_draft", async () => {
  // The codes that a second try meets again (P05-R14): the draft is dead, and stays dead.
  const forGood = ["E_NOT_FOUND", "E_PHASE", "E_AUTH", "E_INVITE", "E_HASH", "E_FULL", "E_ARGS"];
  const { call, chain } = await connectWrite();

  let taskId = 20;
  for (const code of forGood) {
    taskId++;
    const id = String(taskId);
    chain.commit.mockRejectedValueOnce(new TenderError(code, `${code}: refused for good`));
    const refused = await call("commit_result", { task_id: id, content: "a" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(new RegExp(`^${code}: refused for good`));
    expect(refused.text).toContain("retired");
    const dead = await draftOf(id);
    expect(dead.dead?.reason).toBe(`${code}: refused for good`);
    expect(dead.dead?.at).toMatch(ISO);
    expect(dead.committedAt).toBeUndefined();
  }

  // A dead draft is not touched again: the tool asks the chain nothing and sends nothing.
  chain.commit.mockClear();
  chain.getEntry.mockClear();
  chain.storageBalanceOf.mockClear();
  const again = await call("commit_result", { task_id: "21", content: "a" });
  expect(again.isError).toBe(true);
  expect(again.text).toMatch(/^DRAFT_DEAD: .*E_NOT_FOUND: refused for good/);
  expect(chain.commit).not.toHaveBeenCalled();
  expect(chain.getEntry).not.toHaveBeenCalled();
  expect(chain.storageBalanceOf).not.toHaveBeenCalled();
  // Other content does not bring it back either, and it is not revealed.
  expect((await call("commit_result", { task_id: "21", content: "b" })).text).toMatch(
    /^DRAFT_DEAD: /,
  );
  const reveal = await call("reveal_result", { task_id: "21" });
  expect(reveal.text).toMatch(/^DRAFT_DEAD: /);
  expect(chain.reveal).not.toHaveBeenCalled();
});

test("a_refused_commit_that_is_on_chain_already_is_not_retired", async () => {
  // A first send died with the process and landed. The retry starts from a view that has not seen
  // it, is refused because the window has closed since, and only then finds the entry.
  const draft = makeDraft("7");
  await state.saveDraft(draft);
  const { callJson, chain } = await connectWrite();
  chain.getEntry.mockResolvedValueOnce(null).mockResolvedValue(entryView(draft.commitment));
  chain.commit.mockRejectedValueOnce(
    new TenderError("E_PHASE", "E_PHASE: task 7 is not open for commits"),
  );

  const answer = await callJson("commit_result", { task_id: "7", content: "answer for task 7" });

  expect(answer).toMatchObject({ commitment: draft.commitment, tx_hash: null });
  expect(answer).toHaveProperty("note", expect.stringMatching(/on chain already/));
  // The draft is the key to an entry that stands: it is committed, and not dead.
  const kept = await draftOf("7");
  expect(kept.dead).toBeUndefined();
  expect(kept.committedAt).toMatch(ISO);
});

test("a_refused_commit_is_not_retired_when_the_chain_cannot_be_asked", async () => {
  const draft = makeDraft("7");
  await state.saveDraft(draft);
  const { call, chain } = await connectWrite();
  chain.getEntry.mockResolvedValueOnce(null).mockRejectedValue(new Error("RPC is down"));
  chain.commit.mockRejectedValueOnce(
    new TenderError("E_PHASE", "E_PHASE: task 7 is not open for commits"),
  );

  const answer = await call("commit_result", { task_id: "7", content: "answer for task 7" });

  // Retiring a draft is final, so without an answer from the chain it stays as it is.
  expect(answer.isError).toBe(true);
  expect(answer.text).toMatch(/^E_PHASE: task 7 is not open for commits .*left as it is/);
  expect(answer.text).not.toContain("retired");
  const kept = await draftOf("7");
  expect(kept.dead).toBeUndefined();
  expect(kept.committedAt).toBeUndefined();
});

test("a_commit_that_may_work_later_leaves_the_draft_alone", async () => {
  // Storage can be topped up, and a node that is down comes back: none of these is final.
  const { call, chain } = await connectWrite();

  let taskId = 40;
  for (const failure of [
    new TenderError("E_STORAGE", "E_STORAGE: storage is short"),
    new TenderError("E_UNKNOWN", "something the client cannot name"),
    new TenderError("E_PAUSED", "E_PAUSED: paused"),
    new Error("fetch failed"),
  ]) {
    taskId++;
    chain.commit.mockRejectedValueOnce(failure);
    const answer = await call("commit_result", { task_id: String(taskId), content: "a" });
    expect(answer.isError).toBe(true);
    expect(answer.text).not.toContain("retired");
    expect(await draftOf(String(taskId))).toMatchObject({ taskId: String(taskId) });
    expect((await draftOf(String(taskId))).dead).toBeUndefined();
  }
});

test("contract_error_code_surfaces", async () => {
  const { call, chain, api } = await connectWrite({
    keyKind: "full_access",
    judgeAccount: "judge.testnet",
  });
  await state.saveDraft(makeDraft("5", { committedAt: "2026-11-04T09:30:00.000Z" }));
  const refusal = (code: string, detail: string) =>
    new TenderError(code, `Smart contract panicked: ${code}: ${detail}`, { txHash: "TX_FAILED" });

  // The code leads, and the contract's own words follow it once, without its framing.
  chain.commit.mockRejectedValue(refusal("E_PHASE", "task 7 is not open for commits"));
  const commit = await call("commit_result", { task_id: "7", content: "a" });
  expect(commit.isError).toBe(true);
  expect(commit.text).toMatch(/^E_PHASE: task 7 is not open for commits/);
  expect(commit.text).not.toContain("Smart contract panicked");

  chain.reveal.mockRejectedValue(refusal("E_COMMITMENT", "content_hash and salt do not match"));
  expect(await call("reveal_result", { task_id: "5" })).toEqual({
    isError: true,
    text: "E_COMMITMENT: content_hash and salt do not match",
  });

  const cases: Array<[string, Record<string, unknown>, () => void]> = [
    [
      "pick_winners",
      { task_id: "7", winners: [{ account: ACCOUNT, bps: 10_000 }], scorecard: SCORECARD },
      () => chain.pick.mockRejectedValue(refusal("E_AUTH", "only the verifier can pick")),
    ],
    [
      "deposit",
      { amount: "100" },
      () => chain.deposit.mockRejectedValue(refusal("E_TOKEN", "token is not allowed")),
    ],
    [
      "withdraw",
      { amount: "100" },
      () => chain.withdraw.mockRejectedValue(refusal("E_FUNDS", "not enough in the vault")),
    ],
    [
      "register_agent",
      { name: "Alice", description: "An agent", tags: ["data"] },
      () => chain.registerAgent.mockRejectedValue(refusal("E_STORAGE", "no storage balance")),
    ],
    [
      "post_task",
      POST_ARGS,
      () => chain.postTask.mockRejectedValue(refusal("E_REWARD", "reward is out of bounds")),
    ],
  ];
  for (const [name, args, arrange] of cases) {
    arrange();
    const answer = await call(name, args);
    expect(answer.isError, name).toBe(true);
    expect(answer.text, name).toMatch(/^E_[A-Z]+: [a-z]/);
    expect(answer.text, name).not.toContain("Smart contract panicked");
  }
  expect(api.uploadBlob).toHaveBeenCalled();
});

test("draft_of_another_account_is_refused", async () => {
  // A state directory shared by two accounts holds both their drafts under one task id. The draft
  // of bob's task 7 is not alice's: her tools neither extend it, nor reveal it, nor show it as hers.
  const content = "bob's answer";
  const contentHash = sha256Hex(content);
  const bobs: Draft = {
    taskId: "7",
    contentBase64: Buffer.from(content).toString("base64"),
    contentHash,
    salt: SALT,
    commitment: computeCommitment(7n, OTHER, contentHash, SALT),
    committedAt: "2026-11-04T09:30:00.000Z",
  };
  await state.saveDraft(bobs);
  const { call, callJson, chain, api } = await connectWrite();
  api.getTask.mockResolvedValue(makeDetail([]));

  const reveal = await call("reveal_result", { task_id: "7" });
  expect(reveal.isError).toBe(true);
  expect(reveal.text).toMatch(/^DRAFT_NOT_YOURS: /);
  const commit = await call("commit_result", { task_id: "7", content });
  expect(commit.isError).toBe(true);
  expect(commit.text).toMatch(/^DRAFT_NOT_YOURS: /);
  // Nothing was uploaded, revealed or sent, and the draft is as it was.
  expect(api.uploadBlob).not.toHaveBeenCalled();
  expect(chain.reveal).not.toHaveBeenCalled();
  expect(chain.commit).not.toHaveBeenCalled();
  expect(chain.getEntry).not.toHaveBeenCalled();
  expect(await draftOf("7")).toEqual(bobs);

  // The read tools do not show it as hers either, and say whose it is not.
  api.getTask.mockResolvedValue(makeDetail([]));
  const task = (await callJson("get_task", { task_id: "7" })) as {
    own_entry: { status: string; draft: unknown; draft_error: string };
  };
  expect(task.own_entry).toMatchObject({ status: "none", draft: null });
  expect(task.own_entry.draft_error).toMatch(/^DRAFT_NOT_YOURS: /);
  const listEntries = vi.fn<TenderApi["listEntries"]>(async () => ({ entries: [] }));
  const mine = await connect({ api: fakeApi({ listEntries }) });
  await state.saveDraft(makeDraft("3"));
  expect(await mine.callJson("my_entries")).toMatchObject({
    drafts: [{ task_id: "3" }],
    other_accounts_drafts: ["7"],
  });
});

test("reveal_without_draft_errors", async () => {
  const { call, chain, api } = await connectWrite();

  const answer = await call("reveal_result", { task_id: "9" });

  expect(answer.isError).toBe(true);
  expect(answer.text).toMatch(/^NO_DRAFT: .*task 9/);
  expect(api.uploadBlob).not.toHaveBeenCalled();
  expect(chain.reveal).not.toHaveBeenCalled();
});

test("reveal_uploads_the_work_then_reveals_it_and_marks_the_draft", async () => {
  const draft = makeDraft("7", { committedAt: "2026-11-04T09:30:00.000Z" });
  await state.saveDraft(draft);
  const { callJson, chain, api } = await connectWrite();

  const answer = await callJson("reveal_result", { task_id: "7" });

  const uri = `${BLOBS}/${draft.contentHash}`;
  expect(answer).toEqual({ uri, tx_hash: "TX_REVEAL" });
  expect(api.getTask).toHaveBeenCalledWith(7n);
  expect(api.uploadBlob).toHaveBeenCalledExactlyOnceWith({
    kind: "result",
    // The brief asks for JSON (BRIEF.output.format), so the work goes up as JSON.
    contentType: "application/json",
    bytes: expect.any(Uint8Array),
    taskId: 7n,
  });
  const upload = api.uploadBlob.mock.calls[0]?.[0];
  expect(Buffer.from(upload?.bytes ?? []).toString()).toBe("answer for task 7");
  expect(chain.reveal).toHaveBeenCalledExactlyOnceWith(7n, draft.contentHash, SALT, uri);
  // The upload comes first: a reveal with a uri that serves nothing yet would be worth nothing.
  expect(api.uploadBlob.mock.invocationCallOrder[0]).toBeLessThan(
    chain.reveal.mock.invocationCallOrder[0] ?? 0,
  );
  // The draft is marked, with everything else kept.
  expect(await draftOf("7")).toEqual({ ...draft, revealedUri: uri });
  expect(JSON.stringify(answer)).not.toContain(SALT);
});

test("reveal_sends_the_work_as_the_brief_asks_for_it", async () => {
  const formats = {
    json: "application/json",
    regex_json: "application/json",
    text: "text/plain",
    code_js: "text/plain",
  } as const;
  const { callJson, api } = await connectWrite();

  let taskId = 60;
  for (const [format, contentType] of Object.entries(formats)) {
    const id = String(++taskId);
    await state.saveDraft(makeDraft(id, { committedAt: "2026-11-04T09:30:00.000Z" }));
    api.getTask.mockResolvedValue({
      ...makeDetail([]),
      brief: { ...BRIEF, output: { format: format as keyof typeof formats, max_bytes: 4096 } },
    });
    await callJson("reveal_result", { task_id: id });
    expect(api.uploadBlob, format).toHaveBeenLastCalledWith(
      expect.objectContaining({ contentType }),
    );
  }

  // A task the index has not seen, or whose brief it could not read, has no format to go by.
  for (const missing of [null, { ...makeDetail([]), brief: null }]) {
    const id = String(++taskId);
    await state.saveDraft(makeDraft(id, { committedAt: "2026-11-04T09:30:00.000Z" }));
    api.getTask.mockResolvedValue(missing);
    await callJson("reveal_result", { task_id: id });
    expect(api.uploadBlob).toHaveBeenLastCalledWith(
      expect.objectContaining({ contentType: "text/plain" }),
    );
  }
});

test("reveal_retry_after_a_failure_uploads_again_and_reveals_once", async () => {
  // A crash or an early call between the upload and the reveal leaves a draft that is not marked:
  // the next call does both again. The upload is idempotent, as the API names bytes by their hash.
  const draft = makeDraft("7", { committedAt: "2026-11-04T09:30:00.000Z" });
  await state.saveDraft(draft);
  const { call, callJson, chain, api } = await connectWrite();
  chain.reveal.mockRejectedValueOnce(
    new TenderError("E_PHASE", "E_PHASE: task 7 is not in its reveal window"),
  );

  const early = await call("reveal_result", { task_id: "7" });
  expect(early.text).toMatch(/^E_PHASE: task 7 is not in its reveal window/);
  expect((await draftOf("7")).revealedUri).toBeUndefined();
  // A refusal that may pass does not retire the draft: the window may simply not have opened yet.
  expect((await draftOf("7")).dead).toBeUndefined();

  const answer = await callJson("reveal_result", { task_id: "7" });
  expect(answer).toMatchObject({ tx_hash: "TX_REVEAL" });
  expect(api.uploadBlob).toHaveBeenCalledTimes(2);
  expect(chain.reveal).toHaveBeenCalledTimes(2);
  expect((await draftOf("7")).revealedUri).toBe(`${BLOBS}/${draft.contentHash}`);
});

test("reveal_after_a_crash_between_the_reveal_and_the_mark", async () => {
  // The reveal went through, then the process died before the draft was marked. The next call
  // uploads and reveals again, is told the entry is revealed (E_REVEALED), and marks the draft.
  const draft = makeDraft("7", { committedAt: "2026-11-04T09:30:00.000Z" });
  await state.saveDraft(draft);
  const { callJson, chain } = await connectWrite();
  chain.reveal.mockRejectedValueOnce(new TenderError("E_REVEALED", "E_REVEALED: already revealed"));

  const answer = await callJson("reveal_result", { task_id: "7" });

  const uri = `${BLOBS}/${draft.contentHash}`;
  expect(answer).toMatchObject({ uri, tx_hash: null });
  expect(answer).toHaveProperty("note", expect.stringMatching(/revealed already/));
  expect((await draftOf("7")).revealedUri).toBe(uri);
});

test("reveal_whose_draft_cannot_be_marked_is_retried", async () => {
  const draft = makeDraft("7", { committedAt: "2026-11-04T09:30:00.000Z" });
  await state.saveDraft(draft);
  const brokenDisk: StateStore = {
    ...state,
    markRevealed: async () => {
      throw new Error("disk full");
    },
  };
  const first = await connectWrite({ state: brokenDisk });

  // On chain it is revealed, and the answer says the mark is missing instead of failing.
  const answer = await first.callJson("reveal_result", { task_id: "7" });
  expect(answer).toMatchObject({ tx_hash: "TX_REVEAL" });
  expect(answer).toHaveProperty("note", expect.stringMatching(/could not be marked.*disk full/));
  expect((await draftOf("7")).revealedUri).toBeUndefined();

  // The next call, with a disk that works, finds it revealed and marks it.
  const second = await connectWrite();
  second.chain.reveal.mockRejectedValueOnce(new TenderError("E_REVEALED", "E_REVEALED: done"));
  await second.callJson("reveal_result", { task_id: "7" });
  expect((await draftOf("7")).revealedUri).toBe(`${BLOBS}/${draft.contentHash}`);
});

test("a_revealed_draft_is_not_revealed_again", async () => {
  const uri = `${BLOBS}/done`;
  await state.saveDraft(
    makeDraft("7", { committedAt: "2026-11-04T09:30:00.000Z", revealedUri: uri }),
  );
  const { callJson, chain, api } = await connectWrite();

  const answer = await callJson("reveal_result", { task_id: "7" });

  expect(answer).toMatchObject({ uri, tx_hash: null });
  expect(api.uploadBlob).not.toHaveBeenCalled();
  expect(chain.reveal).not.toHaveBeenCalled();
  // And it is not committed again either.
  const commit = await connectWrite();
  expect((await commit.call("commit_result", { task_id: "7", content: "x" })).text).toMatch(
    /^ALREADY_REVEALED: /,
  );
});

test("reveal_needs_a_commit_that_is_on_chain", async () => {
  // A draft that was never confirmed may be on chain or not; the chain is asked before anything is
  // uploaded. If it has the commit, the draft is marked and the reveal goes ahead.
  const draft = makeDraft("7");
  await state.saveDraft(draft);
  const { call, callJson, chain, api } = await connectWrite();

  const missing = await call("reveal_result", { task_id: "7" });
  expect(missing.isError).toBe(true);
  expect(missing.text).toMatch(/^NOT_COMMITTED: .*commit_result/);
  expect(api.uploadBlob).not.toHaveBeenCalled();
  expect(chain.reveal).not.toHaveBeenCalled();

  chain.getEntry.mockResolvedValue(entryView(draft.commitment));
  await callJson("reveal_result", { task_id: "7" });
  expect(chain.reveal).toHaveBeenCalledTimes(1);
  expect((await draftOf("7")).committedAt).toMatch(ISO);

  // An entry with another commitment is not this draft's.
  await state.saveDraft(makeDraft("8"));
  chain.getEntry.mockResolvedValue(entryView("ab".repeat(32)));
  expect((await call("reveal_result", { task_id: "8" })).text).toMatch(/^NOT_COMMITTED: /);
});

test("reveal_refuses_work_that_no_longer_matches_its_hash", async () => {
  // The draft file was altered on disk. Revealing its hash with other bytes behind the uri would
  // score nothing and give the real work away.
  const draft = makeDraft("7", {
    committedAt: "2026-11-04T09:30:00.000Z",
    contentBase64: Buffer.from("not what was committed").toString("base64"),
  });
  await state.saveDraft(draft);
  const { call, chain, api } = await connectWrite();

  const answer = await call("reveal_result", { task_id: "7" });

  expect(answer.isError).toBe(true);
  expect(answer.text).toMatch(/^DRAFT_CORRUPT: /);
  expect(api.uploadBlob).not.toHaveBeenCalled();
  expect(chain.reveal).not.toHaveBeenCalled();
});

test("reveal_refuses_an_upload_that_stored_other_bytes", async () => {
  await state.saveDraft(makeDraft("7", { committedAt: "2026-11-04T09:30:00.000Z" }));
  const { call, chain, api } = await connectWrite();
  api.uploadBlob.mockResolvedValue({ sha256: "ee".repeat(32), uri: `${BLOBS}/${"ee".repeat(32)}` });

  const answer = await call("reveal_result", { task_id: "7" });

  expect(answer.isError).toBe(true);
  expect(answer.text).toMatch(/^HASH_MISMATCH: /);
  expect(chain.reveal).not.toHaveBeenCalled();
  expect((await draftOf("7")).revealedUri).toBeUndefined();
});

test("reveal_says_when_the_index_has_not_seen_the_commit_yet", async () => {
  await state.saveDraft(makeDraft("7", { committedAt: "2026-11-04T09:30:00.000Z" }));
  const { call, chain, api } = await connectWrite();
  api.uploadBlob.mockRejectedValue(new ApiError(403, { error: "forbidden", message: "no entry" }));

  const answer = await call("reveal_result", { task_id: "7" });

  expect(answer.isError).toBe(true);
  expect(answer.text).toMatch(
    /^API_ERROR: request failed with status 403 \(forbidden\); .*indexed/,
  );
  expect(chain.reveal).not.toHaveBeenCalled();
});

test("calls_for_one_task_run_one_at_a_time", async () => {
  // The state store has no locks, so two calls for one task must not interleave their reads and
  // writes of the draft. The second waits for the first, and then finds its commit done.
  const { call, chain } = await connectWrite();
  const release = deferred();
  chain.commit.mockImplementation(async () => {
    await release.promise;
    return tx("TX_COMMIT");
  });

  const first = call("commit_result", { task_id: "7", content: "forty-two" });
  await until(() => chain.commit.mock.calls.length === 1);
  const second = call("commit_result", { task_id: "7", content: "forty-two" });
  const reveal = call("reveal_result", { task_id: "7" });
  await new Promise((done) => setTimeout(done, 100));
  // Neither has touched the chain or the API while the first holds the task.
  expect(chain.commit).toHaveBeenCalledTimes(1);
  expect(chain.getEntry).not.toHaveBeenCalled();
  expect(chain.storageBalanceOf).toHaveBeenCalledTimes(1);

  release.resolve();
  const [one, two, three] = await Promise.all([first, second, reveal]);
  expect(one.isError).toBe(false);
  expect(bodyOf(one).tx_hash).toBe("TX_COMMIT");
  // The second found the commit done and sent nothing.
  expect(two.isError).toBe(false);
  expect(bodyOf(two).tx_hash).toBeNull();
  expect(chain.commit).toHaveBeenCalledTimes(1);
  // The reveal came last, saw the committed draft, and went on to the upload.
  expect(three.isError).toBe(false);
  expect(chain.reveal).toHaveBeenCalledTimes(1);
});

test("calls_for_different_tasks_do_not_wait_for_each_other", async () => {
  const { call, chain } = await connectWrite();
  const release = deferred();
  chain.commit.mockImplementationOnce(async () => {
    await release.promise;
    return tx("TX_SLOW");
  });

  const slow = call("commit_result", { task_id: "7", content: "a" });
  await until(() => chain.commit.mock.calls.length === 1);
  const quick = await call("commit_result", { task_id: "8", content: "b" });

  expect(bodyOf(quick).tx_hash).toBe("TX_COMMIT");
  release.resolve();
  expect(bodyOf(await slow).tx_hash).toBe("TX_SLOW");
});

test("a_failed_call_does_not_hold_the_task_for_the_next", async () => {
  const { call, chain } = await connectWrite();
  chain.commit.mockRejectedValueOnce(new Error("socket hang up"));

  expect((await call("commit_result", { task_id: "7", content: "a" })).isError).toBe(true);
  const retry = await call("commit_result", { task_id: "7", content: "a" });

  expect(retry.isError).toBe(false);
});

const POST_ARGS = {
  title: BRIEF.title,
  summary: BRIEF.summary,
  instructions: BRIEF.instructions,
  category: BRIEF.category,
  tags: BRIEF.tags,
  output_format: "json",
  max_bytes: 4096,
  criteria: CRITERIA,
  heldout: HELDOUT,
  reward: "1500000",
  verifier: "judge",
  commit_secs: 600,
  reveal_secs: 300,
  pick_secs: 600,
  fallback_secs: 600,
  max_winners: 1,
};

test("post_task_uploads_and_passes_commitment", async () => {
  const { callJson, chain, api } = await connectWrite({
    keyKind: "full_access",
    judgeAccount: "judge.testnet",
  });

  const answer = await callJson("post_task", POST_ARGS);

  // The brief and the criteria go up as canonical JSON, and the chain gets the hash of those bytes.
  const brief = canonicalJson(BRIEF);
  const criteria = canonicalJson(CRITERIA);
  const heldout = canonicalJson(HELDOUT);
  expect(api.uploadBlob).toHaveBeenCalledTimes(2);
  expect(api.uploadBlob).toHaveBeenNthCalledWith(1, {
    kind: "brief",
    contentType: "application/json",
    bytes: brief,
  });
  expect(api.uploadBlob).toHaveBeenNthCalledWith(2, {
    kind: "criteria",
    contentType: "application/json",
    bytes: criteria,
  });
  // The held-out document goes to its own intake, which keeps it secret, with its commitment.
  expect(api.uploadHeldout).toHaveBeenCalledExactlyOnceWith(sha256Hex(heldout), heldout);
  expect(chain.postTask).toHaveBeenCalledExactlyOnceWith({
    token: USDC,
    reward: 1_500_000n,
    briefUri: `${BLOBS}/${sha256Hex(brief)}`,
    briefHash: sha256Hex(brief),
    criteriaHash: sha256Hex(criteria),
    heldoutCommitment: sha256Hex(heldout),
    verifier: "judge.testnet",
    commitSecs: 600,
    revealSecs: 300,
    pickSecs: 600,
    fallbackSecs: 600,
    maxWinners: 1,
  });
  // Everything is stored before any money moves.
  const lastUpload = Math.max(
    ...api.uploadBlob.mock.invocationCallOrder,
    ...api.uploadHeldout.mock.invocationCallOrder,
  );
  expect(lastUpload).toBeLessThan(chain.postTask.mock.invocationCallOrder[0] ?? 0);
  expect(answer).toEqual({
    task_id: "12",
    tx_hash: "TX_POST",
    commit_deadline: "2026-11-04T10:00:00.000Z",
  });
});

test("post_task_without_a_heldout_part_or_a_verifier_or_a_token", async () => {
  const { callJson, chain, api } = await connectWrite({ keyKind: "full_access" });
  const { heldout: _heldout, verifier: _verifier, max_bytes: _maxBytes, ...rest } = POST_ARGS;
  const criteria = { ...CRITERIA, has_heldout: false };

  await callJson("post_task", {
    ...rest,
    criteria,
    token: WEIRD,
    invited: [OTHER],
    max_winners: 2,
  });

  expect(api.uploadHeldout).not.toHaveBeenCalled();
  const brief = canonicalJson({ ...BRIEF, output: { format: "json", max_bytes: 262_144 } });
  expect(api.uploadBlob).toHaveBeenNthCalledWith(1, expect.objectContaining({ bytes: brief }));
  const sent = chain.postTask.mock.calls[0]?.[0];
  expect(sent).toMatchObject({ token: WEIRD, maxWinners: 2, invited: [OTHER] });
  // The poster verifies its own task unless it names a verifier, and a task with no held-out part
  // commits to none.
  expect(sent?.verifier).toBeUndefined();
  expect(sent?.heldoutCommitment).toBeUndefined();

  // A verifier named by account is passed as it is.
  await callJson("post_task", { ...rest, criteria, verifier: "judge.testnet" });
  expect(chain.postTask.mock.calls[1]?.[0]).toMatchObject({ verifier: "judge.testnet" });
});

test("post_task_judge_verifier_needs_judge_account", async () => {
  // "judge" means the Judge's account, which this server only knows if it was told.
  const { call, chain, api } = await connectWrite({ keyKind: "full_access" });

  const answer = await call("post_task", POST_ARGS);

  expect(answer.isError).toBe(true);
  expect(answer.text).toMatch(/^NO_JUDGE_ACCOUNT: .*TENDER_JUDGE_ACCOUNT/);
  expect(api.uploadBlob).not.toHaveBeenCalled();
  expect(api.uploadHeldout).not.toHaveBeenCalled();
  expect(chain.postTask).not.toHaveBeenCalled();

  // With the account set, "judge" is that account (post_task_uploads_and_passes_commitment).
  const withJudge = await connectWrite({ keyKind: "full_access", judgeAccount: "judge.testnet" });
  expect((await withJudge.call("post_task", POST_ARGS)).isError).toBe(false);
});

test("post_task_refuses_what_the_shared_schemas_refuse_before_anything_is_sent", async () => {
  const { call, chain, api } = await connectWrite({
    keyKind: "full_access",
    judgeAccount: "judge.testnet",
  });
  const refused: Array<[string, Record<string, unknown>, RegExp]> = [
    [
      "criteria of no known kind",
      { criteria: { ...CRITERIA, kind: "vibes" } },
      /^INVALID_CRITERIA: /,
    ],
    [
      "a criteria key it does not list",
      { criteria: { ...CRITERIA, extra: 1 } },
      /^INVALID_CRITERIA: /,
    ],
    [
      "a score out of range",
      { criteria: { ...CRITERIA, min_score: 101 } },
      /^INVALID_CRITERIA: .*min_score/,
    ],
    ["a held-out document of no kind", { heldout: { vibes: {} } }, /^INVALID_HELDOUT: /],
    [
      "a held-out document of another kind",
      { heldout: { regex_cases: { match: [], no_match: [] } } },
      /^INVALID_HELDOUT: .*kind/,
    ],
    [
      "a held-out part that the criteria do not announce",
      { criteria: { ...CRITERIA, has_heldout: false } },
      /^INVALID_CRITERIA: .*has_heldout/,
    ],
    [
      "criteria that announce a held-out part and none given",
      { heldout: undefined },
      /^INVALID_CRITERIA: .*has_heldout/,
    ],
    [
      "a reward with a point",
      { reward: "1.5" },
      /^BAD_AMOUNT: .*smallest unit.*"1000000" is 1 USDC/,
    ],
    ["a reward of nothing", { reward: "0" }, /^BAD_AMOUNT: /],
    ["a reward that is not a number", { reward: "lots" }, /^BAD_AMOUNT: /],
    [
      "a reward above a u128",
      { reward: "340282366920938463463374607431768211456" },
      /^BAD_AMOUNT: /,
    ],
    ["a verifier that is no account", { verifier: "Not An Account" }, /^BAD_INPUT: .*verifier/],
    ["a token that is no account", { token: "Not An Account" }, /^BAD_INPUT: .*token/],
  ];
  for (const [what, change, expected] of refused) {
    const answer = await call("post_task", { ...POST_ARGS, ...change });
    expect(answer.isError, what).toBe(true);
    expect(answer.text, what).toMatch(expected);
  }

  // Windows below the network's least (60 s on testnet), or not whole, and a brief past the shared
  // limits, are turned back by the tool's own schema.
  for (const change of [
    { commit_secs: 59 },
    { reveal_secs: 1.5 },
    { pick_secs: -1 },
    { fallback_secs: 0 },
    { title: "" },
    { tags: ["Not A Tag"] },
    { category: "vibes" },
    { max_winners: 6 },
    { max_bytes: 262_145 },
    { output_format: "yaml" },
  ]) {
    const answer = await call("post_task", { ...POST_ARGS, ...change });
    expect(answer.isError, JSON.stringify(change)).toBe(true);
  }
  expect(api.uploadBlob).not.toHaveBeenCalled();
  expect(api.uploadHeldout).not.toHaveBeenCalled();
  expect(chain.postTask).not.toHaveBeenCalled();
});

test("fc_key_spend_tools_explain_and_skip_tx", async () => {
  // A function-call key cannot attach the deposit these calls need. The tools say so before they
  // send, or upload, anything: the chain and the API record no call at all.
  for (const keyKind of ["function_call", "unknown"] as const) {
    const { call, chain, api } = await connectWrite({ keyKind, judgeAccount: "judge.testnet" });
    const attempts: Array<[string, Record<string, unknown>]> = [
      ["deposit", { amount: "100" }],
      ["withdraw", { amount: "100", to: OTHER }],
      ["post_task", POST_ARGS],
    ];
    for (const [name, args] of attempts) {
      expect(await call(name, args), `${keyKind} ${name}`).toEqual({
        isError: true,
        text: NEEDS_FULL_ACCESS_KEY,
      });
    }
    for (const mock of [...Object.values(chain), ...Object.values(api)]) {
      expect(mock).not.toHaveBeenCalled();
    }
  }

  // The tools that need no deposit work with such a key (the contract's own rule).
  const { call } = await connectWrite({ keyKind: "function_call" });
  expect((await call("commit_result", { task_id: "7", content: "a" })).isError).toBe(false);
  expect((await call("start_task", { task_id: "7" })).isError).toBe(false);
});

test("pick_winners_uploads_the_scorecard_then_picks", async () => {
  const { callJson, chain, api } = await connectWrite({ keyKind: "function_call" });
  const winners = [{ account: ACCOUNT, bps: 10_000 }];

  const answer = await callJson("pick_winners", { task_id: "7", winners, scorecard: SCORECARD });

  const bytes = canonicalJson(SCORECARD);
  const hash = sha256Hex(bytes);
  expect(api.uploadBlob).toHaveBeenCalledExactlyOnceWith({
    kind: "scorecard",
    contentType: "application/json",
    bytes,
  });
  expect(chain.pick).toHaveBeenCalledExactlyOnceWith(7n, winners, hash, `${BLOBS}/${hash}`);
  expect(api.uploadBlob.mock.invocationCallOrder[0]).toBeLessThan(
    chain.pick.mock.invocationCallOrder[0] ?? 0,
  );
  expect(answer).toEqual({
    tx_hash: "TX_PICK",
    scorecard_uri: `${BLOBS}/${hash}`,
    scorecard_hash: hash,
  });

  // A pick that awards nothing is a scorecard with no winners.
  const none = { ...SCORECARD, winners: [] };
  await callJson("pick_winners", { task_id: "7", winners: [], scorecard: none });
  expect(chain.pick.mock.calls[1]?.[1]).toEqual([]);
});

test("pick_winners_checks_the_scorecard_before_it_publishes_it", async () => {
  const { call, chain, api } = await connectWrite();
  const winners = [{ account: ACCOUNT, bps: 10_000 }];
  const refused: Array<[string, Record<string, unknown>, RegExp]> = [
    [
      "a scorecard that fits no schema",
      { task_id: "7", winners, scorecard: { ...SCORECARD, version: 2 } },
      /^INVALID_SCORECARD: .*version/,
    ],
    [
      "a key the schema does not list",
      { task_id: "7", winners, scorecard: { ...SCORECARD, notes: "x" } },
      /^INVALID_SCORECARD: /,
    ],
    [
      "a scorecard for another task",
      { task_id: "8", winners, scorecard: SCORECARD },
      /^SCORECARD_MISMATCH: .*task/,
    ],
    [
      "other winners than the scorecard names",
      { task_id: "7", winners: [{ account: OTHER, bps: 10_000 }], scorecard: SCORECARD },
      /^SCORECARD_MISMATCH: .*winners/,
    ],
    [
      "other shares than the scorecard names",
      {
        task_id: "7",
        winners: [{ account: ACCOUNT, bps: 5_000 }],
        scorecard: SCORECARD,
      },
      /^SCORECARD_MISMATCH: .*winners/,
    ],
  ];
  for (const [what, args, expected] of refused) {
    const answer = await call("pick_winners", args);
    expect(answer.isError, what).toBe(true);
    expect(answer.text, what).toMatch(expected);
  }
  // Bad winners are turned back by the tool's schema.
  for (const bad of [
    [{ account: ACCOUNT, bps: 0 }],
    [{ account: ACCOUNT, bps: 10_001 }],
    [{ account: "Not An Account", bps: 100 }],
    [{ account: ACCOUNT, bps: 100, amount: "5" }],
    Array.from({ length: 6 }, () => ({ account: ACCOUNT, bps: 1_000 })),
  ]) {
    const answer = await call("pick_winners", { task_id: "7", winners: bad, scorecard: SCORECARD });
    expect(answer.isError, JSON.stringify(bad)).toBe(true);
  }
  expect(api.uploadBlob).not.toHaveBeenCalled();
  expect(chain.pick).not.toHaveBeenCalled();
});

test("register_agent_uploads_the_profile_then_registers", async () => {
  const { callJson, chain, api } = await connectWrite({ keyKind: "function_call" });
  const profile = {
    name: "Alice Extractor",
    description: "Reads invoices and reports the totals.",
    tags: ["invoices", "extraction"],
    homepage: "https://alice.example/agent",
  };

  const answer = await callJson("register_agent", profile);

  const bytes = canonicalJson(profile);
  const hash = sha256Hex(bytes);
  expect(api.uploadBlob).toHaveBeenCalledExactlyOnceWith({
    kind: "profile",
    contentType: "application/json",
    bytes,
  });
  expect(chain.registerAgent).toHaveBeenCalledExactlyOnceWith(
    `${BLOBS}/${hash}`,
    hash,
    profile.tags,
  );
  expect(api.uploadBlob.mock.invocationCallOrder[0]).toBeLessThan(
    chain.registerAgent.mock.invocationCallOrder[0] ?? 0,
  );
  expect(answer).toEqual({
    tx_hash: "TX_AGENT",
    profile_uri: `${BLOBS}/${hash}`,
    profile_hash: hash,
  });

  // The homepage is optional, and a profile that fits no schema is turned back.
  const { homepage: _homepage, ...bare } = profile;
  await callJson("register_agent", bare);
  expect(api.uploadBlob).toHaveBeenLastCalledWith(
    expect.objectContaining({ bytes: canonicalJson(bare) }),
  );
  for (const bad of [
    { ...profile, name: "" },
    { ...profile, homepage: "javascript:alert(1)" },
    { ...profile, tags: Array.from({ length: 9 }, () => "tag") },
  ]) {
    expect((await connectWrite().then((kit) => kit.call("register_agent", bad))).isError).toBe(
      true,
    );
  }
});

test("deposit_and_withdraw_take_raw_amounts_of_the_default_token", async () => {
  const { call, callJson, chain } = await connectWrite({ keyKind: "full_access" });

  const deposited = await callJson("deposit", { amount: "2500000" });
  expect(chain.deposit).toHaveBeenCalledExactlyOnceWith(USDC, 2_500_000n);
  expect(deposited).toEqual({
    tx_hash: "TX_DEPOSIT",
    token: USDC,
    credited: "2500000",
    credited_formatted: "2.50 USDC",
  });
  await callJson("deposit", { amount: "5", token: WEIRD });
  expect(chain.deposit).toHaveBeenLastCalledWith(WEIRD, 5n);

  const withdrawn = await callJson("withdraw", { amount: "1000000" });
  expect(chain.withdraw.mock.calls[0]).toEqual([USDC, 1_000_000n, undefined]);
  expect(withdrawn).toEqual({
    tx_hash: "TX_WITHDRAW",
    token: USDC,
    amount: "1000000",
    amount_formatted: "1.00 USDC",
    to: ACCOUNT,
  });
  expect(await callJson("withdraw", { amount: "7", token: WEIRD, to: OTHER })).toMatchObject({
    to: OTHER,
    amount_formatted: "7 weird.near",
  });
  expect(chain.withdraw.mock.calls[1]).toEqual([WEIRD, 7n, OTHER]);

  // An amount is a whole number of the smallest unit, as the read tools show it. "1.5" would read
  // as one and a half USDC to a person and as nothing sensible to the chain, so it is refused with
  // the conversion, and "1000000" is never taken for a million USDC.
  chain.deposit.mockClear();
  chain.withdraw.mockClear();
  for (const amount of [
    "1.5",
    "0",
    "-5",
    "1e6",
    " 5",
    "",
    "0x10",
    "01",
    "340282366920938463463374607431768211456",
  ]) {
    for (const name of ["deposit", "withdraw"]) {
      const answer = await call(name, { amount });
      expect(answer.isError, `${name} ${JSON.stringify(amount)}`).toBe(true);
      expect(answer.text).toMatch(/^BAD_AMOUNT: .*smallest unit.*"1000000" is 1 USDC/);
    }
  }
  expect(chain.deposit).not.toHaveBeenCalled();
  expect(chain.withdraw).not.toHaveBeenCalled();
  expect((await call("withdraw", { amount: "5", to: "Not An Account" })).text).toMatch(
    /^BAD_INPUT: .*to/,
  );
  expect((await call("deposit", { amount: "5", token: "Not An Account" })).text).toMatch(
    /^BAD_INPUT: .*token/,
  );
  expect(chain.withdraw).not.toHaveBeenCalled();
});

test("a_deposit_that_tender_refused_is_not_reported_as_made", async () => {
  // Tender refunds a deposit it will not take (a token that is not enabled), and the transaction
  // still succeeds: there is no `deposit` event, and the amount taken is 0.
  const { call, chain } = await connectWrite({ keyKind: "full_access" });
  chain.deposit.mockResolvedValue(tx("TX_REFUNDED", { returnValue: "0" }));

  const answer = await call("deposit", { amount: "2500000" });

  expect(answer.isError).toBe(true);
  expect(answer.text).toMatch(/^DEPOSIT_REFUSED: .*refund.*token is not enabled/);
  expect(answer.text).toContain("TX_REFUNDED");
  // Storage is registered first now, so it is no longer named as the likely cause.
  expect(answer.text).not.toContain("no storage deposit");
});

test("deposit_registers_storage_first", async () => {
  // Tender takes a deposit only for an account with a storage balance that has room for the
  // token's slot, and refunds it otherwise. A fresh poster's first deposit must not be that.
  const { callJson, chain } = await connectWrite({ keyKind: "full_access" });
  chain.storageBalanceOf.mockResolvedValue(null);

  const first = await callJson("deposit", { amount: "2500000" });

  // The registration is the (1,024 + 133) bytes of a first entry and 0.01 NEAR on top (X-6, P04-P2),
  // and it goes in before the tokens do.
  expect(chain.storageBalanceOf).toHaveBeenCalledWith(ACCOUNT);
  expect(chain.storageDeposit).toHaveBeenCalledExactlyOnceWith(
    11_570_000_000_000_000_000_000n + 10n ** 22n,
  );
  expect(chain.deposit).toHaveBeenCalledExactlyOnceWith(USDC, 2_500_000n);
  const [registered] = chain.storageDeposit.mock.invocationCallOrder;
  const [deposited] = chain.deposit.mock.invocationCallOrder;
  expect(registered ?? Number.MAX_SAFE_INTEGER).toBeLessThan(deposited ?? 0);
  // The agent is told that NEAR was spent for it.
  expect(first).toMatchObject({ tx_hash: "TX_DEPOSIT", credited: "2500000" });
  expect(first).toHaveProperty(
    "note",
    expect.stringMatching(/added 0\.02157 NEAR to your storage deposit in tender\.testnet first/),
  );

  // Room in the storage balance, or a registered account with too little: only the second tops up.
  chain.storageDeposit.mockClear();
  chain.storageBalanceOf.mockResolvedValue(ROOMY);
  const again = await callJson("deposit", { amount: "5" });
  expect(chain.storageDeposit).not.toHaveBeenCalled();
  expect(again).not.toHaveProperty("note");

  chain.storageBalanceOf.mockResolvedValue({
    total: "10000000000000000000000",
    available: (STORAGE_NEEDED - 1n).toString(),
    used_bytes: "1000",
  });
  await callJson("deposit", { amount: "5" });
  expect(chain.storageDeposit).toHaveBeenCalledExactlyOnceWith(1n + 10n ** 22n);
});

test("deposit_stops_when_storage_cannot_be_registered", async () => {
  const { call, chain } = await connectWrite({ keyKind: "full_access" });
  chain.storageBalanceOf.mockResolvedValue(null);
  chain.storageDeposit.mockRejectedValue(new Error("not enough NEAR on the account"));

  const answer = await call("deposit", { amount: "2500000" });

  // No tokens move for an account that Tender would refuse them from.
  expect(answer).toEqual({ isError: true, text: "ERROR: not enough NEAR on the account" });
  expect(chain.deposit).not.toHaveBeenCalled();
});

test("a_deposit_that_is_refused_up_front_spends_nothing_on_storage", async () => {
  // The amount and the token are checked before the storage is, so a typo costs no NEAR.
  const { call, chain } = await connectWrite({ keyKind: "full_access" });
  chain.storageBalanceOf.mockResolvedValue(null);

  expect((await call("deposit", { amount: "1.5" })).text).toMatch(/^BAD_AMOUNT: /);
  expect((await call("deposit", { amount: "5", token: "Not An Account" })).text).toMatch(
    /^BAD_INPUT: /,
  );

  expect(chain.storageBalanceOf).not.toHaveBeenCalled();
  expect(chain.storageDeposit).not.toHaveBeenCalled();
  expect(chain.deposit).not.toHaveBeenCalled();
});

test("a_withdrawal_the_token_refused_is_not_reported_as_paid", async () => {
  const { call, chain } = await connectWrite({ keyKind: "full_access" });
  const withdrawEvent = (event: "withdraw" | "withdraw_failed") => ({
    event,
    receiptId: "receipt-2",
    logIndex: 0,
    data: { account: ACCOUNT, token: USDC, amount: "100", to: ACCOUNT },
  });

  // The callback restored the balance: the receipt says false, and so does the event.
  chain.withdraw.mockResolvedValue(
    tx("TX_FAILED", { returnValue: false, events: [withdrawEvent("withdraw_failed")] }),
  );
  const failed = await call("withdraw", { amount: "100" });
  expect(failed.isError).toBe(true);
  expect(failed.text).toMatch(/^WITHDRAW_FAILED: .*back in your vault.*registered/);
  expect(failed.text).toContain("TX_FAILED");

  // Either sign alone is enough to know.
  chain.withdraw.mockResolvedValue(tx("TX_2", { returnValue: false }));
  expect((await call("withdraw", { amount: "100" })).text).toMatch(/^WITHDRAW_FAILED: /);
  chain.withdraw.mockResolvedValue(tx("TX_3", { events: [withdrawEvent("withdraw_failed")] }));
  expect((await call("withdraw", { amount: "100" })).text).toMatch(/^WITHDRAW_FAILED: /);
  chain.withdraw.mockResolvedValue(tx("TX_4", { events: [withdrawEvent("withdraw")] }));
  expect((await call("withdraw", { amount: "100" })).isError).toBe(false);

  // A transaction that says neither is not claimed to have paid.
  chain.withdraw.mockResolvedValue(tx("TX_5"));
  const unclear = await call("withdraw", { amount: "100" });
  expect(unclear.isError).toBe(true);
  expect(unclear.text).toMatch(/^WITHDRAW_UNCONFIRMED: /);
});

test("write_errors_never_contain_secrets", async () => {
  // Whatever a library puts in its message, the agent never reads the key, a bearer token or a URL
  // in a tool's error: the key and its body are cut out by name, the rest by shape.
  const leak = `signing with ${SECRET_KEY} (${SECRET_BODY}) failed at https://rpc.example.com/?apiKey=URLKEY with Authorization: Bearer abc123.DEF-456_ghi=`;
  const secrets = [SECRET_KEY, SECRET_BODY];
  await state.saveDraft(makeDraft("5", { committedAt: "2026-11-04T09:30:00.000Z" }));
  const { call, chain, api } = await connectWrite({
    keyKind: "full_access",
    judgeAccount: "judge.testnet",
    secrets,
  });
  const failures: Array<[string, Record<string, unknown>, () => void]> = [
    [
      "commit_result",
      { task_id: "7", content: "a" },
      () => chain.commit.mockRejectedValue(new Error(leak)),
    ],
    [
      "reveal_result",
      { task_id: "5" },
      () => chain.reveal.mockRejectedValue(new TenderError("E_UNKNOWN", leak)),
    ],
    ["start_task", { task_id: "7" }, () => api.start.mockRejectedValue(new Error(leak))],
    ["deposit", { amount: "5" }, () => chain.deposit.mockRejectedValue(new Error(leak))],
    ["withdraw", { amount: "5" }, () => chain.withdraw.mockRejectedValue(new Error(leak))],
    ["post_task", POST_ARGS, () => chain.postTask.mockRejectedValue(new Error(leak))],
    ["post_task", POST_ARGS, () => api.uploadBlob.mockRejectedValue(new Error(leak))],
    [
      "register_agent",
      { name: "Alice", description: "d", tags: [] },
      () => chain.registerAgent.mockRejectedValue(new Error(leak)),
    ],
    [
      "pick_winners",
      { task_id: "7", winners: [{ account: ACCOUNT, bps: 10_000 }], scorecard: SCORECARD },
      () => chain.pick.mockRejectedValue(new Error(leak)),
    ],
  ];
  for (const [name, args, arrange] of failures) {
    arrange();
    const answer = await call(name, args);
    expect(answer.isError, name).toBe(true);
    for (const secret of [
      SECRET_KEY,
      SECRET_BODY,
      "abc123",
      "DEF-456",
      "URLKEY",
      "rpc.example.com",
    ]) {
      expect(answer.text, `${name} leaked ${secret}`).not.toContain(secret);
    }
    expect(answer.text, name).toContain("<redacted>");
    expect(answer.text, name).toContain("Bearer <redacted>");
    expect(answer.text, name).toContain("<url>");
  }

  // The key is not a path out of a draft's error either: the store names a file and never quotes it.
  await writeFile(
    join(dir, "drafts", "6.json"),
    JSON.stringify({ taskId: "6", salt: SECRET_BODY }),
  );
  const corrupt = await call("reveal_result", { task_id: "6" });
  expect(corrupt.isError).toBe(true);
  expect(corrupt.text).not.toContain(SECRET_BODY);

  // A server told no secrets still cuts the bearer tokens and the URLs.
  const bare = await connectWrite({ keyKind: "full_access" });
  bare.chain.deposit.mockRejectedValue(new Error(leak));
  const unguarded = await bare.call("deposit", { amount: "5" });
  expect(unguarded.text).not.toMatch(/abc123|URLKEY/);
  expect(unguarded.text).toContain("Bearer <redacted>");
});

test("a_refusal_retires_the_draft_with_no_secret_in_the_reason", async () => {
  // The reason is written to the draft file and read back by my_entries, so it is cleaned first.
  const leak = `signing with ${SECRET_KEY} failed at https://rpc.example.com/?apiKey=URLKEY with Bearer abc123`;
  const { call, chain } = await connectWrite({ secrets: [SECRET_KEY, SECRET_BODY] });
  chain.commit.mockRejectedValueOnce(new TenderError("E_PHASE", `E_PHASE: ${leak}`));

  const answer = await call("commit_result", { task_id: "7", content: "a" });

  expect(answer.isError).toBe(true);
  const reason = (await draftOf("7")).dead?.reason ?? "";
  expect(reason).toMatch(
    /^E_PHASE: signing with <redacted> failed at <url> with Bearer <redacted>$/,
  );
  const file = await readFile(join(dir, "drafts", "7.json"), "utf8");
  for (const secret of [SECRET_KEY, SECRET_BODY, "URLKEY", "abc123", "rpc.example.com"]) {
    expect(file).not.toContain(secret);
  }
});

test("a_reason_is_cut_to_a_length_a_log_can_hold", async () => {
  const { call, chain } = await connectWrite();
  chain.commit.mockRejectedValueOnce(new TenderError("E_PHASE", `E_PHASE: ${"x".repeat(5000)}`));

  await call("commit_result", { task_id: "7", content: "a" });

  expect((await draftOf("7")).dead?.reason).toHaveLength(300);
});

test("commit_does_not_send_when_the_draft_cannot_be_saved", async () => {
  // The draft is the only thing that can open the commitment later, so a disk that fails stops the
  // commit before anything leaves.
  const brokenDisk: StateStore = {
    ...state,
    saveDraft: async () => {
      throw new Error("disk full");
    },
  };
  const { call, chain } = await connectWrite({ state: brokenDisk });

  expect(await call("commit_result", { task_id: "7", content: "a" })).toEqual({
    isError: true,
    text: "ERROR: disk full",
  });
  expect(chain.commit).not.toHaveBeenCalled();
});

test("a_commit_whose_draft_cannot_be_marked_is_found_on_chain_next_time", async () => {
  // The commit landed, then the disk failed: the answer says so, and the next call asks the chain
  // and does not send again.
  let failing = true;
  const flaky: StateStore = {
    ...state,
    saveDraft: async (draft) => {
      if (failing && draft.committedAt !== undefined) throw new Error("disk full");
      await state.saveDraft(draft);
    },
  };
  const { callJson, chain } = await connectWrite({ state: flaky });

  const first = await callJson("commit_result", { task_id: "7", content: "a" });
  expect(first).toMatchObject({ tx_hash: "TX_COMMIT" });
  expect(first).toHaveProperty(
    "note",
    expect.stringMatching(/could not be marked as committed.*disk full/),
  );
  const saved = await draftOf("7");
  expect(saved.committedAt).toBeUndefined();

  failing = false;
  chain.getEntry.mockResolvedValue(entryView(saved.commitment));
  const second = await callJson("commit_result", { task_id: "7", content: "a" });
  expect(chain.commit).toHaveBeenCalledTimes(1);
  expect(second).toMatchObject({ tx_hash: null });
  expect((await draftOf("7")).committedAt).toMatch(ISO);
});

test("the_lookups_the_api_only_lends_may_fail_without_failing_the_tool", async () => {
  // reveal_opens_at and the content type are conveniences from the API; the chain and the draft are
  // all that a commit and a reveal need.
  const { callJson, api } = await connectWrite();
  api.getTask.mockRejectedValue(new Error("API is down"));

  const committed = await callJson("commit_result", { task_id: "7", content: "a" });
  expect(committed).toMatchObject({ tx_hash: "TX_COMMIT", reveal_opens_at: null });
  // What the commit could not check is said, since the task's size limit comes from the same place.
  expect(committed).toHaveProperty(
    "note",
    expect.stringMatching(/size limit could not be checked/),
  );

  const revealed = await callJson("reveal_result", { task_id: "7" });
  expect(revealed).toMatchObject({ tx_hash: "TX_REVEAL" });
  expect(api.uploadBlob).toHaveBeenCalledWith(
    expect.objectContaining({ contentType: "text/plain" }),
  );
});

test("a_document_the_api_stored_under_another_hash_is_not_sent_to_the_chain", async () => {
  // The hash on chain must be the hash of the bytes that were uploaded. An API that answers with
  // another one has stored something else, and nothing that costs money follows.
  const { call, chain, api } = await connectWrite({
    keyKind: "full_access",
    judgeAccount: "judge.testnet",
  });
  api.uploadBlob.mockResolvedValue({ sha256: "ee".repeat(32), uri: `${BLOBS}/${"ee".repeat(32)}` });

  const attempts: Array<[string, Record<string, unknown>]> = [
    ["post_task", POST_ARGS],
    [
      "pick_winners",
      { task_id: "7", winners: [{ account: ACCOUNT, bps: 10_000 }], scorecard: SCORECARD },
    ],
    ["register_agent", { name: "Alice", description: "d", tags: [] }],
  ];
  for (const [name, args] of attempts) {
    const answer = await call(name, args);
    expect(answer.isError, name).toBe(true);
    expect(answer.text, name).toMatch(/^HASH_MISMATCH: /);
  }
  expect(chain.postTask).not.toHaveBeenCalled();
  expect(chain.pick).not.toHaveBeenCalled();
  expect(chain.registerAgent).not.toHaveBeenCalled();
  expect(api.uploadHeldout).not.toHaveBeenCalled();
});

test("a_draft_that_cannot_be_read_is_never_written_over", async () => {
  // A file that is not a draft may still hold a recoverable salt, so neither tool treats it as "no
  // draft": the commit does not make a new one over it, and nothing is sent.
  const file = join(dir, "drafts", "7.json");
  await mkdir(join(dir, "drafts"), { recursive: true });
  await writeFile(file, "{ half a draft");
  const { call, chain, api } = await connectWrite();

  for (const [name, args] of [
    ["commit_result", { task_id: "7", content: "a" }],
    ["reveal_result", { task_id: "7" }],
  ] as const) {
    const answer = await call(name, args);
    expect(answer.isError, name).toBe(true);
    expect(answer.text, name).toMatch(/^DRAFT_UNREADABLE: .*corrupt/);
    expect(answer.text, name).toContain(file);
  }
  expect(await readFile(file, "utf8")).toBe("{ half a draft");
  expect(chain.commit).not.toHaveBeenCalled();
  expect(chain.storageBalanceOf).not.toHaveBeenCalled();
  expect(api.uploadBlob).not.toHaveBeenCalled();
});
