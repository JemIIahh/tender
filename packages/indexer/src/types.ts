import type { ReceiptOutcome } from "@tender/shared";

/**
 * One finalized block, reduced to what the indexer reads: its height, its time in nanoseconds
 * since the epoch, and the outcome of every receipt that executed in it.
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
