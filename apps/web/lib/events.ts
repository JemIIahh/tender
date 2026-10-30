import { EventMessageSchema, TenderEventSchema, U64StringSchema } from "@tender/shared";
import { useEffect, useRef, useState } from "react";
import { config } from "./config";

// `GET /v1/events`, the API's stream of what the indexer has stored, for a page that wants to know
// when something it shows has changed. The page asks again when told; the stream never carries
// state, only that an event happened.

const STREAM_URL = `${config.apiUrl}/v1/events`;

/** How long to leave a server that refused a stream, the first time. It doubles from here. */
const MIN_BACKOFF_MS = 1_000;
/** The longest wait between two tries, and the longest a `Retry-After` is taken at its word. */
const MAX_BACKOFF_MS = 30_000;
/** How long the probe for `Retry-After` is given to answer, before the stream is reopened without it. */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * Every event the contract logs, by name. The API names each message of the stream with its event
 * (`event: committed`), so a browser hands it only to a listener for that name, and `onmessage`
 * never fires. A name the schema does not know gets no listener and never arrives.
 */
const EVENT_NAMES: string[] = TenderEventSchema.options.map((option) => option.shape.event.value);

/** What a page's filter sees of a message: which event, and the task it is about, if any. */
export interface EventInfo {
  event: string;
  task_id?: string;
}

export interface EventHandlers {
  /** A message of the stream was an event of the contract. */
  onEvent(info: EventInfo): void;
  /**
   * The stream has opened, or come back, with no event id to resume from, so the server will not
   * replay what happened before it: a page that showed something a moment ago should ask again.
   */
  onResync(): void;
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
 */
export function connectEvents({ onEvent, onResync }: EventHandlers): EventStream {
  let source: EventSource | undefined;
  let lastId: string | undefined;
  // A stream that has never been open has nothing to resume from.
  let needsResync = true;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let probe: AbortController | undefined;
  let closed = false;

  function receive(event: MessageEvent): void {
    if (closed) return;
    // Where the stream is now, whether or not the message is of any use. An id that is not a u64
    // would be refused as `?since=`, with a 400 that closes the stream for good, so it is not kept.
    if (U64StringSchema.safeParse(event.lastEventId).success) lastId = event.lastEventId;

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
    // The event as the contract logs it. The schemas drop a key they do not know, so a field added
    // to an event later does not stop this page hearing about it.
    const known = TenderEventSchema.safeParse({
      event: message.data.event,
      data: message.data.data,
    });
    if (!known.success) {
      console.error(`events: ${message.data.event} does not fit its schema`, known.error);
      return;
    }
    onEvent({ event: known.data.event, task_id: message.data.task_id ?? undefined });
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
  const [count, setCount] = useState(0);
  const latest = useRef(filter);
  useEffect(() => {
    latest.current = filter;
  });

  useEffect(() => {
    const stream = connectEvents({
      onEvent: (info) => {
        if (latest.current === undefined || latest.current(info)) setCount((n) => n + 1);
      },
      onResync: () => setCount((n) => n + 1),
    });
    return () => stream.close();
  }, []);

  return count;
}
