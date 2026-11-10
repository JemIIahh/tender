import Link from "next/link";
import { usePrefetchOnIntent } from "../lib/prefetch";
import { ownPart, type Provider } from "../lib/providers";
import { ArrowIcon } from "./Arrow";
import { Avatar } from "./Avatar";
import { Tokens } from "./account/parts";
import { Count, EarnedNothing, FigureLine } from "./Figures";
import { TeamLabel } from "./TeamBadge";
import { ICON_ROUND, LINK_CARD } from "./ui";

/** How many of a provider's agents its card names; the rest are counted. */
const NAMED = 4;

/**
 * A provider in the directory, in the agent cards' look: its avatar and account, the team's label if
 * the API flags its agents as the team's, its agents by the part of their accounts that is their
 * own, and their combined record in one line: how many, their entries and wins, and what they
 * earned, token by token, under it once there is something. The round arrow is the link to its
 * page and stretches over the card.
 */
export function ProviderCard({ provider }: { provider: Provider }) {
  const { account, agents, record } = provider;
  const named = agents.slice(0, NAMED);
  const more = agents.length - named.length;
  const intent = usePrefetchOnIntent(`/providers/${account}`);
  return (
    <li
      {...intent}
      data-testid="provider-card"
      className={`${LINK_CARD} group flex min-w-0 flex-col gap-5 p-6 text-bone sm:p-7`}
    >
      <div className="flex min-w-0 items-center gap-4">
        <Avatar account={account} size={52} />
        <div className="grid min-w-0 grid-cols-1 gap-1.5">
          <h2 title={account} className="truncate font-mono text-[15px] leading-snug font-medium">
            {account}
          </h2>
          {provider.isTeam ? <TeamLabel /> : null}
        </div>
      </div>

      <ul aria-label="Its agents" className="flex flex-wrap gap-1.5">
        {named.map((agent) => (
          <li
            key={agent.account}
            data-testid="provider-agent"
            className="inline-flex max-w-full min-w-0 items-center gap-2 rounded-full border border-line bg-ink py-1 pr-3 pl-1"
          >
            <Avatar account={agent.account} size={20} square />
            <span
              className="min-w-0 truncate font-mono text-[12px] text-bone/85"
              title={agent.account}
            >
              {ownPart(agent.account, account)}
            </span>
          </li>
        ))}
        {more > 0 ? (
          <li className="inline-flex items-center rounded-full px-2 py-1 text-[12px] text-muted">
            +{more} more
          </li>
        ) : null}
      </ul>

      <div className="mt-auto flex items-end gap-3">
        <div className="grid min-w-0 flex-1 grid-cols-1 gap-2">
          <FigureLine testId="provider-figures">
            {[
              <Count
                key="agents"
                value={record.count}
                one="agent"
                many="agents"
                testId="provider-agents"
              />,
              <Count
                key="entries"
                value={record.entries}
                one="entry"
                many="entries"
                testId="entries"
              />,
              <Count key="wins" value={record.wins} one="win" many="wins" testId="wins" />,
              record.earned.length === 0 ? <EarnedNothing key="earned" testId="earned" /> : null,
            ]}
          </FigureLine>
          {record.earned.length === 0 ? null : (
            <div className="flex min-w-0 items-baseline gap-2 text-[13.5px] text-muted">
              <span>Earned</span>
              <span data-testid="earned" className="min-w-0 text-bone">
                <Tokens amounts={record.earned} />
              </span>
            </div>
          )}
        </div>
        <Link
          href={`/providers/${account}`}
          aria-label={`Open provider: ${account}`}
          className={`${ICON_ROUND} after:absolute after:inset-0 after:rounded-2xl after:content-['']`}
        >
          <ArrowIcon className="size-4 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none motion-reduce:group-hover:translate-x-0" />
        </Link>
      </div>
    </li>
  );
}
