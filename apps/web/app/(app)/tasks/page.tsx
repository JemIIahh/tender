"use client";

import {
  formatTokenAmount,
  type ListTasksFilter,
  type TaskSummary,
  tokenMeta,
} from "@tender/shared";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EmptyState } from "../../../components/EmptyState";
import { ErrorState } from "../../../components/ErrorState";
import { PageHead } from "../../../components/PageHead";
import { CARD_GRID, CardsSkeleton } from "../../../components/Skeleton";
import { TaskCard } from "../../../components/TaskCard";
import { PRIMARY, SECONDARY, SEGMENT, SEGMENTS } from "../../../components/ui";
import { api } from "../../../lib/api";
import {
  type BoardSummary,
  boardSummary,
  featuredTaskId,
  type Segment,
  segmentOf,
} from "../../../lib/card";
import { useNowNs } from "../../../lib/clock";
import { config } from "../../../lib/config";
import { errorMessage } from "../../../lib/errors";
import { knownFirst, knowsToken } from "../../../lib/tokens";
import RouteLoading from "./loading";

// The board: the tasks the API lists, newest first, a page of 50 at a time. Under the headline, a
// line says how many of them are open and what they hold in the contract, and a segmented control
// narrows them by where they are in their life (by the clock, as each card says it): open, being
// revealed and judged, or settled. A task in its fallback window, or past it, is listed under All
// only. The counts and the line are of the tasks the board has read, and say so when there are more.
//
// The filters are in the address (`?phase=open`, and `?tag=json`, which the API narrows by), so
// that Back from a task comes to the board as it was left, and a filtered board is a link. A filter
// change replaces the address and does not add to the history. The address can hold any text: what
// is not a segment, or a tag, is ignored.

/** The segments, in the order the control shows them, after All. */
const SEGMENTS_SHOWN: ReadonlyArray<{ segment: Segment; label: string }> = [
  { segment: "open", label: "Open" },
  { segment: "judging", label: "Judging" },
  { segment: "settled", label: "Settled" },
];

/** What an address's `phase` names: a segment, or a phase inside one (an older link's). */
const ADDRESS_SEGMENT: Record<string, Segment> = {
  open: "open",
  judging: "judging",
  revealing: "judging",
  settled: "settled",
};

/** A tag as the brief writes it, which is also what the API accepts. */
const TAG = /^[a-z0-9-]{1,24}$/;

/** The API's largest page: the board reads this many tasks at a time. */
const PAGE_SIZE = 50;

interface Filters {
  segment: Segment | undefined;
  tag: ListTasksFilter["tag"];
}

/** The filters the address asks for: a segment of the control, and a tag as the brief writes it. */
function filtersOf(params: URLSearchParams): Filters {
  const segment = ADDRESS_SEGMENT[params.get("phase") ?? ""];
  const tag = (params.get("tag") ?? "").trim().toLowerCase();
  return { segment, tag: TAG.test(tag) ? tag : undefined };
}

/** The query of an address for `filters`: nothing for no filters. */
function queryOf(filters: Filters): string {
  const query = new URLSearchParams();
  if (filters.segment !== undefined) query.set("phase", filters.segment);
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
    <p ref={line} tabIndex={-1} className="justify-self-center text-sm text-muted">
      No more tasks
    </p>
  );
}

/** The grid of cards: one column on a phone, two on a tablet, three on a wide screen. */
const GRID = CARD_GRID;

/**
 * The board while it loads: the cards' shapes where the cards will be (components/Skeleton.tsx, as
 * the route's loading.tsx draws them), and the words for a screen reader.
 */
function Loading() {
  return (
    <div role="status" className="relative grid">
      <p className="sr-only">Loading tasks…</p>
      <CardsSkeleton />
    </div>
  );
}

/** No tasks to show: a line, a sentence, and the one thing to do. */
function Empty({ filtered }: { filtered: boolean }) {
  return filtered ? (
    <EmptyState
      title="No tasks match these filters."
      action={
        <Link href="/tasks" className={PRIMARY}>
          Show all tasks
        </Link>
      }
    >
      Try another phase, or see every task on the board.
    </EmptyState>
  ) : (
    <EmptyState
      title="No tasks yet."
      action={
        <Link href="/post" className={PRIMARY}>
          Post a task
        </Link>
      }
    >
      Say what you need and lock the reward: agents compete to do it.
    </EmptyState>
  );
}

/** An amount of a token the app knows, as a figure and its symbol. */
function tokenText(token: string, amount: bigint): string {
  const { symbol, decimals } = tokenMeta(token, config.network);
  return `${formatTokenAmount(amount, decimals)} ${symbol}`;
}

/**
 * The line under the headline: how many of the tasks the board has are open, and what their rewards
 * lock in the contract, token by token (a token the app has no decimals for is left out of the
 * line; its cards say its amount). With more tasks to read, it says it counts the loaded ones.
 */
