import { type TenderClient, TenderError } from "@tender/client";
import { type Db, migrate, openDb } from "@tender/db";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { type KeeperChain, keeperTick, startKeeper } from "../src/index";
import { resetDb, seedLifecycle } from "./helpers";

// The keeper's decisions, against a database and a chain that is a fake. Nothing here starts a
// node: test/keeper.sandbox.test.ts has the keeper send to a real chain. The tasks are rows written
// with SQL, so that a deadline can be one nanosecond either side of the clock; one test reads what
// the indexer itself writes for a finished task. Times are nanoseconds near 1.8e18, well above 2^53,
// where a JS number cannot tell neighbours apart: a clock or a deadline that went through one would
// fail the boundary tests.

const SECOND = 1_000_000_000n;
const WEEK = 7n * 86_400n * SECOND;
/** The reveal deadline of a task unless it is given another, and the fallback deadline after it. */
const REVEAL = 1_800_000_000_000_000_000n;
const FALLBACK = REVEAL + 20n * SECOND;
/** A moment at which every task below that has no outcome is long overdue. */
const LONG_AFTER = FALLBACK + 1_000n * SECOND;

let db: Db;
let receipts = 0;

beforeAll(async () => {
  db = await openDb("pglite:memory");
  await migrate(db);
});

afterAll(() => db.close());

