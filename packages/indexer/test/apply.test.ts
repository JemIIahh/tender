import { type Db, migrate, openDb, putBlob } from "@tender/db";
import { canonicalJson, sha256Hex } from "@tender/shared";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { applyBlock, type IndexedBlock } from "../src/index";
import {
  BOB_ENTRY,
  blockOf,
  eventLine,
  FIXTURE_ACCOUNTS,
  FIXTURE_BRIEF,
  FIXTURE_BRIEF_HASH,
  FIXTURE_OPTIONS,
  FIXTURE_PROFILE,
  FIXTURE_PROFILE_HASH,
  FIXTURE_TOKEN,
  fixtureData,
  LIFECYCLE_TASK_ID,
  lifecycleBlocks,
  putFixtureBlobs,
  receipt,
  seedLifecycle,
} from "./fixtures/blocks";

// Every test runs on one PGlite database that is emptied before each test. The lines come from the
// captured logs in @tender/shared (see fixtures/blocks.ts); `eventLine(name, { field })` is the
// captured line with only the named `data` fields changed.

const { poster, judge, alice, bob, carol } = FIXTURE_ACCOUNTS;
const U128_MAX = "340282366920938463463374607431768211455";
const TABLES = ["chain_cursor", "events", "tasks", "funders", "entries", "agents"];

let db: Db;
let height = 1000n;

beforeAll(async () => {
  db = await openDb("pglite:memory");
  await migrate(db);
});

afterAll(() => db.close());

beforeEach(async () => {
  height = 1000n;
  await db.exec(`truncate ${TABLES.join(", ")}, blobs restart identity`);
});

/** Applies one block of its own, at the next height, in which each of `lines` has a receipt. */
function apply(...lines: string[]): Promise<number> {
  return applyBlock(db, blockOf(height++, lines), FIXTURE_OPTIONS);
}

type Row = Record<string, unknown>;

function rows(sql: string, params: unknown[] = []): Promise<Row[]> {
  return db.query<Row>(sql, params);
}

async function count(table: string): Promise<number> {
  const [row] = await db.query<{ n: number }>(`select count(*)::int as n from ${table}`);
  return row?.n ?? -1;
}

async function cursor(): Promise<string | undefined> {
  const [row] = await db.query<{ height: string }>(
    "select height::text as height from chain_cursor where source = $1",
    [FIXTURE_OPTIONS.cursorSource],
  );
  return row?.height;
}

async function taskOf(id: string): Promise<Row | undefined> {
  const [row] = await rows(
    `select id::text as id, poster, token, reward::text as reward, fee_bps, brief_uri, brief_hash,
            criteria_hash, heldout_commitment, verifier, created_at::text as created_at,
            commit_deadline::text as commit_deadline, reveal_deadline::text as reveal_deadline,
            pick_deadline::text as pick_deadline, fallback_deadline::text as fallback_deadline,
            max_entries, max_winners, invited, parent::text as parent, commit_count, reveal_count,
            outcome, settled_height::text as settled_height, title, category, tags, judge_status,
            judge_reason, created_height::text as created_height
       from tasks where id = $1`,
    [id],
  );
  return row;
}

function entriesOf(taskId: string): Promise<Row[]> {
  return rows(
    `select account, entry_index, commitment, committed_height::text as committed_height,
            content_hash, uri
       from entries where task_id = $1 order by entry_index`,
    [taskId],
  );
}

function fundersOf(taskId: string): Promise<Row[]> {
  return rows(
    "select account, amount::text as amount from funders where task_id = $1 order by account",
    [taskId],
  );
}

async function agentOf(account: string): Promise<Row | undefined> {
  const [row] = await rows(
    `select account, asp, profile_uri, profile_hash, tags, name, entries, reveals, wins, earned,
            picks_made, voids_after_reveals, registered_height::text as registered_height, is_team
       from agents where account = $1`,
    [account],
  );
  return row;
}

