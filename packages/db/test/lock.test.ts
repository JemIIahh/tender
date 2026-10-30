import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LockNotHeldError, tryAdvisoryLock } from "../src/index";

// The session advisory lock that keeps one indexer writing to a database (P03-R25). The first
// block drives the code with a fake connection, so it runs anywhere. The second takes real locks,
// on the Postgres server at TEST_DATABASE_URL (CI has one), since only a server can show what a
// session lock does.

const POSTGRES_URL = process.env.TEST_DATABASE_URL || undefined;
const URL_OF_NONE = "postgres://tester:secret@localhost:1/none";
const KEY = 0x494e4445584552n;
/** The session the fake server gives every connection. */
const PID = 4242;

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

/** What the lock's session runs first, once it is connected. */
const SET_IDLE_TIMEOUT = "set idle_session_timeout = '30s'";

describe("tryAdvisoryLock on a fake connection", () => {
  afterEach(() => vi.restoreAllMocks());

  /**
   * Replaces the connection of every `pg.Client`: `connect` fails with `connectError` if given, the
   * idle timeout is refused with `setError` if given, the lock query answers `locked` on session
   * `PID`, and each look at `pg_locks` answers what `held` gives, by default that session `PID`
   * holds the lock. `end` emits 'end', as pg does.
   */
  function fakeConnection(
    options: {
      locked?: boolean;
      connectError?: Error;
      setError?: Error;
      held?: (look: number) => Promise<{ held: boolean; pid: number }>;
    } = {},
  ) {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const clients: pg.Client[] = [];
    const ended = vi.fn();
    let looks = 0;
    vi.spyOn(pg.Client.prototype, "connect").mockImplementation(async function (this: pg.Client) {
      clients.push(this);
      if (options.connectError) throw options.connectError;
    } as never);
    vi.spyOn(pg.Client.prototype, "query").mockImplementation((async (
      text: string,
      values?: unknown[],
    ) => {
      queries.push({ text, values });
      if (text === SET_IDLE_TIMEOUT) {
        if (options.setError) throw options.setError;
        return { rows: [] };
      }
      if (text.includes("pg_try_advisory_lock")) {
        return { rows: [{ locked: options.locked ?? true, pid: PID }] };
      }
      looks += 1;
      return { rows: [options.held ? await options.held(looks) : { held: true, pid: PID }] };
    }) as never);
    vi.spyOn(pg.Client.prototype, "end").mockImplementation(async function (this: pg.Client) {
      ended();
      this.emit("end");
    } as never);
    return { queries, clients, ended, looks: () => looks };
  }

  it("takes_the_lock_on_a_connection_of_its_own_and_lets_it_go_once", async () => {
    const { queries, ended } = fakeConnection();
    const lock = await tryAdvisoryLock(URL_OF_NONE, KEY, { checkEveryMs: 60_000 });
    expect(lock).not.toBeNull();
    // The session's idle timeout is set, the lock is taken, and at once seen to be held by the
    // session that took it.
    expect(queries.map((query) => query.values)).toEqual([
      undefined,
      [KEY.toString()],
      [KEY.toString()],
    ]);
    expect(queries[0]?.text).toBe(SET_IDLE_TIMEOUT);
    expect(queries[1]?.text).toBe(
      "select pg_try_advisory_lock($1::bigint) as locked, pg_backend_pid() as pid",
    );
    expect(queries[2]?.text).toContain("from pg_locks");
    expect(queries[2]?.text).toContain("pid = pg_backend_pid()");
    expect(lock?.lost.aborted).toBe(false);

    const releasing = lock?.release();
    expect(lock?.release()).toBe(releasing);
    await releasing;
    expect(ended).toHaveBeenCalledTimes(1);
    // The connection's end, which a release causes, is no loss.
    expect(lock?.lost.aborted).toBe(false);
  });

  it("sets_the_sessions_idle_timeout_and_says_nothing_when_the_server_takes_it", async () => {
    const { queries } = fakeConnection();
    const lines: string[] = [];
    const lock = await tryAdvisoryLock(URL_OF_NONE, KEY, {
      checkEveryMs: 60_000,
      log: (line) => lines.push(line),
    });
    expect(lock).not.toBeNull();
    expect(queries[0]?.text).toBe(SET_IDLE_TIMEOUT);
    expect(lines).toEqual([]);
    await lock?.release();
  });

  it("takes_the_lock_without_the_idle_timeout_when_the_server_refuses_it", async () => {
    // As a server before Postgres 14 answers: one statement fails, and the session goes on.
    const refused = Object.assign(
      new Error('unrecognized configuration parameter "idle_session_timeout"'),
      { severity: "ERROR", code: "42704" },
    );
    const { queries } = fakeConnection({ setError: refused });
    const lines: string[] = [];
    const lock = await tryAdvisoryLock(URL_OF_NONE, KEY, {
      checkEveryMs: 60_000,
      log: (line) => lines.push(line),
    });
    expect(lock).not.toBeNull();
    expect(lock?.lost.aborted).toBe(false);
    expect(queries.map((query) => query.text.split("\n")[0])).toEqual([
      SET_IDLE_TIMEOUT,
      "select pg_try_advisory_lock($1::bigint) as locked, pg_backend_pid() as pid",
      "select exists (",
    ]);
    // One WARN, which names the setting and the error's code, and nothing of the URL.
    expect(lines).toEqual([
      "WARN database: the server refused idle_session_timeout for the advisory lock's session " +
        "(Error 42704); the lock is taken without it, so a holder the server cannot reach keeps " +
        "it until the server finds the connection gone",
    ]);
    for (const part of ["tester", "secret", "localhost"]) {
      expect(lines.join("\n")).not.toContain(part);
    }
    await lock?.release();
  });

  it("fails_the_try_when_the_connection_fails_at_the_idle_timeout", async () => {
    // No severity: the server did not answer, the connection failed, and no lock is taken on it.
    const failed = new Error("Connection terminated unexpectedly");
    const { ended, queries } = fakeConnection({ setError: failed });
    const lines: string[] = [];
    await expect(
      tryAdvisoryLock(URL_OF_NONE, KEY, { log: (line) => lines.push(line) }),
    ).rejects.toBe(failed);
    expect(queries).toHaveLength(1);
    expect(lines).toEqual([]);
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it("is_null_when_another_session_holds_the_lock", async () => {
    const { ended, looks } = fakeConnection({ locked: false });
    expect(await tryAdvisoryLock(URL_OF_NONE, KEY)).toBeNull();
    expect(looks()).toBe(0);
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it("rejects_when_it_cannot_connect", async () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const { ended } = fakeConnection({ connectError: refused });
    await expect(tryAdvisoryLock(URL_OF_NONE, KEY)).rejects.toBe(refused);
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it("refuses_a_lock_that_its_session_does_not_hold", async () => {
    // As behind a pooler in transaction mode: the look at pg_locks runs on another session, or on
    // the same one after it lost the lock.
    for (const answer of [
      { held: true, pid: PID + 1 },
      { held: false, pid: PID },
    ]) {
      const { ended } = fakeConnection({ held: async () => answer });
      await expect(tryAdvisoryLock(URL_OF_NONE, KEY)).rejects.toBeInstanceOf(LockNotHeldError);
      expect(ended).toHaveBeenCalledTimes(1);
      vi.restoreAllMocks();
    }
  });

  it("keeps_the_lock_while_each_check_finds_it_held", async () => {
    const { looks } = fakeConnection();
    const lock = await tryAdvisoryLock(URL_OF_NONE, KEY, { checkEveryMs: 5 });
    if (lock === null) throw new Error("the lock was not taken");
    await vi.waitFor(() => expect(looks()).toBeGreaterThanOrEqual(5));
    expect(lock.lost.aborted).toBe(false);
    await lock.release();
  });

  it("loses_the_lock_when_its_session_no_longer_holds_it", async () => {
    // The first look is the one at once, the next ones the checks. The third check finds the lock
    // gone, or the connection on another session.
    for (const gone of [
      { held: false, pid: PID },
      { held: true, pid: PID + 1 },
    ]) {
      const { ended, looks } = fakeConnection({
        held: async (look) => (look === 4 ? gone : { held: true, pid: PID }),
      });
      const lock = await tryAdvisoryLock(URL_OF_NONE, KEY, { checkEveryMs: 5 });
      if (lock === null) throw new Error("the lock was not taken");
      await abortedWithin(lock.lost, 2_000);
      expect(lock.lost.reason).toBeInstanceOf(LockNotHeldError);
      // No check follows a loss, and nothing has closed the connection yet: that is release's.
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(looks()).toBe(4);
      expect(ended).not.toHaveBeenCalled();
      await lock.release();
      expect(ended).toHaveBeenCalledTimes(1);
      vi.restoreAllMocks();
    }
  });

  it("loses_the_lock_when_a_check_fails", async () => {
    const failure = new Error("Connection terminated unexpectedly");
    const { looks } = fakeConnection({
      held: async (look) => {
        if (look === 3) throw failure;
        return { held: true, pid: PID };
      },
    });
    const lock = await tryAdvisoryLock(URL_OF_NONE, KEY, { checkEveryMs: 5 });
    if (lock === null) throw new Error("the lock was not taken");
    await abortedWithin(lock.lost, 2_000);
    expect(lock.lost.reason).toBe(failure);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(looks()).toBe(3);
    await lock.release();
  });

  it("loses_the_lock_when_the_connection_fails_or_ends", async () => {
    for (const event of ["error", "end"] as const) {
      const { clients } = fakeConnection();
      const lock = await tryAdvisoryLock(URL_OF_NONE, KEY, { checkEveryMs: 60_000 });
      if (lock === null) throw new Error("the lock was not taken");
      const error = new Error("terminating connection due to administrator command");
      clients[0]?.emit(event, error);
      expect(lock.lost.aborted, event).toBe(true);
      expect(lock.lost.reason, event).toBeInstanceOf(Error);
      expect(lock.lost.reason, event).not.toBeInstanceOf(LockNotHeldError);
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

    // The server takes the session's idle timeout, as every Postgres from 14 on does, and the lock
    // is found on the session at once. The checks every 100 ms go on finding it there.
    const lines: string[] = [];
    const first = await tryAdvisoryLock(url, key, {
      checkEveryMs: 100,
      log: (line) => lines.push(line),
    });
    if (first === null) throw new Error("a free lock was not taken");
    expect(lines).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(first.lost.aborted).toBe(false);
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
