import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { TenderClient } from "@tender/client";
import { type Db, migrate, openDb } from "@tender/db";
import { AccountIdSchema, NETWORKS, type NetworkId, U64StringSchema } from "@tender/shared";
import { type ApplyOptions, applyBlock, cursorHeight } from "./apply";
import { ApplyBlockError, IndexerError } from "./errors";
import { withIndexLock } from "./lock";
import { createNeardataSource } from "./neardata";
import { type ReconcileChain, reconcile } from "./reconcile";
import { createRpcSource } from "./rpc";
import type { BlockSource } from "./types";

export interface RunIndexerOptions extends ApplyOptions {
  db: Db;
  source: BlockSource;
  /** The first height to read, unless the cursor is at it or past it already. */
  startHeight: bigint;
  signal: AbortSignal;
  /** Default: `console.log`. */
  log?: (message: string) => void;
  /** The chain's final height. Given it, the runner logs its height and lag every 60 s. */
  finalHeight?: () => Promise<bigint>;
}

/** How often the runner logs `indexer height=<h> lag=<final-h>`. */
const LAG_LOG_MS = 60_000;

/**
 * Applies the blocks of `source` to `db` with `applyBlock`, one at a time and in order, from
 * `max(cursor + 1, startHeight)` on, until `signal` aborts. It resolves then, once the block in
 * hand is applied: each block is one transaction, with the cursor, so a run stopped anywhere
 * resumes after the last block it applied, and a block applied twice changes nothing.
 *
 * It rejects with whatever the source throws, and applies nothing after it. That includes the RPC
 * source's `BlocksLostError`, and its error on a transaction that is not final: they stand for
 * blocks the runner has not read, which it never skips. A restart from the cursor reads them
 * again; `startIndexer` makes it. When `applyBlock` fails, it rejects with an `ApplyBlockError`
 * that names the block, with what `applyBlock` threw as its `cause`.
 *
 * With `finalHeight`, every 60 s it logs `indexer height=<h> lag=<final-h>`: `h` is the last block
 * applied (before the first, the one below where it started), and the lag is `unknown`, with the
 * error's name, when the final height cannot be read.
 */
export async function runIndexer(opts: RunIndexerOptions): Promise<void> {
  const { db, source, signal, startHeight, finalHeight } = opts;
  const log = opts.log ?? console.log;
  const apply: ApplyOptions = {
    contractId: opts.contractId,
    cursorSource: opts.cursorSource,
    teamAccounts: opts.teamAccounts,
  };
  const cursor = await cursorHeight(db, opts.cursorSource);
  const from = cursor !== null && cursor + 1n > startHeight ? cursor + 1n : startHeight;
  let height = from - 1n;
  log(`indexer: reading blocks from ${from}`);
  const stopLagLog = finalHeight ? logLag(finalHeight, () => height, log) : undefined;
  try {
    for await (const block of source.blocks(from, signal)) {
      try {
        await withIndexLock(db, () => applyBlock(db, block, apply));
      } catch (error) {
        throw new ApplyBlockError(block.height, error);
      }
      height = block.height;
    }
  } finally {
    stopLagLog?.();
  }
}

