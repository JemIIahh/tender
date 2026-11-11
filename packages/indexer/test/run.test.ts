import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db, migrate, openDb } from "@tender/db";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import {
  type BlockSource,
  BlocksLostError,
  checkAgainstChain,
  checkCursorSource,
  checkIndexerEnv,
  IndexerError,
  type ReconcileChain,
  runIndexer,
  startIndexer,
} from "../src/index";
import { blockOf, FIXTURE_CONTRACT, FIXTURE_OPTIONS, lifecycleBlocks } from "./fixtures/blocks";

// The runner and its supervisor, on a PGlite database, with a scripted block source and a fake
// chain: nothing here reaches a network. The sandbox file runs them on a real chain.

const TABLES = [
  "chain_cursor",
  "events",
  "tasks",
  "funders",
  "entries",
  "agents",
  "indexer_request_budget",
];
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

test("retired_lifetime_caps_cannot_stop_the_indexer_even_after_prior_usage", async () => {
  await db.query("insert into indexer_request_budget(scope, requests) values ($1, 1000)", [
    "legacy",
  ]);
  const fetchImpl = vi.fn(async (url: string) => {
    const match = /\/block\/(\d+)/.exec(url);
    const height = match ? Number(match[1]) : 13;
    return new Response(
      JSON.stringify({
        block: {
          header: {
            height,
            prev_height: height - 1,
            timestamp_nanosec: String(height * 1000000000),
          },
        },
        shards: [],
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", fetchImpl);
  const lines: string[] = [];
  const indexer = startIndexer(
    testnetEnv({
      INDEXER_START_HEIGHT: "10",
      INDEXER_MAX_REQUESTS: "2",
      FASTNEAR_API_KEY: "test-placeholder",
    }),
    { db, client: emptyChain(13n), log: (line) => lines.push(line) },
  );
  try {
    await until("all blocks pass the old cap", async () => (await cursor(TESTNET_CURSOR)) === 13n);
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(2);
    expect(lines.some((line) => line.includes("retired and ignored"))).toBe(true);
  } finally {
    await indexer.stop();
    vi.unstubAllGlobals();
  }
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

// ---- The database against the deploy ----------------------------------------------------------

/** Stores a task of id `id` as the index would. */
async function indexTask(id: number): Promise<void> {
  await db.query(
    `insert into tasks (id, poster, token, reward, fee_bps, brief_uri, brief_hash, criteria_hash,
       verifier, created_at, commit_deadline, reveal_deadline, pick_deadline, fallback_deadline,
       max_entries, max_winners, invited, created_height)
     values ($1, 'poster.test.near', 'token.test.near', 1, 0, 'uri', 'h', 'h', 'judge.test.near',
       1, 1, 1, 1, 1, 1, 1, '[]', 1)`,
    [id],
  );
}

async function setCursor(source: string, height: bigint): Promise<void> {
  await db.query("insert into chain_cursor (source, height) values ($1, $2)", [source, height]);
}

/** The deploy that `checkCursorSource` is asked about: the fixture contract on testnet. */
const DEPLOY = { network: "testnet", contractId: FIXTURE_CONTRACT };

test("a_cursor_of_another_source_is_refused_at_the_start_without_asking_the_chain", async () => {
  const failureOf = () =>
    checkCursorSource(db, DEPLOY).then(
      () => undefined,
      (error: unknown) => error as Error,
    );
  // Nothing indexed, or this deploy's cursor alone: nothing to refuse.
  expect(await failureOf()).toBeUndefined();
  await setCursor(TESTNET_CURSOR, 5n);
  expect(await failureOf()).toBeUndefined();

  await setCursor("testnet:old.testnet", 5n);
  const failure = await failureOf();
  expect(failure).toBeInstanceOf(IndexerError);
  // It names the other source and this deploy, and says what to do.
  expect(failure?.message).toMatch(/another deploy of Tender/);
  expect(failure?.message).toContain('"testnet:old.testnet"');
  expect(failure?.message).toContain(`"${TESTNET_CURSOR}"`);
  expect(failure?.message).toContain("one database per contract deploy");

  // A long list is cut short.
  for (const other of ["mainnet:a.near", "mainnet:b.near", "mainnet:c.near"]) {
    await setCursor(other, 9n);
  }
  const many = await failureOf();
  expect(many?.message).toContain('"mainnet:a.near", "mainnet:b.near", "mainnet:c.near"');
  expect(many?.message).toMatch(/ and others, and this deploy/);
  expect(many?.message).not.toContain("old.testnet");

  // A cursor that is only a prefix of this deploy's is another's.
  await db.exec("truncate chain_cursor");
  await setCursor(`${TESTNET_CURSOR}2`, 9n);
  expect(await failureOf()).toBeInstanceOf(IndexerError);
});

/** The Nth answer to the Nth ask, the last one for every ask after it; an `Error` is thrown. */
function answers<T>(list: Array<T | Error>): () => Promise<T> {
  let asked = 0;
  return async () => {
    const next = list[Math.min(asked++, list.length - 1)] as T | Error;
    if (next instanceof Error) throw next;
    return next;
  };
}

/** A chain that answers its final height and its task count from lists, counting the asks. */
function answering(
  finals: Array<bigint | Error>,
  counts: Array<bigint | Error>,
  over: Partial<ReconcileChain> = {},
) {
  const asks = { final: 0, count: 0 };
  const finalHeight = answers(finals);
  const taskCount = answers(counts);
  const chain = emptyChain(0n, {
    finalHeight: () => {
      asks.final += 1;
      return finalHeight();
    },
    taskCount: () => {
      asks.count += 1;
      return taskCount();
    },
    ...over,
  });
  return { chain, asks };
}

/**
 * What `checkAgainstChain` makes of `chain`: whether it went through, the refusal if there is one,
 * and why it waited each time. It waits 1 to 2 ms.
 */
async function againstChain(
  chain: ReconcileChain,
  over: Parameters<typeof checkAgainstChain>[2] = {},
) {
  const waits: string[] = [];
  const outcome = await checkAgainstChain(db, chain, {
    retryMs: 1,
    longestMs: 2,
    onWait: (why) => waits.push(why),
    ...over,
  }).then(
    (ok) => ({ ok, failure: undefined }),
    (error: unknown) => ({ ok: undefined, failure: error as Error }),
  );
  return { ...outcome, waits };
}

test("a_database_with_no_task_and_no_cursor_passes_without_asking_the_chain", async () => {
  const { chain, asks } = answering([new Error("down")], [new Error("down")]);
  expect(await againstChain(chain)).toEqual({ ok: true, failure: undefined, waits: [] });
  expect(asks).toEqual({ final: 0, count: 0 });
});

test("a_cursor_alone_is_checked_against_the_final_height_and_asks_no_count", async () => {
  await setCursor(TESTNET_CURSOR, 100n);
  const { chain, asks } = answering([150n], [new Error("not asked")]);
  expect(await againstChain(chain)).toEqual({ ok: true, failure: undefined, waits: [] });
  expect(asks).toEqual({ final: 1, count: 0 });
});

test("a_task_at_or_below_the_chains_count_passes", async () => {
  await setCursor(TESTNET_CURSOR, 100n);
  await indexTask(7);
  for (const count of [7n, 900n]) {
    const { chain, asks } = answering([150n], [count]);
    expect(await againstChain(chain)).toEqual({ ok: true, failure: undefined, waits: [] });
    expect(asks).toEqual({ final: 1, count: 1 });
  }
  // The count is a bigint: past what a number holds exactly, and a u64 id.
  await db.exec("truncate tasks");
  await indexTask(Number.MAX_SAFE_INTEGER);
  expect((await againstChain(answering([150n], [2n ** 64n - 1n]).chain)).ok).toBe(true);
  // Whatever the highest id is, not the newest row.
  await db.exec("truncate tasks");
  await indexTask(9);
  await indexTask(3);
  expect((await againstChain(answering([150n], [8n]).chain)).failure?.message).toContain(
    "the database holds task 9,",
  );
});

test("a_read_that_fails_is_made_again_and_never_refuses", async () => {
  await setCursor(TESTNET_CURSOR, 100n);
  await indexTask(7);
  const down = new Error(`fetch failed for ${KEYED}`);
  const { chain, asks } = answering([down, down, 150n], [down, 7n]);
  const { ok, failure, waits } = await againstChain(chain);
  expect({ ok, failure }).toEqual({ ok: true, failure: undefined });
  // Each wait says what failed, by its name only: a URL can hold a key.
  expect(waits).toEqual([
    "cannot read the final block (Error)",
    "cannot read the final block (Error)",
    "cannot read the task count (Error)",
  ]);
  expect(leaks(waits)).toEqual([]);
  expect(asks.count).toBe(2);

  // The database may fail to answer as well. It is read again, too.
  const query = vi.spyOn(db, "query");
  query.mockRejectedValueOnce(
    Object.assign(new Error("terminating connection"), { code: "57P01" }),
  );
  const again = await againstChain(answering([150n], [7n]).chain);
  expect(again.ok).toBe(true);
  expect(again.waits).toEqual(["cannot read the database (Error (code 57P01))"]);
  query.mockRestore();
});

test("a_chain_that_never_answers_is_waited_for_until_the_check_is_stopped", async () => {
  await setCursor(TESTNET_CURSOR, 100n);
  await indexTask(7);
  const stop = new AbortController();
  const down = new Error("ECONNREFUSED");
  const { chain } = answering([down], [down]);
  const waits: string[] = [];
  const checking = checkAgainstChain(db, chain, {
    retryMs: 1,
    longestMs: 2,
    signal: stop.signal,
    onWait: (why) => {
      waits.push(why);
      if (waits.length === 5) stop.abort();
    },
  });
  // It never refuses, however long the node is down: the stop ends it, with no verdict.
  expect(await checking).toBe(false);
  expect(waits).toHaveLength(5);

  // A stop before the start ends it at once, with nothing asked.
  const asked = answering([150n], [7n]);
  expect(await checkAgainstChain(db, asked.chain, { signal: stop.signal })).toBe(false);
  expect(asked.asks).toEqual({ final: 0, count: 0 });
});

test("a_node_that_lags_the_index_does_not_refuse_it", async () => {
  await setCursor(TESTNET_CURSOR, 100n);
  await indexTask(7);
  // The count is short of the task, and the node's final block is not yet past the cursor by the
  // skew of 20: it is behind. It is asked again, and when it has caught up the database passes.
  const lagging = answering([105n, 110n, 119n, 125n], [6n, 6n, 6n, 7n]);
  const { ok, failure, waits } = await againstChain(lagging.chain);
  expect({ ok, failure }).toEqual({ ok: true, failure: undefined });
  expect(waits).toHaveLength(3);
  expect(waits[0]).toMatch(
    /^the node counts 6 tasks, fewer than the 7 the database holds, and its final block, 105, is too near the last block the index took, 100, to tell whether it is behind$/,
  );
  expect(lagging.asks).toEqual({ final: 4, count: 4 });

  // The cursor a few blocks ahead of the node's final block is no mismatch either.
  await db.exec("truncate chain_cursor");
  await setCursor(TESTNET_CURSOR, 1_000n);
  const near = await againstChain(answering([985n], [7n]).chain);
  expect({ ok: near.ok, waits: near.waits }).toEqual({ ok: true, waits: [] });
});

test("a_count_below_the_highest_task_refuses_once_two_reads_in_a_row_past_the_cursor_say_so", async () => {
  await setCursor(TESTNET_CURSOR, 100n);
  await indexTask(7);
  // 20 blocks past the cursor: the node has seen every block the index took, and no task of it. It
  // says so on one read, and is asked again; the refusal comes when the second read agrees.
  const sure = answering([120n, 121n], [3n, 3n]);
  const { ok, failure, waits } = await againstChain(sure.chain);
  expect(ok).toBeUndefined();
  expect(failure).toBeInstanceOf(IndexerError);
  expect(waits).toHaveLength(1);
  expect(waits[0]).toBe(
    "the node counts 3 tasks, fewer than the 7 the database holds, though its final block, 120, is past the last block the index took, 100: reading again before the database is taken for another deploy's",
  );
  expect(sure.asks).toEqual({ final: 2, count: 2 });
  const words = failure?.message ?? "";
  expect(words).toContain(
    `the database holds task 7, but ${FIXTURE_CONTRACT} has made 3 on testnet`,
  );
  expect(words).toContain(
    "as read at its final block 121, past the last block the index took (100), on 2 reads in a row",
  );
  expect(words).toContain("one database per contract deploy");
  // The causes come in order, the node first, and the advice is never to discard the database.
  const behind = words.indexOf("behind the chain: wait for it");
  const another = words.indexOf("another contract or chain");
  const fresh = words.indexOf("use a new database");
  expect(behind).toBeGreaterThan(-1);
  expect(another).toBeGreaterThan(behind);
  expect(fresh).toBeGreaterThan(another);
  expect(words).toContain("keep the old one");
  expect(words).not.toMatch(/discard|throw .* away|wipe|reset/i);

  // One odd read does not refuse it: the node that said 3 says 7 the next time, as a load-balanced
  // RPC does when two of its nodes are some blocks apart.
  const odd = answering([120n, 120n], [3n, 7n]);
  const passed = await againstChain(odd.chain);
  expect({ ok: passed.ok, failure: passed.failure }).toEqual({ ok: true, failure: undefined });
  expect(passed.waits).toHaveLength(1);
  expect(odd.asks).toEqual({ final: 2, count: 2 });

  // The two reads are in a row: a round that does not find the count short, because the node is
  // not yet past the cursor, or a read that fails, starts the tally again.
  const between = answering([120n, 110n, 120n, 120n], [3n]);
  const nearby = await againstChain(between.chain);
  expect(nearby.failure).toBeInstanceOf(IndexerError);
  expect(between.asks).toEqual({ final: 4, count: 4 });
  const down = new Error("ECONNRESET");
  const failing = answering([120n, down, 120n, 120n], [3n]);
  const flaky = await againstChain(failing.chain);
  expect(flaky.failure).toBeInstanceOf(IndexerError);
  expect(failing.asks).toEqual({ final: 4, count: 3 });
  expect(flaky.waits).toHaveLength(3);

  // One block short of the skew, the node may be behind: it is asked again, and never refused.
  const short = answering([119n], [3n]);
  const waiting = new AbortController();
  let told = 0;
  const asked = await againstChain(short.chain, {
    signal: waiting.signal,
    onWait: () => {
      told += 1;
      if (told === 6) waiting.abort();
    },
  });
  expect({ ok: asked.ok, failure: asked.failure }).toEqual({ ok: false, failure: undefined });
  expect(short.asks.final).toBe(6);
});

test("on_the_sandbox_the_node_is_the_source_and_there_is_no_skew", async () => {
  const cursor = `sandbox:${FIXTURE_CONTRACT}`;
  await setCursor(cursor, 100n);
  await indexTask(7);
  const sandbox = (finals: bigint[], counts: bigint[]) =>
    answering(finals, counts, { network: "sandbox" });
  // At the cursor itself the node has seen what the index took, and two reads agree.
  const mismatch = sandbox([100n, 100n], [3n, 3n]);
  const refused = await againstChain(mismatch.chain);
  expect(refused.failure).toBeInstanceOf(IndexerError);
  expect(refused.failure?.message).toContain("has made 3 on sandbox");
  expect(mismatch.asks).toEqual({ final: 2, count: 2 });
  // A cursor one block above the node's final block is another chain, at once: one read, and no
  // wait, whatever the retry times are.
  const aheadChain = sandbox([99n], [7n]);
  const ahead = await againstChain(aheadChain.chain, { retryMs: 60_000, longestMs: 60_000 });
  expect(ahead.failure).toBeInstanceOf(IndexerError);
  expect(ahead.waits).toEqual([]);
  expect(aheadChain.asks).toEqual({ final: 1, count: 0 });
  const words = ahead.failure?.message ?? "";
  expect(words).toMatch(
    /^the index took block 100, but the final block of sandbox at the node is 99, 1 block below it\./,
  );
  expect(words).toContain("a sandbox that was started afresh");
  expect(words).toContain("a new chain under this contract name needs a new database");
  // And the same database passes at the cursor, when the chain counts the task.
  expect((await againstChain(sandbox([100n], [7n]).chain)).ok).toBe(true);
});

test("off_the_sandbox_a_node_behind_the_index_is_waited_for_and_never_refused", async () => {
  await setCursor(TESTNET_CURSOR, 1_000n);
  // A node 960 blocks behind, and then still behind: asked again for as long as it takes, with the
  // gap named, and never refused. The wait is told once in `behindWarnMs`, a minute unless given.
  const slow = answering([40n], [0n]);
  const stop = new AbortController();
  const waits: string[] = [];
  const checking = checkAgainstChain(db, slow.chain, {
    retryMs: 1,
    longestMs: 2,
    signal: stop.signal,
    onWait: (why) => waits.push(why),
  });
  await until("the node has been asked again and again", () => slow.asks.final >= 8);
  stop.abort();
  expect(await checking).toBe(false);
  expect(waits).toEqual([
    "the final block of the node, 40, is 960 blocks below the last block the index took, 1000: the node is behind, and is waited for",
  ]);
  expect(slow.asks.count).toBe(0);

  // Told at each wait when `behindWarnMs` is 0.
  const often = answering([40n], [0n]);
  const enough = new AbortController();
  let said = 0;
  const loud = await againstChain(often.chain, {
    behindWarnMs: 0,
    signal: enough.signal,
    onWait: () => {
      said += 1;
      if (said === 4) enough.abort();
    },
  });
  expect(loud.ok).toBe(false);
  expect(said).toBe(4);

  // A node that catches up is believed, and the database passes. No task was asked about.
  const catching = answering([900n, 950n, 990n, 1_100n], [0n]);
  const caught = await againstChain(catching.chain, { behindWarnMs: 0 });
  expect({ ok: caught.ok, failure: caught.failure }).toEqual({ ok: true, failure: undefined });
  expect(caught.waits).toHaveLength(2);
  expect(catching.asks.count).toBe(0);
});

test("off_the_sandbox_only_a_gap_no_lag_explains_is_refused_as_a_node_of_another_network", async () => {
  // 100000 blocks behind is still a node that lags; one more is not.
  await setCursor(TESTNET_CURSOR, 100_100n);
  const limit = answering([100n], [0n]);
  const stop = new AbortController();
  const atLimit = await againstChain(limit.chain, {
    signal: stop.signal,
    onWait: () => stop.abort(),
  });
  expect({ ok: atLimit.ok, failure: atLimit.failure }).toEqual({ ok: false, failure: undefined });

  await db.exec("truncate chain_cursor");
  await setCursor(TESTNET_CURSOR, 500_000n);
  const wrong = answering([100n], [new Error("not asked")]);
  const { ok, failure, waits } = await againstChain(wrong.chain);
  expect(ok).toBeUndefined();
  expect(failure).toBeInstanceOf(IndexerError);
  // The first read is told, and read again; the second says the same, and no count is asked.
  expect(waits).toEqual([
    "the final block of the node, 100, is 499900 blocks below the last block the index took, 500000, more than any lag explains: reading again before the node is taken for one of another network",
  ]);
  expect(wrong.asks).toEqual({ final: 2, count: 0 });
  const words = failure?.message ?? "";
  expect(words).toMatch(
    /^the index took block 500000, but the final block of testnet at the node is 100, 499900 blocks below it, on 2 reads in a row\. No lag explains a gap that size: the node at NEAR_RPC_URL is most likely on another network than testnet\. Point NEAR_RPC_URL at a testnet node, and start the services again\. Or this is a new chain under the contract name /,
  );
  expect(words).toContain("a new chain under this contract name needs a new database");
  expect(words).toContain("one database per contract deploy");
  // The node is named first, and the database is kept.
  expect(words.indexOf("most likely on another network")).toBeLessThan(words.indexOf("new chain"));
  expect(words).toContain("keep the old one");
  expect(words).not.toMatch(/discard|throw .* away|wipe|reset/i);
});

test("off_the_sandbox_one_far_read_is_not_taken_for_a_node_of_another_network", async () => {
  await setCursor(TESTNET_CURSOR, 500_000n);
  // A node that has just restarted says 100 once, and then its own height: the second read is
  // believed, and the database passes. No task was asked about.
  const odd = answering([100n, 500_100n], [0n]);
  const passed = await againstChain(odd.chain);
  expect({ ok: passed.ok, failure: passed.failure }).toEqual({ ok: true, failure: undefined });
  expect(passed.waits).toHaveLength(1);
  expect(odd.asks).toEqual({ final: 2, count: 0 });

  // The two reads are in a row. A read that finds the node merely behind, or fails, starts the
  // tally again, so a far read between others is never the second, however long that goes on.
  const down = new Error("ECONNRESET");
  const never = async (finals: Array<bigint | Error>) => {
    const stop = new AbortController();
    let told = 0;
    const chain = answering(finals, [0n]);
    const outcome = await againstChain(chain.chain, {
      behindWarnMs: 0,
      signal: stop.signal,
      onWait: () => {
        told += 1;
        if (told === 8) stop.abort();
      },
    });
    return { ok: outcome.ok, failure: outcome.failure, asks: chain.asks.final };
  };
  const behind = await never(Array.from({ length: 16 }, (_, i) => (i % 2 === 0 ? 100n : 499_000n)));
  expect({ ok: behind.ok, failure: behind.failure }).toEqual({ ok: false, failure: undefined });
  expect(behind.asks).toBe(8);
  const failing = await never(Array.from({ length: 16 }, (_, i) => (i % 2 === 0 ? 100n : down)));
  expect({ ok: failing.ok, failure: failing.failure }).toEqual({ ok: false, failure: undefined });
  expect(failing.asks).toBe(8);

  // A far read and then a node that is merely behind: the tally starts again, and it takes two
  // far reads in a row, here the third and the fourth.
  const again = answering([100n, 499_000n, 100n, 100n], [0n]);
  const refused = await againstChain(again.chain, { behindWarnMs: 0 });
  expect(refused.failure).toBeInstanceOf(IndexerError);
  expect(again.asks.final).toBe(4);
});

test("it_checks_the_environment_as_startIndexer_does_and_starts_nothing", async () => {
  const none = await deployments();
  const noHeight = /no height to start indexing testnet from: set INDEXER_START_HEIGHT/;
  expect(() => checkIndexerEnv(testnetEnv(), { deploymentsDir: none })).toThrow(noHeight);
  expect(() =>
    startIndexer(testnetEnv(), { db, client: emptyChain(0n), deploymentsDir: none }),
  ).toThrow(noHeight);
  expect(() =>
    checkIndexerEnv(testnetEnv({ INDEXER_START_HEIGHT: "100" }), { deploymentsDir: none }),
  ).not.toThrow();
  // A record of this contract has a height; a record that is broken does not.
  const record = await deployments({
    testnet: { contract: FIXTURE_CONTRACT, deployHeight: "123" },
  });
  expect(() => checkIndexerEnv(testnetEnv(), { deploymentsDir: record })).not.toThrow();
  const broken = await deployments({ testnet: { contract: FIXTURE_CONTRACT, deployHeight: "0" } });
  expect(() => checkIndexerEnv(testnetEnv(), { deploymentsDir: broken })).toThrow(/block height/);
  // The same settings are refused by name.
  for (const [env, named] of [
    [{ TENDER_CONTRACT: FIXTURE_CONTRACT }, /TENDER_NETWORK/],
    [{ TENDER_NETWORK: "testnet" }, /TENDER_CONTRACT/],
    [testnetEnv({ INDEXER_START_HEIGHT: "1", INDEXER_POLL_MS: "soon" }), /INDEXER_POLL_MS/],
    [testnetEnv({ INDEXER_START_HEIGHT: "1", NEARDATA_URL: "ftp://x" }), /NEARDATA_URL/],
    [{ TENDER_NETWORK: "sandbox", TENDER_CONTRACT: FIXTURE_CONTRACT }, /NEAR_RPC_URL/],
  ] as const) {
    expect(() => checkIndexerEnv(env, { deploymentsDir: none })).toThrow(named);
  }
});
