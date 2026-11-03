import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { mkdir, readFile, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { Pool, TypeOverrides, types } from "pg";

/**
 * The one database interface every Tender service codes against. PGlite and Postgres sit behind
 * it and hand back the same row shapes for every type the schema uses, so what a test proves on
 * one holds on the other.
 *
 * Reading: numeric and bigint columns arrive as exact decimal strings, never as JS numbers (a
 * u128 does not fit one). Still select them `::text`, so the query says what it returns, and
 * convert with `BigInt()`. int, float and boolean arrive as numbers and booleans, jsonb as
 * parsed JSON, timestamptz as `Date`, bytea as a plain `Uint8Array`.
 *
 * Errors from the database keep the message, the SQLSTATE `code` and the names that locate the
 * problem (`constraint`, `schema`, `table`, `column`, `dataType`, `position`, `routine`), on both
 * drivers. Everything else is dropped: `detail` (the failing row or the duplicate key, blob bytes
 * included), `where`, `hint`, `internalQuery`, and the statement and parameters PGlite adds. An
 * error is what gets logged, and a row can hold a held-out answer. The one thing that can still
 * quote data is the message of a value that fails to parse: `invalid input syntax for type
 * numeric: "abc"`.
 */
export interface Db {
  /**
   * Runs one statement and returns its rows. Parameters are `$1`, `$2`, …, bound as in
   * node-postgres, on both drivers:
   * - bigint is sent as exact decimal text, for numeric and bigint columns. A JS number is for
   *   floats and integers up to 2^53 - 1: a larger integer throws a RangeError instead of being
   *   rounded, as a parameter and inside a list or a JSON object, so ids and amounts are bigint
   *   or text;
   * - an array is a Postgres array, as in `col = any($1)`. For a jsonb column pass JSON text,
   *   `JSON.stringify(list)`: an array bound to jsonb is an error, as it is on Postgres;
   * - a plain object is sent as JSON text for a jsonb column (a bigint inside it is written as a
   *   decimal string);
   * - a Uint8Array (or any view of bytes) goes to a bytea column, and undefined means null.
   */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Runs one or more statements that take no parameters, such as a migration. */
  exec(sql: string): Promise<void>;
  /**
   * Runs `fn` in a transaction: it commits when `fn` returns and rolls back when `fn` throws.
   * Inside `fn`, use only the `tx` handle. On PGlite the outer `db` waits for this transaction
   * to end while `fn` waits for the outer `db`: a deadlock. On Postgres it would run on another
   * connection, outside the transaction.
   * On Postgres it runs at READ COMMITTED, whatever the server's `default_transaction_isolation`
   * is: the transactions of the services are written for that level, and at a stricter one they
   * would fail with a serialization failure (40001) when they meet.
   * The handle stops working when the transaction ends. Called on a handle, `tx` opens a
   * savepoint, so the inner work can fail and roll back on its own.
   */
  tx<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  /** Closes the database. Closing twice is fine. A transaction handle can not be closed. */
  close(): Promise<void>;
}

type Row = Record<string, unknown>;

/** One connection's worth of work: all that each driver has to provide. */
interface Session {
  /** One statement with parameters. */
  run(sql: string, params: unknown[]): Promise<Row[]>;
  /** One or more statements, no parameters. */
  script(sql: string): Promise<void>;
}

interface Backend extends Session {
  transaction<T>(fn: (session: Session) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// Postgres catalog OIDs of the types the two drivers treat differently.
const BYTEA = 17;
const INT8 = 20;
const JSON_TYPE = 114;
const JSONB = 3802;
const TEXT_ARRAY = 1009;
const INT8_ARRAY = 1016;
const NUMERIC = 1700;
const NUMERIC_ARRAY = 1231;

// pg's typings only know a list of common OIDs, which leaves out the array types.
type KnownOid = Parameters<typeof types.getTypeParser>[0];

// How long a caller waits for a pool connection, a new one or a free one, before it gets an error.
// Without a limit, a host that does not answer holds the caller for as long as the OS allows.
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Opens a database. `pglite:memory` is an in-memory PGlite, `pglite:<dir>` a PGlite that keeps
 * its files in that directory (created when missing), and `postgres://…` (or `postgresql://…`) a
 * Postgres server reached through a connection pool.
 *
 * A PGlite directory is one process's own: PGlite keeps no lock on it, and two processes that open
 * the same files corrupt them. So `openDb` takes a lock file in the directory (`tender.lock`) and
 * throws a `PgliteInUseError` while another process, or this one, has the directory open. The
 * holder renews the lock every 10 s (`PGLITE_LOCK_BEAT_MS`): the time the file was last touched is
 * the heartbeat. `close` lets the lock go, and so does a process that ends by itself or by
 * `process.exit`. A process that is killed leaves the lock, which counts as a leftover once it has
 * gone 30 s without a beat (`PGLITE_LOCK_STALE_MS`): the next open is refused until then, and takes
 * the directory over after. `options.pgliteLock` sets other times, for tests.
 */
export async function openDb(url: string, options: OpenDbOptions = {}): Promise<Db> {
  if (url === "pglite:memory") return openPglite();
  if (url === "pglite:")
    throw new Error("pglite: needs a directory, as in pglite:<dir>, or pglite:memory");
  if (url.startsWith("pglite:")) return openPglite(url.slice("pglite:".length), options.pgliteLock);
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) return openPostgres(url);
  // Only the scheme is named: a url can carry a password.
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1] ?? "none";
  throw new Error(
    `unsupported database url (scheme: ${scheme}); use pglite:memory, pglite:<dir> or postgres://…`,
  );
}

export interface OpenDbOptions {
  /** The times of the lock on a `pglite:<dir>` directory; the defaults suit a service. */
  pgliteLock?: Partial<PgliteLockTiming>;
}

async function openPglite(dir?: string, lock?: Partial<PgliteLockTiming>): Promise<Db> {
  const options = {
    // PGlite returns a small int8 as a number and a large one as a bigint. Postgres drivers
    // return text. Text everywhere, so a bigserial or bigint column has one shape.
    parsers: { [INT8]: (value: string) => value },
    serializers: { [JSON_TYPE]: jsonParam, [JSONB]: jsonParam },
  };
  if (dir === undefined) return makeDb(pgliteBackend(await PGlite.create(options)));
  // Before the directory is made: times that cannot work leave nothing behind.
  const timing = lockTiming(lock);
  await mkdir(dir, { recursive: true });
  const unlock = await lockPgliteDir(dir, timing);
  try {
    return makeDb(pgliteBackend(await PGlite.create(dir, options), unlock));
  } catch (error) {
    await unlock();
    throw error;
  }
}

// ---- The lock on a PGlite directory -----------------------------------------------------------

/**
 * The file in a PGlite directory that says a process has it open. PGlite ignores a file it does not
 * know, including when it makes the directory.
 */
const PGLITE_LOCK_FILE = "tender.lock";
/** How often the process that holds the lock on a PGlite directory touches its file. */
export const PGLITE_LOCK_BEAT_MS = 10_000;
/**
 * How long a lock file may go untouched before it counts as a leftover: three beats, so that a
 * beat or two can be late, as when the process is busy.
 */
export const PGLITE_LOCK_STALE_MS = 30_000;

/** How a lock is kept alive (`beatMs`) and when it counts as left over (`staleMs`). */
export interface PgliteLockTiming {
  beatMs: number;
  staleMs: number;
}

function lockTiming(over: Partial<PgliteLockTiming> = {}): PgliteLockTiming {
  const { beatMs = PGLITE_LOCK_BEAT_MS, staleMs = PGLITE_LOCK_STALE_MS } = over;
  if (!(Number.isFinite(beatMs) && beatMs > 0 && Number.isFinite(staleMs) && staleMs > beatMs)) {
    throw new RangeError("pgliteLock: beatMs must be above 0, and staleMs above beatMs");
  }
  return { beatMs, staleMs };
}

/** The most the lock file is looked at before the directory is given up as taken. */
const LOCK_ATTEMPTS = 3;
/** The PGlite directories this process has open, by real path. */
const pgliteDirsOpen = new Set<string>();
/** The lock files this process holds, by real path, with the text it wrote in each. */
const pgliteLocksHeld = new Map<string, { file: string; text: string }>();
let removesLocksAtExit = false;

/**
 * The directory of a `pglite:<dir>` database is open in another process, or already in this one.
 * The message names the directory, the process if the lock says which, and the file to delete if
 * that process is gone.
 */
export class PgliteInUseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PgliteInUseError";
  }
}

