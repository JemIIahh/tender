import { readFileSync } from "node:fs";
import { type Db, migrate, openDb } from "@tender/db";
import {
  type AgentView,
  AgentViewSchema,
  type EntryView,
  EntryViewSchema,
  type TaskView,
  TaskViewSchema,
} from "@tender/shared";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import {
  applyBlock,
  type ReconcileChain,
  type ReconcileOptions,
  type ReconcileResult,
  reconcile,
} from "../src/index";
import {
  BOB_ENTRY,
  blockOf,
  eventLine,
  FIXTURE_ACCOUNTS,
  FIXTURE_BRIEF_HASH,
  FIXTURE_CONTRACT,
  FIXTURE_OPTIONS,
  FIXTURE_TOKEN,
  fixtureData,
  LIFECYCLE_TASK_ID,
  seedLifecycle,
} from "./fixtures/blocks";

// The index holds the lifecycle of fixtures/blocks.ts (task 1, settled at block 90), and a fake
// chain answers reconcile's views with the samples captured from the contract in @tender/shared
// (task_view.json is task 1 at the end of that lifecycle, agent_view.json alice). Each test makes
// the index and the chain disagree, and checks what reconcile repairs and what it logs.
//
// Reconcile leaves alone what changed within 20 blocks of the index's height (SKEW_BLOCKS), and
// waits for the index to be 20 blocks past the chain's final height. So most tests put the index 20
// empty blocks past the lifecycle (`seed`), and give the chain a final height 20 below the index.

const { judge, alice, bob } = FIXTURE_ACCOUNTS;
const TABLES = ["chain_cursor", "events", "tasks", "funders", "entries", "agents"];
const SAMPLES = new URL("../../shared/test/fixtures/", import.meta.url);

function sample<T>(name: string, schema: { parse(value: unknown): T }): T {
  return schema.parse(JSON.parse(readFileSync(new URL(name, SAMPLES), "utf8")));
}

/** Task 1 on the chain once the lifecycle is over. The lifecycle points it at the fixture brief. */
const TASK_1: TaskView = {
  ...sample("task_view.json", TaskViewSchema),
  brief_hash: FIXTURE_BRIEF_HASH,
};
const ENTRIES_1: EntryView[] = [
  sample("entry_view.json", EntryViewSchema),
  {
    task_id: "1",
    account: bob,
    index: 1,
    commitment: BOB_ENTRY.commitment,
    committed_at_block: "66",
    content_hash: BOB_ENTRY.contentHash,
    uri: BOB_ENTRY.uri,
  },
];
const ALICE: AgentView = sample("agent_view.json", AgentViewSchema);
const AGENTS: AgentView[] = [
  ALICE,
  { ...ALICE, account: bob, earned: [{ token: FIXTURE_TOKEN, amount: "285000" }] },
  { ...ALICE, account: judge, entries: 0, reveals: 0, wins: 0, earned: [], picks_made: 1 },
];

/** Task `id` on the chain as the captured `task_created` posts it: open, with no entry yet. */
function openTask(id: number): TaskView {
  return {
    ...TASK_1,
    id: `${id}`,
    commit_count: 0,
    reveal_count: 0,
    outcome: null,
    phase: "open",
  };
}

/** The block that creates task `id`, at `height`, as the captured `task_created` does task 1. */
const created = (id: number, height: number) =>
  blockOf(height, [eventLine("task_created", { id: `${id}`, brief_hash: FIXTURE_BRIEF_HASH })]);

let db: Db;

beforeAll(async () => {
  db = await openDb("pglite:memory");
  await migrate(db);
});

afterAll(() => db.close());

beforeEach(async () => {
  await db.exec(`truncate ${TABLES.join(", ")}, blobs restart identity`);
});

interface Chain {
  final: bigint;
  tasks: TaskView[];
  entries: Record<string, EntryView[]>;
  agents: AgentView[];
  /**
   * Runs as reconcile reads the first view, and never again: the chain moving on while a pass
   * reads it.
   */
  onFirstRead?: () => Promise<void>;
  /** How many task, entry and agent views were read. */
  reads?: number;
}

/** The chain at the end of the lifecycle, with `over` changed. */
function lifecycleChain(over: Partial<Chain> = {}): Chain {
  return { final: 90n, tasks: [TASK_1], entries: { "1": ENTRIES_1 }, agents: AGENTS, ...over };
}

