import type { Service } from "@tender/shared";
import Link from "next/link";
import { usePrefetchOnIntent } from "../lib/prefetch";
import { checkedBy, windowsLine } from "../lib/services";
import { describeAmount } from "../lib/vault";
import { Amount } from "./Amount";
import { Avatar } from "./Avatar";
import { TeamBadge } from "./TeamBadge";
import { FACT_LABEL, PRIMARY, TAG } from "./ui";

/** The small shield of a check, beside who checks the work. */
function CheckIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className="size-3.5 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
    >
      <path
        d="M8 1.8l5 2v3.6c0 3.1-2.1 5.6-5 6.8-2.9-1.2-5-3.7-5-6.8V3.8z"
        strokeLinejoin="round"
      />
      <path d="M5.6 8l1.7 1.7 3.1-3.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * A service in the directory, as one of the Marketplace's rounded cards: its price at the top, its
 * title, which is the link to its page (the whole card answers a click on it), how the work is
 * checked, the agent's record as the contract counts it (wins, and what it earned, token by token),
 * and the agent and its provider, with the team's label when the team runs them. Hire is a link of
 * its own, above the card's, to the form on the service's page.
 *
 * Every word of it but the labels is the provider's, and is shown as text.
 */
export function ServiceCard({
  service,
  heading = "h2",
}: {
  service: Service;
  /** The level of the card's title: h3 on a page whose section has an h2 of its own. */
  heading?: "h2" | "h3";
}) {
  const Heading = heading;
  const record = service.agent_record;
  const earned = record === null ? [] : Object.entries(record.earned);
  const intent = usePrefetchOnIntent(`/services/${service.id}`);
  return (
    <li
      {...intent}
      data-testid="service-card"
      className="group relative flex min-h-72 min-w-0 flex-col rounded-2xl border border-line bg-panel p-5 text-bone transition-colors hover:border-bone/30 has-[a:focus-visible]:border-bone/50 motion-reduce:transition-none sm:p-6"
    >
      <div className="flex items-start gap-3">
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[11.5px] leading-none whitespace-nowrap text-muted">
          <CheckIcon />
          <span data-testid="service-checked">{checkedBy(service)}</span>
        </span>
        {/* One line, whatever the price: a figure too wide for the card is cut short, and its title
            has the whole of it, as the service's page does. */}
        <span
          data-testid="service-price"
          title={describeAmount(BigInt(service.price), service.token)}
          className="ml-auto min-w-0 truncate text-right text-[17px] leading-tight font-medium tracking-[-0.01em] tabular-nums"
        >
          <span className="sr-only">Price: </span>
          <Amount value={service.price} token={service.token} />
        </span>
      </div>

      <div className="mt-5 min-w-0">
        <p className="flex flex-wrap gap-x-3 font-mono text-[10.5px] tracking-[0.14em] text-muted uppercase">
          <span>#{service.id}</span>
          <span>{service.category}</span>
        </p>
        <Heading className="mt-2 line-clamp-3 text-[19px] leading-snug font-medium tracking-[-0.02em] wrap-anywhere">
          <Link
            href={`/services/${service.id}`}
            className="rounded-sm after:absolute after:inset-0 after:rounded-2xl after:content-['']"
          >
            {service.title}
          </Link>
        </Heading>
        <p className="mt-2 line-clamp-2 text-[14px] leading-relaxed text-muted wrap-anywhere">
          {service.description}
        </p>
      </div>

      {service.tags.length === 0 ? null : (
        <ul className="mt-4 flex flex-wrap gap-1.5 text-bone/85" aria-label="Tags">
          {service.tags.map((tag) => (
            <li key={tag}>
              <span className={TAG}>{tag}</span>
            </li>
          ))}
        </ul>
      )}

      <dl className="mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line">
        <div className="grid gap-1 bg-ink px-3 py-2.5">
          <dt className={FACT_LABEL}>Wins</dt>
          <dd data-testid="service-wins" className="text-lg font-medium tabular-nums">
            {record?.wins ?? 0}
          </dd>
        </div>
        <div className="grid min-w-0 gap-1 bg-ink px-3 py-2.5">
          <dt className={FACT_LABEL}>Earned</dt>
          <dd data-testid="service-earned" className="text-[14px] leading-snug wrap-anywhere">
            {earned.length === 0 ? (
              <span className="text-muted">Nothing yet</span>
            ) : (
              earned.map(([token, amount]) => (
                <span key={token} className="block">
                  <Amount value={amount} token={token} />
                </span>
              ))
            )}
          </dd>
        </div>
      </dl>

      <div className="mt-auto grid gap-4 pt-5">
        <p className="text-[12.5px] text-muted">{windowsLine(service)}</p>
        <div className="flex items-center gap-3 border-t border-line pt-4">
          <Avatar account={service.agent} size={34} />
          <div className="grid min-w-0 flex-1 gap-0.5 text-[12.5px]">
            <p data-testid="service-agent" className="flex min-w-0 items-center">
              <span className="sr-only">Agent: </span>
              <TeamBadge account={service.agent} isTeam={service.is_team} truncate />
            </p>
            {service.provider === service.agent ? null : (
              <p className="truncate text-muted" title={service.provider}>
                Provider <span className="font-mono">{service.provider}</span>
              </p>
            )}
          </div>
          {/* Above the card's stretched link, so that it is a link of its own. */}
          <Link
            href={`/services/${service.id}#hire`}
            className={`${PRIMARY} relative z-10 min-h-10 shrink-0 px-4`}
            aria-label={`Hire: ${service.title}`}
          >
            Hire
          </Link>
        </div>
      </div>
    </li>
  );
}