/** A lock file as it is now: its text, and when it was last touched. */
interface LockFile {
  text: string;
  touchedMs: number;
}

/** What `file` says and when it was touched, or undefined once it is gone. */
async function readLock(file: string): Promise<LockFile | undefined> {
  try {
    const touchedMs = (await stat(file)).mtimeMs;
    return { text: await readFile(file, "utf8"), touchedMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Who a lock file says holds it, for the message. Whether the lock is held is not read from this: a
 * pid comes back (a container that restarts runs under the same pids), so it says nothing about
 * whether its process lives. The host is only shown when it looks like a host name, since the file
 * is text from the disk.
 */
function holderOf(text: string): { pid: number; host: string } | undefined {
  try {
    const { pid, host } = JSON.parse(text) as { pid?: unknown; host?: unknown };
    if (!Number.isSafeInteger(pid) || (pid as number) < 1) return undefined;
    if (typeof host !== "string" || !/^[A-Za-z0-9._-]{1,253}$/.test(host)) return undefined;
    return { pid: pid as number, host };
  } catch {
    return undefined;
  }
}

/** Seconds with one decimal at most, as in `30` or `0.4`. */
const seconds = (ms: number) => String(Math.round(Math.max(0, ms) / 100) / 10);

/**
 * Takes the lock on the PGlite directory `dir`: a file made with the `wx` flag, which only one
 * process can make, holding a random token (so that the holder can tell its own file from another's),
 * its pid and its host. It returns the function that lets the lock go, which is safe to call twice
 * and leaves a lock that another process has taken since. Until then the file is touched every
 * `beatMs`.
 *
 * If the file is there already and was touched within `staleMs`, its holder lives and the
 * directory is its own: this throws a `PgliteInUseError`. A file that was not is a leftover of a
 * process that is gone, and is taken over, whatever pid it names. Two processes that take over the
 * same leftover in the same instant can both end up with the directory: the file is removed only if
 * it is still what was read, which leaves a window of microseconds.
 *
 * The beat runs on the event loop, so a process that does not return to it for `staleMs` (a query
 * that long, a loop that never yields) stops beating, and the next open takes the directory over
 * from under it. Nothing a process does to a directory it has lost can be undone, so it is not
 * tried: the beat stops, and the lock file is left to the new holder.
 */
async function lockPgliteDir(dir: string, timing: PgliteLockTiming): Promise<() => Promise<void>> {
  const key = await realpath(dir);
  const file = join(dir, PGLITE_LOCK_FILE);
  if (pgliteDirsOpen.has(key)) {
    throw new PgliteInUseError(
      `the PGlite directory ${dir} is open already in this process: close it before opening it again`,
    );
  }
  // Before anything else is awaited, so that two opens in this process cannot both pass.
  pgliteDirsOpen.add(key);
  const text = `${JSON.stringify({ token: randomUUID(), pid: process.pid, host: hostname() })}\n`;
  try {
    await claimLockFile(dir, file, text, timing.staleMs);
  } catch (error) {
    pgliteDirsOpen.delete(key);
    throw error;
  }
  pgliteLocksHeld.set(key, { file, text });
  removeLocksAtExit();
  const beat = keepLockFresh(file, text, timing.beatMs);
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      await beat.stop();
      if ((await readLock(file))?.text === text) await rm(file, { force: true });
    } catch {
      // A lock that stays goes stale and is taken over.
    } finally {
      pgliteLocksHeld.delete(key);
      pgliteDirsOpen.delete(key);
    }
  };
}

async function claimLockFile(
  dir: string,
  file: string,
  text: string,
  staleMs: number,
): Promise<void> {
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    try {
      await writeFile(file, text, { flag: "wx" });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const held = await readLock(file);
    if (held === undefined) continue;
    // A time in the future, from a clock that was set back, is not stale: the lock is refused, and
    // the message says how to clear it.
    const idleMs = Date.now() - held.touchedMs;
    if (idleMs <= staleMs) {
      const holder = holderOf(held.text);
      const who =
        holder === undefined ? "another process" : `process ${holder.pid} on ${holder.host}`;
      throw new PgliteInUseError(
        `the PGlite directory ${dir} is in use by ${who} (its lock was renewed ${seconds(idleMs)} s ` +
          `ago): only one process at a time opens it. Stop that process, or use another directory. ` +
          `A lock that goes ${seconds(staleMs)} s without a renewal is taken over, so if the process ` +
          `is gone, try again then; to take the directory now, delete ${file}`,
      );
    }
    // A leftover. Removed only if it is still the one that was read: another process may have taken
    // it over since, or its holder may have woken up and renewed it.
    const again = await readLock(file);
    if (again?.text === held.text && again.touchedMs === held.touchedMs) {
      await rm(file, { force: true });
    }
  }
  throw new PgliteInUseError(
    `the PGlite directory ${dir} is being taken by another process just now: try again`,
  );
}

/**
 * Touches `file` every `beatMs`, for as long as it still says `text`. A file that was deleted is put
 * back, unless another process has made one since; a file that says something else belongs to
 * another process, and the beat ends without touching it. A beat that fails is tried again at the
 * next. The timer does not keep the process alive. `stop` returns once no beat is under way, so that
 * none can put a lock back after the holder has removed it.
 */
function keepLockFresh(file: string, text: string, beatMs: number): { stop(): Promise<void> } {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let beating: Promise<void> = Promise.resolve();
  const renew = async () => {
    const found = await readLock(file);
    if (stopped) return;
    if (found === undefined) {
      await writeFile(file, text, { flag: "wx" });
    } else if (found.text !== text) {
      stopped = true;
    } else {
      const now = new Date();
      await utimes(file, now, now);
    }
  };
  const schedule = () => {
    timer = setTimeout(() => {
      beating = renew()
        .catch(() => undefined)
        .then(() => {
          if (!stopped) schedule();
        });
    }, beatMs);
    timer.unref();
  };
  schedule();
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await beating;
    },
  };
}

