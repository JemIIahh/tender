import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { type MessagePort, type TransferListItem, Worker } from "node:worker_threads";
import type { Heldout } from "@tender/shared";
import type { P0Criteria } from "./intake";
import { checkJsonSchemaUsable } from "./kinds/json_schema";
import { type PreparedScorer, prepareScorer, ScorerUnavailableError } from "./score";
import type { EntryScore } from "./types";

// Every scorer the Judge runs runs here, in a worker thread with hard limits (P05-R1), so that an
// entry, criteria or held-out checks that make a scorer loop, recurse or allocate without end cost
// that entry its score and nothing more. The Judge's thread only sends the documents and the
// entry's bytes, and checks what comes back. A worker is not a wall around memory, though: V8 can
// still abort the whole process when one allocation outruns the heap limit before the worker is
// stopped (megabyte strings built in a tight loop do), and memory outside the heap, such as
// ArrayBuffers and WebAssembly's, has no limit here.

/** How long scoring one entry may take, by default. */
const ENTRY_TIMEOUT_MS = 5_000;
/**
 * How long compiling a `json_schema` schema and its trial run may take, by default: intake's
 * budget. Judging gives the same check, and the compile in a score worker, 4 times as long (see
 * `judgeTask`).
 */
export const COMPILE_BUDGET_MS = 2_000;
/**
 * How long a worker may take to load the scorers, about 130 ms when the machine is idle. Loading
 * is the Judge's own cost, and is not counted against an entry's time or a schema's: the limits
 * start when the work is sent to a worker that is ready.
 */
const START_TIMEOUT_MS = 10_000;
/**
 * Every worker's limits. 4 MiB of stack, so that a deep recursion in the regex sandbox meets the
 * engine's own check (1 MiB) before V8's stack runs out, which on a thread with the default stack
 * it does not; and at most 256 MiB of heap.
 */
const RESOURCE_LIMITS = { stackSizeMb: 4, maxOldGenerationSizeMb: 256 };
/** The worker's entry module. */
const SCORE_WORKER = new URL("./score-worker.ts", import.meta.url);

const TIMED_OUT = "scoring timed out";
const OUT_OF_MEMORY = "scoring ran out of memory";
const FAILED = "scoring failed";
const TOO_SLOW = "criteria schema is not supported: it takes too long to compile";
/** Why criteria are refused when compiling them crashes the worker: intake's reason for that. */
const NOT_CHECKED = "criteria could not be checked";

// The messages of the protocol, besides the requests and the answers.
/** What a worker sends once it has loaded the scorers. */
const READY = "ready";
/** What a score worker sends instead of an answer when the scorer cannot be run at all. */
const UNAVAILABLE = "unavailable";
/** What a check worker is sent to run its check. */
const CHECK = "check";
/** What a score worker is sent, once, to compile the criteria before it takes any entry. */
const COMPILE = "compile";

/** The work a worker is started for, as its `workerData`. */
export type Job =
  | { job: "score"; criteria: P0Criteria; heldout: Heldout | null }
  | { job: "check"; schema: Record<string, unknown> };

/** How a worker is started. The defaults are the Judge's; tests change them. */
export interface WorkerOptions {
  /** The worker's entry module: `score-worker.ts`. A test can pass one that misbehaves. */
  workerUrl?: URL;
  /** How long the worker may take to load (10 s). */
  startTimeoutMs?: number;
}

/** What came of asking a task's scorer for one entry's score. */
export type Scoring =
  /** The entry's score. A failure of its own (time, memory, a crash) is a 0 with the reason. */
  | { kind: "scored"; score: EntryScore }
  /** The stop line came while the entry was being scored: it has no score. */
  | { kind: "cut" }
  /**
   * The stop line came while the Judge's own work ran, before the entry was sent: a worker was
   * loading, or compiling the criteria.
   */
  | { kind: "late" }
  /**
   * The criteria cannot be scored with: they do not compile, not within the budget, or crash the
   * worker that compiles them. That is no entry's doing.
   */
  | { kind: "rejected"; reason: string };

