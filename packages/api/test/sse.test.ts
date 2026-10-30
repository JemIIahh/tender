import type { Db } from "@tender/db";
import { FIXTURE_ACCOUNTS } from "@tender/indexer/testing";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { handleError } from "../src/format";
import { type ApiDeps, createApp, type ErrorBody } from "../src/index";
import { eventRoutes, type SseTiming } from "../src/sse";
import { resetDb, seedLifecycle, testDeps } from "./helpers";

// The event stream. Most tests mount `eventRoutes` on an app of their own with a short interval, so
// that a stream that polls every 10 ms is watched in real time. The tests of the defaults (a poll
// each second, a ping every 15 seconds, 100 events at most to a poll) run under fake timers, over a
// database that waits for nothing, so that the clock alone drives the stream. The events are rows
// of `events` written with explicit ids, which is what the indexer leaves behind and what makes the
// gaps in the ids that this route has to cope with; the payload test reads the lifecycle that the
// indexer wrote from the captured logs instead.

const { alice } = FIXTURE_ACCOUNTS;

/** A stream that polls every 10 ms and, for the length of any test, never pings. */
const QUICK: SseTiming = { pollMs: 10, pingMs: 60_000 };
/** One that polls every 10 ms and pings every 60. */
const PINGING: SseTiming = { pollMs: 10, pingMs: 60 };
/** The timing of the real API: a poll each second and a ping every 15. */
const DEFAULT_TIMING: SseTiming = { pollMs: 1_000, pingMs: 15_000 };

let deps: ApiDeps;

beforeAll(async () => {
  deps = await testDeps();
});

afterAll(() => deps.db.close());

beforeEach(async () => {
  await resetDb(deps.db);
});

/** Every stream a test opened, so that none outlives it and polls on. */
const opened: Listener[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(opened.splice(0).map((listener) => listener.cancel()));
});

/** The event routes alone, under `/v1`, with the API's error handler. */
function appWith(over: Partial<ApiDeps> = {}, timing: SseTiming = QUICK): Hono {
  const app = new Hono();
  app.onError(handleError);
  app.route("/v1", eventRoutes({ ...deps, ...over }, timing));
  return app;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Waits, in real time, until `ready()` holds. The machine may be busy, so it is given long. */
async function waitFor(ready: () => boolean, what: string, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`gave up waiting for ${what}`);
    await sleep(10);
  }
}

// ---- Reading a stream -------------------------------------------------------------------------

/** One message of the stream as an `EventSource` would take it, or one comment. */
interface Frame {
  id?: string;
  event?: string;
  data?: string;
  comment?: string;
}

/** The parts of the text that are whole frames, and the rest. A frame ends with a blank line. */
function parseFrames(text: string): { frames: Frame[]; rest: string } {
  const parts = text.split("\n\n");
  const rest = parts.pop() ?? "";
  const frames = parts.map((part) => {
    const frame: Frame = {};
    for (const line of part.split("\n")) {
      if (line.startsWith(":")) {
        frame.comment = line.slice(1).trim();
        continue;
      }
      const colon = line.indexOf(":");
      const field = line.slice(0, colon) as "id" | "event" | "data";
      const value = line.slice(colon + 1).replace(/^ /, "");
      frame[field] = frame[field] === undefined ? value : `${frame[field]}\n${value}`;
    }
    return frame;
  });
  return { frames, rest };
}

/** A stream being read, in the background, from the moment it is opened. */
interface Listener {
  /** Everything received so far, in order. */
  readonly frames: Frame[];
  /** Whether the server has ended the stream. */
  readonly ended: boolean;
  /** The next `n` frames that nothing has taken yet, once they have arrived. */
  take(n: number, timeoutMs?: number): Promise<Frame[]>;
  /** Fails if a frame arrives within `ms` of real time. */
  quiet(ms: number): Promise<void>;
  /** Resolves when the server ends the stream. */
  end(timeoutMs?: number): Promise<void>;
  /** Hangs up, as a client does. */
  cancel(): Promise<void>;
}

