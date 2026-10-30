import type { Db } from "@tender/db";
import type { EntryView, TaskView } from "@tender/shared";

/** How one revealed entry scored against a task's criteria. */
export interface EntryScore {
  /** A whole number from 0 to 100. */
  score: number;
  /** Whether `score` reaches the criteria's `min_score`. */
  passed: boolean;
  /** Why the entry got its score, one line each. Empty for a perfect score. */
  reasons: string[];
}

/**
 * The two chain reads and the one call the Judge makes. `TenderClient` has all three and
 * satisfies this interface; tests pass a fake, so the Judge type-checks and runs without a chain.
 */
export interface JudgeChain {
  /** The task as the last final block has it, or null when there is no such task. */
  getTask(id: bigint): Promise<TaskView | null>;
  /** Every entry of the task that is left, in entrant order. */
  getAllEntries(taskId: bigint): Promise<EntryView[]>;
  /**
   * Settles the task as its verifier: pays `winners`, or nobody when the list is empty. Throws an
   * error with the contract's `code` (a `TenderError`) when the chain refuses it.
   */
  pick(
    taskId: bigint,
    winners: readonly { account: string; bps: number }[],
    scorecardHash: string,
    scorecardUri: string,
  ): Promise<unknown>;
}

/**
 * How the Judge reaches other hosts for an entry's content. The default is the system resolver
 * and the Judge's own transport, which connects to the address it is given. Tests pass fakes, and
 * never the network.
 *
 * In production leave `JudgeDeps.fetchIo` unset. Passing the global `fetch` as `fetchImpl` breaks
 * every https entry: it drops the `host` header, so the server is not named, and checks the
 * certificate against the address in the URL, which no certificate is for. Every such entry would
 * score 0. It ignores `connectSignal` too.
 */
export interface FetchIo {
  /** Every address `host` resolves to, as text: `93.184.216.34`, `2606:4700::6810:84e5`. */
  lookup(host: string): Promise<string[]>;
  /**
   * Sends one request. The host of the URL it is given is the address to connect to, which the
   * Judge has checked, and the `host` header names the server: the request's Host, and for
   * https the name sent to the server and the one its certificate must be for.
   */
  fetchImpl: (input: URL, init: TransportInit) => Promise<Response>;
}

/** What `FetchIo.fetchImpl` is given with a request: what `fetch` takes, and one signal more. */
export interface TransportInit extends RequestInit {
  /**
   * Aborts when connecting to the address has taken too long: 3 s, while `signal` bounds the
   * whole fetch. Until the connection is made (for https, until TLS is set up), the transport
   * gives up when it aborts and rejects, so that the Judge can try the next address. Once it is
   * made, the transport ignores it.
   */
  connectSignal?: AbortSignal;
}

/**
 * How long scoring may take (P05-R1), for tests. Leave it unset in production: the defaults are
 * the Judge's limits.
 */
export interface ScoringLimits {
  /** How long one entry's scoring may take in its worker: 5 s by default. */
  entryTimeoutMs?: number;
  /**
   * How long a `json_schema` schema may take to compile and pass its trial run at intake: 2 s by
   * default. Judging gives the same check 4 times as long.
   */
  compileBudgetMs?: number;
}

/** Everything the Judge needs. Nothing in it reads the environment: the caller resolves that. */
export interface JudgeDeps {
  db: Db;
  client: JudgeChain;
  /** The Judge's account: it judges the tasks that name it as their verifier, and no others. */
  judgeAccount: string;
  /** Accounts the team runs. Their tasks may use every kind (spec 7.3, C16). */
  teamAccounts: string[];
  /** The base URL the API is served at. Blob URIs under it are read from `db`. */
  publicUrl: string;
  /**
   * Whether `account` may use the bytes that hash to `sha256` as its result for task `taskId` at
   * `nowNs`, the Judge's own clock (`now`) in nanoseconds: a record of its upload of them for the
   * task exists (P03-R17), or the bytes are public by then (P03-R23). The API's `resultUsable` is
   * this. An entry whose URI is one of our own blob URIs counts only when it is true of the
   * `content_hash` the entry revealed: a hash is on chain for anyone to copy once it is revealed,
   * and a private result the entrant did not upload for this task is someone else's work. It
   * throws when it cannot tell, and the task is judged again on a later tick.
   */
  resultUploaded(sha256: string, taskId: bigint, account: string, nowNs: bigint): Promise<boolean>;
  /** The model that scores `rubric` tasks, from P1 on. */
  llm?: { baseUrl: string; apiKey: string; model: string; headers?: Record<string, string> };
  /** The clock. Defaults to the wall clock. */
  now?: () => Date;
  /**
   * How entries hosted elsewhere are fetched, for tests. Leave it unset in production: the default
   * is the network, through the Judge's own transport (see `FetchIo`).
   */
  fetchIo?: FetchIo;
  /** Shorter time limits for scoring, for tests (see `ScoringLimits`). */
  scoringLimits?: ScoringLimits;
}
