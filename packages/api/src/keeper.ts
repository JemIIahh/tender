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

/** The two chores of the keeper, as the memory and the log name them. */
type Chore = "void_task" | "cleanup";

/**
 * How many ticks a task whose call failed is left alone for: the first time the contract refuses
 * it, and every time it fails in another way.
 */
const SKIP_TICKS = 10;
/** The most ticks it is left alone for as the contract keeps refusing it: a day at 30 s a tick. */
const MAX_SKIP_TICKS = 2880;

/** A chore that failed for a task: how often the contract refused it, and when it is retried. */
interface Failure {
  chore: Chore;
  id: bigint;
  /**
   * How many times the contract has refused the chore since it last went through. A failure of
   * another kind does not count, and does not reset the count either.
   */
  refusals: number;
  /** The first tick at which the chore is tried again. */
  retryAt: number;
}

/**
 * What the keeper keeps from one tick to the next, so that it does not spend its reads and its 10
 * actions again on what it has seen to be final, or to be stuck:
 *
 * - a settled task found with nothing left to clean stays so, since a settled task takes no more
 *   entries: it is not read again;
 * - a task whose `void_task` lost with `E_SETTLED` is settled on the chain for good, however long
 *   the index takes to show it: it is not tried again;
 * - a task whose `void_task` or `cleanup` the contract refused, other than by a lost race, or which
 *   the chain says it does not have, is left alone for the next 10 ticks. Each time the contract
 *   refuses the same chore again the wait doubles, up to 2880 ticks (a day at 30 s), and it is 10
 *   again once the chore goes through. Otherwise tasks that the chain keeps refusing, such as the
 *   rows of another deployment's index, would take every slot of every tick and leave none for the
 *   rest;
 * - a task whose call or read failed in any other way, such as a node that cannot be reached or a
 *   transaction that has not finished, is left alone for the next 10 ticks, however often that
 *   happens, and the wait that refusals built up stays as it was. That says nothing of the task:
 *   after an outage every task is back within about 10 ticks.
 *
 * It holds something only for tasks the index still lists (`forget`), so it does not grow with
 * every task that ever failed or was found clean. `startKeeper` keeps one for the whole run. A tick
 * that is given none remembers nothing.
 */
export class KeeperMemory {
  private ticks = 0;
  /** The settled tasks found with nothing left to clean. */
  private readonly clean = new Set<bigint>();
  /** The tasks that `void_task` found settled. */
  private readonly settled = new Set<bigint>();
  private readonly failures = new Map<string, Failure>();

  /** Starts a tick: counts it. */
  begin(): void {
    this.ticks += 1;
  }

  /** How many tasks it holds something for. */
  get size(): number {
    return this.clean.size + this.settled.size + this.failures.size;
  }

  /** Whether `chore` is left alone for the task now: it is known to be done, or it failed lately. */
  isLeftAlone(chore: Chore, id: bigint): boolean {
    if ((chore === "cleanup" ? this.clean : this.settled).has(id)) return true;
    const failure = this.failures.get(`${chore} ${id}`);
    return failure !== undefined && failure.retryAt > this.ticks;
  }

  /** How many tasks `chore` is left alone for now. */
  leftAlone(chore: Chore): number {
    let count = (chore === "cleanup" ? this.clean : this.settled).size;
    for (const failure of this.failures.values()) {
      if (failure.chore === chore && failure.retryAt > this.ticks) count += 1;
    }
    return count;
  }

  /** The settled task has nothing left to clean, and never will. */
  foundClean(id: bigint): void {
    this.clean.add(id);
    this.failures.delete(`cleanup ${id}`);
  }

  /** `void_task` found the task settled: it stays so. */
  foundSettled(id: bigint): void {
    this.settled.add(id);
    this.failures.delete(`void_task ${id}`);
  }

  /** The chore went through: if it fails later, the wait starts from 10 ticks again. */
  succeeded(chore: Chore, id: bigint): void {
    this.failures.delete(`${chore} ${id}`);
  }

