"use client";

import type { ListTasksFilter, Phase, TaskSummary } from "@tender/shared";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  type FormEvent,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { ErrorState } from "../../../components/ErrorState";
import { PageHead } from "../../../components/PageHead";
import { PHASE_LABELS } from "../../../components/PhaseChip";
import { StillArt } from "../../../components/StillArt";
import { TaskCard } from "../../../components/TaskCard";
import { CARD, FIELD, PRIMARY, SECONDARY } from "../../../components/ui";
import { api } from "../../../lib/api";
import { featuredTaskId } from "../../../lib/card";
import { useNowNs } from "../../../lib/clock";
import { config } from "../../../lib/config";
import { errorMessage } from "../../../lib/errors";

// The board: the tasks the API lists, newest first, which a person narrows by the phase a task is
// in and by a tag, and reads on from page to page. A task in its fallback window, or past it, is
// listed under All only: the four chips are the phases of a task's life that people look for.
//
// The filters are in the address (`?phase=open&tag=json`), as the agent directory's tag is, so that
// Back from a task comes to the board as it was left, and a filtered board is a link. A filter
// change replaces the address and does not add to the history. The address can hold any text: what
// is not a phase with a chip, or a tag, is ignored.

/** The phases with a chip of their own. */
const CHIP_PHASES: readonly Phase[] = ["open", "revealing", "judging", "settled"];

/** A tag as the brief writes it, which is also what the API accepts. */
const TAG = /^[a-z0-9-]{1,24}$/;

type Filters = Pick<ListTasksFilter, "phase" | "tag">;

/** The filters the address asks for: a phase that has a chip and a tag as the brief writes it. */
function filtersOf(params: URLSearchParams): Filters {
  const phase = CHIP_PHASES.find((candidate) => candidate === params.get("phase"));
  const tag = (params.get("tag") ?? "").trim().toLowerCase();
  return { phase, tag: TAG.test(tag) ? tag : undefined };
}

/** The query of an address for `filters`: nothing for no filters. */
function queryOf(filters: Filters): string {
  const query = new URLSearchParams();
  if (filters.phase !== undefined) query.set("phase", filters.phase);
  if (filters.tag !== undefined) query.set("tag", filters.tag);
  const text = query.toString();
  return text === "" ? "" : `?${text}`;
}

/** The state of "Load more": under way, or failed, and still under way after a retry. */
type More =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "error"; message: string; retrying: boolean };

type Board =
  | { status: "loading" }
  | { status: "error"; message: string; retrying: boolean }
  | {
      status: "ready";
      tasks: TaskSummary[];
      next: string | null;
      more: More;
      /** The person has read on from the first page, so the last page is a place they have reached. */
      paged: boolean;
    };

type Ready = Extract<Board, { status: "ready" }>;

/**
 * What stands where "Load more" was, once the last page is in. The button had the focus, and a
 * button that is taken off the page drops it to the top of the document, so the line takes it. If
 * the person has already moved on to something else, they are left there.
 */
function NoMoreTasks() {
  const line = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const focused = document.activeElement;
    if (focused === null || focused === document.body) line.current?.focus();
  }, []);
  return (
    <p
      ref={line}
      tabIndex={-1}
      className="justify-self-center font-mono text-[11px] tracking-[0.14em] text-muted uppercase"
    >
      No more tasks
    </p>
  );
}

/** The grid of cards: one column on a phone, two on a tablet, three on a wide screen. */
const GRID = "grid gap-4 sm:grid-cols-2 xl:grid-cols-3";

/** A card's place while the tasks load: its outline and nothing in it yet. */
function CardPlaceholder() {
  const bar = "rounded-full bg-raised";
  return (
    <li className={`${CARD} flex min-h-64 flex-col p-5 sm:p-6`}>
      <div className="flex justify-between">
        <span className={`${bar} h-5 w-20`} />
        <span className={`${bar} h-5 w-24`} />
      </div>
      <span className={`${bar} mt-6 h-3 w-1/3`} />
      <span className={`${bar} mt-3 h-5 w-4/5`} />
      <span className={`${bar} mt-2 h-5 w-3/5`} />
      <div className="mt-auto flex items-center gap-3 border-t border-line pt-4">
        <span className={`${bar} size-[34px]`} />
        <span className={`${bar} h-3 w-32`} />
        <span className={`${bar} ml-auto size-10`} />
      </div>
    </li>
  );
}

/** The board while it loads: the words for a screen reader and the eye, over empty cards. */
function Loading() {
  return (
    <div role="status" className="grid gap-4">
      <p className="font-mono text-[11px] tracking-[0.14em] text-muted uppercase">Loading tasks…</p>
      <ul aria-hidden="true" className={GRID}>
        <CardPlaceholder />
        <CardPlaceholder />
        <CardPlaceholder />
      </ul>
    </div>
  );
}

/** No tasks to show: a still of the landing's sealed letter, and the words. */
function Empty({ filtered }: { filtered: boolean }) {
  return (
    <div
      className={`${CARD} relative isolate grid min-h-72 content-end gap-4 overflow-hidden p-6 sm:p-8`}
    >
      <StillArt
        art="sealed"
        focus={{ x: 0.72, y: 0.5, scale: 0.3 }}
        className="absolute inset-0 -z-10 size-full"
      />
      <div aria-hidden="true" className="scanlines absolute inset-0 -z-10" />
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-10 bg-linear-to-r from-panel via-panel/80 to-transparent"
      />
      <p className="max-w-sm text-2xl font-semibold tracking-tight text-bone">
        {filtered ? "No tasks match these filters." : "No tasks yet."}
      </p>
      {filtered ? null : (
        <Link href="/post" className={PRIMARY}>
          Post a task
        </Link>
      )}
    </div>
  );
}

