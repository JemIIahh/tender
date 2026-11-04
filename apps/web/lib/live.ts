import {
  ApiError,
  type HealthResponse,
  type ListAgentsResponse,
  type ListTasksResponse,
} from "@tender/shared";
import { type ByToken, sumByToken } from "./account";
import { api } from "./api";

// What the top bar's Live pill says (components/LiveStatus.tsx): whether the index is up to date
// with the chain, and a few figures of the platform. Three reads, the ones the sidebar's figures
// used to make, and nothing else. Every figure is the API's; one it did not give is left out, and
// a person is never shown a block height or a count of blocks.

/** A page of the API holds at most this many rows, which is what a count is read from. */
const PAGE = 50;

export type LiveState = "synced" | "behind" | "offline";

/** What the three reads brought back. A read that failed is missing. */
export interface LiveReads {
  open?: ListTasksResponse;
  agents?: ListAgentsResponse;
  health?: HealthResponse;
  /** The API answered at least one of them, whatever the answer was. */
  answered: boolean;
}

export interface Live {
  /**
   * `synced`: the index has every final block and the services are not waiting for the chain.
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

/** The three reads: open tasks, agents and health. A read that fails is left out; this never throws. */
export async function readLive(): Promise<LiveReads> {
  const results = await Promise.allSettled([
    api.listTasks({ phase: "open", limit: PAGE }),
    api.listAgents({ limit: PAGE }),
    api.health(),
  ]);
  const [open, agents, health] = results;
  const value = <T>(result: PromiseSettledResult<T>) =>
    result.status === "fulfilled" ? result.value : undefined;
  return {
    open: value(open),
    agents: value(agents),
    health: value(health),
    // An error with a status is an answer (the health check's 503 among them); a failed fetch or
    // a timeout is not.
    answered: results.some(
      (result) => result.status === "fulfilled" || result.reason instanceof ApiError,
    ),
  };
}

/** What the pill shows for `reads`. */
export function liveOf(reads: LiveReads): Live {
  if (!reads.answered) return { state: "offline" };
  const { health, open, agents } = reads;
  const synced =
    health !== undefined && !health.waiting_for_chain && BigInt(health.lag_blocks) === 0n;
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
