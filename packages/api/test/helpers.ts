import { type Db, migrate, openDb } from "@tender/db";
import { FIXTURE_CONTRACT } from "@tender/indexer/testing";
import type { ApiDeps, ChainReader } from "../src/deps";

// Shared by every test of the API. `testDeps()` is the one place that says what a test app is made
// of; `seedLifecycle(db)`, from the indexer's fixtures, fills the database with a finished task.

export { seedLifecycle } from "@tender/indexer/testing";

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
 * The deps of a test app: a migrated in-memory PGlite (or `overrides.db`, which must be migrated),
 * a fake chain, the sandbox network, the fixtures' contract, no team accounts and a clock fixed at
 * `TEST_NOW`. `overrides` replaces any of them. Close `deps.db` when the test file is done.
 */
export async function testDeps(overrides: Partial<ApiDeps> = {}): Promise<ApiDeps> {
  let db = overrides.db;
  if (!db) {
    db = await openDb("pglite:memory");
    await migrate(db);
  }
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
  "working",
  "auth_challenges",
  "auth_tokens",
  "tg_links",
  "tg_link_nonces",
  "tg_watches",
  "tg_sent",
  "worker_cursor",
];

/** Empties every table, so one database can serve a whole test file. */
export async function resetDb(db: Db): Promise<void> {
  await db.exec(`truncate ${TABLES.join(", ")} restart identity`);
}
