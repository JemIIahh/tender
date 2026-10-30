import type { PublicCriteria } from "@tender/shared";
import type { EntryScore } from "./types";

// The shared package has no name for the type of a split, so it is taken from the criteria.
type Split = PublicCriteria["split"];

/** Basis points in a whole. The shares of one pick add up to exactly this. */
const BPS_WHOLE = 10_000;

/** A revealed entry, once its content has been fetched and scored. */
export interface ScoredEntry extends EntryScore {
  account: string;
  /** The SHA-256 the entry revealed, as 64 lowercase hex characters. */
  contentHash: string;
  uri: string;
  /** The block of the entry's latest commit. */
  committedAtBlock: bigint;
}

/**
 * `entries`, best first: the higher score, then the earlier `committedAtBlock`, then the smaller
 * account. The scorecard states this order (its `tie_break`) so that anyone can run it again, and
 * it depends on the entries alone, not on the order they arrive in.
 *
 * Accounts compare by UTF-16 code unit (`<`), which is the same in every language and on every
 * machine; `localeCompare` is neither. Blocks compare as bigints: a Number cannot tell apart the
 * largest u64 values. Returns a new array.
 */
export function rankEntries(entries: readonly ScoredEntry[]): ScoredEntry[] {
  return entries.toSorted((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.committedAtBlock !== b.committedAtBlock) {
      return a.committedAtBlock < b.committedAtBlock ? -1 : 1;
    }
    if (a.account !== b.account) return a.account < b.account ? -1 : 1;
    return 0;
  });
}

/**
 * Who `pick` pays and what share each gets, in basis points. `ranked` is the output of
 * `rankEntries`. Only an entry that `passed` can win (that is its scorer's verdict on
 * `c.min_score`, which is not read again here), and winners are taken in the order of `ranked`.
 *
 * At most `maxWinners` are paid, and no more than the split has places for: one for
 * `winner_take_all`, as many as the list has shares for an array, no limit of its own for `equal`.
 * Nobody is paid when no entry passed, or when `maxWinners` is below 1: the result is empty, which
 * is a pick that awards nothing.
 *
 * The shares always add up to exactly 10_000, as `pick` demands. When fewer places are filled
 * than the split lists, the shares of the filled ones are scaled up to a whole, each rounded down,
 * and the first winner takes what the rounding leaves: `equal` among 3 is 3334, 3333 and 3333, and
 * `[7000, 3000]` with one winner is `[10000]`. A split that is filled as listed comes out as
 * listed. `c.split` is a valid split, as the criteria schema checks it.
 */
export function chooseWinners(
  ranked: readonly ScoredEntry[],
  c: { min_score: number; split: Split },
  maxWinners: number,
): { account: string; bps: number }[] {
  const eligible = ranked.filter((entry) => entry.passed);
  // `winner_take_all` is a list of one share, the whole. `equal` has no list: every place weighs
  // the same, and there is no limit but the task's.
  const listed = c.split === "winner_take_all" ? [BPS_WHOLE] : c.split;
  const places = listed === "equal" ? Number.POSITIVE_INFINITY : listed.length;
  const n = Math.min(maxWinners, eligible.length, places);
  // A count below 1 pays nobody. It must not reach `slice` either: a negative end counts from the
  // end of the list.
  if (n < 1) return [];

  const weighted = eligible.slice(0, n).map((entry, i) => ({
    account: entry.account,
    // `i` is below `n`, so below `listed.length`; the fallback is for the compiler only.
    weight: listed === "equal" ? 1 : (listed[i] ?? 0),
  }));
  const total = weighted.reduce((sum, winner) => sum + winner.weight, 0);
  // The shares of a split are whole numbers from 1 up that add up to 10_000, so the first `n` of
  // them add up to `total`, at most 10_000. Scaling by 10_000 / `total`, which is 1 or more, never
  // takes a share below its own value, so no winner rounds down to 0 bps, which `pick` refuses.
  // (`equal` gives each floor(10_000 / n), and a task has 5 winners at most.) These are whole
  // numbers far below 2^53, so the arithmetic is exact.
  const winners = weighted.map(({ account, weight }) => ({
    account,
    bps: Math.floor((weight * BPS_WHOLE) / total),
  }));
  // Rounding down leaves a few basis points over. The first winner takes them.
  const left = BPS_WHOLE - winners.reduce((sum, winner) => sum + winner.bps, 0);
  return winners.map((winner, i) => (i === 0 ? { ...winner, bps: winner.bps + left } : winner));
}
