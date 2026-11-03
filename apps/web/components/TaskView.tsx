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
import { useNowNs } from "../lib/clock";
import { config } from "../lib/config";
import { errorMessage } from "../lib/errors";
import { useEvents } from "../lib/events";
import { awaitsJudge, isJudgeAccount, JUDGE_POLL_MS } from "../lib/judge";
import { phaseOfTask } from "../lib/phase";
import { view } from "../lib/rpc";
import { Amount } from "./Amount";
import { BriefSection } from "./BriefSection";
import { CriteriaSection } from "./CriteriaSection";
import { EntryList } from "./EntryList";
import { ErrorState } from "./ErrorState";
import { JudgeNote } from "./JudgeNote";
import { Payouts } from "./Payouts";
import { PhaseChip } from "./PhaseChip";
import { PhaseTimeline } from "./PhaseTimeline";
import { Scorecard } from "./Scorecard";
import { TeamBadge } from "./TeamBadge";
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
    <section className="grid gap-2">
      <h2 className="text-lg font-semibold">Funders</h2>
      <ul className="grid gap-2">
        {funders.map((funder) => (
          <li
            key={funder.account}
            data-testid="funder-row"
            className="flex flex-wrap items-baseline gap-x-3 gap-y-1"
          >
            <span className="font-mono text-sm wrap-anywhere">{funder.account}</span>
            <Amount value={funder.amount} token={token} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function Subtasks({ ids }: { ids: TaskDetailResponse["children"] }) {
  if (ids.length === 0) return null;
  return (
    <section className="grid gap-2">
      <h2 className="text-lg font-semibold">Subtasks</h2>
      <ul className="grid gap-1">
        {ids.map((id) => (
          <li key={id}>
            <Link data-testid="child-link" href={`/tasks/${id}`} className="underline">
              Task #{id}
            </Link>
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
}: {
  loaded: Loaded;
  nowNs: bigint;
  stale: Stale | null;
  judgeAccount: string | null;
  onRetry: () => void;
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
    <article className="grid gap-8">
      <header className="grid gap-2">
        <h1 className="text-2xl font-semibold wrap-anywhere">
          {task.title ?? "Untitled task (no public brief yet)"}
        </h1>
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-neutral-700">
          <span>#{task.id}</span>
          <PhaseChip phase={phase} />
          <Amount value={task.reward} token={task.token} />
        </p>
        <p data-testid="poster" className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <span className="text-neutral-700">Posted by</span>
          <TeamBadge account={task.poster} isTeam={task.is_team_poster} />
        </p>
        <JudgeNote status={task.judge_status} reason={task.judge_reason} />
        {task.parent === null ? null : (
          <p className="text-sm">
            Subtask of{" "}
            <Link data-testid="parent-link" href={`/tasks/${task.parent}`} className="underline">
              Task #{task.parent}
            </Link>
          </p>
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
      <EntryList entries={entries} phase={phase} />
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
        <Scorecard scorecard={scorecard} commitment={task.heldout_commitment} />
      ) : scorecardHash === null ? null : (
        <section className="grid gap-2">
          <h2 className="text-lg font-semibold">Scorecard</h2>
          <p data-testid="scorecard-missing" className="text-sm wrap-anywhere">
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
      <Subtasks ids={children} />
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
  const events = useEvents((event) => event.task_id === id);
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
  // them is one load, a moment after the last.
  useEffect(() => {
    if (events === 0) return;
    const timer = setTimeout(() => load(true), EVENTS_QUIET_MS);
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
  switch (state.status) {
    case "loading":
      return (
        <div className="grid gap-4">
          <h1 className="text-2xl font-semibold">{heading}</h1>
          <p role="status">Loading task…</p>
        </div>
      );
    case "missing":
      return (
        <div className="grid gap-4">
          <h1 className="text-2xl font-semibold">{heading}</h1>
          <Missing heading={heading} absence={state.absence} onCheck={() => load(true)} />
        </div>
      );
    case "error":
      return (
        <div className="grid gap-4">
          <h1 className="text-2xl font-semibold">{heading}</h1>
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
  if (absence === "none") return <p>There is no task with this id.</p>;
  return (
    <div className="grid gap-3">
      <p role="status" data-testid="not-indexed">
        {absence === "on_chain"
          ? `${heading} is on chain. Tender's index hasn't caught up yet, so this page will fill in on its own.`
          : "There is no task with this id in Tender's index, and the chain could not be read to check. It may have been posted just now."}
      </p>
      <button
        type="button"
        onClick={onCheck}
        className="min-h-11 w-fit rounded border border-neutral-900 px-4"
      >
        Check again
      </button>
    </div>
  );
}
