import { type Phase, phaseAt, U64StringSchema } from "@tender/shared";

// One phase rule for the whole app (X-4): the contract's, as `@tender/shared` writes it. This file
// re-exports it, and adds what the timeline needs around it: the four windows of a task, what the
// rules of each phase say, and the map between a position on the scrubber and a moment in time.
export { phaseAt };

/** The times of a task that its windows are made of: nanosecond decimal strings (R19). */
export interface TaskWindows {
  /** The start of the commit window. */
  created_at: string;
  commit_deadline: string;
  reveal_deadline: string;
  pick_deadline: string;
  fallback_deadline: string;
}

/** A task as a row of the API has it: its windows, and whether it has an outcome. */
export type PhasedTask = TaskWindows & { outcome_kind: "picked" | "voided" | null };

/** The phases that are a window of time: `expired` and `settled` are not. */
export type WindowPhase = "open" | "revealing" | "judging" | "fallback";

export interface Segment {
  phase: WindowPhase;
  /** Inclusive. */
  startNs: bigint;
  /** Exclusive: at this moment the next phase has begun. */
  endNs: bigint;
}

const SECOND = 1_000_000_000n;
const WINDOW_PHASES: readonly WindowPhase[] = ["open", "revealing", "judging", "fallback"];

/** `value` as a bigint, or a `TypeError` that names the field: a time that is no u64 is no time. */
function ns(field: keyof TaskWindows, value: string): bigint {
  if (!U64StringSchema.safeParse(value).success) {
    throw new TypeError(
      `${field} must be a u64 as a decimal string, got ${JSON.stringify(String(value).slice(0, 40))}`,
    );
  }
  return BigInt(value);
}

/**
 * The four windows of a task, in order: commit, reveal, judge (the verifier's pick) and fallback
 * (the poster's). The first starts at `created_at` and each ends where the next begins, at the
 * deadline, so together they cover the time from posting to the last deadline with no gap.
 */
export function segments(task: TaskWindows): Segment[] {
  const edges = [
    ns("created_at", task.created_at),
    ns("commit_deadline", task.commit_deadline),
    ns("reveal_deadline", task.reveal_deadline),
    ns("pick_deadline", task.pick_deadline),
    ns("fallback_deadline", task.fallback_deadline),
  ];
  return WINDOW_PHASES.map((phase, i) => ({
    phase,
    startNs: edges[i] ?? 0n,
    endNs: edges[i + 1] ?? 0n,
  }));
}

function deadlines(task: TaskWindows) {
  return {
    commit_deadline: task.commit_deadline,
    reveal_deadline: task.reveal_deadline,
    pick_deadline: task.pick_deadline,
    fallback_deadline: task.fallback_deadline,
  };
}

/** The phase of `task` at `nowNs`: `settled` once it has an outcome, else by its deadlines. */
export function phaseOfTask(task: PhasedTask, nowNs: bigint): Phase {
  return phaseAt({ ...deadlines(task), settled: task.outcome_kind !== null }, nowNs);
}

/**
 * The phase the deadlines alone give at `nowNs`, whether or not the task has an outcome. The
 * scrubber asks it: for a settled task too, it shows what the rule would have been at that moment.
 */
export function phaseByClock(task: TaskWindows, nowNs: bigint): Phase {
  return phaseAt({ ...deadlines(task), settled: false }, nowNs);
}

// ---- The rules --------------------------------------------------------------------------------

export interface Rule {
  /** What applies, in four words. */
  headline: string;
  /** What that means for the people at the task. */
  detail: string;
}

/** What the contract allows in each phase, for the line under the timeline. */
export const RULES: Record<Phase, Rule> = {
  open: {
    headline: "entries are sealed",
    detail: "Agents commit a hash of their answer. Nobody can read an entry yet.",
  },
  revealing: {
    headline: "reveal or forfeit",
    detail: "Agents reveal what they committed to. An entry that is not revealed is out.",
  },
  judging: {
    headline: "verifier picks",
    detail: "Only the verifier can pick the winners now.",
  },
  fallback: {
    headline: "poster may pick",
    detail: "The verifier did not pick in time, so the poster can.",
  },
  expired: {
    headline: "anyone can refund",
    detail: "No one picked in time. Anyone can send the reward back to whoever paid it.",
  },
  settled: {
    headline: "settled",
    detail: "The task is closed. The reward was paid out or refunded.",
  },
};

/** The name of each window on the timeline. */
export const WINDOW_LABELS: Record<WindowPhase | "expired", string> = {
  open: "Commit",
  revealing: "Reveal",
  judging: "Judge",
  fallback: "Fallback",
  expired: "Expired",
};

// ---- The scrubber -----------------------------------------------------------------------------

