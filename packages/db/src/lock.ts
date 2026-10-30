import { Client } from "pg";

/**
 * A session-level advisory lock on a Postgres server. A session keeps such a lock until it lets it
 * go or ends, so the lock has a connection of its own, held for as long as the lock is wanted:
 * closing the connection lets the lock go, and losing it loses the lock.
 */
export interface SessionLock {
  /**
   * Aborts when the connection that holds the lock is lost: it failed, the server ended it, or it
   * did not answer a check in time. The server lets the lock go with the session, so another one
   * may take it: whatever the lock guards must stop, and then `release` this one.
   */
  readonly lost: AbortSignal;
  /** Lets the lock go and closes its connection. Calling it again does nothing more. */
  release(): Promise<void>;
}

export interface AdvisoryLockOptions {
  /** How often the connection is checked while it holds the lock, in milliseconds. Default 5 s. */
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
 * Tries once to take the session-level advisory lock `key` (`pg_try_advisory_lock`) on the
 * Postgres server at `url`, on a new connection, and does not wait for it. Resolves with the lock,
 * held until `release`, or with null when another session holds it. Rejects with the driver's
 * error when the server cannot be reached or refuses the connection; the driver's messages name
 * no password. The connection is closed in both of these cases.
 *
 * While the lock is held, the connection is checked with `select 1` every `checkEveryMs`. A check
 * that fails, or takes longer than `timeoutMs`, counts as losing it, as does any error or end of
 * the connection: a server that restarted has forgotten the session, and the lock with it, and a
 * client that is not talking to it would not hear of that.
 */
export async function tryAdvisoryLock(
  url: string,
  key: bigint,
  options: AdvisoryLockOptions = {},
): Promise<SessionLock | null> {
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
  });
  const lost = new AbortController();
  let releasing = false;
  const lose = () => {
    if (!releasing) lost.abort();
  };
  // Also what keeps an 'error' event from being raised as an uncaught exception, which would end
  // the process.
  client.on("error", lose);
  client.on("end", lose);
  const close = async () => {
    releasing = true;
    await client.end().catch(() => undefined);
  };

  try {
    await client.connect();
    const { rows } = await client.query<{ locked: boolean }>(
      "select pg_try_advisory_lock($1::bigint) as locked",
      [key.toString()],
    );
    if (rows[0]?.locked !== true) {
      await close();
      return null;
    }
  } catch (error) {
    await close();
    throw error;
  }

  const checkEveryMs = options.checkEveryMs ?? CHECK_EVERY_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = async () => {
    try {
      await client.query("select 1");
    } catch {
      lose();
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
