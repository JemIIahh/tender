import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { TenderError } from "@tender/client";
import { extractEvents, parseEventLog } from "@tender/shared";
import { NotSyncedYetError, UnknownChunkError } from "near-api-js/rpc-errors";
import { afterEach, expect, test, vi } from "vitest";
import { BlocksLostError, createRpcSource, type IndexedBlock } from "../src/index";
import { eventLine } from "./fixtures/blocks";

// `createRpcSource` against a fake node that speaks JSON-RPC over HTTP, for what a sandbox does not
// produce: a height with no block, a block the node has lost, a chunk from an earlier block, a
// receipt listed twice, an answer from before a transaction is final, a node that never answers,
// and the errors that must not be skipped. rpc.sandbox.test.ts runs the source on a real nearcore.

const EMPTY_TX_ROOT = "11111111111111111111111111111111";
const FAILURE = { Failure: { ActionError: { index: 0, kind: "boom" } } };

// The error bodies of nearcore 2.13.4, as a local node sent them for a height it has no block for
// and for a chunk it does not have. near-api-js 7.4.0 turns the first into an UnknownBlockError and
// the second into an UnknownChunkError. The third has the same envelope with another cause.
const handlerError = (cause: object, data: string) => ({
  name: "HANDLER_ERROR",
  cause,
  code: -32000,
  message: "Server error",
  data,
});
const UNKNOWN_BLOCK = handlerError(
  { info: {}, name: "UNKNOWN_BLOCK" },
  "DB Not Found Error: BLOCK HEIGHT: 2 \n Cause: Unknown",
);
const UNKNOWN_CHUNK = handlerError(
  { info: { chunk_hash: "chunk-b" }, name: "UNKNOWN_CHUNK" },
  "Chunk Missing (unavailable on the node): ChunkHash(`chunk-b`) \n Cause: Unknown",
);
const NOT_SYNCED_YET = handlerError({ info: {}, name: "NOT_SYNCED_YET" }, "Node is not synced yet");

interface Outcome {
  id: string;
  executor: string;
  status: unknown;
  logs?: string[];
}
interface Tx {
  hash: string;
  signer: string;
  outcomes: Outcome[];
}
interface Chunk {
  hash: string;
  /** The height of the block that included it, when that is not the block that lists it. */
  includedAt?: number;
  txs: Tx[];
}
/** The fake node: its final height, and the chunks of each height that has a block. */
interface Chain {
  final: number;
  blocks: Record<number, Chunk[]>;
  /** Heights of `blocks` that the node has lost: it answers UNKNOWN_BLOCK, as for no block. */
  lost?: number[];
  /** A node that leaves `prev_height` out of its block headers. */
  noParentHeight?: boolean;
  /** Errors to answer with, by `<method>:<block height or chunk hash>`. */
  errors?: Record<string, object>;
  /** Holds back every answer about a transaction until this settles. */
  gate?: Promise<void>;
  /** What a transaction's status says it has reached, if not FINAL: a node that answers early. */
  finalExecutionStatus?: string;
}
interface Call {
  method: string;
  params: unknown;
}

const ok = (id: string, executor = "tender.near"): Outcome => ({
  id,
  executor,
  status: { SuccessValue: "" },
});
const tx = (hash: string, ...outcomes: Outcome[]): Tx => ({
  hash,
  signer: `${hash}.near`,
  outcomes,
});
const chunk = (hash: string, ...txs: Tx[]): Chunk => ({ hash, txs });

let closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.map((close) => close()));
  closers = [];
});