  /**
   * The contract refused the chore, or says it has no such task: the task is left alone twice as
   * long as the last time it was refused, from 10 ticks up to 2880.
   */
  refused(chore: Chore, id: bigint): void {
    const key = `${chore} ${id}`;
    const refusals = (this.failures.get(key)?.refusals ?? 0) + 1;
    const skip = Math.min(SKIP_TICKS * 2 ** (refusals - 1), MAX_SKIP_TICKS);
    this.failures.set(key, { chore, id, refusals, retryAt: this.ticks + skip + 1 });
  }

  /**
   * The chore, or the read for it, failed in a way that says nothing of the task, such as a node
   * that cannot be reached: the task is left alone for 10 ticks, however often that happens. What
   * refusals have counted is kept as it was.
   */
  failed(chore: Chore, id: bigint): void {
    const key = `${chore} ${id}`;
    const refusals = this.failures.get(key)?.refusals ?? 0;
    this.failures.set(key, { chore, id, refusals, retryAt: this.ticks + SKIP_TICKS + 1 });
  }

  /**
   * Forgets what it holds of the tasks of `chore` that a listing of the index no longer has: they
   * left the window, or were settled. `listed` is the whole listing when `upTo` is left out, and
   * otherwise the listing as far as task `upTo`, which a limit cut short: a task beyond it may
   * still be listed, so it is kept.
   */
  forget(chore: Chore, listed: readonly bigint[], upTo?: bigint): void {
    const present = new Set(listed);
    const gone = (id: bigint) => !present.has(id) && (upTo === undefined || id <= upTo);
    const known = chore === "cleanup" ? this.clean : this.settled;
    for (const id of known) {
      if (gone(id)) known.delete(id);
    }
    for (const [key, failure] of this.failures) {
      if (failure.chore === chore && gone(failure.id)) this.failures.delete(key);
    }
  }
}

