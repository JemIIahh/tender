import {
  type AccountEntry,
  AccountIdSchema,
  type ListTasksFilter,
  type Phase,
  type TaskDetailResponse,
  type TaskSummary,
  U64StringSchema,
  U128StringSchema,
} from "@tender/shared";
import { type AgentRecord, api } from "./api";
import { config } from "./config";
import { phaseOfTask } from "./phase";
import { view } from "./rpc";

// What the account pages read and add up: the agents a connected account runs (My agents), what
// they won and what is still to be decided (Earnings), the tasks the account posted, and the bond
// an agent locks. Everything here is the API's or the chain's figure, added up token by token:
// amounts of different tokens are never added together, and nothing is estimated to fill a gap.

// ---- The agent bond (contract Task 16b) ----------------------------------------------------------

/** What an agent's bond says of it, once the contract keeps bonds. */
export type BondStatus = "active" | "unregistering" | "retired";

const BOND_STATUSES: readonly BondStatus[] = ["active", "unregistering", "retired"];

export interface Bond {
  status: BondStatus;
  /** The token the bond is in, and the amount, as the agent locked them; null if not given. */
  token: string | null;
  amount: string | null;
  /** When an unregistering agent can claim its bond back, in nanoseconds; null if not given. */
  claimableAt: bigint | null;
}

/**
 * The bond fields of an agent, if the API sends them: `status`, `bond_token`, `bond_amount` and
 * `claimable_at`, as the contract's agent view has them (Task 16b). Null when there is no `status`
 * the page knows: an API from before bonds, or a value it can't vouch for. A field that is there
 * but is not what it should be is left out (null), and never guessed.
 */
export function bondOf(agent: AgentRecord): Bond | null {
  const status = BOND_STATUSES.find((candidate) => candidate === agent.status);
  if (status === undefined) return null;
  const token = AccountIdSchema.safeParse(agent.bond_token);
  const amount = U128StringSchema.safeParse(agent.bond_amount);
  const claimable = U64StringSchema.safeParse(agent.claimable_at);
  return {
    status,
    token: token.success ? token.data : null,
    amount: amount.success ? amount.data : null,
    claimableAt: claimable.success ? BigInt(claimable.data) : null,
  };
}

/** What registering an agent locks, as the contract's config says. */
export type BondTerms =
  /** The contract's config has no bond fields: it is from before bonds. */
  | { state: "unknown" }
  /** The contract keeps bonds, and none is set: registration takes none. */
  | { state: "none" }
  | { state: "set"; token: string; amount: string; cooldownSecs: number | null };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The bond terms in the contract's config view. Task 16b says only that the bond token, its amount
 * and the cooldown are "readable in the config view", so both spellings it is likely to take are
 * read: `agent_bond: { token, amount }` and `agent_bond_token` with `agent_bond_amount`, and the
 * cooldown as `agent_bond_cooldown_secs`. A config with none of them is "unknown".
 */
export function bondTermsOf(configView: unknown): BondTerms {
  const view = asRecord(configView);
  if (view === undefined) return { state: "unknown" };
  const nested = asRecord(view.agent_bond);
  const hasFields =
    "agent_bond" in view || "agent_bond_token" in view || "agent_bond_amount" in view;
  if (!hasFields) return { state: "unknown" };
  const token = AccountIdSchema.safeParse(nested?.token ?? view.agent_bond_token);
  const amount = U128StringSchema.safeParse(nested?.amount ?? view.agent_bond_amount);
  if (!token.success || !amount.success || amount.data === "0") return { state: "none" };
  const cooldown = U64StringSchema.safeParse(
    String(view.agent_bond_cooldown_secs ?? nested?.cooldown_secs ?? ""),
  );
  return {
    state: "set",
    token: token.data,
    amount: amount.data,
    cooldownSecs: cooldown.success ? Number(cooldown.data) : null,
  };
}

/** The bond terms of the configured contract, read from its config view on the chain. */
export async function readBondTerms(): Promise<BondTerms> {
  return bondTermsOf(await view<unknown>(config.contractId, "get_config"));
}

// ---- Adding up ------------------------------------------------------------------------------------

/** Amounts by token, in the order each token first came. */
export type ByToken = Array<[token: string, amount: bigint]>;

/** `amounts` added up token by token. A value that is no amount is left out. */
export function sumByToken(amounts: Iterable<[token: string, amount: string | bigint]>): ByToken {
  const totals = new Map<string, bigint>();
  for (const [token, amount] of amounts) {
    let value: bigint;
    try {
      value = BigInt(amount);
    } catch {
      continue;
    }
    totals.set(token, (totals.get(token) ?? 0n) + value);
  }
  return [...totals];
}

// ---- My agents ------------------------------------------------------------------------------------

/** The API's largest page, and how many pages a list reads before it stops: 500 rows. */
const PAGE_SIZE = 50;
const MAX_PAGES = 10;

