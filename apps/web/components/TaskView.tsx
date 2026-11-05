"use client";

import {
  type AgentSummary,
  type TaskDetailResponse,
  TaskViewSchema,
  U64StringSchema,
} from "@tender/shared";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { formatBps } from "../lib/bps";
import { useNowNs } from "../lib/clock";
import { config } from "../lib/config";
import { UNTITLED_TASK } from "../lib/copy";
import { errorMessage } from "../lib/errors";
import { type EventInfo, isBoardEvent, useEventsBy } from "../lib/events";
import { awaitsJudge, isJudgeAccount, JUDGE_POLL_MS } from "../lib/judge";
import { phaseOfTask } from "../lib/phase";
import { view } from "../lib/rpc";
import { Amount } from "./Amount";
import { Avatar } from "./Avatar";
import { TaskActions } from "./actions/TaskActions";
import { BriefSection } from "./BriefSection";
import { CriteriaSection } from "./CriteriaSection";
import { EntryList } from "./EntryList";
import { ErrorState } from "./ErrorState";
import { JudgeNote } from "./JudgeNote";
import { Payouts } from "./Payouts";
import { PhaseChip } from "./PhaseChip";
import { PhaseTimeline } from "./PhaseTimeline";
import { Questions } from "./Questions";
import { Scorecard } from "./Scorecard";
import { TASK_TITLE, TaskSkeleton } from "./SkeletonDetail";
import { SwarmTree } from "./SwarmTree";
import { TeamBadge } from "./TeamBadge";
import { EYEBROW, FACT_LABEL, PANEL, PANEL_TITLE, SECONDARY, TEXT_LINK } from "./ui";
import { VerifierRecord } from "./VerifierRecord";

interface Loaded {
  data: TaskDetailResponse;
  /**
   * The task's verifier as an agent: null if it never registered as one, and "unavailable" if its
   * profile could not be read just now. The task is the page, and the profile is a section of it.
   */
  verifier: AgentSummary | null | "unavailable";
}

/** An answer that could not be had again: what was shown stays, with this above it. */
interface Stale {
  message: string;
  retrying: boolean;
}

/**
 * Why the index has no task with an id, as far as the chain can say: the chain has it (the index
 * has not read that block yet), it has none, or it could not be asked.
 */
type Absence = "on_chain" | "none" | "unreadable";

type State =
  | { status: "loading" }
  | { status: "missing"; absence: Absence }
  | { status: "error"; message: string; retrying: boolean }
  | ({ status: "ready"; stale: Stale | null } & Loaded);

/** How often the page asks the index again for a task that is on chain and not indexed yet. */
const INDEX_POLL_MS = 4_000;
/** How long it keeps asking: a few minutes, which the index takes when it lags, and no more. */
const INDEX_POLL_WINDOW_MS = 5 * 60_000;
/**
 * How long the page waits for the stream to go quiet before it asks again. A burst of events, or a
 * replay after a phone wakes, then costs one load and not one for each event.
 */
const EVENTS_QUIET_MS = 300;
/**
 * The longest a burst keeps the page waiting. A stream that never goes quiet (a replay that
 * repeats, a server that sends without end) would put off the load for good, and the page would
 * show a task that has moved on without saying so.
 */
const EVENTS_MAX_WAIT_MS = 2_000;

/** What the page asks again for, by what an event is about. */
const EVENT_KINDS = ["task", "board", "tree"] as const;
type EventKind = (typeof EVENT_KINDS)[number];

/** The events of another task in the swarm tree that change what the tree shows of it. */
const TREE_EVENTS: ReadonlySet<string> = new Set(["task_topped_up", "picked", "voided"]);

/**
 * What an event is about, for the page of task `id`: the task itself, its question board (whose
 * events are the API's, not the contract's), or another task of its swarm tree (`tree`). Anything
 * else is no news here.
 */