async function counters(account: string): Promise<Row | undefined> {
  const [row] = await rows(
    `select entries, reveals, wins, picks_made, voids_after_reveals from agents where account = $1`,
    [account],
  );
  return row;
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

// ---- The lifecycle ----------------------------------------------------------------------------

test("projects_full_lifecycle", async () => {
  await seedLifecycle(db);

  expect(await count("events")).toBe(9);
  const task = await taskOf(LIFECYCLE_TASK_ID);
  expect(task).toMatchObject({
    reward: "1000003",
    commit_count: 2,
    reveal_count: 2,
    settled_height: "90",
    title: FIXTURE_BRIEF.title,
  });
  expect(task?.outcome).toEqual({ kind: "picked", ...fixtureData("picked") });

  expect(await entriesOf(LIFECYCLE_TASK_ID)).toEqual([
    {
      account: alice,
      entry_index: 0,
      commitment: fixtureData("committed").commitment,
      committed_height: "65",
      content_hash: fixtureData("revealed").content_hash,
      uri: "ipfs://alice-work",
    },
    {
      account: bob,
      entry_index: 1,
      commitment: BOB_ENTRY.commitment,
      committed_height: "66",
      content_hash: BOB_ENTRY.contentHash,
      uri: BOB_ENTRY.uri,
    },
  ]);
  expect(await fundersOf(LIFECYCLE_TASK_ID)).toEqual([{ account: poster, amount: "1000003" }]);

  // The agents as the contract's get_agent shows them at the end of this run.
  expect(await agentOf(alice)).toMatchObject({
    name: FIXTURE_PROFILE.name,
    entries: 1,
    reveals: 1,
    wins: 1,
    earned: { [FIXTURE_TOKEN]: "665003" },
    picks_made: 0,
    voids_after_reveals: 0,
    registered_height: "60",
    is_team: false,
  });
  expect(await agentOf(bob)).toMatchObject({
    name: null,
    entries: 1,
    reveals: 1,
    wins: 1,
    earned: { [FIXTURE_TOKEN]: "285000" },
  });
  expect(await agentOf(judge)).toMatchObject({ entries: 0, wins: 0, picks_made: 1 });
  expect((await agentOf(judge))?.earned).toEqual({});
  expect(await cursor()).toBe("90");
});

test("task_created_maps_every_field", async () => {
  expect(await apply(eventLine("task_created"))).toBe(1);

  const d = fixtureData("task_created");
  expect(await taskOf("1")).toEqual({
    id: "1",
    poster: d.poster,
    token: d.token,
    reward: d.reward,
    fee_bps: d.fee_bps,
    brief_uri: d.brief_uri,
    brief_hash: d.brief_hash,
    criteria_hash: d.criteria_hash,
    heldout_commitment: d.heldout_commitment,
    verifier: d.verifier,
    created_at: d.created_at,
    commit_deadline: d.commit_deadline,
    reveal_deadline: d.reveal_deadline,
    pick_deadline: d.pick_deadline,
    fallback_deadline: d.fallback_deadline,
    max_entries: d.max_entries,
    max_winners: d.max_winners,
    invited: d.invited,
    parent: null,
    commit_count: 0,
    reveal_count: 0,
    outcome: null,
    settled_height: null,
    title: null,
    category: null,
    tags: [],
    judge_status: null,
    judge_reason: null,
    created_height: "1000",
  });
  // The poster is the only funder, for the whole reward.
  expect(await fundersOf("1")).toEqual([{ account: d.poster, amount: d.reward }]);

  // The two nullable fields, the other way round from the capture.
  await apply(eventLine("task_created", { id: "2", parent: "1", heldout_commitment: null }));
  expect(await taskOf("2")).toMatchObject({ parent: "1", heldout_commitment: null });
});

test("replaced_commit_keeps_index_and_count", async () => {
  await apply(eventLine("agent_registered"));
  await apply(eventLine("task_created"));
  await apply(eventLine("committed"));
  await apply(
    eventLine("committed", { account: bob, commitment: BOB_ENTRY.commitment, block_height: "66" }),
  );
  const again = sha256Hex("alice commits again");
  await apply(eventLine("committed", { replaced: true, commitment: again, block_height: "70" }));

  expect(await entriesOf("1")).toMatchObject([
    { account: alice, entry_index: 0, commitment: again, committed_height: "70" },
    { account: bob, entry_index: 1, commitment: BOB_ENTRY.commitment, committed_height: "66" },
  ]);
  expect((await taskOf("1"))?.commit_count).toBe(2);
  // Replacing a commitment is not a new entry for the agent either.
  expect((await counters(alice))?.entries).toBe(1);
});

// ---- Idempotency, failures, rollback ----------------------------------------------------------

test("idempotent_on_replay", async () => {
  await putFixtureBlobs(db);
  const blocks = lifecycleBlocks();
  for (const block of blocks) expect(await applyBlock(db, block, FIXTURE_OPTIONS)).toBe(1);
  const before = await snapshot();
  expect(await counters(alice)).toEqual({
    entries: 1,
    reveals: 1,
    wins: 1,
    picks_made: 0,
    voids_after_reveals: 0,
  });

  // The whole run again, block by block: nothing is applied, and no row of any table changes.
  for (const block of blocks) expect(await applyBlock(db, block, FIXTURE_OPTIONS)).toBe(0);
  expect(await snapshot()).toEqual(before);
});

test("replay_applies_only_the_events_it_has_not_seen", async () => {
  const created = receipt("create", [eventLine("task_created")]);
  const block = (receipts: IndexedBlock["receipts"]): IndexedBlock => ({
    height: 5n,
    timestampNs: 1n,
    receipts,
  });
  expect(await applyBlock(db, block([created]), FIXTURE_OPTIONS)).toBe(1);

  // The same receipt beside a new one: only the commit is new, so only it is projected.
  const commit = receipt("commit", [eventLine("committed")]);
  expect(await applyBlock(db, block([created, commit]), FIXTURE_OPTIONS)).toBe(1);

  expect(await count("events")).toBe(2);
  expect(await taskOf("1")).toMatchObject({ commit_count: 1 });
  expect(await fundersOf("1")).toEqual([{ account: poster, amount: "1000003" }]);
});

test("failure_receipt_ignored", async () => {
  const mixed: IndexedBlock = {
    height: 70n,
    timestampNs: 1n,
    receipts: [
      // A failed call keeps its logs on chain, but it changed no state.
      receipt("failed", [eventLine("task_created")], { status: "failure" }),
      // Any contract can log a line that looks like ours.
      receipt("lookalike", [eventLine("task_created")], { executorId: "other.test.near" }),
      // A good receipt beside them counts. Its log_index counts the plain log before the event.
      receipt("good", ["plain log", eventLine("agent_registered")]),
    ],
  };
  expect(await applyBlock(db, mixed, FIXTURE_OPTIONS)).toBe(1);
  expect(await rows("select receipt_id, log_index, event from events")).toEqual([
    { receipt_id: "good", log_index: 1, event: "agent_registered" },
  ]);
  expect(await count("tasks")).toBe(0);
  expect(await count("funders")).toBe(0);

  // A block with nothing to apply still moves the cursor: the block was read.
  const onlyFailed: IndexedBlock = {
    height: 71n,
    timestampNs: 2n,
    receipts: [receipt("failed-too", [eventLine("task_created")], { status: "failure" })],
  };
  expect(await applyBlock(db, onlyFailed, FIXTURE_OPTIONS)).toBe(0);
  expect(await count("events")).toBe(1);
  expect(await cursor()).toBe("71");
});

test("cursor_and_rows_roll_back_together", async () => {
  await db.query("insert into chain_cursor (source, height) values ($1, 50)", [
    FIXTURE_OPTIONS.cursorSource,
  ]);
  // A database whose transactions fail on the statements that match `fault`.
  const failingOn = (fault: RegExp): Db => ({
    ...db,
    tx: (fn) =>
      db.tx((tx) =>
        fn({
          ...tx,
          query: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
            if (fault.test(sql)) throw new Error("injected error");
            return tx.query<T>(sql, params);
          },
        }),
      ),
  });
  const block = blockOf(60, [
    eventLine("agent_registered"),
    eventLine("task_created"),
    eventLine("committed"),
  ]);

  // The fault comes in the projection of the third event, after the first two projected without
  // trouble, and then in the cursor write at the very end, after all three did. Either way nothing
  // of the block stays, and the cursor is where it was.
  for (const fault of [/insert into entries/i, /insert into chain_cursor/i]) {
    await expect(applyBlock(failingOn(fault), block, FIXTURE_OPTIONS)).rejects.toThrow(
      "injected error",
    );
    for (const table of ["events", "agents", "tasks", "funders", "entries"]) {
      expect(await count(table), `${table} after a fault in ${fault}`).toBe(0);
    }
    expect(await cursor()).toBe("50");
  }

  // Without the fault, the same block applies in full.
  expect(await applyBlock(db, block, FIXTURE_OPTIONS)).toBe(3);
  expect(await cursor()).toBe("60");
});

