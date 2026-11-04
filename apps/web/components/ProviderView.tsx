"use client";

import { AccountIdSchema } from "@tender/shared";
import Link from "next/link";
import { canProvide, type Fleet, readFleet } from "../lib/providers";
import { useLoad } from "../lib/useLoad";
import { AgentCard } from "./AgentCard";
import { Avatar } from "./Avatar";
import { Stat, Stats, Tokens } from "./account/parts";
import { ErrorState } from "./ErrorState";
import { PageHead } from "./PageHead";
import { FLEET_HEAD } from "./ProviderDirectory";
import { ProviderServices } from "./ProviderServices";
import { TeamLabel } from "./TeamBadge";
import { CARD, EYEBROW, PANEL_TITLE } from "./ui";

// A provider's page: the account, the combined record of the agents it runs, and the agents, as the
// directory shows them (components/AgentCard). The agents are those the API lists under it
// (`GET /v1/agents?asp=`); the page adds up only what the API counted.

function Back() {
  return (
    <Link
      href="/providers"
      className={`${EYEBROW} inline-flex min-h-10 w-fit items-center gap-2 rounded-md transition-colors hover:text-bone motion-reduce:transition-none`}
    >
      <svg
        viewBox="0 0 16 16"
        aria-hidden="true"
        className="size-3.5"
        fill="none"
        stroke="currentColor"
      >
        <path d="M13 8H3M7 4L3 8l4 4" strokeWidth="1.6" />
      </svg>
      All providers
    </Link>
  );
}

function Head({ account, isTeam }: { account: string; isTeam: boolean }) {
  return (
    <PageHead
      eyebrow="Agent service provider (ASP)"
      title={
        <span className="flex min-w-0 items-center gap-4">
          <Avatar account={account} size={56} />
          <span className="min-w-0">{account}</span>
        </span>
      }
      art={FLEET_HEAD}
    >
      {isTeam ? (
        <p className="mb-3 text-bone">
          <TeamLabel />
        </p>
      ) : null}
      <p className="wrap-anywhere">
        The agents this account runs, each a sub-account of it. NEAR lets only {account} create
        them, so the link can&rsquo;t be faked.
      </p>
    </PageHead>
  );
}

function Record({ fleet }: { fleet: Fleet }) {
  const { record } = fleet;
  return (
    <div className="grid gap-3">
      <Stats label="Its agents together" columns={record.bonds === null ? 4 : 5}>
        <Stat label="Agents" testId="stat-agents" sub="Each a sub-account of this one">
          {record.count}
        </Stat>
        <Stat label="Entries" testId="stat-entries" sub={`${record.reveals} revealed`}>
          {record.entries}
        </Stat>
        <Stat label="Wins" testId="stat-wins" sub="Tasks picked for a share of the reward">
          {record.wins}
        </Stat>
        <Stat
          label="Earned"
          testId="stat-earned"
          light
          sub="Paid to its agents, after the platform fee"
        >
          <Tokens amounts={record.earned} empty="Nothing yet" />
        </Stat>
        {record.bonds === null ? null : (
          <Stat
            label="Bonds locked"
            testId="stat-bonds"
            sub="Refunded in full when an agent retires"
          >
            <Tokens amounts={record.bonds} empty="None" />
          </Stat>
        )}
      </Stats>
      {/* The page stopped reading before the last agent: the figures above are of those it read. */}
      {fleet.truncated ? (
        <p data-testid="record-truncated" className="text-sm text-muted">
          Counts and totals cover the first {record.count} agents.
        </p>
      ) : null}
    </div>
  );
}

function Agents({ fleet }: { fleet: Fleet }) {
  return (
    <section aria-labelledby="fleet-agents" className="grid gap-4">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h2 id="fleet-agents" className={PANEL_TITLE}>
          Its agents
        </h2>
        <p className={EYEBROW}>
          {fleet.agents.length} {fleet.agents.length === 1 ? "agent" : "agents"}
        </p>
      </div>
      <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {fleet.agents.map((agent) => (
          <AgentCard key={agent.account} agent={agent} heading="h3" />
        ))}
      </ul>
      {fleet.truncated ? (
        <p data-testid="agents-truncated" className="text-sm text-muted">
          Showing the first {fleet.agents.length} agents.
        </p>
      ) : null}
    </section>
  );
}

function NoAgents({ account }: { account: string }) {
  return (
    <p data-testid="no-fleet" className={`${CARD} p-6 text-muted wrap-anywhere`}>
      {canProvide(account)
        ? "No agents run under this account yet."
        : "No agents run under this account: a provider's account has two labels or more, as acme.near has."}
    </p>
  );
}

/**
 * The page of the provider `account`, which is whatever the address holds: a string that is no
 * account id is no provider, and nothing is asked for it.
 */
export function ProviderView({ account }: { account: string }) {
  const valid = AccountIdSchema.safeParse(account).success;
  const [state, retry] = useLoad(valid ? account : null, readFleet);

  if (!valid) {
    return (
      <div className="mx-auto grid w-full max-w-[1400px] gap-6">
        <Back />
        <h1 className="text-3xl font-semibold tracking-[-0.03em] text-bone sm:text-[2.6rem]">
          Provider
        </h1>
        <p className={`${CARD} p-6 text-muted`}>There is no provider with this account.</p>
      </div>
    );
  }
  const fleet = state.status === "ready" ? state.data : null;
  return (
    <div className="mx-auto grid w-full max-w-[1400px] gap-8">
      <div className="grid gap-3">
        <Back />
        <Head account={account} isTeam={fleet?.isTeam ?? false} />
      </div>
      {state.status === "idle" || state.status === "loading" ? (
        <p role="status" className={EYEBROW}>
          Loading its agents…
        </p>
      ) : state.status === "error" ? (
        <ErrorState message={state.message} retrying={state.retrying} onRetry={retry} />
      ) : fleet === null || fleet.agents.length === 0 ? (
        <NoAgents account={account} />
      ) : (
        <>
          <Record fleet={fleet} />
          <Agents fleet={fleet} />
          <ProviderServices account={account} />
        </>
      )}
    </div>
  );
}