function eventKind(event: EventInfo, id: string, tree: ReadonlySet<string>): EventKind | null {
  if (event.task_id === undefined) return null;
  if (isBoardEvent(event.event)) return event.task_id === id ? "board" : null;
  if (event.task_id === id) return "task";
  return tree.has(event.task_id) && TREE_EVENTS.has(event.event) ? "tree" : null;
}

/**
 * What the chain itself says of task `id`, read through the browser's RPC node: the index lags the
 * chain, and a poster who has just paid is sent to the page of a task the index has not seen.
 */
async function absenceOf(id: string): Promise<Absence> {
  if (!U64StringSchema.safeParse(id).success) return "none";
  try {
    const found = await view<unknown>(config.contractId, "get_task", { task_id: id });
    if (found === undefined || found === null) return "none";
    return TaskViewSchema.safeParse(found).success ? "on_chain" : "unreadable";
  } catch (error) {
    // The page says it could not look; the original goes to the console, where a developer looks.
    console.error(error);
    return "unreadable";
  }
}

/**
 * The task, then its verifier, which the task names. If the index has no such task, why not, as
 * far as the chain says.
 */
async function fetchTask(id: string): Promise<Loaded | { absence: Absence }> {
  const data = await api.getTask(id);
  if (data === null) return { absence: await absenceOf(id) };
  try {
    const record = await api.getAgent(data.task.verifier);
    return { data, verifier: record?.agent ?? null };
  } catch (error) {
    // The section says what is missing; the original goes to the console, where a developer looks.
    console.error(error);
    return { data, verifier: "unavailable" };
  }
}

/** The name the page has before it has a title: the task's number, if the address holds one. */
const headingFor = (id: string): string =>
  U64StringSchema.safeParse(id).success ? `Task #${id}` : "Task";

