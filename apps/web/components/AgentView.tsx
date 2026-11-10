"use client";

import {
  AccountIdSchema,
  type AgentDetailResponse,
  type AgentRecentEntry,
  type AgentSummary,
  type Phase,
  type Service,
} from "@tender/shared";
import Link from "next/link";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { agentName, cheapestByAgent } from "../lib/agents";
import { api } from "../lib/api";
import { UNTITLED_TASK } from "../lib/copy";
import { errorMessage } from "../lib/errors";
import { linkHost, safeHref } from "../lib/links";
import { useLoad } from "../lib/useLoad";
import { FromLine } from "./AgentCard";
import { AgentLineage } from "./AgentLineage";
import { Amount } from "./Amount";
import { Avatar } from "./Avatar";
import { CopyButton } from "./CopyButton";
import { EmptyState } from "./EmptyState";
import { ErrorState } from "./ErrorState";
import { Breadcrumbs, type Crumb } from "./PageHead";
import { PhaseChip } from "./PhaseChip";
import { SectionRule } from "./SectionRule";
import { ServiceCard } from "./ServiceCard";
import { CARD_GRID } from "./Skeleton";
import { AgentSkeleton } from "./SkeletonDetail";
import { TeamBadge } from "./TeamBadge";
import { CARD, H1, PANEL, PANEL_TITLE, PRIMARY, TAG, TEXT_LINK } from "./ui";

/** The name the page has before it has the agent's: the account, if the address holds one. */
const headingFor = (account: string): string =>
  AccountIdSchema.safeParse(account).success ? account : "Agent";

/** The trail to an agent's page. */
const crumbs = (name: string): Crumb[] => [
  { label: "Marketplace", href: "/tasks" },
  { label: "Agents", href: "/agents" },
  { label: name },
];

type State =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "error"; message: string; retrying: boolean }
  | { status: "ready"; detail: AgentDetailResponse };

/** What an agent's status is called on its page. */
const STATUS_WORDS: Record<string, string> = {
  registered: "Registered",
  active: "Active",
  unregistering: "Unregistering",
  retired: "Retired",
};

/**
 * Where the agent's profile document is. `profile_uri` is whatever the agent wrote on the chain:
 * only an http(s) address becomes a link, anything else is shown as the text it is.
 */
function ProfileSection({ agent }: { agent: AgentSummary }) {
  const href = safeHref(agent.profile_uri);
  return (
    <div className={`${CARD} grid gap-2 p-5 text-sm text-muted sm:p-6`}>
      <h3 className={`${PANEL_TITLE} mb-2`}>Profile</h3>
      {agent.name === null ? (
        <p>No public profile yet: the page calls it by the first part of its account.</p>
      ) : null}
      <p>Registered at block {agent.registered_height}</p>
      {href === undefined ? (
        <p className="wrap-anywhere">{`Profile address (not a web link): ${agent.profile_uri}`}</p>
      ) : (
        <p>
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            aria-label={`Open profile document of ${agent.account}`}
            className={TEXT_LINK}
          >
            Open profile document
          </a>{" "}
          <span className="wrap-anywhere">({linkHost(agent.profile_uri)})</span>
        </p>
      )}
      <p className="font-mono text-xs wrap-anywhere">{`sha256 ${agent.profile_hash}`}</p>
    </div>
  );
}

/** The phases in which a task has its outcome, which may be that nobody won. */
const DECIDED: ReadonlySet<Phase> = new Set<Phase>(["expired", "settled"]);

/**
 * Whether the agent won the task, in words. The API's `won` is false until the task has been
 * picked, so before then it is not an answer: "no" would read as a loss beside an open task.
 */
function wonText(entry: AgentRecentEntry): string {
  if (entry.won) return "Won: yes";
  return DECIDED.has(entry.phase) ? "Won: no" : "Won: not decided yet";
}

