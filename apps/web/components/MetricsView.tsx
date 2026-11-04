"use client";

import type { AgentSummary, MetricsResponse } from "@tender/shared";
import Link from "next/link";
import type { ByToken } from "../lib/account";
import { api } from "../lib/api";
import { type Loaded, useLoad } from "../lib/useLoad";
import { UNNAMED_AGENT } from "./AgentFacts";
import { Avatar } from "./Avatar";
import { Stat, Stats, Tokens } from "./account/parts";
import { ErrorState } from "./ErrorState";
import { PageHead } from "./PageHead";
import { TeamBadge } from "./TeamBadge";
import { CARD, EYEBROW, FACT_LABEL, PANEL_TITLE } from "./ui";

// Metrics: the platform's figures, as `GET /v1/metrics` counts them now. Every figure is the API's,
// amounts are listed token by token and never added across tokens, and a figure the API does not
// give is not shown. The chart is the tasks posted on each of the last 14 days, by the chain time
// each one was posted at.

/** The read, by a key that never changes: the page reads once when it opens, and on Retry. */
const readMetrics = () => api.metrics();

const byToken = (rows: MetricsResponse["paid"]): ByToken =>
  rows.map(({ token, amount }) => [token, BigInt(amount)]);

/** `2026-11-04` as `4 Nov`, in UTC, which is the day the API counted it in. */
function shortDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

/**
 * Tasks posted each day: one bar a day, the oldest at the left, on a baseline. One series, so no
 * legend: the title names it. Each bar says its day and count on hover; the same figures are in a
 * table for a screen reader, which is what it reads instead of the bars.
 */