function fake(chain: Chain): ReconcileChain {
  const read = async () => {
    chain.reads = (chain.reads ?? 0) + 1;
    const hook = chain.onFirstRead;
    chain.onFirstRead = undefined;
    await hook?.();
  };
  return {
    network: "sandbox",
    contractId: FIXTURE_CONTRACT,
    finalHeight: async () => chain.final,
    taskCount: async () => BigInt(chain.tasks.length),
    async getTask(id) {
      await read();
      return chain.tasks.find((task) => task.id === `${id}`) ?? null;
    },
    async getAllEntries(id) {
      await read();
      return chain.entries[`${id}`] ?? [];
    },
    async getAgent(account) {
      await read();
      return chain.agents.find((agent) => agent.account === account) ?? null;
    },
  };
}

/** Reconciles the fixtures' index against `chain`, with the log lines going to `lines`. */
function reconcileWith(
  chain: Chain,
  lines: string[],
  opts: ReconcileOptions = {},
): Promise<ReconcileResult> {
  return reconcile(db, fake(chain), {
    cursorSource: FIXTURE_OPTIONS.cursorSource,
    log: (line) => lines.push(line),
    ...opts,
  });
}

const apply = (block: ReturnType<typeof blockOf>) => applyBlock(db, block, FIXTURE_OPTIONS);

type Row = Record<string, unknown>;

async function taskOf(id: string): Promise<Row | undefined> {
  const [row] = await db.query<Row>(
    `select id::text as id, poster, token, reward::text as reward, fee_bps, brief_uri, brief_hash,
            criteria_hash, heldout_commitment, verifier, created_at::text as created_at,
            commit_deadline::text as commit_deadline, reveal_deadline::text as reveal_deadline,
            pick_deadline::text as pick_deadline, fallback_deadline::text as fallback_deadline,
            max_entries, max_winners, invited, parent::text as parent, commit_count, reveal_count,
            outcome, outcome is not null as has_outcome, settled_height::text as settled_height,
            title, category, tags, created_height::text as created_height
       from tasks where id = $1`,
    [id],
  );
  return row;
}

function entriesOf(taskId: string): Promise<Row[]> {
  return db.query<Row>(
    `select account, entry_index, commitment, committed_height::text as committed_height,
            content_hash, uri
       from entries where task_id = $1 order by entry_index`,
    [taskId],
  );
}

function fundersOf(taskId: string): Promise<Row[]> {
  return db.query<Row>(
    "select account, amount::text as amount from funders where task_id = $1 order by account",
    [taskId],
  );
}

/** Every row of every projected table as JSON text, so two states compare exactly. */
async function snapshot(): Promise<Record<string, string[]>> {
  const state: Record<string, string[]> = {};
  for (const table of TABLES) {
    const found = await db.query<{ row: string }>(
      `select to_jsonb(t)::text as row from ${table} t order by 1`,
    );
    state[table] = found.map((r) => r.row);
  }
  return state;
}

/** Drops task `id` from the index, events and all, as if the index had never seen it. */
async function forget(id: string): Promise<void> {
  await db.query("delete from events where task_id = $1", [id]);
  await db.query("delete from entries where task_id = $1", [id]);
  await db.query("delete from funders where task_id = $1", [id]);
  await db.query("delete from tasks where id = $1", [id]);
}

/** Reconcile's margin for answers of the chain that are blocks apart (SKEW_BLOCKS). */
const SKEW = 20;

/** The lifecycle, then an empty block 20 after its last: it is all behind reconcile's margin. */
async function seed(): Promise<void> {
  await seedLifecycle(db);
  await apply(blockOf(90 + SKEW, []));
}

/** Applies an empty block at `height` once `ms` have passed: the runner, while a pass waits. */
function applyLater(height: number, ms = 200): void {
  setTimeout(() => void apply(blockOf(height, [])), ms);
}

/** The rows of the projection, without the cursor and the events. */
async function projected() {
  const { tasks, funders, entries, agents } = await snapshot();
  return { tasks, funders, entries, agents };
}

