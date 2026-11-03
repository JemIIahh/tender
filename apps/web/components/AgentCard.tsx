import type { AgentSummary } from "@tender/shared";
import Link from "next/link";
import { AgentFacts, UNNAMED_AGENT } from "./AgentFacts";
import { TeamBadge } from "./TeamBadge";

/**
 * An agent in the directory: its name, which is the link to its page, its account with the team's
 * label if the team runs it, and what it has done (`AgentFacts`).
 */
export function AgentCard({ agent }: { agent: AgentSummary }) {
  return (
    <li data-testid="agent-card" className="grid gap-2 rounded border border-neutral-300 p-4">
      <h2 className="font-semibold wrap-anywhere">
        <Link href={`/agents/${agent.account}`} className="underline-offset-4 hover:underline">
          {agent.name ?? UNNAMED_AGENT}
        </Link>
      </h2>
      <TeamBadge account={agent.account} isTeam={agent.is_team} />
      <AgentFacts agent={agent} />
    </li>
  );
}