/**
 * Removes the lock files this process still holds when it ends, as `process.exit` or the end of
 * its work do: a lock left behind would turn the next start away until it went stale. A signal that
 * ends the process without a handler runs nothing, and neither does a kill.
 */
function removeLocksAtExit(): void {
  if (removesLocksAtExit) return;
  removesLocksAtExit = true;
  process.on("exit", () => {
    for (const { file, text } of pgliteLocksHeld.values()) {
      try {
        if (readFileSync(file, "utf8") === text) rmSync(file, { force: true });
      } catch {
        // It goes stale, and is taken over.
      }
    }
  });
}

async function openPostgres(url: string): Promise<Db> {
  // This pool's own parsers; the process-wide ones are left alone. Where PGlite hands out exact text
  // or a plain Uint8Array, so does this pool, whatever else in the process has done to pg's parsers:
  // - int8, int8[], numeric and numeric[] are text. pg does that by default for the first three, but
  //   its switch `defaults.parseInt8` turns int8 and int8[] into JS numbers for every pool without
  //   parsers of its own, and its numeric[] parser reads the elements into floats, losing digits.
  // - bytea is a plain Uint8Array copy; pg gives a Buffer.
  const parseBytea = types.getTypeParser(BYTEA);
  const parseTextArray = types.getTypeParser(TEXT_ARRAY as number as KnownOid);
  const asText = (text: string) => text;
  const parsers = new TypeOverrides();
  parsers.setTypeParser(BYTEA, (text: string) => new Uint8Array(parseBytea(text) as Uint8Array));
  parsers.setTypeParser(INT8, asText);
  parsers.setTypeParser(INT8_ARRAY, parseTextArray);
  parsers.setTypeParser(NUMERIC, asText);
  parsers.setTypeParser(NUMERIC_ARRAY, parseTextArray);
  const pool = new Pool({
    connectionString: url,
    types: parsers,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  // An idle connection can fail (server restart, network). Without a listener Node would treat
  // the pool's 'error' event as uncaught and exit; the pool replaces the connection itself.
  pool.on("error", (error) => {
    console.error(`database: idle connection failed: ${error.message}`);
  });
  try {
    // Fail here, with the real reason, rather than on the first query somewhere else.
    await pool.query("select 1");
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
  return makeDb(postgresBackend(pool));
}

interface PgliteTarget {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
}

/**
 * PGlite picks how to bind a parameter from the column's type, so it would quietly accept an
 * array for a jsonb column, where node-postgres sends a Postgres array literal that jsonb rejects.
 * Refuse it here, so the mistake fails in a PGlite test just as it fails on Postgres.
 */
function jsonParam(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    throw new TypeError("a jsonb parameter must be JSON text: pass JSON.stringify(array)");
  }
  return JSON.stringify(value, exactJson);
}

/** JSON.stringify replacer: a bigint is written as a decimal string; a rounded integer is refused. */
function exactJson(_key: string, value: unknown): unknown {
  assertNotRounded(value, "a number in a JSON parameter");
  return typeof value === "bigint" ? value.toString() : value;
}

// The fields of a database error that say what went wrong and where, without quoting data. Postgres
// quotes the failing row or the duplicate key in `detail`, a JSON or COPY line in `where`, and now
// and then a value in `hint` or `internalQuery`; PGlite adds the statement, its parameters and the
// call options. A row can hold blob bytes or a held-out answer, and an error is what gets logged, so
// every other field goes.
const ERROR_FIELDS_KEPT = new Set([
  "name",
  "severity",
  "code",
  "schema",
  "table",
  "column",
  "dataType",
  "constraint",
  "position",
  "routine",
]);

/**
 * Takes the row data off an error that came from the database, in place, and returns it. The
 * message and the fields above stay. An error that did not come from the database is left as it is:
 * a network error has a `code` too (ECONNRESET), but no `severity`, and keeps its errno and syscall.
 */
function withoutRowData(error: unknown): unknown {
  if (typeof error !== "object" || error === null) return error;
  const { severity, code } = error as { severity?: unknown; code?: unknown };
  if (typeof severity === "string" && typeof code === "string") {
    for (const key of Object.keys(error)) {
      if (!ERROR_FIELDS_KEPT.has(key)) Reflect.deleteProperty(error, key);
    }
  }
  return error;
}

/** Runs `work`; a database error it throws goes on without its row data. */
async function scrubbed<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw withoutRowData(error);
  }
}

