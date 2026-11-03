import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { STOP_WAITING_MS, useWaitedLong } from "../lib/waiting";

// How long the page waits before it offers to stop waiting (lib/waiting.ts).

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const wait = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

test("a_wallet_is_waited_on_for_a_minute_before_stopping_is_offered", async () => {
  expect(STOP_WAITING_MS).toBe(60_000);
  const { result } = renderHook(() => useWaitedLong("wallet"));

  expect(result.current).toBe(false);
  await wait(STOP_WAITING_MS - 1);
  expect(result.current).toBe(false);
  await wait(1);
  expect(result.current).toBe(true);
});

test("waiting_on_something_else_starts_the_count_again", async () => {
  const { result, rerender } = renderHook(({ what }) => useWaitedLong(what), {
    initialProps: { what: "signin" as string | null },
  });
  await wait(STOP_WAITING_MS);
  expect(result.current).toBe(true);

  // The next thing the page waits on is a new wait, whatever came before.
  rerender({ what: "wallet" });
  expect(result.current).toBe(false);
  await wait(STOP_WAITING_MS - 1);
  expect(result.current).toBe(false);
  await wait(1);
  expect(result.current).toBe(true);
});

test("waiting_on_nothing_is_not_a_wait", async () => {
  const { result, rerender } = renderHook(({ what }) => useWaitedLong(what), {
    initialProps: { what: "wallet" as string | null },
  });
  await wait(STOP_WAITING_MS);
  expect(result.current).toBe(true);

  rerender({ what: null });
  expect(result.current).toBe(false);
  await wait(STOP_WAITING_MS * 2);
  expect(result.current).toBe(false);
});