function listen(res: Response): Listener {
  if (res.body === null) throw new Error("the response has no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const frames: Frame[] = [];
  let taken = 0;
  let ended = false;
  let changed: (() => void) | undefined;
  const signal = () => changed?.();

  void (async () => {
    let rest = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const parsed = parseFrames(rest + decoder.decode(value, { stream: true }));
        rest = parsed.rest;
        frames.push(...parsed.frames);
        signal();
      }
    } catch {
      // A stream that is cancelled or reset ends the read; the test sees it as the end.
    }
    ended = true;
    signal();
  })();

  /** Waits until `ready()` holds, or fails after `ms` of real time. */
  async function until(ready: () => boolean, ms: number, what: string): Promise<void> {
    const deadline = Date.now() + ms;
    while (!ready()) {
      const left = deadline - Date.now();
      if (left <= 0)
        throw new Error(`${what}: nothing within ${ms} ms (got ${JSON.stringify(frames)})`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        changed = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }

  const listener: Listener = {
    frames,
    get ended() {
      return ended;
    },
    async take(n, timeoutMs = 3_000) {
      await until(() => frames.length >= taken + n || ended, timeoutMs, `waiting for ${n} frames`);
      if (frames.length < taken + n) throw new Error("the stream ended before that");
      taken += n;
      return frames.slice(taken - n, taken);
    },
    async quiet(ms) {
      const seen = frames.length;
      await sleep(ms);
      if (frames.length !== seen) {
        throw new Error(`expected silence, got ${JSON.stringify(frames.slice(seen))}`);
      }
    },
    async end(timeoutMs = 3_000) {
      await until(() => ended, timeoutMs, "waiting for the end of the stream");
    },
    async cancel() {
      await reader.cancel().catch(() => undefined);
    },
  };
  opened.push(listener);
  return listener;
}

/** Opens `path` on `app` and starts reading it. The answer must be a stream. */
async function open(
  app: Hono,
  path = "/v1/events",
  headers: Record<string, string> = {},
): Promise<Listener> {
  const res = await app.request(path, { headers });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  return listen(res);
}

/**
 * Opens a stream once there is a place for it. The stream that held the place was cancelled a
 * moment ago and gives it back when its loop next runs, which is soon but not at the same instant.
 */
async function openWhenFree(app: Hono, path = "/v1/events"): Promise<Listener> {
  for (let tries = 0; tries < 200; tries++) {
    const res = await app.request(path);
    if (res.status === 200) return listen(res);
    expect(res.status).toBe(503);
    await sleep(10);
  }
  throw new Error("no place for a stream became free");
}

const ids = (frames: Frame[]) => frames.map((frame) => frame.id);

// ---- Data -------------------------------------------------------------------------------------

interface NewEvent {
  id: number;
  event?: string;
  height?: number;
  /** The `task_id` column, as a number or as text for a u64 beyond 2^53. Default: task 1. */
  taskId?: number | string | null;
  data?: Record<string, unknown>;
}

/** Inserts events with the ids they are given, as the indexer would have left them. */
async function addEvents(...events: NewEvent[]): Promise<void> {
  for (const e of events) {
    const data = e.data ?? { task_id: "1", account: alice };
    await deps.db.query(
      `insert into events (id, height, block_ts, receipt_id, log_index, event, data, task_id)
       values ($1, $2, $3, $4, 0, $5, $6, $7)`,
      [
        e.id,
        e.height ?? 1_000 + e.id,
        1_793_307_000_000_000_000n + BigInt(e.id),
        `receipt-${e.id}`,
        e.event ?? "committed",
        data,
        e.taskId === undefined ? 1 : e.taskId,
      ],
    );
  }
}

const eventsWithIds = (...list: number[]) => list.map((id) => ({ id }));

/**
 * A database that wraps `deps.db` and counts every statement it is given, and can be told to wait
 * before it runs one, or to fail it.
 */
function watched(over: { before?: (n: number, sql: string) => Promise<void> | undefined } = {}) {
  const sqls: string[] = [];
  const db: Db = {
    ...deps.db,
    query: async <T>(sql: string, params?: unknown[]) => {
      sqls.push(sql);
      await over.before?.(sqls.length, sql);
      return deps.db.query<T>(sql, params);
    },
  };
  return { db, sqls, polls: () => sqls.filter((sql) => !/max\(id\)/.test(sql)).length };
}

/**
 * A database with no events in it that waits for nothing, so that a fake clock alone drives a
 * stream. It counts the polls, which are the statements that are not the one that looks for the
 * newest id.
 */
function idleDb() {
  const sqls: string[] = [];
  const unused = async () => {
    throw new Error("the stream has no use for this");
  };
  const db: Db = {
    query: async <T>(sql: string) => {
      sqls.push(sql);
      return (/max\(id\)/.test(sql) ? [{ max: "0" }] : []) as T[];
    },
    exec: unused,
    tx: unused,
    close: unused,
  };
  return { db, polls: () => sqls.filter((sql) => !/max\(id\)/.test(sql)).length };
}

// ---- Resuming ---------------------------------------------------------------------------------

test("sse_resumes_from_last_event_id", async () => {
  const app = appWith();
  // A stream that begins on an empty table sees every event after it, in order.
  const first = await open(app);
  await addEvents(...eventsWithIds(1, 2, 3, 4, 5));
  expect(ids(await first.take(3))).toEqual(["1", "2", "3"]);
  await first.cancel();

  // The browser reconnects with the id of the last event it got: exactly the two it missed, and
  // none of them twice, however long the stream then runs.
  const second = await open(app, "/v1/events", { "Last-Event-ID": "3" });
  expect(ids(await second.take(2))).toEqual(["4", "5"]);
  await second.quiet(100);
  expect(ids(second.frames.filter((frame) => frame.id !== undefined))).toEqual(["4", "5"]);

  // Whatever comes next follows on from the last one.
  await addEvents({ id: 6 });
  expect(ids(await second.take(1))).toEqual(["6"]);

  // `since` says the same, for a client that cannot set the header.
  const third = await open(app, "/v1/events?since=4");
  expect(ids(await third.take(2))).toEqual(["5", "6"]);
});

test("sse_resumes_from_the_header_when_both_are_given", async () => {
  await addEvents(...eventsWithIds(1, 2, 3, 4, 5));
  // The header is what the browser sends when it reconnects to the address it first opened, and
  // that address still carries the `since` of the first connection: the header is the newer.
  const stream = await open(appWith(), "/v1/events?since=0", { "Last-Event-ID": "4" });
  expect(ids(await stream.take(1))).toEqual(["5"]);
  await stream.quiet(60);
  expect(stream.frames).toHaveLength(1);
});

test("sse_without_a_resume_id_starts_after_the_newest_event", async () => {
  await addEvents(...eventsWithIds(1, 2, 3));
  const stream = await open(appWith());
  // Nothing from the past is replayed ...
  await stream.quiet(80);
  expect(stream.frames).toEqual([]);
  // ... and the next event is the first thing sent.
  await addEvents({ id: 4 });
  expect(ids(await stream.take(1))).toEqual(["4"]);

  // On an empty table "after the newest" is after 0, so the very first event arrives.
  await resetDb(deps.db);
  const empty = await open(appWith());
  await addEvents({ id: 1 });
  expect(ids(await empty.take(1))).toEqual(["1"]);
});

test("sse_ids_have_gaps", async () => {
  // Rolled-back transactions leave holes in a sequence, so the ids are not 1, 2, 3 ...
  await addEvents(...eventsWithIds(1, 2, 5, 9, 10));
  const app = appWith();

  const all = await open(app, "/v1/events?since=0");
  expect(ids(await all.take(5))).toEqual(["1", "2", "5", "9", "10"]);

  // A resume id between two events, or on one that is gone, continues with the next one that is.
  for (const [since, expected] of [
    ["2", ["5", "9", "10"]],
    ["3", ["5", "9", "10"]],
    ["4", ["5", "9", "10"]],
    ["9", ["10"]],
  ] as const) {
    const stream = await open(app, `/v1/events?since=${since}`);
    expect(ids(await stream.take(expected.length)), `since ${since}`).toEqual(expected);
    await stream.quiet(30);
    expect(stream.frames, `since ${since}`).toHaveLength(expected.length);
  }

  // Events that arrive later with holes between them are all delivered, none skipped.
  await addEvents({ id: 20 }, { id: 21 }, { id: 40 });
  expect(ids(await all.take(3))).toEqual(["20", "21", "40"]);
});

test("sse_a_resume_id_beyond_the_newest_starts_from_the_newest", async () => {
  // A client that kept its id across a restart of a database that began again is ahead of the
  // index. It would otherwise wait for ids the table will not reach for a long time.
  await addEvents(...eventsWithIds(1, 2, 3));
  const app = appWith();
  const stale = await open(app, "/v1/events", { "Last-Event-ID": "5000" });
  const far = await open(app, "/v1/events?since=18446744073709551615");
  await stale.quiet(60);
  await addEvents({ id: 4 });
  expect(ids(await stale.take(1))).toEqual(["4"]);
  expect(ids(await far.take(1))).toEqual(["4"]);
});

test("sse_reads_a_backlog_in_order_a_hundred_events_at_a_time", async () => {
  // 250 events are waiting, and ids 1 to 250 are the case where a sort of the ids as text goes
  // wrong (10 before 2, 100 before 11). They are sent in order and once each, and no poll reads
  // more than 100 of them: three polls, of 100, 100 and 50.
  await deps.db.query(
    `insert into events (id, height, block_ts, receipt_id, log_index, event, data, task_id)
     select n, 1000 + n, 1793307000000000000 + n, 'receipt-' || n, 0, 'committed',
            '{"task_id":"1"}'::jsonb, 1
       from generate_series(1, 250) as n`,
  );
  const counted: number[] = [];
  const db: Db = {
    ...deps.db,
    query: async <T>(sql: string, params?: unknown[]) => {
      const rows = await deps.db.query<T>(sql, params);
      if (!/max\(id\)/.test(sql)) counted.push(rows.length);
      return rows;
    },
  };
  const stream = await open(appWith({ db }), "/v1/events?since=0");
  const frames = await stream.take(250, 5_000);
  await stream.quiet(60);

  expect(ids(frames)).toEqual(Array.from({ length: 250 }, (_, i) => String(i + 1)));
  expect(stream.frames).toHaveLength(250);
  expect(counted.slice(0, 3)).toEqual([100, 100, 50]);
  expect(Math.max(...counted)).toBe(100);
});

test("sse_sends_a_hundred_events_at_most_per_poll", async () => {
  // A stream far behind does not make its polls any bigger or any more frequent: it reads 100
  // events, waits a second, reads 100 more, and so costs the database what an idle one does.
  const asked: Array<{ after: string; limit: number }> = [];
  const db: Db = {
    query: async <T>(sql: string, params: unknown[] = []) => {
      if (/max\(id\)/.test(sql)) return [{ max: "250" }] as T[];
      const [after, limit] = params.map(String);
      asked.push({ after: after ?? "", limit: Number(limit) });
      const first = Number(after) + 1;
      const last = Math.min(first + Number(limit) - 1, 250);
      return Array.from({ length: Math.max(last - first + 1, 0) }, (_, i) => ({
        id: String(first + i),
        event: "committed",
        data: { task_id: "1" },
        height: String(1000 + first + i),
        task_id: "1",
      })) as T[];
    },
    exec: async () => undefined,
    tx: async () => {
      throw new Error("the stream has no use for this");
    },
    close: async () => undefined,
  };
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const stream = listen(await appWith({ db }, DEFAULT_TIMING).request("/v1/events?since=0"));
  await vi.advanceTimersByTimeAsync(0);
  expect(stream.frames).toHaveLength(100);
  expect(stream.frames[0]?.id).toBe("1");
  expect(stream.frames[99]?.id).toBe("100");

  await vi.advanceTimersByTimeAsync(999);
  expect(stream.frames).toHaveLength(100);
  await vi.advanceTimersByTimeAsync(1);
  expect(stream.frames).toHaveLength(200);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(ids(stream.frames.slice(200))).toEqual(
    Array.from({ length: 50 }, (_, i) => String(201 + i)),
  );

  // Caught up: nothing is sent twice, and the polls go on a second apart, from the last id.
  await vi.advanceTimersByTimeAsync(5_000);
  expect(stream.frames.filter((frame) => frame.id !== undefined)).toHaveLength(250);
  expect(asked.slice(0, 4)).toEqual([
    { after: "0", limit: 100 },
    { after: "100", limit: 100 },
    { after: "200", limit: 100 },
    { after: "250", limit: 100 },
  ]);
  expect(asked).toHaveLength(8);
});

test("sse_rejects_a_resume_id_that_is_no_u64", async () => {
  const app = appWith({ maxSseStreams: 1 });
  const bad = [
    "abc",
    "-1",
    "+1",
    "01",
    "1.5",
    "1e3",
    "0x10",
    "1 2",
    "1,2",
    "18446744073709551616",
    "9".repeat(40),
  ];
  for (const value of bad) {
    for (const how of ["header", "query"] as const) {
      const res =
        how === "header"
          ? await app.request("/v1/events", { headers: { "Last-Event-ID": value } })
          : await app.request(`/v1/events?since=${encodeURIComponent(value)}`);
      expect(res.status, `${how} ${value}`).toBe(400);
      const body = (await res.json()) as ErrorBody;
      expect(body.error).toBe("bad_request");
      // Fixed text: the value that was sent is not in it.
      expect(JSON.stringify(body)).not.toContain(value);
    }
  }
  // A good one next to a bad one is still refused, whichever is the one that would be used.
  const mixed = await app.request("/v1/events?since=abc", { headers: { "Last-Event-ID": "3" } });
  expect(mixed.status).toBe(400);
  const mixedTheOtherWay = await app.request("/v1/events?since=3", {
    headers: { "Last-Event-ID": "abc" },
  });
  expect(mixedTheOtherWay.status).toBe(400);

  // None of them took a place among the open streams (there is one).
  const stream = await open(app, "/v1/events", { "Last-Event-ID": "0" });
  expect(stream.ended).toBe(false);
});

test("sse_accepts_the_edges_of_the_u64_range", async () => {
  const app = appWith();
  for (const value of ["0", "18446744073709551615"]) {
    const res = await app.request(`/v1/events?since=${value}`);
    expect(res.status, value).toBe(200);
    await res.body?.cancel();
  }
});

// ---- The message ------------------------------------------------------------------------------

test("sse_payload_follows_r19", async () => {
  await seedLifecycle(deps.db);
  const stored = await deps.db.query<{
    id: string;
    event: string;
    height: string;
    task_id: string | null;
    data: Record<string, unknown>;
  }>(
    "select id::text as id, event, height::text as height, task_id::text as task_id, data from events order by id",
  );
  expect(stored).toHaveLength(9);

  const stream = await open(appWith(), "/v1/events?since=0");
  const frames = await stream.take(9);
  expect(ids(frames)).toEqual(stored.map((row) => row.id));

  for (const [i, frame] of frames.entries()) {
    const row = stored[i];
    const payload = JSON.parse(frame.data ?? "null") as Record<string, unknown>;
    // The event is the name of the message, and also what its data says.
    expect(frame.event, `frame ${i}`).toBe(row?.event);
    expect(Object.keys(payload), `frame ${i}`).toEqual(["event", "data", "height", "task_id"]);
    expect(payload.event).toBe(row?.event);
    expect(payload.data).toEqual(row?.data);
    // A height is a u64, so a decimal string, and so is the task: null for an event of no task.
    expect(payload.height).toBe(row?.height);
    expect(typeof payload.height).toBe("string");
    expect(payload.task_id).toBe(row?.task_id);
  }
  expect(frames.map((frame) => frame.event)).toEqual([
    "agent_registered",
    "agent_registered",
    "agent_registered",
    "task_created",
    "committed",
    "committed",
    "revealed",
    "revealed",
    "picked",
  ]);
  const taskIds = frames.map(
    (frame) => (JSON.parse(frame.data ?? "null") as { task_id: unknown }).task_id,
  );
  expect(taskIds).toEqual([null, null, null, "1", "1", "1", "1", "1", "1"]);
});

test("sse_task_id_is_the_column", async () => {
  // The id of the task is the `task_id` column, which the indexer fills from `task_id` (or from
  // `id` for a new task); the stream does not look inside the data for it.
  await addEvents(
    { id: 1, taskId: 42, data: { task_id: "1" } },
    { id: 2, taskId: null, data: { task_id: "1" } },
    { id: 3, taskId: "18446744073709551615", data: {} },
  );
  const stream = await open(appWith(), "/v1/events?since=0");
  const payloads = (await stream.take(3)).map(
    (frame) => JSON.parse(frame.data ?? "null") as { task_id: unknown },
  );
  expect(payloads.map((p) => p.task_id)).toEqual(["42", null, "18446744073709551615"]);
});

test("sse_wire_format", async () => {
  await addEvents({ id: 7, event: "revealed", height: 123, taskId: 5, data: { task_id: "5" } });
  const res = await appWith().request("/v1/events?since=0");
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  expect(res.headers.get("cache-control")).toContain("no-cache");
  const reader = res.body?.getReader();
  const { value } = (await reader?.read()) ?? {};
  await reader?.cancel();
  const text = new TextDecoder().decode(value);
  // One message: the id, the name and a single line of JSON, ended by a blank line.
  expect(text).toBe(
    'event: revealed\ndata: {"event":"revealed","data":{"task_id":"5"},"height":"123","task_id":"5"}\nid: 7\n\n',
  );
});

// ---- Pings ------------------------------------------------------------------------------------

test("sse_sends_ping", async () => {
  const stream = await open(appWith({}, PINGING));
  const started = Date.now();
  // A comment, which an EventSource ignores and a proxy sees as traffic, and not before it is due.
  const [first] = await stream.take(1);
  expect(first).toEqual({ comment: "ping" });
  expect(Date.now() - started).toBeGreaterThanOrEqual(40);
  const [second] = await stream.take(1);
  expect(second).toEqual({ comment: "ping" });
  // Nothing else is in it.
  expect(stream.frames.every((frame) => frame.comment === "ping")).toBe(true);

  // Events between the pings are events, and the pings go on.
  await addEvents({ id: 1 });
  const rest = await stream.take(2);
  expect(rest.filter((frame) => frame.id === "1")).toHaveLength(1);
});

test("sse_polls_every_second_and_pings_every_fifteen", async () => {
  const { db, polls } = idleDb();
  const app = createApp({ ...deps, db });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const stream = listen(await app.request("/v1/events"));
  await vi.advanceTimersByTimeAsync(0);

  // One poll as it opens, then one a second.
  expect(polls()).toBe(1);
  await vi.advanceTimersByTimeAsync(999);
  expect(polls()).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(polls()).toBe(2);
  await vi.advanceTimersByTimeAsync(13_000);
  expect(polls()).toBe(15);

  // Not a moment before 15 seconds.
  await vi.advanceTimersByTimeAsync(999);
  expect(stream.frames).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(stream.frames).toEqual([{ comment: "ping" }]);
  expect(polls()).toBe(16);

  // And then every 15 seconds.
  await vi.advanceTimersByTimeAsync(14_999);
  expect(stream.frames).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(stream.frames).toEqual([{ comment: "ping" }, { comment: "ping" }]);
  expect(polls()).toBe(31);
});

// ---- Disconnecting ----------------------------------------------------------------------------

test("sse_stops_when_the_client_leaves", async () => {
  const { db, sqls, polls } = watched();
  const app = appWith({ db, maxSseStreams: 1 });
  const stream = await open(app);
  await waitFor(() => polls() >= 3, "three polls");
  expect((await app.request("/v1/events")).status).toBe(503);

  await stream.cancel();
  const next = await openWhenFree(app);
  expect(next.ended).toBe(false);
  await next.cancel();
  // No poll follows the last one: the loop is over, and the next stream's place was free at once.
  await sleep(60);
  const after = sqls.length;
  await sleep(100);
  expect(sqls.length).toBe(after);
});

test("sse_leaves_no_timer_behind_a_client_that_leaves", async () => {
  const { db, polls } = idleDb();
  const app = createApp({ ...deps, db });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const stream = listen(await app.request("/v1/events"));
  await vi.advanceTimersByTimeAsync(3_000);
  expect(polls()).toBe(4);
  // The stream waits on one timer, for its next poll.
  expect(vi.getTimerCount()).toBe(1);

  await stream.cancel();
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(polls()).toBe(4);
  expect(vi.getTimerCount()).toBe(0);
});

test("sse_a_client_that_leaves_during_a_poll_costs_nothing_more", async () => {
  // The poll that is running when the client leaves finishes with rows to send. They go nowhere,
  // and no poll follows.
  await addEvents(...eventsWithIds(1, 2, 3));
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reachedPoll: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => {
    reachedPoll = resolve;
  });
  const { db, sqls } = watched({
    before: (n) => {
      if (n !== 2) return undefined;
      reachedPoll();
      return held;
    },
  });
  const app = appWith({ db, maxSseStreams: 1 });
  const stream = await open(app, "/v1/events?since=0");
  await reached;
  await stream.cancel();
  release();
  await sleep(100);
  expect(sqls).toHaveLength(2);
  const next = await openWhenFree(app);
  expect(next.ended).toBe(false);
});

