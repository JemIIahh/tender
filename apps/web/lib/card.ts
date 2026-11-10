import { type NetworkId, type Phase, type TaskSummary, tokenMeta } from "@tender/shared";
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

/**
 * A time left in one unit, never more than there is: whole days from two days up, whole hours
 * under that (as "47h"), whole minutes under an hour. A board card's foot has room for no more.
 */
export function briefly(leftNs: bigint): string {
  const minutes = leftNs / (60n * SECOND);
  const hours = minutes / 60n;
  if (hours >= 48n) return `${hours / 24n}d`;
  if (hours > 0n) return `${hours}h`;
  if (minutes > 0n) return `${minutes}m`;
  return "under a minute";
}

/** What closes at the end of each window, as a card says it. */
const CLOSES = {
  open: "Entries close",
  revealing: "Reveals close",
  judging: "Pick due",
  fallback: "Poster's pick due",
} as const;

/** The same, in the fewest words, for the foot of a board card, where the phase is beside it. */
const ENDS = {
  open: "Ends",
  revealing: "Reveals end",
  judging: "Pick due",
  fallback: "Poster's pick due",
} as const;

/**
 * When the open window of `task` closes, at `nowNs`, in a few words; or what became of the task once
 * every window is past: refunded or paid out once it is settled, and open to a refund before then.
 * `short` is the board card's wording ("Ends in 2d", `briefly`), whose phase badge says which
 * window it is.
 */
export function deadlineLine(task: TaskSummary, nowNs: bigint, short = false): string {
  const phase = phaseOfTask(task, nowNs);
  if (phase === "settled") return task.outcome_kind === "voided" ? "Refunded" : "Paid out";
  if (phase === "expired") return "Anyone can refund";
  const window = segments(task).find((segment) => segment.phase === phase);
  const left = window === undefined || window.endNs <= nowNs ? 0n : window.endNs - nowNs;
  return short ? `${ENDS[phase]} in ${briefly(left)}` : `${CLOSES[phase]} in ${roughly(left)}`;
}

/** The symbols of the tokens whose amounts are dollars, which are the ones a reward is compared in. */
const DOLLARS: ReadonlySet<string> = new Set(["USDC", "tUSDC"]);

/**
 * The id of the board's featured task: the open task (by the clock) with the largest reward, among
 * those paid in a dollar token. Rewards in other tokens are not compared with them, as there is no
 * rate here to compare them by. Null when no open task is paid in dollars, and when fewer than two
 * tasks are open: one open task is not a top of anything. The first of equals.
 */
export function featuredTaskId(
  tasks: readonly TaskSummary[],
  nowNs: bigint,
  network: NetworkId,
): string | null {
  let best: TaskSummary | null = null;
  let open = 0;
  for (const task of tasks) {
    if (phaseOfTask(task, nowNs) !== "open") continue;
    open += 1;
    if (!DOLLARS.has(tokenMeta(task.token, network).symbol)) continue;
    if (best === null || BigInt(task.reward) > BigInt(best.reward)) best = task;
  }
  return open < 2 ? null : (best?.id ?? null);
}

/**
 * The board's segments, each the phases (by the clock) it shows: a task is in the open window, in
 * the windows where entries are revealed and judged, or settled. A task in its fallback window, or
 * past it, is under All only.
 */
export const SEGMENT_PHASES = {
  open: ["open"],
  judging: ["revealing", "judging"],
  settled: ["settled"],
} as const satisfies Record<string, readonly Phase[]>;

export type Segment = keyof typeof SEGMENT_PHASES;

/** The segment a task is in at `nowNs`, or null for one that is under All only. */
export function segmentOf(task: TaskSummary, nowNs: bigint): Segment | null {
  const phase = phaseOfTask(task, nowNs);
  for (const [segment, phases] of Object.entries(SEGMENT_PHASES) as Array<
    [Segment, readonly Phase[]]
  >) {
    if (phases.includes(phase)) return segment;
  }
  return null;
}

/** What the board's summary line says of the tasks it has: how many are open, what they lock. */
export interface BoardSummary {
  open: number;
  /**
   * The rewards the open tasks hold in the contract, token by token, as the sidebar's Live block
   * counts them: a reward is locked from the post until a winner is paid or it is refunded.
   */
  locked: Array<[token: string, amount: bigint]>;
}

/** The summary of `tasks` at `nowNs`. */
export function boardSummary(tasks: readonly TaskSummary[], nowNs: bigint): BoardSummary {
  let open = 0;
  const locked = new Map<string, bigint>();
  for (const task of tasks) {
    if (phaseOfTask(task, nowNs) !== "open") continue;
    open += 1;
    locked.set(task.token, (locked.get(task.token) ?? 0n) + BigInt(task.reward));
  }
  return { open, locked: [...locked].filter(([, amount]) => amount > 0n) };
}
