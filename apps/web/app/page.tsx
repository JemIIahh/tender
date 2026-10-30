"use client";

import type { TaskSummary } from "@tender/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { Amount } from "../components/Amount";
import { ErrorState } from "../components/ErrorState";
import { TeamBadge } from "../components/TeamBadge";
import { api } from "../lib/api";
import { errorMessage } from "../lib/errors";

// A placeholder board: the first page of tasks from the API, as a plain list. 06-T2 builds the
// real one, with the phase chips, the tag filter and the links to the task pages.

type Board =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; tasks: TaskSummary[] };

function TaskCard({ task }: { task: TaskSummary }) {
  return (
    <li data-testid="task-card" className="rounded border border-neutral-300 p-4">
      <h2 className="font-semibold wrap-anywhere">
        {task.title ?? "Untitled task (no public brief yet)"}
      </h2>
      <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-neutral-700">
        <span>#{task.id}</span>
        <span>{task.phase}</span>
        <Amount value={task.reward} token={task.token} />
        <span>
          {task.commit_count} {task.commit_count === 1 ? "entry" : "entries"}
        </span>
      </p>
      <p data-testid="poster" className="mt-2 flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className="text-neutral-700">Posted by</span>
        <TeamBadge account={task.poster} isTeam={task.is_team_poster} />
      </p>
    </li>
  );
}

function BoardBody({ board, onRetry }: { board: Board; onRetry: () => void }) {
  switch (board.status) {
    case "loading":
      return <p role="status">Loading tasks…</p>;
    case "error":
      return <ErrorState message={board.message} onRetry={onRetry} />;
    case "ready":
      return board.tasks.length === 0 ? (
        <p>No tasks yet.</p>
      ) : (
        <ul className="grid gap-3">
          {board.tasks.map((task) => (
            <TaskCard key={task.id} task={task} />
          ))}
        </ul>
      );
  }
}

export default function Home() {
  const [board, setBoard] = useState<Board>({ status: "loading" });
  // The request that counts. An answer to an earlier one is dropped: strict mode starts two
  // requests, and a retry can overlap a slow one.
  const latest = useRef(0);

  const load = useCallback(() => {
    const request = ++latest.current;
    setBoard({ status: "loading" });
    api.listTasks().then(
      (page) => {
        if (request === latest.current) setBoard({ status: "ready", tasks: page.tasks });
      },
      (error) => {
        if (request === latest.current) setBoard({ status: "error", message: errorMessage(error) });
      },
    );
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="grid gap-4">
      <h1 className="text-2xl font-semibold">Tasks</h1>
      <BoardBody board={board} onRetry={load} />
    </div>
  );
}
