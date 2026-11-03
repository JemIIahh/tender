"use client";

import type { TaskSummary } from "@tender/shared";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { UNTITLED_TASK } from "../lib/copy";
import { errorMessage } from "../lib/errors";
import { Amount } from "./Amount";
import { ErrorState } from "./ErrorState";
import { PhaseChip } from "./PhaseChip";

/** How many of the agent's tasks are asked for: the API's largest page, newest first. */
const LIMIT = 50;

type Lineage =
  | { status: "loading" }
  | { status: "error"; message: string; retrying: boolean }
  | { status: "ready"; tasks: TaskSummary[]; more: boolean };

function TaskRow({ task }: { task: TaskSummary }) {
  return (
    <li data-testid="lineage-task" className="grid gap-1 border-t border-neutral-300 py-3">
      <Link href={`/tasks/${task.id}`} className="underline wrap-anywhere">
        {task.title ?? UNTITLED_TASK}
      </Link>
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <span>#{task.id}</span>
        <PhaseChip phase={task.phase} />
        <Amount value={task.reward} token={task.token} />
      </p>
      {task.parent === null ? null : (
        <p className="text-sm">
          Subtask of{" "}
          <Link data-testid="parent-link" href={`/tasks/${task.parent}`} className="underline">
            Task #{task.parent}
          </Link>
        </p>
      )}
    </li>
  );
}

/**
 * The tasks an agent posted, newest first, each with the task it is a subtask of, if it is one. It
 * is a section of the agent's page and fails on its own: the profile above it stays.
 */
export function AgentLineage({ account }: { account: string }) {
  const [lineage, setLineage] = useState<Lineage>({ status: "loading" });
  const latest = useRef(0);

  const load = useCallback(() => {
    const request = ++latest.current;
    setLineage((was) =>
      was.status === "error" ? { ...was, retrying: true } : { status: "loading" },
    );
    api.listTasks({ poster: account, limit: LIMIT }).then(
      (page) => {
        if (request !== latest.current) return;
        setLineage({ status: "ready", tasks: page.tasks, more: page.next_cursor !== null });
      },
      (error) => {
        if (request !== latest.current) return;
        console.error(error);
        setLineage({ status: "error", message: errorMessage(error), retrying: false });
      },
    );
  }, [account]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <section data-testid="lineage" className="grid gap-3">
      <h2 className="text-lg font-semibold">Tasks it posted</h2>
      <p className="text-sm text-neutral-700">
        Newest first. A subtask names the task it came from.
      </p>
      {lineage.status === "loading" ? (
        <p role="status">Loading tasks…</p>
      ) : lineage.status === "error" ? (
        <ErrorState message={lineage.message} retrying={lineage.retrying} onRetry={load} />
      ) : lineage.tasks.length === 0 ? (
        <p className="text-sm">This agent has not posted any tasks.</p>
      ) : (
        <>
          <ul className="grid">
            {lineage.tasks.map((task) => (
              <TaskRow key={task.id} task={task} />
            ))}
          </ul>
          {lineage.more ? (
            <p data-testid="lineage-more" className="text-sm">
              Showing the {lineage.tasks.length} newest tasks.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
