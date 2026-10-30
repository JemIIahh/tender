import { act, render, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { connectEvents, useEvents } from "../lib/events";
import { committedData, EVENT_NAMES, FakeEventSource, message } from "./fakeEventSource";

// The stream of `GET /v1/events` over a stand-in for the browser's EventSource. vitest.config.ts
// puts the API at http://api.test.

const STREAM = "http://api.test/v1/events";

/** A `fetch` that answers every call with `response`, and remembers how it was asked. */
function stubFetch(response: () => Response | Promise<Response>) {
  const fetchSpy = vi.fn(async (_url: unknown, _init?: RequestInit) => response());
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

const refused = (status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error: "unavailable", message: "too many streams" }), {
    status,
    headers,
  });

beforeEach(() => {
  FakeEventSource.reset();
  vi.stubGlobal("EventSource", FakeEventSource);
  // The probe that reads Retry-After: by default the server says nothing about waiting.
  stubFetch(() => refused(500));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Opens a stream and returns what it told the page, and the open stream. */
function connect() {
  const seen: Array<{ event: string; task_id?: string }> = [];
  const resyncs = vi.fn();
  const stream = connectEvents({ onEvent: (info) => seen.push(info), onResync: resyncs });
  return { seen, resyncs, stream, source: () => FakeEventSource.latest };
}

// ---- What it listens to -----------------------------------------------------------------------

test("events_listen_for_every_event_name_of_the_contract", () => {
  connect();

  // Every message is named, so `onmessage` never fires: a listener per name, or nothing arrives.
  const listening = FakeEventSource.latest.listening;
  for (const name of EVENT_NAMES) expect(listening, name).toContain(name);
  for (const name of ["task_created", "committed", "revealed", "picked", "voided"]) {
    expect(EVENT_NAMES, name).toContain(name);
  }
  expect(FakeEventSource.latest.url).toBe(STREAM);
});

test("events_pass_on_the_name_and_the_task_of_a_message", () => {
  const { seen, source } = connect();

  source().send("committed", message("committed", "7", committedData("7")), "11");
  source().send("task_created", message("task_created", "8", taskCreatedData("8")), "12");

  expect(seen).toEqual([
    { event: "committed", task_id: "7" },
    { event: "task_created", task_id: "8" },
  ]);
});

function taskCreatedData(id: string): Record<string, unknown> {
  return {
    id,
    poster: "poster.testnet",
    token: "tusdc.testnet",
    reward: "1000000",
    fee_bps: 500,
    brief_uri: "http://api.test/v1/blobs/x",
    brief_hash: "a".repeat(64),
    criteria_hash: "b".repeat(64),
    heldout_commitment: null,
    verifier: "judge.testnet",
    created_at: "1",
    commit_deadline: "2",
    reveal_deadline: "3",
    pick_deadline: "4",
    fallback_deadline: "5",
    max_entries: 0,
    max_winners: 1,
    invited: [],
    parent: null,
  };
}

test("events_have_no_task_for_an_event_about_none", () => {
  const { seen, source } = connect();

  source().send(
    "agent_registered",
    message("agent_registered", null, {
      account: "alice.testnet",
      asp: null,
      profile_uri: "x",
      profile_hash: "a".repeat(64),
      tags: [],
      updated: false,
    }),
    "1",
  );

  expect(seen).toEqual([{ event: "agent_registered", task_id: undefined }]);
});

test("events_drop_a_message_that_is_not_json_or_not_a_message_and_log_it", () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const { seen, source } = connect();

  source().send("committed", "this is not json", "1");
  source().send("committed", { event: "committed", data: "nope", height: "1", task_id: "7" }, "2");
  // A task id that is no u64 is not a message of the API's either.
  source().send("committed", message("committed", "seven", committedData("7")), "3");

  expect(seen).toEqual([]);
  expect(log).toHaveBeenCalledTimes(3);
});

test("events_drop_a_known_event_whose_data_does_not_fit_and_log_it", () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const { seen, source } = connect();

  // `committed` needs a commitment, a flag and a block height.
  source().send(
    "committed",
    message("committed", "7", { task_id: "7", account: "alice.testnet" }),
    "1",
  );

  expect(seen).toEqual([]);
  expect(log).toHaveBeenCalledTimes(1);
});

// ---- Looking again when it may have missed something ------------------------------------------

test("events_say_to_look_again_when_the_stream_opens_with_no_id_to_resume_from", () => {
  const { resyncs, source } = connect();

  // The server starts a stream with no id after the newest event, so what happened before it
  // opened (while a page was loading, say) is not sent. The page must ask for itself.
  source().open();
  expect(resyncs).toHaveBeenCalledTimes(1);
});

test("events_do_not_say_it_again_when_they_can_resume_from_an_id", () => {
  const { resyncs, source } = connect();
  source().open();
  source().send("committed", message("committed", "7", committedData("7")), "41");
  expect(resyncs).toHaveBeenCalledTimes(1);

  // The browser lost the connection and came back. It sends Last-Event-ID, so nothing was missed.
  source().dropAndRetry();
  source().open();

  expect(resyncs).toHaveBeenCalledTimes(1);
});