test("cursor_moves_forward_only", async () => {
  await apply(eventLine("agent_registered"));
  expect(await cursor()).toBe("1000");

  // An older block applied late does not pull the cursor back.
  await applyBlock(db, { height: 900n, timestampNs: 1n, receipts: [] }, FIXTURE_OPTIONS);
  expect(await cursor()).toBe("1000");

  // A block with no events still advances it.
  await applyBlock(db, { height: 1005n, timestampNs: 1n, receipts: [] }, FIXTURE_OPTIONS);
  expect(await cursor()).toBe("1005");
});

// ---- Brief and profile blobs ------------------------------------------------------------------

test("brief_fields_filled_when_blob_present", async () => {
  await putFixtureBlobs(db);
  await apply(eventLine("task_created", { brief_hash: FIXTURE_BRIEF_HASH }));

  expect(await taskOf("1")).toMatchObject({
    brief_hash: FIXTURE_BRIEF_HASH,
    title: FIXTURE_BRIEF.title,
    category: FIXTURE_BRIEF.category,
    tags: FIXTURE_BRIEF.tags,
  });
});

test("brief_fields_stay_empty_without_a_valid_blob", async () => {
  const store = (bytes: Uint8Array) =>
    putBlob(db, { kind: "brief", contentType: "application/json", bytes, isPublic: true });
  // BriefSchema is strict, so a misspelt key means this is not a brief.
  const misspelt = await store(canonicalJson({ ...FIXTURE_BRIEF, attachements: [] }));
  const notJson = await store(new TextEncoder().encode("{ not json"));

  await apply(
    eventLine("task_created", { id: "1" }), // no blob at all under the captured hash
    eventLine("task_created", { id: "2", brief_hash: misspelt }),
    eventLine("task_created", { id: "3", brief_hash: notJson }),
  );

  expect(await count("tasks")).toBe(3);
  for (const id of ["1", "2", "3"]) {
    expect(await taskOf(id), id).toMatchObject({ title: null, category: null, tags: [] });
  }
});

