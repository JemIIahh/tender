import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { type MessagePort, type TransferListItem, Worker } from "node:worker_threads";
import type { Heldout } from "@tender/shared";
import type { P0Criteria } from "./intake";
import { checkJsonSchemaUsable } from "./kinds/json_schema";
import { ScorerUnavailableError, scorerFor } from "./score";
import type { EntryScore } from "./types";

// Every scorer the Judge runs runs here, in a worker thread with hard limits (P05-R1), so that an
// entry, criteria or held-out checks that make a scorer loop, recurse or allocate without end cost
// that entry its score and nothing more. The Judge's thread only sends the documents and the
// entry's bytes, and checks what comes back.

/** How long scoring one entry may take, by default. */
const ENTRY_TIMEOUT_MS = 5_000;
/** How long compiling a `json_schema` schema and its trial run may take, by default. */
const COMPILE_BUDGET_MS = 2_000;
/**
 * How long a worker may take to load the scorers, about 130 ms when the machine is idle. Loading
 * is the Judge's own cost, and is not counted against an entry's time or a schema's: the limits
 * start when the work is sent to a worker that is ready. A start and an entry's limit together
 * stay well inside the 30 s that judging leaves before a pick deadline.
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

// The messages of the protocol, besides the requests and the answers.
/** What a worker sends once it has loaded the scorers and can take work. */
const READY = "ready";
/** What a score worker sends instead of a score when the scorer cannot be run at all. */
const UNAVAILABLE = "unavailable";
/** What a check worker is sent to run its check. */
const CHECK = "check";

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

/** What the scorer of one task's entries does. */
export interface TaskScorer {
  /**
   * The score of one entry's content. It resolves whatever the content does: an entry whose
   * scoring takes longer than the limit (5 s) scores 0 (`scoring timed out`), one whose scorer
   * runs out of memory too (`scoring ran out of memory`), and one that makes the worker crash,
   * or answer with anything but a score, scores 0 as well (`scoring failed`). The worker is
   * stopped after each of these, and the next entry gets a new one. It rejects with
   * `ScorerUnavailableError` when the scorer cannot be run at all: no worker can be started, or
   * the scorer says so (the regex sandbox could not be loaded, say), which is the Judge's trouble.
   * Entries are scored one at a time, in the order they are asked for.
   */
  score(content: Uint8Array): Promise<EntryScore>;
  /** Stops the worker. Resolves once no worker of this scorer is left. */
  close(): Promise<void>;
}

/**
 * The scorer of one task's entries: one worker for the task, which scores them one after another
 * (it compiles a `json_schema` schema once, for all of them), and is never shared with another
 * task. Only the criteria, the held-out document and each entry's bytes go to the worker, and
 * only a score comes back: `{ score, passed, reasons }`, with a whole `score` from 0 to 100,
 * `passed` that is what the criteria's `min_score` makes of it, and reasons that are strings.
 * Anything else is a crash.
 *
 * `onCrash` is told of each crash, with the error when there is one. Nothing is started until an
 * entry is scored.
 */