test("events_say_it_again_when_the_connection_is_lost_before_any_id_arrived", () => {
  const { resyncs, source } = connect();
  source().open();
  expect(resyncs).toHaveBeenCalledTimes(1);

  source().dropAndRetry();
  source().open();

  // The browser has no id to send, so the gap is the page's to close.
  expect(resyncs).toHaveBeenCalledTimes(2);
});

// ---- Staying connected ------------------------------------------------------------------------

test("events_leave_a_connection_the_browser_is_retrying_alone", async () => {
  vi.useFakeTimers();
  connect();

  FakeEventSource.latest.dropAndRetry();
  await vi.advanceTimersByTimeAsync(120_000);

  expect(FakeEventSource.instances).toHaveLength(1);
});

test("events_reconnect_with_the_last_id_after_the_browser_gives_up", async () => {
  vi.useFakeTimers();
  const { source } = connect();
  source().open();
  source().send("committed", message("committed", "7", committedData("7")), "41");

  source().failForGood();

  // Not at once: a server that just refused should be left a moment.
  expect(FakeEventSource.instances).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(999);
  expect(FakeEventSource.instances).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(FakeEventSource.instances).toHaveLength(2);
  expect(FakeEventSource.latest.url).toBe(`${STREAM}?since=41`);
});

test("events_back_off_1_2_4_up_to_30_seconds", async () => {
  vi.useFakeTimers();
  connect();

  const waits: number[] = [];
  for (let attempt = 0; attempt < 8; attempt++) {
    const before = FakeEventSource.instances.length;
    FakeEventSource.latest.failForGood();
    let waited = 0;
    while (FakeEventSource.instances.length === before) {
      await vi.advanceTimersByTimeAsync(500);
      waited += 500;
      if (waited > 60_000) throw new Error("it never reconnected");
    }
    waits.push(waited);
  }

  expect(waits).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000]);
});

test("events_start_the_backoff_again_once_a_connection_opens", async () => {
  vi.useFakeTimers();
  connect();
  for (const wait of [1000, 2000, 4000]) {
    FakeEventSource.latest.failForGood();
    await vi.advanceTimersByTimeAsync(wait);
  }
  expect(FakeEventSource.instances).toHaveLength(4);
  FakeEventSource.latest.open();

  FakeEventSource.latest.failForGood();
  await vi.advanceTimersByTimeAsync(1000);

  expect(FakeEventSource.instances).toHaveLength(5);
});

test("events_wait_as_long_as_retry_after_says", async () => {
  vi.useFakeTimers();
  // The API turns a stream away when it is full, with `Retry-After: 5`.
  const probe = stubFetch(() => refused(503, { "Retry-After": "5" }));
  connect();

  FakeEventSource.latest.failForGood();
  await vi.advanceTimersByTimeAsync(4999);
  expect(FakeEventSource.instances).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);

  expect(FakeEventSource.instances).toHaveLength(2);
  // It asked the stream's own address to learn that: an EventSource cannot read a header.
  expect(probe).toHaveBeenCalledTimes(1);
  expect(String(probe.mock.calls[0]?.[0])).toBe(STREAM);
});

test("events_never_wait_less_than_the_backoff_for_a_short_retry_after", async () => {
  vi.useFakeTimers();
  stubFetch(() => refused(503, { "Retry-After": "0" }));
  connect();

  // Retry-After is a floor and not the whole wait: a server that says 0 is still left the backoff.
  FakeEventSource.latest.failForGood();
  await vi.advanceTimersByTimeAsync(999);
  expect(FakeEventSource.instances).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(FakeEventSource.instances).toHaveLength(2);

  FakeEventSource.latest.failForGood();
  await vi.advanceTimersByTimeAsync(1999);
  expect(FakeEventSource.instances).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(FakeEventSource.instances).toHaveLength(3);
});

test("events_read_retry_after_as_a_date_and_cap_it_at_30_seconds", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-30T10:00:00Z"));
  stubFetch(() => refused(503, { "Retry-After": "Fri, 30 Oct 2026 10:00:12 GMT" }));
  connect();
  FakeEventSource.latest.failForGood();
  await vi.advanceTimersByTimeAsync(11_999);
  expect(FakeEventSource.instances).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(FakeEventSource.instances).toHaveLength(2);

  // A server that asks for an hour is not waited for that long.
  stubFetch(() => refused(503, { "Retry-After": "3600" }));
  FakeEventSource.latest.failForGood();
  await vi.advanceTimersByTimeAsync(29_999);
  expect(FakeEventSource.instances).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(FakeEventSource.instances).toHaveLength(3);
});