test("agent_name_only_from_a_valid_profile_blob", async () => {
  await putFixtureBlobs(db);
  // ProfileSchema allows http(s) homepages only, so this profile is not valid.
  const badHomepage = await putBlob(db, {
    kind: "profile",
    contentType: "application/json",
    bytes: canonicalJson({ ...FIXTURE_PROFILE, name: "Mallory", homepage: "javascript:alert(1)" }),
    isPublic: true,
  });

  await apply(
    eventLine("agent_registered", { profile_hash: FIXTURE_PROFILE_HASH }),
    eventLine("agent_registered", { account: bob, profile_hash: badHomepage }),
    eventLine("agent_registered", { account: judge }), // the captured hash has no blob
  );

  expect((await agentOf(alice))?.name).toBe(FIXTURE_PROFILE.name);
  expect((await agentOf(bob))?.name).toBeNull();
  expect((await agentOf(judge))?.name).toBeNull();
});

// ---- Agents -----------------------------------------------------------------------------------

test("team_flag_from_asp", async () => {
  const options = { ...FIXTURE_OPTIONS, teamAccounts: ["test.near", "team.near"] };
  const register = (account: string, asp: string | null) =>
    eventLine("agent_registered", { account, asp });
  const block = blockOf(7, [
    register(alice, "test.near"), // the provider is ours
    register("dave.other.near", "other.near"), // someone else's provider
    register("team.near", null), // the account itself is ours
    register("loner.near", null), // no provider, not ours
  ]);
  expect(await applyBlock(db, block, options)).toBe(4);

  const flags = await rows("select account, is_team from agents order by account");
  expect(flags).toEqual([
    { account: alice, is_team: true },
    { account: "dave.other.near", is_team: false },
    { account: "loner.near", is_team: false },
    { account: "team.near", is_team: true },
  ]);

  // An update works the flag out again, from the teamAccounts it is given.
  const update = blockOf(8, [
    eventLine("agent_registered", { account: "dave.other.near", asp: "other.near", updated: true }),
  ]);
  await applyBlock(db, update, { ...FIXTURE_OPTIONS, teamAccounts: ["other.near"] });
  expect((await agentOf("dave.other.near"))?.is_team).toBe(true);
});

