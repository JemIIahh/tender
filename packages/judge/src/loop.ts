import { phaseAt } from "@tender/shared";
import { intakeTask } from "./intake";
import { WarmWorker } from "./isolate";
import { clearStaleWaits, describeError, judgeTask } from "./judge";
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
 * the clock in its judging window. A task accepted by the first pass can be judged in the second.
 * Intake goes in id order. Judging goes earliest pick deadline first (P05-R18), and each task has
 * a slice of the tick (20 s) before the next one's turn: one with many slow entries takes up again
 * on the next tick, from what it had found out (`deps.memory`), so that it cannot keep the others
 * from their pick deadlines. What the Judge keeps of a task that is no longer in its judging
 * window goes. Last, a `waiting: …` reason is cleared from every task that can no longer be
 * judged (`clearStaleWaits`), which a Judge that was not running when the wait ended leaves.
 *
 * A task that throws, as on a chain or database error, is logged, and the pass goes on with the
 * next task. The clock is read again for the judging pass: intake can take a while.
 */
export async function judgeTick(deps: JudgeDeps): Promise<void> {
  const clock = deps.now ?? (() => new Date());
  // `order by t.id`: the output column `id` is text, which would sort "10" before "9".
  const waiting = await deps.db.query<{ id: string }>(
    `select t.id::text as id from tasks t
      where t.verifier = $1 and (t.judge_status is null or t.judge_status = 'pending')
      order by t.id`,
    [deps.judgeAccount],
  );
  for (const { id } of waiting) {
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
      where t.verifier = $1 and t.judge_status = 'accepted' and t.outcome is null
      order by t.pick_deadline, t.id`,
    [deps.judgeAccount],
  );
  const judging = new Set<string>();
  for (const row of accepted) {
    try {
      // The database's view of the window, which only chooses what to look at: `judgeTask`
      // decides from the chain.
      if (phaseAt({ ...row, settled: false }, nowNs) !== "judging") continue;
      judging.add(row.id);
      await judgeTask(deps, BigInt(row.id));
    } catch (error) {
      console.error(`judge: judging task ${row.id} failed (${describeError(error)})`);
    }
  }
  for (const id of deps.memory?.progress.keys() ?? []) {
    if (!judging.has(id)) deps.memory?.progress.delete(id);
  }
  await clearStaleWaits(deps, nowNs);
}

/** A memory with nothing in it yet. */
export function newJudgeMemory(): JudgeMemory {
  return { checks: new Map(), progress: new Map() };
}

/**
 * Runs `judgeTick` now, and again `intervalMs` (default 10 s) after each tick ends, until `signal`
 * aborts. The ticks share one `JudgeMemory`, `deps.memory` or a new one, and one `WarmWorker`,
 * `deps.warm` or one started with the loop, so that a score worker is loaded before a task needs
 * one. The wait starts when a tick ends, so ticks never overlap, however long one takes. A tick
 * that throws is logged and the loop goes on.
 *
 * An abort during the wait ends the loop at once. An abort during a tick lets the tick finish
 * first, so that a pick it sent is seen through. A signal that is aborted already runs no tick.
 * The returned promise resolves once the loop has stopped, and the warm worker it started with
 * it, and never rejects.
 */
export function startJudge(
  deps: JudgeDeps & { intervalMs?: number; signal: AbortSignal },
): Promise<void> {
  const { intervalMs = DEFAULT_INTERVAL_MS, signal } = deps;
  if (signal.aborted) return Promise.resolve();
  const warm = deps.warm ?? new WarmWorker();
  const ticked: JudgeDeps = { ...deps, memory: deps.memory ?? newJudgeMemory(), warm };
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ticking = false;

    const finish = () => {
      clearTimeout(timer);
      // One it was given is the giver's to stop.
      const stopped = deps.warm === undefined ? warm.close() : Promise.resolve();
      void stopped.then(resolve, resolve);
    };
    const run = async () => {
      ticking = true;
      try {
        await judgeTick(ticked);
      } catch (error) {
        console.error(`judge: tick failed (${describeError(error)})`);
      }
      ticking = false;
      if (signal.aborted) finish();
      else timer = setTimeout(run, intervalMs);
    };

    // `once` removes the listener when it fires. An abort during a tick is seen after the tick.
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
