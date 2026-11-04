import {
  BOARD_EVENT_NAMES,
  BoardEventSchema,
  EventMessageSchema,
  TenderEventSchema,
  U64StringSchema,
} from "@tender/shared";
import { useEffect, useRef, useState } from "react";
import { config } from "./config";

// `GET /v1/events`, the API's stream of what the indexer has stored, for a page that wants to know
// when something it shows has changed. The page asks again when told; the stream never carries
// state, only that an event happened. Next to the contract's events it carries the question
// board's (spec 7.2.1: `question_asked` and the rest), which name a task and a row and no text.

const STREAM_URL = `${config.apiUrl}/v1/events`;

/** How long to leave a server that refused a stream, the first time. It doubles from here. */
const MIN_BACKOFF_MS = 1_000;
/** The longest wait between two tries, and the longest a `Retry-After` is taken at its word. */
const MAX_BACKOFF_MS = 30_000;
/** How long the probe for `Retry-After` is given to answer, before the stream is reopened without it. */
const PROBE_TIMEOUT_MS = 5_000;

/** The board's events, which the API writes to the same stream (they are not the contract's). */
const BOARD_EVENTS: ReadonlySet<string> = new Set(BOARD_EVENT_NAMES);

/** Whether `event` is a name of the question board's events, and not of the contract's. */
export const isBoardEvent = (event: string): boolean => BOARD_EVENTS.has(event);

/**
 * Every event the contract logs, and every event of the board, by name. The API names each message
 * of the stream with its event (`event: committed`), so a browser hands it only to a listener for
 * that name, and `onmessage` never fires. A name the schemas do not know gets no listener and
 * never arrives.
 */
const EVENT_NAMES: string[] = [
  ...TenderEventSchema.options.map((option) => option.shape.event.value),
  ...BOARD_EVENT_NAMES,
];

/** What a page's filter sees of a message: which event, and the task it is about, if any. */
export interface EventInfo {
  event: string;
  task_id?: string;
}

/**
 * A message of the stream in full, for a page that shows the events themselves (the Activity feed):
 * its id (undefined if the stream sent none that is a u64), the event and its data as its schema
 * parsed them, the block it was logged in, and the task it is about.
 */
export interface StreamEvent {
  id: string | undefined;
  event: string;
  data: Record<string, unknown>;
  height: string;
  task_id: string | null;
}

export interface EventHandlers {
  /** A message of the stream was an event of the contract. */
  onEvent(info: EventInfo): void;
  /**
   * The stream has opened, or come back, with no event id to resume from, so the server will not
   * replay what happened before it: a page that showed something a moment ago should ask again.
   */
  onResync(): void;
  /** The same message as `onEvent`, whole, for a page that wants more than that it happened. */
  onMessage?(message: StreamEvent): void;
}

export interface ConnectOptions {
  /**
   * The id of the last event the page already has (a backlog it read): the stream begins after it
   * (`?since=`), with nothing to resync. A value that is not a u64 is not used.
   */
  since?: string;
}

export interface EventStream {
  close(): void;
}

/**
 * How long a `Retry-After` header asks for, in milliseconds: delta-seconds (`5`) or an HTTP date.
 * Anything else is undefined.
 */
function retryAfterMs(header: string | null): number | undefined {
  if (header === null) return undefined;
  const text = header.trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  // The one date form that current servers write (IMF-fixdate). `Date.parse` alone would take
  // some text that is not a date at all.
  if (/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text)) {
    const at = Date.parse(text);
    if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  }
  return undefined;
}

/**
 * How long the server asks a client to wait, learnt by asking the stream's address with `fetch`.
 * An `EventSource` cannot say: when a response is not a stream the browser reports an error with no
 * status and no headers, and closes for good. The API turns a stream away with a 503 and
 * `Retry-After: 5` when it is full, and lets the page read that header (CORS exposes it).
 *
 * If the server lets this request in, that opens a stream nobody wants, so it is cut off as soon
 * as the headers are here, whatever they say. A server that turned the stream away may not answer
 * this request either, and the reopen waits for it, so it is cut off after `PROBE_TIMEOUT_MS` too.
 * Undefined if there was no answer or no header.
 *
 * Being cut off (by the timer, or by `controller.abort()` from outside) ends the wait at once,
 * whether or not the `fetch` takes the abort to heart: the reopen never depends on it.
 */
