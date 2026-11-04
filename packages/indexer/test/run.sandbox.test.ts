import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type LocalChain,
  type LocalRole,
  registerLocalAgent,
  startLocalChain,
  TenderClient,
} from "@tender/client";
import { type Db, migrate, openDb } from "@tender/db";
import { computeCommitment, randomSalt, sha256Hex } from "@tender/shared";
import { afterAll, beforeAll, expect, test } from "vitest";
import { runSkeleton } from "../../../scripts/skeleton";
import { reconcile, startIndexer } from "../src/index";

// One local chain for the file, used by the tests one after another. Each test indexes it into a
// PGlite database of its own, with the indexer as `pnpm serve` starts it: the RPC source on the
// sandbox, from the chain's final height when nothing says where to start. The skeleton
// (scripts/skeleton.ts) runs a whole task on the chain in about 30 s: a deposit, a post, two
// commits, two reveals, a pick and a withdrawal. The sandbox prunes its oldest blocks after a
// minute or two, so no test leaves an indexer stopped for long.

let chain: LocalChain;
/** Reads the chain's views, as reconcile does. */
let reader: TenderClient;
/** No deployment record is in it, so that nothing in the repository picks the start height. */
let deploymentsDir: string;
const databases: Db[] = [];

beforeAll(async () => {
  chain = await startLocalChain();
  reader = new TenderClient({
    network: chain.network,
    contractId: chain.contractId,
    rpcUrl: chain.rpcUrl,
  });
  deploymentsDir = await mkdtemp(join(tmpdir(), "tender-indexer-"));
});

afterAll(async () => {
  await Promise.all(databases.map((db) => db.close()));
  await chain?.stop();
  if (deploymentsDir) await rm(deploymentsDir, { recursive: true, force: true });
});

async function freshDb(): Promise<Db> {
  const db = await openDb("pglite:memory");
  await migrate(db);
  databases.push(db);
  return db;
}

/** What `pnpm serve` gives the indexer for this chain. */
function env(): Record<string, string> {
  return {
    TENDER_NETWORK: "sandbox",
    TENDER_CONTRACT: chain.contractId,
    NEAR_RPC_URL: chain.rpcUrl,
    INDEXER_POLL_MS: "100",
  };
}

function start(db: Db, lines: string[]) {
  return startIndexer(env(), { db, deploymentsDir, log: (line) => lines.push(line) });
}

const clientOf = (role: LocalRole) =>
  new TenderClient({
    network: chain.network,
    contractId: chain.contractId,
    rpcUrl: chain.rpcUrl,
    signer: chain.accounts[role],
  });

/** The height of the last block the index applied, or null before the first. */
async function indexedHeight(db: Db): Promise<bigint | null> {
  const [row] = await db.query<{ height: string }>(
    "select height::text as height from chain_cursor where source = $1",
    [`sandbox:${chain.contractId}`],
  );
  return row ? BigInt(row.height) : null;
}

