import type { Db } from "@tender/db";
import { Hono } from "hono";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";
import type { ApiDeps } from "./deps";
import { type ErrorBody, parseU64 } from "./format";

// `GET /v1/events`: the events the indexer has stored, as a Server-Sent Events stream, for the web
// app and for agents that want to know when something happens without asking again and again.
//
// The stream reads the `events` table and nothing else. Every stream polls it, so a client that
// connects costs the database one small indexed query a second; `maxSseStreams` is what bounds
// that. The events come out in the order of their ids, and a reconnecting client names the last
// id it got (`Last-Event-ID`, or `?since=`) and gets everything after it, no more and no less.
// That is safe because the indexer is the only writer and applies one block at a time, the events
// of a block in one transaction: they become visible in the order of their ids, so a stream that
// has read up to an id has missed nothing below it. The ids have gaps (a rolled-back transaction
// uses up its ids), so a stream asks for `id > last`, never for `last + 1`.

/** How a stream keeps time. The API uses `DEFAULT_TIMING`; a test passes a shorter one. */
export interface SseTiming {
  /** Milliseconds between two looks at the table. */
  pollMs: number;
  /** Milliseconds between two `: ping` comments, which keep an idle connection from being closed. */
  pingMs: number;
}

const DEFAULT_TIMING: SseTiming = { pollMs: 1_000, pingMs: 15_000 };

/** The most events one look at the table reads. */
const PAGE = 100;

/** The open streams a process serves at once, unless `deps.maxSseStreams` says otherwise. */
const DEFAULT_MAX_STREAMS = 200;

/** How long a client that was turned away should wait before it tries again, in seconds. */
const RETRY_AFTER_SECONDS = "5";

/**
 * The `data` of a message of the stream, as one line of JSON. `event` and `data` are the event as
 * the contract logged it, and `height` and `task_id` are decimal strings, as every u64 the API
 * sends is (R19). `task_id` is the `events.task_id` column, which the indexer fills in, and is
 * null for an event that is about no task, such as an agent registering.
 */
export interface EventMessage {
  event: string;
  data: Record<string, unknown>;
  height: string;
  task_id: string | null;
}

interface EventRow extends EventMessage {
  id: string;
}

/**
 * The newest event id, for a stream that was not told where to begin. A stream that is told gets
 * its own id, unless that is beyond the newest: a client that kept the id of a database that has
 * since started over would wait for ids that the table will not reach for a long time, so it
 * begins from the newest as well.
 */
async function startAfter(db: Db, resume: string | undefined): Promise<bigint> {
  const [row] = await db.query<{ max: string }>(
    "select coalesce(max(id), 0)::text as max from events",
  );
  const newest = BigInt(row?.max ?? "0");
  if (resume === undefined) return newest;
  const asked = BigInt(resume);
  if (asked > newest) return newest;
  return asked;
}

/** Resolves after `ms`, or as soon as `signal` aborts. The timer is gone either way. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Sends the events after `after` as they appear, until the client goes. Each pass reads at most
 * `PAGE` events, in id order, sends them, and waits `pollMs`. So a stream puts one small query a
 * second on the database whatever it has to send, which is what the cap on streams relies on, and
 * one that is far behind catches up `PAGE` events a second. Every `pingMs` of waiting it sends a
 * comment, so that a proxy sees traffic on a stream that has nothing to say.
 *
 * `hangup` is the request's signal. Hono ends a stream when the response body is cancelled, which
 * the server does when the client leaves, but not when the client left before the response was
 * handed to the server: there is nothing to cancel, and the stream would run for ever. The signal
 * is aborted in both cases.
 */
