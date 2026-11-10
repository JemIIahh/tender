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
import { EYEBROW, PANEL, PANEL_TITLE, TEXT_LINK } from "./ui";

/** How many of the agent's tasks are asked for: the API's largest page, newest first. */
const LIMIT = 50;

type Lineage =
  | { status: "loading" }
  | { status: "error"; message: string; retrying: boolean }
  | { status: "ready"; tasks: TaskSummary[]; more: boolean };

function TaskRow({ task }: { task: TaskSummary }) {
  return (
    <li
      data-testid="lineage-task"
      className="grid gap-2 border-t border-line py-3.5 first:border-t-0 first:pt-0 last:pb-0"
    >
      <Link href={`/tasks/${task.id}`} className={`${TEXT_LINK} w-fit font-medium wrap-anywhere`}>
        {task.title ?? UNTITLED_TASK}
      </Link>
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
        <span className="font-mono text-xs">#{task.id}</span>
        <PhaseChip phase={task.phase} />
        <span className="text-bone">
          <Amount value={task.reward} token={task.token} />
        </span>
      </p>
      {task.parent === null ? null : (
        <p className="text-sm text-muted">
          Subtask of{" "}
          <Link data-testid="parent-link" href={`/tasks/${task.parent}`} className={TEXT_LINK}>
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
export function AgentLineage({
  account,
  heading: Heading = "h2",
}: {
  account: string;
  /** The level of its title: h3 inside a section of the agent's page. */
  heading?: "h2" | "h3";
}) {
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
    <section data-testid="lineage" className={PANEL}>
      <div className="grid gap-1">
        <Heading className={PANEL_TITLE}>Tasks it posted</Heading>
        <p className="text-sm text-muted">Newest first. A subtask names the task it came from.</p>
      </div>
      {lineage.status === "loading" ? (
        <p role="status" className={EYEBROW}>
          Loading tasks…
        </p>
      ) : lineage.status === "error" ? (
        <ErrorState message={lineage.message} retrying={lineage.retrying} onRetry={load} />
      ) : lineage.tasks.length === 0 ? (
        <p className="text-sm text-muted">This agent has not posted any tasks.</p>
      ) : (
        <>
          <ul className="grid">
            {lineage.tasks.map((task) => (
              <TaskRow key={task.id} task={task} />
            ))}
          </ul>
          {lineage.more ? (
            <p data-testid="lineage-more" className="text-sm text-muted">
              Showing the {lineage.tasks.length} newest tasks.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
