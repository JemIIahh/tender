import { phaseAt } from "@tender/shared";
import { intakeTask } from "./intake";
import { WarmWorker } from "./isolate";
import { clearStaleWaits, describeError, judgeTask, stopLineOf } from "./judge";
import type { JudgeDeps, JudgeMemory } from "./types";

/** How long `startJudge` waits after a tick before the next one starts, by default. */
const DEFAULT_INTERVAL_MS = 10_000;
const NS_PER_MS = 1_000_000n;

/** The deadlines of an accepted task, as numeric text. */
interface DeadlineRow {
  id: string;
  commit_deadline: string;
  reveal_deadline: string;
  pick_deadline: string;
  fallback_deadline: string;
}

/**
 * One pass of the Judge over the tasks that name `deps.judgeAccount` as their verifier. First
 * intake (`intakeTask`) for every task with no `judge_status` or a `pending` one, then judging
 * (`judgeTask`) for every `accepted` task the database has no outcome for and whose deadlines put
 * the clock in its judging window: the due tasks. A task accepted by the first pass can be judged
 * in the second. Intake goes in id order. Judging goes earliest stop line first (`stopLineOf`),
 * the order in which the tasks run out of time, and then by id. A busy task's turn ends at its
 * slice of the tick (20 s) whenever more than two slices are left before its stop line, whether or
 * not another task waits (P05-R18, P05-R19), and it takes up again on its next turn from what it
 * found out (`deps.memory`). What the Judge keeps of a task that is no longer due goes. Last, a
 * `waiting: …` reason is cleared from every task that can no longer be judged
 * (`clearStaleWaits`), which a Judge that was not running when the wait ended leaves.
 *
 * It resolves with whether a task's turn ended at its slice, so that the next tick starts at once
 * (`startJudge`), intake first: a task that came due, or was posted, during a turn joins the next
 * pass. What that guarantees is that no task holds the Judge for more than a slice, and the work
 * under way at its end, while it has more than two slices left before its stop line. It does not
 * guarantee that each task gets to its stop line. A task within two slices of its line runs to it
 * uncut, and a task waiting behind it whose own line comes before the end of that stretch, as can
 * happen with two busy tasks, comes back past its line: it is then picked from what it found out.
 * When the wait also takes it past its pick deadline, as with a margin shorter than the wait, it
 * is not picked, and its fallback window applies. A due task that only waits (P05-R8) costs a
 * pass a quick look; no turn depends on it.
 *
 * A task that throws, as on a chain or database error, is logged, and the pass goes on with the
 * next task. The clock is read again for the judging pass: intake can take a while.
 *
 * Once `signal` has aborted, the pass takes no further task: the one in hand finishes, so that a
 * pick it sent is seen through, and the pass returns before the next intake or the next turn. On a
 * lost indexer lock, that keeps this Judge from judging alongside the one that takes the lock over.
 */
export async function judgeTick(deps: JudgeDeps, signal?: AbortSignal): Promise<boolean> {
  const clock = deps.now ?? (() => new Date());
  // `order by t.id`: the output column `id` is text, which would sort "10" before "9".
  const waiting = await deps.db.query<{ id: string }>(
    `select t.id::text as id from tasks t
      where t.verifier = $1 and (t.judge_status is null or t.judge_status = 'pending')
      order by t.id`,
    [deps.judgeAccount],
  );
  for (const { id } of waiting) {
    if (signal?.aborted) return false;
    try {
      await intakeTask(deps, BigInt(id));
    } catch (error) {
      console.error(`judge: intake of task ${id} failed (${describeError(error)})`);
    }
  }

  const nowNs = BigInt(clock().getTime()) * NS_PER_MS;
  const accepted = await deps.db.query<DeadlineRow>(
    `select t.id::text as id, t.commit_deadline::text as commit_deadline,
            t.reveal_deadline::text as reveal_deadline, t.pick_deadline::text as pick_deadline,
            t.fallback_deadline::text as fallback_deadline
       from tasks t
      where t.verifier = $1 and t.judge_status = 'accepted' and t.outcome is null`,
    [deps.judgeAccount],
  );
  // The database's view of the window, which only chooses what to look at: `judgeTask` decides
  // from the chain.
  const due = accepted
    .filter((row) => phaseAt({ ...row, settled: false }, nowNs) === "judging")
    .map((row) => ({ row, stopLine: stopLineOf(row), id: BigInt(row.id) }))
    .sort((a, b) => compare(a.stopLine, b.stopLine) || compare(a.id, b.id));
  let gaveWay = false;
  for (const { row, id } of due) {
    if (signal?.aborted) return gaveWay;
    try {
      if ((await judgeTask(deps, id)) === "yielded") gaveWay = true;
    } catch (error) {
      console.error(`judge: judging task ${row.id} failed (${describeError(error)})`);
    }
  }
  const judging = new Set(due.map(({ row }) => row.id));
  for (const id of deps.memory?.progress.keys() ?? []) {
    if (!judging.has(id)) deps.memory?.progress.delete(id);
  }
  await clearStaleWaits(deps, nowNs);
  return gaveWay;
}

/** The order of two bigints, for `sort`. */
function compare(a: bigint, b: bigint): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** A memory with nothing in it yet. */
export function newJudgeMemory(): JudgeMemory {
  return { checks: new Map(), progress: new Map() };
}

/**
 * Runs `judgeTick` now, and again `intervalMs` (default 10 s) after each tick ends, until `signal`
 * aborts: at once, when a task gave way in the tick (P05-R18). The ticks share one `JudgeMemory`,
 * `deps.memory` or a new one, and one `WarmWorker`, `deps.warm` or one started with the loop, so
 * that a score worker is loaded before a task needs one. The wait starts when a tick ends, so
 * ticks never overlap, however long one takes. A tick that throws is logged and the loop goes on.
 *
 * An abort during the wait ends the loop at once. An abort during a tick lets the task in hand
 * finish, so that a pick it sent is seen through, and the tick takes no other (`judgeTick`). A
 * signal that is aborted already runs no tick. The returned promise resolves once the loop has
 * stopped, and the warm worker it started with it, and never rejects.
 */
export function startJudge(
  deps: JudgeDeps & { intervalMs?: number; signal: AbortSignal },
): Promise<void> {
  const { intervalMs = DEFAULT_INTERVAL_MS, signal } = deps;
  if (signal.aborted) return Promise.resolve();
  // One it is given is the giver's to stop.
  const own = deps.warm === undefined ? new WarmWorker() : undefined;
  const ticked: JudgeDeps = {
    ...deps,
    memory: deps.memory ?? newJudgeMemory(),
    warm: deps.warm ?? own,
  };
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ticking = false;

    const finish = () => {
      clearTimeout(timer);
      void (own?.close() ?? Promise.resolve()).then(resolve, resolve);
    };
    const run = async () => {
      ticking = true;
      let gaveWay = false;
      try {
        gaveWay = await judgeTick(ticked, signal);
      } catch (error) {
        console.error(`judge: tick failed (${describeError(error)})`);
      }
      ticking = false;
      if (signal.aborted) finish();
      // A task that gave way takes up again at once, not after the wait.
      else timer = setTimeout(run, gaveWay ? 0 : intervalMs);
    };

    // `once` removes the listener when it fires. An abort during a tick is seen when the tick
    // returns, after the task in hand.
    signal.addEventListener(
      "abort",
      () => {
        if (!ticking) finish();
      },
      { once: true },
    );
    void run();
  });
}