test("events_ignore_a_retry_after_they_cannot_read", async () => {
  vi.useFakeTimers();
  stubFetch(() => refused(503, { "Retry-After": "soon" }));
  connect();

  FakeEventSource.latest.failForGood();
  await vi.advanceTimersByTimeAsync(1000);

  expect(FakeEventSource.instances).toHaveLength(2);
});

test("events_back_off_by_themselves_when_the_probe_gets_no_answer", async () => {
  vi.useFakeTimers();
  stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
  connect();

  FakeEventSource.latest.failForGood();
  await vi.advanceTimersByTimeAsync(1000);

  expect(FakeEventSource.instances).toHaveLength(2);
});

test("events_give_back_the_stream_a_probe_opened", async () => {
  vi.useFakeTimers();
  // The probe may be let in, which opens a stream the page does not want: it is cut off.
  let signal: AbortSignal | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });
    }),
  );
  connect();

  FakeEventSource.latest.failForGood();
  await vi.advanceTimersByTimeAsync(0);

  expect(signal).toBeDefined();
  expect(signal?.aborted).toBe(true);
});

test("events_do_not_resume_from_an_id_that_is_no_u64", async () => {
  vi.useFakeTimers();
  const { source } = connect();
  source().open();
  // The API would answer a `since` like this with a 400, which would close the stream for good.
  source().send("committed", message("committed", "7", committedData("7")), "not-a-number");

  source().failForGood();
  await vi.advanceTimersByTimeAsync(1000);

  expect(FakeEventSource.latest.url).toBe(STREAM);
});

test("events_stop_for_good_when_closed", async () => {
  vi.useFakeTimers();
  const { stream, source } = connect();
  const first = source();

  first.failForGood();
  stream.close();
  await vi.advanceTimersByTimeAsync(120_000);

  // The reconnect that was waiting never happens, and the stream that was open is closed.
  expect(FakeEventSource.instances).toHaveLength(1);
  expect(first.readyState).toBe(FakeEventSource.CLOSED);
});

test("events_close_the_open_stream_and_hear_nothing_more", () => {
  const { seen, stream, source } = connect();
  const first = source();

  stream.close();
  first.send("committed", message("committed", "7", committedData("7")), "1");

  expect(first.readyState).toBe(FakeEventSource.CLOSED);
  expect(seen).toEqual([]);
});

// ---- The hook ---------------------------------------------------------------------------------

test("use_events_counts_the_events_the_filter_lets_through", () => {
  const { result } = renderHook(() => useEvents((event) => event.task_id === "7"));
  expect(result.current).toBe(0);

  act(() =>
    FakeEventSource.latest.send("committed", message("committed", "7", committedData("7")), "1"),
  );
  expect(result.current).toBe(1);

  // Another task's event, and an event about no task: not for this page.
  act(() =>
    FakeEventSource.latest.send("committed", message("committed", "8", committedData("8")), "2"),
  );
  expect(result.current).toBe(1);

  act(() =>
    FakeEventSource.latest.send("committed", message("committed", "7", committedData("7")), "3"),
  );
  expect(result.current).toBe(2);
});

test("use_events_counts_every_event_without_a_filter", () => {
  const { result } = renderHook(() => useEvents());

  act(() =>
    FakeEventSource.latest.send("committed", message("committed", "7", committedData("7")), "1"),
  );
  act(() =>
    FakeEventSource.latest.send("committed", message("committed", "8", committedData("8")), "2"),
  );

  expect(result.current).toBe(2);
});

test("use_events_uses_the_filter_of_the_latest_render", () => {
  const { result, rerender } = renderHook(({ id }) => useEvents((event) => event.task_id === id), {
    initialProps: { id: "7" },
  });

  rerender({ id: "8" });
  act(() =>
    FakeEventSource.latest.send("committed", message("committed", "7", committedData("7")), "1"),
  );
  expect(result.current).toBe(0);
  act(() =>
    FakeEventSource.latest.send("committed", message("committed", "8", committedData("8")), "2"),
  );

  // The filter is not a reason to open another stream.
  expect(result.current).toBe(1);
  expect(FakeEventSource.instances).toHaveLength(1);
});

test("use_events_counts_the_look_again_when_the_stream_opens", () => {
  const { result } = renderHook(() => useEvents((event) => event.task_id === "7"));

  act(() => FakeEventSource.latest.open());

  expect(result.current).toBe(1);
});

test("use_events_close_the_stream_when_the_page_goes", () => {
  const view = renderHook(() => useEvents());
  const stream = FakeEventSource.latest;

  view.unmount();

  expect(stream.readyState).toBe(FakeEventSource.CLOSED);
});

/** A component that only listens to the stream. */
function Probe() {
  useEvents();
  return null;
}

test("use_events_keep_one_open_stream_under_strict_mode", () => {
  render(
    <StrictMode>
      <Probe />
    </StrictMode>,
  );

  // Strict mode mounts, unmounts and mounts again: the first stream is closed, one is left open.
  const open = FakeEventSource.instances.filter((s) => s.readyState !== FakeEventSource.CLOSED);
  expect(open).toHaveLength(1);
});