/** `unlock` lets the lock on the PGlite directory go, once PGlite is closed. */
function pgliteBackend(pglite: PGlite, unlock?: () => Promise<void>): Backend {
  const sessionOn = (target: PgliteTarget): Session => ({
    run: (sql, params) => scrubbed(async () => (await target.query<Row>(sql, params)).rows),
    script: (sql) =>
      scrubbed(async () => {
        await target.exec(sql);
      }),
  });
  return {
    ...sessionOn(pglite),
    transaction: (fn) => scrubbed(() => pglite.transaction((tx) => fn(sessionOn(tx)))),
    close: async () => {
      try {
        await pglite.close();
      } finally {
        await unlock?.();
      }
    },
  };
}

interface PgTarget {
  query(
    config: string | { text: string; values?: unknown[]; queryMode?: "extended" },
  ): Promise<{ rows: Row[] }>;
}

function postgresBackend(pool: Pool): Backend {
  const sessionOn = (target: PgTarget): Session => ({
    // The extended protocol takes exactly one statement, as PGlite's query does; without it pg
    // would run several statements sent with no parameters and return a list of results.
    run: (sql, params) =>
      scrubbed(
        async () => (await target.query({ text: sql, values: params, queryMode: "extended" })).rows,
      ),
    script: (sql) =>
      scrubbed(async () => {
        await target.query(sql);
      }),
  });
  return {
    ...sessionOn(pool),
    async transaction(fn) {
      const client = await pool.connect();
      // pg-pool takes its own 'error' listener off a client while it is checked out and puts it back
      // on release. If the connection drops in between, pg emits 'error' on a client nobody listens
      // to, and Node raises that as an uncaught exception, which ends the process. This listener
      // only has to exist. The transaction still fails by itself: the statement that is running, the
      // next one or the commit at the latest rejects on a dead client, and the client is then
      // released as broken.
      const ignoreLostConnection = () => undefined;
      client.on("error", ignoreLostConnection);
      let broken = false;
      const session = sessionOn(client);
      try {
        // READ COMMITTED whatever the server's default is: see `Db.tx`.
        await session.script("begin isolation level read committed");
        const result = await fn(session);
        await session.script("commit");
        return result;
      } catch (error) {
        try {
          await session.script("rollback");
        } catch {
          // Not even that works, so the connection is dead; report the original error.
          broken = true;
        }
        throw error;
      } finally {
        // Off again before the client goes back: the pool reuses it, and a listener per transaction
        // would pile up on it.
        client.off("error", ignoreLostConnection);
        // Releasing with true makes the pool discard the connection instead of reusing it.
        client.release(broken);
      }
    },
    close: () => pool.end(),
  };
}