export interface KeeperTickOptions {
  /** The index, which says which tasks to look at. */
  db: Db;
  client: KeeperChain;
  /** The current time in nanoseconds since the epoch. Default: the wall clock. */
  now?: () => bigint;
  /**
   * Receives the keeper's lines. `DEBUG` lines are lost races, `ERROR` lines are failures; the rest
   * say what the keeper did. Default: `console.log`. A `log` that throws is ignored: the keeper
   * has nowhere else to say so, and its work comes first.
   */
  log?: (message: string) => void;
  /** Ends the tick before its next call to the chain once it aborts. */
  signal?: AbortSignal;
  /**
   * What the keeper remembers between ticks; see `KeeperMemory`. `startKeeper` makes one if it is
   * not given one. Without it, a tick starts from nothing: it cannot leave alone what failed in the
   * ticks before, so tasks that always fail at the head of its queue are tried again each time.
   */
  memory?: KeeperMemory;
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
/** How many reads that fail in a row end the reading of a tick: the chain is likely down. */
const MAX_FAILED_READS = 3;
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
 * A `log` that cannot throw. The keeper writes a line after each call it makes, and a sink that
 * fails must not cost it the rest of its tick, or the loop that runs the ticks.
 */
function quiet(log: (message: string) => void): (message: string) => void {
  return (message) => {
    try {
      log(message);
    } catch {
      // There is nowhere left to say so.
    }
  };
}

/**
 * How a call went: it went through; another caller got there first (`settled` when the task is
 * settled, which is final; `lost` when the phase had changed, which may not stay so); the contract
 * refused it (`refused`); or it failed in another way (`failed`), which says nothing of the task.
 */
type Attempt = "sent" | "lost" | "settled" | "refused" | "failed";

/**
 * Whether `error`, which is not a lost race, is the contract refusing the call: a `TenderError`,
 * which the client throws for a transaction that failed on chain, whose code names a refusal.
 * `E_UNKNOWN` is no such code: it is what the client calls a transaction that has no final outcome
 * yet (the RPC's doing), and a failure whose text it does not know. Nor is anything thrown before
 * the transaction ran, by near-api-js or the network: a timeout, a refused connection, a 5xx.
 */
function isRefusal(error: unknown): boolean {
  return error instanceof TenderError && error.code !== "E_UNKNOWN";
}

/**
 * Sends one call. A lost race is logged at debug level and any other failure as an error; neither
 * stops the tick.
 */
async function attempt(
  log: (message: string) => void,
  method: Chore,
  id: bigint,
  send: () => Promise<unknown>,
): Promise<Attempt> {
  try {
    await send();
    return "sent";
  } catch (error) {
    if (error instanceof TenderError && LOST_RACE.has(error.code)) {
      log(`DEBUG keeper: ${method} task ${id} lost the race (${error.code})`);
      return error.code === "E_SETTLED" ? "settled" : "lost";
    }
    log(`ERROR keeper: ${method} task ${id} failed (${describe(error)})`);
    return isRefusal(error) ? "refused" : "failed";
  }
}

/**
 * The tasks without an outcome that `void_task` voids at `now`, oldest first, at most `limit`:
 * those whose reveal deadline has passed with nothing revealed, and those whose fallback deadline
 * has passed. These are the contract's own rules (`void_task` in settle.rs). At a deadline itself
 * the next window has begun, so a deadline that equals `now` has passed.
 */
async function expiredTasks(db: Db, now: bigint, limit: number): Promise<bigint[]> {
  const rows = await db.query<{ id: string }>(
    // `t.id` in the order: a bare `id` there is the output column, which is text.
    `select t.id::text as id
       from tasks t
      where t.outcome is null
        and (($1::numeric >= t.reveal_deadline and t.reveal_count = 0)
             or $1::numeric >= t.fallback_deadline)
      order by t.id
      limit $2`,
    [now, limit],
  );
  return rows.map((row) => BigInt(row.id));
}

/**
 * The tasks that took entries and were settled no longer than 7 days before `now`, the one settled
 * longest ago first. A task is settled when its `picked` or `voided` event is, and its date is that
 * event's block time: the task row has no date for it. That time has a lower bound, `now` less 7
 * days, and no upper one. A task whose outcome no event of its own explains, such as one reconcile
 * stored from the chain's view, has no date and is not among them. A task that took no entries
 * has nothing to clean.
 */
async function settledTasks(db: Db, now: bigint): Promise<bigint[]> {
  const rows = await db.query<{ id: string }>(
    `select t.id::text as id
       from tasks t
       join events e on e.task_id = t.id and e.event in ('picked', 'voided')
      where t.outcome is not null
        and t.commit_count > 0
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
 * - with what is left of the 10, `cleanup` (50 entries) for each task that took entries and was
 *   settled in the last 7 days, whose chain view says `cleaned < commit_count`, the one settled
 *   longest ago first. The chain is read for each of them first, since the index does not hold
 *   `cleaned`; a read is not one of the 10. Three reads that fail in a row end the reading for the
 *   tick: if the chain is down, every read would fail the same way, and log a line of its own.
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
 * With a `memory` (as `startKeeper` runs it) a task found with nothing left to clean is not read
 * again, and a task whose void lost with `E_SETTLED` is not voided again. A task whose call or read
 * failed, other than by a lost race, is left alone for the next 10 ticks. It is left alone for
 * twice as long each time the contract refuses the same call again (see `KeeperMemory`), so that
 * tasks the chain keeps refusing cannot hold every slot; a failure of the node or the network
 * keeps it at 10, so that after an outage every task is back within about 10 ticks. Without a
 * `memory` a tick is for a one-off run; a long run should pass one (`startKeeper` does).
 *
 * Rejects only when the index cannot be read. Pass `signal` to have it end before its next call.
 */
export async function keeperTick(opts: KeeperTickOptions): Promise<KeeperTickResult> {
  const { db, client, signal } = opts;
  const log = quiet(opts.log ?? console.log);
  const memory = opts.memory ?? new KeeperMemory();
  const now = nowNs(opts);
  const result: KeeperTickResult = { voided: [], cleaned: [] };
  let actions = 0;
  const roomLeft = () => actions < MAX_ACTIONS && signal?.aborted !== true;
  memory.begin();
  if (!roomLeft()) return result;

  // A task that is left alone takes a row of the result and no action, so ask for that many rows
  // more: 10 that are not left alone are in it, however many are.
  const limit = MAX_ACTIONS + memory.leftAlone("void_task");
  const expired = await expiredTasks(db, now, limit);
  // The rows are the lowest ids that are expired: every id below the last one is among them. A task
  // that was left alone and is not among them has been settled in the index, and is forgotten.
  memory.forget("void_task", expired, expired.length < limit ? undefined : expired.at(-1));
  for (const id of expired) {
    if (memory.isLeftAlone("void_task", id)) continue;
    if (!roomLeft()) return result;
    actions += 1;
    const sent = await attempt(log, "void_task", id, () => client.voidTask(id));
    if (sent === "sent") {
      memory.succeeded("void_task", id);
      result.voided.push(id);
      log(`keeper: voided task ${id}`);
    } else if (sent === "settled") {
      // The index will say so in time; until then the task is not tried again.
      memory.foundSettled(id);
    } else if (sent === "refused") {
      memory.refused("void_task", id);
    } else if (sent === "failed") {
      memory.failed("void_task", id);
    }
  }

  if (!roomLeft()) return result;
  const settled = await settledTasks(db, now);
  memory.forget("cleanup", settled);
  let failedReads = 0;
  for (const id of settled) {
    if (!roomLeft()) return result;
    if (memory.isLeftAlone("cleanup", id)) continue;
    let view: Awaited<ReturnType<KeeperChain["getTask"]>>;
    try {
      view = await client.getTask(id);
    } catch (error) {
      log(`ERROR keeper: get_task task ${id} failed (${describe(error)})`);
      memory.failed("cleanup", id);
      failedReads += 1;
      if (failedReads === MAX_FAILED_READS) break;
      continue;
    }
    failedReads = 0;
    if (view === null) {
      // The chain's own answer that it has no such task, as it would give a call: a refusal.
      memory.refused("cleanup", id);
      continue;
    }
    if (view.cleaned >= view.commit_count) {
      memory.foundClean(id);
      continue;
    }
    actions += 1;
    const sent = await attempt(log, "cleanup", id, () => client.cleanup(id, CLEANUP_BATCH));
    if (sent === "sent") {
      memory.succeeded("cleanup", id);
      result.cleaned.push(id);
      log(`keeper: cleaned task ${id}`);
    } else if (sent === "refused") {
      memory.refused("cleanup", id);
    } else if (sent === "failed") {
      memory.failed("cleanup", id);
    }
  }
  return result;
}

/**
 * Starts the keeper and returns at once. It runs `keeperTick` now, and again `intervalMs` (default
 * 30 s) after each tick ends, so ticks never overlap and a slow chain only slows the keeper down.
 * A tick that throws, which it does only when the index cannot be read, is logged as an error and
 * the keeper goes on. So does a `log` that throws: nothing a tick or the log does stops the loop,
 * short of the signal.
 *
 * The keeper has a `KeeperMemory` for the whole run (the one in `opts.memory`, if it is given).
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
  const log = quiet(opts.log ?? console.log);
  const memory = opts.memory ?? new KeeperMemory();

  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      timer = undefined;
      try {
        await keeperTick({ ...opts, log, signal, memory });
      } catch (error) {
        log(`ERROR keeper: tick failed (${describe(error)})`);
      } finally {
        // Whatever the tick did, the loop is left with a timer or with its end, never with neither.
        if (signal.aborted) resolve();
        else timer = setTimeout(tick, intervalMs);
      }
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
