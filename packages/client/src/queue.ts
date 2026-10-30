import { InvalidNonceError } from "near-api-js/rpc-errors";

/** How long `KeyQueue` waits before it calls again after a nonce collision. */
const RETRY_MS = 500;

/**
 * Whether `error` says the transaction lost its nonce to another one of the same key.
 *
 * near-api-js 7.4.0 throws an `InvalidNonceError` (from `near-api-js/rpc-errors`) when the RPC turns
 * a transaction down for that. Its message, `Invalid nonce (ak: <n>, tx: <n>)`, does not contain
 * `InvalidNonce`, so the error is known by its class, or by its name `InvalidNonceError` when
 * another copy of near-api-js made it. Any other error counts when its message contains
 * `InvalidNonce`, such as the `TenderError` of a final outcome that failed with
 * `{"InvalidTxError":{"InvalidNonce":…}}`.
 */
function isNonceCollision(error: unknown): boolean {
  if (error instanceof InvalidNonceError) return true;
  if (typeof error !== "object" || error === null) return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  return (
    name === "InvalidNonceError" ||
    (typeof message === "string" && message.includes("InvalidNonce"))
  );
}

/** Calls `fn`, and calls it once more, `RETRY_MS` later, if it failed with a nonce collision. */
async function withOneRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (!isNonceCollision(error)) throw error;
  }
  await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
  return fn();
}

/**
 * Runs async calls one at a time per key, and the calls of different keys at the same time.
 *
 * A NEAR access key has one nonce, and each transaction signed with it must carry a higher one than
 * the last that ran. Two transactions of one key in flight at once can carry the same nonce, and
 * then only one of them runs. Keyed by signer, the queue sends them one after another.
 */
export class KeyQueue {
  /** The last call queued for each key that is still busy; it never rejects. */
  private readonly tails = new Map<string, Promise<void>>();

  /**
   * Calls `fn` once every call queued under `key` before it has settled, and returns what `fn`
   * returns or throws. A failure does not hold up the calls after it. If `fn` fails with a nonce
   * collision, it is called once more after 500 ms, before the next call of the key starts; a
   * second collision is thrown.
   */
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const result = (this.tails.get(key) ?? Promise.resolve()).then(() => withOneRetry(fn));
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}

/**
 * The queue of this process. `TenderClient.send` runs every transaction in it, keyed by the
 * signer's account id, so the clients of one account in this process never race each other.
 */
export const defaultQueue = new KeyQueue();