test("sse_a_client_that_left_before_the_stream_began_costs_nothing", async () => {
  // The request is gone while the route is still asking for the newest id. The server cannot
  // write to it, so nothing would ever cancel the response: the request's own signal is what ends
  // the stream, and frees the place it was going to take.
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reachedQuery: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => {
    reachedQuery = resolve;
  });
  const { db, sqls } = watched({
    before: (n) => {
      if (n !== 1) return undefined;
      reachedQuery();
      return held;
    },
  });
  const app = appWith({ db, maxSseStreams: 1 });
  const hangup = new AbortController();
  const pending = Promise.resolve(app.request("/v1/events", { signal: hangup.signal }));
  await reached;
  hangup.abort();
  release();
  const res = await pending;
  const stream = listen(res);
  await stream.end();
  await sleep(60);
  expect(sqls).toHaveLength(1);

  const next = await open(app);
  expect(next.ended).toBe(false);
});

test("sse_a_head_request_opens_no_stream", async () => {
  // Hono answers HEAD with the GET route and drops the body without reading or cancelling it, so
  // a stream opened for it would poll for ever.
  const { db, sqls } = watched();
  const app = appWith({ db, maxSseStreams: 1 });
  const res = await app.request("/v1/events", { method: "HEAD" });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  expect(await res.text()).toBe("");
  await sleep(80);
  expect(sqls).toEqual([]);
  // And it took no place.
  const stream = await open(app);
  expect(stream.ended).toBe(false);
});

