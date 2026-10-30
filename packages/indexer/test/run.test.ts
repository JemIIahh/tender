import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db, migrate, openDb } from "@tender/db";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import {
  type BlockSource,
  BlocksLostError,
  type ReconcileChain,
  runIndexer,
  startIndexer,
} from "../src/index";
import { blockOf, FIXTURE_CONTRACT, FIXTURE_OPTIONS, lifecycleBlocks } from "./fixtures/blocks";

// The runner and its supervisor, on a PGlite database, with a scripted block source and a fake
// chain: nothing here reaches a network. The sandbox file runs them on a real chain.

const TABLES = ["chain_cursor", "events", "tasks", "funders", "entries", "agents"];
/** What an RPC error may quote: a URL, which can hold a key. No log line may show it (P03-R16). */
const KEYED = "https://rpc.example.org/?apiKey=s3cret";
const leaks = (lines: string[]) => lines.filter((line) => line.includes("s3cret"));

let db: Db;
const dirs: string[] = [];

beforeAll(async () => {
  db = await openDb("pglite:memory");
  await migrate(db);
});

afterAll(() => db.close());

beforeEach(async () => {
  await db.exec(`truncate ${TABLES.join(", ")}, blobs restart identity`);
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Resolves when `signal` aborts. */
function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

interface Run {
  /** The heights to yield, those at or after the one asked for. */
  heights?: number[];
  /** Thrown after the heights. Without it the run waits for the abort. */
  error?: Error;
  /** Thrown once the run is aborted, as by a node that stops right after. */
  errorOnAbort?: Error;
}

/**
 * A source that serves each call of `blocks` with the next run of `runs` (an empty one when they
 * are used up), and records the height each call asked for. Its blocks hold no receipt.
 */
function scripted(runs: Run[]): { source: BlockSource; asked: bigint[] } {
  const asked: bigint[] = [];
  const source: BlockSource = {
    async *blocks(from, signal) {
      asked.push(from);
      const run = runs.shift() ?? {};
      for (const height of run.heights ?? []) {
        if (BigInt(height) >= from) yield blockOf(height, []);
      }
      if (run.error) throw run.error;
      await aborted(signal);
      if (run.errorOnAbort) throw run.errorOnAbort;
    },
  };
  return { source, asked };
}

async function cursor(source = FIXTURE_OPTIONS.cursorSource): Promise<bigint | null> {
  const [row] = await db.query<{ height: string }>(
    "select height::text as height from chain_cursor where source = $1",
    [source],
  );
  return row ? BigInt(row.height) : null;
}

/** Waits until `check` holds, looking every 20 ms, and fails the test after `ms`. */
async function until(what: string, check: () => boolean | Promise<boolean>, ms = 5_000) {
  const giveUpAt = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > giveUpAt) throw new Error(`timed out waiting until ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A chain with no task and no agent, whose final height is `final`. */
function emptyChain(final: bigint, over: Partial<ReconcileChain> = {}): ReconcileChain {
  return {
    network: "testnet",
    contractId: FIXTURE_CONTRACT,
    finalHeight: async () => final,
    taskCount: async () => 0n,
    getTask: async () => null,
    getAllEntries: async () => [],
    getAgent: async () => null,
    ...over,
  };
}

/** A directory for deployment records, holding `records` by network. */
async function deployments(records: Record<string, unknown> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tender-indexer-"));
  dirs.push(dir);
  await mkdir(dir, { recursive: true });
  for (const [network, record] of Object.entries(records)) {
    await writeFile(join(dir, `${network}.json`), JSON.stringify(record));
  }
  return dir;
}

const testnetEnv = (over: Record<string, string> = {}) => ({
  TENDER_NETWORK: "testnet",
  TENDER_CONTRACT: FIXTURE_CONTRACT,
  ...over,
});

/** The cursor of the indexer that `startIndexer` runs for `testnetEnv`. */
const TESTNET_CURSOR = `testnet:${FIXTURE_CONTRACT}`;

// ---- runIndexer -------------------------------------------------------------------------------

function run(source: BlockSource, startHeight: bigint, signal: AbortSignal) {
  return runIndexer({ db, source, startHeight, signal, log: () => undefined, ...FIXTURE_OPTIONS });
}

test("starts_at_the_later_of_the_cursor_plus_one_and_the_start_height", async () => {
  const startAt = async (startHeight: bigint) => {
    const { source, asked } = scripted([{}]);
    const stop = new AbortController();
    const running = run(source, startHeight, stop.signal);
    await until("the source is asked for blocks", () => asked.length === 1);
    stop.abort();
    await running;
    return asked[0];
  };

  expect(await startAt(100n)).toBe(100n);
  await db.query("insert into chain_cursor (source, height) values ($1, 120)", [
    FIXTURE_OPTIONS.cursorSource,
  ]);
  expect(await startAt(100n)).toBe(121n);
  expect(await startAt(200n)).toBe(200n);
});

test("rejects_with_what_the_source_throws_after_applying_the_blocks_before", async () => {
  const lost = new BlocksLostError(102n, 105n, 103n);
  const { source } = scripted([{ heights: [100, 101], error: lost }]);

  await expect(run(source, 100n, new AbortController().signal)).rejects.toBe(lost);
  expect(await cursor()).toBe(101n);
});

test("logs_its_height_and_lag_every_60_s", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  // A stand-in for the database, which PGlite cannot be under fake timers: no cursor, and every
  // write accepted.
  const fakeDb: Db = {
    query: async () => [],
    exec: async () => undefined,
    tx: (fn) => fn(fakeDb),
    close: async () => undefined,
  };
  const { source } = scripted([{ heights: [100] }]);
  const finals = [130n, new Error(`fetch failed for ${KEYED}`), 140n];
  const lines: string[] = [];
  const stop = new AbortController();
  const running = runIndexer({
    db: fakeDb,
    source,
    startHeight: 100n,
    signal: stop.signal,
    log: (line) => lines.push(line),
    finalHeight: async () => {
      const next = finals.shift();
      if (next instanceof Error) throw next;
      return next ?? 0n;
    },
    ...FIXTURE_OPTIONS,
  });

  await vi.advanceTimersByTimeAsync(59_999);
  expect(lines.filter((line) => line.startsWith("indexer height="))).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(lines.filter((line) => line.startsWith("indexer height="))).toEqual([
    "indexer height=100 lag=30",
    "indexer height=100 lag=unknown (Error)",
    "indexer height=100 lag=40",
  ]);
  expect(leaks(lines)).toEqual([]);
  stop.abort();
  await running;
});

// ---- startIndexer: where it starts ------------------------------------------------------------

test("starts_at_INDEXER_START_HEIGHT_or_else_the_deploy_height", async () => {
  const dir = await deployments({
    testnet: { network: "testnet", contract: FIXTURE_CONTRACT, deployHeight: "300" },
  });
  const startAt = async (env: Record<string, string>) => {
    const { source, asked } = scripted([{}]);
    const lines: string[] = [];
    const indexer = startIndexer(env, {
      db,
      client: emptyChain(0n),
      source,
      deploymentsDir: dir,
      log: (line) => lines.push(line),
    });
    await until("the source is asked for blocks", () => asked.length === 1);
    await indexer.stop();
    return { from: asked[0], lines };
  };

  const fromEnv = await startAt(testnetEnv({ INDEXER_START_HEIGHT: "500" }));
  expect(fromEnv.from).toBe(500n);
  expect(fromEnv.lines).toContain("indexer: starting at block 500 (INDEXER_START_HEIGHT)");

  const fromRecord = await startAt(testnetEnv());
  expect(fromRecord.from).toBe(300n);
  expect(fromRecord.lines).toContain(
    `indexer: starting at block 300 (deployHeight in ${join(dir, "testnet.json")})`,
  );
});

test("off_the_sandbox_with_no_start_height_it_throws", async () => {
  const opts = async (records?: Record<string, unknown>) => ({
    db,
    client: emptyChain(0n),
    source: scripted([]).source,
    deploymentsDir: await deployments(records),
  });

  expect(() => startIndexer(testnetEnv(), {})).toThrow(/INDEXER_START_HEIGHT/);
  const none = await opts();
  expect(() => startIndexer(testnetEnv(), none)).toThrow(/INDEXER_START_HEIGHT/);
  // A record of another contract says nothing about where this one's events begin.
  const other = await opts({
    testnet: { network: "testnet", contract: "other.testnet", deployHeight: "300" },
  });
  expect(() => startIndexer(testnetEnv(), other)).toThrow(
    /INDEXER_START_HEIGHT.*other\.testnet|other\.testnet.*INDEXER_START_HEIGHT/,
  );
  // A height that is not one, in the environment or in the record, is refused, not guessed at.
  for (const bad of ["0", "-5", "12x", "1.5"]) {
    expect(() => startIndexer(testnetEnv({ INDEXER_START_HEIGHT: bad }), none)).toThrow(
      /INDEXER_START_HEIGHT/,
    );
  }
  const broken = await opts({
    testnet: { network: "testnet", contract: FIXTURE_CONTRACT, deployHeight: 300 },
  });
  expect(() => startIndexer(testnetEnv(), broken)).toThrow(/deployHeight/);
});

test("the_sandbox_starts_at_its_final_height_then_resumes_after_the_cursor", async () => {
  const env = {
    TENDER_NETWORK: "sandbox",
    TENDER_CONTRACT: FIXTURE_CONTRACT,
    NEAR_RPC_URL: "http://127.0.0.1:1",
  };
  const client = emptyChain(700n, { network: "sandbox" });
  const dir = await deployments();
  const cursorSource = `sandbox:${FIXTURE_CONTRACT}`;

  const first = scripted([{ heights: [700, 701] }]);
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);
  let indexer = startIndexer(env, { db, client, source: first.source, deploymentsDir: dir, log });
  await until("block 701 is applied", async () => (await cursor(cursorSource)) === 701n);
  await indexer.stop();
  expect(first.asked).toEqual([700n]);
  expect(lines).toContain(
    "indexer: no INDEXER_START_HEIGHT and no deployment record; " +
      "starting at the sandbox's final height 700",
  );

  // Started again, with the chain further on: it goes on after the cursor, not from the new final
  // height, which would skip what came in between.
  const second = scripted([{}]);
  const later = emptyChain(900n, { network: "sandbox" });
  indexer = startIndexer(env, {
    db,
    client: later,
    source: second.source,
    deploymentsDir: dir,
    log,
  });
  await until("the source is asked for blocks", () => second.asked.length === 1);
  await indexer.stop();
  expect(second.asked).toEqual([702n]);
  expect(lines).toContain("indexer: resuming after block 701");
});

test("the_sandbox_takes_its_final_height_again_for_a_restart_before_the_first_block", async () => {
  // The first run fails before it applies a block. By the restart, 5 s on, the sandbox may have
  // pruned the block it started from, and nothing was indexed from it: the restart takes the
  // final height of its own time.
  const env = {
    TENDER_NETWORK: "sandbox",
    TENDER_CONTRACT: FIXTURE_CONTRACT,
    NEAR_RPC_URL: "http://127.0.0.1:1",
  };
  const finals = [700n, 900n];
  const client = emptyChain(0n, {
    network: "sandbox",
    finalHeight: async () => finals.shift() ?? 900n,
  });
  const { source, asked } = scripted([{ error: new Error("not ready") }, { heights: [900] }]);
  const lines: string[] = [];
  const indexer = startIndexer(env, {
    db,
    client,
    source,
    deploymentsDir: await deployments(),
    log: (line) => lines.push(line),
  });
  try {
    await until("the restart asks for blocks", () => asked.length === 2, 9_000);
    expect(asked).toEqual([700n, 900n]);
    expect(lines.filter((line) => line.includes("the sandbox's final height"))).toEqual([
      expect.stringMatching(/height 700$/),
      expect.stringMatching(/height 900$/),
    ]);
  } finally {
    await indexer.stop();
  }
}, 15_000);

// ---- startIndexer: errors ---------------------------------------------------------------------

test("an_error_restarts_it_from_the_cursor_and_a_repeat_warns", async () => {
  const { source, asked } = scripted([
    { heights: [100, 101], error: new BlocksLostError(102n, 104n, 102n) },
    { error: new Error(`fetch failed for ${KEYED}`) },
  ]);
  const lines: string[] = [];
  const indexer = startIndexer(testnetEnv({ INDEXER_START_HEIGHT: "100" }), {
    db,
    client: emptyChain(0n),
    source,
    deploymentsDir: await deployments(),
    log: (line) => lines.push(line),
  });
  try {
    // The first failure came after progress: a first failure, retried after 5 s. The second
    // made none: a repeat, which warns, and waits twice as long.
    await until(
      "the second failure is logged",
      () => lines.some((l) => l.startsWith("WARN")),
      9_000,
    );
    expect(asked).toEqual([100n, 102n]);
    expect(lines.filter((line) => line.includes("restarting"))).toEqual([
      "indexer: BlocksLostError: the node has no block for heights 102 to 104, but block 105 " +
        "follows block 102: it has pruned them, or is behind; restarting from the cursor in 5 s",
      "WARN indexer: failed 2 times in a row (Error); restarting from the cursor in 10 s",
    ]);
    expect(leaks(lines)).toEqual([]);
  } finally {
    // It is waiting to restart: stop ends the wait.
    const stopped = Date.now();
    await indexer.stop();
    expect(Date.now() - stopped).toBeLessThan(1_000);
  }
  expect(asked).toHaveLength(2);
  expect(await cursor(TESTNET_CURSOR)).toBe(101n);
}, 15_000);

test("a_block_that_fails_on_the_database_is_logged_with_its_code_and_height", async () => {
  // With no funders table, block 64's task_created fails on the database, and would on every try:
  // the line says with which SQLSTATE, and on which block, and quotes no message of the database.
  const broken = await openDb("pglite:memory");
  await migrate(broken);
  await broken.exec("drop table funders");
  const source: BlockSource = {
    async *blocks(from) {
      for (const block of lifecycleBlocks()) if (block.height >= from) yield block;
    },
  };
  const lines: string[] = [];
  const indexer = startIndexer(testnetEnv({ INDEXER_START_HEIGHT: "60" }), {
    db: broken,
    client: emptyChain(0n),
    source,
    deploymentsDir: await deployments(),
    log: (line) => lines.push(line),
  });
  try {
    await until("the failure is logged", () => lines.some((line) => line.includes("restarting")));
  } finally {
    await indexer.stop();
    await broken.close();
  }
  expect(lines.filter((line) => line.includes("restarting"))).toEqual([
    "indexer: error (code 42P01) at block 64; restarting from the cursor in 5 s",
  ]);
  expect(lines.filter((line) => line.includes("does not exist"))).toEqual([]);
});

test("an_error_after_stop_is_the_shutdown_not_a_failure", async () => {
  const { source, asked } = scripted([
    { heights: [100], errorOnAbort: new Error("socket hang up") },
  ]);
  const lines: string[] = [];
  const indexer = startIndexer(testnetEnv({ INDEXER_START_HEIGHT: "100" }), {
    db,
    client: emptyChain(0n),
    source,
    deploymentsDir: await deployments(),
    log: (line) => lines.push(line),
  });
  await until("block 100 is applied", async () => (await cursor(TESTNET_CURSOR)) === 100n);

  await indexer.stop();
  expect(asked).toEqual([100n]);
  expect(lines.filter((line) => line.includes("socket hang up"))).toEqual([]);
});

test("a_failed_reconcile_is_logged_and_indexing_goes_on", async () => {
  const { source } = scripted([{ heights: [100, 101] }]);
  const lines: string[] = [];
  const client = emptyChain(0n, {
    taskCount: async () => {
      throw new Error(`fetch failed for ${KEYED}`);
    },
  });
  const indexer = startIndexer(testnetEnv({ INDEXER_START_HEIGHT: "100" }), {
    db,
    client,
    source,
    deploymentsDir: await deployments(),
    log: (line) => lines.push(line),
  });
  try {
    await until("the failure is logged", () => lines.includes("WARN reconcile: failed (Error)"));
    await until("block 101 is applied", async () => (await cursor(TESTNET_CURSOR)) === 101n);
  } finally {
    await indexer.stop();
  }
  expect(leaks(lines)).toEqual([]);
});

test("neardata's lines name NEARDATA_URL rather than quote it", async () => {
  // Nothing listens on port 1, so every request fails at once, and neardata logs each retry with
  // the URL it asked for. The base of that URL is NEARDATA_URL, which can hold a key.
  const lines: string[] = [];
  const indexer = startIndexer(
    testnetEnv({ INDEXER_START_HEIGHT: "1", NEARDATA_URL: "http://127.0.0.1:1/s3cret/" }),
    { db, client: emptyChain(0n), deploymentsDir: await deployments(), log: (l) => lines.push(l) },
  );
  try {
    await until("neardata logs a failed request", () =>
      lines.some((line) => line.startsWith("neardata: GET")),
    );
  } finally {
    await indexer.stop();
  }
  expect(lines.find((line) => line.startsWith("neardata: GET"))).toMatch(
    /^neardata: GET NEARDATA_URL\/v0\/last_block\/final failed/,
  );
  expect(leaks(lines)).toEqual([]);
});

test("it_names_the_variable_that_is_missing_or_wrong", () => {
  const opts = { db, client: emptyChain(0n), source: scripted([]).source };
  expect(() => startIndexer({ TENDER_CONTRACT: FIXTURE_CONTRACT }, opts)).toThrow(/TENDER_NETWORK/);
  expect(() => startIndexer(testnetEnv({ TENDER_NETWORK: "devnet" }), opts)).toThrow(
    /TENDER_NETWORK/,
  );
  expect(() => startIndexer({ TENDER_NETWORK: "testnet" }, opts)).toThrow(/TENDER_CONTRACT/);
  expect(() =>
    startIndexer({ TENDER_NETWORK: "sandbox", TENDER_CONTRACT: FIXTURE_CONTRACT }, { db }),
  ).toThrow(/NEAR_RPC_URL/);
  expect(() =>
    startIndexer(testnetEnv({ INDEXER_START_HEIGHT: "1", INDEXER_POLL_MS: "soon" }), opts),
  ).toThrow(/INDEXER_POLL_MS/);
  expect(() =>
    startIndexer(
      testnetEnv({ INDEXER_START_HEIGHT: "1", TEAM_ACCOUNTS: "ok.testnet,Not An Id" }),
      opts,
    ),
  ).toThrow(/TEAM_ACCOUNTS/);
  expect(() =>
    startIndexer(testnetEnv({ INDEXER_START_HEIGHT: "1" }), { client: emptyChain(0n) }),
  ).toThrow(/DATABASE_URL/);
});