test("agent_update_keeps_counters_and_registered_height", async () => {
  await putFixtureBlobs(db);
  await apply(eventLine("agent_registered", { profile_hash: FIXTURE_PROFILE_HASH }));

  // The first registration writes every counter out, as zero.
  const captured = fixtureData("agent_registered");
  expect(await agentOf(alice)).toEqual({
    account: alice,
    asp: "test.near",
    profile_uri: captured.profile_uri,
    profile_hash: FIXTURE_PROFILE_HASH,
    tags: captured.tags,
    name: FIXTURE_PROFILE.name,
    entries: 0,
    reveals: 0,
    wins: 0,
    earned: {},
    picks_made: 0,
    voids_after_reveals: 0,
    registered_height: "1000",
    is_team: false,
  });

  await apply(eventLine("task_created"));
  await apply(eventLine("committed"));

  const v2 = { ...FIXTURE_PROFILE, name: "Alice Researcher", tags: ["research"] };
  const v2Hash = await putBlob(db, {
    kind: "profile",
    contentType: "application/json",
    bytes: canonicalJson(v2),
    isPublic: true,
  });
  await apply(
    eventLine("agent_registered", {
      updated: true,
      profile_uri: "ipfs://alice-profile-v2",
      profile_hash: v2Hash,
      tags: ["research"],
    }),
  );

  // The profile is replaced. The counters and the registration height are not.
  expect(await agentOf(alice)).toMatchObject({
    profile_uri: "ipfs://alice-profile-v2",
    profile_hash: v2Hash,
    tags: ["research"],
    name: "Alice Researcher",
    entries: 1,
    registered_height: "1000",
  });
});

