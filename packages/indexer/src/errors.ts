/**
 * An error of the indexer's own. A log line may quote its message, which the indexer wrote and
 * which holds no URL. Not so the message of an error from elsewhere, which can quote the RPC's or
 * neardata's URL, and a URL can hold a key (P03-R16).
 */
export class IndexerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "IndexerError";
  }
}

/** `applyBlock` failed on the block at `height`; `cause` is what it threw. */
export class ApplyBlockError extends IndexerError {
  readonly height: bigint;

  constructor(height: bigint, cause: unknown) {
    super(`block ${height} could not be applied`, { cause });
    this.name = "ApplyBlockError";
    this.height = height;
  }
}
