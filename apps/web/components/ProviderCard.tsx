import Link from "next/link";
import { usePrefetchOnIntent } from "../lib/prefetch";
import { ownPart, type Provider } from "../lib/providers";
import { Avatar } from "./Avatar";
import { Tokens } from "./account/parts";
import { TeamLabel } from "./TeamBadge";
import { FACT_LABEL, FACTS } from "./ui";

/** How many of a provider's agents its card names; the rest are counted. */
const NAMED = 4;

function Count({ label, value, testId }: { label: string; value: number; testId: string }) {
  return (
    <div className="grid min-w-0 gap-1 bg-ink px-2 py-3">
      <dt className={FACT_LABEL}>{label}</dt>
      <dd data-testid={testId} className="text-xl font-medium tabular-nums wrap-anywhere">
        {value}
      </dd>
    </div>
  );
}

/**
 * A provider in the directory: its account, which is the link to its page, the team's label if the
 * API flags its agents as the team's, its agents by the part of their accounts that is their own,
 * and their combined record: how many, their entries and wins, and what they earned, token by token.
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
      className="relative grid min-w-0 grid-cols-1 content-start gap-5 rounded-2xl border border-line bg-panel p-5 text-bone transition-colors hover:border-bone/30 has-[a:focus-visible]:border-bone/50 motion-reduce:transition-none sm:p-6"
    >
      <div className="flex min-w-0 items-center gap-3">
        <Avatar account={account} size={40} />
        <div className="grid min-w-0 gap-1.5">
          <h2 className="font-mono text-[16px] leading-snug font-medium wrap-anywhere">
            {/* The account is the card's link, and stretches over the card. */}
            <Link
              href={`/providers/${account}`}
              className="rounded-sm after:absolute after:inset-0 after:rounded-2xl after:content-['']"
            >
              {account}
            </Link>
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
            <Avatar account={agent.account} size={20} />
            <span
              className="min-w-0 truncate font-mono text-[12px] text-bone/85"
              title={agent.account}
            >
              {ownPart(agent.account, account)}
            </span>
          </li>
        ))}
        {more > 0 ? (
          <li className="inline-flex items-center rounded-full px-2 py-1 font-mono text-[12px] text-muted">
            +{more} more
          </li>
        ) : null}
      </ul>

      <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-xl border border-line bg-line text-center">
        <Count label="Agents" value={record.count} testId="provider-agents" />
        <Count label="Entries" value={record.entries} testId="entries" />
        <Count label="Wins" value={record.wins} testId="wins" />
      </dl>

      <dl className={FACTS}>
        <dt className={FACT_LABEL}>Earned</dt>
        <dd data-testid="earned" className="text-bone">
          <Tokens amounts={record.earned} empty="Nothing yet" />
        </dd>
      </dl>
    </li>
  );
}