test("agent_counters_follow_contract", async () => {
  const create = (id: string) => eventLine("task_created", { id });
  const commit = (task: string, account: string) =>
    eventLine("committed", { task_id: task, account });
  const reveal = (task: string, account: string) =>
    eventLine("revealed", { task_id: task, account });
  for (const account of [alice, bob, judge, poster]) {
    await apply(eventLine("agent_registered", { account }));
  }

  // Task 1: alice and bob enter and reveal, and the verifier picks them both.
  await apply(create("1"));
  await apply(commit("1", alice), commit("1", bob));
  await apply(reveal("1", alice), reveal("1", bob));
  await apply(eventLine("picked"));

  // Task 2: alice wins alone. The poster picks, as it may in the fallback window, so the pick is
  // the poster's: picks_made goes to `by`, not to the task's verifier.
  await apply(create("2"));
  await apply(commit("2", alice));
  await apply(reveal("2", alice));
  await apply(
    eventLine("picked", {
      task_id: "2",
      by: poster,
      winners: [{ account: alice, bps: 10000, amount: "950003" }],
      fee: "50000",
    }),
  );

  // Task 3: void_task closes it. No account is behind it (`by` is null), so no counter moves.
  await apply(create("3"));
  await apply(
    eventLine("voided", {
      task_id: "3",
      reason: "no_reveals",
      by: null,
      refunds: [{ account: poster, amount: "1000003" }],
      scorecard_hash: null,
      scorecard_uri: null,
    }),
  );

  const zero = { entries: 0, reveals: 0, wins: 0, picks_made: 0, voids_after_reveals: 0 };
  expect(await counters(alice)).toEqual({ ...zero, entries: 2, reveals: 2, wins: 2 });
  expect(await counters(bob)).toEqual({ ...zero, entries: 1, reveals: 1, wins: 1 });
  expect(await counters(judge)).toEqual({ ...zero, picks_made: 1 });
  expect(await counters(poster)).toEqual({ ...zero, picks_made: 1 });

  // The outcome keeps `by`, the only record of who settled the task.
  expect((await taskOf("1"))?.outcome).toMatchObject({ kind: "picked", by: judge });
  expect((await taskOf("2"))?.outcome).toMatchObject({ kind: "picked", by: poster });
  expect((await taskOf("3"))?.outcome).toEqual({
    kind: "voided",
    task_id: "3",
    reason: "no_reveals",
    by: null,
    refunds: [{ account: poster, amount: "1000003" }],
    scorecard_hash: null,
    scorecard_uri: null,
  });
  expect(await taskOf("3")).toMatchObject({ settled_height: String(height - 1n) });
});

test("voided_no_award_counts_voids_after_reveals", async () => {
  await apply(
    eventLine("agent_registered", { account: judge }),
    eventLine("agent_registered", { account: alice }),
  );
  // The captured voided is an empty pick (reason no_award) by the judge, with its scorecard.
  const emptyPick = (task: string, by: string) => eventLine("voided", { task_id: task, by });
  const enter = async (task: string, reveals: boolean) => {
    await apply(eventLine("task_created", { id: task }));
    await apply(eventLine("committed", { task_id: task }));
    if (reveals) await apply(eventLine("revealed", { task_id: task }));
  };

  // Task 1: alice reveals, then the judge awards nobody. That is the one that counts.
  await enter("1", true);
  await apply(emptyPick("1", judge));
  expect(await counters(judge)).toMatchObject({ voids_after_reveals: 1, picks_made: 0 });
  expect((await taskOf("1"))?.outcome).toEqual({
    kind: "voided",
    ...fixtureData("voided"),
    task_id: "1",
  });

  // Task 2: nothing was revealed, so an empty pick adds nothing.
  await enter("2", false);
  await apply(emptyPick("2", judge));
  expect(await counters(judge)).toMatchObject({ voids_after_reveals: 1 });

  // Task 3: reveals, but void_task closes it (no `by`), so it adds nothing either.
  await enter("3", true);
  await apply(
    eventLine("voided", {
      task_id: "3",
      reason: "expired",
      by: null,
      scorecard_hash: null,
      scorecard_uri: null,
    }),
  );
  expect(await counters(judge)).toMatchObject({ voids_after_reveals: 1, picks_made: 0 });

  // Task 4: reveals, and a `by` that is not an agent. Nothing is counted and no agent appears.
  await enter("4", true);
  await apply(emptyPick("4", "stranger.test.near"));
  expect(await agentOf("stranger.test.near")).toBeUndefined();
  expect(await counters(judge)).toMatchObject({ voids_after_reveals: 1 });
  expect(await counters(alice)).toMatchObject({ entries: 4, reveals: 3, voids_after_reveals: 0 });
});

