"use client";

import type { ListTasksFilter, Phase, TaskSummary } from "@tender/shared";
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { ErrorState } from "../components/ErrorState";
import { PHASE_LABELS } from "../components/PhaseChip";
import { TaskCard } from "../components/TaskCard";
import { api } from "../lib/api";
import { errorMessage } from "../lib/errors";

// The board: the tasks the API lists, newest first, which a person narrows by the phase a task is
// in and by a tag, and reads on from page to page. A task in its fallback window, or past it, is
// listed under All only: the four chips are the phases of a task's life that people look for.

/** The phases with a chip of their own. */
const CHIP_PHASES: readonly Phase[] = ["open", "revealing", "judging", "settled"];

/** A tag as the brief writes it, which is also what the API accepts. */
const TAG = /^[a-z0-9-]{1,24}$/;

type Filters = Pick<ListTasksFilter, "phase" | "tag">;

/** The state of "Load more": under way, or failed, and still under way after a retry. */
type More =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "error"; message: string; retrying: boolean };

type Board =
  | { status: "loading" }
  | { status: "error"; message: string; retrying: boolean }
  | { status: "ready"; tasks: TaskSummary[]; next: string | null; more: More };

type Ready = Extract<Board, { status: "ready" }>;

function BoardBody({
  board,
  filtered,
  onRetry,
  onMore,
  onTag,
}: {
  board: Board;
  filtered: boolean;
  onRetry: () => void;
  onMore: (from: Ready) => void;
  onTag: (tag: string) => void;
}) {
  switch (board.status) {
    case "loading":
      return <p role="status">Loading tasks…</p>;
    case "error":
      return <ErrorState message={board.message} retrying={board.retrying} onRetry={onRetry} />;
    case "ready":
      if (board.tasks.length === 0) {
        return <p>{filtered ? "No tasks match these filters." : "No tasks yet."}</p>;
      }
      return (
        <>
          <ul className="grid gap-3">
            {board.tasks.map((task) => (
              <TaskCard key={task.id} task={task} onTag={onTag} />
            ))}
          </ul>
          {board.next === null ? null : board.more.state === "error" ? (
            <ErrorState
              message={board.more.message}
              retrying={board.more.retrying}
              onRetry={() => onMore(board)}
            />
          ) : (
            // `aria-disabled` and not `disabled`, as the retry button: the focus stays on it.
            <button
              type="button"
              aria-disabled={board.more.state === "loading"}
              onClick={() => onMore(board)}
              className="min-h-11 w-fit rounded border border-neutral-900 px-4"
            >
              {board.more.state === "loading" ? "Loading…" : "Load more"}
            </button>
          )}
        </>
      );
  }
}

export default function Home() {
  const tagId = useId();
  const [board, setBoard] = useState<Board>({ status: "loading" });
  const [filters, setFilters] = useState<Filters>({});
  // What is typed in the tag field, which is not the filter until the person applies it.
  const [tagText, setTagText] = useState("");
  const [tagError, setTagError] = useState<string | null>(null);
  // The request that counts. An answer to an earlier one is dropped: strict mode starts two
  // requests, a retry can overlap a slow one, and a filter changed under a request makes its
  // answer one for a board that is no longer there.
  const latest = useRef(0);

  const load = useCallback((now: Filters) => {
    const request = ++latest.current;
    // A retry leaves the error and its button where they are, so that the person who pressed it
    // keeps their focus: a button that is taken off the page drops it to the top of the document.
    setBoard((was) =>
      was.status === "error" ? { ...was, retrying: true } : { status: "loading" },
    );
    api.listTasks(now).then(
      (page) => {
        if (request === latest.current) {
          setBoard({
            status: "ready",
            tasks: page.tasks,
            next: page.next_cursor,
            more: { state: "idle" },
          });
        }
      },
      (error) => {
        if (request !== latest.current) return;
        // The person gets words (`errorMessage`); the original, with its status, its body and the
        // field a schema refused, goes to the console, where a developer looks.
        console.error(error);
        setBoard({ status: "error", message: errorMessage(error), retrying: false });
      },
    );
  }, []);

  useEffect(() => {
    load(filters);
  }, [filters, load]);

  /** The next page, after the tasks the board has. */
  const loadMore = (from: Ready) => {
    if (from.next === null || from.more.state === "loading") return;
    if (from.more.state === "error" && from.more.retrying) return;
    const request = ++latest.current;
    setBoard({
      ...from,
      more: from.more.state === "error" ? { ...from.more, retrying: true } : { state: "loading" },
    });
    api.listTasks({ ...filters, cursor: from.next }).then(
      (page) => {
        if (request !== latest.current) return;
        setBoard({
          status: "ready",
          tasks: [...from.tasks, ...page.tasks],
          next: page.next_cursor,
          more: { state: "idle" },
        });
      },
      (error) => {
        if (request !== latest.current) return;
        console.error(error);
        setBoard({
          ...from,
          more: { state: "error", message: errorMessage(error), retrying: false },
        });
      },
    );
  };

  const filterByTag = (tag: string | undefined) => {
    setTagText(tag ?? "");
    setTagError(null);
    setFilters((now) => (now.tag === tag ? now : { ...now, tag }));
  };

  const applyTag = (event: FormEvent) => {
    event.preventDefault();
    // A tag is lower case; people type it as they like, with a space on either side.
    const tag = tagText.trim().toLowerCase();
    if (tag === "") return filterByTag(undefined);
    if (!TAG.test(tag)) {
      setTagError("A tag is 1 to 24 characters: a to z, 0 to 9 and -.");
      return;
    }
    filterByTag(tag);
  };

  const filtered = filters.phase !== undefined || filters.tag !== undefined;

  return (
    <div className="grid gap-4">
      <h1 className="text-2xl font-semibold">Tasks</h1>

      <fieldset className="flex min-w-0 flex-wrap gap-2">
        <legend className="sr-only">Phase</legend>
        {[undefined, ...CHIP_PHASES].map((phase) => (
          <button
            key={phase ?? "all"}
            type="button"
            aria-pressed={filters.phase === phase}
            onClick={() => setFilters((now) => ({ ...now, phase }))}
            className="min-h-11 rounded border border-neutral-900 px-3 aria-pressed:bg-neutral-900 aria-pressed:text-white"
          >
            {phase === undefined ? "All" : PHASE_LABELS[phase]}
          </button>
        ))}
      </fieldset>

      <form onSubmit={applyTag} className="grid gap-1">
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid gap-1">
            <label htmlFor={tagId} className="text-sm">
              Tag
            </label>
            <input
              id={tagId}
              value={tagText}
              onChange={(event) => setTagText(event.currentTarget.value)}
              aria-describedby={tagError === null ? undefined : `${tagId}-error`}
              aria-invalid={tagError !== null}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="min-h-11 w-48 rounded border border-neutral-900 px-2"
            />
          </div>
          <button type="submit" className="min-h-11 rounded border border-neutral-900 px-4">
            Filter
          </button>
          {filters.tag === undefined ? null : (
            <button
              type="button"
              onClick={() => filterByTag(undefined)}
              className="min-h-11 rounded border border-neutral-900 px-4"
            >
              Clear
            </button>
          )}
        </div>
        {/* Not an alert: the board has one alert at a time, for a request that failed. */}
        {tagError === null ? null : (
          <p id={`${tagId}-error`} data-testid="tag-error" className="text-sm">
            {tagError}
          </p>
        )}
      </form>

      <BoardBody
        board={board}
        filtered={filtered}
        onRetry={() => load(filters)}
        onMore={loadMore}
        onTag={filterByTag}
      />
    </div>
  );
}
