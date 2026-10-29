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