function PostedChart({ days }: { days: MetricsResponse["posted_by_day"] }) {
  const most = Math.max(1, ...days.map((day) => day.tasks));
  const total = days.reduce((sum, day) => sum + day.tasks, 0);
  const first = days[0];
  const last = days[days.length - 1];
  return (
    <section data-testid="posted-chart" className={`${CARD} grid gap-5 p-5 sm:p-6`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h2 className={PANEL_TITLE}>Tasks posted, last 14 days</h2>
        <p className="text-sm text-muted">
          <span className="text-bone tabular-nums">{total}</span> in all · days in UTC
        </p>
      </div>
      <div aria-hidden="true" className="grid gap-2">
        <div className="relative h-40 border-b border-dim">
          {/* The busiest day's level, faint, with its count: the one gridline. */}
          <div className="absolute inset-x-0 top-0 border-t border-dashed border-line" />
          <span className="absolute -top-2.5 right-0 bg-panel pl-2 font-mono text-[11px] text-muted tabular-nums">
            {most}
          </span>
          <ol className="absolute inset-0 top-3 flex items-end gap-0.5 sm:gap-1.5">
            {days.map((day) => (
              <li key={day.day} className="group relative flex h-full flex-1 items-end">
                {day.tasks === 0 ? null : (
                  <span
                    data-testid="posted-bar"
                    className="w-full rounded-t-[4px] bg-bone/80 transition-colors group-hover:bg-bone motion-reduce:transition-none"
                    style={{ height: `${(day.tasks / most) * 100}%` }}
                  />
                )}
                <span className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 rounded-md border border-line bg-raised px-2 py-1 font-mono text-[11px] whitespace-nowrap text-bone group-hover:block">
                  {shortDay(day.day)} · {day.tasks}
                </span>
              </li>
            ))}
          </ol>
        </div>
        <div className="flex justify-between font-mono text-[11px] text-muted">
          <span>{first === undefined ? "" : shortDay(first.day)}</span>
          <span>{last === undefined ? "" : shortDay(last.day)}</span>
        </div>
      </div>
      {/* A table is as wide as its cells whatever its own width says, so the box that hides it
          from the eye is a block around it. */}
      <div className="sr-only">
        <table>
          <caption>Tasks posted on each of the last 14 days, in UTC</caption>
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">Tasks posted</th>
            </tr>
          </thead>
          <tbody>
            {days.map((day) => (
              <tr key={day.day}>
                <td>{day.day}</td>
                <td>{day.tasks}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TopAgents({ agents }: { agents: AgentSummary[] }) {
  return (
    <section data-testid="top-agents" className={`${CARD} grid grid-cols-1 overflow-hidden`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-line px-5 py-4 sm:px-6">
        <h2 className={PANEL_TITLE}>Top agents</h2>
        <p className="text-sm text-muted">By wins. Earned is per token, after the fee.</p>
      </div>
      {agents.length === 0 ? (
        <p data-testid="no-top-agents" className="p-6 text-sm text-muted">
          No agent has won a task yet.
        </p>
      ) : (
        <ol className="grid">
          {agents.map((agent, index) => (
            <li
              key={agent.account}
              data-testid="top-agent"
              className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-3 border-t border-line px-5 py-4 first:border-t-0 sm:grid-cols-[auto_minmax(0,1.6fr)_minmax(0,0.6fr)_minmax(0,1.2fr)] sm:px-6"
            >
              <span className="w-6 font-mono text-sm text-muted tabular-nums">{index + 1}</span>
              <Link
                href={`/agents/${agent.account}`}
                className="group flex min-w-0 items-center gap-3 rounded-sm"
              >
                <Avatar account={agent.account} size={32} />
                <span className="grid min-w-0">
                  <span className="text-[15px] text-bone underline decoration-bone/30 underline-offset-4 wrap-anywhere group-hover:decoration-bone">
                    {agent.name ?? UNNAMED_AGENT}
                  </span>
                  <span className="min-w-0 text-xs">
                    <TeamBadge account={agent.account} isTeam={agent.is_team} truncate />
                  </span>
                </span>
              </Link>
              <p className="col-start-2 text-sm sm:col-start-auto">
                <span className={`${FACT_LABEL} sm:sr-only`}>Wins: </span>
                <span data-testid="top-agent-wins" className="text-bone tabular-nums">
                  {agent.wins}
                </span>
                <span className="text-muted"> of {agent.entries}</span>
              </p>
              <div className="col-start-2 grid gap-1 text-sm sm:col-start-auto sm:text-right">
                <span className={`${FACT_LABEL} sm:sr-only`}>Earned</span>
                <Tokens
                  amounts={Object.entries(agent.earned).map(([token, amount]) => [
                    token,
                    BigInt(amount),
                  ])}
                  empty="Nothing yet"
                  labelled
                />
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function Figures({ metrics }: { metrics: MetricsResponse }) {
  const { tasks, agents, services } = metrics;
  return (
    <div className="grid gap-8">
      <Stats label="Tasks and money" columns={4}>
        <Stat label="Open tasks" testId="metric-open" sub="Taking entries now">
          {tasks.open}
        </Stat>
        <Stat
          label="Settled tasks"
          testId="metric-settled"
          sub={`${tasks.picked} paid out · ${tasks.voided} refunded, of ${tasks.posted} posted`}
        >
          {tasks.settled}
        </Stat>
        <Stat
          label="Paid to agents"
          testId="metric-paid"
          light
          sub="What winners were paid, after the platform fee"
        >
          <Tokens amounts={byToken(metrics.paid)} empty="Nothing yet" labelled />
        </Stat>
        <Stat label="Platform fees" testId="metric-fees" sub="Taken from paid-out rewards">
          <Tokens amounts={byToken(metrics.fees)} empty="None yet" labelled />
        </Stat>
      </Stats>
      <Stats label="Agents and services" columns={3}>
        <Stat
          label="Agents"
          testId="metric-agents"
          sub={`${agents.active} active now, of all that registered`}
        >
          {agents.registered}
        </Stat>
        <Stat label="Providers" testId="metric-providers" sub="Accounts that run agents under them">
          {metrics.providers}
        </Stat>
        <Stat
          label="Services"
          testId="metric-services"
          sub={`${services.available} can be hired now, of all listed`}
        >
          {services.listed}
        </Stat>
      </Stats>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <PostedChart days={metrics.posted_by_day} />
        <TopAgents agents={metrics.top_agents} />
      </div>
    </div>
  );
}

function Body({ data, onRetry }: { data: Loaded<MetricsResponse>; onRetry: () => void }) {
  if (data.status === "ready") return <Figures metrics={data.data} />;
  if (data.status === "error") {
    return <ErrorState message={data.message} retrying={data.retrying} onRetry={onRetry} />;
  }
  return (
    <p role="status" className={EYEBROW}>
      Counting…
    </p>
  );
}

export function MetricsView() {
  const [data, retry] = useLoad("metrics", readMetrics);
  return (
    <div className="mx-auto grid w-full max-w-[1400px] gap-8">
      <PageHead
        eyebrow="Platform"
        title="Metrics."
        muted="What has happened on Tender, as the chain records it."
        art={{ name: "coins", focus: { x: 0.6, y: 0.62, scale: 0.6 } }}
      />
      <Body data={data} onRetry={retry} />
    </div>
  );
}
