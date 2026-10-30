import type { ReceiptOutcome } from "@tender/shared";

/**
 * One finalized block, reduced to what the indexer reads: its height, its time in nanoseconds
 * since the epoch, and the outcomes of its receipts. Which receipts these are depends on the
 * source. Neardata gives the receipts that executed in the block. The RPC source gives the whole
 * receipt trees of the transactions the block included, some of whose receipts executed in later
 * blocks (see `createRpcSource`).
 */
export interface IndexedBlock {
  height: bigint;
  timestampNs: bigint;
  receipts: ReceiptOutcome[];
}

/** Yields indexed blocks in strictly ascending height order, from `fromHeight` on, until `signal` aborts. */
export interface BlockSource {
  blocks(fromHeight: bigint, signal: AbortSignal): AsyncIterable<IndexedBlock>;
}
