import { receiptsFromTx, type TxReceiptsOutcome } from "@tender/client/outcome";
import type { BlockSource, IndexedBlock } from "./types";

export interface NeardataOptions {
  /** The API root, such as `https://testnet.neardata.xyz`. */
  baseUrl: string;
  /** A FastNEAR API key, sent as `Authorization: Bearer <key>`. Empty means none. */
  apiKey?: string;
  /** How many blocks are fetched at once. Default 4. */
  concurrency?: number;
  /** Milliseconds to wait, once caught up, before asking for a newer final block. Default 1000. */
  pollMs?: number;
  /** For tests. Default: the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Told about every failed request, just before it is tried again. */
  log?: (message: string) => void;
}

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_POLL_MS = 1000;
/** A request not answered in this long, body included, is given up and tried again. */
const REQUEST_TIMEOUT_MS = 10_000;
/** The wait after a first failure. It doubles with each failure in a row, up to `LONGEST_WAIT_MS`. */
const FIRST_WAIT_MS = 500;
const LONGEST_WAIT_MS = 8000;

/** What a fetch gives when the source was stopped before it could finish. */
const STOPPED = Symbol("stopped");
type Stopped = typeof STOPPED;

/**
 * A block source that reads finalized blocks from the NEAR Data API (neardata.xyz).
 *
 * `blocks(from, signal)` asks for the final height (`GET /v0/last_block/final`), fetches the
 * heights from `from` to it (`GET /v0/block/{height}`) `concurrency` at a time, and yields them in
 * height order, whatever order they arrive in. A fetch is started as soon as a place in the window
 * is free, so at most `concurrency` blocks are in flight or waiting to be yielded. When it has
 * yielded up to the final height it asks for it again: if that shows nothing new it waits `pollMs`
 * and asks once more, and so on until a newer block is final.
 *
 * A block is left out only when neardata says there is none at that height (see `blockAt`). Every
 * other failure is retried, after a wait of 0.5, 1, 2, 4, 8, 8... s, for as long as `signal` has
 * not aborted: an HTTP error of any status, a network error, no answer in 10 s, an answer that is
 * not a block or not the block asked for. Not getting a block shows as lag, never as a gap.
 *
 * When `signal` aborts, the iteration ends (it does not throw) and the requests in flight are
 * cancelled. They are too when the caller leaves its loop early.
 */
export function createNeardataSource(opts: NeardataOptions): BlockSource {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.log;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(`concurrency must be a whole number of at least 1, got ${concurrency}`);
  }
  if (!Number.isFinite(pollMs) || pollMs < 0) {
    throw new RangeError(`pollMs must be 0 or more, got ${pollMs}`);
  }
  const headers: Record<string, string> = opts.apiKey
    ? { Authorization: `Bearer ${opts.apiKey}` }
    : {};

  /**
   * The JSON body of `GET url`. Throws on a status that is not 2xx, a body that is not JSON, and
   * no answer in time.
   */
  async function getJson(url: string, stop: AbortSignal): Promise<unknown> {
    // This request's own signal: aborted when the source is stopped, or when the time is up.
    const request = new AbortController();
    const abort = () => request.abort();
    stop.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, REQUEST_TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, { headers, signal: request.signal });
      if (!res.ok) {
        // Not reading the body would keep the connection busy until it is collected.
        await res.body?.cancel().catch(() => undefined);
        throw new Error(`HTTP ${res.status}`);
      }
      return await res.json();
    } catch (error) {
      if (request.signal.aborted && !stop.aborted) {
        throw new Error(`no answer in ${REQUEST_TIMEOUT_MS / 1000} s`, { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timer);
      stop.removeEventListener("abort", abort);
    }
  }

  /**
   * What `read` makes of the JSON at `url`, trying again for as long as anything goes wrong in
   * getting it or in `read`. STOPPED if `stop` aborts first.
   */
  async function fetchUntilRead<T>(
    url: string,
    stop: AbortSignal,
    read: (json: unknown) => T,
  ): Promise<T | Stopped> {
    for (let failures = 0; !stop.aborted; failures++) {
      try {
        return read(await getJson(url, stop));
      } catch (error) {
        if (stop.aborted) break;
        const wait = Math.min(FIRST_WAIT_MS * 2 ** failures, LONGEST_WAIT_MS);
        log?.(`neardata: GET ${url} failed (${reasonOf(error)}); retrying in ${wait} ms`);
        await sleep(wait, stop);
      }
    }
    return STOPPED;
  }

  const fetchFinalHeight = (stop: AbortSignal) =>
    fetchUntilRead(`${baseUrl}/v0/last_block/final`, stop, finalHeightOf);

  const fetchBlock = (height: bigint, stop: AbortSignal) =>
    fetchUntilRead(`${baseUrl}/v0/block/${height}`, stop, (json) => blockAt(height, json));

  async function* blocks(
    fromHeight: bigint,
    signal: AbortSignal,
  ): AsyncGenerator<IndexedBlock, void, undefined> {
    if (signal.aborted) return;
    // `stop` is what every request and wait below listens to. It aborts with `signal`, and also
    // when the caller leaves the loop early, so that nothing is left running behind it.
    const stop = new AbortController();
    const abort = () => stop.abort();
    signal.addEventListener("abort", abort, { once: true });
    try {
      let next = fromHeight;
      while (!stop.signal.aborted) {
        const final = await fetchFinalHeight(stop.signal);
        if (final === STOPPED) return;
        if (final < next) {
          await sleep(pollMs, stop.signal);
          continue;
        }

        // The heights next..final. `queue` holds the requests for the first `concurrency` of
        // those that are not yielded yet, lowest height first. The head stays in it while it is
        // awaited, so `concurrency` caps the requests in flight, and a place frees up only when
        // the head has come: blocks that arrive early wait for the ones before them.
        const queue: Array<Promise<IndexedBlock | null | Stopped>> = [];
        let requested = next;
        const refill = () => {
          while (queue.length < concurrency && requested <= final) {
            const request = fetchBlock(requested, stop.signal);
            // Nothing but a throwing `log` can reject it. This way that surfaces where the request
            // is awaited, in order, and not as an unhandled rejection while it waits behind the head.
            request.catch(() => undefined);
            queue.push(request);
            requested += 1n;
          }
        };
        refill();
        for (let head = queue[0]; head !== undefined; head = queue[0]) {
          const block = await head;
          queue.shift();
          if (block === STOPPED || stop.signal.aborted) return;
          // Before the yield, so that the next request is under way while the caller uses `block`.
          refill();
          if (block !== null) yield block;
        }
        next = final + 1n;
      }
    } finally {
      signal.removeEventListener("abort", abort);
      stop.abort();
    }
  }

  return { blocks };
}

