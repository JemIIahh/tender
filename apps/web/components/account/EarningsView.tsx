"use client";

import type { TaskSummary } from "@tender/shared";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type KeyboardEvent, type ReactNode, useId, useRef } from "react";
import {
  combinedRecord,
  type Earnings,
  type MyAgents,
  type Pending,
  type PostedState,
  postedStateOf,
  postedTotals,
  readEarnings,
  readMyAgents,
  readPosted,
  type Win,
  winTotals,
} from "../../lib/account";
import { agentName } from "../../lib/agents";
import type { AgentRecord } from "../../lib/api";
import { useNowNs } from "../../lib/clock";
import { phaseOfTask } from "../../lib/phase";
import { scrollCue } from "../../lib/scrollCue";
import { type Loaded, useLoad } from "../../lib/useLoad";
import { useWallet } from "../../lib/wallet";
import { Amount } from "../Amount";
import { Avatar } from "../Avatar";
import { ErrorState } from "../ErrorState";
import { PageHead } from "../PageHead";
import { PhaseChip } from "../PhaseChip";
import { RowsSkeleton } from "../SkeletonLists";
import { CARD, PRIMARY, SCROLL_CUE } from "../ui";
import { Cell, Chip, ConnectGate, ROW, Rows, Stat, Stats, TaskCell, Tokens } from "./parts";

// Earnings: what the connected account's agents won, what is still to be decided, and the tasks
// the account posted, with where each reward went. Every figure is the chain's, through the API:
// a win's amount is the payout its task's outcome records, and the fee is the task's own. Amounts
// of different tokens are listed one under the other and never added together.

type Tab = "agents" | "transactions" | "poster";

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: "agents", label: "My agents" },
  { id: "transactions", label: "Transactions" },
  { id: "poster", label: "As a poster" },
];

interface AgentsEarnings {
  mine: MyAgents;
  earnings: Earnings;
}

/** The account's agents, and what they won and wait on. Null once the page stops waiting. */
async function readAgentsEarnings(
  account: string,
  wanted: () => boolean,
): Promise<AgentsEarnings | null> {
  const mine = await readMyAgents(account, wanted);
  if (mine === null) return null;
  const earnings = await readEarnings(mine.agents, wanted);
  return earnings === null ? null : { mine, earnings };
}

function AgentCell({ agent }: { agent: AgentRecord }) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <Avatar account={agent.account} size={28} />
      <span className="grid min-w-0">
        <span className="text-sm text-bone wrap-anywhere">{agent.name ?? agent.account}</span>
        {agent.name === null ? null : (
          <span className="font-mono text-xs text-muted wrap-anywhere">{agent.account}</span>
        )}
      </span>
    </span>
  );
}

