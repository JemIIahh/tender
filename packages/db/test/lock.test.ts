import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tryAdvisoryLock } from "../src/index";

// The session advisory lock that keeps one indexer writing to a database (P03-R25). The first
// block drives the code with a fake connection, so it runs anywhere. The second takes real locks,
// on the Postgres server at TEST_DATABASE_URL (CI has one), since only a server can show what a
// session lock does.

const POSTGRES_URL = process.env.TEST_DATABASE_URL || undefined;
const URL_OF_NONE = "postgres://tester:secret@localhost:1/none";
const KEY = 0x494e4445584552n;

/** Resolves once `signal` aborts, or rejects after `ms`. */
function abortedWithin(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => reject(new Error(`not aborted within ${ms} ms`)), ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

describe("tryAdvisoryLock on a fake connection", () => {
  afterEach(() => vi.restoreAllMocks());

  /**
   * Replaces the connection of every `pg.Client`: `connect` fails with `connectError` if given,
   * the lock query answers `locked`, and each check runs `check`. `end` emits 'end', as pg does.
   */
  function fakeConnection(
    options: { locked?: boolean; connectError?: Error; check?: () => Promise<unknown> } = {},
  ) {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const clients: pg.Client[] = [];
    const ended = vi.fn();
    vi.spyOn(pg.Client.prototype, "connect").mockImplementation(async function (this: pg.Client) {
      clients.push(this);
      if (options.connectError) throw options.connectError;
    } as never);
    vi.spyOn(pg.Client.prototype, "query").mockImplementation((async (
      text: string,
      values?: unknown[],
    ) => {
      queries.push({ text, values });
      if (text.includes("pg_try_advisory_lock"))
        return { rows: [{ locked: options.locked ?? true }] };
      if (options.check) await options.check();
      return { rows: [] };
    }) as never);
    vi.spyOn(pg.Client.prototype, "end").mockImplementation(async function (this: pg.Client) {
      ended();
      this.emit("end");
    } as never);
    return { queries, clients, ended };
  }

  it("takes_the_lock_on_a_connection_of_its_own_and_lets_it_go_once", async () => {
    const { queries, ended } = fakeConnection();
    const lock = await tryAdvisoryLock(URL_OF_NONE, KEY, { checkEveryMs: 60_000 });
    expect(lock).not.toBeNull();
    expect(queries).toEqual([
      { text: "select pg_try_advisory_lock($1::bigint) as locked", values: [KEY.toString()] },
    ]);
    expect(lock?.lost.aborted).toBe(false);

    const releasing = lock?.release();
    expect(lock?.release()).toBe(releasing);
    await releasing;
    expect(ended).toHaveBeenCalledTimes(1);
    // The connection's end, which a release causes, is no loss.
    expect(lock?.lost.aborted).toBe(false);
  });

  it("is_null_when_another_session_holds_the_lock", async () => {
    const { ended } = fakeConnection({ locked: false });
    expect(await tryAdvisoryLock(URL_OF_NONE, KEY)).toBeNull();
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it("rejects_when_it_cannot_connect", async () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const { ended } = fakeConnection({ connectError: refused });
    await expect(tryAdvisoryLock(URL_OF_NONE, KEY)).rejects.toBe(refused);
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it("loses_the_lock_when_a_check_fails", async () => {
    let checks = 0;
    const { ended } = fakeConnection({
      check: async () => {
        checks += 1;
        if (checks === 3) throw new Error("Connection terminated unexpectedly");
      },
    });
    const lock = await tryAdvisoryLock(URL_OF_NONE, KEY, { checkEveryMs: 5 });
    if (lock === null) throw new Error("the lock was not taken");
    await abortedWithin(lock.lost, 2_000);
    expect(checks).toBe(3);
    // No check follows a loss, and nothing has closed the connection yet: that is release's.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(checks).toBe(3);
    expect(ended).not.toHaveBeenCalled();
    await lock.release();
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it("loses_the_lock_when_the_connection_fails_or_ends", async () => {
    for (const event of ["error", "end"] as const) {
      const { clients } = fakeConnection();
      const lock = await tryAdvisoryLock(URL_OF_NONE, KEY, { checkEveryMs: 60_000 });
      if (lock === null) throw new Error("the lock was not taken");
      clients[0]?.emit(event, new Error("terminating connection due to administrator command"));
      expect(lock.lost.aborted, event).toBe(true);
      await lock.release();
      vi.restoreAllMocks();
    }
  });
});

/**
 * The lock, taken within 5 s. A server lets a session's locks go as the session's process exits,
 * which can be a moment after its client has heard the session end.
 */
async function takeSoon(url: string, key: bigint, checkEveryMs?: number) {
  for (let tries = 0; tries < 50; tries++) {
    const lock = await tryAdvisoryLock(url, key, { checkEveryMs });
    if (lock !== null) return lock;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("the lock was not taken within 5 s");
}

describe.skipIf(!POSTGRES_URL)("tryAdvisoryLock on postgres", () => {
  it("one_session_holds_the_lock_and_the_server_ending_it_loses_it", {
    timeout: 60_000,
  }, async () => {
    const url = POSTGRES_URL ?? "";
    // A key of this run alone: 48 random bits, so the server keeps it in classid and objid.
    const key = BigInt(`0x${randomBytes(6).toString("hex")}`);

    const first = await tryAdvisoryLock(url, key, { checkEveryMs: 100 });
    if (first === null) throw new Error("a free lock was not taken");
    expect(await tryAdvisoryLock(url, key)).toBeNull();
    await first.release();
    expect(first.lost.aborted).toBe(false);

    const second = await takeSoon(url, key, 100);
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    try {
      // The server ends the session that holds the lock, as a restart or an administrator would.
      const { rows } = await admin.query<{ ended: boolean }>(
        `select pg_terminate_backend(pid) as ended
           from pg_locks
          where locktype = 'advisory' and granted and objsubid = 1
            and classid = ($1::bigint >> 32)::oid and objid = ($1::bigint & 4294967295)::oid`,
        [key.toString()],
      );
      expect(rows).toEqual([{ ended: true }]);
      await abortedWithin(second.lost, 10_000);
      await second.release();

      // Another session takes it then.
      await (await takeSoon(url, key)).release();
    } finally {
      await admin.end();
    }
  });
});