test("earned_mirrors_contract_slots", async () => {
  const OTHER_TOKEN = "usdc.test.near";
  await apply(eventLine("agent_registered", { account: alice }));
  await apply(eventLine("task_created", { id: "1" }));

  // bob enters before he is an agent, so no slot. alice is one, so her first entry in the task's
  // token opens a slot at zero.
  await apply(eventLine("committed", { account: bob, commitment: BOB_ENTRY.commitment }));
  await apply(eventLine("committed", { account: alice }));
  expect((await agentOf(alice))?.earned).toEqual({ [FIXTURE_TOKEN]: "0" });

  // bob registers and then replaces his commitment. A replacement opens no slot and counts no entry.
  await apply(eventLine("agent_registered", { account: bob }));
  await apply(
    eventLine("committed", { account: bob, replaced: true, commitment: sha256Hex("b2") }),
  );
  expect(await counters(bob)).toMatchObject({ entries: 0 });
  expect((await agentOf(bob))?.earned).toEqual({});

  await apply(
    eventLine("revealed", { account: alice }),
    eventLine("revealed", { account: bob, content_hash: BOB_ENTRY.contentHash }),
  );
  await apply(eventLine("picked")); // alice 665003, bob 285000
  // alice's slot takes her share. bob has none, so he is a winner with nothing on record, which is
  // what the contract's get_agent shows for him too.
  expect(await agentOf(alice)).toMatchObject({ wins: 1, earned: { [FIXTURE_TOKEN]: "665003" } });
  expect(await counters(bob)).toMatchObject({ wins: 1 });
  expect((await agentOf(bob))?.earned).toEqual({});

  // A task in another token opens a second slot beside the first. A later task in the first token
  // leaves that slot's balance alone.
  await apply(eventLine("task_created", { id: "2", token: OTHER_TOKEN }));
  await apply(eventLine("task_created", { id: "3" }));
  await apply(eventLine("committed", { task_id: "2", account: alice }));
  await apply(eventLine("committed", { task_id: "3", account: alice }));
  expect((await agentOf(alice))?.earned).toEqual({
    [FIXTURE_TOKEN]: "665003",
    [OTHER_TOKEN]: "0",
  });

  // Winnings are added to the slot of the task's token only, as exact sums (this one is past 2^53).
  const win = (task: string, amount: string) =>
    eventLine("picked", { task_id: task, winners: [{ account: alice, bps: 10000, amount }] });
  await apply(eventLine("revealed", { task_id: "2", account: alice }));
  await apply(win("2", "950003"));
  await apply(eventLine("revealed", { task_id: "3", account: alice }));
  await apply(win("3", "9007199254740993"));
  expect((await agentOf(alice))?.earned).toEqual({
    [FIXTURE_TOKEN]: "9007199255405996",
    [OTHER_TOKEN]: "950003",
  });

  // Like the contract's saturating_add, the sum stops at the largest u128.
  await apply(eventLine("task_created", { id: "4" }));
  await apply(eventLine("committed", { task_id: "4", account: alice }));
  await apply(eventLine("revealed", { task_id: "4", account: alice }));
  await apply(win("4", U128_MAX));
  expect((await agentOf(alice))?.earned).toMatchObject({ [FIXTURE_TOKEN]: U128_MAX });
  expect(await counters(alice)).toMatchObject({ wins: 4 });
});

// ---- Events and tasks -------------------------------------------------------------------------

test("events_task_id_comes_from_task_id_or_id", async () => {
  await seedLifecycle(db);

  // task_created names its task `id`, the others `task_id`; an agent event names no task.
  expect(await rows("select event, task_id::text as task_id from events order by id")).toEqual([
    { event: "agent_registered", task_id: null },
    { event: "agent_registered", task_id: null },
    { event: "agent_registered", task_id: null },
    { event: "task_created", task_id: "1" },
    { event: "committed", task_id: "1" },
    { event: "committed", task_id: "1" },
    { event: "revealed", task_id: "1" },
    { event: "revealed", task_id: "1" },
    { event: "picked", task_id: "1" },
  ]);
});

test("vault_and_delegate_events_are_stored_only", async () => {
  const names = [
    "deposit",
    "withdraw",
    "withdraw_failed",
    "storage_deposit",
    "delegate_added",
    "delegate_removed",
    "attested_pick",
  ];
  expect(await apply(...names.map((name) => eventLine(name)))).toBe(7);

  expect(await rows("select event, task_id::text as task_id from events order by id")).toEqual(
    names.map((event) => ({ event, task_id: event === "attested_pick" ? "1" : null })),
  );
  for (const table of ["tasks", "funders", "entries", "agents"]) {
    expect(await count(table), table).toBe(0);
  }
});