/** A share in basis points as a percentage: 10000 is 100%, 2500 is 25%, 333 is 3.33%. */
function percent(bps: number): string {
  return `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
}

// ---- The tabs' panels --------------------------------------------------------------------------

function NoAgentsYet() {
  return (
    <div className="grid justify-items-start gap-3 p-6">
      <p className="text-lg font-medium text-bone">No agents yet</p>
      <p className="text-sm text-muted">What your agents win shows here, once you run one.</p>
      <Link href="/my-agents/new" className={PRIMARY}>
        Add an agent
      </Link>
    </div>
  );
}

function AgentsPanel({ data }: { data: AgentsEarnings }) {
  const { agents } = data.mine;
  if (agents.length === 0) return <NoAgentsYet />;
  const pendingOf = (agent: AgentRecord) =>
    data.earnings.pending.filter((row) => row.agent.account === agent.account).length;
  return (
    <>
      <Rows
        heads={["Agent", "Wins", "Earned", "Waiting on a pick"]}
        grid="md:grid-cols-[minmax(0,1.6fr)_minmax(0,0.6fr)_minmax(0,1.2fr)_minmax(0,0.8fr)]"
        testId="earnings-agents"
      >
        {agents.map((agent) => (
          <li
            key={agent.account}
            data-testid="earnings-agent"
            className={`${ROW} md:grid-cols-[minmax(0,1.6fr)_minmax(0,0.6fr)_minmax(0,1.2fr)_minmax(0,0.8fr)]`}
          >
            <Cell head="Agent" lead>
              <Link
                href={`/agents/${agent.account}`}
                className="group flex min-w-0 items-center gap-2.5 rounded-sm"
              >
                <Avatar account={agent.account} size={28} />
                <span className="grid min-w-0">
                  <span className="text-sm text-bone underline decoration-bone/30 underline-offset-4 wrap-anywhere group-hover:decoration-bone">
                    {agentName(agent)}
                  </span>
                  <span className="font-mono text-xs text-muted wrap-anywhere">
                    {agent.account}
                  </span>
                </span>
              </Link>
            </Cell>
            <Cell head="Wins">
              <span className="tabular-nums">
                {agent.wins}
                <span className="text-muted"> of {agent.entries}</span>
              </span>
            </Cell>
            <Cell head="Earned">
              <Tokens
                amounts={Object.entries(agent.earned).map(([token, amount]) => [
                  token,
                  BigInt(amount),
                ])}
                empty="Nothing yet"
              />
            </Cell>
            <Cell head="Waiting on a pick" end>
              <span className="tabular-nums">{pendingOf(agent)}</span>
            </Cell>
          </li>
        ))}
      </Rows>
      <p className="border-t border-line px-5 py-4 text-sm text-muted sm:px-6">
        Earned is the contract's count of what each agent was paid: its share of each reward, less
        the platform fee.
      </p>
    </>
  );
}

type Transaction = { kind: "win"; win: Win } | { kind: "pending"; pending: Pending };

function TransactionsPanel({ data }: { data: AgentsEarnings }) {
  const { wins, pending } = data.earnings;
  const rows: Transaction[] = [
    ...wins.map((win): Transaction => ({ kind: "win", win })),
    ...pending.map((row): Transaction => ({ kind: "pending", pending: row })),
  ].sort((a, b) => {
    const id = (row: Transaction) =>
      BigInt(row.kind === "win" ? row.win.taskId : row.pending.taskId);
    return id(b) > id(a) ? 1 : id(b) < id(a) ? -1 : 0;
  });
  if (rows.length === 0) {
    return (
      <div data-testid="no-transactions" className="grid justify-items-start gap-3 p-6">
        <p className="text-sm text-muted">
          No wins or payouts yet. A win shows here when its task is picked; an entry that is opened
          (revealed) shows here while it waits.
        </p>
        <Link href="/tasks" className={PRIMARY}>
          Find a task
        </Link>
      </div>
    );
  }
  const grid =
    "md:grid-cols-[minmax(0,1.5fr)_minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.9fr)]";
  return (
    <>
      <Rows
        heads={["Task", "Agent", "Amount", "Net after fee", "Status"]}
        grid={grid}
        testId="transactions"
      >
        {rows.map((row) =>
          row.kind === "win" ? (
            <li
              key={`win-${row.win.agent.account}-${row.win.taskId}`}
              data-testid="transaction"
              className={`${ROW} ${grid}`}
            >
              <Cell head="Task" lead>
                <TaskCell taskId={row.win.taskId} title={row.win.title} />
              </Cell>
              <Cell head="Agent">
                <AgentCell agent={row.win.agent} />
              </Cell>
              <Cell head="Amount">
                <span data-testid="gross">
                  <Amount value={row.win.gross.toString()} token={row.win.token} />
                </span>
                <span className="block text-xs text-muted">{percent(row.win.bps)} share</span>
              </Cell>
              <Cell head="Net after fee">
                <span data-testid="net" className="text-bone">
                  <Amount value={row.win.net.toString()} token={row.win.token} />
                </span>
                <span className="block text-xs text-muted">less {percent(row.win.feeBps)} fee</span>
              </Cell>
              <Cell head="Status" end>
                <span data-testid="transaction-status">
                  <Chip dot="bg-seal">Paid</Chip>
                </span>
              </Cell>
            </li>
          ) : (
            <li
              key={`pending-${row.pending.agent.account}-${row.pending.taskId}`}
              data-testid="transaction"
              className={`${ROW} ${grid}`}
            >
              <Cell head="Task" lead>
                <TaskCell taskId={row.pending.taskId} title={row.pending.title} />
              </Cell>
              <Cell head="Agent">
                <AgentCell agent={row.pending.agent} />
              </Cell>
              <Cell head="Amount">
                <span className="text-muted">Not decided</span>
              </Cell>
              <Cell head="Net after fee">
                <span className="text-muted">—</span>
              </Cell>
              <Cell head="Status" end>
                <span data-testid="transaction-status">
                  <Chip dot="bg-current opacity-60">Awaiting pick</Chip>
                </span>
              </Cell>
            </li>
          ),
        )}
      </Rows>
      <p className="border-t border-line px-5 py-4 text-sm text-muted sm:px-6">
        Net is what the chain paid the agent, into its Tender vault. Amount is that and the
        agent&rsquo;s part of the task&rsquo;s fee, by its share: the chain records one fee for the
        whole task.
      </p>
    </>
  );
}

const POSTED_WORDS: Record<PostedState, string> = {
  locked: "Locked in escrow",
  "due-back": "Due back to its funders in full",
  paid: "Paid to the winners, less the platform fee",
  refunded: "Refunded to its funders in full",
  settled: "Settled",
};

function PosterPanel({
  posted,
  nowNs,
  onRetry,
}: {
  posted: Loaded<{ tasks: TaskSummary[]; truncated: boolean }>;
  nowNs: bigint;
  onRetry: () => void;
}) {
  if (posted.status === "idle" || posted.status === "loading") {
    return (
      <div className="relative grid">
        <p role="status" className="sr-only">
          Loading the tasks you posted…
        </p>
        <RowsSkeleton rows={2} />
      </div>
    );
  }
  if (posted.status === "error") {
    return (
      <div className="p-5">
        <ErrorState message={posted.message} retrying={posted.retrying} onRetry={onRetry} />
      </div>
    );
  }
  const { tasks, truncated } = posted.data;
  if (tasks.length === 0) {
    return (
      <div data-testid="no-posted" className="grid justify-items-start gap-3 p-6">
        <p className="text-lg font-medium text-bone">No tasks posted yet</p>
        <p className="text-sm text-muted">
          The reward of a task you post is locked until it is paid out or refunded.
        </p>
        <Link href="/post" className={PRIMARY}>
          Post a task
        </Link>
      </div>
    );
  }
  const totals = postedTotals(tasks, nowNs);
  const grid = "md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1.3fr)_auto]";
  return (
    <>
      <div className="border-b border-line p-5 sm:p-6">
        <Stats label="Tasks you posted" columns={3}>
          <Stat
            label="Locked"
            testId="poster-locked"
            sub="Rewards of your tasks not yet decided, from all their funders"
          >
            <Tokens amounts={totals.locked} empty="None" />
          </Stat>
          <Stat
            label="Paid out"
            testId="poster-paid"
            sub="Rewards of your tasks, before the fee, from all their funders"
          >
            <Tokens amounts={totals.paid} empty="None" />
          </Stat>
          <Stat
            label="Refunded"
            testId="poster-refunded"
            sub="Rewards of your tasks, each funder's part back to it in full"
          >
            <Tokens amounts={totals.refunded} empty="None" />
          </Stat>
        </Stats>
      </div>
      <Rows heads={["Task", "Reward", "Where it is", "Phase"]} grid={grid} testId="posted">
        {tasks.map((task) => {
          const state = postedStateOf(task, nowNs);
          return (
            <li key={task.id} data-testid="posted-task" className={`${ROW} ${grid}`}>
              <Cell head="Task" lead>
                <TaskCell taskId={task.id} title={task.title} />
              </Cell>
              <Cell head="Reward">
                <Amount value={task.reward} token={task.token} />
              </Cell>
              <Cell head="Where it is">
                <span
                  data-testid="posted-state"
                  className={
                    state === "locked" || state === "due-back" ? "text-bone" : "text-muted"
                  }
                >
                  {POSTED_WORDS[state]}
                </span>
              </Cell>
              <Cell head="Phase" end>
                <PhaseChip phase={phaseOfTask(task, nowNs)} />
              </Cell>
            </li>
          );
        })}
      </Rows>
      <p className="border-t border-line px-5 py-4 text-sm text-muted sm:px-6">
        A task's reward counts what every funder put in. A refund goes back to each funder in full.
        {truncated ? ` Showing the newest ${tasks.length} tasks.` : ""}
      </p>
    </>
  );
}

// ---- The page ---------------------------------------------------------------------------------

function Summary({ data }: { data: Loaded<AgentsEarnings> }) {
  if (data.status !== "ready") return null;
  const { mine, earnings } = data.data;
  const totals = winTotals(earnings.wins);
  const record = combinedRecord(mine.agents);
  const known = record.wins;
  return (
    <div className="grid gap-3">
      <Stats label="Earnings" columns={record.bonds === null ? 4 : 5}>
        <Stat
          label="Total earned"
          testId="stat-gross"
          sub="Your agents' share of the rewards they won, before the fee"
        >
          <Tokens amounts={totals.gross} empty="Nothing yet" />
        </Stat>
        <Stat
          label="Fees paid"
          testId="stat-fees"
          sub="Your agents' part of the fee on those tasks, by their share"
        >
          <Tokens amounts={totals.fee} empty="None" />
        </Stat>
        <Stat label="Net" testId="stat-net" light sub="Paid into your agents' Tender vaults">
          <Tokens amounts={totals.net} empty="Nothing yet" />
        </Stat>
        <Stat label="Pending" testId="stat-pending" sub="Revealed entries waiting on a pick">
          {earnings.pending.length}
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
      {earnings.winsRead < known ? (
        <p data-testid="coverage" className="text-sm text-muted">
          These sums are from the {earnings.winsRead} of your agents' {known} wins that were read.
        </p>
      ) : null}
    </div>
  );
}

function tabOf(params: URLSearchParams): Tab {
  return TABS.find((tab) => tab.id === params.get("tab"))?.id ?? "agents";
}

function Account({ account }: { account: string }) {
  const id = useId();
  const router = useRouter();
  const pathname = usePathname();
  const tab = tabOf(useSearchParams());
  const nowNs = useNowNs();
  const [agents, retryAgents] = useLoad(account, readAgentsEarnings);
  const [posted, retryPosted] = useLoad(account, readPosted);
  const buttons = useRef(new Map<Tab, HTMLButtonElement>());

  const choose = (next: Tab, focus = false) => {
    router.replace(next === "agents" ? pathname : `${pathname}?tab=${next}`, { scroll: false });
    if (focus) buttons.current.get(next)?.focus();
  };

  // The tabs are one stop for the keyboard: the arrows move between them, as in any tab list.
  const onKeyDown = (event: KeyboardEvent) => {
    const at = TABS.findIndex((candidate) => candidate.id === tab);
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      choose((event.key === "Home" ? TABS[0] : TABS[TABS.length - 1])?.id ?? "agents", true);
    } else if (step !== 0) {
      event.preventDefault();
      choose(TABS[(at + step + TABS.length) % TABS.length]?.id ?? "agents", true);
    }
  };

  const agentsBody = (render: (data: AgentsEarnings) => ReactNode) =>
    agents.status === "ready" ? (
      render(agents.data)
    ) : agents.status === "error" ? (
      <div className="p-5">
        <ErrorState message={agents.message} retrying={agents.retrying} onRetry={retryAgents} />
      </div>
    ) : (
      <div className="relative grid">
        <p role="status" className="sr-only">
          Loading what your agents won…
        </p>
        <RowsSkeleton rows={2} />
      </div>
    );

  return (
    <div className="grid gap-8">
      <Summary data={agents} />
      <section className={`${CARD} grid overflow-hidden`}>
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2 border-b border-line px-5 pt-4 sm:px-6">
          <h2 className="sr-only">Details</h2>
          <div
            role="tablist"
            aria-label="Earnings"
            onKeyDown={onKeyDown}
            ref={scrollCue}
            className={`-mb-px flex max-w-full gap-5 overflow-x-auto sm:gap-7 ${SCROLL_CUE}`}
          >
            {TABS.map((candidate) => (
              <button
                key={candidate.id}
                ref={(element) => {
                  if (element === null) buttons.current.delete(candidate.id);
                  else buttons.current.set(candidate.id, element);
                }}
                type="button"
                role="tab"
                id={`${id}-tab-${candidate.id}`}
                aria-selected={tab === candidate.id}
                aria-controls={`${id}-panel`}
                tabIndex={tab === candidate.id ? 0 : -1}
                onClick={() => choose(candidate.id)}
                className="min-h-11 shrink-0 border-b-2 border-transparent pb-1 text-[15px] whitespace-nowrap text-muted transition-colors hover:text-bone motion-reduce:transition-none aria-selected:border-bone aria-selected:font-medium aria-selected:text-bone"
              >
                {candidate.label}
              </button>
            ))}
          </div>
        </div>
        <div
          role="tabpanel"
          id={`${id}-panel`}
          aria-labelledby={`${id}-tab-${tab}`}
          data-testid={`panel-${tab}`}
          className="grid"
        >
          {tab === "agents" ? (
            agentsBody((data) => <AgentsPanel data={data} />)
          ) : tab === "transactions" ? (
            agentsBody((data) => <TransactionsPanel data={data} />)
          ) : (
            <PosterPanel posted={posted} nowNs={nowNs} onRetry={retryPosted} />
          )}
        </div>
      </section>
    </div>
  );
}

export function EarningsView() {
  const wallet = useWallet();
  return (
    <div className="mx-auto grid w-full max-w-[1400px] gap-8">
      <PageHead title="Earnings." muted="What your agents won, and where your rewards went." />
      <ConnectGate
        wallet={wallet}
        why="Connect a wallet to see what its agents won, what is still to be decided, and where the rewards of the tasks it posted went."
      >
        {(account) => <Account account={account} />}
      </ConnectGate>
    </div>
  );
}
