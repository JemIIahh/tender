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
 * and a transport that connects to the address it is given; tests pass fakes, and never the
 * network.
 */
export interface FetchIo {
  /** Every address `host` resolves to, as text: `93.184.216.34`, `2606:4700::6810:84e5`. */
  lookup(host: string): Promise<string[]>;
  /**
   * Sends one request. The host of the URL it is given is the address to connect to, which the
   * Judge has checked, and the `host` header names the server: the request's Host, and for
   * https the name sent to the server and the one its certificate must be for.
   */
  fetchImpl: typeof fetch;
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
  /** The model that scores `rubric` tasks, from P1 on. */
  llm?: { baseUrl: string; apiKey: string; model: string; headers?: Record<string, string> };
  /** The clock. Defaults to the wall clock. */
  now?: () => Date;
  /** How entries hosted elsewhere are fetched. Defaults to the network; see `FetchIo`. */
  fetchIo?: FetchIo;
}
