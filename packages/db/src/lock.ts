import { Client } from "pg";

/**
 * A session-level advisory lock on a Postgres server. A session keeps such a lock until it lets it
 * go or ends, so the lock has a connection of its own, held for as long as the lock is wanted:
 * closing the connection lets the lock go, and losing it loses the lock.
 *
 * So it needs one server session for the life of its connection: a direct connection, or a pooler
 * in session mode. A pooler in transaction mode (PgBouncer or Supavisor in that mode, Neon's
 * `-pooler` hosts) runs each statement on whichever session is free. The lock would stay with a
 * session this connection no longer has, which other clients could then take it again on. The lock
 * checks the session it is on, and fails when that happens (`LockNotHeldError`).
 */
export interface SessionLock {
  /**
   * Aborts when the lock may no longer be held, with the reason: the connection's error, or an
   * error saying it ended, when it failed, ended or did not answer a check in time; a
   * `LockNotHeldError` when the session it is on does not hold the lock. The server lets the lock
   * go with the session, so another may take it: whatever the lock guards must stop, and then
   * `release` this one.
   */
  readonly lost: AbortSignal;
  /** Lets the lock go and closes its connection. Calling it again does nothing more. */
  release(): Promise<void>;
}

/**
 * The lock's connection is on a session that does not hold the lock, or not on the session that
 * took it: what a pooler in transaction mode does. The message says so, and names no value.
 */
export class LockNotHeldError extends Error {
  constructor() {
    super(
      "the database session of the advisory lock does not hold it, as happens behind a pooler " +
        "in transaction mode: connect to the server directly, or through a pooler in session mode",
    );
    this.name = "LockNotHeldError";
  }
}

export interface AdvisoryLockOptions {
  /** How often the lock is checked while it is held, in milliseconds. Default 5 s. */
  checkEveryMs?: number;
  /**
   * How long the connection may take to connect, or to answer a query, before it counts as lost,
   * in milliseconds. Default 10 s.
   */
  timeoutMs?: number;
}

const CHECK_EVERY_MS = 5_000;
const TIMEOUT_MS = 10_000;

/**
 * What the server is told at connect: to end the lock's session once it has been idle for 30 s.
 * A holder checks its lock every 5 s, so only one that has gone silent, such as one on the far side
 * of a network partition, is ended, and its lock let go, rather than after the hours that TCP
 * takes to notice. It has stopped what the lock guards by then: its own checks fail within 15 s.
 */
const IDLE_SESSION_TIMEOUT = "-c idle_session_timeout=30s";

/**
 * Whether the session holds advisory lock `$1`, and which session it is. The server keeps a bigint
 * key as two halves, the high one in `classid` and the low one in `objid`, with `objsubid` 1.
 */
const HELD = `select exists (
    select 1 from pg_locks
     where locktype = 'advisory' and granted and pid = pg_backend_pid()
       and classid = ($1::bigint >> 32)::oid
       and objid = ($1::bigint & 4294967295)::oid
       and objsubid = 1
  ) as held, pg_backend_pid() as pid`;

/**
 * The connection settings of the lock's client: `url`, with `IDLE_SESSION_TIMEOUT` after whatever
 * `options` the URL has, since the URL's own `options` would replace a client's.
 */
function connectionOf(url: string): { connectionString: string; options?: string } {
  const parsed = URL.parse(url);
  // A URL that does not parse here has no `options` that could be read and kept.
  if (parsed === null) return { connectionString: url, options: IDLE_SESSION_TIMEOUT };
  const options = parsed.searchParams.get("options");
  parsed.searchParams.set(
    "options",
    options === null ? IDLE_SESSION_TIMEOUT : `${options} ${IDLE_SESSION_TIMEOUT}`,
  );
  return { connectionString: parsed.toString() };
}

/**
 * Tries once to take the session-level advisory lock `key` (`pg_try_advisory_lock`) on the
 * Postgres server at `url`, on a new connection, and does not wait for it. Resolves with the lock,
 * held until `release`, or with null when another session holds it. Rejects with the driver's
 * error when the server cannot be reached or refuses the connection (the driver's messages name no
 * password), and with a `LockNotHeldError` when the lock, once taken, is not on the connection's
 * session. The connection is closed in each of these cases.
 *
 * The server ends the session once it has been idle for 30 s (`idle_session_timeout`, Postgres 14
 * and later). While the lock is held it is checked every `checkEveryMs`: the session must still be
 * the one that took the lock, and hold it. A check that fails, or takes longer than `timeoutMs`,
 * counts as losing the lock, as does any error or end of the connection, since a server that
 * restarted has forgotten the session without a word to a client that is not talking to it.
 */
export async function tryAdvisoryLock(
  url: string,
  key: bigint,
  options: AdvisoryLockOptions = {},
): Promise<SessionLock | null> {
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const client = new Client({
    ...connectionOf(url),
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
  });
  const lost = new AbortController();
  let releasing = false;
  const lose = (reason: unknown) => {
    if (!releasing && !lost.signal.aborted) lost.abort(reason);
  };
  // Also what keeps an 'error' event from being raised as an uncaught exception, which would end
  // the process.
  client.on("error", lose);
  client.on("end", () => lose(new Error("the connection of the advisory lock ended")));
  const close = async () => {
    releasing = true;
    await client.end().catch(() => undefined);
  };
  /** Whether the connection is still on session `pid`, and that session holds the lock. */
  const holds = async (pid: number) => {
    const { rows } = await client.query<{ held: boolean; pid: number }>(HELD, [key.toString()]);
    return rows[0]?.held === true && rows[0].pid === pid;
  };

  let pid: number;
  try {
    await client.connect();
    const { rows } = await client.query<{ locked: boolean; pid: number }>(
      "select pg_try_advisory_lock($1::bigint) as locked, pg_backend_pid() as pid",
      [key.toString()],
    );
    const [row] = rows;
    if (row?.locked !== true) {
      await close();
      return null;
    }
    pid = row.pid;
    // At once, not only at the first check: behind a pooler in transaction mode the next statement
    // may run on another session already.
    if (!(await holds(pid))) throw new LockNotHeldError();
  } catch (error) {
    await close();
    throw error;
  }

  const checkEveryMs = options.checkEveryMs ?? CHECK_EVERY_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = async () => {
    try {
      if (!(await holds(pid))) lose(new LockNotHeldError());
    } catch (error) {
      lose(error);
    }
    if (!releasing && !lost.signal.aborted) timer = setTimeout(check, checkEveryMs);
  };
  timer = setTimeout(check, checkEveryMs);
  lost.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });

  let released: Promise<void> | undefined;
  return {
    lost: lost.signal,
    release() {
      released ??= (async () => {
        clearTimeout(timer);
        await close();
      })();
      return released;
    },
  };
}