// ---- The cap ----------------------------------------------------------------------------------

test("sse_cap_answers_503_with_retry_after", async () => {
  const app = appWith({ maxSseStreams: 2 });
  const one = await open(app);
  const two = await open(app);

  const refused = await app.request("/v1/events");
  expect(refused.status).toBe(503);
  expect(refused.headers.get("retry-after")).toBe("5");
  expect(refused.headers.get("content-type")).toContain("application/json");
  const body = (await refused.json()) as ErrorBody;
  expect(body.error).toBe("unavailable");
  expect(body.message).toBe("too many event streams are open, try again shortly");

  // A stream that goes frees its place at once; the one that is left stays open.
  await one.cancel();
  const three = await openWhenFree(app);
  expect((await app.request("/v1/events")).status).toBe(503);
  expect(two.ended).toBe(false);
  expect(three.ended).toBe(false);

  // A bad resume id is refused as a bad request even when the process is full.
  expect((await app.request("/v1/events?since=abc")).status).toBe(400);
});

test("sse_cap_defaults_to_200", async () => {
  const { db } = idleDb();
  const app = appWith({ db }, DEFAULT_TIMING);
  for (let i = 0; i < 200; i++) await open(app);
  const refused = await app.request("/v1/events");
  expect(refused.status).toBe(503);
  expect(refused.headers.get("retry-after")).toBe("5");
  // The count is the app's own: a second app in the same process has a cap of its own.
  await open(appWith({ db, maxSseStreams: 1 }, DEFAULT_TIMING));
});