function makeDb(backend: Backend): Db {
  let closing: Promise<void> | undefined;
  return {
    query: async <T = Row>(sql: string, params: unknown[] = []) =>
      (await backend.run(sql, params.map(toParam))) as T[],
    exec: (sql) => backend.script(sql),
    tx: (fn) =>
      backend.transaction(async (session) => {
        const handle = transactionDb(session, { savepoints: 0 });
        try {
          return await fn(handle.db);
        } finally {
          handle.end();
        }
      }),
    close: () => {
      closing ??= backend.close();
      return closing;
    },
  };
}

/** A `Db` bound to one open transaction. `end()` kills it, so a stray reference fails loudly. */
function transactionDb(session: Session, counter: { savepoints: number }) {
  let open = true;
  const assertOpen = () => {
    if (!open) throw new Error("transaction is closed");
  };
  const db: Db = {
    query: async <T = Row>(sql: string, params: unknown[] = []) => {
      assertOpen();
      return (await session.run(sql, params.map(toParam))) as T[];
    },
    exec: async (sql) => {
      assertOpen();
      await session.script(sql);
    },
    tx: async <T>(fn: (tx: Db) => Promise<T>) => {
      assertOpen();
      const savepoint = `tender_sp_${++counter.savepoints}`;
      await session.script(`savepoint ${savepoint}`);
      const inner = transactionDb(session, counter);
      let result: T;
      try {
        result = await fn(inner.db);
      } catch (error) {
        try {
          await session.script(`rollback to savepoint ${savepoint}`);
          await session.script(`release savepoint ${savepoint}`);
        } catch {
          // The connection is gone; the error worth reporting is the original one.
        }
        throw error;
      } finally {
        inner.end();
      }
      await session.script(`release savepoint ${savepoint}`);
      return result;
    },
    close: async () => {
      throw new Error("a transaction handle can not be closed");
    },
  };
  return {
    db,
    end() {
      open = false;
    },
  };
}

