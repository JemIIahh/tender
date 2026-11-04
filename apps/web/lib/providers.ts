import { AccountIdSchema } from "@tender/shared";
import { type AgentsRecord, combinedRecord } from "./account";
import { type AgentRecord, api } from "./api";

// Agent service providers (ASPs): the accounts that run agents as sub-accounts of their own. An
// agent's provider is the `asp` the API gives it (the contract's rule: its account's parent, when
// the parent has two labels or more), so a provider is never guessed here from a name.
//
// The directory (/providers) groups every agent the API lists by that field; a provider's page
// (/providers/[account]) asks for the agents under one account (`GET /v1/agents?asp=`). Every
// figure is the API's, added up as `combinedRecord` adds them for My agents: token by token, and
// nothing estimated to fill a gap.

/** The API's largest page, and how many pages a list reads before it stops: 500 agents. */
const PAGE_SIZE = 50;
const MAX_PAGES = 10;

export interface Provider {
  account: string;
  /** Its agents, in the API's order (by account). */
  agents: AgentRecord[];
  record: AgentsRecord;
  /**
   * The API flags every one of its agents as the team's. It does that for each agent under a team
   * account, so this is how a team provider is told, with nothing listed here of our own.
   */
  isTeam: boolean;
}

function providerOf(account: string, agents: AgentRecord[]): Provider {
  return {
    account,
    agents,
    record: combinedRecord(agents),
    isTeam: agents.length > 0 && agents.every((agent) => agent.is_team),
  };
}

/** Byte order, as the API orders accounts: an account id is ASCII. */
const byAccount = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The providers among `agents`, each with its agents and their combined record: the largest fleet
 * first, then by account. An agent with no provider is in no group, and neither is one whose
 * provider could not be one (`canProvide`): the registry never records such a provider, so an
 * answer that names one is not shown as a provider.
 */
export function groupProviders(agents: readonly AgentRecord[]): Provider[] {
  const fleets = new Map<string, AgentRecord[]>();
  for (const agent of agents) {
    if (agent.asp === null || !canProvide(agent.asp)) continue;
    const fleet = fleets.get(agent.asp);
    if (fleet === undefined) fleets.set(agent.asp, [agent]);
    else fleet.push(agent);
  }
  return [...fleets]
    .map(([account, fleet]) => providerOf(account, fleet))
    .sort((a, b) => b.agents.length - a.agents.length || byAccount(a.account, b.account));
}

/** Every page of `GET /v1/agents` with `asp`, or of all agents, up to `MAX_PAGES`. */
async function readAgents(
  asp: string | undefined,
  wanted: () => boolean,
): Promise<{ agents: AgentRecord[]; truncated: boolean } | null> {
  const agents: AgentRecord[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const answer = await api.listAgentRecords({ asp, limit: PAGE_SIZE, cursor });
    if (!wanted()) return null;
    agents.push(...answer.agents);
    if (answer.next_cursor === null) return { agents, truncated: false };
    cursor = answer.next_cursor;
  }
  return { agents, truncated: true };
}

export interface Providers {
  providers: Provider[];
  /** How many agents were read, with a provider or not. */
  agentsRead: number;
  /** There were more agents than the directory reads: a fleet may be counted in part. */
  truncated: boolean;
}

/** The provider directory: every agent the API lists, grouped. Null once `wanted()` is false. */
export async function readProviders(wanted: () => boolean = () => true): Promise<Providers | null> {
  const read = await readAgents(undefined, wanted);
  if (read === null) return null;
  return {
    providers: groupProviders(read.agents),
    agentsRead: read.agents.length,
    truncated: read.truncated,
  };
}

export interface Fleet extends Provider {
  /** There were more agents under it than the page reads. */
  truncated: boolean;
}

/** The agents under `account`, and their combined record. Null once `wanted()` is false. */
export async function readFleet(
  account: string,
  wanted: () => boolean = () => true,
): Promise<Fleet | null> {
  const read = await readAgents(account, wanted);
  if (read === null) return null;
  return { ...providerOf(account, read.agents), truncated: read.truncated };
}

/**
 * Whether `account` can be a provider: an account id of two labels or more, as `acme.near` is. The
 * registry gives no agent a provider of one label (`near`, or an implicit account).
 */
export function canProvide(account: string): boolean {
  return AccountIdSchema.safeParse(account).success && account.includes(".");
}

/**
 * The part of an agent's account that is its own under `provider`: `writer` for `writer.acme.near`
 * under `acme.near`. An account that is not under it is given whole.
 */
export function ownPart(agent: string, provider: string): string {
  return agent.endsWith(`.${provider}`) ? agent.slice(0, -provider.length - 1) : agent;
}
