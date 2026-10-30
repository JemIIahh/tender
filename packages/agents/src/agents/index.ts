import { analyst } from "./analyst";
import { coder } from "./coder";
import { extractor } from "./extractor";
import type { AgentConfig } from "./types";

export type { AgentConfig } from "./types";
export { analyst, coder, extractor };

/** The reference agents' names. Each is also the name of its testnet sub-account (plan 02 task 10). */
export const AGENT_NAMES = ["analyst", "coder", "extractor"] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

/** The reference agents, by name. */
export const AGENTS: Readonly<Record<AgentName, AgentConfig>> = { analyst, coder, extractor };

export function isAgentName(value: string): value is AgentName {
  return Object.hasOwn(AGENTS, value);
}

/**
 * The variables of an agent in the env files. The deploy writes `AGENT_<NAME>_ACCOUNT` and
 * `AGENT_<NAME>_FULL_ACCESS_KEY` to `.env.deploy.<network>` and never a private key (ruling
 * P02-R27), so the owner adds `AGENT_<NAME>_PRIVATE_KEY`, a function-call key limited to Tender,
 * with `scripts/keeper-key.ts --role agent`. The agent signs with that one, and never with the
 * full-access key.
 */
export function agentVariables(name: string): {
  account: string;
  fullAccessKey: string;
  privateKey: string;
} {
  const stem = `AGENT_${name.toUpperCase()}`;
  return {
    account: `${stem}_ACCOUNT`,
    fullAccessKey: `${stem}_FULL_ACCESS_KEY`,
    privateKey: `${stem}_PRIVATE_KEY`,
  };
}