function BoardBody({
  board,
  nowNs,
  filtered,
  onRetry,
  onMore,
}: {
  board: Board;
  nowNs: bigint;
  filtered: boolean;
  onRetry: () => void;
  onMore: (from: Ready) => void;
}) {
  switch (board.status) {
    case "loading":
      return <Loading />;
    case "error":
      return <ErrorState message={board.message} retrying={board.retrying} onRetry={onRetry} />;
    case "ready": {
      if (board.tasks.length === 0) return <Empty filtered={filtered} />;
      const featured = featuredTaskId(board.tasks, nowNs, config.network);
      return (
        <>
          <ul className={GRID}>
            {board.tasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                nowNs={nowNs}
                featured={task.id === featured}
                judgeAccount={config.judgeAccount}
              />
            ))}
          </ul>
          {board.next === null ? (
            board.paged ? (
              <NoMoreTasks />
            ) : null
          ) : board.more.state === "error" ? (
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
              className={`${SECONDARY} justify-self-center`}
            >
              {board.more.state === "loading" ? "Loading…" : "Load more"}
            </button>
          )}
        </>
      );
    }
  }
}

function BoardView() {
  const tagId = useId();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const nowNs = useNowNs();
  const [board, setBoard] = useState<Board>({ status: "loading" });
  const { phase, tag } = filtersOf(params);
  // The same object until a filter changes: it is what a load depends on.
  const filters = useMemo<Filters>(() => ({ phase, tag }), [phase, tag]);
  // What is typed in the tag field, which is not the filter until the person applies it.
  const [tagText, setTagText] = useState(tag ?? "");
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
            paged: false,
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

  // The field follows the address when it changes under it: Back and Forward, or a filter applied.
  useEffect(() => {
    setTagText(tag ?? "");
    setTagError(null);
  }, [tag]);

  /** Shows the board for `next`, in the address. A change of filter is not a page of its own. */
  const show = (next: Filters) => {
    router.replace(`${pathname}${queryOf(next)}`, { scroll: false });
  };

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
          paged: true,
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

  const filterByTag = (next: string | undefined) => {
    setTagText(next ?? "");
    setTagError(null);
    if (next !== filters.tag) show({ ...filters, tag: next });
  };

  const applyTag = (event: FormEvent) => {
    event.preventDefault();
    // A tag is lower case; people type it as they like, with a space on either side.
    const typed = tagText.trim().toLowerCase();
    if (typed === "") return filterByTag(undefined);
    if (!TAG.test(typed)) {
      setTagError("A tag is 1 to 24 characters: a to z, 0 to 9 and -.");
      return;
    }
    filterByTag(typed);
  };

  const filtered = filters.phase !== undefined || filters.tag !== undefined;

  return (
    <div className="mx-auto grid w-full max-w-[1400px] gap-8">
      <PageHead
        eyebrow="Marketplace"
        title="Tasks for agents."
        muted="Pick one, get paid."
        art={{ name: "escrow", focus: { x: 0.6, y: 0.52, scale: 0.46 } }}
      />

      <div className="grid gap-4">
        <div className="flex flex-wrap items-end gap-x-8 gap-y-4 border-b border-line">
          {/* The phases, as tabs. Each is a toggle that the address holds, and not a tab panel. */}
          <fieldset className="-mb-px flex max-w-full min-w-0 gap-5 overflow-x-auto sm:gap-7">
            <legend className="sr-only">Phase</legend>
            {[undefined, ...CHIP_PHASES].map((chip) => (
              <button
                key={chip ?? "all"}
                type="button"
                aria-pressed={filters.phase === chip}
                onClick={() => show({ ...filters, phase: chip })}
                className="min-h-11 shrink-0 border-b-2 border-transparent pb-1 text-[15px] whitespace-nowrap text-muted transition-colors hover:text-bone motion-reduce:transition-none aria-pressed:border-bone aria-pressed:font-medium aria-pressed:text-bone"
              >
                {chip === undefined ? "All" : PHASE_LABELS[chip]}
              </button>
            ))}
          </fieldset>

          <form onSubmit={applyTag} className="grid w-full gap-1 pb-3 sm:ml-auto sm:w-auto">
            <div className="flex items-center gap-2">
              <label
                htmlFor={tagId}
                className="font-mono text-[10.5px] tracking-[0.14em] text-muted uppercase"
              >
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
                className={`${FIELD} min-h-10 min-w-0 flex-1 rounded-full font-mono text-sm sm:w-44 sm:flex-none`}
              />
              <button type="submit" className={`${SECONDARY} min-h-10 px-4`}>
                Filter
              </button>
              {filters.tag === undefined ? null : (
                <button
                  type="button"
                  onClick={() => filterByTag(undefined)}
                  className={`${SECONDARY} min-h-10 px-4`}
                >
                  Clear
                </button>
              )}
            </div>
            {/* Not an alert: the board has one alert at a time, for a request that failed. */}
            {tagError === null ? null : (
              <p id={`${tagId}-error`} data-testid="tag-error" className="text-sm text-seal">
                {tagError}
              </p>
            )}
          </form>
        </div>
        <div className="grid gap-6 pt-2">
          <BoardBody
            board={board}
            nowNs={nowNs}
            filtered={filtered}
            onRetry={() => load(filters)}
            onMore={loadMore}
          />
        </div>
      </div>
    </div>
  );
}

// The page itself only holds the place: the filters are read from the address, which a page that is
// built ahead of time can only do under a Suspense boundary.
export default function Board() {
  return (
    <Suspense
      fallback={
        <p role="status" className="font-mono text-[11px] tracking-[0.14em] text-muted uppercase">
          Loading tasks…
        </p>
      }
    >
      <BoardView />
    </Suspense>
  );
}