export interface MyAgents {
  /** The connected account itself, if it is a registered agent, first; then the agents under it. */
  agents: AgentRecord[];
  /** Whether the connected account is itself among them. */
  selfRegistered: boolean;
  /** There were more agents under it than the page reads. */
  truncated: boolean;
}

/**
 * The agents `account` runs: itself, if it is registered (`GET /v1/agents/:account`), and the
 * agents that name it as their provider (`GET /v1/agents?asp=`), page after page. `wanted` says
 * whether anyone still waits: once it is false no more pages are asked for, and the answer is null.
 */
export async function readMyAgents(
  account: string,
  wanted: () => boolean = () => true,
): Promise<MyAgents | null> {
  const self = api.getAgentRecord(account);
  const under: AgentRecord[] = [];
  let cursor: string | null = null;
  let truncated = true;
  for (let page = 0; page < MAX_PAGES; page++) {
    const answer = await api.listAgentRecords({ asp: account, limit: PAGE_SIZE, cursor });
    if (!wanted()) return null;
    under.push(...answer.agents);
    if (answer.next_cursor === null) {
      truncated = false;
      break;
    }
    cursor = answer.next_cursor;
  }
  const own = await self;
  if (!wanted()) return null;
  const others = under.filter((agent) => agent.account !== account);
  return {
    agents: own === null ? others : [own.agent, ...others],
    selfRegistered: own !== null,
    truncated,
  };
}

/** The combined record of a set of agents: only what the API counted, added up. */
export interface AgentsRecord {
  count: number;
  entries: number;
  reveals: number;
  wins: number;
  earned: ByToken;
  /** The bonds locked by active and unregistering agents; null when no agent has bond fields. */
  bonds: ByToken | null;
}

export function combinedRecord(agents: readonly AgentRecord[]): AgentsRecord {
  const bonds = agents.map((agent) => bondOf(agent));
  return {
    count: agents.length,
    entries: agents.reduce((sum, agent) => sum + agent.entries, 0),
    reveals: agents.reduce((sum, agent) => sum + agent.reveals, 0),
    wins: agents.reduce((sum, agent) => sum + agent.wins, 0),
    earned: sumByToken(agents.flatMap((agent) => Object.entries(agent.earned))),
    bonds: bonds.every((bond) => bond === null)
      ? null
      : sumByToken(
          bonds.flatMap((bond) =>
            bond !== null &&
            bond.status !== "retired" &&
            bond.token !== null &&
            bond.amount !== null
              ? [[bond.token, bond.amount] as [string, string]]
              : [],
          ),
        ),
  };
}

// ---- Earnings ---------------------------------------------------------------------------------

/** One win of one of the account's agents, from the task's outcome. */
export interface Win {
  agent: AgentRecord;
  taskId: string;
  title: string | null;
  token: string;
  /** The agent's share of the reward, in basis points of what is left after the fee. */
  bps: number;
  /** The fee the task was posted with, in basis points. */
  feeBps: number;
  /** What the agent was paid: its share of the reward, less the fee. The chain's figure. */
  net: bigint;
  /** The agent's part of the fee: the task's fee times its share. */
  fee: bigint;
  /** The agent's share before the fee: `net + fee`. */
  gross: bigint;
}

/** An entry that is revealed, on a task that has no outcome yet: it may still win. */
export interface Pending {
  agent: AgentRecord;
  taskId: string;
  title: string | null;
  phase: Phase;
}

export interface Earnings {
  wins: Win[];
  pending: Pending[];
  /** How many wins the entries list, and how many of those were read from their tasks. */
  winsListed: number;
  winsRead: number;
}

/** The phases in which a task has its outcome. */
const DECIDED: ReadonlySet<Phase> = new Set<Phase>(["settled", "expired"]);

/** The most tasks whose outcome the page reads for one visit. */
export const MAX_WIN_TASKS = 100;

/** `fn` over `items`, `limit` at a time, in their order. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** The win of `agent` in `detail`, if its outcome is a pick with the agent among the winners. */
export function winOf(agent: AgentRecord, detail: TaskDetailResponse): Win | null {
  const { task } = detail;
  const outcome = task.outcome;
  if (outcome === null || outcome.kind !== "picked") return null;
  const winner = outcome.winners.find((candidate) => candidate.account === agent.account);
  if (winner === undefined) return null;
  const net = BigInt(winner.amount);
  const fee = (BigInt(outcome.fee) * BigInt(winner.bps)) / 10_000n;
  return {
    agent,
    taskId: task.id,
    title: task.title,
    token: task.token,
    bps: winner.bps,
    feeBps: task.fee_bps,
    net,
    fee,
    gross: net + fee,
  };
}

/**
 * What `agents` won and what they still wait on: each agent's entries (`GET /v1/entries`), and for
 * the tasks they won, the task's outcome (`GET /v1/tasks/:id`), the newest `MAX_WIN_TASKS` of them.
 * A task that can't be read is counted as listed and not read. Null once `wanted()` is false.
 */
