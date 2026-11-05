"use client";

import type { Service } from "@tender/shared";
import Link from "next/link";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  type ActivityKind,
  type ActivityLine,
  ago,
  FEED_EVENTS,
  type FeedEvent,
  FILTERS,
  fromBacklog,
  fromStream,
  groupLines,
  lineOf,
  mergeFeed,
  type Part,
  tokensPosted,
} from "../lib/activity";
import { api } from "../lib/api";
import { listenToEvents } from "../lib/events";
import { scrollCue } from "../lib/scrollCue";
import { knowsToken } from "../lib/tokens";
import { useLoad } from "../lib/useLoad";
import { useWallet } from "../lib/wallet";
import { Amount, RawUnits } from "./Amount";
import { ErrorState } from "./ErrorState";
import { PageHead } from "./PageHead";
import { FeedSkeleton } from "./SkeletonLists";
import { CARD, PRIMARY, SCROLL_CUE, TEXT_LINK } from "./ui";

// Activity: what happens on Tender, one plain line an event, newest first. The page reads the API's
// backlog of recent events once, then follows the event stream from the newest of them (the same
// stream client the task page uses), so it misses nothing between the two and polls nothing.

/** How many events the backlog brings. */
const BACKLOG = 50;
const SHOWN: ReadonlySet<string> = new Set(FEED_EVENTS);

interface Backlog {
  events: FeedEvent[];
  /** The id the stream opens after. */
  newest: string;
  /** The services listed, which tell the hire of one from another pinned task. */
  services: Service[];
}

/** How many pages of services the page reads to tell hires by: 250 services. */
const SERVICE_PAGES = 5;

/** Every service, paused ones too, page after page, up to `SERVICE_PAGES` of them. */
async function readServices(): Promise<Service[]> {
  const services: Service[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < SERVICE_PAGES; page++) {
    const answer = await api.listServices({ status: "all", limit: 50, cursor });
    services.push(...answer.services);
    if (answer.next_cursor === null) break;
    cursor = answer.next_cursor;
  }
  return services;
}

/**
 * The backlog, and the services that a hire is told by. Without the services (they could not be
 * read, or there are more than `SERVICE_PAGES` pages of them), a hire of a Judge-checked service
 * that is not among them reads as a task posted, which is also true.
 */
async function readBacklog(): Promise<Backlog> {
  const [recent, services] = await Promise.allSettled([
    api.recentEvents({ limit: BACKLOG, event: FEED_EVENTS }),
    readServices(),
  ]);
  if (recent.status === "rejected") throw recent.reason;
  if (services.status === "rejected") console.error(services.reason);
  return {
    events: recent.value.events.map(fromBacklog),
    newest: recent.value.newest,
    services: services.status === "fulfilled" ? services.value : [],
  };
}

/** The time now in ms, read again every 30 seconds: a line says how long ago, to the minute. */
function useNowMs(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** The icon at the start of a line: what kind of event it is, as a picture; the words say it too. */
const ICONS: Record<ActivityKind, ReactNode> = {
  posted: (
    <>
      <path d="M4 1.8h5l3 3v9.4H4z" />
      <path d="M9 1.8v3h3M8 7.6v4.2M5.9 9.7h4.2" />
    </>
  ),
  hired: (
    <>
      <path d="M2.2 5.2h11.6v8H2.2z" />
      <path d="M5.8 5.2V3.4h4.4v1.8M2.2 8.8h11.6" />
    </>
  ),
  entered: (
    <>
      <path d="M1.8 3.8h12.4v8.4H1.8z" />
      <path d="M1.8 3.8L8 8.6l6.2-4.8" />
    </>
  ),
  revealed: (
    <>
      <path d="M1.8 7L8 2.8 14.2 7v6.2H1.8z" />
      <path d="M1.8 7L8 11l6.2-4" />
    </>
  ),
  paid: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M5.4 8.2l1.8 1.8 3.4-3.6" />
    </>
  ),
  refunded: (
    <>
      <path d="M5.8 3.6L2.6 6.8l3.2 3.2" />
      <path d="M2.6 6.8h7.2a3.6 3.6 0 010 7.2H8.4" />
    </>
  ),
  agent: (
    <>
      <circle cx="8" cy="5.4" r="2.6" />
      <path d="M2.8 14c.6-2.9 2.6-4.3 5.2-4.3s4.6 1.4 5.2 4.3" />
    </>
  ),
};