/**
 * Refuses an integer that a JS number cannot hold exactly (beyond 2^53 - 1). Its low digits are
 * already gone by the time it gets here, so sending it would store a different number without a
 * word. Floats and the integers a number does hold pass; so does anything that is not a number.
 */
function assertNotRounded(value: unknown, where: string): void {
  if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) {
    throw new RangeError(
      `${where} is an integer beyond 2^53 - 1, which a JS number rounds; pass a bigint or decimal text`,
    );
  }
  if (Array.isArray(value)) for (const item of value) assertNotRounded(item, where);
}

/**
 * Maps a JS value to something both drivers bind the same way. Strings, numbers, booleans, null,
 * dates, byte arrays and arrays go as they are (node-postgres binds an array as a Postgres
 * array, PGlite by the column's type), except that an integer a number cannot hold exactly is
 * refused, as a value or inside an array or a JSON object. bigint becomes decimal text, because a
 * JSON object with a bigint inside would otherwise throw; other byte views become a Uint8Array;
 * and a plain object becomes JSON text, with any bigint inside it as a decimal string.
 */
function toParam(value: unknown, index: number): unknown {
  if (value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  assertNotRounded(value, `parameter $${index + 1}`);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date || value instanceof Uint8Array || Array.isArray(value)) return value;
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return JSON.stringify(value, exactJson);
}
