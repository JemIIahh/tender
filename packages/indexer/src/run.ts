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
 *   No lifetime HTTP request cap is imposed. Provider access errors retry with backoff.
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
  const start = startOf(env, config, opts.deploymentsDir);
  const client = opts.client ?? clientOf(env, config);
  const { db } = opts;
  let openDatabase: () => Promise<Db>;
  if (db === undefined) {
    const url = required(env, "DATABASE_URL");
    openDatabase = () => openIndex(url);
  } else {
    openDatabase = async () => db;
  }
  if (setting(env, "INDEXER_MAX_REQUESTS") !== undefined)
    log(
      "WARN indexer: INDEXER_MAX_REQUESTS is retired and ignored; monitor provider usage and lag. No lifetime request cap is applied.",
    );
  const source = opts.source ?? sourceOf(env, config, log);

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

/**
 * Throws what `startIndexer` throws for a setting or a deployment record of `env` that is missing
 * or wrong, and starts nothing. The services call it before they open anything, so that a start
 * that cannot work fails at once, though the indexer starts only after the database has been
 * checked against the chain (`checkAgainstChain`).
 */
export function checkIndexerEnv(
  env: Record<string, string | undefined>,
  opts: Pick<StartIndexerOptions, "deploymentsDir"> = {},
): void {
  const config = readConfig(env);
  startOf(env, config, opts.deploymentsDir);
  sourceOf(env, config, () => undefined);
  clientOf(env, config);
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

/** The most other sources `checkCursorSource` names. */
const SOURCES_NAMED = 3;

/**
 * Refuses a database whose chain cursor is for another deploy of Tender than `deploy`: one
 * database serves one contract deploy. The tables of the index are not keyed by contract, so a
 * second contract on the same database would project its events onto the first one's rows, and the
 * keeper and the Judge would act on them. It throws an `IndexerError` that says "one database per
 * contract deploy" when `chain_cursor` holds a row for any source but `<network>:<contractId>`.
 *
 * It asks nothing of the chain, so the services make it at their start, before anything serves
 * from the database. `checkAgainstChain` is the half that needs the chain.
 */
export async function checkCursorSource(
  db: Db,
  deploy: { network: string; contractId: string },
): Promise<void> {
  const own = cursorSourceOf(deploy);
  const others = await db.query<{ source: string }>(
    "select source from chain_cursor where source <> $1 order by source limit $2",
    [own, SOURCES_NAMED + 1],
  );
  if (others.length === 0) return;
  const named = others.slice(0, SOURCES_NAMED).map(({ source }) => JSON.stringify(source));
  const more = others.length > SOURCES_NAMED ? " and others" : "";
  throw new IndexerError(
    `the database holds the index of another deploy of Tender: its chain cursor is for ` +
      `${named.join(", ")}${more}, and this deploy is ${JSON.stringify(own)}. A database ` +
      "serves one contract deploy: use a new database for this one (one database per " +
      "contract deploy)",
  );
}

/** The reads of the chain that `checkAgainstChain` makes. */
export type DeploymentChain = Pick<
  ReconcileChain,
  "network" | "contractId" | "finalHeight" | "taskCount"
>;

export interface CheckAgainstChainOptions {
  /** Ends the waiting, and the check with it: it then resolves false. */
  signal?: AbortSignal;
  /** Told of each wait, with why it waits and for how many milliseconds. */
  onWait?: (why: string, retryMs: number) => void;
  /** The first wait, in milliseconds. It doubles with each wait, up to `longestMs`. Default 2000. */
  retryMs?: number;
  /** The longest wait, in milliseconds. Default 30000. */
  longestMs?: number;
  /**
   * How many blocks apart the node and the index may be before a difference counts as the
   * database's. Default 20 off the sandbox, as in reconcile: the final height and a view come
   * from a load-balanced RPC, whose nodes can be some blocks apart, and the index follows
   * neardata. On the sandbox it is 0: the node is the index's own source.
   */
  skewBlocks?: bigint;
  /**
   * How many blocks the node's final block may be below the index's cursor before no lag
   * explains it. Default 100000 off the sandbox, about 16 hours of blocks; on the sandbox 0, where
   * any block below the cursor is another chain. A gap over a limit above 0 is refused only when
   * `MISMATCH_ROUNDS` rounds in a row find it, since the final height can come from a node of a
   * load-balanced RPC that has just restarted or is syncing; with a limit of 0 one read is enough.
   */
  lagLimitBlocks?: bigint;
  /**
   * The least time between two `onWait` calls about a node that is behind the index, in
   * milliseconds. Default 60000: that wait goes on for as long as the node takes, and says so once
   * a minute.
   */
  behindWarnMs?: number;
}

const CHECK_FIRST_WAIT_MS = 2_000;
const CHECK_LONGEST_WAIT_MS = 30_000;
const SKEW_BLOCKS = 20n;
const LAG_LIMIT_BLOCKS = 100_000n;
const BEHIND_WARN_MS = 60_000;
/** How many rounds in a row must find the task count short before the database is refused. */
const MISMATCH_ROUNDS = 2;

/** What the refusal on a task count says first: the node is the likelier cause. */
const NODE_BEHIND =
  "Either the node at NEAR_RPC_URL is behind the chain: wait for it, or point NEAR_RPC_URL at " +
  "another node, and start the services again.";
/** What the refusals say of the database that is refused: it is not to be thrown away. */
const KEEP_DATABASE =
  "keep the old one: it holds uploads, sign-ins and Telegram links that cannot be rebuilt from " +
  "the chain";

/**
 * Checks the database against the chain before the indexer, the keeper and the Judge start on it.
 * One database serves one contract deploy, and a database that holds another's index would have
 * this deploy's events projected onto it, and the keeper and the Judge act on them. Two things
 * give it away, and both are read from the node, which can be down or behind:
 *
 * - the highest task id in `tasks` is above the number of tasks the contract has made
 *   (`taskCount()`), as with a contract account that was deleted and made again, which counts its
 *   tasks from 1;
 * - the cursor is far above the node's final height, as with a new chain under the same contract
 *   name (a sandbox that was started afresh), or with a `NEAR_RPC_URL` of another network: the
 *   indexer would resume after the old cursor, and skip the new chain's blocks below it.
 *
 * It resolves true once the database matches the chain, or holds nothing to check (no task and no
 * cursor: the chain is not asked), and false if `signal` aborts first. It throws an `IndexerError`
 * for a mismatch it is sure of, and for nothing else. What it waits for, with `onWait` told:
 *
 * - A read that fails, of the node or of the database, is made again after a wait that doubles
 *   from `retryMs` to `longestMs`, for as long as it takes.
 * - A node whose final height is below the cursor by more than `skewBlocks` is behind, and is
 *   waited for, for as long as it takes: nothing writes meanwhile. The wait is told once in
 *   `behindWarnMs`, with the gap. Only a gap that no lag explains, over `lagLimitBlocks`, is
 *   refused, as a node of another network (on the sandbox, any gap, as a new chain). Off the
 *   sandbox that takes `MISMATCH_ROUNDS` rounds in a row, as a short count does; on the sandbox,
 *   where the node is the index's own source, one read.
 * - A count below the highest task id is a mismatch when the node's final height, read before the
 *   count, is `skewBlocks` or more past the cursor: a node that has seen every block the index took
 *   has seen its tasks. A node short of that is behind. Even then the count is taken for the
 *   chain's only when it has come out short on `MISMATCH_ROUNDS` rounds in a row, each of fresh
 *   reads, since the final height and the count can come from two nodes of a load-balanced RPC.
 *
 * A refusal names the likely causes in order: the node (behind, or of another network), and then
 * that the database is another deploy's, which needs a new one. It never advises to discard the
 * database: it holds records that cannot be rebuilt from the chain.
 */
export async function checkAgainstChain(
  db: Db,
  chain: DeploymentChain,
  options: CheckAgainstChainOptions = {},
): Promise<boolean> {
  const signal = options.signal ?? new AbortController().signal;
  const sandbox = chain.network === "sandbox";
  const skew = options.skewBlocks ?? (sandbox ? 0n : SKEW_BLOCKS);
  const lagLimit = options.lagLimitBlocks ?? (sandbox ? 0n : LAG_LIMIT_BLOCKS);
  const behindWarnMs = options.behindWarnMs ?? BEHIND_WARN_MS;
  const longestMs = options.longestMs ?? CHECK_LONGEST_WAIT_MS;
  let waitMs = options.retryMs ?? CHECK_FIRST_WAIT_MS;

  /** Tells why unless `quiet`, waits, and says whether the check goes on: not once `signal` aborts. */
  const wait = async (why: string, quiet = false): Promise<boolean> => {
    if (!quiet) options.onWait?.(why, waitMs);
    await pause(waitMs, signal);
    waitMs = Math.min(waitMs * 2, longestMs);
    return !signal.aborted;
  };

  // What the database holds, which nothing changes while this waits: the indexer has not started.
  let held: { cursor: bigint | null; highest: bigint | null } | undefined;
  while (held === undefined) {
    if (signal.aborted) return false;
    try {
      const cursor = await cursorHeight(db, cursorSourceOf(chain));
      const [row] = await db.query<{ id: string | null }>("select max(id)::text as id from tasks");
      held = { cursor, highest: row === undefined || row.id === null ? null : BigInt(row.id) };
    } catch (error) {
      if (!(await wait(`cannot read the database (${describe(error)})`))) return false;
    }
  }
  const { cursor, highest } = held;
  if (cursor === null && highest === null) return true;
  const indexed = cursor ?? 0n;

  /**
   * What the rounds in a row have found, and how many: a gap that no lag explains, or a count that
   * is short. A round that finds another thing, or nothing wrong, starts the tally again.
   */
  let tally: { found: "far" | "short"; rounds: number } | undefined;
  const found = (what: "far" | "short"): number => {
    tally =
      tally?.found === what
        ? { found: what, rounds: tally.rounds + 1 }
        : { found: what, rounds: 1 };
    return tally.rounds;
  };
  let toldBehindAt: number | undefined;
  for (;;) {
    // The final height first: the count is then read at a block at least as late as it.
    let final: bigint;
    try {
      final = await chain.finalHeight();
    } catch (error) {
      tally = undefined;
      if (!(await wait(`cannot read the final block (${describe(error)})`))) return false;
      continue;
    }

    if (cursor !== null && cursor > final + skew) {
      const gap = cursor - final;
      if (gap > lagLimit) {
        // No lag explains it. Where none is tolerated, as on the sandbox, the node is the index's
        // own source and one read says so. Elsewhere the final height can come from a node of a
        // load-balanced RPC that has just restarted or is syncing, so it is read again first.
        const reads = lagLimit === 0n ? 1 : MISMATCH_ROUNDS;
        if (found("far") >= reads) {
          throw new IndexerError(farBehindWords(chain, cursor, final, reads));
        }
        const why =
          `the final block of the node, ${final}, is ${blocks(gap)} below the last block the ` +
          `index took, ${cursor}, more than any lag explains: reading again before the node is ` +
          "taken for one of another network";
        if (!(await wait(why))) return false;
        continue;
      }
      // The node is behind. Nothing writes while it is waited for, so it is waited for, and said so
      // once a minute.
      tally = undefined;
      const now = Date.now();
      const tell = toldBehindAt === undefined || now - toldBehindAt >= behindWarnMs;
      if (tell) toldBehindAt = now;
      const why =
        `the final block of the node, ${final}, is ${blocks(gap)} below the last block the index ` +
        `took, ${cursor}: the node is behind, and is waited for`;
      if (!(await wait(why, !tell))) return false;
      continue;
    }

    if (highest === null) return true;
    let count: bigint;
    try {
      count = await chain.taskCount();
    } catch (error) {
      tally = undefined;
      if (!(await wait(`cannot read the task count (${describe(error)})`))) return false;
      continue;
    }
    if (highest <= count) return true;
    if (final >= indexed + skew) {
      if (found("short") >= MISMATCH_ROUNDS) {
        throw new IndexerError(
          `the database holds task ${highest}, but ${chain.contractId} has made ${count} on ` +
            `${chain.network}, as read at its final block ${final}, past the last block the index ` +
            `took (${indexed}), on ${MISMATCH_ROUNDS} reads in a row. ${NODE_BEHIND} Or the ` +
            "database is the index of another contract or chain, or of an earlier deploy of this " +
            "contract (an account that was deleted and made again counts its tasks from 1): use a " +
            `new database for this deploy (one database per contract deploy); ${KEEP_DATABASE}`,
        );
      }
      const why =
        `the node counts ${count} tasks, fewer than the ${highest} the database holds, though ` +
        `its final block, ${final}, is past the last block the index took, ${indexed}: reading ` +
        "again before the database is taken for another deploy's";
      if (!(await wait(why))) return false;
      continue;
    }
    tally = undefined;
    const why =
      `the node counts ${count} tasks, fewer than the ${highest} the database holds, and its ` +
      `final block, ${final}, is too near the last block the index took, ${indexed}, to tell ` +
      "whether it is behind";
    if (!(await wait(why))) return false;
  }
}

/** "1 block", "20 blocks". */
const blocks = (n: bigint) => `${n} block${n === 1n ? "" : "s"}`;

/**
 * What the check says of a node that is further below the cursor than any lag explains, as `reads`
 * reads in a row have found it.
 */
function farBehindWords(
  chain: DeploymentChain,
  cursor: bigint,
  final: bigint,
  reads: number,
): string {
  const sandbox = chain.network === "sandbox";
  const where =
    `the index took block ${cursor}, but the final block of ${chain.network} at the node is ` +
    `${final}, ${blocks(cursor - final)} below it${reads > 1 ? `, on ${reads} reads in a row` : ""}.`;
  const node = sandbox
    ? NODE_BEHIND
    : "No lag explains a gap that size: the node at NEAR_RPC_URL is most likely on another " +
      `network than ${chain.network}. Point NEAR_RPC_URL at a ${chain.network} node, and start ` +
      "the services again.";
  const fresh =
    `Or this is a new chain under the contract name ${chain.contractId}` +
    `${sandbox ? " (a sandbox that was started afresh, say)" : ""}, and the database holds the ` +
    "index of the old one: a new chain under this contract name needs a new database (one " +
    `database per contract deploy); ${KEEP_DATABASE}`;
  return `${where} ${node} ${fresh}`;
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

/**
 * Where the indexer starts, as configured. Off the sandbox it throws, naming `INDEXER_START_HEIGHT`,
 * when neither that nor a deployment record of this contract gives a height.
 */
function startOf(
  env: Record<string, string | undefined>,
  config: Config,
  deploymentsDir: string = DEPLOYMENTS_DIR,
): Start {
  const start = configuredStart(env, config, deploymentsDir);
  if (start.height === null && config.network !== "sandbox") {
    throw new Error(
      `no height to start indexing ${config.network} from: set INDEXER_START_HEIGHT (${start.why})`,
    );
  }
  return start;
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
  const apiKey = setting(env, "FASTNEAR_API_KEY");
  return createNeardataSource({
    baseUrl,
    apiKey,
    // Public access is limited to 180 requests/minute per IP. Without a key, the source starts a
    // request at most every 400 ms (150 a minute), retries included; a final-height poll, which
    // neardata redirects to the block, takes two of those slots, and so does any other redirect.
    minRequestIntervalMs: apiKey === undefined ? 400 : 0,
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