/** Waits until `check` holds, looking every 100 ms, and fails the test after `ms`. */
async function until(what: string, check: () => Promise<boolean>, ms = 60_000): Promise<void> {
  const giveUpAt = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > giveUpAt) throw new Error(`timed out waiting until ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const started = (db: Db) =>
  until("the indexer applies its first block", async () => (await indexedHeight(db)) !== null);

/** Waits until the index holds every block up to the chain's final height as of now. */
async function caughtUp(db: Db): Promise<void> {
  const final = await reader.finalHeight();
  await until(`the index reaches block ${final}`, async () => {
    const height = await indexedHeight(db);
    return height !== null && height >= final;
  });
}

interface TaskRow {
  commit_count: number;
  reveal_count: number;
  outcome: Record<string, unknown> | null;
  settled: boolean;
}

async function taskRow(db: Db, id: bigint): Promise<TaskRow | undefined> {
  const [row] = await db.query<TaskRow>(
    `select commit_count, reveal_count, outcome, outcome is not null as settled
       from tasks where id = $1`,
    [id],
  );
  return row;
}

/** The task's entries, in the shape of the chain's `get_entries`. */
async function entriesOf(db: Db, taskId: bigint) {
  return db.query(
    `select task_id::text as task_id, account, entry_index as index, commitment,
            committed_height::text as committed_at_block, content_hash, uri
       from entries where task_id = $1 order by entry_index`,
    [taskId],
  );
}

async function fundersOf(db: Db, taskId: bigint) {
  return db.query(
    "select account, amount::text as amount from funders where task_id = $1 order by account",
    [taskId],
  );
}

/** How many of each event the index holds for the task. */
async function eventCounts(db: Db, taskId: bigint): Promise<Record<string, number>> {
  const rows = await db.query<{ event: string; n: number }>(
    "select event, count(*)::int as n from events where task_id = $1 group by event",
    [taskId],
  );
  return Object.fromEntries(rows.map((row) => [row.event, row.n]));
}

/** The view's outcome, which has no `by`, as the index stores it from the event, which does. */
function outcomeFromEvent(taskId: bigint, outcome: unknown, by: string) {
  return { ...(outcome as object), task_id: `${taskId}`, by };
}

const warnings = (lines: string[]) => lines.filter((line) => line.startsWith("WARN"));

test("indexer_follows_local_chain_end_to_end", async () => {
  const db = await freshDb();
  const lines: string[] = [];
  const indexer = start(db, lines);
  try {
    await started(db);
    const { taskId } = await runSkeleton({ network: "sandbox", chain, log: () => undefined });
    await caughtUp(db);

    const view = await reader.getTask(taskId);
    if (view === null) throw new Error(`task ${taskId} is not on the chain`);
    expect(view.outcome?.kind).toBe("picked");
    const row = await taskRow(db, taskId);
    expect(row).toMatchObject({ commit_count: 2, reveal_count: 2, settled: true });
    expect(row?.outcome).toEqual(
      outcomeFromEvent(taskId, view.outcome, chain.accounts.judge.accountId),
    );

    // Both entries are revealed, as the chain has them, in its entrant order. Alice and bob commit
    // side by side, so either can come first.
    const entries = await entriesOf(db, taskId);
    expect(entries).toEqual(await reader.getAllEntries(taskId));
    expect(entries.map((entry) => entry.uri).sort()).toEqual([
      `skeleton://${chain.accounts.alice.accountId}`,
      `skeleton://${chain.accounts.bob.accountId}`,
    ]);
    expect(await fundersOf(db, taskId)).toEqual(view.funders);

    // Nothing said where to start, so it started at the chain's final height, and said so.
    expect(lines.filter((line) => line.includes("starting at the sandbox's final height"))).toEqual(
      [expect.stringMatching(/height \d+$/)],
    );
    expect(warnings(lines)).toEqual([]);
  } finally {
    await indexer.stop();
  }
});

test("restart_resumes_from_cursor_without_duplicates", async () => {
  const db = await freshDb();
  const lines: string[] = [];
  let indexer = start(db, lines);

  // Stopped once both entries are committed, and started again once both are revealed: the reveals
  // run on a chain that nothing indexes, and the second start has to go back for them.
  let stopping: Promise<void> | undefined;
  let restarting: Promise<void> | undefined;
  try {
    await started(db);
    const { taskId } = await runSkeleton({
      network: "sandbox",
      chain,
      log: (line) => {
        if (line.startsWith("COMMITTED")) stopping = indexer.stop();
        if (line.startsWith("REVEALED")) {
          restarting = stopping?.then(() => {
            indexer = start(db, lines);
          });
        }
      },
    });
    expect(stopping).toBeDefined();
    expect(restarting).toBeDefined();
    await restarting;
    await caughtUp(db);

    const view = await reader.getTask(taskId);
    if (view === null) throw new Error(`task ${taskId} is not on the chain`);
    const row = await taskRow(db, taskId);
    expect(row).toMatchObject({
      commit_count: view.commit_count,
      reveal_count: view.reveal_count,
      settled: true,
    });
    expect(row?.outcome).toEqual(
      outcomeFromEvent(taskId, view.outcome, chain.accounts.judge.accountId),
    );
    expect(await entriesOf(db, taskId)).toEqual(await reader.getAllEntries(taskId));
    expect(await fundersOf(db, taskId)).toEqual(view.funders);
    // Each event once, though the indexer stopped and started in the middle of them.
    expect(await eventCounts(db, taskId)).toEqual({
      task_created: 1,
      committed: view.commit_count,
      revealed: view.reveal_count,
      picked: 1,
    });

    // The index holds as many tasks as the chain: one that came before the first start, if an
    // earlier test made it, is filled in by the reconcile that runs at start.
    const [tasks] = await db.query<{ n: string }>("select count(*)::text as n from tasks");
    expect(BigInt(tasks?.n ?? "-1")).toBe(await reader.taskCount());

    // The first start began at the final height; the second resumed after the cursor.
    expect(lines.filter((line) => line.includes("starting at the sandbox's final height"))).toEqual(
      [expect.any(String)],
    );
    expect(lines.filter((line) => line.includes("resuming after block"))).toEqual([
      expect.any(String),
    ]);
    // Reconcile only ever inserted what came before the first start, and repaired nothing.
    expect(warnings(lines).filter((line) => !line.endsWith("inserted from the chain"))).toEqual([]);
  } finally {
    // Whichever indexer is the latest, once a restart under way has made it.
    await restarting?.catch(() => undefined);
    await indexer.stop();
  }
});

