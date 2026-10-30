"use client";

import type { AgentSummary, TaskDetailResponse } from "@tender/shared";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { useNowNs } from "../lib/clock";
import { errorMessage } from "../lib/errors";
import { useEvents } from "../lib/events";
import { phaseOfTask } from "../lib/phase";
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
  /** The task's verifier as an agent, or null if it never registered as one. */
  verifier: AgentSummary | null;
}

/** An answer that could not be had again: what was shown stays, with this above it. */
interface Stale {
  message: string;
  retrying: boolean;
}

type State =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "error"; message: string; retrying: boolean }
  | ({ status: "ready"; stale: Stale | null } & Loaded);

/** The task, then its verifier, which the task names. Null if there is no such task. */
async function fetchTask(id: string): Promise<Loaded | null> {
  const data = await api.getTask(id);
  if (data === null) return null;
  const record = await api.getAgent(data.task.verifier);
  return { data, verifier: record?.agent ?? null };
}

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
  onRetry,
}: {
  loaded: Loaded;
  nowNs: bigint;
  stale: Stale | null;
  onRetry: () => void;
}) {
  const { task, brief, criteria, entries, funders, children, scorecard } = loaded.data;
  // The phase by the clock, so that a window ends on the page when it ends in the contract.
  const phase = phaseOfTask(task, nowNs);
  const scorecardHash = task.outcome?.scorecard_hash ?? null;

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
        isTeam={loaded.verifier?.is_team ?? false}
        picks_made={loaded.verifier?.picks_made ?? null}
        voids_after_reveals={loaded.verifier?.voids_after_reveals ?? null}
        isPoster={task.poster === task.verifier}
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
 * reload. If asking again fails, what is shown stays, with a notice that it may be out of date.
 * The phase and its countdown follow the clock.
 */
export function TaskView({ id }: { id: string }) {
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
            loaded === null ? { status: "missing" } : { status: "ready", stale: null, ...loaded },
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

  // The stream said something changed here, or it opened with nothing to resume from.
  useEffect(() => {
    if (events > 0) load(true);
  }, [events, load]);

  switch (state.status) {
    case "loading":
      return <p role="status">Loading task…</p>;
    case "missing":
      return <p>There is no task with this id.</p>;
    case "error":
      return (
        <ErrorState message={state.message} retrying={state.retrying} onRetry={() => load(false)} />
      );
    case "ready":
      return (
        <ReadyView loaded={state} nowNs={nowNs} stale={state.stale} onRetry={() => load(true)} />
      );
  }
}
