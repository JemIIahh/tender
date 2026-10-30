import { type LocalChain, startLocalChain, TenderClient, TenderError } from "@tender/client";
import { receiptsFromTx } from "@tender/client/outcome";
import { extractEvents, type PostTaskInput, sha256Hex } from "@tender/shared";
import { JsonRpcProvider } from "near-api-js";
import { UnknownBlockError } from "near-api-js/rpc-errors";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createRpcSource, type IndexedBlock } from "../src/index";

// One real nearcore for the file. It makes a block about every 130 ms and, within a minute, starts
// to prune its oldest ones (see the note on createRpcSource).

const REWARD = 1_000_000n;

let chain: LocalChain;
let poster: TenderClient;
let provider: JsonRpcProvider;

beforeAll(async () => {
  chain = await startLocalChain();
  poster = new TenderClient({
    network: chain.network,
    contractId: chain.contractId,
    rpcUrl: chain.rpcUrl,
    signer: chain.accounts.poster,
  });
  provider = new JsonRpcProvider({ url: chain.rpcUrl });
});

afterAll(async () => {
  await chain?.stop();
});

/** A task in the local token, judged by the judge, with four windows of the chain's minimum. */
function taskInput(): PostTaskInput {
  return {
    token: chain.tokenId,
    reward: REWARD,
    briefUri: "ipfs://brief",
    briefHash: sha256Hex("brief"),
    criteriaHash: sha256Hex("criteria"),
    verifier: chain.accounts.judge.accountId,
    commitSecs: 5,
    revealSecs: 5,
    pickSecs: 5,
    fallbackSecs: 5,
  };
}

/**
 * The height to scan from: block 1, or, once the sandbox has pruned its oldest blocks, one that it
 * still has. The source refuses to skip a block that the node has lost, so it must not be asked
 * for one. The margin is for the pruning that goes on between this call and the scan.
 */
async function firstHeight(): Promise<bigint> {
  const { earliest_block_height: earliest } = (await provider.viewNodeStatus()).sync_info;
  return earliest ? BigInt(earliest) + 100n : 1n;
}

/** The TenderError that `call` fails with. Any other outcome fails the test. */
async function failure(call: Promise<unknown>): Promise<TenderError> {
  try {
    await call;
  } catch (error) {
    if (error instanceof TenderError) return error;
    throw error;
  }
  throw new Error("expected the call to fail");
}

/**
 * The blocks of `from` on, up to the first one that `last` accepts. A source that hangs ends with
 * the timeout, or with `signal`, and the test then fails on what it did not see.
 */
async function readBlocks(
  from: bigint,
  last: (block: IndexedBlock) => boolean,
  opts: { signal?: AbortSignal; pollMs?: number } = {},
): Promise<IndexedBlock[]> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(60_000),
    ...(opts.signal ? [opts.signal] : []),
  ]);
  const source = createRpcSource({ rpcUrl: chain.rpcUrl, pollMs: opts.pollMs });
  const blocks: IndexedBlock[] = [];
  for await (const block of source.blocks(from, signal)) {
    blocks.push(block);
    if (last(block)) break;
  }
  return blocks;
}

test("rpc_source_sees_tender_events_including_failures", async () => {
  await poster.deposit(chain.tokenId, REWARD);
  const { taskId } = await poster.postTask(taskInput());
  // The poster may not enter its own task: `commit` runs on the contract and panics with E_AUTH.
  const failed = await failure(poster.commit(taskId, sha256Hex("commitment")));
  expect(failed.code).toBe("E_AUTH");
  if (failed.txHash === undefined) throw new Error("the failed commit has no transaction hash");

  // `send` returned only once the transaction was final, so the last final block has it.
  const final = await poster.finalHeight();
  const from = await firstHeight();
  const blocks = await readBlocks(from, (block) => block.height >= final);

  // The blocks come in strictly ascending order, with the chain's own time.
  expect(blocks[0]?.height).toBeGreaterThanOrEqual(from);
  expect(blocks.at(-1)?.height).toBe(final);
  for (const [i, block] of blocks.entries()) {
    expect(block.timestampNs).toBeGreaterThan(0n);
    const before = blocks[i - 1];
    if (before) {
      expect(block.height).toBeGreaterThan(before.height);
      expect(block.timestampNs).toBeGreaterThan(before.timestampNs);
    }
  }

  // No receipt is read twice.
  const receipts = blocks.flatMap((block) => block.receipts);
  expect(new Set(receipts.map((r) => r.receiptId)).size).toBe(receipts.length);

  // The events of the deposit and of the post are there.
  const events = extractEvents(receipts, chain.contractId);
  expect(events.map((e) => e.event)).toEqual(expect.arrayContaining(["deposit", "task_created"]));

  // The failed commit: the source returns exactly the receipts the RPC lists for that transaction,
  // and the one that ran on the contract failed.
  const oracle = receiptsFromTx(
    await provider.viewTransactionStatusWithReceipts({
      txHash: failed.txHash,
      accountId: chain.accounts.poster.accountId,
      waitUntil: "FINAL",
    }),
  );
  const ids = new Set(oracle.map((r) => r.receiptId));
  expect(receipts.filter((r) => ids.has(r.receiptId))).toEqual(oracle);
  expect(oracle.find((r) => r.executorId === chain.contractId)?.status).toBe("failure");
});

test("rpc_source_follows_the_chain_tip", async () => {
  // Start at the block after the last final one: the source has nothing to read, waits for the
  // chain to make it final, and then reads on as blocks arrive.
  const start = (await poster.finalHeight()) + 1n;
  const stop = new AbortController();
  try {
    const [blocks, sent] = await Promise.all([
      readBlocks(
        start,
        (block) =>
          extractEvents(block.receipts, chain.contractId).some((e) => e.event === "deposit"),
        { signal: stop.signal, pollMs: 50 },
      ),
      poster.deposit(chain.tokenId, 3n),
    ]);

    // The heights run on one by one, so none is skipped while the source follows the tip.
    expect(blocks.map((b) => b.height)).toEqual(blocks.map((_, i) => start + BigInt(i)));
    const receipts = blocks.flatMap((block) => block.receipts);
    expect(receipts).toEqual(expect.arrayContaining(sent.receipts));
    expect(extractEvents(receipts, chain.contractId)).toEqual(sent.events);
  } finally {
    // If the deposit failed, the reader would otherwise run on until its timeout.
    stop.abort();
  }
});

test("a_height_the_node_does_not_have_is_an_UnknownBlockError", async () => {
  // The shape that `createRpcSource` skips on, as a real node and near-api-js 7.4.0 give it.
  const final = (await provider.viewBlock({ finality: "final" })).header.height;
  const error = await provider.viewBlock({ blockId: final + 1_000_000 }).catch((e) => e);
  expect(error).toBeInstanceOf(UnknownBlockError);
});
