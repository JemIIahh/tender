import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ApiError,
  type Brief,
  type ConfigView,
  computeCommitment,
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

// The read tools are driven the way a client drives them: through the SDK's `Client`, over an
// in-memory pair of transports, with a plain object for the chain and another for the API. The
// state store is the real one, in a temp dir, since its files are what `my_entries` reads.

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
      brief_uri: "https://api.tender.example/v1/blobs/brief",
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

function fakeChain(overrides: Partial<McpChain> = {}): McpChain {
  return {
    getConfig: async () => CONFIG,
    balanceOf: async () => 0n,
    storageBalanceOf: async () => null,
    ...overrides,
  };
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
  expect(tools.map((tool) => tool.name).sort()).toEqual([
    "balance",
    "get_scorecard",
    "get_task",
    "list_tasks",
    "my_entries",
  ]);
  // None of them changes anything, and a client may run them without asking.
  expect(tools.map((tool) => tool.annotations?.readOnlyHint)).toEqual(tools.map(() => true));

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
  expect(byName.my_entries?.properties).toEqual({});
  expect(byName.balance?.properties).toEqual({});
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
        reward: "2500000 (2.50 USDC)",
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
      { id: "7", token: WEIRD, reward: "40 (40 weird.near)" },
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
            uri: "https://api.tender.example/v1/blobs/bob",
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
    reward: "1000000 (1.00 USDC)",
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
  expect(body.funders).toEqual([{ account: POSTER, amount: "1000000 (1.00 USDC)" }]);
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

  // An entry the index lists as revealed.
  await state.markRevealed("7", "https://api.tender.example/v1/blobs/mine");
  detail.mockResolvedValue(
    makeDetail([
      makeEntry(ACCOUNT, {
        entry_index: 3,
        content_hash: "55".repeat(32),
        uri: "https://api.tender.example/v1/blobs/mine",
        revealed: true,
      }),
    ]),
  );
  expect(await ownEntry()).toMatchObject({
    status: "revealed",
    entry_index: 3,
    revealed: true,
    content_hash: "55".repeat(32),
    draft: { revealed_uri: "https://api.tender.example/v1/blobs/mine" },
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
      scorecard_uri: "https://api.tender.example/v1/blobs/card",
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
        winners: [{ account: ACCOUNT, bps: 10_000, amount: "950000 (0.95 USDC)" }],
        fee: "50000 (0.05 USDC)",
      },
    },
  });

  getTask.mockResolvedValue(voided);
  expect(await callJson("get_task", { task_id: "7" })).toMatchObject({
    task: {
      outcome: {
        kind: "voided",
        reason: "no_reveals",
        refunds: [{ account: POSTER, amount: "1000000 (1.00 USDC)" }],
      },
    },
  });
});

test("a_missing_task_is_an_answer_and_not_an_error", async () => {
  const { call } = await connect({ api: fakeApi({ getTask: async () => null }) });

  expect(await call("get_task", { task_id: "99" })).toEqual({ isError: false, text: "no task 99" });
});

test("my_entries_includes_unrevealed_drafts", async () => {
  // Task 3 is committed and waits for its reveal, 9 is revealed already, and 12 was saved but its
  // commit has not been confirmed.
  await state.saveDraft(makeDraft("3", { committedAt: "2026-11-04T09:30:00.000Z" }));
  await state.saveDraft(makeDraft("9", { committedAt: "2026-11-04T09:31:00.000Z" }));
  await state.markRevealed("9", "https://api.tender.example/v1/blobs/nine");
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
      uri: "https://api.tender.example/v1/blobs/nine",
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
  // Only the drafts not revealed yet, by task number, and nothing that lets the work out early.
  expect(body.unrevealed_drafts).toEqual([
    {
      task_id: "3",
      content_hash: sha256Hex("answer for task 3"),
      commitment: makeDraft("3").commitment,
      committed_at: "2026-11-04T09:30:00.000Z",
      revealed_uri: null,
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
  const bad = join(dir, "drafts", "9.json");
  await writeFile(bad, "this is not a draft");
  const entries = [
    {
      task_id: "3",
      title: "Three",
      phase: "revealing" as const,
      revealed: false,
      won: false,
      entry_index: 0,
      committed_height: "30",
      content_hash: null,
      uri: null,
    },
  ];
  const { call } = await connect({ api: fakeApi({ listEntries: async () => ({ entries }) }) });

  // The entries still come, and the answer says which file it could not read.
  const answer = await call("my_entries");
  expect(answer.isError).toBe(false);
  const body = JSON.parse(answer.text);
  expect(body.entries).toEqual(entries);
  expect(body.unrevealed_drafts).toBeNull();
  expect(body.drafts_error).toContain(bad);
  expect(body.drafts_error).toContain("corrupt");
});

test("my_entries_with_no_state_dir_has_no_drafts", async () => {
  const { callJson } = await connect({
    api: fakeApi({ listEntries: async () => ({ entries: [] }) }),
  });

  expect(await callJson("my_entries")).toEqual({
    account: ACCOUNT,
    entries: [],
    unrevealed_drafts: [],
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
      { token: USDC, enabled: true, balance: "1250000 (1.25 USDC)" },
      // A token the table does not know: the raw amount and the token id, decimals not guessed.
      { token: WEIRD, enabled: true, balance: "500 (500 weird.near)" },
      { token: "old.testnet", enabled: false, balance: "0 (0 old.testnet)" },
    ],
    storage: {
      total: "10000000000000000000000 (0.01 NEAR)",
      available: "4000000000000000000000 (0.004 NEAR)",
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
    vault: [{ balance: "0 (0.00 USDC)" }, { balance: "0 (0 weird.near)" }, {}],
    storage: null,
  });
});

test("get_scorecard_returns_the_scorecard_or_says_there_is_none", async () => {
  const scorecard: Scorecard = {
    version: 1,
    task_id: "7",
    verifier: "judge.testnet",
    kind: "exact",
    criteria_hash: "22".repeat(32),
    heldout_commitment: "33".repeat(32),
    heldout: { exact: { expected: ["[1050]"] } },
    tie_break: "score desc, committed_at_block asc, account asc",
    entries: [
      {
        account: ACCOUNT,
        content_hash: "55".repeat(32),
        uri: "https://api.tender.example/v1/blobs/mine",
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
  const getScorecard = vi.fn<TenderApi["getScorecard"]>();
  const { call } = await connect({ api: fakeApi({ getScorecard }) });

  getScorecard.mockResolvedValue(scorecard);
  const found = await call("get_scorecard", { task_id: "7" });
  expect(getScorecard).toHaveBeenCalledWith(7n);
  expect(found.isError).toBe(false);
  expect(JSON.parse(found.text)).toEqual(scorecard);

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
