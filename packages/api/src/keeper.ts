import { TenderError } from "@tender/client";
import type { Db } from "@tender/db";
import type { TaskView } from "@tender/shared";
import { nowNs } from "./deps";

// The keeper does the two chores of the contract that anyone may do and nobody is paid for:
// `void_task` on a task that ran out its windows, which refunds its funders, and `cleanup` on a
// settled task, which refunds the entrants the storage of their entries. It reads the index to
// find the tasks, and the chain to decide, since the index does not know what `cleanup` removed.

/**
 * What the keeper does on the chain. `TenderClient` has all three and satisfies this interface;
 * tests pass a fake, so the keeper type-checks and runs without a chain (X-12).
 */
export interface KeeperChain {
  /** The task as of the last final block, or null when the chain has none. */
  getTask(id: bigint): Promise<Pick<TaskView, "cleaned" | "commit_count"> | null>;
  /** Sends `void_task`. */
  voidTask(id: bigint): Promise<unknown>;
  /** Sends `cleanup` for the next `limit` (1 to 50) entries. */
  cleanup(id: bigint, limit?: number): Promise<unknown>;
}

export interface KeeperTickOptions {
  /** The index, which says which tasks to look at. */
  db: Db;
  client: KeeperChain;
  /** The current time in nanoseconds since the epoch. Default: the wall clock. */
  now?: () => bigint;
  /**
   * Receives the keeper's lines. `DEBUG` lines are lost races, `ERROR` lines are failures; the rest
   * say what the keeper did. Default: `console.log`.
   */
  log?: (message: string) => void;
  /** Ends the tick before its next call to the chain once it aborts. */
  signal?: AbortSignal;
}

export interface StartKeeperOptions extends KeeperTickOptions {
  /** How long to wait after a tick ends before the next one starts. Default 30 s. */
  intervalMs?: number;
  /** Stops the keeper once the tick in hand is done. */
  signal: AbortSignal;
}

/** What a tick did: the tasks its `void_task` and its `cleanup` calls went through for. */
export interface KeeperTickResult {
  voided: bigint[];
  cleaned: bigint[];
}

/** The most calls to the chain, `void_task` and `cleanup`, that one tick sends. */
const MAX_ACTIONS = 10;
/** The entries one `cleanup` call goes through: the most the contract allows (`MAX_PAGE`). */
const CLEANUP_BATCH = 50;
/** How far back a settlement still gets its entries cleaned: 7 days, in nanoseconds. */
const CLEANUP_WINDOW_NS = 7n * 24n * 3_600n * 1_000_000_000n;
const DEFAULT_INTERVAL_MS = 30_000;
/** The longest wait `setTimeout` keeps: it runs anything above this after 1 ms instead. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * The codes that say another caller got there first, which is no failure of the keeper's: the task
 * was settled in the meantime (`E_SETTLED` from `void_task`), or it is not in the phase the index
 * had it in (`E_PHASE`, from either call). Whoever won did what the keeper meant to.
 */
const LOST_RACE = new Set(["E_SETTLED", "E_PHASE"]);

/** What a code looks like, the contract's (`E_AUTH`) or Node's (`ECONNREFUSED`). */
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * What a log line says of an error: its name and, if it has one, its code. Never its message,
 * which can quote the RPC's URL, and a URL can hold a key (P03-R16). A code that does not look like
 * one is dropped too, since a foreign error may put anything there.
 */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && CODE.test(code) ? `${error.name} ${code}` : error.name;
}

/**
 * Sends one call. Returns whether it went through. A lost race is logged at debug level and any
 * other failure as an error; neither stops the tick.
 */
async function attempt(
  log: (message: string) => void,
  method: string,
  id: bigint,
  send: () => Promise<unknown>,
): Promise<boolean> {
  try {
    await send();
    return true;
  } catch (error) {
    if (error instanceof TenderError && LOST_RACE.has(error.code)) {
      log(`DEBUG keeper: ${method} task ${id} lost the race (${error.code})`);
    } else {
      log(`ERROR keeper: ${method} task ${id} failed (${describe(error)})`);
    }
    return false;
  }
}

/**
 * The tasks without an outcome that `void_task` voids at `now`, oldest first: those whose reveal
 * deadline has passed with nothing revealed, and those whose fallback deadline has passed. These
 * are the contract's own rules (`void_task` in settle.rs). At a deadline itself the next window has
 * begun, so a deadline that equals `now` has passed.
 */
async function expiredTasks(db: Db, now: bigint): Promise<bigint[]> {
  const rows = await db.query<{ id: string }>(
    // `t.id` in the order: a bare `id` there is the output column, which is text.
    `select t.id::text as id
       from tasks t
      where t.outcome is null
        and (($1::numeric >= t.reveal_deadline and t.reveal_count = 0)
             or $1::numeric >= t.fallback_deadline)
      order by t.id
      limit $2`,
    [now, MAX_ACTIONS],
  );
  return rows.map((row) => BigInt(row.id));
}