beforeEach(async () => {
  await resetDb(db);
  receipts = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

interface TaskSeed {
  id: number;
  commitCount?: number;
  revealCount?: number;
  revealDeadline?: bigint;
  fallbackDeadline?: bigint;
  /** The event that settled it, and when: the task has an outcome, and the event is stored. */
  settled?: { kind: "picked" | "voided"; at: bigint };
}

/** Inserts a task of `seed.id`, the 4 windows 10 s long apart from the deadlines it is given. */
async function addTask(seed: TaskSeed): Promise<void> {
  const reveal = seed.revealDeadline ?? REVEAL;
  const fallback = seed.fallbackDeadline ?? FALLBACK;
  const outcome = seed.settled ? JSON.stringify({ kind: seed.settled.kind }) : null;
  await db.query(
    `insert into tasks (
       id, poster, token, reward, fee_bps, brief_uri, brief_hash, criteria_hash, verifier,
       created_at, commit_deadline, reveal_deadline, pick_deadline, fallback_deadline,
       max_entries, max_winners, invited, commit_count, reveal_count, outcome, created_height)
     values ($1, 'poster.test', 'token.test', 1000, 500, 'ipfs://brief', $2, $2, 'judge.test',
             $3, $4, $5, $6, $7, 0, 1, '[]', $8, $9, $10, 1)`,
    [
      seed.id,
      "a".repeat(64),
      reveal - 20n * SECOND,
      reveal - 10n * SECOND,
      reveal,
      reveal + 10n * SECOND,
      fallback,
      seed.commitCount ?? 0,
      seed.revealCount ?? 0,
      outcome,
    ],
  );
  if (seed.settled) await addEvent(seed.id, seed.settled.kind, seed.settled.at);
}

/** Stores an event of the task, as the indexer would, at block time `at`. */
async function addEvent(taskId: number, event: string, at: bigint): Promise<void> {
  receipts += 1;
  await db.query(
    `insert into events (height, block_ts, receipt_id, log_index, event, data, task_id)
     values (1, $1, $2, 0, $3, '{}', $4)`,
    [at, `receipt-${receipts}`, event, taskId],
  );
}

type Call =
  | { method: "getTask"; id: bigint }
  | { method: "voidTask"; id: bigint }
  | { method: "cleanup"; id: bigint; limit: number | undefined };

/**
 * A chain that answers `views` (by task id, as text) for `getTask` and accepts every send, and the
 * calls it was made, in order. A hook runs after its call is recorded, and may throw to make the
 * call fail.
 */
function fakeChain(
  views: Record<string, { cleaned: number; commit_count: number }> = {},
  hooks: {
    getTask?: (id: bigint) => void | Promise<void>;
    voidTask?: (id: bigint) => void | Promise<void>;
    cleanup?: (id: bigint) => void | Promise<void>;
  } = {},
) {
  const calls: Call[] = [];
  const chain: KeeperChain = {
    getTask: async (id) => {
      calls.push({ method: "getTask", id });
      await hooks.getTask?.(id);
      return views[`${id}`] ?? null;
    },
    voidTask: async (id) => {
      calls.push({ method: "voidTask", id });
      await hooks.voidTask?.(id);
    },
    cleanup: async (id, limit) => {
      calls.push({ method: "cleanup", id, limit });
      await hooks.cleanup?.(id);
    },
  };
  return { chain, calls };
}

/** The ids `method` was called with, in order. */
const idsOf = (calls: Call[], method: Call["method"]) =>
  calls.filter((call) => call.method === method).map((call) => call.id);

function logger() {
  const lines: string[] = [];
  return { lines, log: (line: string) => void lines.push(line) };
}

/** A database that answers every statement with `rows` after `answer` has run. */
function stubDb(answer: (sql: string) => Promise<unknown>): Db {
  return {
    query: (async (sql: string) => {
      const rows = await answer(sql);
      return Array.isArray(rows) ? rows : [];
    }) as Db["query"],
    exec: async () => undefined,
    tx: async () => {
      throw new Error("the keeper opens no transaction");
    },
    close: async () => undefined,
  };
}

// ---- Types --------------------------------------------------------------------------------------

test("tender_client_satisfies_keeper_chain", () => {
  // Compiles only while `TenderClient` has the three methods, as the keeper calls them.
  const asChain = (client: TenderClient): KeeperChain => client;
  expect(asChain).toBeTypeOf("function");
});

// ---- Void ---------------------------------------------------------------------------------------

test("keeper_voids_a_task_with_no_reveals_from_its_reveal_deadline_on", async () => {
  await addTask({ id: 1, revealCount: 0 });

  const voidedAt = async (now: bigint) => {
    const { chain, calls } = fakeChain();
    const result = await keeperTick({ db, client: chain, now: () => now, log: () => {} });
    expect(result.voided).toEqual(idsOf(calls, "voidTask"));
    return idsOf(calls, "voidTask");
  };

  // The reveal window runs up to, but not including, the deadline: at it the judging window begins.
  expect(await voidedAt(REVEAL - 1n)).toEqual([]);
  expect(await voidedAt(REVEAL)).toEqual([1n]);
  expect(await voidedAt(REVEAL + 1n)).toEqual([1n]);
  expect(await voidedAt(LONG_AFTER)).toEqual([1n]);
});

test("keeper_voids_a_task_with_reveals_only_from_its_fallback_deadline_on", async () => {
  await addTask({ id: 1, revealCount: 1, commitCount: 1 });

  const voidedAt = async (now: bigint) => {
    const { chain, calls } = fakeChain();
    await keeperTick({ db, client: chain, now: () => now, log: () => {} });
    return idsOf(calls, "voidTask");
  };

  // With a reveal in, the judge's windows must run out first: the pick window, then the poster's.
  expect(await voidedAt(REVEAL)).toEqual([]);
  expect(await voidedAt(REVEAL + 10n * SECOND)).toEqual([]);
  expect(await voidedAt(FALLBACK - 1n)).toEqual([]);
  expect(await voidedAt(FALLBACK)).toEqual([1n]);
  expect(await voidedAt(FALLBACK + 1n)).toEqual([1n]);
});

test("keeper_does_not_void_a_task_that_has_an_outcome", async () => {
  await addTask({ id: 1, settled: { kind: "picked", at: REVEAL + 5n * SECOND } });
  await addTask({ id: 2, settled: { kind: "voided", at: REVEAL + 5n * SECOND } });
  const { chain, calls } = fakeChain();

  const result = await keeperTick({ db, client: chain, now: () => LONG_AFTER, log: () => {} });

  expect(result.voided).toEqual([]);
  expect(idsOf(calls, "voidTask")).toEqual([]);
});

test("keeper_voids_the_oldest_tasks_first", async () => {
  // In numbers, not in text: 9 comes before 10, which text puts first.
  for (const id of [100, 9, 2, 10]) await addTask({ id });
  const { chain, calls } = fakeChain();

  await keeperTick({ db, client: chain, now: () => LONG_AFTER, log: () => {} });

  expect(idsOf(calls, "voidTask")).toEqual([2n, 9n, 10n, 100n]);
});

// ---- Clean up -----------------------------------------------------------------------------------

test("keeper_cleans_a_settled_task_while_entries_are_left_and_never_after", async () => {
  const settled = { kind: "picked", at: REVEAL } as const;
  for (const id of [1, 2, 3, 4]) await addTask({ id, commitCount: 120, settled });
  const { chain, calls } = fakeChain({
    "1": { cleaned: 0, commit_count: 120 },
    "2": { cleaned: 50, commit_count: 120 },
    "3": { cleaned: 120, commit_count: 120 },
    // Task 4 is not on the chain: the index may be of another one.
  });
  const { lines, log } = logger();

  const result = await keeperTick({ db, client: chain, now: () => REVEAL + SECOND, log });

  // Each task is read first, and cleaned in batches of 50 only where entries are left.
  expect(calls).toEqual([
    { method: "getTask", id: 1n },
    { method: "cleanup", id: 1n, limit: 50 },
    { method: "getTask", id: 2n },
    { method: "cleanup", id: 2n, limit: 50 },
    { method: "getTask", id: 3n },
    { method: "getTask", id: 4n },
  ]);
  expect(result).toEqual({ voided: [], cleaned: [1n, 2n] });
  expect(lines).toEqual(["keeper: cleaned task 1", "keeper: cleaned task 2"]);
});

// ---- The 7 days ---------------------------------------------------------------------------------

test("keeper_reads_a_task_settled_up_to_7_days_ago_and_no_older_one", async () => {
  const S = REVEAL;
  await addTask({ id: 1, commitCount: 2, settled: { kind: "picked", at: S } });
  await addTask({ id: 2, commitCount: 2, settled: { kind: "voided", at: S } });
  const views = {
    "1": { cleaned: 0, commit_count: 2 },
    "2": { cleaned: 0, commit_count: 2 },
  };

  const readAt = async (now: bigint) => {
    const { chain, calls } = fakeChain(views);
    await keeperTick({ db, client: chain, now: () => now, log: () => {} });
    return idsOf(calls, "getTask");
  };

  // The window is the last 7 days, the moment 7 days back included.
  expect(await readAt(S)).toEqual([1n, 2n]);
  expect(await readAt(S + WEEK - 1n)).toEqual([1n, 2n]);
  expect(await readAt(S + WEEK)).toEqual([1n, 2n]);
  expect(await readAt(S + WEEK + 1n)).toEqual([]);
  expect(await readAt(S + 30n * WEEK)).toEqual([]);
});

test("keeper_dates_a_settlement_by_its_picked_or_voided_event", async () => {
  const now = 10n * WEEK;
  // Settled a day ago by a pick, but opened, committed to and topped up much earlier: only the
  // event that settled it says when.
  await addTask({ id: 1, commitCount: 1, settled: { kind: "picked", at: now - 86_400n * SECOND } });
  await addEvent(1, "task_created", now - 9n * WEEK);
  await addEvent(1, "committed", now - 8n * WEEK);
  // Settled 8 days ago, but an event of another kind, such as the attestation of a pick, came later.
  await addTask({
    id: 2,
    commitCount: 1,
    settled: { kind: "voided", at: now - 8n * 86_400n * SECOND },
  });
  await addEvent(2, "attested_pick", now - 86_400n * SECOND);
  // An outcome that no event of its own settled, such as one reconcile stored from the chain's view.
  await addTask({ id: 3, commitCount: 1 });
  await db.query("update tasks set outcome = $1 where id = 3", [
    JSON.stringify({ kind: "voided" }),
  ]);
  await addEvent(3, "committed", now - 86_400n * SECOND);
  const views = Object.fromEntries(
    [1, 2, 3].map((id) => [`${id}`, { cleaned: 0, commit_count: 1 }]),
  );
  const { chain, calls } = fakeChain(views);

  await keeperTick({ db, client: chain, now: () => now, log: () => {} });

  expect(idsOf(calls, "getTask")).toEqual([1n]);
  expect(idsOf(calls, "cleanup")).toEqual([1n]);
});

test("keeper_reads_the_task_settled_longest_ago_first", async () => {
  const S = REVEAL;
  await addTask({ id: 5, commitCount: 1, settled: { kind: "picked", at: S } });
  await addTask({ id: 4, commitCount: 1, settled: { kind: "picked", at: S + SECOND } });
  await addTask({ id: 6, commitCount: 1, settled: { kind: "voided", at: S + 2n * SECOND } });
  // Two settled at the same moment, such as in one block: the lower id first, as a number.
  await addTask({ id: 10, commitCount: 1, settled: { kind: "picked", at: S + 3n * SECOND } });
  await addTask({ id: 9, commitCount: 1, settled: { kind: "picked", at: S + 3n * SECOND } });
  const { chain, calls } = fakeChain();

  await keeperTick({ db, client: chain, now: () => S + 10n * SECOND, log: () => {} });

  // The one closest to leaving the window comes first, whatever its id.
  expect(idsOf(calls, "getTask")).toEqual([5n, 4n, 6n, 9n, 10n]);
});

test("keeper_finds_the_settlement_the_indexer_wrote", async () => {
  await seedLifecycle(db);
  const [event] = await db.query<{ at: string }>(
    "select block_ts::text as at from events where event = 'picked' and task_id = 1",
  );
  const at = BigInt(event?.at ?? "0");
  expect(at).toBeGreaterThan(0n);
  const views = { "1": { cleaned: 0, commit_count: 2 } };

  const run = async (now: bigint) => {
    const { chain, calls } = fakeChain(views);
    const result = await keeperTick({ db, client: chain, now: () => now, log: () => {} });
    return { result, calls };
  };

  const inside = await run(at + WEEK);
  expect(inside.calls).toEqual([
    { method: "getTask", id: 1n },
    { method: "cleanup", id: 1n, limit: 50 },
  ]);
  expect(inside.result.cleaned).toEqual([1n]);
  expect((await run(at + WEEK + 1n)).calls).toEqual([]);
});

// ---- The cap ------------------------------------------------------------------------------------

test("keeper_sends_at_most_10_voids_a_tick", async () => {
  for (let id = 1; id <= 12; id++) await addTask({ id });
  const { chain, calls } = fakeChain();

  const result = await keeperTick({ db, client: chain, now: () => LONG_AFTER, log: () => {} });

  expect(idsOf(calls, "voidTask")).toEqual([1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n]);
  expect(result.voided).toHaveLength(10);
  // The cap is spent, so the chain is not read for the cleanups either.
  expect(idsOf(calls, "getTask")).toEqual([]);

  // The next tick, when those have an outcome, takes the rest.
  await db.query('update tasks set outcome = \'{"kind":"voided"}\' where id <= 10');
  const next = fakeChain();
  await keeperTick({ db, client: next.chain, now: () => LONG_AFTER, log: () => {} });
  expect(idsOf(next.calls, "voidTask")).toEqual([11n, 12n]);
});

test("keeper_spends_what_the_voids_leave_of_the_10_actions_on_cleanups", async () => {
  for (const id of [1, 2, 3]) await addTask({ id });
  // 15 settled tasks, 3 of them clean already: reading a clean one is no action.
  const views: Record<string, { cleaned: number; commit_count: number }> = {};
  for (let id = 101; id <= 115; id++) {
    await addTask({
      id,
      commitCount: 2,
      settled: { kind: "picked", at: LONG_AFTER - BigInt(200 - id) * SECOND },
    });
    views[`${id}`] = { cleaned: id <= 103 ? 2 : 0, commit_count: 2 };
  }
  const { chain, calls } = fakeChain(views);

  const result = await keeperTick({ db, client: chain, now: () => LONG_AFTER, log: () => {} });

  expect(idsOf(calls, "voidTask")).toEqual([1n, 2n, 3n]);
  // 3 voids and 7 cleanups are the 10; the 8th is never read. The first three are read and skipped.
  expect(idsOf(calls, "cleanup")).toEqual([104n, 105n, 106n, 107n, 108n, 109n, 110n]);
  expect(idsOf(calls, "getTask")).toEqual([
    101n,
    102n,
    103n,
    104n,
    105n,
    106n,
    107n,
    108n,
    109n,
    110n,
  ]);
  expect(result.voided).toEqual([1n, 2n, 3n]);
  expect(result.cleaned).toHaveLength(7);
});

test("keeper_counts_an_action_that_failed_or_lost_the_race_against_the_cap", async () => {
  for (let id = 1; id <= 12; id++) await addTask({ id });
  const { chain, calls } = fakeChain(
    {},
    {
      voidTask: (id) => {
        throw id % 2n === 0n
          ? new TenderError("E_SETTLED", "settled")
          : new TenderError("E_AUTH", "no");
      },
    },
  );

  const result = await keeperTick({ db, client: chain, now: () => LONG_AFTER, log: () => {} });

  expect(idsOf(calls, "voidTask")).toHaveLength(10);
  expect(result.voided).toEqual([]);
});

// ---- Errors -------------------------------------------------------------------------------------

test("keeper_logs_a_lost_race_at_debug_and_goes_on", async () => {
  for (const id of [1, 2, 3]) await addTask({ id });
  await addTask({ id: 4, commitCount: 1, settled: { kind: "picked", at: LONG_AFTER } });
  const { chain, calls } = fakeChain(
    { "4": { cleaned: 0, commit_count: 1 } },
    {
      voidTask: (id) => {
        if (id === 1n) throw new TenderError("E_SETTLED", "Smart contract panicked: E_SETTLED: 1");
        if (id === 2n) throw new TenderError("E_PHASE", "Smart contract panicked: E_PHASE: 2");
      },
      cleanup: () => {
        throw new TenderError("E_PHASE", "Smart contract panicked: E_PHASE: not settled");
      },
    },
  );
  const { lines, log } = logger();

  const result = await keeperTick({ db, client: chain, now: () => LONG_AFTER, log });

  // The tick went on to task 3 and to the cleanup of task 4.
  expect(idsOf(calls, "voidTask")).toEqual([1n, 2n, 3n]);
  expect(idsOf(calls, "cleanup")).toEqual([4n]);
  expect(result).toEqual({ voided: [3n], cleaned: [] });
  expect(lines).toEqual([
    "DEBUG keeper: void_task task 1 lost the race (E_SETTLED)",
    "DEBUG keeper: void_task task 2 lost the race (E_PHASE)",
    "keeper: voided task 3",
    "DEBUG keeper: cleanup task 4 lost the race (E_PHASE)",
  ]);
});

test("keeper_logs_any_other_failure_by_name_and_code_alone_and_goes_on", async () => {
  for (let id = 1; id <= 6; id++) await addTask({ id });
  const url = "https://rpc.example.invalid/?apiKey=SECRET-KEY-123";
  const failures: Record<string, unknown> = {
    // The chain's own refusal: the contract's code is the whole story.
    "1": new TenderError("E_AUTH", `Smart contract panicked: E_AUTH: ${url}`),
    // An error of the network stack, whose message quotes the URL it asked.
    "2": Object.assign(new TypeError(`fetch failed: ${url}`), { code: "ECONNREFUSED" }),
    // An error with no code, and one whose code is no code.
    "3": new Error(`request to ${url} failed`),
    "4": Object.assign(new Error(url), { code: url }),
    // A thing that is no error at all.
    "5": `rejected with ${url}`,
  };
  const { chain, calls } = fakeChain(
    {},
    {
      voidTask: (id) => {
        if (`${id}` in failures) throw failures[`${id}`];
      },
    },
  );
  const { lines, log } = logger();

  const result = await keeperTick({ db, client: chain, now: () => LONG_AFTER, log });

  expect(idsOf(calls, "voidTask")).toEqual([1n, 2n, 3n, 4n, 5n, 6n]);
  expect(result.voided).toEqual([6n]);
  expect(lines).toEqual([
    "ERROR keeper: void_task task 1 failed (TenderError E_AUTH)",
    "ERROR keeper: void_task task 2 failed (TypeError ECONNREFUSED)",
    "ERROR keeper: void_task task 3 failed (Error)",
    "ERROR keeper: void_task task 4 failed (Error)",
    "ERROR keeper: void_task task 5 failed (string)",
    "keeper: voided task 6",
  ]);
  expect(lines.join("\n")).not.toMatch(/rpc\.example|SECRET|apiKey/);
});

test("keeper_logs_a_failed_read_and_reads_the_next_task", async () => {
  const settled = { kind: "picked", at: REVEAL } as const;
  for (const id of [1, 2]) await addTask({ id, commitCount: 1, settled });
  const { chain, calls } = fakeChain(
    { "2": { cleaned: 0, commit_count: 1 } },
    {
      getTask: (id) => {
        if (id === 1n) {
          const message = "https://rpc.example.invalid/?k=SECRET";
          throw Object.assign(new Error(message), { code: "ETIMEDOUT" });
        }
      },
    },
  );
  const { lines, log } = logger();

  const result = await keeperTick({ db, client: chain, now: () => REVEAL + SECOND, log });

  expect(idsOf(calls, "getTask")).toEqual([1n, 2n]);
  expect(result.cleaned).toEqual([2n]);
  expect(lines).toEqual([
    "ERROR keeper: get_task task 1 failed (Error ETIMEDOUT)",
    "keeper: cleaned task 2",
  ]);
});

test("keeper_sends_nothing_more_once_the_signal_aborts", async () => {
  for (const id of [1, 2, 3]) await addTask({ id });
  const controller = new AbortController();
  const { chain, calls } = fakeChain(
    {},
    {
      voidTask: (id) => {
        if (id === 2n) controller.abort();
      },
    },
  );

  const result = await keeperTick({
    db,
    client: chain,
    now: () => LONG_AFTER,
    log: () => {},
    signal: controller.signal,
  });

  expect(idsOf(calls, "voidTask")).toEqual([1n, 2n]);
  expect(result.voided).toEqual([1n, 2n]);
});

// ---- The clock and the log ----------------------------------------------------------------------

test("keeper_reads_the_wall_clock_in_nanoseconds_unless_it_is_given_a_clock", async () => {
  // A deadline a minute ago has passed and one an hour on has not, if the clock reads nanoseconds:
  // in milliseconds, or microseconds, both would lie far ahead of it.
  const nowNs = BigInt(Date.now()) * 1_000_000n;
  const fallback = nowNs + 3_600n * SECOND;
  await addTask({ id: 1, revealDeadline: nowNs - 60n * SECOND, fallbackDeadline: fallback });
  await addTask({ id: 2, revealDeadline: nowNs + 3_600n * SECOND, fallbackDeadline: fallback });
  const { chain, calls } = fakeChain();

  await keeperTick({ db, client: chain, log: () => {} });

  expect(idsOf(calls, "voidTask")).toEqual([1n]);
});

test("keeper_logs_to_the_console_unless_it_is_given_a_log", async () => {
  await addTask({ id: 1 });
  const out = vi.spyOn(console, "log").mockImplementation(() => {});
  const { chain } = fakeChain();

  await keeperTick({ db, client: chain, now: () => LONG_AFTER });

  expect(out).toHaveBeenCalledWith("keeper: voided task 1");
});

// ---- startKeeper --------------------------------------------------------------------------------

/** The chain of the loop tests: it is never asked anything, since their database has no tasks. */
const idleChain = fakeChain().chain;

test("start_keeper_ticks_at_the_interval_after_the_last_tick_ends_and_never_overlaps", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const asked: number[] = [];
  let running = 0;
  let peak = 0;
  const slow = stubDb(async () => {
    running += 1;
    peak = Math.max(peak, running);
    asked.push(Date.now());
    // A tick asks twice (for the voids, then for the settled tasks), so it takes 500 ms in all.
    await new Promise((resolve) => setTimeout(resolve, 250));
    running -= 1;
  });
  const t0 = Date.now();

  const done = startKeeper({
    db: slow,
    client: idleChain,
    intervalMs: 100,
    signal: controller.signal,
    log: () => {},
  });
  await vi.advanceTimersByTimeAsync(1_500);

  // A tick at once; the next 100 ms after the first ended, at 500 ms; the next 100 ms after that.
  expect(asked.map((at) => at - t0)).toEqual([0, 250, 600, 850, 1_200, 1_450]);
  expect(peak).toBe(1);
  controller.abort();
  await vi.advanceTimersByTimeAsync(1_000);
  await done;
});

test("start_keeper_ticks_every_30_seconds_unless_it_is_given_an_interval", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  let asked = 0;
  const counting = stubDb(async () => {
    asked += 1;
  });
  /** An idle tick asks twice. */
  const ticks = () => asked / 2;

  const done = startKeeper({
    db: counting,
    client: idleChain,
    signal: controller.signal,
    log: () => {},
  });
  await vi.advanceTimersByTimeAsync(29_999);
  expect(ticks()).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(ticks()).toBe(2);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(ticks()).toBe(3);

  controller.abort();
  await done;
});

