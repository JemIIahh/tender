"use client";

import type { TaskSummary } from "@tender/shared";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type KeyboardEvent, type ReactNode, useCallback, useId, useRef } from "react";
import { type Posted, readPosted } from "../../lib/account";
import { deadlineLine } from "../../lib/card";
import { nowNs as clockNs, useNowNs } from "../../lib/clock";
import { type NextStep, nextStep, readHires, readToPick } from "../../lib/myTasks";
import { phaseOfTask } from "../../lib/phase";
import { scrollCue } from "../../lib/scrollCue";
import { type Loaded, useLoad } from "../../lib/useLoad";
import { useWallet } from "../../lib/wallet";
import { Amount } from "../Amount";
import { ErrorState } from "../ErrorState";
import { PageHead } from "../PageHead";
import { PhaseChip } from "../PhaseChip";
import { RowsSkeleton } from "../SkeletonLists";
import { CARD, PRIMARY, SCROLL_CUE, SECONDARY } from "../ui";
import { Cell, ConnectGate, ROW, Rows, TaskCell } from "./parts";

// My tasks: what the connected account posted, what it has to pick, and the hires it made of a
// service, each task with its phase, its reward, its entries, when its window closes, and the next
// step the account can take. The step is a link to that step's control on the task's page
// (`/tasks/<id>#pick`, `#refund`, `#top-up`); nothing here signs anything.

type Tab = "pick" | "posted" | "hires";

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: "pick", label: "To pick" },
  { id: "posted", label: "Posted" },
  { id: "hires", label: "Hires" },
];

/** What each step says on its link, and how the link reads to a screen reader (with the task). */
const STEPS: Record<NextStep, { label: string; name: (id: string) => string; primary: boolean }> = {
  pick: { label: "Pick", name: (id) => `Pick the winners of task #${id}`, primary: true },
  refund: { label: "Refund", name: (id) => `Refund task #${id}`, primary: false },
  "top-up": { label: "Top up", name: (id) => `Top up task #${id}`, primary: false },
};

const GRID =
  "md:grid-cols-[minmax(0,1.7fr)_minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,1.1fr)_minmax(0,0.7fr)]";

function StepLink({ task, step }: { task: TaskSummary; step: NextStep | null }) {
  if (step === null) return <span className="text-muted">—</span>;
  const look = STEPS[step];
  return (
    <Link
      // The task page's control for the step has the step's name as its id (#pick, #refund,
      // #top-up), so the link lands on it; a page without it opens at its top.
      href={`/tasks/${task.id}#${step}`}
      aria-label={look.name(task.id)}
      data-testid="next-step"
      data-step={step}
      className={`${look.primary ? PRIMARY : SECONDARY} min-h-10 px-4`}
    >
      {look.label}
    </Link>
  );
}

function TaskRows({
  tasks,
  account,
  nowNs,
  testId,
}: {
  tasks: TaskSummary[];
  account: string;
  nowNs: bigint;
  testId: string;
}) {
  return (
    <Rows
      heads={["Task", "Status", "Reward", "Entries", "Closes", "Next"]}
      grid={GRID}
      testId={testId}
    >
      {tasks.map((task) => (
        <li key={task.id} data-testid="my-task" className={`${ROW} ${GRID}`}>
          <Cell head="Task" lead>
            <TaskCell taskId={task.id} title={task.title} />
          </Cell>
          <Cell head="Status">
            <PhaseChip phase={phaseOfTask(task, nowNs)} />
          </Cell>
          <Cell head="Reward">
            <Amount value={task.reward} token={task.token} />
          </Cell>
          <Cell head="Entries">
            <span className="tabular-nums">
              {task.commit_count}
              <span className="text-muted"> · {task.reveal_count} revealed</span>
            </span>
          </Cell>
          <Cell head="Closes">
            <span data-testid="closes" className="text-sm">
              {deadlineLine(task, nowNs)}
            </span>
          </Cell>
          <Cell head="Next" end>
            <StepLink task={task} step={nextStep(task, account, nowNs)} />
          </Cell>
        </li>
      ))}
    </Rows>
  );
}

/** A tab's empty state: a line, and where to go from here. */
function Empty({
  testId,
  title,
  line,
  action,
}: {
  testId: string;
  title: string;
  line: string;
  action?: ReactNode;
}) {
  return (
    <div data-testid={testId} className="grid justify-items-start gap-3 p-6">
      <p className="text-lg font-medium text-bone">{title}</p>
      <p className="max-w-xl text-sm text-muted">{line}</p>
      {action}
    </div>
  );
}

function Panel({
  data,
  loading,
  onRetry,
  render,
}: {
  data: Loaded<Posted>;
  loading: string;
  onRetry: () => void;
  render: (posted: Posted) => ReactNode;
}) {
  if (data.status === "ready") return <>{render(data.data)}</>;
  if (data.status === "error") {
    return (
      <div className="p-5">
        <ErrorState message={data.message} retrying={data.retrying} onRetry={onRetry} />
      </div>
    );
  }
  // The rows' shapes where the rows will be (components/Skeleton.tsx), and the words for a screen
  // reader.
  return (
    <div className="relative grid">
      <p role="status" className="sr-only">
        {loading}
      </p>
      <RowsSkeleton rows={2} />
    </div>
  );
}

