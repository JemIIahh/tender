"use client";

import Link from "next/link";
import {
  type AgentsRecord,
  type Bond,
  bondOf,
  combinedRecord,
  readMyAgents,
} from "../../lib/account";
import type { AgentRecord } from "../../lib/api";
import { useLoad } from "../../lib/useLoad";
import { useWallet } from "../../lib/wallet";
import { UNNAMED_AGENT } from "../AgentFacts";
import { Avatar } from "../Avatar";
import { ErrorState } from "../ErrorState";
import { PageHead } from "../PageHead";
import { TeamBadge } from "../TeamBadge";
import { CARD, EYEBROW, FACT_LABEL, PANEL_TITLE, PRIMARY, TAG } from "../ui";
import { ArtCard, Chip, ConnectGate, Stat, Stats, Tokens } from "./parts";
import { ServicesSection } from "./ServicesSection";

// My agents: the agents the connected account runs, as a provider (ASP) sees them. They are the
// account itself, if it is a registered agent, and every agent that names it as its provider, which
// is what an agent made with "Add an agent" does: its account is under the person's. Each one shows
// what the contract counted (entries, reveals, wins, what it earned, token by token) and, once the
// contract keeps agent bonds (Task 16b), its status and its bond. Nothing is added that the API
// did not give.

/** When an unregistering agent can take its bond back, in the reader's own time. */
function claimableText(ns: bigint): { iso: string; text: string } {
  const date = new Date(Number(ns / 1_000_000n));
  return {
    iso: date.toISOString(),
    text: date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }),
  };
}

const STATUS_WORDS: Record<Bond["status"], { label: string; dot: string }> = {
  active: { label: "Active", dot: "bg-seal" },
  unregistering: { label: "Unregistering", dot: "bg-current" },
  retired: { label: "Retired", dot: "bg-current opacity-35" },
};

/** The agent's status: its bond's, once the API sends one, and otherwise that it is registered. */
function StatusChip({ bond }: { bond: Bond | null }) {
  if (bond === null) return <Chip dot="bg-seal">Registered</Chip>;
  const { label, dot } = STATUS_WORDS[bond.status];
  return <Chip dot={dot}>{label}</Chip>;
}

/** The bond of an agent, as the API gave it: what is locked, and when an unregistering one frees it. */
function BondFacts({ bond }: { bond: Bond }) {
  return (
    <div data-testid="bond" className="grid gap-1 text-sm">
      <p className={FACT_LABEL}>Bond</p>
      {bond.token === null || bond.amount === null ? (
        <p className="text-muted">Not given</p>
      ) : (
        <Tokens amounts={[[bond.token, BigInt(bond.amount)]]} />
      )}
      {bond.status === "unregistering" && bond.claimableAt !== null ? (
        <p className="text-[13px] text-muted">
          Claimable from{" "}
          <time dateTime={claimableText(bond.claimableAt).iso}>
            {claimableText(bond.claimableAt).text}
          </time>
        </p>
      ) : null}
      {bond.status === "retired" ? (
        <p className="text-[13px] text-muted">Claimed back in full</p>
      ) : null}
    </div>
  );
}

function Count({ label, value, testId }: { label: string; value: number; testId: string }) {
  return (
    <div className="grid min-w-0 gap-1 bg-ink px-2 py-2.5 text-center">
      <dt className={FACT_LABEL}>{label}</dt>
      <dd data-testid={testId} className="text-lg font-medium tabular-nums wrap-anywhere">
        {value}
      </dd>
    </div>
  );
}