/** What the scorer of one task's entries does. */
export interface TaskScorer {
  /**
   * Scores one entry's content. `leftMs` is the time left before the stop line, which no part of
   * the work may run past (P05-R15): starting a worker and compiling the criteria, when a new
   * worker is needed, then the entry's own scoring. Each of them has the smaller of its own limit
   * and the time left.
   *
   * - `scored`: the entry's score. An entry whose scoring takes longer than its limit (5 s)
   *   scores 0 (`scoring timed out`), one whose scorer runs out of memory too (`scoring ran out of
   *   memory`), and one that makes the worker crash, or answer with anything but a score, scores
   *   0 as well (`scoring failed`). The worker is stopped after each of these.
   * - `cut`: the time left ran out while the entry was being scored, before its own limit did.
   * - `late`: the time left ran out while a worker loaded or compiled the criteria (P05-R17: no
   *   entry pays for the compile).
   * - `rejected`: the criteria cannot be scored with (see `Scoring`).
   *
   * It rejects with `ScorerUnavailableError` when the scorer cannot be run at all: no worker can
   * be started, one takes longer than its own start limit, or the scorer says so (the regex sandbox
   * could not be loaded, say), which is the Judge's trouble. Entries are scored one at a time, in
   * the order they are asked for.
   */
  score(content: Uint8Array, leftMs?: number): Promise<Scoring>;
  /** Stops the worker. Resolves once no worker of this scorer is left. */
  close(): Promise<void>;
}

/**
 * The scorer of one task's entries: one worker for the task, which compiles the criteria once,
 * before any entry (within `compileBudgetMs`, 2 s by default), and then scores the entries one
 * after another. It is never shared with another task. A worker that is stopped after an entry's
 * failure is replaced by one that compiles the criteria again, under the same budget. Only the
 * criteria, the held-out document and each entry's bytes go to the worker, and only a score
 * comes back: `{ score, passed, reasons }`, with a whole `score` from 0 to 100, `passed` that is
 * what the criteria's `min_score` makes of it, and reasons that are strings. Anything else is a
 * crash.
 *
 * `onCrash` is told of each crash an entry causes, with the error when there is one. Nothing is
 * started until an entry is scored.
 */
export function openTaskScorer(
  task: { criteria: P0Criteria; heldout: Heldout | null },
  options: WorkerOptions & {
    entryTimeoutMs?: number;
    compileBudgetMs?: number;
    onCrash?: (error: unknown) => void;
  } = {},
): TaskScorer {
  const job: Job = { job: "score", criteria: task.criteria, heldout: task.heldout };
  const timeoutMs = options.entryTimeoutMs ?? ENTRY_TIMEOUT_MS;
  const startTimeoutMs = options.startTimeoutMs ?? START_TIMEOUT_MS;
  const compileBudgetMs = options.compileBudgetMs ?? COMPILE_BUDGET_MS;
  let lane: Lane | undefined;
  /** Each worker that has been stopped, until it has ended. */
  const stopped: Promise<unknown>[] = [];
  /** The last request: each one waits for the one before it. */
  let last: Promise<unknown> = Promise.resolve();

  const stop = (worker: Lane) => stopped.push(worker.stop());
  const drop = () => {
    if (lane !== undefined) stop(lane);
    lane = undefined;
  };
  const crashed = (error: unknown): Scoring => {
    drop();
    options.onCrash?.(error);
    return scored(zero(FAILED));
  };

  /** A worker that has loaded and compiled the criteria, or why there is none, by `left()`. */
  const ready = async (left: () => number): Promise<Lane | Scoring> => {
    const loadMs = Math.min(startTimeoutMs, left());
    if (loadMs <= 0) return { kind: "late" };
    const started = await Lane.start(job, options, loadMs);
    if (started === "timeout") {
      if (loadMs < startTimeoutMs) return { kind: "late" };
      throw new ScorerUnavailableError("a score worker did not start in time");
    }
    const compileMs = Math.min(compileBudgetMs, left());
    if (compileMs <= 0) {
      stop(started);
      return { kind: "late" };
    }
    const outcome = await started.ask(COMPILE, [], compileMs);
    if (outcome.kind === "answer" && outcome.value === UNAVAILABLE) {
      stop(started);
      throw new ScorerUnavailableError("the scorer could not be run");
    }
    const usable = outcome.kind === "answer" ? usabilityOf(outcome.value) : null;
    if (usable !== null) {
      if (usable.ok) return started;
      stop(started);
      return { kind: "rejected", reason: usable.reason };
    }
    stop(started);
    // A crash, or something else for an answer.
    if (outcome.kind !== "timeout") return { kind: "rejected", reason: NOT_CHECKED };
    // Its own budget, or the stop line, which came first.
    return compileMs < compileBudgetMs ? { kind: "late" } : { kind: "rejected", reason: TOO_SLOW };
  };

  const scoreOne = async (content: Uint8Array, leftMs: number): Promise<Scoring> => {
    const until = performance.now() + leftMs;
    const left = () => until - performance.now();
    if (lane === undefined || !lane.alive) {
      drop();
      const started = await ready(left);
      if (!(started instanceof Lane)) return started;
      lane = started;
    }
    const limitMs = Math.min(timeoutMs, left());
    if (limitMs <= 0) return { kind: "cut" };
    // A copy of exactly these bytes, moved to the worker rather than copied again. `content` can
    // be a view into a larger buffer, all of which would be copied.
    const bytes = new Uint8Array(content);
    const outcome = await lane.ask(bytes, [bytes.buffer], limitMs);
    switch (outcome.kind) {
      case "timeout":
        drop();
        // Its own limit, or the stop line, which came first.
        return limitMs < timeoutMs ? { kind: "cut" } : scored(zero(TIMED_OUT));
      case "error":
        if (!isOutOfMemory(outcome.error)) return crashed(outcome.error);
        drop();
        return scored(zero(OUT_OF_MEMORY));
      case "exit":
        return crashed(new ScoreWorkerError(`the score worker exited (code ${outcome.code})`));
      case "answer": {
        if (outcome.value === UNAVAILABLE) {
          drop();
          throw new ScorerUnavailableError("the scorer could not be run");
        }
        const score = entryScoreOf(outcome.value, task.criteria.min_score);
        if (score === null)
          return crashed(new ScoreWorkerError("the score worker sent something else"));
        return scored(score);
      }
    }
  };

  return {
    score(content, leftMs = Number.POSITIVE_INFINITY) {
      const result = last.then(() => scoreOne(content, leftMs));
      last = result.catch(() => undefined);
      return result;
    },
    async close() {
      await last;
      drop();
      await Promise.all(stopped);
    },
  };
}