test("start_keeper_logs_a_tick_that_throws_and_ticks_again", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  let asked = 0;
  const flaky = stubDb(async () => {
    asked += 1;
    if (asked === 1) {
      // The driver's error, whose message quotes the connection string.
      const message = "connect ECONNREFUSED postgres://user:hunter2@db.example/tender";
      throw Object.assign(new Error(message), { code: "ECONNREFUSED" });
    }
  });
  const { lines, log } = logger();

  const done = startKeeper({
    db: flaky,
    client: idleChain,
    intervalMs: 1_000,
    signal: controller.signal,
    log,
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(lines).toEqual(["ERROR keeper: tick failed (Error ECONNREFUSED)"]);
  expect(asked).toBe(1);

  // It carries on: the second tick asks twice and finds nothing to do.
  await vi.advanceTimersByTimeAsync(1_000);
  expect(asked).toBe(3);
  expect(lines).toHaveLength(1);

  controller.abort();
  await done;
});

test("start_keeper_asks_with_the_clock_it_is_given", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const params: unknown[][] = [];
  const recording: Db = {
    ...stubDb(async () => undefined),
    query: (async (_sql: string, values: unknown[] = []) => {
      params.push(values);
      return [];
    }) as Db["query"],
  };

  const done = startKeeper({
    db: recording,
    client: idleChain,
    intervalMs: 1_000,
    now: () => 42n,
    signal: controller.signal,
    log: () => {},
  });
  await vi.advanceTimersByTimeAsync(0);

  // The statements ask about the injected clock, not the wall clock.
  expect(params[0]?.[0]).toBe(42n);
  controller.abort();
  await done;
});