async function askHowLongToWait(controller: AbortController): Promise<number | undefined> {
  const { signal } = controller;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cutOff = new Promise<undefined>((resolve) => {
    signal.addEventListener("abort", () => resolve(undefined), { once: true });
    timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  });
  try {
    const asked = fetch(STREAM_URL, { headers: { Accept: "text/event-stream" }, signal }).then(
      (response) => retryAfterMs(response.headers.get("Retry-After")),
    );
    return await Promise.race([asked, cutOff]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/**
 * Opens the stream and keeps it open until `close`.
 *
 * - When a connection ends or is lost, the browser reconnects by itself and sends the last id it
 *   got as `Last-Event-ID`, so nothing is missed. That includes the server ending a stream after
 *   its ten minutes.
 * - When the server answers with something that is not a stream (a 503 when it is full, a 500),
 *   the browser gives up for good: the `EventSource` is `CLOSED`. This waits and opens a new one,
 *   at `?since=` the last id it got. The wait doubles from a second to 30 seconds, and is at least
 *   what `Retry-After` asks for, which is read with a request of its own that is given five
 *   seconds to answer. It starts at a second again once a connection opens.
 * - A message that is not an event the contract logs is dropped, and logged.
 * - Given `since`, the first stream opens at `?since=` that id, as if it had got it: the server
 *   sends what came after it, and there is nothing to resync.
 */
export function connectEvents(
  { onEvent, onResync, onMessage }: EventHandlers,
  { since }: ConnectOptions = {},
): EventStream {
  let source: EventSource | undefined;
  let lastId: string | undefined =
    since !== undefined && U64StringSchema.safeParse(since).success ? since : undefined;
  // A stream that has never been open has nothing to resume from, unless it was given an id.
  let needsResync = lastId === undefined;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let probe: AbortController | undefined;
  let closed = false;

  function receive(event: MessageEvent): void {
    if (closed) return;
    // Where the stream is now, whether or not the message is of any use. An id that is not a u64
    // would be refused as `?since=`, with a 400 that closes the stream for good, so it is not kept.
    const id = U64StringSchema.safeParse(event.lastEventId).success ? event.lastEventId : undefined;
    if (id !== undefined) lastId = id;

    let json: unknown;
    try {
      json = JSON.parse(String(event.data));
    } catch (error) {
      console.error("events: a message is not JSON", error);
      return;
    }
    const message = EventMessageSchema.safeParse(json);
    if (!message.success) {
      console.error("events: a message is not one the API sends", message.error);
      return;
    }
    // The event as the contract logs it, or as the board writes it. The schemas drop a key they do
    // not know, so a field added to an event later does not stop this page hearing about it.
    const schema = isBoardEvent(message.data.event) ? BoardEventSchema : TenderEventSchema;
    const known = schema.safeParse({
      event: message.data.event,
      data: message.data.data,
    });
    if (!known.success) {
      console.error(`events: ${message.data.event} does not fit its schema`, known.error);
      return;
    }
    onEvent({ event: known.data.event, task_id: message.data.task_id ?? undefined });
    onMessage?.({
      id,
      event: known.data.event,
      data: known.data.data as Record<string, unknown>,
      height: message.data.height,
      task_id: message.data.task_id,
    });
  }

  function open(): void {
    const stream = new EventSource(
      lastId === undefined ? STREAM_URL : `${STREAM_URL}?since=${lastId}`,
    );
    source = stream;

    stream.addEventListener("open", () => {
      failures = 0;
      if (needsResync) {
        needsResync = false;
        onResync();
      }
    });
    stream.addEventListener("error", () => {
      if (closed) return;
      // Whichever way this ends, a connection with no id behind it will come back with none.
      if (lastId === undefined) needsResync = true;
      // `CONNECTING`: the browser is trying again and will send Last-Event-ID. `CLOSED`: it will not.
      if (stream.readyState === EventSource.CLOSED) reconnectLater();
    });
    for (const name of EVENT_NAMES) {
      stream.addEventListener(name, (event) => receive(event as MessageEvent));
    }
  }

  function reconnectLater(): void {
    const backoff = Math.min(MIN_BACKOFF_MS * 2 ** failures, MAX_BACKOFF_MS);
    failures += 1;
    const asking = new AbortController();
    probe = asking;
    void askHowLongToWait(asking).then((asked) => {
      if (closed) return;
      const wait = Math.max(backoff, Math.min(asked ?? 0, MAX_BACKOFF_MS));
      timer = setTimeout(() => {
        timer = undefined;
        if (!closed) open();
      }, wait);
    });
  }

  open();

  return {
    close() {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      probe?.abort();
      source?.close();
    },
  };
}

// ---- One stream for the tab -------------------------------------------------------------------

/** How many of the latest messages the tab's stream keeps, for a listener that joins it late. */
const KEPT_MESSAGES = 200;

interface Listener {
  handlers: EventHandlers;
}

/**
 * The tab's one stream, shared by every listener (`listenToEvents`), and what it has heard: the
 * latest messages with an id, so that a listener that joins with `since` is handed what came after
 * it. `from` is the id the stream is known to hold every event after (undefined: it does not know,
 * such as a stream that opened with nothing to resume from), and `dropped` the newest id that is no
 * longer kept.
 */
interface TabStream {
  stream: EventStream;
  listeners: Set<Listener>;
  kept: StreamEvent[];
  from: bigint | undefined;
  dropped: bigint | undefined;
}

/** The tab's stream, while anything listens to it. */
let shared: TabStream | null = null;

const u64 = (id: string | undefined): bigint | undefined =>
  id !== undefined && U64StringSchema.safeParse(id).success ? BigInt(id) : undefined;

/**
 * Listens to the tab's one stream of `GET /v1/events` until `close`: the first listener opens it
 * (`connectEvents`, at `since` if it has one) and the last one to close closes it. However many
 * parts of a page listen, the tab holds one connection (the API holds a client to a few).
 *
 * Every listener hears every message (`onEvent` and `onMessage`) and every resync (`onResync`), as
 * a stream of its own would tell it. One that joins a stream already open with `since` is first
 * handed the kept messages after that id, in order; if the stream can't say it heard everything
 * after it (it opened later than that, or no longer keeps them), the listener is told to resync.
 */
export function listenToEvents(
  handlers: EventHandlers,
  { since }: ConnectOptions = {},
): EventStream {
  const listener: Listener = { handlers };
  if (shared === null) {
    const start = u64(since);
    const tab: TabStream = {
      listeners: new Set([listener]),
      kept: [],
      from: start,
      dropped: undefined,
      stream: { close() {} },
    };
    shared = tab;
    tab.stream = connectEvents(
      {
        onEvent: () => {},
        onResync: () => {
          // What came before is not sent again: the stream is no longer sure of anything kept.
          tab.kept = [];
          tab.from = undefined;
          tab.dropped = undefined;
          for (const one of [...tab.listeners]) one.handlers.onResync();
        },
        onMessage: (message) => {
          if (message.id !== undefined) {
            tab.kept.push(message);
            if (tab.kept.length > KEPT_MESSAGES) tab.dropped = u64(tab.kept.shift()?.id);
          }
          const info: EventInfo = { event: message.event, task_id: message.task_id ?? undefined };
          for (const one of [...tab.listeners]) {
            one.handlers.onEvent(info);
            one.handlers.onMessage?.(message);
          }
        },
      },
      { since },
    );
  } else {
    const tab = shared;
    tab.listeners.add(listener);
    const after = u64(since);
    if (after !== undefined) {
      const missing =
        tab.from === undefined ||
        tab.from > after ||
        (tab.dropped !== undefined && tab.dropped > after);
      for (const message of tab.kept) {
        const id = u64(message.id);
        if (id === undefined || id <= after) continue;
        handlers.onEvent({ event: message.event, task_id: message.task_id ?? undefined });
        handlers.onMessage?.(message);
      }
      if (missing) handlers.onResync();
    }
  }
  const tab = shared;
  let closed = false;
  return {
    close() {
      if (closed) return;
      closed = true;
      tab.listeners.delete(listener);
      if (tab.listeners.size === 0 && shared === tab) {
        shared = null;
        tab.stream.close();
      }
    },
  };
}

/**
 * A counter that goes up each time the stream tells this page something worth looking at: an event
 * `filter` lets through (every event if there is none), and also once whenever the stream opens
 * with no id to resume from, since events before that were not sent. A page that shows data
 * fetches it again when the number changes. The number itself means nothing.
 *
 * `filter` sees the name of the event and the task it is about (`task_id`, which the API fills in
 * for every event that has one; undefined for one that has none, such as an agent registering).
 * It can change on every render without opening another stream.
 */
export function useEvents(filter?: (event: EventInfo) => boolean): number {
  return useEventsBy(ONE_KIND, (event) => (filter === undefined || filter(event) ? "events" : null))
    .events;
}

const ONE_KIND = ["events"] as const;

/**
 * `useEvents` for a page that shows several things, over one stream: a counter for each of `kinds`,
 * which goes up each time `sort` puts an event in that kind (null: in none), and every counter
 * goes up when the stream opens with no id to resume from. So a page asks again for only what an
 * event is about, and opens one stream however many parts it has (the API holds a client to a few).
 *
 * `kinds` is read once, when the page first renders; `sort` can change on every render.
 */
export function useEventsBy<K extends string>(
  kinds: readonly K[],
  sort: (event: EventInfo) => K | null,
): Readonly<Record<K, number>> {
  const [counts, setCounts] = useState(
    () => Object.fromEntries(kinds.map((kind) => [kind, 0])) as Record<K, number>,
  );
  const latest = useRef(sort);
  useEffect(() => {
    latest.current = sort;
  });

  useEffect(() => {
    const stream = listenToEvents({
      onEvent: (info) => {
        const kind = latest.current(info);
        if (kind === null) return;
        setCounts((was) => ({ ...was, [kind]: (was[kind] ?? 0) + 1 }));
      },
      onResync: () =>
        setCounts(
          (was) =>
            Object.fromEntries(
              Object.entries<number>(was).map(([kind, n]) => [kind, n + 1]),
            ) as Record<K, number>,
        ),
    });
    return () => stream.close();
  }, []);

  return counts;
}