/** Serves `chain` on a local port. Returns its URL and the calls it has received. */
async function serve(chain: Chain) {
  const calls: Call[] = [];
  const chunks = () => Object.values(chain.blocks).flat();
  const answer = ({ method, params }: Call): { result: unknown } | { error: object } => {
    if (method === "block") {
      const { finality, block_id: id } = params as { finality?: string; block_id?: number };
      const height = finality === "final" ? chain.final : (id as number);
      const error = chain.errors?.[`block:${height}`];
      if (error) return { error };
      const listed = chain.blocks[height];
      // A lost block is lost to a request by height. The final block is not asked of this node.
      const lost = finality !== "final" && chain.lost?.includes(height);
      if (!listed || lost) return { error: UNKNOWN_BLOCK };
      // The parent is the highest block below, whether the node still has it or not.
      const parent = Math.max(
        0,
        ...Object.keys(chain.blocks)
          .map(Number)
          .filter((h) => h < height),
      );
      return {
        result: {
          author: "validator.near",
          header: {
            height,
            prev_height: chain.noParentHeight ? undefined : parent,
            timestamp_nanosec: `${BigInt(height) * 1_000_000_000n}`,
          },
          chunks: listed.map((c) => ({
            chunk_hash: c.hash,
            height_included: c.includedAt ?? height,
            tx_root: c.txs.length > 0 ? `root-${c.hash}` : EMPTY_TX_ROOT,
          })),
        },
      };
    }
    if (method === "chunk") {
      const [hash] = params as [string];
      const error = chain.errors?.[`chunk:${hash}`];
      if (error) return { error };
      const txs = chunks().find((c) => c.hash === hash)?.txs ?? [];
      return {
        result: {
          author: "validator.near",
          header: {},
          receipts: [],
          transactions: txs.map((t) => ({ hash: t.hash, signer_id: t.signer })),
        },
      };
    }
    if (method === "EXPERIMENTAL_tx_status") {
      const p = params as { tx_hash: string; sender_account_id: string; wait_until: string };
      const target = chunks()
        .flatMap((c) => c.txs)
        .find((t) => t.hash === p.tx_hash && t.signer === p.sender_account_id);
      // The scan reads final blocks, so it asks for the transaction to be final as well.
      if (!target || p.wait_until !== "FINAL") throw new Error(`unexpected ${JSON.stringify(p)}`);
      return {
        result: {
          final_execution_status: chain.finalExecutionStatus ?? "FINAL",
          status: { SuccessValue: "" },
          receipts_outcome: target.outcomes.map((o) => ({
            id: o.id,
            outcome: { executor_id: o.executor, status: o.status, logs: o.logs ?? [] },
          })),
        },
      };
    }
    throw new Error(`unexpected call ${method}`);
  };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (part) => {
      body += part;
    });
    req.on("end", async () => {
      const request = JSON.parse(body);
      const call: Call = { method: request.method, params: request.params };
      calls.push(call);
      if (call.method === "EXPERIMENTAL_tx_status") await chain.gate;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...answer(call) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const { port } = server.address() as AddressInfo;
  return { rpcUrl: `http://127.0.0.1:${port}`, calls };
}

const blockParams = (calls: Call[]) =>
  calls
    .filter((c) => c.method === "block")
    .map((c) => c.params as { finality?: string; block_id?: number });
/** The heights asked for by number. The reads of the final block are not among them. */
const heightsAsked = (calls: Call[]) =>
  blockParams(calls).flatMap((p) => (p.block_id === undefined ? [] : [p.block_id]));
const finalReads = (calls: Call[]) =>
  blockParams(calls).filter((p) => p.finality === "final").length;
const chunksAsked = (calls: Call[]) =>
  calls.filter((c) => c.method === "chunk").map((c) => (c.params as [string])[0]);
/** The hashes of the transactions whose status was asked for. */
const txsAsked = (calls: Call[]) =>
  calls
    .filter((c) => c.method === "EXPERIMENTAL_tx_status")
    .map((c) => (c.params as { tx_hash: string }).tx_hash);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The first `count` blocks of `rpcUrl` from `from`. A source that fails throws here. */
async function take(rpcUrl: string, from: bigint, count: number): Promise<IndexedBlock[]> {
  const blocks: IndexedBlock[] = [];
  for await (const block of createRpcSource({ rpcUrl }).blocks(from, AbortSignal.timeout(4_000))) {
    blocks.push(block);
    if (blocks.length === count) break;
  }
  return blocks;
}

/** What `take` throws. A source that does not fail fails the test. */
async function failure(rpcUrl: string, from: bigint, count: number): Promise<unknown> {
  try {
    await take(rpcUrl, from, count);
  } catch (error) {
    return error;
  }
  throw new Error("expected the source to fail");
}

test("skips_a_height_the_node_has_no_block_for", async () => {
  const { rpcUrl, calls } = await serve({
    final: 4,
    // No block at 2: the node answers UNKNOWN_BLOCK, as for a slot whose producer missed it.
    blocks: {
      1: [chunk("chunk-a", tx("a", ok("r1")))],
      3: [chunk("chunk-c", tx("c", ok("r3")))],
      4: [chunk("chunk-d", tx("d", ok("r4")))],
    },
  });
  expect(await take(rpcUrl, 1n, 3)).toEqual([
    {
      height: 1n,
      timestampNs: 1_000_000_000n,
      receipts: [expect.objectContaining({ receiptId: "r1" })],
    },
    {
      height: 3n,
      timestampNs: 3_000_000_000n,
      receipts: [expect.objectContaining({ receiptId: "r3" })],
    },
    {
      height: 4n,
      timestampNs: 4_000_000_000n,
      receipts: [expect.objectContaining({ receiptId: "r4" })],
    },
  ]);
  expect(heightsAsked(calls)).toEqual([1, 2, 3, 4]);
});

test("does_not_skip_blocks_the_node_has_lost", async () => {
  const empty = [chunk("chunk-empty")];
  const chain: Chain = { final: 4, blocks: { 1: empty, 2: empty, 3: empty, 4: empty } };
  const { rpcUrl, calls } = await serve(chain);

  // The node has lost block 2, and answers for it as for a height that never had a block. Block 3
  // says its parent is block 2, so block 2 is not skipped: the source ends there, not at block 4.
  // The error is a BlocksLostError that says which heights, for a runner to restart on.
  chain.lost = [2];
  const lost = await failure(rpcUrl, 1n, 4);
  expect(lost).toBeInstanceOf(BlocksLostError);
  expect(lost).toMatchObject({ from: 2n, to: 2n, parent: 2n });
  expect((lost as Error).message).toContain(
    "the node has no block for heights 2 to 2, but block 3 follows block 2",
  );
  expect(heightsAsked(calls)).toEqual([1, 2, 3]);

  // The same when it starts at a block that the node has lost, as after a long time away.
  chain.lost = [1, 2];
  const longGone = await failure(rpcUrl, 1n, 4);
  expect(longGone).toBeInstanceOf(BlocksLostError);
  expect(longGone).toMatchObject({ from: 1n, to: 2n, parent: 2n });
  expect((longGone as Error).message).toContain(
    "the node has no block for heights 1 to 2, but block 3 follows block 2",
  );

  // From a block that it still has, the source reads on.
  expect((await take(rpcUrl, 3n, 2)).map((b) => b.height)).toEqual([3n, 4n]);

  // A node that does not say where a block's parent is cannot be checked: the gap is skipped.
  chain.lost = [2];
  chain.noParentHeight = true;
  expect((await take(rpcUrl, 1n, 3)).map((b) => b.height)).toEqual([1n, 3n, 4n]);
});

test("checks_a_gap_that_reaches_the_final_block_when_the_next_one_comes", async () => {
  const empty = [chunk("chunk-empty")];
  // A node behind the one that gave the final height 3 does not have block 3 yet.
  const chain: Chain = { final: 3, blocks: { 1: empty, 2: empty, 3: empty, 4: empty }, lost: [3] };
  const { rpcUrl } = await serve(chain);
  const source = createRpcSource({ rpcUrl, pollMs: 5 });
  const heights: bigint[] = [];
  const reading = (async () => {
    for await (const block of source.blocks(1n, AbortSignal.timeout(4_000))) {
      heights.push(block.height);
      // After block 2 the source skips block 3, and waits for a final block newer than 3.
      if (block.height === 2n) setTimeout(() => (chain.final = 4), 50);
    }
  })();
  // Block 4 comes final, and says that its parent is block 3, which the source skipped.
  await expect(reading).rejects.toThrow("heights 3 to 3, but block 4 follows block 3");
  expect(heights).toEqual([1n, 2n]);
});

test("starts_at_block_1_when_asked_for_block_0", async () => {
  const empty = [chunk("chunk-empty")];
  // A chain whose first block is 5, not 0. As with the genesis block of a current node, the first
  // block gives its parent as height 0. A scan from 0 must not take that for a lost block.
  const { rpcUrl, calls } = await serve({ final: 7, blocks: { 5: empty, 6: empty, 7: empty } });
  expect((await take(rpcUrl, 0n, 3)).map((b) => b.height)).toEqual([5n, 6n, 7n]);
  // Block 0 is never asked for: genesis holds no transactions.
  expect(heightsAsked(calls)).toEqual([1, 2, 3, 4, 5, 6, 7]);
});

test("reads_only_up_to_the_final_block_and_follows_it", async () => {
  const empty = [chunk("chunk-empty")];
  const chain: Chain = { final: 2, blocks: { 1: empty, 2: empty, 3: empty, 4: empty } };
  const { rpcUrl, calls } = await serve(chain);
  const controller = new AbortController();
  const iterator = createRpcSource({ rpcUrl, pollMs: 5 })
    .blocks(1n, controller.signal)
    [Symbol.asyncIterator]();
  expect((await iterator.next()).value?.height).toBe(1n);
  expect((await iterator.next()).value?.height).toBe(2n);

  // Caught up: it looks at the final height again and again, and asks for no block past it.
  const third = iterator.next();
  while (finalReads(calls) < 4) await sleep(5);
  expect(heightsAsked(calls)).toEqual([1, 2]);

  chain.final = 3;
  expect((await third).value?.height).toBe(3n);
  controller.abort();
  expect(heightsAsked(calls)).toEqual([1, 2, 3]);
});

test("reads_the_chunks_a_block_included_that_have_transactions", async () => {
  const { rpcUrl, calls } = await serve({
    final: 5,
    blocks: {
      5: [
        chunk("chunk-empty"),
        // The block lists its shard's latest chunk, which came in block 4 when block 5 missed one.
        { ...chunk("chunk-old", tx("old", ok("old-r"))), includedAt: 4 },
        chunk("chunk-new", tx("new", ok("new-r"))),
      ],
    },
  });
  const [block] = await take(rpcUrl, 5n, 1);
  expect(chunksAsked(calls)).toEqual(["chunk-new"]);
  expect(block?.receipts.map((r) => r.receiptId)).toEqual(["new-r"]);
});

test("returns_each_receipt_once_failed_ones_with_their_logs", async () => {
  // A failed receipt keeps the logs it wrote before it failed, a valid event line among them.
  const deposited = eventLine("deposit");
  const created = eventLine("task_created");
  const logged: Outcome = { ...ok("r1"), logs: [deposited] };
  const failed: Outcome = { id: "r2", executor: "tender.near", status: FAILURE, logs: [created] };
  const { rpcUrl } = await serve({
    final: 1,
    blocks: {
      1: [
        chunk(
          "chunk-a",
          tx("a", logged, failed),
          // A receipt listed again by another transaction comes out once.
          tx("b", failed, ok("r3", "poster.near")),
        ),
      ],
    },
  });
  const [block] = await take(rpcUrl, 1n, 1);
  expect(block?.receipts).toEqual([
    { receiptId: "r1", executorId: "tender.near", status: "success", logs: [deposited] },
    { receiptId: "r2", executorId: "tender.near", status: "failure", logs: [created] },
    { receiptId: "r3", executorId: "poster.near", status: "success", logs: [] },
  ]);
  // The events come from the receipt that succeeded alone. The line of the failed one is a valid
  // event, and counts for none.
  expect(parseEventLog(created)?.event).toBe("task_created");
  const events = extractEvents(block?.receipts ?? [], "tender.near");
  expect(events.map((e) => [e.event, e.receiptId])).toEqual([["deposit", "r1"]]);
});

test("ends_when_the_node_answers_before_the_transaction_is_final", async () => {
  // A node, or a proxy that drops `wait_until`, answers at once. The receipts have not run, so they
  // show as Unknown, which reads as a failure: their events would be lost for good.
  const unrun: Outcome = { id: "r1", executor: "tender.near", status: "Unknown" };
  const { rpcUrl } = await serve({
    final: 2,
    blocks: { 1: [chunk("chunk-a", tx("a", unrun))], 2: [chunk("chunk-empty")] },
    finalExecutionStatus: "INCLUDED",
  });
  const heights: bigint[] = [];
  const reading = (async () => {
    for await (const block of createRpcSource({ rpcUrl }).blocks(1n, AbortSignal.timeout(4_000))) {
      heights.push(block.height);
    }
  })();
  await expect(reading).rejects.toThrow(
    "the status of transaction a as INCLUDED, not FINAL: its receipts may not have run",
  );
  // The block is not handed over with receipts that are failures only in appearance.
  expect(heights).toEqual([]);
});

test("an_error_that_is_not_an_unknown_block_ends_the_source_and_skips_nothing", async () => {
  const chain: Chain = {
    final: 4,
    blocks: {
      1: [chunk("chunk-a", tx("a", ok("r1")))],
      2: [chunk("chunk-b", tx("b", ok("r2")))],
      3: [chunk("chunk-c")],
      4: [chunk("chunk-d")],
    },
    errors: { "chunk:chunk-b": UNKNOWN_CHUNK, "block:3": NOT_SYNCED_YET },
  };
  const { rpcUrl, calls } = await serve(chain);
  const source = createRpcSource({ rpcUrl });
  const heights: bigint[] = [];
  const read = async (from: bigint) => {
    for await (const block of source.blocks(from, AbortSignal.timeout(4_000))) {
      heights.push(block.height);
    }
  };

  // Block 2 has a chunk that the node does not have. The source ends there, with that error: it
  // does not go on to block 3.
  await expect(read(1n)).rejects.toBeInstanceOf(UnknownChunkError);
  expect(heights).toEqual([1n]);
  expect(heightsAsked(calls)).toEqual([1, 2]);

  // Block 3 cannot be read yet, which is not the same as having no block. It is not skipped.
  delete chain.errors?.["chunk:chunk-b"];
  heights.length = 0;
  await expect(read(2n)).rejects.toBeInstanceOf(NotSyncedYetError);
  expect(heights).toEqual([2n]);
  expect(heightsAsked(calls)).not.toContain(4);
});

test("stops_on_abort_without_an_error", async () => {
  const { rpcUrl, calls } = await serve({ final: 1, blocks: { 1: [chunk("chunk-empty")] } });
  const source = createRpcSource({ rpcUrl, pollMs: 60_000 });

  // Aborted from the start: nothing is read.
  const aborted = new AbortController();
  aborted.abort();
  const none: IndexedBlock[] = [];
  for await (const block of source.blocks(1n, aborted.signal)) none.push(block);
  expect(none).toEqual([]);
  expect(calls).toEqual([]);

  // Aborted while it waits to poll again, with a long poll interval: it ends at once.
  const controller = new AbortController();
  const iterator = source.blocks(1n, controller.signal)[Symbol.asyncIterator]();
  expect((await iterator.next()).value?.height).toBe(1n);
  const next = iterator.next();
  while (finalReads(calls) < 2) await sleep(5);
  controller.abort();
  expect(await next).toEqual({ done: true, value: undefined });
});

test("nothing_comes_out_after_the_abort", async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { rpcUrl, calls } = await serve({
    final: 1,
    blocks: { 1: [chunk("chunk-a", tx("a", ok("r1")))] },
    gate,
  });
  const controller = new AbortController();
  const next = createRpcSource({ rpcUrl })
    .blocks(1n, controller.signal)
    [Symbol.asyncIterator]()
    .next();

  // The abort comes while the source waits for the transaction's status. Once that arrives, the
  // block is complete, and the source still does not hand it over.
  while (!calls.some((c) => c.method === "EXPERIMENTAL_tx_status")) await sleep(5);
  controller.abort();
  release();
  expect(await next).toEqual({ done: true, value: undefined });
});

