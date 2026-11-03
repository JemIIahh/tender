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

/**
 * A patcher of `fetch` like Next.js's: it patches once, by a mark that it keeps on the function it
 * leaves in place, and patches again whenever it finds the mark gone. `layers.count` is how many
 * times a request has gone through a layer of it.
 */
function patchOnce(layers: { count: number }): void {
  const current = globalThis.fetch as typeof fetch & { __patched?: true };
  if (current.__patched) return;
  Reflect.set(
    globalThis,
    "fetch",
    Object.assign(
      (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        layers.count++;
        return current(input, init);
      },
      { __patched: true as const },
    ),
  );
}

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

test("with_deadline_ends_its_message_with_the_note_it_is_given", async () => {
  vi.useFakeTimers();
  const outcome = withDeadline(
    "TenderClient.send commit",
    1_000,
    () => new Promise<never>(() => {}),
    "The caller has a word to add.",
  ).then(
    () => "resolved",
    (error: unknown) => error,
  );

  await vi.advanceTimersByTimeAsync(1_000);
  expect(await outcome).toMatchObject({
    code: "E_TIMEOUT",
    message: "TenderClient.send commit timed out after 1000 ms. The caller has a word to add.",
  });
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

test("calls_put_fetch_in_place_once_and_leave_it_there", async () => {
  vi.stubGlobal("fetch", () => Promise.resolve(new Response("ok")));
  await withDeadline("op", 1_000, () => fetch("http://127.0.0.1:1"));
  const placed = globalThis.fetch;

  for (let call = 0; call < 5; call++) {
    await withDeadline("op", 1_000, () => fetch("http://127.0.0.1:1"));
  }
  expect(globalThis.fetch).toBe(placed);
});

test("a_patcher_that_looks_for_its_own_mark_does_not_pile_up_with_ours", async () => {
  let reached = 0;
  const signals: Array<AbortSignal | null | undefined> = [];
  vi.stubGlobal("fetch", (_url: unknown, init?: RequestInit) => {
    reached++;
    signals.push(init?.signal);
    return Promise.resolve(new Response("ok"));
  });
  const patcher = { count: 0 };
  patchOnce(patcher);

  // The two look at `fetch` in turn, as a framework does on each request and a call on each start.
  // Whichever finds the other's wrapper over its own takes it for its own if it keeps its mark.
  for (let round = 0; round < 5; round++) {
    await withDeadline("op", 1_000, () => fetch("http://127.0.0.1:1"));
    patchOnce(patcher);
  }

  // A request goes through one layer of the patcher and reaches the function under it once. Were a
  // layer added in each round, the patcher would have counted six.
  const inCalls = signals.slice();
  patcher.count = 0;
  reached = 0;
  await fetch("http://127.0.0.1:1");
  expect(patcher.count).toBe(1);
  expect(reached).toBe(1);
  // And its mark has not kept ours from doing what it is for: each request made in a call had the
  // call's signal.
  expect(inCalls).toHaveLength(5);
  for (const signal of inCalls) expect(signal).toBeInstanceOf(AbortSignal);
});