test("reconcile_repairs_missing_task", async () => {
  const db = await freshDb();
  const lines: string[] = [];
  const indexer = start(db, lines);
  try {
    await started(db);

    // A task in its commit window, entered by the lead, a registered agent. The lead is not an
    // entrant of the skeleton run that the tests before this one make: alice and bob are, and
    // registered with a bond then, so their records already count those entries, and a record that
    // starts here counts only this one.
    const poster = clientOf("poster");
    const lead = clientOf("lead");
    const leadId = chain.accounts.lead.accountId;
    const reward = 1_000_000n;
    await poster.deposit(chain.tokenId, reward);
    await registerLocalAgent(chain, "lead", ["extraction"]);
    const { taskId } = await poster.postTask({
      token: chain.tokenId,
      reward,
      briefUri: "ipfs://brief",
      briefHash: sha256Hex("brief"),
      criteriaHash: sha256Hex("criteria"),
      verifier: chain.accounts.judge.accountId,
      commitSecs: 120,
      revealSecs: 120,
      pickSecs: 120,
      fallbackSecs: 120,
    });
    await lead.commit(taskId, computeCommitment(taskId, leadId, sha256Hex("work"), randomSalt()));
    await caughtUp(db);
    // A pass leaves alone what changed within 20 blocks of the index's height (the RPC skew it
    // allows for): the index goes on that far past the lead's registration and commit first.
    const past = (await reader.finalHeight()) + 21n;
    await until(`the index reaches block ${past}`, async () => {
      const height = await indexedHeight(db);
      return height !== null && height >= past;
    });
    const before = await taskRow(db, taskId);
    expect(before).toMatchObject({ commit_count: 1, reveal_count: 0, settled: false });
    const entriesBefore = await entriesOf(db, taskId);
    const fundersBefore = await fundersOf(db, taskId);
    expect(entriesBefore).toHaveLength(1);

    // The index loses the task, and the lead's counters go back to zero, as in an index that
    // started after both.
    await db.query("delete from events where task_id = $1", [taskId]);
    await db.query("delete from entries where task_id = $1", [taskId]);
    await db.query("delete from funders where task_id = $1", [taskId]);
    await db.query("delete from tasks where id = $1", [taskId]);
    await db.query("update agents set entries = 0, earned = '{}' where account = $1", [leadId]);

    const repairs: string[] = [];
    const result = await reconcile(db, reader, { log: (line) => repairs.push(line) });

    expect(result).toEqual({ inserted: 1, updated: 1 });
    // The row is back as it was, with no outcome as SQL NULL, and its entry and funder with it.
    expect(await taskRow(db, taskId)).toEqual(before);
    expect(await entriesOf(db, taskId)).toEqual(entriesBefore);
    expect(await fundersOf(db, taskId)).toEqual(fundersBefore);
    const [agent] = await db.query("select entries, earned from agents where account = $1", [
      leadId,
    ]);
    expect(agent).toEqual({ entries: 1, earned: { [chain.tokenId]: "0" } });
    expect(repairs).toEqual([
      `WARN reconcile task=${taskId} inserted from the chain`,
      `WARN reconcile agent=${leadId} field=entries`,
      `WARN reconcile agent=${leadId} field=earned`,
    ]);

    // A second pass finds nothing left to repair.
    expect(await reconcile(db, reader, { log: (line) => repairs.push(line) })).toEqual({
      inserted: 0,
      updated: 0,
    });
    expect(repairs).toHaveLength(3);
    // The indexer's own reconcile, at start, only filled in the tasks of the tests before.
    expect(warnings(lines).filter((line) => !line.endsWith("inserted from the chain"))).toEqual([]);
  } finally {
    await indexer.stop();
  }
});