test("stops_between_the_transactions_of_a_block_when_aborted", async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { rpcUrl, calls } = await serve({
    final: 1,
    blocks: { 1: [chunk("chunk-a", tx("a", ok("r1")), tx("b", ok("r2")))] },
    gate,
  });
  const controller = new AbortController();
  const next = createRpcSource({ rpcUrl })
    .blocks(1n, controller.signal)
    [Symbol.asyncIterator]()
    .next();

  // The abort comes while the source waits for the first transaction's status. It does not go on
  // to ask for the second's.
  while (txsAsked(calls).length === 0) await sleep(5);
  controller.abort();
  release();
  expect(await next).toEqual({ done: true, value: undefined });
  expect(txsAsked(calls)).toEqual(["a"]);
});

test("a_node_that_takes_a_read_and_never_answers_ends_the_source_with_E_TIMEOUT", async () => {
  // Not `serve`: this node is no chain. It takes a request and leaves it without an answer.
  const hits: Array<{ method: string; closed: boolean }> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (part) => {
      body += part;
    });
    req.on("end", () => {
      const hit = { method: JSON.parse(body).method as string, closed: false };
      res.on("close", () => {
        hit.closed = true;
      });
      hits.push(hit);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const rpcUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const source = createRpcSource({ rpcUrl, rpcTimeoutMs: 300 });
  const started = performance.now();
  const error = await source
    .blocks(1n, AbortSignal.timeout(10_000))
    [Symbol.asyncIterator]()
    .next()
    .then(
      () => undefined,
      (failed: unknown) => failed,
    );

  // The source ends with the read's own error, once the time is out and not before, and it names
  // the read, not the node.
  expect(performance.now() - started).toBeGreaterThanOrEqual(250);
  expect(error).toBeInstanceOf(TenderError);
  expect(error).toMatchObject({ code: "E_TIMEOUT" });
  const message = (error as Error).message;
  expect(message).toBe("RPC block source viewBlock timed out after 300 ms");
  expect(message).not.toContain("127.0.0.1");

  // The request was cancelled, its connection with it, and the source asked for nothing else.
  await vi.waitFor(() => expect(hits[0]?.closed).toBe(true));
  expect(hits.map((hit) => hit.method)).toEqual(["block"]);
});

test("rejects_a_read_time_that_is_not_a_whole_number_of_milliseconds", () => {
  const rpcUrl = "http://127.0.0.1:1";
  const bad = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648];
  for (const rpcTimeoutMs of bad) {
    expect(() => createRpcSource({ rpcUrl, rpcTimeoutMs }), String(rpcTimeoutMs)).toThrow(
      RangeError,
    );
  }
  expect(() => createRpcSource({ rpcUrl, rpcTimeoutMs: 0 })).toThrow(
    "createRpcSource: rpcTimeoutMs must be a whole number of milliseconds from 1 to 2147483647, not 0",
  );
  // The ends of the range, and no time given, are taken.
  for (const rpcTimeoutMs of [1, 30_000, 2_147_483_647, undefined]) {
    expect(() => createRpcSource({ rpcUrl, rpcTimeoutMs }), String(rpcTimeoutMs)).not.toThrow();
  }
});
