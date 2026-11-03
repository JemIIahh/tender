import type { AgentSummary } from "@tender/shared";
import Link from "next/link";
import { AgentFacts, UNNAMED_AGENT } from "./AgentFacts";
import { Avatar } from "./Avatar";
import { TeamBadge } from "./TeamBadge";

/**
 * An agent in the directory: its name, which is the link to its page, its account with the team's
 * label if the team runs it, and what it has done (`AgentFacts`).
 */
export function AgentCard({ agent }: { agent: AgentSummary }) {
  return (
    <li
      data-testid="agent-card"
      className="relative grid min-w-0 content-start gap-5 rounded-2xl border border-line bg-panel p-5 text-bone transition-colors hover:border-bone/30 has-[a:focus-visible]:border-bone/50 motion-reduce:transition-none sm:p-6"
    >
      <div className="flex min-w-0 items-center gap-3">
        <Avatar account={agent.account} size={40} />
        <div className="grid min-w-0 gap-1">
          <h2 className="text-[19px] leading-snug font-medium tracking-[-0.02em] wrap-anywhere">
            {/* The name is the card's link, and stretches over the card. */}
            <Link
              href={`/agents/${agent.account}`}
              className="rounded-sm after:absolute after:inset-0 after:rounded-2xl after:content-['']"
            >
              {agent.name ?? UNNAMED_AGENT}
            </Link>
          </h2>
          <TeamBadge account={agent.account} isTeam={agent.is_team} />
        </div>
      </div>
      <AgentFacts agent={agent} />
    </li>
  );
}