/**
 * `checkJsonSchemaUsable` in a worker, with a time budget: compiling `schema` and its trial run may
 * take `budgetMs` (2 s by default), counted from when the worker is ready. Past it the worker is
 * stopped and the schema refused, with `criteria schema is not supported: it takes too long to
 * compile`. Otherwise the result is the check's own.
 *
 * It rejects when there is no result: with `ScorerUnavailableError` when no worker can be
 * started, the Judge's trouble, and with another error when the check crashed its worker (it ran
 * out of memory, say), which the schema did. The worker is stopped before it settles.
 */
export async function checkJsonSchemaIsolated(
  schema: Record<string, unknown>,
  options: WorkerOptions & { budgetMs?: number } = {},
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const startTimeoutMs = options.startTimeoutMs ?? START_TIMEOUT_MS;
  const lane = await Lane.start({ job: "check", schema }, options, startTimeoutMs);
  if (lane === "timeout") throw new ScorerUnavailableError("a check worker did not start in time");
  try {
    const outcome = await lane.ask(CHECK, [], options.budgetMs ?? COMPILE_BUDGET_MS);
    if (outcome.kind === "timeout") return { ok: false, reason: TOO_SLOW };
    const usable = outcome.kind === "answer" ? usabilityOf(outcome.value) : null;
    if (usable !== null) return usable;
    throw new ScoreWorkerError("the criteria check failed in its worker", {
      cause: outcome.kind === "error" ? outcome.error : outcome,
    });
  } finally {
    await lane.stop();
  }
}

/** The scorers a worker runs. A test can pass ones that misbehave on cue. */
export interface WorkerScorers {
  prepareScorer: typeof prepareScorer;
  checkJsonSchemaUsable: typeof checkJsonSchemaUsable;
}

/**
 * The worker's side, which `score-worker.ts` runs: `job` is its `workerData`, and each request on
 * `port` is answered on it. A request is `{ id, request }`, and its answer `{ id, answer }`, with
 * the same id: the host takes any answer to another one, or to none, for a crash. Once the worker is
 * set up it answers request 0, its start, with `ready`.
 *
 * A score job is first asked to compile the criteria (`compile`), and answers as the check does:
 * `{ ok: true }`, or `{ ok: false, reason }` when the criteria cannot be scored with, or
 * `unavailable` when the scorer cannot be made at all (`ScorerUnavailableError`). Then each request
 * is an entry's bytes, answered with the score, or with `unavailable` when the scorer throws
 * `ScorerUnavailableError`. A check job answers each request with `checkJsonSchemaUsable` of its
 * schema.
 *
 * Anything else a scorer, the compile or the check throws ends the worker with that error, which
 * its host takes for a crash: nothing is left to run in a worker whose state is in doubt.
 */