async function pump(
  db: Db,
  stream: SSEStreamingApi,
  timing: SseTiming,
  hangup: AbortSignal,
  after: bigint,
): Promise<void> {
  // The waits end the moment the stream is aborted, so that no timer outlives the client.
  const stopped = new AbortController();
  stream.onAbort(() => stopped.abort());
  const onHangup = () => stream.abort();
  if (hangup.aborted) stream.abort();
  else hangup.addEventListener("abort", onHangup, { once: true });

  try {
    let last = after;
    let waited = 0;
    while (!stream.aborted) {
      // `e.id` in `order by`, not `id`: a bare name there is the output column of that name, which
      // is text, and text puts event 10 before event 2.
      const rows = await db.query<EventRow>(
        `select e.id::text as id, e.event, e.data, e.height::text as height,
                e.task_id::text as task_id
           from events e
          where e.id > $1::bigint
          order by e.id
          limit $2::int`,
        [last, PAGE],
      );
      for (const row of rows) {
        if (stream.aborted) return;
        const message: EventMessage = {
          event: row.event,
          data: row.data,
          height: row.height,
          task_id: row.task_id,
        };
        await stream.writeSSE({ id: row.id, event: row.event, data: JSON.stringify(message) });
        last = BigInt(row.id);
      }

      await pause(timing.pollMs, stopped.signal);
      if (stream.aborted) return;
      // A ping is due after `pingMs` of waiting. The waits are counted, not read off a clock, so
      // the rhythm is the same whatever clock the process runs on, a fake one in a test included.
      waited += timing.pollMs;
      if (waited >= timing.pingMs) {
        waited = 0;
        await stream.write(": ping\n\n");
      }
    }
  } finally {
    hangup.removeEventListener("abort", onHangup);
  }
}

/**
 * `GET /v1/events`, a stream of the stored events, each as
 *
 *     id: <events.id>
 *     event: <the name of the event>
 *     data: {"event":…,"data":…,"height":"…","task_id":"…"}
 *
 * It begins after the id in the `Last-Event-ID` header or, failing that, in `?since=`, or after
 * the newest event when it is given neither. The header comes first because it is what a browser
 * sends when it reconnects, to the address it opened, which still carries the `since` it opened
 * with. Both are checked when both are given: an id that is no canonical u64 is a 400, whose text
 * is fixed and does not repeat it.
 *
 * At most `deps.maxSseStreams` (200) streams are open in a process. Past that the answer is a
 * 503 with `Retry-After: 5`. `HEAD` is answered with the headers and no stream: Hono hands it to
 * this route and then drops the body without reading it, so a stream opened for it would never
 * end.
 *
 * A failure after the stream has begun cannot change the status. The stream ends, the error is
 * logged and the client, which reconnects with the id it has, loses nothing.
 */
export function eventRoutes(deps: ApiDeps, timing: SseTiming = DEFAULT_TIMING): Hono {
  const app = new Hono();
  // The streams open now. It belongs to this app: one app is one process in production.
  let open = 0;

  app.get("/events", async (c) => {
    const lastEventId = parseU64("Last-Event-ID", c.req.header("Last-Event-ID"));
    const since = parseU64("since", c.req.query("since"));

    if (c.req.method === "HEAD") {
      return c.body(null, 200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });
    }

    if (open >= (deps.maxSseStreams ?? DEFAULT_MAX_STREAMS)) {
      const body: ErrorBody = {
        error: "unavailable",
        message: "too many event streams are open, try again shortly",
      };
      return c.json(body, 503, { "Retry-After": RETRY_AFTER_SECONDS });
    }

    // The place is taken before anything is awaited and given back exactly once, whichever way
    // the request ends: by an error here, or when the stream is over.
    open += 1;
    let given = false;
    const giveBack = () => {
      if (given) return;
      given = true;
      open -= 1;
    };
    try {
      const after = await startAfter(deps.db, lastEventId ?? since);
      return streamSSE(c, async (stream) => {
        try {
          await pump(deps.db, stream, timing, c.req.raw.signal, after);
        } catch (error) {
          console.error("api: events: a stream ended on an error:", error);
        } finally {
          giveBack();
        }
      });
    } catch (error) {
      giveBack();
      throw error;
    }
  });

  return app;
}