function KindIcon({ kind }: { kind: ActivityKind }) {
  return (
    <span
      aria-hidden="true"
      className={`grid size-7 shrink-0 place-items-center rounded-full border ${
        kind === "paid" ? "border-seal/50 text-seal" : "border-line text-bone/80"
      }`}
    >
      <svg
        viewBox="0 0 16 16"
        aria-hidden="true"
        className="size-3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {ICONS[kind]}
      </svg>
    </span>
  );
}

/**
 * An account in a line, short: its first label in full, and the rest of it muted, cut short with
 * "…" when the line has no room for it (`lead` `.tender-dev-1104.testnet`). The whole of it is its
 * title, and the words a screen reader says.
 */
function AccountName({ account, agent }: { account: string; agent: boolean }) {
  const dot = account.indexOf(".");
  const head = dot === -1 ? account : account.slice(0, dot);
  const tail = dot === -1 ? "" : account.slice(dot);
  const name = (
    <>
      {/* The first label is kept whole; the rest gives way. An account of one label (an
          implicit one, 64 characters) is cut short itself. */}
      <span className={`font-medium text-bone ${tail === "" ? "min-w-0 truncate" : "shrink-0"}`}>
        {head}
      </span>
      {tail === "" ? null : <span className="min-w-0 truncate text-muted">{tail}</span>}
    </>
  );
  const shape =
    "inline-flex max-w-[min(100%,15rem)] min-w-0 align-bottom font-mono text-[13px] whitespace-nowrap";
  return agent ? (
    <Link
      href={`/agents/${account}`}
      title={account}
      className={`${shape} underline decoration-bone/30 underline-offset-4 transition-colors hover:decoration-bone motion-reduce:transition-none`}
    >
      {name}
    </Link>
  ) : (
    <span title={account} className={shape}>
      {name}
    </span>
  );
}

function PartView({ part }: { part: Part }) {
  if (part.kind === "text") return <span>{part.text}</span>;
  if (part.kind === "task") {
    return (
      <Link href={`/tasks/${part.taskId}`} className={TEXT_LINK}>
        task #{part.taskId}
      </Link>
    );
  }
  return <AccountName account={part.account} agent={part.agent} />;
}

function LineAmounts({ line }: { line: ActivityLine }) {
  if (line.amounts.length === 0 && !line.amountPending) return null;
  return (
    <span className="grid gap-0.5 text-[13px] text-bone">
      {line.amounts.map(([token, amount]) => (
        <span
          key={token}
          className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 sm:justify-end"
        >
          <span className="text-muted">{line.amountLabel}</span>
          {knowsToken(token) ? (
            <span className="tabular-nums">
              <Amount value={amount.toString()} token={token} />
            </span>
          ) : (
            <span className="text-[12px]">
              <RawUnits value={amount.toString()} token={token} />
            </span>
          )}
        </span>
      ))}
      {line.amountPending ? (
        <span data-testid="amount-pending" className="text-muted">
          {line.amountLabel}: reading the task's token…
        </span>
      ) : null}
    </span>
  );
}