test("sse_cap_of_zero_refuses_every_stream", async () => {
  const res = await appWith({ maxSseStreams: 0 }).request("/v1/events");
  expect(res.status).toBe(503);
  expect(res.headers.get("retry-after")).toBe("5");
});

test("sse_a_stream_that_fails_frees_its_place", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  await addEvents(...eventsWithIds(1, 2));
  // The newest id is found, the first poll sends what is there, the second poll fails.
  const { db } = watched({
    before: (n) => {
      if (n === 3) throw new Error("connection to 10.0.0.7 lost, password=secret");
      return undefined;
    },
  });
  const app = appWith({ db, maxSseStreams: 1 });
  const stream = await open(app, "/v1/events?since=0");
  expect(ids(await stream.take(2))).toEqual(["1", "2"]);
  // The stream ends, so that the browser reconnects with the id it has; and it says nothing of why.
  await stream.end();
  expect(JSON.stringify(stream.frames)).not.toContain("secret");
  expect(console.error).toHaveBeenCalled();

  const next = await openWhenFree(app);
  expect(next.ended).toBe(false);
});

test("sse_a_failure_before_the_stream_is_a_500_and_frees_its_place", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const broken: Db = {
    ...deps.db,
    query: async () => {
      throw new Error("relation events is broken, password=secret");
    },
  };
  const app = appWith({ db: broken, maxSseStreams: 1 });
  for (let i = 0; i < 3; i++) {
    const res = await app.request("/v1/events");
    expect(res.status).toBe(500);
    const body = (await res.json()) as ErrorBody;
    expect(body.error).toBe("internal");
    expect(JSON.stringify(body)).not.toContain("secret");
  }
});

// ---- Through the whole API --------------------------------------------------------------------

test("sse_is_served_by_the_api_to_other_origins", async () => {
  await addEvents(...eventsWithIds(1, 2));
  const app = createApp({ ...deps, webOrigins: ["https://tender.example"] });
  const res = await app.request("/v1/events?since=1", {
    headers: { Origin: "https://tender.example" },
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  // The sandbox serves any origin, as for every other route.
  expect(res.headers.get("access-control-allow-origin")).toBe("*");
  const stream = listen(res);
  expect(ids(await stream.take(1))).toEqual(["2"]);

  // The browser's preflight for the reconnect header is answered like the rest of `/v1`.
  const preflight = await app.request("/v1/events", {
    method: "OPTIONS",
    headers: {
      Origin: "https://tender.example",
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "last-event-id",
    },
  });
  expect(preflight.headers.get("access-control-allow-headers")?.toLowerCase()).toContain(
    "last-event-id",
  );
});
