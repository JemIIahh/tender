import {
  ApiError,
  type HealthResponse,
  type ListAgentsResponse,
  type ListTasksResponse,
} from "@tender/shared";
import { api } from "./api";
import { sharedRead } from "./sharedRead";

// The three reads behind the top bar's Live pill (lib/live.ts) and the landing's ticker
// (lib/ticker.ts): the open tasks, the agents and the health check. The tab makes them once for both
// (`liveReads`). They are in a module of their own, apart from what the pill makes of them, so the
// landing, which has no pill, brings none of that with it.

/** A page of the API holds at most this many rows, which is what a count is read from. */
const PAGE = 50;

/** How often the three are read again, while something shows them and the tab is in view. */
export const LIVE_REFRESH_MS = 60_000;

/** What the three reads brought back. A read that failed is missing. */
export interface LiveReads {
  open?: ListTasksResponse;
  agents?: ListAgentsResponse;
  health?: HealthResponse;
  /** The API answered at least one of them, whatever the answer was. */
  answered: boolean;
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

/**
 * The three reads, made once for the tab: the Live pill and the landing's ticker both listen, a
 * part that comes within a minute of the last read is given it, and a read under way is not made
 * twice (lib/sharedRead.ts).
 */
export const liveReads = sharedRead(readLive, LIVE_REFRESH_MS);