/** Logs the height and the lag every `LAG_LOG_MS`, until the function it returns is called. */
function logLag(
  finalHeight: () => Promise<bigint>,
  height: () => bigint,
  log: (message: string) => void,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const tick = async () => {
    let final: bigint | undefined;
    let failure: unknown;
    try {
      final = await finalHeight();
    } catch (error) {
      failure = error;
    }
    if (stopped) return;
    const h = height();
    const lag =
      final === undefined ? `unknown (${describe(failure)})` : `${final > h ? final - h : 0n}`;
    log(`indexer height=${h} lag=${lag}`);
    timer = setTimeout(tick, LAG_LOG_MS);
  };
  timer = setTimeout(tick, LAG_LOG_MS);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

export interface StartIndexerOptions {
  /** The index. Default: `DATABASE_URL`, opened and migrated here, and closed by `stop`. */
  db?: Db;
  /**
   * Reads the chain for the lag line, for reconcile, and for where to start on the sandbox.
   * Default: a `TenderClient` of the network, at `NEAR_RPC_URL` if it is set.
   */
  client?: ReconcileChain;
  /** Where the deploy script's record, `<network>.json`, is. Default: the repository's. */
  deploymentsDir?: string;
  /** Default: `console.log`. */
  log?: (message: string) => void;
  /** For tests: the block source to read instead of the one `TENDER_NETWORK` calls for. */
  source?: BlockSource;
}

export interface Indexer {
  /** Stops the indexer, and resolves once the work in flight is done. */
  stop(): Promise<void>;
}

/** The wait after a first failure. It doubles with each failure in a row, up to the longest. */
const FIRST_BACKOFF_MS = 5_000;
const LONGEST_BACKOFF_MS = 60_000;
const RECONCILE_EVERY_MS = 10 * 60_000;
/** How often the first reconcile looks for the index's first block. */
const FIRST_BLOCK_POLL_MS = 1_000;
const DEPLOYMENTS_DIR = fileURLToPath(new URL("../../../deployments/", import.meta.url));

/**
 * Starts the indexer of `env`'s network and contract, and returns at once; it runs until `stop`.
 *
 * - **Source** (P03-R6): the RPC source at `NEAR_RPC_URL` when `TENDER_NETWORK` is `sandbox`,
 *   neardata otherwise, at `NEARDATA_URL` (default: the network's) with `FASTNEAR_API_KEY`. Neither
 *   ever stands in for the other. `INDEXER_POLL_MS` sets how often a source that has caught up
 *   looks again.
 * - **Start**: `INDEXER_START_HEIGHT`; else the `deployHeight` in the deploy script's record,
 *   `<deploymentsDir>/<network>.json`, if it is this contract's; else, on the sandbox only, the
 *   chain's final height when nothing is indexed yet (it prunes its old blocks within minutes),
 *   taken again at each restart until a block is applied, and after the cursor once one is. Off
 *   the sandbox, with neither, it throws, naming `INDEXER_START_HEIGHT`. The cursor goes first in
 *   any case: the runner reads from `max(cursor + 1, start)`.
 * - **Failures**: the runner rejects with what the source throws, `BlocksLostError` included.
 *   The error is logged and the runner restarts from the cursor after 5 s, doubling to 60 s while
 *   restarts make no progress; each failure after the first in a row logs a WARN. An error that
 *   comes after `stop` is the shutdown, not a failure. A line quotes the indexer's own errors, and
 *   of any other gives the name and code only, never the message, which can hold a URL, and so a
 *   key (P03-R16); of a block that fails, it gives the height.
 * - **Reconcile** runs once the index holds its first block, and every 10 min after (see
 *   `reconcile`). Its errors are logged and never stop the indexer.
 *
 * The cursor is `<network>:<contractId>`, as `reconcile` assumes. The environment is checked
 * first, and a value that is missing or wrong throws, naming the variable.
 */
export function startIndexer(
  env: Record<string, string | undefined>,
  opts: StartIndexerOptions = {},
): Indexer {
  const log = opts.log ?? console.log;
  const config = readConfig(env);
  const start = configuredStart(env, config, opts.deploymentsDir ?? DEPLOYMENTS_DIR);
  if (start.height === null && config.network !== "sandbox") {
    throw new Error(
      `no height to start indexing ${config.network} from: set INDEXER_START_HEIGHT (${start.why})`,
    );
  }
  const source = opts.source ?? sourceOf(env, config, log);
  const client = opts.client ?? clientOf(env, config);
  const { db } = opts;
  let openDatabase: () => Promise<Db>;
  if (db === undefined) {
    const url = required(env, "DATABASE_URL");
    openDatabase = () => openIndex(url);
  } else {
    openDatabase = async () => db;
  }

  const stopping = new AbortController();
  const running = supervise({
    ...config,
    cursorSource: cursorSourceOf(config),
    start,
    source,
    client,
    openDatabase,
    ownsDatabase: db === undefined,
    log,
    signal: stopping.signal,
  });
  return {
    async stop() {
      stopping.abort();
      await running;
    },
  };
}

interface Config {
  network: NetworkId;
  contractId: string;
  teamAccounts: string[];
  pollMs?: number;
}

/** The key of the indexer's row in `chain_cursor`: `<network>:<contractId>`. */
function cursorSourceOf(chain: { network: string; contractId: string }): string {
  return `${chain.network}:${chain.contractId}`;
}

/** The reads of the chain that `checkDeployment` makes. */
export type DeploymentChain = Pick<ReconcileChain, "network" | "contractId" | "taskCount">;

export interface CheckDeploymentOptions {
  /**
   * How many more times the chain is asked, when the index holds a task above the number it gives
   * (see `checkDeployment`). Default 3.
   */
  retries?: number;
  /** How long to wait before each new ask, in milliseconds. Default 2000. */
  retryMs?: number;
}

const DEPLOYMENT_RETRIES = 3;
const DEPLOYMENT_RETRY_MS = 2_000;
/** The most other sources `checkDeployment` names. */
const SOURCES_NAMED = 3;

/**
 * Refuses a database that holds the index of another deploy of Tender: one database serves one
 * contract deploy. The tables of the index are not keyed by contract, so a second contract on the
 * same database would project its events onto the first one's rows, and the keeper and the Judge
 * would act on them; and so would a contract account that was deleted and made again, whose task
 * ids start from 1. It throws an `IndexerError` that says "one database per contract deploy", when
 *
 * - `chain_cursor` holds a row for any source but `<network>:<contractId>` of `chain`; or
 * - the highest task id in `tasks` is above `taskCount()` of the chain.
 *
 * It is made at the start of the services, before anything serves from the database or acts on it.
 * A database with no task asks nothing of the chain. The count is read again up to `retries`
 * times, `retryMs` apart, before it refuses: the index follows neardata, and the RPC node that
 * answers `taskCount()` can be some blocks behind it, so that a task posted just before a restart
 * is no mismatch. A chain that cannot be asked is a refusal too, one that names the kind of the
 * failure only: a database that holds tasks is not started on without the check.
 */
export async function checkDeployment(
  db: Db,
  chain: DeploymentChain,
  options: CheckDeploymentOptions = {},
): Promise<void> {
  const own = cursorSourceOf(chain);
  const others = await db.query<{ source: string }>(
    "select source from chain_cursor where source <> $1 order by source limit $2",
    [own, SOURCES_NAMED + 1],
  );
  if (others.length > 0) {
    const named = others.slice(0, SOURCES_NAMED).map(({ source }) => JSON.stringify(source));
    const more = others.length > SOURCES_NAMED ? " and others" : "";
    throw new IndexerError(
      `the database holds the index of another deploy of Tender: its chain cursor is for ` +
        `${named.join(", ")}${more}, and this deploy is ${JSON.stringify(own)}. A database ` +
        "serves one contract deploy: use a new database for this one (one database per " +
        "contract deploy)",
    );
  }

  const [row] = await db.query<{ id: string | null }>("select max(id)::text as id from tasks");
  if (row?.id === null || row?.id === undefined) return;
  const highest = BigInt(row.id);
  const retries = options.retries ?? DEPLOYMENT_RETRIES;
  const retryMs = options.retryMs ?? DEPLOYMENT_RETRY_MS;
  for (let asked = 0; ; asked++) {
    let count: bigint;
    try {
      count = await chain.taskCount();
    } catch (error) {
      throw new IndexerError(
        `cannot ask the chain how many tasks ${chain.contractId} has (${describe(error)}), ` +
          "and the database holds tasks that the services do not start on without checking " +
          "them against it",
        { cause: error },
      );
    }
    if (highest <= count) return;
    if (asked >= retries) {
      throw new IndexerError(
        `the database holds task ${highest}, but ${chain.contractId} has ${count} on ` +
          `${chain.network}: it is the index of another deploy of Tender, since a contract ` +
          "account that was deleted and made again counts its tasks from 1. A database serves " +
          "one contract deploy: use a new database for this one (one database per contract " +
          "deploy)",
      );
    }
    await delay(retryMs);
  }
}

/**
 * Where to start, as configured; or null, with the reason, and whether there is a deployment record
 * at all (one of another contract does not count).
 */
type Start = { height: bigint; from: string } | { height: null; why: string; record: boolean };

interface Supervised extends Config {
  cursorSource: string;
  start: Start;
  source: BlockSource;
  client: ReconcileChain;
  /** The index. A failure to open it is a failure like any other, and is retried. */
  openDatabase: () => Promise<Db>;
  /** Whether the index was opened here, and is closed here. */
  ownsDatabase: boolean;
  log: (message: string) => void;
  signal: AbortSignal;
}

/**
 * Runs the runner, and restarts it after each failure, until `signal` aborts. It rejects only if
 * closing a database it opened fails.
 */
async function supervise(p: Supervised): Promise<void> {
  const { cursorSource, signal, log } = p;
  let db: Db | undefined;
  let reconciling: Promise<void> | undefined;
  let failures = 0;
  try {
    while (!signal.aborted) {
      // The cursor as the run started, to tell a run that made progress before it failed.
      let before: bigint | null | undefined;
      try {
        db ??= await p.openDatabase();
        if (signal.aborted) break;
        reconciling ??= reconcileEvery(db, p.client, cursorSource, signal, log);
        // Taken again at every start: on the sandbox, until a block is applied, the start moves
        // on with the chain, which prunes the blocks behind it.
        const startHeight = await startHeightOf(db, p);
        before = await cursorHeight(db, cursorSource);
        await runIndexer({
          db,
          source: p.source,
          contractId: p.contractId,
          cursorSource,
          teamAccounts: p.teamAccounts,
          startHeight,
          signal,
          log,
          finalHeight: () => p.client.finalHeight(),
        });
        if (signal.aborted) break;
        throw new IndexerError("the block source ended before the indexer was stopped");
      } catch (error) {
        // The node or the database going away as the indexer stops is the shutdown, not a failure.
        if (signal.aborted) break;
        const after =
          db === undefined ? null : await cursorHeight(db, cursorSource).catch(() => null);
        const progressed =
          before !== undefined && after !== null && (before === null || after > before);
        failures = progressed ? 1 : failures + 1;
        const wait = Math.min(FIRST_BACKOFF_MS * 2 ** (failures - 1), LONGEST_BACKOFF_MS);
        const restart = `restarting from the cursor in ${wait / 1000} s`;
        log(
          failures === 1
            ? `indexer: ${describe(error)}; ${restart}`
            : `WARN indexer: failed ${failures} times in a row (${describe(error)}); ${restart}`,
        );
        await pause(wait, signal);
      }
    }
  } finally {
    await reconciling;
    if (p.ownsDatabase) await db?.close();
  }
}

async function openIndex(url: string): Promise<Db> {
  const db = await openDb(url);
  try {
    await migrate(db);
  } catch (error) {
    await db.close().catch(() => undefined);
    throw error;
  }
  return db;
}

/**
 * The height the runner starts from, logged: the configured one, or on the sandbox the block after
 * the cursor, or the chain's final height when there is no cursor yet.
 */
async function startHeightOf(db: Db, p: Supervised): Promise<bigint> {
  const cursor = await cursorHeight(db, p.cursorSource);
  const { start, log } = p;
  if (start.height !== null) {
    if (cursor !== null && cursor + 1n >= start.height) {
      log(`indexer: resuming after block ${cursor}`);
    } else {
      log(`indexer: starting at block ${start.height} (${start.from})`);
    }
    return start.height;
  }
  if (cursor !== null) {
    log(`indexer: resuming after block ${cursor}`);
    return cursor + 1n;
  }
  const final = await p.client.finalHeight();
  const record = start.record ? ` of ${p.contractId} (${start.why})` : "";
  log(
    `indexer: no INDEXER_START_HEIGHT and no deployment record${record}; ` +
      `starting at the sandbox's final height ${final}`,
  );
  return final;
}

/**
 * Runs `reconcile` once the index holds a block, and every 10 min after, until `signal` aborts.
 * Never rejects.
 */
async function reconcileEvery(
  db: Db,
  client: ReconcileChain,
  cursorSource: string,
  signal: AbortSignal,
  log: (message: string) => void,
): Promise<void> {
  // Before the first block a pass has no height to start from (see `reconcile`).
  while (!signal.aborted && (await cursorHeight(db, cursorSource).catch(() => null)) === null) {
    await pause(FIRST_BLOCK_POLL_MS, signal);
  }
  while (!signal.aborted) {
    try {
      await reconcile(db, client, { cursorSource, log, signal });
    } catch (error) {
      if (!signal.aborted) log(`WARN reconcile: failed (${describe(error)})`);
    }
    await pause(RECONCILE_EVERY_MS, signal);
  }
}

/** Waits `ms`, or until `signal` aborts. */
async function pause(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await delay(ms, undefined, { signal });
  } catch {
    // aborted
  }
}

