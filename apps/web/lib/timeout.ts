/**
 * Runs `run` with a signal that aborts with a `TimeoutError` if `run` has not finished after `ms`.
 * A `fetch` that is given the signal rejects with that error, so a request that gets no answer
 * ends instead of leaving a page waiting.
 */
export async function withTimeout<T>(
  ms: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException(`no answer after ${ms} ms`, "TimeoutError"));
  }, ms);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}
