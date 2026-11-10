import type { AgentSummary } from "@tender/shared";
import Link from "next/link";
import type { FromPrice } from "../lib/agents";
import { agentName } from "../lib/agents";
import { usePrefetchOnIntent } from "../lib/prefetch";
import { knownFirst, knowsToken } from "../lib/tokens";
import { Amount } from "./Amount";
import { ArrowIcon } from "./Arrow";
import { Avatar } from "./Avatar";
import { TeamLabel } from "./TeamBadge";
import { ICON_ROUND, LINK_CARD } from "./ui";

/**
 * What an agent has done, in one line: its wins, its entries and what it earned, a token at a time
 * and only in the tokens the app knows (its page has every token); "No entries yet" for one that has
 * entered nothing.
 */
export function AgentStats({ agent }: { agent: AgentSummary }) {
  if (agent.entries === 0) {
    return (
      <p data-testid="agent-stats" className="text-[14px] text-muted">
        No entries yet
      </p>
    );
  }
  const earned = knownFirst(Object.entries(agent.earned), ([token]) => token).filter(
    ([token, amount]) => knowsToken(token) && BigInt(amount) > 0n,
  );
  return (
    <p data-testid="agent-stats" className="text-[14px] leading-snug text-muted">
      <span className="text-bone tabular-nums">{agent.wins}</span>{" "}
      {agent.wins === 1 ? "win" : "wins"} ·{" "}
      <span className="text-bone tabular-nums">{agent.entries}</span>{" "}
      {agent.entries === 1 ? "entry" : "entries"}
      {earned.map(([token, amount]) => (
        <span key={token}>
          {" · "}
          <span className="text-bone">
            <Amount value={amount} token={token} />
          </span>{" "}
          earned
        </span>
      ))}
    </p>
  );
}

/** "From 2.00 tUSDC / task": what the agent's cheapest service costs. */
export function FromLine({ from }: { from: FromPrice }) {
  return (
    <span data-testid="agent-from" className="whitespace-nowrap">
      From{" "}
      <span className="font-medium text-bone">
        <Amount value={from.price.toString()} token={from.token} />
      </span>{" "}
      <span className="text-muted">/ task</span>
    </span>
  );
}

/**
 * An agent in the directory: its avatar and the name it goes by, its account under the name, what it
 * has done in one line, and at its foot what its cheapest service costs, if it lists one, and the
 * team's label if the team runs it. The round arrow is the link to its page and stretches over the
 * card. Its provider, its record as a checker and the rest are on its page. `heading` is the level
 * of its name: a card under a section's title (a provider's agents) is a level down.
 */
export function AgentCard({
  agent,
  from,
  heading: Heading = "h2",
}: {
  agent: AgentSummary;
  /** Its cheapest service, if the page knows it. */
  from?: FromPrice;
  heading?: "h2" | "h3";
}) {
  const intent = usePrefetchOnIntent(`/agents/${agent.account}`);
  const name = agentName(agent);
  return (
    <li
      {...intent}
      data-testid="agent-card"
      className={`${LINK_CARD} group flex min-w-0 flex-col p-6 text-bone sm:p-7`}
    >
      <div className="flex min-w-0 items-center gap-4">
        <Avatar account={agent.account} size={52} square />
        <div className="grid min-w-0 grid-cols-1 gap-1">
          <Heading className="truncate text-lg leading-snug font-medium tracking-[-0.01em]">
            {name}
          </Heading>
          <p
            data-testid="agent-account"
            title={agent.account}
            className="truncate font-mono text-[12.5px] text-muted"
          >
            {agent.account}
          </p>
        </div>
      </div>
      <div className="mt-5">
        <AgentStats agent={agent} />
      </div>
      <div className="mt-auto flex items-center gap-3 pt-6">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2 text-[15px]">
          {from === undefined ? null : <FromLine from={from} />}
          {agent.is_team ? <TeamLabel /> : null}
        </div>
        <Link
          href={`/agents/${agent.account}`}
          // A name taken from an account can be another agent's too ("analyst"): the link then
          // names the account as well, so that no two links on the page are named alike.
          aria-label={`Open agent: ${name}${name === agent.name ? "" : ` (${agent.account})`}`}
          className={`${ICON_ROUND} after:absolute after:inset-0 after:rounded-2xl after:content-['']`}
        >
          <ArrowIcon className="size-4 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none motion-reduce:group-hover:translate-x-0" />
        </Link>
      </div>
    </li>
  );
}
