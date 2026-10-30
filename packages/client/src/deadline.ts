import { AsyncLocalStorage } from "node:async_hooks";
import { TenderError } from "./errors";

// near-api-js 7.4.0 has no time to give a request. Its JSON-RPC provider takes a URL and some
// headers, asks the global `fetch` with no signal, and retries a failing node for minutes, so a
// node that takes a request and never answers holds the caller for ever, and with it whatever the
// caller holds: an account's turn in `defaultQueue`, and near-api-js's lock on the key's nonce.
//
// `withDeadline` gives a call a time, in two parts that do not rely on each other:
//
// - It cancels. The call runs in a scope that holds an abort signal, and the global `fetch` is
//   wrapped, once, to add the signal of the scope it is called in to the request. A request made
//   outside a scope is called as it was, so no other `fetch` of the process is touched. When the
//   time is out the signal aborts: the request is cancelled and its connection closed, and
//   near-api-js, which does not retry a cancelled request, gives up at once and lets go of what it
//   held. The one signal covers everything the call does, so near-api-js's retries are inside the
//   time and do not add to it.
// - It does not trust the cancel. The call is raced against the timer too, so that the caller
//   hears of the timeout when the time is out, whatever the call is doing: sleeping between two of
//   near-api-js's retries, which nothing cancels, or running on a `fetch` that something else put
//   in place and that does not look at its signal.

/**
 * How long a read of the node (a view, a key, a block) may take, in milliseconds, unless the client
 * is given another time.
 */
export const DEFAULT_RPC_TIMEOUT_MS = 30_000;

/**
 * How long a send may take, in milliseconds, unless the client is given another time: from the
 * first read it makes to the final outcome. A send is the one call that waits for the chain.
 */
export const DEFAULT_SEND_TIMEOUT_MS = 120_000;

/** The longest wait `setTimeout` keeps: it runs anything above this after 1 ms instead. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * `value`, or `fallback` when it is not set. A time that is set must be a whole number of
 * milliseconds from 1 to what a timer keeps: `setTimeout` would turn anything else into a wait of a
 * millisecond, and every call would time out at once. Anything else throws a `RangeError` that
 * names `option`.
 */
export function timeoutOption(option: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
    throw new RangeError(
      `${option} must be a whole number of milliseconds from 1 to ${MAX_TIMEOUT_MS}, not ${String(value)}`,
    );
  }
  return value;
}

/**
 * Where the signal of the call in hand is kept. The holder and the wrapped `fetch` are shared on
 * `globalThis` through registered symbols, so that a second copy of this module, as a loader can
 * make, finds both and adds neither again: two holders would leave one copy's calls with a `fetch`
 * that looks in the other's.
 */
const SCOPE = Symbol.for("@tender/client:deadline-scope");
/** Marks the `fetch` that carries the signal of a scope. */
const SCOPED = Symbol.for("@tender/client:deadline-fetch");

function sharedScope(): AsyncLocalStorage<AbortSignal> {
  const found: unknown = Reflect.get(globalThis, SCOPE);
  if (found instanceof AsyncLocalStorage) return found;
  const made = new AsyncLocalStorage<AbortSignal>();
  Reflect.set(globalThis, SCOPE, made);
  return made;
}

const inScope = sharedScope();

/**
 * `next`, with the signal of the scope it is called in added to the request. Called outside a
 * scope, it is `next`. A signal the request has already is kept: either one aborts it.
 */
function scopedFetch(next: typeof fetch): typeof fetch {
  const scoped = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const deadline = inScope.getStore();
    if (deadline === undefined) return next(input, init);
    const own = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    return next(input, { ...init, signal: own ? AbortSignal.any([own, deadline]) : deadline });
  };
  return Object.assign(scoped, { [SCOPED]: true });
}

/**
 * Puts the wrapped `fetch` in place unless it is. Asked before every call and not once: a test
 * that stubs `fetch` and restores it takes the wrapper away with the stub, and the next call puts
 * it back.
 */
function ensureScopedFetch(): void {
  const current: unknown = globalThis.fetch;
  if (typeof current !== "function" || Reflect.get(current, SCOPED) === true) return;
  Reflect.set(globalThis, "fetch", scopedFetch(current as typeof fetch));
}

/**
 * Runs `call`, which asks a node for something through near-api-js, and gives its result, or fails
 * with a `TenderError` with code `E_TIMEOUT` once `timeoutMs` have passed. `operation` names the
 * call in the error's message, which says nothing else: not the node's URL, and not a key.
 *
 * Every request `call` makes is cancelled at that time, its connection with it, and near-api-js's
 * retries are inside the time. The failure comes at that time whatever `call` is doing (see the top
 * of this file). What `call` does after that it does unobserved, and a send may still run on the
 * chain: the node can have had the transaction when the caller stopped waiting.
 *
 * A call made inside another's time is under that time too. The timer is put away however the call
 * ends.
 */
export async function withDeadline<T>(
  operation: string,
  timeoutMs: number,
  call: () => Promise<T>,
): Promise<T> {
  ensureScopedFetch();
  const timeout = new AbortController();
  const outer = inScope.getStore();
  const signal = outer === undefined ? timeout.signal : AbortSignal.any([outer, timeout.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new TenderError("E_TIMEOUT", `${operation} timed out after ${timeoutMs} ms`);
      timeout.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([inScope.run(signal, call), expired]);
  } finally {
    clearTimeout(timer);
  }
}