test("start_keeper_stops_and_resolves_when_the_signal_aborts_while_it_waits", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const done = startKeeper({
    db: stubDb(async () => undefined),
    client: idleChain,
    intervalMs: 1_000,
    signal: controller.signal,
    log: () => {},
  });
  await vi.advanceTimersByTimeAsync(10);
  expect(vi.getTimerCount()).toBe(1);

  controller.abort();

  await done;
  expect(vi.getTimerCount()).toBe(0);
});

test("start_keeper_finishes_the_tick_in_hand_before_it_resolves", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let asked = 0;
  const blocked = stubDb(async () => {
    asked += 1;
    await gate;
  });
  let resolved = false;
  const done = startKeeper({
    db: blocked,
    client: idleChain,
    intervalMs: 100,
    signal: controller.signal,
    log: () => {},
  });
  void done.then(() => {
    resolved = true;
  });
  await vi.advanceTimersByTimeAsync(10);

  controller.abort();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(resolved).toBe(false);

  release();
  await done;
  // The tick ended at its next look at the signal, and no timer is left behind.
  expect(asked).toBe(1);
  expect(vi.getTimerCount()).toBe(0);
});

test("start_keeper_does_not_tick_when_the_signal_is_aborted_already", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  controller.abort();
  let asked = 0;
  const counting = stubDb(async () => {
    asked += 1;
  });

  await startKeeper({ db: counting, client: idleChain, signal: controller.signal, log: () => {} });

  expect(asked).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

test("start_keeper_refuses_an_interval_that_setTimeout_cannot_keep", () => {
  const signal = new AbortController().signal;
  const start = (intervalMs: number) => () =>
    startKeeper({ db: stubDb(async () => undefined), client: idleChain, intervalMs, signal });

  // 0 would spin; NaN and a negative are no time; setTimeout runs anything above 2^31 - 1 ms at 1 ms.
  for (const intervalMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
    expect(start(intervalMs), String(intervalMs)).toThrow(/intervalMs/);
  }
});