function Funders({ funders, token }: Pick<TaskDetailResponse, "funders"> & { token: string }) {
  if (funders.length === 0) return null;
  return (
    <section className={PANEL}>
      <h2 className={PANEL_TITLE}>Funders</h2>
      <ul className="grid">
        {funders.map((funder) => (
          <li
            key={funder.account}
            data-testid="funder-row"
            className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-line py-3 first:border-t-0 first:pt-0 last:pb-0"
          >
            <span className="min-w-0 font-mono text-[13px] wrap-anywhere">{funder.account}</span>
            <span className="tabular-nums">
              <Amount value={funder.amount} token={token} />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ReadyView({
  loaded,
  nowNs,
  stale,
  judgeAccount,
  onRetry,
  boardEvents,
  treeEvents,
  onTreeIds,
}: {
  loaded: Loaded;
  nowNs: bigint;
  stale: Stale | null;
  judgeAccount: string | null;
  onRetry: () => void;
  /** Goes up when the stream says the question board changed. */
  boardEvents: number;
  /** Goes up when the stream says another task of the swarm tree changed. */
  treeEvents: number;
  onTreeIds: (ids: ReadonlySet<string>) => void;
}) {
  const { task, brief, criteria, entries, funders, children, scorecard } = loaded.data;
  // The phase by the clock, so that a window ends on the page when it ends in the contract.
  const phase = phaseOfTask(task, nowNs);
  const scorecardHash = task.outcome?.scorecard_hash ?? null;
  const record = loaded.verifier === "unavailable" ? null : loaded.verifier;
  // The Judge is not a registered agent, so its profile says nothing: the team's own account is
  // labelled as ours whether or not it has one (spec 9.4).
  const isJudge = isJudgeAccount(task.verifier, judgeAccount);

  return (
    <article className="mx-auto grid w-full max-w-4xl gap-5">
      <header className="grid gap-5 pb-3">
        <p className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className={EYEBROW}>
            Task <span className="text-seal">&gt;</span>
          </span>
          <PhaseChip phase={phase} />
          <span className={EYEBROW}>#{task.id}</span>
          {task.category === null ? null : <span className={EYEBROW}>{task.category}</span>}
        </p>
        <h1 className="text-3xl leading-[1.08] font-semibold tracking-[-0.03em] text-bone wrap-anywhere sm:text-[2.6rem]">
          {task.title ?? UNTITLED_TASK}
        </h1>
        {/* The task's figures side by side, as the board's cards and the landing's are. */}
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-line bg-line lg:grid-cols-[minmax(0,1.3fr)_minmax(0,0.8fr)_minmax(0,0.8fr)_minmax(0,1.5fr)]">
          <div className="col-span-2 grid content-start gap-2 bg-panel p-5 sm:col-span-1">
            <p className={FACT_LABEL}>Reward</p>
            <p className="text-2xl leading-tight font-medium tracking-[-0.02em] text-bone tabular-nums">
              <Amount value={task.reward} token={task.token} />
            </p>
          </div>
          <div className="grid content-start gap-2 bg-panel p-5">
            <p className={FACT_LABEL}>Entries</p>
            <p className="text-2xl leading-tight font-medium tracking-[-0.02em] text-bone tabular-nums wrap-anywhere">
              {task.commit_count}
            </p>
            <p className="text-[13px] text-muted">{task.reveal_count} revealed</p>
          </div>
          <div className="grid content-start gap-2 bg-panel p-5">
            <p className={FACT_LABEL}>Platform fee</p>
            <p className="text-2xl leading-tight font-medium tracking-[-0.02em] text-bone tabular-nums">
              {formatBps(task.fee_bps)}
            </p>
            <p className="text-[13px] text-muted">Of the reward, when it is paid out</p>
          </div>
          <div className="col-span-2 grid content-start gap-2 bg-panel p-5 sm:col-span-1">
            <p className={FACT_LABEL}>Posted by</p>
            <p data-testid="poster" className="flex min-w-0 items-center gap-3">
              <Avatar account={task.poster} size={34} />
              <TeamBadge account={task.poster} isTeam={task.is_team_poster} />
            </p>
          </div>
        </div>
        {task.judge_status === null && task.judge_reason === null && task.parent === null ? null : (
          <div className="grid gap-1.5 text-sm text-muted">
            <JudgeNote status={task.judge_status} reason={task.judge_reason} />
            {task.parent === null ? null : (
              <p>
                Subtask of{" "}
                <Link
                  data-testid="parent-link"
                  href={`/tasks/${task.parent}`}
                  className={TEXT_LINK}
                >
                  Task #{task.parent}
                </Link>
              </p>
            )}
          </div>
        )}
      </header>

      {stale === null ? null : (
        <ErrorState
          message={`${stale.message} What is shown may be out of date.`}
          retrying={stale.retrying}
          onRetry={onRetry}
        />
      )}

      <PhaseTimeline task={task} nowNs={nowNs} />
      <BriefSection brief={brief} />
      <CriteriaSection criteria={criteria} />
      {/* The board explains the brief and the criteria, so it comes after them. */}
      <Questions task={task} phase={phase} refresh={boardEvents} />
      <EntryList entries={entries} phase={phase} />
      {/* What can be done now: pick, refund, top up (`#pick`, `#refund`, `#top-up`). */}
      <TaskActions data={loaded.data} nowNs={nowNs} judgeAccount={judgeAccount} />
      <VerifierRecord
        account={task.verifier}
        isJudge={isJudge}
        isTeam={isJudge || (record?.is_team ?? false)}
        picks_made={record?.picks_made ?? null}
        voids_after_reveals={record?.voids_after_reveals ?? null}
        isPoster={task.poster === task.verifier}
        unavailable={loaded.verifier === "unavailable"}
      />
      {scorecard !== null ? (
        <Scorecard
          scorecard={scorecard}
          commitment={task.heldout_commitment}
          judgeAccount={judgeAccount}
        />
      ) : scorecardHash === null ? null : (
        <section className={PANEL}>
          <h2 className={PANEL_TITLE}>Scorecard</h2>
          <p data-testid="scorecard-missing" className="text-sm text-muted wrap-anywhere">
            {`The scorecard is not available from this server. Its sha256 is ${scorecardHash}.`}
          </p>
        </section>
      )}
      {task.outcome === null ? null : (
        <Payouts
          outcome={task.outcome}
          token={task.token}
          poster={task.poster}
          verifier={task.verifier}
        />
      )}
      <Funders funders={funders} token={task.token} />
      {/* Where the subtasks were listed: the lineage, as a tree, on a task that has one. */}
      {task.parent === null && children.length === 0 ? null : (
        <SwarmTree current={loaded.data} nowNs={nowNs} refresh={treeEvents} onIds={onTreeIds} />
      )}
    </article>
  );
}

/**
 * A task's page. It loads the task from the API, then its verifier, and asks again whenever the
 * event stream reports something on this task, so that an entry or a reveal appears without a
 * reload. If asking again fails, what is shown stays, with a notice that it may be out of date. If
 * only the verifier's profile cannot be read, the task is shown and that section says so. The
 * phase and its countdown follow the clock.
 *
 * Two things are not announced by the stream, and the page asks for them itself:
 *
 * - The Judge's verdict. Intake writes it to the database and logs no event, and a poster lands
 *   here right after paying, so while the Judge is the verifier and has said nothing the page asks
 *   every few seconds (`awaitsJudge`).
 * - A task the index has not read yet. The page that the post wizard opens is for a task that is on
 *   chain, and the index lags. The page asks the chain, says what it finds, and asks the index
 *   again for a few minutes.
 */
export function TaskView({
  id,
  judgeAccount = config.judgeAccount,
}: {
  id: string;
  /** The Judge's account; this build's by default. */
  judgeAccount?: string | null;
}) {
  const [state, setState] = useState<State>({ status: "loading" });
  const nowNs = useNowNs();
  // The tasks of the swarm tree, as the tree last read them: their settling is news here too.
  const treeIds = useRef<ReadonlySet<string>>(new Set());
  const onTreeIds = useCallback((ids: ReadonlySet<string>) => {
    treeIds.current = ids;
  }, []);
  // One stream for the whole page; each part asks again for what an event is about.
  const counts = useEventsBy(EVENT_KINDS, (event) => eventKind(event, id, treeIds.current));
  const events = counts.task;
  // The request that counts. An answer to an earlier one is dropped: strict mode starts two
  // requests, and the stream can ask again while a slow answer is on its way.
  const latest = useRef(0);

  /** `quiet`: ask again without taking the page away, which is what the stream and the notice do. */
  const load = useCallback(
    (quiet: boolean) => {
      const request = ++latest.current;
      setState((was) => {
        if (quiet) {
          return was.status === "ready" && was.stale !== null
            ? { ...was, stale: { ...was.stale, retrying: true } }
            : was;
        }
        // A retry leaves the error and its button where they are, so that the person who pressed it
        // keeps their focus.
        return was.status === "error" ? { ...was, retrying: true } : { status: "loading" };
      });
      fetchTask(id).then(
        (loaded) => {
          if (request !== latest.current) return;
          setState(
            "absence" in loaded
              ? { status: "missing", absence: loaded.absence }
              : { status: "ready", stale: null, ...loaded },
          );
        },
        (error) => {
          if (request !== latest.current) return;
          // The person gets words; the original goes to the console, where a developer looks.
          console.error(error);
          const message = errorMessage(error);
          setState((was) =>
            was.status === "ready"
              ? { ...was, stale: { message, retrying: false } }
              : { status: "error", message, retrying: false },
          );
        },
      );
    },
    [id],
  );

  useEffect(() => {
    load(false);
  }, [load]);

  // The stream said something changed here, or it opened with nothing to resume from. A burst of
  // them is one load, a moment after the last, and no later than `EVENTS_MAX_WAIT_MS` after the
  // first.
  const burstSince = useRef<number | null>(null);
  useEffect(() => {
    if (events === 0) return;
    // The monotonic clock: the wall clock can be set back, or stand still in a test, and a burst
    // must still end.
    const now = performance.now();
    const since = burstSince.current ?? now;
    burstSince.current = since;
    const wait = Math.min(EVENTS_QUIET_MS, Math.max(0, since + EVENTS_MAX_WAIT_MS - now));
    const timer = setTimeout(() => {
      burstSince.current = null;
      load(true);
    }, wait);
    return () => clearTimeout(timer);
  }, [events, load]);

  // The Judge has not said what it makes of the task. `waitingOnJudge` changes when the verdict
  // comes, or the window for it ends, and not each second, so the timer runs undisturbed.
  const waitingOnJudge =
    state.status === "ready" && awaitsJudge(state.data.task, judgeAccount, nowNs);
  useEffect(() => {
    if (!waitingOnJudge) return;
    const timer = setInterval(() => load(true), JUDGE_POLL_MS);
    return () => clearInterval(timer);
  }, [waitingOnJudge, load]);

  // The chain has the task and the index does not yet.
  const waitingOnIndex = state.status === "missing" && state.absence === "on_chain";
  useEffect(() => {
    if (!waitingOnIndex) return;
    const until = Date.now() + INDEX_POLL_WINDOW_MS;
    const timer = setInterval(() => {
      if (Date.now() >= until) clearInterval(timer);
      else load(true);
    }, INDEX_POLL_MS);
    return () => clearInterval(timer);
  }, [waitingOnIndex, load]);

  const heading = headingFor(id);
  const plain = "mx-auto grid w-full max-w-4xl gap-6";
  const title = "text-3xl font-semibold tracking-[-0.03em] text-bone sm:text-[2.6rem]";
  switch (state.status) {
    case "loading":
      // The loaded page's shapes, in its boxes (components/Skeleton.tsx), under the task's number.
      return (
        <article className="relative mx-auto grid w-full max-w-4xl gap-5">
          <p role="status" className="sr-only">
            Loading task…
          </p>
          <TaskSkeleton heading={<h1 className={TASK_TITLE}>{heading}</h1>} />
        </article>
      );
    case "missing":
      return (
        <div className={plain}>
          <h1 className={title}>{heading}</h1>
          <Missing heading={heading} absence={state.absence} onCheck={() => load(true)} />
        </div>
      );
    case "error":
      return (
        <div className={plain}>
          <h1 className={title}>{heading}</h1>
          <ErrorState
            message={state.message}
            retrying={state.retrying}
            onRetry={() => load(false)}
          />
        </div>
      );
    case "ready":
      return (
        <ReadyView
          loaded={state}
          nowNs={nowNs}
          stale={state.stale}
          judgeAccount={judgeAccount}
          onRetry={() => load(true)}
          boardEvents={counts.board}
          treeEvents={counts.tree}
          onTreeIds={onTreeIds}
        />
      );
  }
}

/** What to say of a task the index does not have, by what the chain says. */
function Missing({
  heading,
  absence,
  onCheck,
}: {
  heading: string;
  absence: Absence;
  onCheck: () => void;
}) {
  if (absence === "none") {
    return <p className={`${PANEL} text-muted`}>There is no task with this id.</p>;
  }
  return (
    <div className={PANEL}>
      <p role="status" data-testid="not-indexed" className="text-bone">
        {absence === "on_chain"
          ? `${heading} is on chain. Tender's index hasn't caught up yet, so this page will fill in on its own.`
          : "There is no task with this id in Tender's index, and the chain could not be read to check. It may have been posted just now."}
      </p>
      <button type="button" onClick={onCheck} className={SECONDARY}>
        Check again
      </button>
    </div>
  );
}