export function serveWorker(
  port: MessagePort,
  job: Job,
  scorers: WorkerScorers = { prepareScorer, checkJsonSchemaUsable },
): void {
  const crash = (error: unknown) =>
    process.nextTick(() => {
      throw error;
    });
  const answer = (id: number, value: unknown) => port.postMessage({ id, answer: value });
  let prepared: PreparedScorer | undefined;
  port.on("message", (message: unknown) => {
    const { id, request } = message as { id: number; request: unknown };
    if (job.job === "check") {
      answer(id, scorers.checkJsonSchemaUsable(job.schema));
      return;
    }
    if (request === COMPILE) {
      try {
        prepared = scorers.prepareScorer(job.criteria, job.heldout);
      } catch (error) {
        if (!(error instanceof ScorerUnavailableError)) throw error;
        answer(id, UNAVAILABLE);
        return;
      }
      const { problem } = prepared;
      answer(id, problem === null ? { ok: true } : { ok: false, reason: problem });
      return;
    }
    if (prepared === undefined) throw new Error("an entry came before the criteria compiled");
    prepared
      .score(request as Uint8Array)
      .then((result) => answer(id, result))
      .catch((error: unknown) => {
        if (error instanceof ScorerUnavailableError) answer(id, UNAVAILABLE);
        else crash(error);
      });
  });
  answer(0, READY);
}

/** A score worker that did not keep to the protocol: it exited, or sent something unexpected. */
class ScoreWorkerError extends Error {
  override name = "ScoreWorkerError";
}

/** What came of one request to a worker. */
type Outcome =
  | { kind: "answer"; value: unknown }
  | { kind: "timeout" }
  | { kind: "error"; error: unknown }
  | { kind: "exit"; code: number };

/** One worker thread, asked one thing at a time. */
class Lane {
  /** Settles the request in flight, if there is one. */
  private waiting: ((outcome: Outcome) => void) | undefined;
  /** The id of the request in flight, which its answer must name. */
  private awaited: number | undefined;
  /** The id of the last request sent. The start is request 0. */
  private sent = 0;
  /** How the worker ended: an error, or its exit. */
  private ended: Outcome | undefined;
  private stopping: Promise<unknown> | undefined;

  private constructor(private readonly worker: Worker) {
    // An `error` event with no listener would be thrown on the Judge's thread.
    worker.on("error", (error: unknown) => this.end({ kind: "error", error }));
    worker.on("messageerror", (error: unknown) => this.end({ kind: "error", error }));
    worker.on("exit", (code: number) => this.end({ kind: "exit", code }));
    worker.on("message", (message: unknown) => this.receive(message));
  }

  /**
   * An answer to the request in flight settles it. Anything else, an answer to another request or
   * to none, or a message that is no answer at all, is a worker that does not keep to the
   * protocol: it is taken for a crash, of the request in flight if there is one, and stopped.
   */
  private receive(message: unknown): void {
    const id = isObject(message) && Object.hasOwn(message, "answer") ? message.id : undefined;
    if (this.waiting === undefined || id !== this.awaited) {
      this.end({ kind: "error", error: new ScoreWorkerError("the worker answered out of turn") });
      void this.stop();
      return;
    }
    this.waiting({ kind: "answer", value: (message as { answer: unknown }).answer });
  }

  /**
   * A worker started on `job`, once it has loaded the scorers, or `timeout` when it has not
   * within `timeoutMs` (it is stopped then). It rejects with `ScorerUnavailableError` when the
   * worker cannot be started, or fails while it loads.
   */
  static async start(
    job: Job,
    options: WorkerOptions,
    timeoutMs: number,
  ): Promise<Lane | "timeout"> {
    let lane: Lane;
    try {
      const worker = new Worker(options.workerUrl ?? SCORE_WORKER, {
        workerData: job,
        execArgv: workerExecArgv(),
        resourceLimits: RESOURCE_LIMITS,
        // None of the Judge's environment, its keys included: the scorers need none of it, and
        // nor does tsx's loader (its cache goes to the temporary directory an empty one gives).
        env: {},
      });
      lane = new Lane(worker);
    } catch (error) {
      throw new ScorerUnavailableError("a score worker could not be started", { cause: error });
    }
    const outcome = await lane.next(0, timeoutMs);
    if (outcome.kind === "answer" && outcome.value === READY) return lane;
    await lane.stop();
    if (outcome.kind === "timeout") return "timeout";
    throw new ScorerUnavailableError("a score worker could not be started", {
      cause: outcome.kind === "error" ? outcome.error : outcome,
    });
  }