/**
 * What a log line says of an error: one of the indexer's own in full, and of a block that failed,
 * its height besides. Of any other error its name, and its `code` when that is a string (a
 * SQLSTATE, or a system error's such as ECONNREFUSED), but never its message, which can quote the
 * RPC's or neardata's URL, and a URL can hold a key (P03-R16).
 */
function describe(error: unknown): string {
  if (error instanceof ApplyBlockError) return `${describe(error.cause)} at block ${error.height}`;
  if (error instanceof IndexerError) return `${error.name}: ${error.message}`;
  if (!(error instanceof Error)) return typeof error;
  const { code } = error as { code?: unknown };
  return typeof code === "string" ? `${error.name} (code ${code})` : error.name;
}

// ---- the environment --------------------------------------------------------------------------

/** The value of `key`, trimmed; undefined when it is unset or empty (a blank line of `.env`). */
function setting(env: Record<string, string | undefined>, key: string): string | undefined {
  const value = env[key]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function required(env: Record<string, string | undefined>, key: string): string {
  const value = setting(env, key);
  if (value === undefined) throw new Error(`${key} must be set for the indexer`);
  return value;
}

/** `key` as an http or https URL. Its value is never quoted: a URL can hold a key. */
function httpUrl(key: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${key} must be an http or https URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${key} must be an http or https URL`);
  }
  return value;
}

function readConfig(env: Record<string, string | undefined>): Config {
  const network = setting(env, "TENDER_NETWORK");
  if (network === undefined || !Object.hasOwn(NETWORKS, network)) {
    const got = network === undefined ? "it is unset" : `not ${JSON.stringify(network)}`;
    throw new Error(`TENDER_NETWORK must be sandbox, testnet or mainnet, ${got}`);
  }
  const contractId = setting(env, "TENDER_CONTRACT");
  if (contractId === undefined || !AccountIdSchema.safeParse(contractId).success) {
    throw new Error("TENDER_CONTRACT must be the account id of the Tender contract");
  }
  const teamAccounts = (setting(env, "TEAM_ACCOUNTS") ?? "")
    .split(",")
    .map((account) => account.trim())
    .filter((account) => account !== "");
  const notAnAccount = teamAccounts.find((account) => !AccountIdSchema.safeParse(account).success);
  if (notAnAccount !== undefined) {
    const which = JSON.stringify(notAnAccount);
    throw new Error(`TEAM_ACCOUNTS must be account ids separated by commas; ${which} is not one`);
  }
  const poll = setting(env, "INDEXER_POLL_MS");
  if (poll !== undefined && !(/^\d+$/.test(poll) && Number.isSafeInteger(Number(poll)))) {
    throw new Error("INDEXER_POLL_MS must be a whole number of milliseconds");
  }
  return {
    network: network as NetworkId,
    contractId,
    teamAccounts,
    pollMs: poll === undefined ? undefined : Number(poll),
  };
}

/** `value` as a block height: decimal text for a whole number from 1 to 2^64 - 1. */
function blockHeight(value: unknown, what: string): bigint {
  if (typeof value !== "string" || value === "0" || !U64StringSchema.safeParse(value).success) {
    throw new Error(
      `${what} must be a block height, a whole number of at least 1 written in digits`,
    );
  }
  return BigInt(value);
}

/** `INDEXER_START_HEIGHT`, or the `deployHeight` of this contract's deployment record. */
function configuredStart(
  env: Record<string, string | undefined>,
  config: Config,
  deploymentsDir: string,
): Start {
  const fromEnv = setting(env, "INDEXER_START_HEIGHT");
  if (fromEnv !== undefined) {
    return {
      height: blockHeight(fromEnv, "INDEXER_START_HEIGHT"),
      from: "INDEXER_START_HEIGHT",
    };
  }
  const file = join(deploymentsDir, `${config.network}.json`);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { height: null, why: `there is no ${file}`, record: false };
    }
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid JSON`, { cause: error });
  }
  const record = typeof json === "object" && json !== null ? (json as Record<string, unknown>) : {};
  // Another contract's deploy says nothing of where this one's events begin.
  if (record.contract !== config.contractId) {
    const of = typeof record.contract === "string" ? record.contract : "no contract";
    return { height: null, why: `${file} is the record of ${of}`, record: true };
  }
  const from = `deployHeight in ${file}`;
  return { height: blockHeight(record.deployHeight, from), from };
}