test("top_up_adds_to_the_funder_and_sets_the_reward", async () => {
  await apply(eventLine("task_created")); // the poster funds 1000003
  await apply(eventLine("task_topped_up")); // carol adds 500000: the reward is now 1500003
  await apply(eventLine("task_topped_up", { amount: "200000", reward: "1700003" })); // carol again
  await apply(eventLine("task_topped_up", { funder: poster, amount: "1", reward: "1700004" }));

  expect(await fundersOf("1")).toEqual([
    { account: carol, amount: "700000" },
    { account: poster, amount: "1000004" },
  ]);
  expect((await taskOf("1"))?.reward).toBe("1700004");
});

test("event_for_an_unknown_task_is_stored_not_projected", async () => {
  // An index that started after task 9 was created never saw its task_created.
  await apply(eventLine("agent_registered", { account: alice }));
  const lines = [
    eventLine("task_topped_up", { task_id: "9" }),
    eventLine("committed", { task_id: "9", account: alice }),
    eventLine("revealed", { task_id: "9", account: alice }),
    eventLine("picked", { task_id: "9" }),
    eventLine("voided", { task_id: "9" }),
  ];

  expect(await apply(...lines)).toBe(5);
  expect(await count("events")).toBe(6);
  for (const table of ["tasks", "funders", "entries"]) expect(await count(table), table).toBe(0);
  expect(await counters(alice)).toEqual({
    entries: 0,
    reveals: 0,
    wins: 0,
    picks_made: 0,
    voids_after_reveals: 0,
  });
});

test("values_the_database_cannot_hold_do_not_stop_the_indexer", async () => {
  // All legal on chain. The contract checks a URI only for its length, so it may hold a NUL, which
  // neither text nor jsonb accepts. max_entries is a u32, and an int column holds half that. Left
  // alone, either would fail a projection and roll the block back, on every retry.
  const nul = "ipfs://a\u0000b";
  // What a NUL becomes: U+FFFD, the replacement character.
  const replacement = String.fromCodePoint(0xfffd);
  const cleaned = `ipfs://a${replacement}b`;
  const store = (kind: "brief" | "profile", document: unknown) =>
    putBlob(db, {
      kind,
      contentType: "application/json",
      bytes: canonicalJson(document),
      isPublic: true,
    });
  // The title of a brief and the name of a profile come from blobs, which can hold a NUL too.
  const briefHash = await store("brief", { ...FIXTURE_BRIEF, title: "Extract\u0000totals" });
  const profileHash = await store("profile", { ...FIXTURE_PROFILE, name: "Al\u0000ice" });

  expect(
    await apply(
      eventLine("agent_registered", { profile_uri: nul, profile_hash: profileHash }),
      eventLine("task_created", {
        brief_uri: nul,
        brief_hash: briefHash,
        max_entries: 4_294_967_295,
      }),
    ),
  ).toBe(2);
  await apply(eventLine("committed"));
  await apply(eventLine("revealed", { uri: nul }));
  await apply(eventLine("picked", { scorecard_uri: nul }));

  expect(await agentOf(alice)).toMatchObject({
    profile_uri: cleaned,
    name: `Al${replacement}ice`,
  });
  expect(await taskOf("1")).toMatchObject({
    brief_uri: cleaned,
    title: `Extract${replacement}totals`,
    max_entries: 2_147_483_647,
    commit_count: 1,
    reveal_count: 1,
  });
  expect(await entriesOf("1")).toMatchObject([{ uri: cleaned }]);
  expect((await taskOf("1"))?.outcome).toMatchObject({ scorecard_uri: cleaned });
  const stored = await rows("select data->>'uri' as uri from events where event = 'revealed'");
  expect(stored).toEqual([{ uri: cleaned }]);
});