/** One of the account's agents, as a row of the list: who it is, its record, what it earned. */
function AgentRow({ agent, self }: { agent: AgentRecord; self: boolean }) {
  const bond = bondOf(agent);
  return (
    <li
      data-testid="my-agent"
      className="group relative grid min-w-0 gap-5 border-t border-line px-5 py-5 transition-colors first:border-t-0 hover:bg-raised/40 has-[a:focus-visible]:bg-raised/40 motion-reduce:transition-none sm:px-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)_minmax(0,0.9fr)_auto] lg:items-center lg:gap-8"
    >
      <div className="flex min-w-0 items-start gap-3.5">
        <Avatar account={agent.account} size={44} />
        <div className="grid min-w-0 gap-1.5">
          <h3 className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[17px] leading-snug font-medium tracking-[-0.01em] text-bone">
            {/* The name is the row's link, and stretches over the row. */}
            <Link
              href={`/agents/${agent.account}`}
              className="min-w-0 rounded-sm wrap-anywhere after:absolute after:inset-0 after:content-['']"
            >
              {agent.name ?? UNNAMED_AGENT}
            </Link>
          </h3>
          <p className="text-muted" data-testid="my-agent-account">
            <TeamBadge account={agent.account} isTeam={agent.is_team} />
          </p>
          <ul className="flex flex-wrap items-center gap-1.5 pt-1">
            <li data-testid="status" className="text-bone">
              <span className="sr-only">Status: </span>
              <StatusChip bond={bond} />
            </li>
            {self ? (
              <li>
                <span className={`${TAG} border-seal/50 text-bone`} data-testid="this-account">
                  This account
                </span>
              </li>
            ) : null}
            {agent.tags.map((tag, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the contract does not make an agent's tags unique
              <li key={`${tag}-${index}`} className="min-w-0">
                <span className={`${TAG} max-w-full text-bone/85 wrap-anywhere`}>
                  <span className="sr-only">Tag: </span>
                  {tag}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-xl border border-line bg-line">
        <Count label="Entries" value={agent.entries} testId="entries" />
        <Count label="Reveals" value={agent.reveals} testId="reveals" />
        <Count label="Wins" value={agent.wins} testId="wins" />
      </dl>

      <div className="grid min-w-0 content-start gap-4 sm:grid-cols-2 lg:grid-cols-1">
        <div className="grid gap-1 text-sm">
          <p className={FACT_LABEL}>Earned</p>
          <div data-testid="earned" className="text-bone">
            <Tokens
              amounts={Object.entries(agent.earned).map(([token, amount]) => [
                token,
                BigInt(amount),
              ])}
              empty="Nothing yet"
            />
          </div>
        </div>
        {bond === null ? null : <BondFacts bond={bond} />}
      </div>

      <span
        aria-hidden="true"
        className="hidden size-10 shrink-0 place-items-center rounded-full bg-bone text-ink transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none motion-reduce:group-hover:translate-x-0 lg:grid"
      >
        <svg
          viewBox="0 0 16 16"
          aria-hidden="true"
          className="size-4"
          fill="none"
          stroke="currentColor"
        >
          <path d="M3 8h10M9 4l4 4-4 4" strokeWidth="1.6" />
        </svg>
      </span>
    </li>
  );
}

/** The figures of all the agents together: only what the API counted, added up. */
function Summary({ record, selfRegistered }: { record: AgentsRecord; selfRegistered: boolean }) {
  const under = record.count - (selfRegistered ? 1 : 0);
  return (
    <Stats label="All your agents" columns={record.bonds === null ? 4 : 5}>
      <Stat
        label="Agents"
        testId="stat-agents"
        sub={
          selfRegistered
            ? `This account and ${under} under it`
            : `${under === 1 ? "1 account" : `${under} accounts`} under yours`
        }
      >
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
        sub="Paid to your agents, after the platform fee"
      >
        <Tokens amounts={record.earned} empty="Nothing yet" />
      </Stat>
      {record.bonds === null ? null : (
        <Stat label="Bonds locked" testId="stat-bonds" sub="Refunded in full when an agent retires">
          <Tokens amounts={record.bonds} empty="None" />
        </Stat>
      )}
    </Stats>
  );
}

const ADD = "/my-agents/new";

function NoAgents() {
  return (
    <ArtCard art="scorecard" focus={{ x: 0.72, y: 0.32, scale: 0.4 }} testId="no-agents">
      <p className="max-w-sm text-2xl font-semibold tracking-tight text-bone">No agents yet</p>
      <p className="max-w-md text-[15px] leading-relaxed text-muted">
        An agent gets an account under yours, made with a key that stays where the agent runs. Then
        it registers itself and starts entering tasks.
      </p>
      <Link href={ADD} className={PRIMARY}>
        Add an agent
      </Link>
    </ArtCard>
  );
}

function Loading() {
  const bar = "rounded-full bg-raised";
  return (
    <div role="status" className="grid gap-4">
      <p className={EYEBROW}>Loading your agents…</p>
      <ul aria-hidden="true" className={`${CARD} grid`}>
        {[0, 1].map((row) => (
          <li
            key={row}
            className="flex items-center gap-4 border-t border-line p-6 first:border-t-0"
          >
            <span className={`${bar} size-11`} />
            <span className="grid flex-1 gap-2">
              <span className={`${bar} h-4 w-48`} />
              <span className={`${bar} h-3 w-32`} />
            </span>
            <span className={`${bar} hidden h-12 w-56 sm:block`} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function Agents({ account }: { account: string }) {
  const [state, retry] = useLoad(account, readMyAgents);
  if (state.status === "idle" || state.status === "loading") return <Loading />;
  if (state.status === "error") {
    return <ErrorState message={state.message} retrying={state.retrying} onRetry={retry} />;
  }
  const { agents, selfRegistered, truncated } = state.data;
  if (agents.length === 0) return <NoAgents />;
  return (
    <>
      <Summary record={combinedRecord(agents)} selfRegistered={selfRegistered} />
      <section className={`${CARD} grid overflow-hidden`}>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-b border-line px-5 py-4 sm:px-6">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <h2 className={PANEL_TITLE}>Your agents</h2>
            <p className={EYEBROW}>
              {agents.length} {agents.length === 1 ? "agent" : "agents"}
            </p>
          </div>
          <Link href={ADD} className={`${PRIMARY} min-h-10`}>
            Add an agent
          </Link>
        </div>
        <ul className="grid">
          {agents.map((agent, index) => (
            <AgentRow key={agent.account} agent={agent} self={selfRegistered && index === 0} />
          ))}
        </ul>
      </section>
      {truncated ? (
        <p data-testid="agents-truncated" className="text-sm text-muted">
          Showing the first {agents.length} agents.
        </p>
      ) : null}
      <ServicesSection account={account} agents={agents} />
    </>
  );
}

export function MyAgentsView() {
  const wallet = useWallet();
  return (
    <div className="mx-auto grid w-full max-w-[1400px] gap-8">
      <PageHead
        eyebrow="Account"
        title="My agents."
        muted="What they entered, won and earned."
        art={{ name: "scale", focus: { x: 0.62, y: 0.55, scale: 0.42 } }}
      />
      <ConnectGate
        wallet={wallet}
        art="scorecard"
        why="Connect a wallet to see the agents it runs: the account itself, if it is registered, and the agents under it."
      >
        {(account) => <Agents account={account} />}
      </ConnectGate>
    </div>
  );
}
