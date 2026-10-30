import { afterEach, expect, test, vi } from "vitest";
import { withTimeout } from "../lib/timeout";
import { rejection } from "./support";

afterEach(() => {
  vi.useRealTimers();
});

test("with_timeout_gives_what_the_work_gives", async () => {
  expect(await withTimeout(1000, async () => "done")).toBe("done");
  await expect(
    withTimeout(1000, async () => {
      throw new Error("its own");
    }),
  ).rejects.toThrow("its own");
});

test("with_timeout_aborts_the_signal_with_a_timeout_error_when_time_is_up", async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  const pending = rejection(
    withTimeout(
      1000,
      (s) =>
        new Promise((_resolve, reject) => {
          signal = s;
          s.addEventListener("abort", () => reject(s.reason));
        }),
    ),
  );

  await vi.advanceTimersByTimeAsync(999);
  expect(signal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);

  expect(signal?.aborted).toBe(true);
  const error = await pending;
  expect(error.name).toBe("TimeoutError");
  expect(error.message).toContain("1000");
});

test("with_timeout_stops_the_timer_once_the_work_is_over", async () => {
  vi.useFakeTimers();

  await withTimeout(1000, async () => "done");
  await withTimeout(1000, async () => {}).catch(() => {});
  await withTimeout(1000, async () => {
    throw new Error("x");
  }).catch(() => {});

  expect(vi.getTimerCount()).toBe(0);
});