/** A line under a list that is cut off: how many of the account's tasks it shows. */
function Truncated({ posted }: { posted: Posted }) {
  if (!posted.truncated) return null;
  return (
    <p className="border-t border-line px-5 py-4 text-sm text-muted sm:px-6">
      Showing the newest {posted.tasks.length}.
    </p>
  );
}

function tabOf(params: URLSearchParams): Tab | null {
  return TABS.find((tab) => tab.id === params.get("tab"))?.id ?? null;
}

function Account({ account }: { account: string }) {
  const id = useId();
  const router = useRouter();
  const pathname = usePathname();
  const asked = tabOf(useSearchParams());
  const nowNs = useNowNs();
  const readPick = useCallback(
    (key: string, wanted: () => boolean) => readToPick(key, clockNs, wanted),
    [],
  );
  const [toPick, retryPick] = useLoad(account, readPick);
  const [posted, retryPosted] = useLoad(account, readPosted);
  const [hires, retryHires] = useLoad(account, readHires);
  const buttons = useRef(new Map<Tab, HTMLButtonElement>());

  // With no tab in the address: what is to pick when there is any, else what was posted.
  const pickCount = toPick.status === "ready" ? toPick.data.tasks.length : null;
  const tab: Tab = asked ?? (pickCount === 0 ? "posted" : "pick");

  const choose = (next: Tab, focus = false) => {
    router.replace(`${pathname}?tab=${next}`, { scroll: false });
    if (focus) buttons.current.get(next)?.focus();
  };

  // The tabs are one stop for the keyboard: the arrows move between them, as in any tab list.
  const onKeyDown = (event: KeyboardEvent) => {
    const at = TABS.findIndex((candidate) => candidate.id === tab);
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      choose((event.key === "Home" ? TABS[0] : TABS[TABS.length - 1])?.id ?? "pick", true);
    } else if (step !== 0) {
      event.preventDefault();
      choose(TABS[(at + step + TABS.length) % TABS.length]?.id ?? "pick", true);
    }
  };

  const rows = (posted: Posted, testId: string) => (
    <>
      <TaskRows tasks={posted.tasks} account={account} nowNs={nowNs} testId={testId} />
      <Truncated posted={posted} />
    </>
  );

  return (
    <section className={`${CARD} grid grid-cols-1 overflow-hidden`}>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2 border-b border-line px-5 pt-4 sm:px-6">
        <h2 className="sr-only">Your tasks</h2>
        <div
          role="tablist"
          aria-label="Your tasks"
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
              className="flex min-h-11 shrink-0 items-center gap-2 border-b-2 border-transparent pb-1 text-[15px] whitespace-nowrap text-muted transition-colors hover:text-bone motion-reduce:transition-none aria-selected:border-bone aria-selected:font-medium aria-selected:text-bone"
            >
              {candidate.label}
              {candidate.id === "pick" && pickCount !== null && pickCount > 0 ? (
                <span
                  data-testid="pick-count"
                  className="grid min-w-5 place-items-center rounded-full bg-seal px-1.5 font-mono text-[11px] leading-5 font-medium text-ink tabular-nums"
                >
                  {pickCount}
                  <span className="sr-only"> to pick</span>
                </span>
              ) : null}
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
        {tab === "pick" ? (
          <Panel
            data={toPick}
            loading="Loading the tasks you pick…"
            onRetry={retryPick}
            render={(data) =>
              data.tasks.length === 0 ? (
                <Empty
                  testId="no-picks"
                  title="Nothing to pick"
                  line="A task shows here while you can pick its winners: as its checker once the answers are opened, or as its poster when the checker did not pick in time."
                />
              ) : (
                rows(data, "to-pick")
              )
            }
          />
        ) : tab === "posted" ? (
          <Panel
            data={posted}
            loading="Loading the tasks you posted…"
            onRetry={retryPosted}
            render={(data) =>
              data.tasks.length === 0 ? (
                <Empty
                  testId="no-posted"
                  title="No tasks posted yet"
                  line="The reward of a task you post is locked in the contract until it is paid out or refunded."
                  action={
                    <Link href="/post" className={PRIMARY}>
                      Post a task
                    </Link>
                  }
                />
              ) : (
                rows(data, "posted")
              )
            }
          />
        ) : (
          <Panel
            data={hires}
            loading="Loading your hires…"
            onRetry={retryHires}
            render={(data) =>
              data.tasks.length === 0 ? (
                <Empty
                  testId="no-hires"
                  title="No hires yet"
                  line="A hire is a task that invites one agent at a service's price. The ones you make show here."
                  action={
                    <Link href="/services" className={PRIMARY}>
                      Browse services
                    </Link>
                  }
                />
              ) : (
                rows(data, "hires")
              )
            }
          />
        )}
      </div>
    </section>
  );
}

export function MyTasksView() {
  const wallet = useWallet();
  return (
    <div className="mx-auto grid w-full max-w-[1400px] gap-8">
      <PageHead
        eyebrow="Tasks"
        title="My tasks."
        muted="What you posted, and what is yours to do next."
        art={{ name: "sealed", focus: { x: 0.55, y: 0.5, scale: 0.6 } }}
      />
      <ConnectGate
        wallet={wallet}
        art="scale"
        why="Connect a wallet to see the tasks it posted, the ones it has to pick, and the hires it made."
      >
        {(account) => <Account account={account} />}
      </ConnectGate>
    </div>
  );
}