function sourceOf(
  env: Record<string, string | undefined>,
  config: Config,
  log: (message: string) => void,
): BlockSource {
  if (config.network === "sandbox") {
    const rpcUrl = httpUrl("NEAR_RPC_URL", required(env, "NEAR_RPC_URL"));
    return createRpcSource({ rpcUrl, pollMs: config.pollMs });
  }
  const baseUrl = setting(env, "NEARDATA_URL") ?? NETWORKS[config.network].neardataUrl;
  if (baseUrl === undefined) throw new Error("NEARDATA_URL must be set for the indexer");
  // The source's lines quote the URLs it asks for, which begin with NEARDATA_URL as it keeps it,
  // with no trailing slash. A URL can hold a key, so the lines name it instead (P03-R16).
  const base = httpUrl("NEARDATA_URL", baseUrl).replace(/\/+$/, "");
  return createNeardataSource({
    baseUrl,
    apiKey: setting(env, "FASTNEAR_API_KEY"),
    pollMs: config.pollMs,
    log: (line) => log(line.replaceAll(base, "NEARDATA_URL")),
  });
}

function clientOf(env: Record<string, string | undefined>, config: Config): ReconcileChain {
  const value =
    config.network === "sandbox" ? required(env, "NEAR_RPC_URL") : setting(env, "NEAR_RPC_URL");
  return new TenderClient({
    network: config.network,
    contractId: config.contractId,
    rpcUrl: value === undefined ? undefined : httpUrl("NEAR_RPC_URL", value),
  });
}