/** Waits until the index's cursor is at `height` or past it. */
async function cursorReaches(height: number): Promise<void> {
  const giveUpAt = Date.now() + 5_000;
  for (;;) {
    const [row] = await db.query<{ height: string }>(
      "select height::text as height from chain_cursor where source = $1",
      [FIXTURE_OPTIONS.cursorSource],
    );
    if (row !== undefined && BigInt(row.height) >= BigInt(height)) return;
    if (Date.now() > giveUpAt) throw new Error(`the index did not reach block ${height}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("an_index_that_agrees_with_the_chain_is_left_as_it_is", async () => {
  await seed();
  const before = await snapshot();
  const lines: string[] = [];

  expect(await reconcileWith(lifecycleChain(), lines)).toEqual({ inserted: 0, updated: 0 });
  expect(lines).toEqual([]);
  expect(await snapshot()).toEqual(before);
});

test("a_missing_task_comes_back_with_its_funders_entries_and_an_outcome_by_nobody", async () => {
  await seedLifecycle(db);
  // Task 2 came after task 1 and the index holds it: the gap is below the highest id.
  await apply(created(2, 95));
  await apply(blockOf(95 + SKEW, []));
  const before = await taskOf(LIFECYCLE_TASK_ID);
  const entries = await entriesOf(LIFECYCLE_TASK_ID);
  const funders = await fundersOf(LIFECYCLE_TASK_ID);
  await forget(LIFECYCLE_TASK_ID);
  const lines: string[] = [];

  const chain = lifecycleChain({ final: 95n, tasks: [TASK_1, openTask(2)] });
  expect(await reconcileWith(chain, lines)).toEqual({ inserted: 1, updated: 0 });

  // As the events had made it, but for what the views cannot tell: who picked (`by` is null, and
  // `by_source` says why), the block of the pick, and the block it was created in, for which it
  // gets the final height that reconcile read, by which it existed.
  expect(await taskOf(LIFECYCLE_TASK_ID)).toEqual({
    ...before,
    outcome: { ...(before?.outcome as object), by: null, by_source: "reconcile" },
    settled_height: null,
    created_height: "95",
  });
  expect(await entriesOf(LIFECYCLE_TASK_ID)).toEqual(entries);
  expect(await fundersOf(LIFECYCLE_TASK_ID)).toEqual(funders);
  expect(lines).toEqual(["WARN reconcile task=1 inserted from the chain"]);
});

test("an_inserted_task_keeps_the_rows_that_its_views_lack", async () => {
  // The index lost the task's row and events, but not its entries and funder. Since then the
  // chain's cleanup has removed alice's entry, the first one: the index holds the only copy.
  await seed();
  const entries = await entriesOf(LIFECYCLE_TASK_ID);
  const funders = await fundersOf(LIFECYCLE_TASK_ID);
  await db.query("delete from events where task_id = 1");
  await db.query("delete from tasks where id = 1");
  const lines: string[] = [];

  const chain = lifecycleChain({
    tasks: [{ ...TASK_1, cleaned: 1 }],
    entries: { "1": ENTRIES_1.slice(1) },
  });
  expect(await reconcileWith(chain, lines)).toEqual({ inserted: 1, updated: 0 });
  expect(await entriesOf(LIFECYCLE_TASK_ID)).toEqual(entries);
  expect(await fundersOf(LIFECYCLE_TASK_ID)).toEqual(funders);
});

test("a_nul_in_a_view_is_stored_as_u_fffd_and_agrees_with_the_chain_after", async () => {
  // The contract checks a URI's length only, so the views can hand back a NUL, which neither a
  // text nor a jsonb column takes. Stored as it came, it would fail the insert on every pass.
  await seed();
  await forget(LIFECYCLE_TASK_ID);
  const withNul = (text: string) => `${text}\u0000`;
  const outcome = TASK_1.outcome?.kind === "picked" ? TASK_1.outcome : undefined;
  if (outcome === undefined) throw new Error("task 1 of the samples is not picked");
  const [aliceEntry, bobEntry] = ENTRIES_1;
  if (aliceEntry === undefined || bobEntry === undefined) throw new Error("two entries expected");
  const chain = lifecycleChain({
    tasks: [
      {
        ...TASK_1,
        brief_uri: withNul(TASK_1.brief_uri),
        outcome: { ...outcome, scorecard_uri: withNul(outcome.scorecard_uri) },
      },
    ],
    entries: { "1": [{ ...aliceEntry, uri: "ipfs://alice\u0000work" }, bobEntry] },
  });
  const lines: string[] = [];

  expect(await reconcileWith(chain, lines)).toEqual({ inserted: 1, updated: 0 });
  const [entry] = await entriesOf(LIFECYCLE_TASK_ID);
  expect(entry?.uri).toBe("ipfs://alice\u{fffd}work");
  const task = await taskOf(LIFECYCLE_TASK_ID);
  expect(task?.brief_uri).toBe(`${TASK_1.brief_uri}\u{fffd}`);
  expect(task?.outcome).toMatchObject({ scorecard_uri: `${outcome.scorecard_uri}\u{fffd}` });

  // The next pass compares the chain's NUL with the stored U+FFFD as the same, as applyBlock
  // stores it, and has nothing to repair.
  expect(await reconcileWith(chain, lines)).toEqual({ inserted: 0, updated: 0 });
  expect(lines).toEqual(["WARN reconcile task=1 inserted from the chain"]);
});

test("a_u32_beyond_an_int_column_is_stored_clamped_and_agrees_with_the_chain_after", async () => {
  // u32 on chain, int in the index: past 2147483647 the insert would fail on every pass.
  const U32_MAX = 4_294_967_295;
  const INT_MAX = 2_147_483_647;
  await seed();
  await forget(LIFECYCLE_TASK_ID);
  const [aliceEntry, bobEntry] = ENTRIES_1;
  if (aliceEntry === undefined || bobEntry === undefined) throw new Error("two entries expected");
  const chain = lifecycleChain({
    tasks: [{ ...TASK_1, max_entries: U32_MAX, commit_count: U32_MAX }],
    entries: { "1": [aliceEntry, { ...bobEntry, index: U32_MAX }] },
    agents: AGENTS.map((agent) => (agent.account === alice ? { ...agent, wins: U32_MAX } : agent)),
  });
  const lines: string[] = [];

  expect(await reconcileWith(chain, lines)).toEqual({ inserted: 1, updated: 1 });
  expect(await taskOf(LIFECYCLE_TASK_ID)).toMatchObject({
    max_entries: INT_MAX,
    commit_count: INT_MAX,
  });
  expect((await entriesOf(LIFECYCLE_TASK_ID)).map((entry) => entry.entry_index)).toEqual([
    0,
    INT_MAX,
  ]);
  const [agent] = await db.query("select wins from agents where account = $1", [alice]);
  expect(agent).toEqual({ wins: INT_MAX });

  expect(await reconcileWith(chain, lines)).toEqual({ inserted: 0, updated: 0 });
  expect(lines).toEqual([
    "WARN reconcile task=1 inserted from the chain",
    `WARN reconcile agent=${alice} field=wins`,
  ]);
});

test("a_task_the_chain_does_not_have_is_warned_about_and_kept", async () => {
  await seed();
  const before = await snapshot();
  const lines: string[] = [];

  // An index of another chain: this one has no task at all.
  const chain = lifecycleChain({ tasks: [], entries: {} });
  expect(await reconcileWith(chain, lines)).toEqual({ inserted: 0, updated: 0 });
  expect(lines).toEqual(["WARN reconcile task=1 is not on the chain"]);
  expect(await snapshot()).toEqual(before);
});

test("a_task_without_an_outcome_is_stored_with_sql_null_and_a_json_null_is_repaired", async () => {
  await seedLifecycle(db);
  await apply(created(2, 95));
  await apply(blockOf(95 + SKEW, []));
  await forget("2");
  const chain = lifecycleChain({ final: 95n, tasks: [TASK_1, openTask(2)] });
  const lines: string[] = [];

  expect(await reconcileWith(chain, lines)).toEqual({ inserted: 1, updated: 0 });
  expect(await taskOf("2")).toMatchObject({ outcome: null, has_outcome: false });

  // A JSON null reads as null but is not SQL NULL: `outcome is not null` holds, and the task would
  // read as settled.
  await db.query(`update tasks set outcome = 'null'::jsonb where id = 2`);
  expect(await reconcileWith(chain, lines)).toEqual({ inserted: 0, updated: 1 });
  expect(await taskOf("2")).toMatchObject({ outcome: null, has_outcome: false });
  expect(lines).toEqual([
    "WARN reconcile task=2 inserted from the chain",
    "WARN reconcile task=2 field=outcome",
  ]);
});

test("each_field_that_differs_is_repaired_with_a_warn_of_its_own_and_by_is_kept", async () => {
  await seed();
  const before = await snapshot();
  await db.query(
    `update tasks
        set commit_count = 1,
            outcome = outcome || '{"fee": "1", "scorecard_uri": "ipfs://elsewhere"}'::jsonb
      where id = 1`,
  );
  const lines: string[] = [];

  expect(await reconcileWith(lifecycleChain(), lines)).toEqual({ inserted: 0, updated: 1 });
  expect(lines).toEqual([
    "WARN reconcile task=1 field=commit_count",
    "WARN reconcile task=1 field=outcome.fee",
    "WARN reconcile task=1 field=outcome.scorecard_uri",
  ]);
  // Back to what the events made, `by` and the height of the pick included.
  expect(await snapshot()).toEqual(before);
});

test("a_pick_the_index_missed_is_stored_from_the_view_with_by_null", async () => {
  await seed();
  await db.query("update tasks set outcome = null, settled_height = null where id = 1");
  const lines: string[] = [];

  expect(await reconcileWith(lifecycleChain(), lines)).toEqual({ inserted: 0, updated: 1 });
  expect((await taskOf("1"))?.outcome).toEqual({
    ...TASK_1.outcome,
    task_id: "1",
    by: null,
    by_source: "reconcile",
  });
  expect(lines).toEqual(["WARN reconcile task=1 field=outcome"]);
});

test("a_stored_outcome_of_the_other_kind_is_replaced_as_if_it_were_missing", async () => {
  // The kind never changes on chain: a void stored for a task that the chain shows picked is not
  // its outcome, and neither is the `by` or the height that came with it.
  await seed();
  const voided = { kind: "voided", ...fixtureData("voided"), task_id: "1" };
  await db.query("update tasks set outcome = $1 where id = 1", [JSON.stringify(voided)]);
  const lines: string[] = [];

  expect(await reconcileWith(lifecycleChain(), lines)).toEqual({ inserted: 0, updated: 1 });
  expect(lines).toEqual(["WARN reconcile task=1 field=outcome.kind"]);
  const task = await taskOf("1");
  expect(task?.outcome).toEqual({
    ...TASK_1.outcome,
    task_id: "1",
    by: null,
    by_source: "reconcile",
  });
  expect(task?.settled_height).toBeNull();
});

test("an_outcome_is_never_cleared_by_a_view_without_one", async () => {
  // A view from a node further behind than the margin, or of another chain, can lack the outcome.
  // An outcome is final on chain, so such a view is stale: the row keeps its outcome, `by` and all.
  await seed();
  const before = await snapshot();
  const lines: string[] = [];
  const stale = lifecycleChain({ tasks: [{ ...TASK_1, outcome: null, phase: "judging" }] });

  expect(await reconcileWith(stale, lines)).toEqual({ inserted: 0, updated: 0 });
  expect(lines).toEqual([
    "WARN reconcile task=1 field=outcome kept: the view has none, and an outcome is final",
  ]);
  expect(await snapshot()).toEqual(before);

  // A current view agrees with the row as it is, and the judge is still the one who picked.
  expect(await reconcileWith(lifecycleChain(), lines)).toEqual({ inserted: 0, updated: 0 });
  expect(lines).toHaveLength(1);
  expect((await taskOf("1"))?.outcome).toMatchObject({ by: judge });
});

test("a_view_from_up_to_20_blocks_before_the_index_repairs_nothing", async () => {
  // A lagging RPC node answers as of block 85, before the pick that the index applied at 90: task
  // 1 has no outcome in its view, and nobody has won or picked yet.
  await seedLifecycle(db);
  const before = await projected();
  const stale = lifecycleChain({
    tasks: [{ ...TASK_1, outcome: null, phase: "judging" }],
    agents: AGENTS.map((agent) => ({ ...agent, wins: 0, earned: [], picks_made: 0 })),
  });
  // The pass reads the final height as 90 and waits for block 110, which the runner gets to.
  applyLater(90 + SKEW);
  const lines: string[] = [];

  expect(await reconcileWith(stale, lines, { catchUpMs: 5_000 })).toEqual({
    inserted: 0,
    updated: 0,
  });
  expect(lines).toEqual([]);
  expect(await projected()).toEqual(before);
});

test("a_view_from_up_to_20_blocks_past_the_final_height_repairs_nothing_early", async () => {
  // Task 2 has been open since block 95. A node ahead of the one that gave the final height, 120,
  // already shows bob's commit at block 121, which the index has not applied. Repaired to one
  // commit now, the task would count that commit twice once the index applied it, and give bob's
  // entry index 1 for good.
  await seedLifecycle(db);
  await apply(created(2, 95));
  await apply(blockOf(120, []));
  const chain = lifecycleChain({
    final: 120n,
    tasks: [TASK_1, { ...openTask(2), commit_count: 1 }],
  });
  const commit = eventLine("committed", {
    task_id: "2",
    account: bob,
    commitment: BOB_ENTRY.commitment,
    block_height: "121",
  });
  // While the pass waits, the runner applies the commit and goes on to block 140.
  setTimeout(() => {
    void apply(blockOf(121, [commit])).then(() => apply(blockOf(120 + SKEW, [])));
  }, 200);
  const lines: string[] = [];

  expect(await reconcileWith(chain, lines, { catchUpMs: 5_000 })).toEqual({
    inserted: 0,
    updated: 0,
  });
  await cursorReaches(120 + SKEW);
  expect(lines).toEqual([]);
  expect(await taskOf("2")).toMatchObject({ commit_count: 1 });
  expect(await entriesOf("2")).toMatchObject([{ account: bob, entry_index: 0 }]);
});

test("a_task_with_an_event_after_the_start_of_a_pass_waits_for_a_later_pass", async () => {
  await seed();
  await db.query("update tasks set commit_count = 1 where id = 1");
  // While reconcile reads the views, carol tops task 1 up: an event at block 111, after the height
  // the pass started from. What it read of task 1 may predate that or not.
  const chain = lifecycleChain({
    final: 91n,
    onFirstRead: async () => {
      await apply(blockOf(111, [eventLine("task_topped_up")]));
    },
  });
  const lines: string[] = [];

  expect(await reconcileWith(chain, lines)).toEqual({ inserted: 0, updated: 0 });
  expect(lines).toEqual([]);
  expect(await taskOf("1")).toMatchObject({ commit_count: 1 });

  // Once the index is 20 blocks past the top-up, and the chain has not moved since, a pass repairs
  // the count.
  await apply(blockOf(111 + SKEW, []));
  chain.final = 111n;
  expect(await reconcileWith(chain, lines)).toEqual({ inserted: 0, updated: 1 });
  expect(lines).toEqual(["WARN reconcile task=1 field=commit_count"]);
  expect(await taskOf("1")).toMatchObject({ commit_count: 2 });
});

test("nothing_is_repaired_until_the_index_is_20_blocks_past_the_final_height", async () => {
  await seed();
  await db.query("update tasks set commit_count = 1 where id = 1");
  const lines: string[] = [];

  // The views may show the chain up to 20 blocks past the final height they gave, 92, and the
  // index is at 110: a commit at 111 or 112 would look like one that it missed.
  const chain = lifecycleChain({ final: 92n });
  expect(await reconcileWith(chain, lines, { catchUpMs: 300 })).toEqual({
    inserted: 0,
    updated: 0,
  });
  expect(lines).toEqual([
    "reconcile: the index is at block 110, short of block 112, 20 past the chain's final " +
      "height; nothing repaired",
  ]);
  expect(await taskOf("1")).toMatchObject({ commit_count: 1 });

  // Once the index gets there, the pass goes on.
  applyLater(112);
  expect(await reconcileWith(chain, lines, { catchUpMs: 5_000 })).toEqual({
    inserted: 0,
    updated: 1,
  });
  expect(await taskOf("1")).toMatchObject({ commit_count: 2 });
});

test("a_pass_before_the_index_holds_a_block_reads_no_view", async () => {
  // With no cursor, a pass has no height to start from, and no event could tell it what moved.
  const chain = lifecycleChain();
  const lines: string[] = [];

  expect(await reconcileWith(chain, lines, { catchUpMs: 300 })).toEqual({
    inserted: 0,
    updated: 0,
  });
  expect(lines).toEqual(["reconcile: the index holds no block yet; nothing repaired"]);
  expect(chain.reads ?? 0).toBe(0);
  expect(await taskOf(LIFECYCLE_TASK_ID)).toBeUndefined();
});

test("a_pass_reads_no_view_while_the_index_is_too_far_behind_to_catch_up", async () => {
  // 201 blocks short of the chain's final height: catching up, more than a pass could wait for.
  await seed();
  await db.query("update tasks set commit_count = 1 where id = 1");
  const chain = lifecycleChain({ final: 110n + 201n });
  const lines: string[] = [];

  expect(await reconcileWith(chain, lines, { catchUpMs: 300 })).toEqual({
    inserted: 0,
    updated: 0,
  });
  expect(lines).toEqual([
    "reconcile: the index is at block 110, 201 blocks short of the chain's final height 311; " +
      "nothing repaired",
  ]);
  expect(chain.reads ?? 0).toBe(0);
  expect(await taskOf("1")).toMatchObject({ commit_count: 1 });
});

test("agent_counters_are_repaired_but_not_for_an_agent_with_a_newer_event", async () => {
  await seed();
  await db.query(
    `update agents set entries = 0, reveals = 0, wins = 0, earned = '{}' where account = $1`,
    [alice],
  );
  await db.query("update agents set picks_made = 0 where account = $1", [judge]);
  // The judge updates its profile while reconcile reads the views.
  const chain = lifecycleChain({
    final: 91n,
    onFirstRead: async () => {
      await apply(blockOf(111, [eventLine("agent_registered", { account: judge, updated: true })]));
    },
  });
  const lines: string[] = [];

  expect(await reconcileWith(chain, lines)).toEqual({ inserted: 0, updated: 1 });
  expect(lines).toEqual([
    `WARN reconcile agent=${alice} field=entries`,
    `WARN reconcile agent=${alice} field=reveals`,
    `WARN reconcile agent=${alice} field=wins`,
    `WARN reconcile agent=${alice} field=earned`,
  ]);
  const [repaired] = await db.query(
    "select entries, reveals, wins, earned from agents where account = $1",
    [alice],
  );
  expect(repaired).toEqual({
    entries: 1,
    reveals: 1,
    wins: 1,
    earned: { [FIXTURE_TOKEN]: "665003" },
  });
  const [skipped] = await db.query("select picks_made from agents where account = $1", [judge]);
  expect(skipped).toEqual({ picks_made: 0 });
});

test("only_the_50_newest_tasks_and_the_unsettled_ones_are_compared", async () => {
  await seedLifecycle(db);
  // Tasks 2 to 52, all open: the 50 newest are 3 to 52, so task 1 (settled) and task 2 (open) are
  // older than those.
  const tasks = [TASK_1];
  for (let id = 2; id <= 52; id++) {
    await apply(created(id, 100 + id));
    tasks.push(openTask(id));
  }
  await apply(blockOf(152 + SKEW, []));
  await db.query("update tasks set commit_count = 9 where id in (1, 2)");
  const lines: string[] = [];

  const chain = lifecycleChain({ final: 152n, tasks });
  expect(await reconcileWith(chain, lines)).toEqual({ inserted: 0, updated: 1 });
  expect(lines).toEqual(["WARN reconcile task=2 field=commit_count"]);
  expect(await taskOf("1")).toMatchObject({ commit_count: 9 });
  expect(await taskOf("2")).toMatchObject({ commit_count: 0 });
});

test("a_late_start_fills_in_the_tasks_and_agent_counters_it_never_saw", async () => {
  // The index starts at block 70: it saw the agents register, and none of task 1. Its commits,
  // reveals and pick project nothing, for the index has no task 1 to put them in.
  await seed();
  await forget(LIFECYCLE_TASK_ID);
  await db.query(
    `update agents set entries = 0, reveals = 0, wins = 0, earned = '{}', picks_made = 0`,
  );
  const lines: string[] = [];

  expect(await reconcileWith(lifecycleChain(), lines)).toEqual({ inserted: 1, updated: 3 });
  expect(await taskOf(LIFECYCLE_TASK_ID)).toMatchObject({
    commit_count: 2,
    reveal_count: 2,
    outcome: { kind: "picked", by: null, by_source: "reconcile" },
  });
  const agents = await db.query(
    `select account, entries, reveals, wins, earned, picks_made, voids_after_reveals
       from agents order by account`,
  );
  expect(agents).toEqual(
    [...AGENTS]
      .sort((a, b) => a.account.localeCompare(b.account))
      .map((agent) => ({
        account: agent.account,
        entries: agent.entries,
        reveals: agent.reveals,
        wins: agent.wins,
        earned: Object.fromEntries(agent.earned.map((slot) => [slot.token, slot.amount])),
        picks_made: agent.picks_made,
        voids_after_reveals: agent.voids_after_reveals,
      })),
  );
  expect(lines[0]).toBe("WARN reconcile task=1 inserted from the chain");
  expect(lines).toContain(`WARN reconcile agent=${judge} field=picks_made`);
});
