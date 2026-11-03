import { type NetworkId, type TaskSummary, tokenMeta } from "@tender/shared";
import { phaseOfTask, segments } from "./phase";

// What a card on the board says in a line beside the phase: when the window that is open closes,
// or how the task ended, and which card is the board's featured one.

const SECOND = 1_000_000_000n;

/** A time left, to the minute: a card does not count seconds, its task's page does. */
export function roughly(leftNs: bigint): string {
  const minutes = leftNs / (60n * SECOND);
  const days = minutes / 1440n;
  const hours = (minutes % 1440n) / 60n;
  const mins = minutes % 60n;
  if (days > 0n) return hours > 0n ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0n) return mins > 0n ? `${hours}h ${mins}m` : `${hours}h`;
  if (mins > 0n) return `${mins}m`;
  return "under a minute";
}

/** What closes at the end of each window, as a card says it. */
const CLOSES = {
  open: "Entries close",
  revealing: "Reveals close",
  judging: "Pick due",
  fallback: "Poster's pick due",
} as const;

/**
 * When the open window of `task` closes, at `nowNs`, in a few words; or what became of the task once
 * every window is past: refunded or paid out once it is settled, and open to a refund before then.
 */
export function deadlineLine(task: TaskSummary, nowNs: bigint): string {
  const phase = phaseOfTask(task, nowNs);
  if (phase === "settled") return task.outcome_kind === "voided" ? "Refunded" : "Paid out";
  if (phase === "expired") return "Anyone can refund";
  const window = segments(task).find((segment) => segment.phase === phase);
  const left = window === undefined || window.endNs <= nowNs ? 0n : window.endNs - nowNs;
  return `${CLOSES[phase]} in ${roughly(left)}`;
}

/** The symbols of the tokens whose amounts are dollars, which are the ones a reward is compared in. */
const DOLLARS: ReadonlySet<string> = new Set(["USDC", "tUSDC"]);

/**
 * The id of the board's featured task: the open task (by the clock) with the largest reward, among
 * those paid in a dollar token. Rewards in other tokens are not compared with them, as there is no
 * rate here to compare them by. Null when no open task is paid in dollars. The first of equals.
 */
export function featuredTaskId(
  tasks: readonly TaskSummary[],
  nowNs: bigint,
  network: NetworkId,
): string | null {
  let best: TaskSummary | null = null;
  for (const task of tasks) {
    if (phaseOfTask(task, nowNs) !== "open") continue;
    if (!DOLLARS.has(tokenMeta(task.token, network).symbol)) continue;
    if (best === null || BigInt(task.reward) > BigInt(best.reward)) best = task;
  }
  return best?.id ?? null;
}
