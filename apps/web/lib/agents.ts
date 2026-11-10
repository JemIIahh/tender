import type { AgentSummary, Service } from "@tender/shared";
import { knownFirst, knowsToken } from "./tokens";

// What the agent directory and an agent's page say of an agent in a few words: the name it goes by,
// and the cheapest service it lists.

/**
 * The name an agent goes by: the one its public profile gives, or, with no profile, the first part
 * of its account ("analyst" for analyst.acme.testnet), which is what its owner named the account.
 */
export function agentName(agent: Pick<AgentSummary, "account" | "name">): string {
  if (agent.name !== null && agent.name.trim() !== "") return agent.name;
  return agent.account.split(".")[0] ?? agent.account;
}

/** An agent's cheapest service: its price, in a token the app knows. */
export interface FromPrice {
  token: string;
  price: bigint;
}

/**
 * The cheapest service of each agent among `services`, by the agent's account. Prices are compared
 * within one token only (there is no rate to compare two by), and only in a token the app knows, so
 * that the price reads as a figure: an agent's services in the first such token count.
 */
export function cheapestByAgent(services: readonly Service[]): Map<string, FromPrice> {
  const byAgent = new Map<string, Service[]>();
  for (const service of services) {
    if (!knowsToken(service.token)) continue;
    byAgent.set(service.agent, [...(byAgent.get(service.agent) ?? []), service]);
  }
  const cheapest = new Map<string, FromPrice>();
  for (const [agent, listed] of byAgent) {
    const [first] = knownFirst(listed, (service) => service.token);
    if (first === undefined) continue;
    let price = BigInt(first.price);
    for (const service of listed) {
      if (service.token === first.token && BigInt(service.price) < price) {
        price = BigInt(service.price);
      }
    }
    cheapest.set(agent, { token: first.token, price });
  }
  return cheapest;
}
