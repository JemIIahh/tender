import { randomBytes } from "node:crypto";
import { type Db, migrate, openDb } from "@tender/db";
import { FIXTURE_CONTRACT } from "@tender/indexer/testing";
import type { ApiDeps, ChainReader } from "../src/deps";

// Shared by every test of the API. `testDeps()` is the one place that says what a test app is made
// of; `seedLifecycle(db)`, from the indexer's fixtures, fills the database with a finished task.

export { seedLifecycle } from "@tender/indexer/testing";

/**
 * `TEST_DATABASE_URL`: a Postgres server for the tests (CI has one), which `testDb` uses in place
 * of PGlite when it is set. It must be a direct connection, not a transaction pooler: each test
 * database is a schema of its own, which the `options` startup parameter makes the search path.
 */
const POSTGRES_URL = process.env.TEST_DATABASE_URL || undefined;

/**
 * A migrated, empty database for a test file: an in-memory PGlite, or, with `TEST_DATABASE_URL`
 * set, a new schema on that server, which `close` drops. `postgres: false` asks for PGlite
 * whatever is set, for a test that counts the timers it fakes: pg's pool sets a timer for each
 * connection it takes back. Close it when the test file is done.
 */
export async function testDb(options: { postgres?: boolean } = {}): Promise<Db> {
  const db =
    POSTGRES_URL !== undefined && options.postgres !== false
      ? await postgresSchema(POSTGRES_URL)
      : await openDb("pglite:memory");
  try {
    await migrate(db);
  } catch (error) {
    await db.close();
    throw error;
  }
  return db;
}

/**
 * A database in a new schema of the server at `url`. `close` drops the schema and ends the pool.
 * The schema is made over a pool of its own, which is ended as soon as the database is open: the
 * server takes only so many connections, and every test file holds a database at once.
 */
async function postgresSchema(url: string): Promise<Db> {
  const schema = `api_${randomBytes(6).toString("hex")}`;
  const admin = await openDb(url);
  let db: Db;
  try {
    await admin.exec(`create schema ${schema}`);
    const scoped = new URL(url);
    scoped.searchParams.set("options", `-c search_path=${schema}`);
    db = await openDb(scoped.toString()).catch(async (error: unknown) => {
      await admin.exec(`drop schema ${schema} cascade`).catch(() => undefined);
      throw error;
    });
  } finally {
    await admin.close();
  }
  let closed: Promise<void> | undefined;
  return {
    ...db,
    close() {
      // A connection may drop the schema it works in; the pool is ended whatever the drop did.
      closed ??= db.exec(`drop schema ${schema} cascade`).finally(() => db.close());
      return closed;
    },
  };
}

/**
 * The time every test app runs at unless a test sets its own: 30 seconds after the lifecycle
 * task's `created_at`, so a task with the captured deadlines is still in its commit window.
 */
export const TEST_NOW = 1_793_307_200_000_000_000n;

/** The final block height of the fake chain. */
export const TEST_FINAL_HEIGHT = 100n;

/**
 * A chain reader that answers without a chain: the final height is `TEST_FINAL_HEIGHT` and every
 * access key is a full-access one. Pass `over` to change either.
 */
export function fakeClient(over: Partial<ChainReader> = {}): ChainReader {
  return {
    finalHeight: async () => TEST_FINAL_HEIGHT,
    viewAccessKey: async () => ({ permission: "FullAccess" }),
    ...over,
  };
}

/**
 * The deps of a test app: a database from `testDb` (or `overrides.db`, which must be migrated), a
 * fake chain, the sandbox network, the fixtures' contract, no team accounts and a clock fixed at
 * `TEST_NOW`. `overrides` replaces any of them. Close `deps.db` when the test file is done.
 */
export async function testDeps(overrides: Partial<ApiDeps> = {}): Promise<ApiDeps> {
  const db = overrides.db ?? (await testDb());
  return {
    client: fakeClient(),
    network: "sandbox",
    contractId: FIXTURE_CONTRACT,
    publicUrl: "http://api.test",
    teamAccounts: [],
    webOrigins: [],
    now: () => TEST_NOW,
    ...overrides,
    db,
  };
}

const TABLES = [
  "chain_cursor",
  "events",
  "tasks",
  "funders",
  "entries",
  "agents",
  "blobs",
  "result_uploads",
  "heldout_uploads",
  "working",
  "task_questions",
  "auth_challenges",
  "auth_tokens",
  "tg_links",
  "tg_link_nonces",
  "tg_watches",
  "tg_sent",
  "worker_cursor",
  "connect_codes",
];

/** Empties every table, so one database can serve a whole test file. */
export async function resetDb(db: Db): Promise<void> {
  await db.exec(`truncate ${TABLES.join(", ")} restart identity`);
}
