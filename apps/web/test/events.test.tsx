import { act, render, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { connectEvents, listenToEvents, useEvents, useEventsBy } from "../lib/events";
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

test("events_hand_a_page_the_whole_message_when_it_asks", () => {
  const messages: unknown[] = [];
  connectEvents({
    onEvent: () => {},
    onResync: () => {},
    onMessage: (whole) => messages.push(whole),
  });
  const source = FakeEventSource.latest;
  source.send("committed", message("committed", "7", committedData("7")), "11");
  // A message the schema refuses reaches neither handler.
  vi.spyOn(console, "error").mockImplementation(() => {});
  source.send("committed", message("committed", "7", { task_id: "7" }), "12");
  source.send("task_created", { ...message("task_created", "8", taskCreatedData("8")) });
  expect(messages).toEqual([
    { id: "11", event: "committed", data: committedData("7"), height: "1000", task_id: "7" },
    // A message with no id of its own keeps the stream's last one, as a browser does.
    {
      id: "12",
      event: "task_created",
      data: taskCreatedData("8"),
      height: "1000",
      task_id: "8",
    },
  ]);
});

test("events_begin_after_the_id_a_page_already_has_and_need_no_resync", () => {
  const resyncs = vi.fn();
  connectEvents({ onEvent: () => {}, onResync: resyncs }, { since: "42" });
  expect(FakeEventSource.latest.url).toBe(`${STREAM}?since=42`);
  FakeEventSource.latest.open();
  expect(resyncs).not.toHaveBeenCalled();

  // An id that is no u64 is not sent: the stream opens as it would without one.
  connectEvents({ onEvent: () => {}, onResync: resyncs }, { since: "4 2" });
  expect(FakeEventSource.latest.url).toBe(STREAM);
  FakeEventSource.latest.open();
  expect(resyncs).toHaveBeenCalledTimes(1);
});

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

test("events_hear_the_question_boards_events_with_their_task_and_no_text", () => {
  const { seen, source } = connect();

  // The board's events are the API's own, on the same stream, and each has a listener.
  for (const name of [
    "question_asked",
    "question_answered",
    "question_hidden",
    "clarification_posted",
  ]) {
    expect(source().listening, name).toContain(name);
  }
  source().send(
    "question_asked",
    message("question_asked", "7", { task_id: "7", question_id: "1", asker: "bob.testnet" }),
    "1",
  );
  source().send(
    "question_hidden",
    message("question_hidden", "7", { task_id: "7", question_id: "1" }),
    "2",
  );
  source().send(
    "clarification_posted",
    message("clarification_posted", "8", { task_id: "8", clarification_id: "4" }),
    "3",
  );

  expect(seen).toEqual([
    { event: "question_asked", task_id: "7" },
    { event: "question_hidden", task_id: "7" },
    { event: "clarification_posted", task_id: "8" },
  ]);
});

test("events_drop_a_board_event_whose_data_does_not_fit_and_log_it", () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const { seen, source } = connect();

  // `question_answered` names its question.
  source().send("question_answered", message("question_answered", "7", { task_id: "7" }), "1");

  expect(seen).toEqual([]);
  expect(log).toHaveBeenCalledTimes(1);
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

test("events_reopen_after_the_backoff_when_the_probe_never_answers", async () => {
  vi.useFakeTimers();
  // A server that turned the stream away may not answer the probe either, and this one never does,
  // not even when the request is cut off.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Response>(() => {})),
  );
  connect();

  FakeEventSource.latest.failForGood();
  // The probe is given five seconds, and then the backoff of a second is waited as usual.
  await vi.advanceTimersByTimeAsync(5999);
  expect(FakeEventSource.instances).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);

  expect(FakeEventSource.instances).toHaveLength(2);
  expect(FakeEventSource.latest.url).toBe(STREAM);
});

test("events_cut_off_a_probe_that_is_not_answered_in_five_seconds", async () => {
  vi.useFakeTimers();
  // A request that hangs, as a real one does, until it is aborted.
  let signal: AbortSignal | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          signal = init?.signal ?? undefined;
          signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    ),
  );
  connect();

  FakeEventSource.latest.failForGood();
  await vi.advanceTimersByTimeAsync(4999);
  expect(signal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(signal?.aborted).toBe(true);

  // Without a Retry-After the backoff decides, and it was a second.
  await vi.advanceTimersByTimeAsync(1000);
  expect(FakeEventSource.instances).toHaveLength(2);
});

