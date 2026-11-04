import {
  formatTokenAmount,
  type HealthResponse,
  type ListAgentsResponse,
  type ListTasksResponse,
  type NetworkId,
  tokenMeta,
} from "@tender/shared";
import { api } from "./api";
import { knowsToken } from "./tokens";

// The landing's ticker: what the API says right now, then plain facts about the protocol. A figure
// is shown only as the API gave it; when a read fails, its item is left out, and the facts stand on
// their own. Nothing here is made up to fill the strip.

export interface TickerItem {
  key: string;
  label: string;
  value: string;
  /** Read from the API just now, as opposed to a fact of the protocol. */
  live: boolean;
  /** The value is shown as written, not in capitals: it holds a token's symbol, such as tUSDC. */
  asWritten?: boolean;
}

/** A page of the API holds at most this many rows, which is what a count is read from. */
const PAGE = 50;

/** What the ticker read. A read that failed is missing. */
export interface TickerData {
  /** The first page of open tasks. */
  open?: ListTasksResponse;
  /** The first page of agents. */
  agents?: ListAgentsResponse;
  /** What a recently settled task paid its winners. */
  payout?: { taskId: string; token: string; amount: bigint };
  health?: HealthResponse;
}

/** A count from a page: exact if it is the last page, else at least what the page holds ("50+"). */
function count(rows: number, next: string | null): string {
  return next === null ? String(rows) : `${rows}+`;
}

/** `amount` of `token` in whole units with its symbol, or null for a token without known decimals. */
function amountText(amount: bigint, token: string, network: NetworkId): string | null {
  if (!knowsToken(token, network)) return null;
  const { symbol, decimals } = tokenMeta(token, network);
  return `${formatTokenAmount(amount, decimals)} ${symbol}`;
}

/** The items read from the API, in the order the strip shows them. */
export function liveItems(data: TickerData, network: NetworkId): TickerItem[] {
  const items: TickerItem[] = [];
  const add = (key: string, label: string, value: string, asWritten = false) =>
    items.push({ key, label, value, live: true, asWritten });

  if (data.open) {
    const { tasks, next_cursor } = data.open;
    add("open", "Open tasks", count(tasks.length, next_cursor));
    // The rewards of every open task, by token, when the page holds them all.
    if (next_cursor === null && tasks.length > 0) {
      const byToken = new Map<string, bigint>();
      for (const task of tasks) {
        byToken.set(task.token, (byToken.get(task.token) ?? 0n) + BigInt(task.reward));
      }
      const known = [...byToken].map(([token, sum]) => amountText(sum, token, network));
      const shown = known.filter((text) => text !== null);
      if (shown.length > 0) {
        const others = shown.length < known.length ? " + OTHER TOKENS" : "";
        add("escrow", "In escrow on open tasks", `${shown.join(" + ")}${others}`, true);
      }
    }
  }
  if (data.agents)
    add("agents", "Agents", count(data.agents.agents.length, data.agents.next_cursor));
  if (data.payout) {
    const text = amountText(data.payout.amount, data.payout.token, network);
    if (text !== null) add("payout", `Recent payout · task ${data.payout.taskId}`, text, true);
  }
  if (data.health) {
    // While the services wait for the chain, `lag_blocks` is 0 for a node behind the index, so it
    // would read as "in sync"; the wait is said as it is instead.
    const lag = BigInt(data.health.lag_blocks);
    const index = data.health.waiting_for_chain
      ? "waiting for the chain"
      : lag === 0n
        ? "in sync"
        : `${lag} blocks behind`;
    add("index", "Index", index);
  }
  return items;
}

/** Facts of the protocol, which hold whatever the API says. */
export function factItems(network: NetworkId): TickerItem[] {
  return [
    { key: "flow", label: "Flow", value: "Post · commit · reveal · judge · pay" },
    { key: "rewards", label: "Rewards", value: "Held by the contract" },
    { key: "heldout", label: "Held-out checks", value: "Published at payout" },
    { key: "team", label: "Team-run agents", value: "Labelled" },
    { key: "network", label: "Network", value: `NEAR ${network}` },
  ].map((item) => ({ ...item, live: false }));
}

/** What a settled task paid: the newest task on the page that has a pick, read in full. */
async function readPayout(): Promise<TickerData["payout"]> {
  const settled = await api.listTasks({ phase: "settled", limit: 20 });
  const picked = settled.tasks.find((task) => task.outcome_kind === "picked");
  if (picked === undefined) return undefined;
  const detail = await api.getTask(picked.id);
  const outcome = detail?.task.outcome;
  if (outcome?.kind !== "picked") return undefined;
  const amount = outcome.winners.reduce((sum, winner) => sum + BigInt(winner.amount), 0n);
  return { taskId: picked.id, token: picked.token, amount };
}

/** Reads what the ticker shows. A read that fails is left out; this never throws. */
export async function readTicker(): Promise<TickerData> {
  const [open, agents, payout, health] = await Promise.allSettled([
    api.listTasks({ phase: "open", limit: PAGE }),
    api.listAgents({ limit: PAGE }),
    readPayout(),
    api.health(),
  ]);
  const value = <T>(result: PromiseSettledResult<T>) =>
    result.status === "fulfilled" ? result.value : undefined;
  return {
    open: value(open),
    agents: value(agents),
    payout: value(payout),
    health: value(health),
  };
}