function Summary({
  summary,
  loaded,
  more,
}: {
  summary: BoardSummary;
  loaded: number;
  more: boolean;
}) {
  const locked = knownFirst(summary.locked, ([token]) => token).filter(([token]) =>
    knowsToken(token),
  );
  return (
    <p
      data-testid="board-summary"
      title="The open tasks among those loaded, and what their rewards lock in the contract"
      className="flex min-w-0 items-center gap-2.5 text-[15px] text-muted"
    >
      <span
        aria-hidden="true"
        className={`size-2 shrink-0 rounded-full ${summary.open > 0 ? "bg-ok" : "border-[1.5px] border-muted"}`}
      />
      <span className="min-w-0">
        <span className="font-medium text-bone tabular-nums">{summary.open}</span> open
        {locked.map(([token, amount]) => (
          <span key={token}>
            {" · "}
            <span className="font-medium text-bone tabular-nums">{tokenText(token, amount)}</span>{" "}
            locked
          </span>
        ))}
        {more ? ` · of the ${loaded} tasks loaded` : null}
      </span>
    </p>
  );
}

/** The summary line's place while the board loads, as tall as the line. */
function SummaryShape() {
  return (
    <span aria-hidden="true" className="flex h-[1lh] items-center text-[15px]">
      <span className="skeleton h-[0.62em] w-44 rounded-full" />
    </span>
  );
}

function BoardBody({
  board,
  nowNs,
  segment,
  filtered,
  onRetry,
  onMore,
}: {
  board: Board;
  nowNs: bigint;
  segment: Segment | undefined;
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
      const shown =
        segment === undefined
          ? board.tasks
          : board.tasks.filter((task) => segmentOf(task, nowNs) === segment);
      const featured = featuredTaskId(board.tasks, nowNs, config.network);
      return (
        <>
          {shown.length === 0 ? (
            <Empty filtered={filtered} />
          ) : (
            <ul className={GRID}>
              {shown.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  nowNs={nowNs}
                  featured={task.id === featured}
                  judgeAccount={config.judgeAccount}
                />
              ))}
            </ul>
          )}
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
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const nowNs = useNowNs();
  const [board, setBoard] = useState<Board>({ status: "loading" });
  const { segment, tag } = filtersOf(params);
  // The same value until the tag changes: it is what a load depends on. The segment is not: it
  // narrows the tasks the board has, by the clock, and asks the API for nothing.
  const filters = useMemo<Filters>(() => ({ segment, tag }), [segment, tag]);
  // The request that counts. An answer to an earlier one is dropped: strict mode starts two
  // requests, a retry can overlap a slow one, and a tag changed under a request makes its answer
  // one for a board that is no longer there.
  const latest = useRef(0);

  const load = useCallback((now: string | undefined) => {
    const request = ++latest.current;
    // A retry leaves the error and its button where they are, so that the person who pressed it
    // keeps their focus: a button that is taken off the page drops it to the top of the document.
    setBoard((was) =>
      was.status === "error" ? { ...was, retrying: true } : { status: "loading" },
    );
    api.listTasks({ tag: now, limit: PAGE_SIZE }).then(
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
    load(tag);
  }, [tag, load]);

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
    api.listTasks({ tag: filters.tag, limit: PAGE_SIZE, cursor: from.next }).then(
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

  const filtered = filters.segment !== undefined || filters.tag !== undefined;
  const ready = board.status === "ready" ? board : null;
  // How many of the tasks the board has are in each segment, by the clock.
  const counts = useMemo(() => {
    const by: Record<Segment | "all", number> = { all: 0, open: 0, judging: 0, settled: 0 };
    for (const task of ready?.tasks ?? []) {
      by.all += 1;
      const at = segmentOf(task, nowNs);
      if (at !== null) by[at] += 1;
    }
    return by;
  }, [ready, nowNs]);

  return (
    <div className="mx-auto grid w-full max-w-[1400px] grid-cols-1 gap-8">
      <PageHead title="Tasks for agents." muted="Pick one, get paid." />

      <div className="grid gap-6">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
          <div className="grid min-w-0 gap-2">
            {ready === null ? (
              <SummaryShape />
            ) : (
              <Summary
                summary={boardSummary(ready.tasks, nowNs)}
                loaded={ready.tasks.length}
                more={ready.next !== null}
              />
            )}
            {filters.tag === undefined ? null : (
              <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
                Tagged <span className="font-medium text-bone">{filters.tag}</span>
                <button
                  type="button"
                  onClick={() => show({ ...filters, tag: undefined })}
                  className={`${SECONDARY} min-h-8 px-3 text-[13px]`}
                >
                  Clear
                </button>
              </p>
            )}
          </div>
          {/* The segments: each is a toggle that the address holds, and not a tab panel. On a
              narrow phone the track scrolls sideways rather than wrap. */}
          <fieldset className={`${SEGMENTS} max-w-full overflow-x-auto`}>
            <legend className="sr-only">Phase</legend>
            {[{ segment: undefined, label: "All" }, ...SEGMENTS_SHOWN].map((chip) => (
              <button
                key={chip.segment ?? "all"}
                type="button"
                aria-pressed={filters.segment === chip.segment}
                onClick={() => show({ ...filters, segment: chip.segment })}
                className={SEGMENT}
              >
                {chip.label}{" "}
                {ready === null ? null : (
                  <span className="text-[13px] tabular-nums opacity-70">
                    {counts[chip.segment ?? "all"]}
                  </span>
                )}
              </button>
            ))}
          </fieldset>
        </div>
        <div className="grid gap-6">
          <BoardBody
            board={board}
            nowNs={nowNs}
            segment={filters.segment}
            filtered={filtered}
            onRetry={() => load(filters.tag)}
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
    <Suspense fallback={<RouteLoading />}>
      <BoardView />
    </Suspense>
  );
}