test("events_double_the_backoff_after_a_probe_that_timed_out", async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Response>(() => {})),
  );
  connect();

  // Each failure costs the five seconds of the probe and then the backoff: 1, 2, 4 seconds.
  const waits: number[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
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

  expect(waits).toEqual([6000, 7000, 9000]);
});

test("events_leave_no_timer_behind_once_the_probe_has_answered", async () => {
  vi.useFakeTimers();
  stubFetch(() => refused(503, { "Retry-After": "2" }));
  connect();

  FakeEventSource.latest.failForGood();
  await vi.advanceTimersByTimeAsync(0);

  // The wait before the reopen is pending, and not the five seconds the probe was given.
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(2000);
  expect(FakeEventSource.instances).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(0);
});

test("events_close_while_the_probe_waits_and_nothing_is_left_running", async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Response>(() => {})),
  );
  const { stream } = connect();
  FakeEventSource.latest.failForGood();
  await vi.advanceTimersByTimeAsync(2000);

  stream.close();
  await vi.advanceTimersByTimeAsync(60_000);

  expect(FakeEventSource.instances).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
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

test("use_events_by_counts_each_kind_over_one_stream_and_all_of_them_on_a_look_again", () => {
  const { result } = renderHook(() =>
    useEventsBy(["task", "board"] as const, (event) =>
      event.task_id !== "7" ? null : event.event.startsWith("question") ? "board" : "task",
    ),
  );
  expect(result.current).toEqual({ task: 0, board: 0 });

  act(() =>
    FakeEventSource.latest.send("committed", message("committed", "7", committedData("7")), "1"),
  );
  act(() =>
    FakeEventSource.latest.send(
      "question_asked",
      message("question_asked", "7", { task_id: "7", question_id: "1", asker: "bob.testnet" }),
      "2",
    ),
  );
  act(() =>
    FakeEventSource.latest.send("committed", message("committed", "8", committedData("8")), "3"),
  );
  expect(result.current).toEqual({ task: 1, board: 1 });

  // The stream opened with nothing to resume from: every part looks again.
  act(() => FakeEventSource.latest.open());
  expect(result.current).toEqual({ task: 2, board: 2 });
  expect(FakeEventSource.instances).toHaveLength(1);
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

// ---- One stream for the tab -------------------------------------------------------------------

/** A component that counts the events about task `id`. */
function Counter({ id, testId }: { id: string; testId: string }) {
  const count = useEvents((event) => event.task_id === id);
  return <span data-testid={testId}>{count}</span>;
}

test("events_are_one_stream_for_the_tab_however_many_parts_listen", () => {
  const first = render(<Counter id="7" testId="seven" />);
  const second = render(<Counter id="8" testId="eight" />);
  const third = renderHook(() => useEventsBy(["any"] as const, () => "any"));
  expect(FakeEventSource.instances).toHaveLength(1);

  const source = FakeEventSource.latest;
  act(() => source.send("committed", message("committed", "7", committedData("7")), "1"));
  act(() => source.send("committed", message("committed", "8", committedData("8")), "2"));
  expect(first.getByTestId("seven").textContent).toBe("1");
  expect(second.getByTestId("eight").textContent).toBe("1");
  expect(third.result.current.any).toBe(2);

  // A part that goes leaves the stream to the others; the last one to go closes it.
  first.unmount();
  third.unmount();
  expect(source.readyState).not.toBe(FakeEventSource.CLOSED);
  act(() => source.send("committed", message("committed", "8", committedData("8")), "3"));
  expect(second.getByTestId("eight").textContent).toBe("2");
  second.unmount();
  expect(source.readyState).toBe(FakeEventSource.CLOSED);
  expect(FakeEventSource.instances).toHaveLength(1);
});

test("events_hand_a_part_that_joins_with_an_id_what_came_after_it", () => {
  // The stream is opened from id 10 (a page that read a backlog up to it), and hears 11 and 12.
  const opener = listenToEvents({ onEvent: () => {}, onResync: () => {} }, { since: "10" });
  const source = FakeEventSource.latest;
  act(() => {
    source.open();
    source.send("committed", message("committed", "7", committedData("7")), "11");
    source.send("committed", message("committed", "8", committedData("8")), "12");
  });

  // A part that read up to 11 joins: it is handed 12, and nothing is opened.
  const seen: Array<string | undefined> = [];
  const resyncs = vi.fn();
  const joiner = listenToEvents(
    { onEvent: () => {}, onResync: resyncs, onMessage: (whole) => seen.push(whole.id) },
    { since: "11" },
  );
  expect(seen).toEqual(["12"]);
  expect(resyncs).not.toHaveBeenCalled();
  expect(FakeEventSource.instances).toHaveLength(1);
  act(() => source.send("committed", message("committed", "7", committedData("7")), "13"));
  expect(seen).toEqual(["12", "13"]);

  // One that read up to 9 can't be handed 10: the stream began after it, so it is told to look
  // again, after it is handed what the stream has.
  const behind = vi.fn();
  const older: Array<string | undefined> = [];
  listenToEvents(
    { onEvent: () => {}, onResync: behind, onMessage: (whole) => older.push(whole.id) },
    { since: "9" },
  ).close();
  expect(older).toEqual(["11", "12", "13"]);
  expect(behind).toHaveBeenCalledTimes(1);

  joiner.close();
  opener.close();
  expect(source.readyState).toBe(FakeEventSource.CLOSED);
});

test("events_hand_each_listener_a_message_once_and_one_that_fails_stops_no_other", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  // A page opens the stream from id 10 and fails on every message.
  listenToEvents(
    {
      onEvent: () => {
        throw new Error("a part that fails");
      },
      onResync: () => {},
    },
    { since: "10" },
  );
  const source = FakeEventSource.latest;
  // Another joins having read up to 12 already, before the stream has sent anything.
  const seen: Array<string | undefined> = [];
  listenToEvents(
    { onEvent: () => {}, onResync: () => {}, onMessage: (whole) => seen.push(whole.id) },
    { since: "12" },
  );

  // The stream then sends what came after 10: the second part is handed only 13, once.
  act(() => {
    source.open();
    for (const id of ["11", "12", "13"]) {
      source.send("committed", message("committed", "7", committedData("7")), id);
    }
    source.send("committed", message("committed", "7", committedData("7")), "13");
  });
  expect(seen).toEqual(["13"]);
});

test("events_follow_the_stream_when_its_ids_go_back_after_the_api_s_database_started_over", () => {
  // A page has heard up to 500. The API's database starts over, and the API begins the stream at
  // its new newest id, so the next ids are lower: the page hears them, and is told to look again.
  const seen: Array<string | undefined> = [];
  const resyncs = vi.fn();
  listenToEvents({
    onEvent: () => {},
    onResync: resyncs,
    onMessage: (whole) => seen.push(whole.id),
  });
  const source = FakeEventSource.latest;
  act(() => {
    source.open();
    source.send("committed", message("committed", "7", committedData("7")), "500");
  });
  expect(resyncs).toHaveBeenCalledTimes(1);

  act(() => source.send("committed", message("committed", "8", committedData("8")), "31"));
  expect(seen).toEqual(["500", "31"]);
  expect(resyncs).toHaveBeenCalledTimes(2);
  // From there on the new ids are followed, each once.
  act(() => {
    source.send("committed", message("committed", "8", committedData("8")), "32");
    source.send("committed", message("committed", "8", committedData("8")), "32");
  });
  expect(seen).toEqual(["500", "31", "32"]);

  // A part that joins now, having read up to 31 of the new database, is handed 32: what was kept
  // from the old one is gone.
  const joined: Array<string | undefined> = [];
  listenToEvents(
    { onEvent: () => {}, onResync: () => {}, onMessage: (whole) => joined.push(whole.id) },
    { since: "31" },
  );
  expect(joined).toEqual(["32"]);
});

test("events_opened_after_an_id_follow_lower_ids_when_the_database_started_over", () => {
  // Opened after 12 (a backlog the page read), and the database started over below it.
  const seen: Array<string | undefined> = [];
  const resyncs = vi.fn();
  listenToEvents(
    { onEvent: () => {}, onResync: resyncs, onMessage: (whole) => seen.push(whole.id) },
    { since: "12" },
  );
  const source = FakeEventSource.latest;
  act(() => {
    source.open();
    source.send("committed", message("committed", "7", committedData("7")), "4");
  });
  expect(seen).toEqual(["4"]);
  expect(resyncs).toHaveBeenCalledTimes(1);
});