export function openTaskScorer(
  task: { criteria: P0Criteria; heldout: Heldout | null },
  options: WorkerOptions & { entryTimeoutMs?: number; onCrash?: (error: unknown) => void } = {},
): TaskScorer {
  const job: Job = { job: "score", criteria: task.criteria, heldout: task.heldout };
  const timeoutMs = options.entryTimeoutMs ?? ENTRY_TIMEOUT_MS;
  let lane: Lane | undefined;
  /** Each worker that has been stopped, until it has ended. */
  const stopped: Promise<unknown>[] = [];
  /** The last request: each one waits for the one before it. */
  let last: Promise<unknown> = Promise.resolve();

  const drop = () => {
    if (lane !== undefined) stopped.push(lane.stop());
    lane = undefined;
  };
  const crashed = (error: unknown): EntryScore => {
    drop();
    options.onCrash?.(error);
    return zero(FAILED);
  };

  const scoreOne = async (content: Uint8Array): Promise<EntryScore> => {
    if (lane === undefined || !lane.alive) {
      drop();
      lane = await Lane.start(job, options);
    }
    // A copy of exactly these bytes, moved to the worker rather than copied again. `content` can
    // be a view into a larger buffer, all of which would be copied.
    const bytes = new Uint8Array(content);
    const outcome = await lane.ask(bytes, [bytes.buffer], timeoutMs);
    switch (outcome.kind) {
      case "timeout":
        drop();
        return zero(TIMED_OUT);
      case "error":
        if (!isOutOfMemory(outcome.error)) return crashed(outcome.error);
        drop();
        return zero(OUT_OF_MEMORY);
      case "exit":
        return crashed(new ScoreWorkerError(`the score worker exited (code ${outcome.code})`));
      case "answer": {
        if (outcome.value === UNAVAILABLE) {
          drop();
          throw new ScorerUnavailableError("the scorer could not be run");
        }
        const score = entryScoreOf(outcome.value, task.criteria.min_score);
        return score ?? crashed(new ScoreWorkerError("the score worker sent something else"));
      }
    }
  };

  return {
    score(content) {
      const result = last.then(() => scoreOne(content));
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
  const lane = await Lane.start({ job: "check", schema }, options);
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
  scorerFor: typeof scorerFor;
  checkJsonSchemaUsable: typeof checkJsonSchemaUsable;
}

/**
 * The worker's side, which `score-worker.ts` runs: `job` is its `workerData`, and each request on
 * `port` is answered on it. A score job takes an entry's bytes and answers with the score, or
 * with `unavailable` when the scorer throws `ScorerUnavailableError`; a check job answers each
 * request with `checkJsonSchemaUsable` of its schema. Once it is set up it sends `ready`.
 *
 * Anything else a scorer or the check throws ends the worker with that error, which its host takes
 * for a crash: nothing is left to run in a worker whose state is in doubt.
 */
export function serveWorker(
  port: MessagePort,
  job: Job,
  scorers: WorkerScorers = { scorerFor, checkJsonSchemaUsable },
): void {
  const crash = (error: unknown) =>
    process.nextTick(() => {
      throw error;
    });
  if (job.job === "check") {
    port.on("message", () => port.postMessage(scorers.checkJsonSchemaUsable(job.schema)));
  } else {
    const score = scorers.scorerFor(job.criteria, job.heldout);
    port.on("message", (content: Uint8Array) => {
      score(content)
        .then((result) => port.postMessage(result))
        .catch((error: unknown) => {
          if (error instanceof ScorerUnavailableError) port.postMessage(UNAVAILABLE);
          else crash(error);
        });
    });
  }
  port.postMessage(READY);
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
  /** How the worker ended: an error, or its exit. */
  private ended: Outcome | undefined;
  private stopping: Promise<unknown> | undefined;

  private constructor(private readonly worker: Worker) {
    // An `error` event with no listener would be thrown on the Judge's thread.
    worker.on("error", (error: unknown) => this.end({ kind: "error", error }));
    worker.on("messageerror", (error: unknown) => this.end({ kind: "error", error }));
    worker.on("exit", (code: number) => this.end({ kind: "exit", code }));
    worker.on("message", (value: unknown) => this.waiting?.({ kind: "answer", value }));
  }

  /**
   * A worker started on `job`, once it has loaded the scorers. It rejects with
   * `ScorerUnavailableError` when the worker cannot be started, fails while it loads, or takes
   * longer than the start timeout.
   */
  static async start(job: Job, options: WorkerOptions): Promise<Lane> {
    let lane: Lane;
    try {
      const worker = new Worker(options.workerUrl ?? SCORE_WORKER, {
        workerData: job,
        execArgv: workerExecArgv(),
        resourceLimits: RESOURCE_LIMITS,
      });
      lane = new Lane(worker);
    } catch (error) {
      throw new ScorerUnavailableError("a score worker could not be started", { cause: error });
    }
    const outcome = await lane.next(options.startTimeoutMs ?? START_TIMEOUT_MS);
    if (outcome.kind === "answer" && outcome.value === READY) return lane;
    await lane.stop();
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
    const outcome = this.next(timeoutMs);
    if (this.ended === undefined) {
      try {
        this.worker.postMessage(request, transfer);
      } catch (error) {
        this.end({ kind: "error", error });
      }
    }
    return outcome;
  }

  /** The next thing the worker comes to, or a timeout after `timeoutMs`. */
  private next(timeoutMs: number): Promise<Outcome> {
    if (this.ended !== undefined) return Promise.resolve(this.ended);
    return new Promise<Outcome>((resolve) => {
      const settle = (outcome: Outcome) => {
        clearTimeout(timer);
        this.waiting = undefined;
        if (outcome.kind !== "answer") void this.stop();
        resolve(outcome);
      };
      const timer = setTimeout(() => settle({ kind: "timeout" }), timeoutMs);
      this.waiting = settle;
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

/** A score of 0 that does not pass, whatever the pass mark: the entry could not be scored. */
function zero(reason: string): EntryScore {
  return { score: 0, passed: false, reasons: [reason] };
}