function Line({ line, nowMs }: { line: ActivityLine; nowMs: number }) {
  const at = new Date(line.atMs);
  return (
    <li
      data-testid="activity-line"
      data-kind={line.kind}
      className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-0.5 border-t border-line px-4 py-2 first:border-t-0 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:px-5"
    >
      <KindIcon kind={line.kind} />
      <p className="min-w-0 text-[14px] leading-snug text-muted">
        {line.parts.map((part, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a line's parts are fixed in their order
          <span key={index}>
            {/* A comma goes on the word before it. */}
            {index === 0 || (part.kind === "text" && part.text === ",") ? null : " "}
            <PartView part={part} />
          </span>
        ))}
        {line.note === null ? null : <span>: {line.note}</span>}
      </p>
      {/* The amount and the time, together at the right of the line. */}
      <div className="col-start-2 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 sm:col-start-auto sm:justify-end sm:text-right">
        <LineAmounts line={line} />
        <time
          dateTime={at.toISOString()}
          title={at.toLocaleString()}
          className="font-mono text-[11.5px] whitespace-nowrap text-muted sm:min-w-[4.5rem]"
        >
          {ago(line.atMs, nowMs)}
        </time>
      </div>
    </li>
  );
}

/**
 * The tasks' tokens the page has asked the API for: those of the picks and voids the stream told of
 * on a task the page has not seen posted, each asked for once. Null for one that could not be read:
 * its line goes without the amount, and its task's page has it.
 */
function useFetchedTokens(feed: readonly FeedEvent[], posted: ReadonlyMap<string, string>) {
  const [fetched, setFetched] = useState<ReadonlyMap<string, string | null>>(new Map());
  const asked = useRef(new Set<string>());
  useEffect(() => {
    for (const event of feed) {
      if (event.event !== "picked" && event.event !== "voided") continue;
      const id = event.task_id;
      if (id === null || event.token !== null || posted.has(id) || asked.current.has(id)) continue;
      asked.current.add(id);
      const found = (token: string | null) => setFetched((was) => new Map(was).set(id, token));
      api.getTask(id).then(
        (detail) => found(detail?.task.token ?? null),
        (error) => {
          console.error(error);
          found(null);
        },
      );
    }
  }, [feed, posted]);
  return fetched;
}

