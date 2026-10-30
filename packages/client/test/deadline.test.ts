import { afterEach, expect, test, vi } from "vitest";
import { TenderError, withDeadline } from "../src/index";

// `withDeadline` on fake timers, with no network: how it counts its time, what it gives back, and
// that it puts its timer away however the call ends. rpc-timeouts.test.ts has it against real
// sockets. This file makes no real request, and must stay so: in a worker that has used real
// sockets, a test with fake timers was seen to count a timer that Node's own `fetch` had armed
// (`vi.getTimerCount()` was 2 for one deadline), which is why these tests are not in that file.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test("with_deadline_gives_what_the_call_gives_and_puts_its_timer_away", async () => {
  vi.useFakeTimers();
  await expect(withDeadline("op", 1_000, async () => "done")).resolves.toBe("done");
  expect(vi.getTimerCount()).toBe(0);

  const failure = new Error("not a timeout");
  await expect(
    withDeadline("op", 1_000, async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(vi.getTimerCount()).toBe(0);

  // A call that throws before it returns a promise is no different.
  await expect(
    withDeadline("op", 1_000, () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(vi.getTimerCount()).toBe(0);
});

test("with_deadline_fails_with_E_TIMEOUT_at_the_limit_and_not_before", async () => {
  vi.useFakeTimers();
  const call = withDeadline(
    "TenderClient.view get_task",
    1_000,
    () => new Promise<never>(() => {}),
  );
  const outcome = call.then(
    () => "resolved",
    (error: unknown) => error,
  );

  await vi.advanceTimersByTimeAsync(999);
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  const error = await outcome;
  expect(error).toBeInstanceOf(TenderError);
  expect(error).toMatchObject({
    code: "E_TIMEOUT",
    message: "TenderClient.view get_task timed out after 1000 ms",
  });
  expect(vi.getTimerCount()).toBe(0);
});

test("a_call_inside_another_s_time_is_under_that_time_too", async () => {
  const signals: AbortSignal[] = [];
  vi.stubGlobal("fetch", (_url: unknown, init?: RequestInit) => {
    if (init?.signal) signals.push(init.signal);
    return new Promise<Response>(() => undefined);
  });
  vi.useFakeTimers();

  // The outer time is the shorter, and the request is made by the inner call.
  const outer = withDeadline("outer", 1_000, () =>
    withDeadline("inner", 60_000, () => fetch("http://127.0.0.1:1")),
  );
  const outcome = outer.then(
    () => "resolved",
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(1_000);

  expect(await outcome).toMatchObject({
    code: "E_TIMEOUT",
    message: "outer timed out after 1000 ms",
  });
  expect(signals).toHaveLength(1);
  expect(signals[0]?.aborted).toBe(true);
});

test("a_request_made_outside_a_call_carries_no_signal_of_ours", async () => {
  const signals: Array<AbortSignal | null | undefined> = [];
  vi.stubGlobal("fetch", (_url: unknown, init?: RequestInit) => {
    signals.push(init?.signal);
    return Promise.resolve(new Response("ok"));
  });

  // Inside a call the request is given the call's signal; outside, and after the call, it is called
  // as it was made, with the signal its maker gave it or none. (The first call puts the wrapper over
  // the stub, so the stub has the wrapper's word for the rest.)
  await withDeadline("op", 1_000, () => fetch("http://127.0.0.1:1"));
  const own = new AbortController();
  await fetch("http://127.0.0.1:1", { signal: own.signal });
  await fetch("http://127.0.0.1:1");

  expect(signals[0]).toBeInstanceOf(AbortSignal);
  expect(signals[1]).toBe(own.signal);
  expect(signals[2]).toBeUndefined();
});

test("a_request_that_has_a_signal_keeps_it_inside_a_call", async () => {
  const signals: Array<AbortSignal | null | undefined> = [];
  vi.stubGlobal("fetch", (_url: unknown, init?: RequestInit) => {
    signals.push(init?.signal);
    return new Promise<Response>(() => undefined);
  });
  vi.useFakeTimers();

  // Either aborts the request: the signal it has and the call's. Here its maker's goes first.
  const own = new AbortController();
  const call = withDeadline("op", 1_000, () => fetch("http://127.0.0.1:1", { signal: own.signal }));
  const outcome = call.then(
    () => "resolved",
    (error: unknown) => error,
  );
  const reason = new Error("the maker gave up");
  own.abort(reason);

  expect(signals).toHaveLength(1);
  expect(signals[0]).not.toBe(own.signal);
  expect(signals[0]?.aborted).toBe(true);
  expect(signals[0]?.reason).toBe(reason);
  // The call is still bounded: its own time fails it, as the stub does not settle.
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await outcome).toMatchObject({ code: "E_TIMEOUT" });
});
