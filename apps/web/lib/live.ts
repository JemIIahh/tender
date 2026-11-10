import { type ByToken, sumByToken } from "./account";
import type { LiveReads } from "./liveReads";

// What the top bar's Live pill says (components/LiveStatus.tsx): whether the index is up to date
// with the chain, and a few figures of the platform. Three reads, the ones the sidebar's figures
// used to make, and nothing else (lib/liveReads.ts, which the landing's ticker shares). Every figure
// is the API's; one it did not give is left out, and a person is never shown a block height or a
// count of blocks.

export { LIVE_REFRESH_MS, type LiveReads, liveReads, readLive } from "./liveReads";

export type LiveState = "synced" | "behind" | "offline";

export interface Live {
  /**
   * `synced`: the index is `SYNCED_LAG_BLOCKS` or fewer behind the final block and the services
   * are not waiting for the chain.
   * `behind`: the API answers, but it can't say the index is up to date (it is catching up, the
   * services wait for the chain, or the chain could not be read). `offline`: no answer at all.
   */
  state: LiveState;
  /** How many tasks are open: exact, or "50+" when there are more than a page. */
  openTasks?: string;
  agents?: string;
  /** The rewards the open tasks hold, token by token; only when the page holds every open task. */
  escrow?: ByToken;
}

/** A count from a page: exact if it is the last page, else at least what the page holds ("50+"). */
function count(rows: number, next: string | null): string {
  return next === null ? String(rows) : `${rows}+`;
}

/**
 * The most blocks the index may be behind the chain's final block and still be called up to date:
 * about 30 seconds of NEAR's blocks. The index reads finalized blocks, so on testnet it runs a steady
 * one to three behind, which is as up to date as it gets.
 */
export const SYNCED_LAG_BLOCKS = 30n;

/**
 * Whether `lag` is small enough to call up to date. Only a count of blocks in decimal digits is
 * read: one that is no number (`BigInt` would take "" and " " as 0) is not taken to be small.
 */
function smallLag(lag: string): boolean {
  return /^[0-9]{1,20}$/.test(lag) && BigInt(lag) <= SYNCED_LAG_BLOCKS;
}

/** What the pill shows for `reads`. */
export function liveOf(reads: LiveReads): Live {
  if (!reads.answered) return { state: "offline" };
  const { health, open, agents } = reads;
  const synced = health !== undefined && !health.waiting_for_chain && smallLag(health.lag_blocks);
  const live: Live = { state: synced ? "synced" : "behind" };
  if (open !== undefined) {
    live.openTasks = count(open.tasks.length, open.next_cursor);
    if (open.next_cursor === null) {
      live.escrow = sumByToken(open.tasks.map((task) => [task.token, task.reward]));
    }
  }
  if (agents !== undefined) live.agents = count(agents.agents.length, agents.next_cursor);
  return live;
}
