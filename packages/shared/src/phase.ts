import { type Phase, type TaskView, U64StringSchema } from "./views";

/**
 * The phase of a task at `nowNs`, by the contract's own rule (`phase` in
 * contract/tender/src/tasks.rs). A settled task is `settled` whatever the time. Otherwise each
 * window runs from one deadline up to, but not including, the next: `open` before
 * `commit_deadline`, then `revealing`, `judging` and `fallback`, and `expired` from
 * `fallback_deadline` on. At a deadline itself the next phase has begun.
 *
 * The contract works the phase out from the block time on every read and never stores it, so use
 * this wherever a phase is needed for a moment other than the one a view was served at: a
 * countdown, a row in the database, a check before a call is sent. For a decision about a call
 * pass the latest block's timestamp, which is what the contract will read; a wall clock can be a
 * few seconds away from it.
 *
 * `settled` is true once the task has an outcome. The deadlines are u64 nanosecond decimal
 * strings, as the contract's JSON writes them, and they are compared as bigints because
 * nanosecond timestamps are above 2^53, where a `Number` cannot tell neighbours apart. A deadline
 * that is not a u64 decimal string throws a `TypeError`, settled task or not, instead of turning
 * into a wrong phase (`BigInt("")` is `0n`).
 */
export function phaseAt(
  t: {
    commit_deadline: string;
    reveal_deadline: string;
    pick_deadline: string;
    fallback_deadline: string;
    settled: boolean;
  },
  nowNs: bigint,
): Phase {
  const commit = ns("commit_deadline", t.commit_deadline);
  const reveal = ns("reveal_deadline", t.reveal_deadline);
  const pick = ns("pick_deadline", t.pick_deadline);
  const fallback = ns("fallback_deadline", t.fallback_deadline);

  if (t.settled) return "settled";
  if (nowNs < commit) return "open";
  if (nowNs < reveal) return "revealing";
  if (nowNs < pick) return "judging";
  if (nowNs < fallback) return "fallback";
  return "expired";
}

/**
 * The phase of a `TaskView` at `nowNs`: `phaseAt` with `settled` set when the view has an
 * outcome. The view's own `phase` is the contract's answer at the block that served it and goes
 * stale as time passes; this works it out again for `nowNs`.
 */
export function phaseOfTaskView(view: TaskView, nowNs: bigint): Phase {
  return phaseAt(
    {
      commit_deadline: view.commit_deadline,
      reveal_deadline: view.reveal_deadline,
      pick_deadline: view.pick_deadline,
      fallback_deadline: view.fallback_deadline,
      settled: view.outcome !== null,
    },
    nowNs,
  );
}

/** A deadline as a bigint. The error names the field and shows the start of what it got. */
function ns(field: string, value: string): bigint {
  if (!U64StringSchema.safeParse(value).success) {
    throw new TypeError(
      `${field} must be a u64 as a decimal string, got ${JSON.stringify(String(value).slice(0, 40))}`,
    );
  }
  return BigInt(value);
}