  /** Whether the worker can still be asked: it has not ended, and has not been stopped. */
  get alive(): boolean {
    return this.ended === undefined && this.stopping === undefined;
  }

  /**
   * Sends `request`, moving `transfer`, and resolves with what comes of it within `timeoutMs`.
   * Anything but an answer stops the worker.
   */
  ask(request: unknown, transfer: TransferListItem[], timeoutMs: number): Promise<Outcome> {
    this.sent++;
    const outcome = this.next(this.sent, timeoutMs);
    if (this.ended === undefined) {
      try {
        this.worker.postMessage({ id: this.sent, request }, transfer);
      } catch (error) {
        this.end({ kind: "error", error });
      }
    }
    return outcome;
  }

  /** What the worker comes to for request `id`, or a timeout after `timeoutMs`. */
  private next(id: number, timeoutMs: number): Promise<Outcome> {
    if (this.ended !== undefined) return Promise.resolve(this.ended);
    return new Promise<Outcome>((resolve) => {
      const settle = (outcome: Outcome) => {
        clearTimeout(timer);
        this.waiting = undefined;
        this.awaited = undefined;
        if (outcome.kind !== "answer") void this.stop();
        resolve(outcome);
      };
      const timer = setTimeout(() => settle({ kind: "timeout" }), timeoutMs);
      this.waiting = settle;
      this.awaited = id;
    });
  }

  private end(outcome: Outcome): void {
    this.ended ??= outcome;
    this.waiting?.(outcome);
  }

  /** Stops the worker at once, wherever it is. Resolves once its thread has ended. */
  stop(): Promise<unknown> {
    this.stopping ??= this.worker.terminate();
    return this.stopping;
  }
}

/**
 * What a worker is started with, for its TypeScript to load: tsx's loader. `pnpm serve` runs the
 * Judge under tsx, and a worker inherits the loader with the rest of its parent's options (this is
 * `undefined` then). Under vitest, which loads TypeScript its own way, the worker gets the loader
 * and no other option. It throws when tsx cannot be found.
 */
function workerExecArgv(): string[] | undefined {
  const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  return process.execArgv.includes(loader) ? undefined : ["--import", loader];
}

/**
 * `value` as a score, when it is exactly one: the three fields and nothing else, a whole score
 * from 0 to 100, `passed` as `minScore` makes it, and every reason a string. Otherwise `null`.
 */
function entryScoreOf(value: unknown, minScore: number): EntryScore | null {
  if (typeof value !== "object" || value === null || Object.keys(value).length !== 3) return null;
  const { score, passed, reasons } = value as Record<string, unknown>;
  if (typeof score !== "number" || !Number.isInteger(score) || score < 0 || score > 100) {
    return null;
  }
  if (passed !== score >= minScore || !Array.isArray(reasons)) return null;
  const copied: string[] = [];
  // By index, so that a hole in the array is not skipped.
  for (let i = 0; i < reasons.length; i++) {
    const reason: unknown = reasons[i];
    if (typeof reason !== "string") return null;
    copied.push(reason);
  }
  return { score, passed, reasons: copied };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `value` as the check's result, when it is one. Otherwise `null`. */
function usabilityOf(value: unknown): { ok: true } | { ok: false; reason: string } | null {
  if (typeof value !== "object" || value === null) return null;
  const { ok, reason } = value as Record<string, unknown>;
  if (ok === true) return { ok: true };
  return ok === false && typeof reason === "string" ? { ok: false, reason } : null;
}

function isOutOfMemory(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    Reflect.get(error, "code") === "ERR_WORKER_OUT_OF_MEMORY"
  );
}

function scored(score: EntryScore): Scoring {
  return { kind: "scored", score };
}

/** A score of 0 that does not pass, whatever the pass mark: the entry could not be scored. */
function zero(reason: string): EntryScore {
  return { score: 0, passed: false, reasons: [reason] };
}
