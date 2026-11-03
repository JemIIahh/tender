import type { Db } from "@tender/db";
import type { EntryView, TaskView } from "@tender/shared";
import type { WorkerSource } from "./isolate";

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
  /**
   * How long one task's entries are fetched and scored in one tick before the Judge moves on: 20 s
   * by default (P05-R18, P05-R19). The task takes up again where it was on the next tick, which
   * needs a `JudgeMemory`: without one, a task is judged in one go.
   */
  sliceMs?: number;
  /**
   * How long one tick spends on intake before it moves on to judging: 5 s by default (I5). Intake
   * of a `json_schema` task starts a worker, so a burst of new tasks would otherwise hold up every
   * pick that is due. The task in hand is finished, each tick does at least one, and the next tick
   * starts at once and takes up with the task after it.
   */
  intakeBudgetMs?: number;
}

/**
 * What a running Judge keeps between its ticks, in memory only, and never an entry's bytes.
 * `startJudge` makes one; a call made without one keeps nothing.
 */
export interface JudgeMemory {
  /**
   * What the criteria check (`checkJsonSchemaUsable`, run in a worker) came to, by criteria hash
   * and budget: a task that waits, or is judged again, does not start a worker for it each tick.
   * Only what the schema itself decides is kept, never a refusal for time, which is load.
   */
  checks: Map<string, { ok: true } | { ok: false; reason: string }>;
  /**
   * What judging each task the Judge is part way through has found out, by task id. A task that
   * gave way at the end of its slice takes up again from here (P05-R18), as does one whose pick
   * failed. It goes once the task is picked or settled, is never judged, or is out of its judging
   * window.
   */
  progress: Map<string, TaskProgress>;
  /**
   * How many times the criteria check of each task has run out of time at intake, by task id (M1).
   * The task stays `pending` while it is tried again, and the count goes once it is decided.
   */
  overruns: Map<string, number>;
  /**
   * The id of the first task that the last tick's intake did not get to, when its budget ran out
   * (I5): the next tick starts with it, so that a task that is slow every time cannot keep the
   * ones behind it from being looked at. `null` when intake got through every task.
   */
  intakeFrom: string | null;
}

/** What judging one task has found out of its entries so far: never their bytes. */
export interface TaskProgress {
  /**
   * The result of each content scored, or turned away, by its content hash and URI: its score and
   * reasons. Whether an entrant may use a content is asked again on each tick: it is the entrant's.
   */
  results: Map<string, EntryScore>;
  /** How many of those the scorer scored. */
  scored: number;
  /**
   * For a `rubric` task, how many of those a model graded with a reply that could be used, and
   * how many the replies (or the server's refusal) disqualified (P05-R20). A task in which the
   * model was asked about contents and disqualified every one of them fails closed.
   */
  usable: number;
  disqualified: number;
  /**
   * Whether a worker has compiled the task's criteria to score with. From then on a compile that
   * fails is the machine's load, not the criteria's fault, and does not reject them.
   */
  compiled: boolean;
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
  /** What the Judge keeps between ticks (see `JudgeMemory`). */
  memory?: JudgeMemory;
  /**
   * Where a task's scorer, and its criteria check at judging, take a worker kept loaded for them
   * (a `WarmWorker`). `startJudge` makes one. Without it, each starts its own.
   */
  warm?: WorkerSource;
}
