/** What `withinDeadline` rejects with when the time it was given has passed. */
export class NoAnswerInTime extends Error {
  constructor(ms: number) {
    super(`no answer within ${ms} ms`);
    this.name = "NoAnswerInTime";
  }
}

/**
 * What `promise` settles to, or a rejection with `NoAnswerInTime` once `ms` have passed: for a
 * question to the chain, when the caller can wait less than the client does. The client gives a
 * read of the node `rpcTimeoutMs` (30 s unless it is set), then cancels it and fails it with
 * `E_TIMEOUT`; this race does not cancel the question. One that is given up on here settles on its
 * own, and what it says then is dropped; the race subscribes to it, so a failure after the
 * deadline is no unhandled rejection. The timer is cleared however the race ends.
 */
export async function withinDeadline<T>(ms: number, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new NoAnswerInTime(ms)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