function Feed({ backlog, onResync }: { backlog: Backlog; onResync: () => void }) {
  const id = useId();
  const nowMs = useNowMs();
  const wallet = useWallet();
  // The latest of the page's way to read the backlog again, for the stream's handler.
  const resyncRef = useRef(onResync);
  resyncRef.current = onResync;
  const [feed, setFeed] = useState<FeedEvent[]>(backlog.events);
  const [filter, setFilter] = useState(FILTERS[0]?.id ?? "all");
  const [mine, setMine] = useState(false);

  // The stream, from the newest event of the backlog: what happened after it, as it happens. It is
  // the tab's one stream (`listenToEvents`), shared with any other part that listens.
  useEffect(() => {
    const stream = listenToEvents(
      {
        onEvent: () => {},
        // The stream can't vouch for what came before: the feed is read again, backlog and all
        // (the API's database started over, say, and the ids the feed holds are of the old one).
        onResync: () => resyncRef.current(),
        onMessage: (message) => {
          if (!SHOWN.has(message.event)) return;
          setFeed((was) => mergeFeed(was, [fromStream(message, Date.now())]));
        },
      },
      { since: backlog.newest },
    );
    return () => stream.close();
  }, [backlog.newest]);

  const posted = useMemo(() => tokensPosted(feed), [feed]);
  const fetched = useFetchedTokens(feed, posted);
  const lines = useMemo(() => {
    const ctx = {
      tokenOf: (taskId: string) => posted.get(taskId) ?? fetched.get(taskId) ?? undefined,
      unread: (taskId: string) => fetched.get(taskId) === null,
      services: backlog.services,
    };
    return feed.flatMap((event) => {
      const line = lineOf(event, ctx);
      return line === null ? [] : [line];
    });
  }, [feed, posted, fetched, backlog.services]);

  const kinds = new Set(FILTERS.find((choice) => choice.id === filter)?.kinds ?? []);
  const account = wallet.accountId;
  // Filtered first, so that a run of one account's lines is said as one only within what is shown.
  const shown = groupLines(
    lines.filter(
      (line) =>
        kinds.has(line.kind) && (!mine || account === null || line.accounts.includes(account)),
    ),
  );

  return (
    <section className={`${CARD} grid grid-cols-1 overflow-hidden`}>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b border-line px-4 py-3 sm:px-5">
        {/* On a phone the row is wider than the screen and scrolls: while there is more of it
            past its right edge, the edge fades out, so that the choices past it show as more to
            come (`SCROLL_CUE`). */}
        <fieldset
          ref={scrollCue}
          data-testid="activity-filters"
          className={`-mx-1 flex max-w-full min-w-0 gap-1 overflow-x-auto px-1 py-0.5 ${SCROLL_CUE}`}
        >
          <legend className="sr-only">Show</legend>
          {FILTERS.map((choice) => (
            <button
              key={choice.id}
              type="button"
              aria-pressed={filter === choice.id}
              onClick={() => setFilter(choice.id)}
              className="min-h-10 shrink-0 rounded-full border border-transparent px-3.5 text-sm whitespace-nowrap text-muted transition-colors hover:text-bone motion-reduce:transition-none aria-pressed:border-line aria-pressed:bg-raised aria-pressed:text-bone"
            >
              {choice.label}
            </button>
          ))}
        </fieldset>
        {account === null ? null : (
          <label
            htmlFor={`${id}-mine`}
            className="flex min-h-10 cursor-pointer items-center gap-2.5 text-sm text-bone"
          >
            <input
              id={`${id}-mine`}
              type="checkbox"
              checked={mine}
              onChange={(event) => setMine(event.target.checked)}
              className="size-4 accent-[var(--color-bone)]"
            />
            Mine only
          </label>
        )}
      </div>
      <p className="sr-only" role="status">
        {`${shown.length} ${shown.length === 1 ? "line" : "lines"} shown`}
      </p>
      {lines.length === 0 ? (
        <div data-testid="activity-empty" className="grid justify-items-start gap-2 p-6">
          <p className="text-lg font-medium text-bone">Nothing has happened yet</p>
          <p className="max-w-md text-sm text-muted">
            Tasks posted, entries, payouts and new agents show here as they happen.
          </p>
          <Link href="/post" className={`${PRIMARY} mt-2`}>
            Post a task
          </Link>
        </div>
      ) : shown.length === 0 ? (
        <p data-testid="activity-none-shown" className="p-6 text-sm text-muted">
          {mine
            ? "None of the latest activity is yours."
            : "None of the latest activity is of this kind."}
        </p>
      ) : (
        <ol data-testid="activity" className="grid">
          {shown.map((line) => (
            <Line key={line.key} line={line} nowMs={nowMs} />
          ))}
        </ol>
      )}
      <p className="border-t border-line px-4 py-3 text-[13px] text-muted sm:px-5">
        Newest first, as it happens. Amounts are in each task&rsquo;s token.
      </p>
    </section>
  );
}

export function ActivityView() {
  const [backlog, retry] = useLoad("activity", readBacklog);
  return (
    <div className="mx-auto grid w-full max-w-5xl gap-8">
      <PageHead
        eyebrow="Live"
        title="Activity."
        muted="What happens on Tender, as it happens."
        art={{ name: "signal", focus: { x: 0.55, y: 0.5, scale: 0.6 } }}
      />
      {backlog.status === "ready" ? (
        <Feed backlog={backlog.data} onResync={retry} />
      ) : backlog.status === "error" ? (
        <ErrorState message={backlog.message} retrying={backlog.retrying} onRetry={retry} />
      ) : (
        <>
          <p role="status" className="sr-only">
            Loading activity…
          </p>
          <FeedSkeleton />
        </>
      )}
    </div>
  );
}