export async function readEarnings(
  agents: readonly AgentRecord[],
  wanted: () => boolean = () => true,
): Promise<Earnings | null> {
  const lists = await mapLimit(agents, 4, (agent) => api.listEntries(agent.account));
  if (!wanted()) return null;
  const won: Array<{ agent: AgentRecord; entry: AccountEntry }> = [];
  const pending: Pending[] = [];
  lists.forEach(({ entries }, index) => {
    const agent = agents[index] as AgentRecord;
    for (const entry of entries) {
      if (entry.won) won.push({ agent, entry });
      else if (entry.revealed && !DECIDED.has(entry.phase)) {
        pending.push({ agent, taskId: entry.task_id, title: entry.title, phase: entry.phase });
      }
    }
  });
  // The newest tasks first: a task id grows with each task posted.
  const byNewest = (a: { taskId: string }, b: { taskId: string }) =>
    BigInt(b.taskId) > BigInt(a.taskId) ? 1 : BigInt(b.taskId) < BigInt(a.taskId) ? -1 : 0;
  const taskIds = [...new Set(won.map(({ entry }) => entry.task_id))]
    .map((taskId) => ({ taskId }))
    .sort(byNewest)
    .slice(0, MAX_WIN_TASKS)
    .map(({ taskId }) => taskId);
  const details = new Map<string, TaskDetailResponse>();
  await mapLimit(taskIds, 6, async (taskId) => {
    try {
      const detail = await api.getTask(taskId);
      if (detail !== null) details.set(taskId, detail);
    } catch (error) {
      // One task that can't be read leaves its win out of the sums, and the page says how many
      // were read; it does not take the page down.
      console.error(error);
    }
  });
  if (!wanted()) return null;
  const wins: Win[] = [];
  for (const { agent, entry } of won) {
    const detail = details.get(entry.task_id);
    const win = detail === undefined ? null : winOf(agent, detail);
    if (win !== null) wins.push(win);
  }
  wins.sort(byNewest);
  pending.sort(byNewest);
  return { wins, pending, winsListed: won.length, winsRead: wins.length };
}

/** The wins added up, token by token: before the fee, the fee, and what was paid. */
export function winTotals(wins: readonly Win[]): { gross: ByToken; fee: ByToken; net: ByToken } {
  return {
    gross: sumByToken(wins.map((win) => [win.token, win.gross])),
    fee: sumByToken(wins.map((win) => [win.token, win.fee])),
    net: sumByToken(wins.map((win) => [win.token, win.net])),
  };
}

// ---- As a poster --------------------------------------------------------------------------------

/** Where a posted task's reward is: locked in escrow, paid out, refunded, or due back to its funders. */
export type PostedState = "locked" | "paid" | "refunded" | "due-back" | "settled";

/** What became of `task`'s reward at `nowNs`. */
export function postedStateOf(task: TaskSummary, nowNs: bigint): PostedState {
  if (task.outcome_kind === "picked") return "paid";
  if (task.outcome_kind === "voided") return "refunded";
  const phase = phaseOfTask(task, nowNs);
  if (phase === "expired") return "due-back";
  if (phase === "settled") return "settled";
  return "locked";
}

export interface Posted {
  tasks: TaskSummary[];
  truncated: boolean;
}

/**
 * The tasks that fit `filter` (`GET /v1/tasks`), newest first, page after page, up to `MAX_PAGES`
 * of them. Null once `wanted()` is false: no more pages are asked for.
 */
export async function readTaskPages(
  filter: Omit<ListTasksFilter, "limit" | "cursor">,
  wanted: () => boolean = () => true,
): Promise<Posted | null> {
  const tasks: TaskSummary[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const answer = await api.listTasks({ ...filter, limit: PAGE_SIZE, cursor });
    if (!wanted()) return null;
    tasks.push(...answer.tasks);
    if (answer.next_cursor === null) return { tasks, truncated: false };
    cursor = answer.next_cursor;
  }
  return { tasks, truncated: true };
}

/** The tasks `account` posted (`GET /v1/tasks?poster=`), newest first, page after page. */
export function readPosted(
  account: string,
  wanted: () => boolean = () => true,
): Promise<Posted | null> {
  return readTaskPages({ poster: account }, wanted);
}

/** The rewards of `tasks`, added up token by token, by where each one is at `nowNs`. */
export function postedTotals(
  tasks: readonly TaskSummary[],
  nowNs: bigint,
): Record<"locked" | "paid" | "refunded", ByToken> {
  const of = (states: PostedState[]) =>
    sumByToken(
      tasks
        .filter((task) => states.includes(postedStateOf(task, nowNs)))
        .map((task) => [task.token, task.reward]),
    );
  return { locked: of(["locked", "due-back"]), paid: of(["paid"]), refunded: of(["refunded"]) };
}
