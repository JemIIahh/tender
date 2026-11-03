// The waits of the chain suite's setup and teardown. Every wait has a deadline, and the error of a
// wait that runs out says what it was waiting for, and for `until` what it last saw.

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const seconds = (ms: number) => `${Math.round(ms / 100) / 10} s`;

/**
 * `work`, unless `ms` pass first or `signal` aborts, which is an error that names `what` was being
 * waited for. The work itself goes on, unobserved: whoever started it has to see to what it makes.
 */
export function limited<T>(
  what: string,
  ms: number,
  work: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const settle = (finish: () => void) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      finish();
    };
    const timer = setTimeout(() => {
      settle(() => reject(new Error(`timed out after ${seconds(ms)} waiting for ${what}`)));
    }, ms);
    const onAbort = () => {
      settle(() => reject(new Error(`stopped while waiting for ${what}`)));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error)),
    );
  });
}

/** What a probe of `until` throws to end the wait at once: what it waits for can no longer come. */
export class GiveUp extends Error {}

/** What a probe of `until` answers: the value it was waiting for, or what it saw instead. */
export type Poll<T> = { value: T } | { seen: string };

/**
 * Asks `probe` every `everyMs` until it gives a value. A probe that throws has not got one yet,
 * and its error is what was seen, unless it is a `GiveUp`, which ends the wait with that error.
 * After `ms` the error names `what` and the last thing seen.
 */
export async function until<T>(
  what: string,
  ms: number,
  probe: () => Promise<Poll<T>>,
  signal?: AbortSignal,
  everyMs = 250,
): Promise<T> {
  const deadline = Date.now() + ms;
  let seen = "nothing yet";
  for (;;) {
    signal?.throwIfAborted();
    try {
      const polled = await probe();
      if ("value" in polled) return polled.value;
      seen = polled.seen;
    } catch (error) {
      if (error instanceof GiveUp) throw error;
      seen = `an error: ${messageOf(error)}`;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${seconds(ms)} waiting for ${what} (last seen: ${seen})`);
    }
    await sleep(everyMs);
  }
}
