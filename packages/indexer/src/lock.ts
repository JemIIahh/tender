import type { Db } from "@tender/db";

/** The last piece of work queued on each database that is still busy; it never rejects. */
const tails = new WeakMap<Db, Promise<void>>();

/**
 * Runs `fn` once all the work queued on `db` before it has settled, and returns what `fn` returns
 * or throws. The runner applies each block under it and reconcile makes each repair under it, so
 * no repair in this process interleaves with a block: a block that came between a repair's check
 * and its write would be lost, or counted twice. It is not exported from the package.
 */
export function withIndexLock<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  const result = (tails.get(db) ?? Promise.resolve()).then(fn);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  tails.set(db, tail);
  return result;
}