/** Resolves after `ms`, or as soon as `stop` aborts. The caller checks `stop.aborted` after it. */
function sleep(ms: number, stop: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (stop.aborted) return resolve();
    const wake = () => {
      clearTimeout(timer);
      stop.removeEventListener("abort", wake);
      resolve();
    };
    const timer = setTimeout(wake, ms);
    stop.addEventListener("abort", wake, { once: true });
  });
}

function reasonOf(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  // `fetch failed` alone does not say why; the reason is in the cause.
  return error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message;
}

// ---- reading what neardata sends --------------------------------------------------------------
//
// A block is read strictly: a response that does not have the shape below is an error, and so is
// tried again, not guessed at. A receipt read wrongly is an event lost, and a lost event is wrong
// balances. Fields the source does not read are not looked at.

type Json = Record<string, unknown>;

function malformed(problem: string): Error {
  return new Error(`not a neardata block: ${problem}`);
}

function object(value: unknown, what: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw malformed(`${what} is not an object`);
  }
  return value as Json;
}

function array(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw malformed(`${what} is not an array`);
  return value;
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string") throw malformed(`${what} is not a string`);
  return value;
}

/** A block height, which neardata writes as a JSON number. */
function heightField(value: unknown, what: string): bigint {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw malformed(`${what} is not a block height`);
  }
  return BigInt(value);
}

function headerOf(root: Json): Json {
  return object(object(root.block, "block").header, "block.header");
}

/** The height of the block `GET /v0/last_block/final` answers with. */
function finalHeightOf(json: unknown): bigint {
  return heightField(headerOf(object(json, "the response")).height, "block.header.height");
}

/** One of `receipt_execution_outcomes`, as `receiptsFromTx` takes it: `execution_outcome` is a `receipts_outcome` entry. */
function executionOutcome(
  entry: unknown,
  where: string,
): TxReceiptsOutcome["receipts_outcome"][number] {
  const at = `${where}.execution_outcome`;
  const executed = object(object(entry, where).execution_outcome, at);
  const outcome = object(executed.outcome, `${at}.outcome`);
  return {
    id: text(executed.id, `${at}.id`),
    outcome: {
      executor_id: text(outcome.executor_id, `${at}.outcome.executor_id`),
      status: outcome.status,
      logs: array(outcome.logs, `${at}.outcome.logs`).map((line, i) =>
        text(line, `${at}.outcome.logs[${i}]`),
      ),
    },
  };
}

interface ReadBlock {
  height: bigint;
  /** The height of the block before it, null if the response does not say. */
  prevHeight: bigint | null;
  indexed: IndexedBlock;
}

function readBlock(json: unknown): ReadBlock {
  const root = object(json, "the response");
  const header = headerOf(root);
  const height = heightField(header.height, "block.header.height");
  const prevHeight =
    header.prev_height === undefined || header.prev_height === null
      ? null
      : heightField(header.prev_height, "block.header.prev_height");
  // The `timestamp` beside it is a JSON number, which JSON.parse cannot hold exactly at 1.7e18.
  const timestamp = text(header.timestamp_nanosec, "block.header.timestamp_nanosec");
  if (!/^\d+$/.test(timestamp)) throw malformed("block.header.timestamp_nanosec is not a number");

  // The receipts of the shards in the order of `shards`, each shard's in its own order.
  const outcomes = array(root.shards, "shards").flatMap((shard, s) => {
    const where = `shards[${s}].receipt_execution_outcomes`;
    return array(object(shard, `shards[${s}]`).receipt_execution_outcomes, where).map((entry, r) =>
      executionOutcome(entry, `${where}[${r}]`),
    );
  });
  return {
    height,
    prevHeight,
    indexed: {
      height,
      timestampNs: BigInt(timestamp),
      receipts: receiptsFromTx({ receipts_outcome: outcomes }),
    },
  };
}

/**
 * The block that neardata answered `GET /v0/block/{height}` with, or null if there is no block at
 * `height`. Throws if the answer cannot be trusted to be the block at `height`.
 *
 * Neardata says a height has no block (the chain skipped it) with a JSON `null`. The design notes
 * (spec 7.1) add that such a height may redirect instead, and a redirect that lands on the block
 * after the skipped height shows up here as that block. It counts as a skip only if the chain
 * agrees: the block comes later than `height`, and its parent is earlier than `height`, so that
 * nothing lies between them. Any other block than the one asked for is not yielded and not
 * skipped, but asked for again.
 */
function blockAt(height: bigint, json: unknown): IndexedBlock | null {
  if (json === null) return null;
  const block = readBlock(json);
  if (block.height === height) return block.indexed;
  if (block.height > height && block.prevHeight !== null && block.prevHeight < height) return null;
  throw new Error(`asked for block ${height} and got block ${block.height}`);
}