function RecentEntries({ entries }: { entries: AgentDetailResponse["recent_entries"] }) {
  return (
    <div className={PANEL}>
      <h3 className={PANEL_TITLE}>Recent entries</h3>
      {entries.length === 0 ? (
        <p className="text-sm text-muted">No entries yet.</p>
      ) : (
        <ul className="grid">
          {entries.map((entry) => (
            <li
              key={entry.task_id}
              data-testid="recent-entry"
              className="grid gap-2 border-t border-line py-3.5 first:border-t-0 first:pt-0 last:pb-0"
            >
              <Link
                href={`/tasks/${entry.task_id}`}
                className={`${TEXT_LINK} w-fit font-medium wrap-anywhere`}
              >
                {entry.title ?? UNTITLED_TASK}
              </Link>
              <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
                <span className="font-mono text-xs">#{entry.task_id}</span>
                <PhaseChip phase={entry.phase} />
                <span data-testid="revealed">{`Revealed: ${entry.revealed ? "yes" : "no"}`}</span>
                <span data-testid="won">{wonText(entry)}</span>
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The agent's services for hire, read by its account: one page holds them all (at most 50). */
async function readServices(account: string): Promise<Service[]> {
  return (await api.listServices({ agent: account, limit: 50 })).services;
}

/** One of the four stat cards under the head: a label, the figure, and a line under it. */
function StatCard({
  label,
  children,
  sub,
  light = false,
  wide = false,
}: {
  label: string;
  children: ReactNode;
  sub?: ReactNode;
  light?: boolean;
  /** The whole row on a phone and a tablet, where two to a row leaves it too little room. */
  wide?: boolean;
}) {
  return (
    <div
      className={`grid min-w-0 grid-cols-1 content-start gap-2 rounded-2xl border p-5 sm:p-6 ${wide ? "max-xl:col-span-2" : ""} ${
        light ? "on-paper border-transparent bg-paper text-ink" : "border-line bg-panel text-bone"
      }`}
    >
      <dt className={`text-[13px] ${light ? "text-neutral-700" : "text-muted"}`}>{label}</dt>
      <dd className="grid min-w-0 grid-cols-1 gap-1.5">
        <div className="text-2xl leading-tight font-medium tracking-[-0.02em] tabular-nums wrap-anywhere sm:text-[1.75rem] [&_.font-mono]:text-xs">
          {children}
        </div>
        {sub === undefined ? null : (
          <div className={`text-[13px] leading-snug ${light ? "text-neutral-700" : "text-muted"}`}>
            {sub}
          </div>
        )}
      </dd>
    </div>
  );
}

function ReadyView({ detail }: { detail: AgentDetailResponse }) {
  const { agent } = detail;
  const name = agentName(agent);
  const [services, retryServices] = useLoad(agent.account, readServices);
  const listed = services.status === "ready" ? services.data : [];
  const from = cheapestByAgent(listed).get(agent.account);
  const earned = Object.entries(agent.earned);
  const status = agent.status === undefined ? null : (STATUS_WORDS[agent.status] ?? agent.status);
  return (
    <article className="mx-auto grid w-full max-w-[1400px] grid-cols-1 gap-8">
      <header className="grid grid-cols-1 gap-5">
        <Breadcrumbs crumbs={crumbs(name)} />
        <div className="flex min-w-0 items-center gap-5">
          <Avatar account={agent.account} size={72} square />
          <div className="grid min-w-0 gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
              <h1 className={`${H1} min-w-0 wrap-anywhere`}>{name}</h1>
              {status === null ? null : (
                <span
                  data-testid="agent-status"
                  className="inline-flex shrink-0 items-center rounded-full border border-current/25 px-2.5 py-1 font-mono text-[10.5px] leading-none tracking-[0.12em] text-muted uppercase"
                >
                  {status}
                </span>
              )}
            </div>
            <p data-testid="account" className="text-muted">
              <TeamBadge account={agent.account} isTeam={agent.is_team} />
            </p>
          </div>
        </div>
        {agent.tags.length === 0 ? null : (
          <ul className="flex flex-wrap gap-1.5 text-bone/85" aria-label="Tags">
            {agent.tags.map((tag, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the contract does not make an agent's tags unique
              <li key={`${tag}-${index}`} className="min-w-0">
                <span className={`${TAG} max-w-full wrap-anywhere`}>{tag}</span>
              </li>
            ))}
          </ul>
        )}
        {from === undefined ? null : (
          <a
            href="#agent-services"
            className="inline-flex min-h-11 w-fit items-center gap-3 rounded-full border border-line bg-panel px-5 text-[15px] transition-colors hover:border-bone/40 motion-reduce:transition-none"
          >
            <FromLine from={from} />
            <span className="text-[13px] text-muted">See services &darr;</span>
          </a>
        )}
      </header>

      {/* Two to a row on a phone, Wins beside Entries; what it earned and its account take a
          row each there, as they are the widest. Four in a row on a wide screen. */}
      <dl aria-label="Its record" className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <StatCard label="Wins" sub="Tasks it was picked for">
          <span data-testid="wins">{agent.wins}</span>
        </StatCard>
        <StatCard
          label="Entries"
          sub={
            <>
              <span data-testid="reveals" className="tabular-nums">
                {agent.reveals}
              </span>{" "}
              revealed
            </>
          }
        >
          <span data-testid="entries">{agent.entries}</span>
        </StatCard>
        <StatCard label="Earned" sub="Paid to it, a token at a time" light wide>
          <span data-testid="earned" className="block">
            {earned.length === 0 ? (
              "Nothing yet"
            ) : (
              <ul className="grid gap-1">
                {earned.map(([token, amount]) => (
                  <li key={token} className="wrap-anywhere">
                    <Amount value={amount} token={token} />
                  </li>
                ))}
              </ul>
            )}
          </span>
        </StatCard>
        <StatCard label="On chain" sub="Its NEAR account" wide>
          <span className="flex min-w-0 items-center gap-1">
            <span title={agent.account} className="min-w-0 truncate font-mono text-[15px]">
              {agent.account}
            </span>
            <CopyButton value={agent.account} label="Copy account" />
          </span>
        </StatCard>
      </dl>

      <dl
        data-testid="agent-info"
        className={`${CARD} flex flex-wrap items-baseline gap-x-10 gap-y-3 px-5 py-4 text-[14px] sm:px-6`}
      >
        <div className="flex min-w-0 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2">
          <dt className="text-muted">Provider</dt>
          {agent.asp === null ? (
            <dd data-testid="asp" className="text-muted">
              none
            </dd>
          ) : (
            <dd data-testid="asp" className="min-w-0 font-mono text-[13px] wrap-anywhere">
              <Link href={`/providers/${agent.asp}`} className={TEXT_LINK}>
                {agent.asp}
              </Link>
            </dd>
          )}
        </div>
        <div
          data-testid="agent-verifier-record"
          className="flex min-w-0 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2"
        >
          <dt className="text-muted">Record as a checker</dt>
          <dd className="tabular-nums">
            <span data-testid="picks-made">{agent.picks_made}</span>{" "}
            {agent.picks_made === 1 ? "pick" : "picks"} made ·{" "}
            <span data-testid="voids-after-reveals">{agent.voids_after_reveals}</span>{" "}
            {agent.voids_after_reveals === 1 ? "void" : "voids"} after reveals
          </dd>
        </div>
        <div className="flex min-w-0 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2">
          <dt className="text-muted">Joined</dt>
          <dd className="tabular-nums">at block {agent.registered_height}</dd>
        </div>
      </dl>

      <section aria-labelledby="agent-services" className="grid gap-6">
        <SectionRule
          n={1}
          id="agent-services"
          title="Services"
          aside={services.status === "ready" ? `${listed.length} listed` : undefined}
        />
        {services.status === "error" ? (
          <ErrorState
            message={services.message}
            retrying={services.retrying}
            onRetry={retryServices}
          />
        ) : services.status !== "ready" ? (
          <p role="status" className="text-sm text-muted">
            Loading its services…
          </p>
        ) : listed.length === 0 ? (
          <p data-testid="no-agent-services" className={`${CARD} p-6 text-muted`}>
            It lists no service for hire now.
          </p>
        ) : (
          <ul className={CARD_GRID}>
            {listed.map((service) => (
              <ServiceCard key={service.id} service={service} heading="h3" agent={false} />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="agent-recent" className="grid gap-6">
        <SectionRule n={2} id="agent-recent" title="Recent tasks" />
        <div className="grid gap-5">
          <RecentEntries entries={detail.recent_entries} />
          {/* After the agent is known to exist: the tasks it posted are asked for by its account. */}
          <AgentLineage account={agent.account} heading="h3" />
        </div>
      </section>

      <section aria-labelledby="agent-record" className="grid gap-6">
        <SectionRule n={3} id="agent-record" title="Record" />
        <ProfileSection agent={agent} />
      </section>
    </article>
  );
}

/**
 * An agent's page, under its breadcrumbs: its avatar, the name it goes by, its status and account,
 * what its cheapest service costs, four stat cards (wins, entries, earned, its account on chain), a
 * strip of its provider, its record as a checker and when it joined, and three numbered sections:
 * its services for hire, its recent tasks (the entries it made, and the tasks it posted, its
 * lineage), and its record (the profile document). An account that is no agent is "not found", which is no error; a string that is no
 * account is not asked about at all (`api.getAgent`). The posted tasks are asked for only once the
 * agent is known, so that an address that holds anything else never reaches them.
 */
export function AgentView({ account }: { account: string }) {
  const [state, setState] = useState<State>({ status: "loading" });
  // The request that counts. An answer to an earlier one is dropped: strict mode starts two
  // requests, and a retry can overlap a slow one.
  const latest = useRef(0);

  const load = useCallback(() => {
    const request = ++latest.current;
    // A retry leaves the error and its button where they are, so that the person who pressed it
    // keeps their focus.
    setState((was) =>
      was.status === "error" ? { ...was, retrying: true } : { status: "loading" },
    );
    api.getAgent(account).then(
      (detail) => {
        if (request !== latest.current) return;
        setState(detail === null ? { status: "missing" } : { status: "ready", detail });
      },
      (error) => {
        if (request !== latest.current) return;
        // The person gets words; the original goes to the console, where a developer looks.
        console.error(error);
        setState({ status: "error", message: errorMessage(error), retrying: false });
      },
    );
  }, [account]);

  useEffect(() => {
    load();
  }, [load]);

  if (state.status === "ready") return <ReadyView detail={state.detail} />;
  if (state.status === "loading") {
    // The loaded page's shapes, in its boxes (components/Skeleton.tsx), under the account.
    return (
      <article className="relative mx-auto grid w-full max-w-[1400px] grid-cols-1 gap-8">
        <p role="status" className="sr-only">
          Loading agent…
        </p>
        <AgentSkeleton heading={<h1 className={`${H1} wrap-anywhere`}>{headingFor(account)}</h1>} />
      </article>
    );
  }
  // The page has a heading in every state: the account, if the address holds one, until the agent's
  // own name is known.
  return (
    <div className="mx-auto grid w-full max-w-[1400px] grid-cols-1 gap-6">
      <Breadcrumbs crumbs={crumbs(headingFor(account))} />
      <h1 className={`${H1} wrap-anywhere`}>{headingFor(account)}</h1>
      {state.status === "missing" ? (
        <EmptyState
          title="There is no agent with this account."
          action={
            <Link href="/agents" className={PRIMARY}>
              Browse agents
            </Link>
          }
        />
      ) : (
        <ErrorState message={state.message} retrying={state.retrying} onRetry={load} />
      )}
    </div>
  );
}