/**
 * The scrubber's scale runs from 0 to this, a position a step. It is cut into five equal zones: the
 * four windows, and after them the time past the last deadline, where the rule is that anyone can
 * refund. A scale that gave each window its share of the time would leave the reveal window, often
 * the shortest, a sliver that cannot be seen or hit on a phone. A hundred positions are few enough
 * for the arrow keys to cross a zone in twenty presses.
 */
export const SCRUB_MAX = 100;
const ZONES = 5;
const ZONE_STEPS = SCRUB_MAX / ZONES;

/** The time each zone covers, from and up to (not including): the windows, then the time after. */
function zones(task: TaskWindows): Array<[bigint, bigint]> {
  const windows = segments(task);
  const last = windows[windows.length - 1];
  const end = last?.endNs ?? 0n;
  // The zone after the windows is as long as the last window, and at least a second.
  const length =
    last !== undefined && last.endNs - last.startNs > SECOND ? last.endNs - last.startNs : SECOND;
  return [...windows.map((w): [bigint, bigint] => [w.startNs, w.endNs]), [end, end + length]];
}

/**
 * The moment a position on the scrubber stands for. It is linear in time inside a zone, so the
 * start of a zone is the deadline that opens it: 20 is the commit deadline, 40 the reveal
 * deadline, and so on. A position outside the scale, or that is not a number, is the nearest end.
 */
export function nsAtScrub(task: TaskWindows, position: number): bigint {
  const steps = Number.isFinite(position)
    ? Math.min(Math.max(Math.round(position), 0), SCRUB_MAX)
    : 0;
  const zone = Math.min(Math.floor(steps / ZONE_STEPS), ZONES - 1);
  const [start, end] = zones(task)[zone] ?? [0n, 0n];
  const within = BigInt(steps - zone * ZONE_STEPS);
  return start + ((end - start) * within) / BigInt(ZONE_STEPS);
}

/**
 * Where on the scale a moment sits: the inverse of `nsAtScrub`, rounded down, so that a moment
 * before a deadline is never placed in the zone that the deadline opens. A moment before the task
 * was posted is 0 and one past the last zone is the end of the scale.
 */
export function scrubOf(task: TaskWindows, nowNs: bigint): number {
  const all = zones(task);
  for (const [zone, [start, end]] of all.entries()) {
    if (nowNs < start) return zone * ZONE_STEPS;
    if (nowNs < end) {
      return zone * ZONE_STEPS + Number(((nowNs - start) * BigInt(ZONE_STEPS)) / (end - start));
    }
  }
  return SCRUB_MAX;
}

// ---- Durations --------------------------------------------------------------------------------

/** Whole seconds in `durationNs`, rounded up, and none for a time that has passed. */
function wholeSeconds(durationNs: bigint): bigint {
  return durationNs > 0n ? (durationNs + SECOND - 1n) / SECOND : 0n;
}

function units(seconds: bigint) {
  return {
    d: seconds / 86_400n,
    h: (seconds % 86_400n) / 3_600n,
    m: (seconds % 3_600n) / 60n,
    s: seconds % 60n,
  };
}

/**
 * A time left or gone as a clock reads it: `2d 3h 4m 5s`, `1m 5s`, `9s`. The seconds are rounded
 * up, so that a countdown reads `1s` until the moment it is over, and a time that has passed is
 * `0s`. The units above the largest that is not zero are left out, and those below it are not.
 */
export function formatDuration(durationNs: bigint): string {
  const { d, h, m, s } = units(wholeSeconds(durationNs));
  if (d > 0n) return `${d}d ${h}h ${m}m ${s}s`;
  if (h > 0n) return `${h}h ${m}m ${s}s`;
  if (m > 0n) return `${m}m ${s}s`;
  return `${s}s`;
}

/** The length of a window in as few words as it takes: `10m`, `1h 30m`, `14d`. */
export function formatSpan(durationNs: bigint): string {
  const { d, h, m, s } = units(wholeSeconds(durationNs));
  const parts = [
    d > 0n ? `${d}d` : "",
    h > 0n ? `${h}h` : "",
    m > 0n ? `${m}m` : "",
    s > 0n ? `${s}s` : "",
  ];
  return parts.filter((part) => part !== "").join(" ") || "0s";
}

/** `durationNs` as an ISO 8601 duration, for the `datetime` of a `<time>`: `PT2M5S`. */
export function isoDuration(durationNs: bigint): string {
  const { d, h, m, s } = units(wholeSeconds(durationNs));
  const time = `${h > 0n ? `${h}H` : ""}${m > 0n ? `${m}M` : ""}${s > 0n ? `${s}S` : ""}`;
  const date = d > 0n ? `${d}D` : "";
  if (date === "" && time === "") return "PT0S";
  return `P${date}${time === "" ? "" : `T${time}`}`;
}
