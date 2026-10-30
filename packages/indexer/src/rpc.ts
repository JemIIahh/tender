import { setTimeout as delay } from "node:timers/promises";
import { receiptsFromTx } from "@tender/client/outcome";
import type { ReceiptOutcome } from "@tender/shared";
import { JsonRpcProvider } from "near-api-js";
import { UnknownBlockError } from "near-api-js/rpc-errors";
import type { BlockSource, IndexedBlock } from "./types";

/** The `tx_root` of a chunk without transactions: 32 zero bytes in base58. */
const EMPTY_TX_ROOT = "11111111111111111111111111111111";

/** A block as the node's `block` method gives it. */
type NodeBlock = Awaited<ReturnType<JsonRpcProvider["viewBlock"]>>;

/**
 * The node has no block for the heights `from` to `to`, though one of them is the parent of block
 * `to + 1`: it has pruned them, or it is behind the node that gave the final height. The source
 * ends rather than skip them, which would lose their events. Nothing from `from` on has come out
 * of it, so a restart from the last block applied reads the run again. That works once a node that
 * is behind has caught up, and fails the same way if the node has pruned the run.
 */
export class BlocksLostError extends Error {
  readonly from: bigint;
  readonly to: bigint;
  /** The height of the parent of block `to + 1`, from `from` to `to`. */
  readonly parent: bigint;

  constructor(from: bigint, to: bigint, parent: bigint) {
    super(
      `the node has no block for heights ${from} to ${to}, but block ${to + 1n} follows ` +
        `block ${parent}: it has pruned them, or is behind`,
    );
    this.name = "BlocksLostError";
    this.from = from;
    this.to = to;
    this.parent = parent;
  }
}

/**
 * A block source that reads over a node's JSON-RPC, for local chains such as the sandbox, which
 * neardata cannot see. It is not a fallback for neardata, and nothing switches to it by itself.
 *
 * For each height it reads the block, then each chunk the block included that has transactions,
 * and for each transaction its status with receipts, waiting until the transaction and all of its
 * receipts are final. That lists every receipt the transaction spawned, with its status and logs,
 * the failed ones too: they come out with status `failure` and the logs they wrote, which
 * `extractEvents` ignores. A node that answers before the transaction is final ends the source
 * with an error: receipts that have not run would show as failures, and their events be lost. The
 * transactions are read one after another, which keeps up on a local chain and would not on the
 * full blocks of a network.
 *
 * A block here holds the receipts of the transactions it included, all of them, though some ran
 * in later blocks, and its `height` and `timestampNs` are the including block's. Neardata puts a
 * receipt in the block it ran in. Either way a receipt is in exactly one block.
 *
 * So `fromHeight` selects transactions by the block that included them: a source that starts at
 * height H does not read the receipts that run at H or later for transactions included before H.
 * Switching to this source from neardata at H would lose them. A switch by hand must start this
 * source at least 30 blocks before H; the idempotent insert of `applyBlock` absorbs the repeats. A
 * switch the other way only repeats receipts.
 *
 * Only blocks up to the last final one are read. When the source has caught up it waits `pollMs`
 * (default 500) and looks at the final height again. Once `signal` aborts it ends without an
 * error and yields nothing more. It looks at the signal before each read, so only the call under
 * way finishes first. near-api-js cannot cancel that call, and retries a failing node for about
 * two minutes.
 *
 * A height that has no block, as when its producer missed the slot, is skipped: the node answers
 * it with an `UnknownBlockError`. But a node answers a block that it has lost the same way, and
 * skipping that would lose its events without a sign. So a run of such heights is skipped only if
 * the block after it has its parent below the run (`prev_height`); if not, the source ends with a
 * `BlocksLostError`. A node that does not give `prev_height` cannot be checked, and its runs are
 * skipped unchecked. The sandbox prunes blocks like this: it keeps only the last few hundred to a
 * thousand, a minute or two's worth, and a node that is not an archive keeps a few days. Start from
 * a height the node still has, and do not fall further behind than it keeps.
 *
 * It starts at `fromHeight`, or at 1 if that is lower. Genesis holds no transactions, and a
 * current node gives it 0 as its `prev_height` (mainnet and testnet give null). On a chain whose
 * genesis is above 0, a scan from 0 would take that 0 for the parent of a lost block.
 *
 * No other error skips a block either: it ends the iteration, as that error.
 */