/**
 * The tasks settled in the last 7 days up to `now`, the one settled longest ago first. A task is
 * settled when its `picked` or `voided` event is, and its date is that event's block time: the task
 * row has no date for it. A task whose outcome no event of its own explains, such as one reconcile
 * stored from the chain's view, has no date and is not among them.
 */
async function settledTasks(db: Db, now: bigint): Promise<bigint[]> {
  const rows = await db.query<{ id: string }>(
    `select t.id::text as id
       from tasks t
       join events e on e.task_id = t.id and e.event in ('picked', 'voided')
      where t.outcome is not null
        and e.block_ts >= $1::numeric
      group by t.id
      order by min(e.block_ts), t.id`,
    [now - CLEANUP_WINDOW_NS],
  );
  return rows.map((row) => BigInt(row.id));
}

/**
 * Runs one pass of the keeper, and returns what it did. It sends at most 10 calls to the chain:
 *
 * - `void_task` for each task without an outcome in the index whose reveal deadline has passed
 *   with nothing revealed, or whose fallback deadline has passed, the oldest first;
 * - with what is left of the 10, `cleanup` (50 entries) for each task settled in the last 7 days
 *   whose chain view says `cleaned < commit_count`, the one settled longest ago first. The chain is
 *   read for each of them first, since the index does not hold `cleaned`; a read is not one of the
 *   10, and a task with nothing left to clean costs only that.
 *
 * A call that fails does not stop the tick, and counts against the 10. `E_SETTLED` and `E_PHASE`
 * mean another caller got there first and are logged at debug level; any other failure, a failed
 * read included, is logged as an error. A line names an error and never quotes its message, which
 * can hold a URL, and so a key (P03-R16).
 *
 * The index trails the chain, so it can show a task as unsettled that someone settled a moment ago:
 * the call then loses the race, which costs one of the 10 and no more. A task whose settlement the
 * index never saw, because it started after it, is not cleaned; nor is one settled more than 7 days
 * ago, so a task with more entries than 7 days of ticks can clean is left with the rest.
 *
 * Rejects only when the index cannot be read. Pass `signal` to have it end before its next call.
 */
export async function keeperTick(opts: KeeperTickOptions): Promise<KeeperTickResult> {
  const { db, client, signal } = opts;
  const log = opts.log ?? console.log;
  const now = nowNs(opts);
  const result: KeeperTickResult = { voided: [], cleaned: [] };
  let actions = 0;
  const roomLeft = () => actions < MAX_ACTIONS && signal?.aborted !== true;
  if (!roomLeft()) return result;

  for (const id of await expiredTasks(db, now)) {
    if (!roomLeft()) return result;
    actions += 1;
    if (await attempt(log, "void_task", id, () => client.voidTask(id))) {
      result.voided.push(id);
      log(`keeper: voided task ${id}`);
    }
  }

  if (!roomLeft()) return result;
  for (const id of await settledTasks(db, now)) {
    if (!roomLeft()) return result;
    let view: Awaited<ReturnType<KeeperChain["getTask"]>>;
    try {
      view = await client.getTask(id);
    } catch (error) {
      log(`ERROR keeper: get_task task ${id} failed (${describe(error)})`);
      continue;
    }
    if (view === null || view.cleaned >= view.commit_count) continue;
    actions += 1;
    if (await attempt(log, "cleanup", id, () => client.cleanup(id, CLEANUP_BATCH))) {
      result.cleaned.push(id);
      log(`keeper: cleaned task ${id}`);
    }
  }
  return result;
}

/**
 * Starts the keeper and returns at once. It runs `keeperTick` now, and again `intervalMs` (default
 * 30 s) after each tick ends, so ticks never overlap and a slow chain only slows the keeper down.
 * A tick that throws, which it does only when the index cannot be read, is logged as an error and
 * the keeper goes on.
 *
 * The returned promise resolves once `signal` has aborted and the tick in hand is done: that tick
 * sends nothing more after the abort. It never rejects. It throws at once, not by rejecting, for an
 * `intervalMs` that `setTimeout` cannot keep.
 */
export function startKeeper(opts: StartKeeperOptions): Promise<void> {
  const { signal } = opts;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs < 1 || intervalMs > MAX_TIMEOUT_MS) {
    throw new RangeError(`intervalMs must be from 1 to ${MAX_TIMEOUT_MS} milliseconds`);
  }
  const log = opts.log ?? console.log;

  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      timer = undefined;
      try {
        await keeperTick({ ...opts, log, signal });
      } catch (error) {
        log(`ERROR keeper: tick failed (${describe(error)})`);
      }
      if (signal.aborted) resolve();
      else timer = setTimeout(tick, intervalMs);
    };
    signal.addEventListener(
      "abort",
      () => {
        // While a tick is in hand there is no timer: the tick resolves at its end.
        if (timer === undefined) return;
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    if (signal.aborted) resolve();
    else void tick();
  });
}