export function createRpcSource(opts: { rpcUrl: string; pollMs?: number }): BlockSource {
  const provider = new JsonRpcProvider({ url: opts.rpcUrl });
  const pollMs = opts.pollMs ?? 500;
  return {
    async *blocks(fromHeight, signal) {
      let height = fromHeight > 0n ? fromHeight : 1n;
      // The first height of the run of heights without a block that the source is skipping.
      let gapFrom: bigint | null = null;
      while (!signal.aborted) {
        const { header } = await provider.viewBlock({ finality: "final" });
        const finalHeight = BigInt(header.height);
        if (height > finalHeight) {
          await pause(pollMs, signal);
          continue;
        }
        for (; height <= finalHeight; height++) {
          if (signal.aborted) return;
          const block = await viewBlockAt(provider, height);
          if (block === null) {
            gapFrom ??= height;
            continue;
          }
          if (gapFrom !== null) assertNeverHadBlocks(gapFrom, height, block.header.prev_height);
          gapFrom = null;
          const indexed = await indexBlock(provider, block, signal);
          // An abort that came while the block was read keeps it from coming out, whole or not.
          if (indexed === null || signal.aborted) return;
          yield indexed;
        }
      }
    },
  };
}

/** Waits `ms`, or until `signal` aborts. */
async function pause(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await delay(ms, undefined, { signal });
  } catch (error) {
    if (!signal.aborted) throw error;
  }
}

/** The node's block at `height`, or null if it has none. */
async function viewBlockAt(provider: JsonRpcProvider, height: bigint): Promise<NodeBlock | null> {
  try {
    return await provider.viewBlock({ blockId: Number(height) });
  } catch (error) {
    if (error instanceof UnknownBlockError) return null;
    throw error;
  }
}

/**
 * Throws a BlocksLostError unless the heights `from` to `height - 1`, for which the node has no
 * block, never had one. The block at `height` gives the height of its parent: at `from` or later,
 * a block was there and the node has lost it (pruned it, or is behind the node that gave the final
 * height). A node that does not give the parent's height cannot be checked.
 */
function assertNeverHadBlocks(from: bigint, height: bigint, parent: number | null | undefined) {
  if (parent === null || parent === undefined || BigInt(parent) < from) return;
  throw new BlocksLostError(from, height - 1n, BigInt(parent));
}

/**
 * `block` with the receipts of all the transactions that it included, or null if `signal` aborts
 * before they are all read.
 */
async function indexBlock(
  provider: JsonRpcProvider,
  block: NodeBlock,
  signal: AbortSignal,
): Promise<IndexedBlock | null> {
  // Keyed by receipt id, so that a receipt which the status of two transactions both list comes
  // out once. A map keeps the order in which the RPC lists them.
  const receipts = new Map<string, ReceiptOutcome>();
  for (const header of block.chunks) {
    // A block lists the latest chunk of every shard. When its chunk for a shard was missed, that
    // is the one that an earlier block included, with that block's `height_included`, and its
    // transactions belong to that block.
    if (header.height_included !== block.header.height) continue;
    if (header.tx_root === EMPTY_TX_ROOT) continue;
    if (signal.aborted) return null;
    const chunk = await provider.viewChunk(header.chunk_hash);
    for (const tx of chunk.transactions) {
      if (signal.aborted) return null;
      const status = await provider.viewTransactionStatusWithReceipts({
        txHash: tx.hash,
        accountId: tx.signer_id,
        waitUntil: "FINAL",
      });
      // A node, or a proxy that drops `wait_until`, may answer before the receipts have run. They
      // would show as failures, and their events be lost for good.
      if (status.final_execution_status !== "FINAL") {
        throw new Error(
          `the node answered the status of transaction ${tx.hash} as ` +
            `${status.final_execution_status}, not FINAL: its receipts may not have run`,
        );
      }
      for (const receipt of receiptsFromTx(status)) {
        if (!receipts.has(receipt.receiptId)) receipts.set(receipt.receiptId, receipt);
      }
    }
  }
  return {
    height: BigInt(block.header.height),
    timestampNs: BigInt(block.header.timestamp_nanosec),
    receipts: [...receipts.values()],
  };
}
