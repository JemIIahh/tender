import {
  newQuickJSWASMModule,
  type QuickJSContext,
  type QuickJSRuntime,
  type QuickJSWASMModule,
  shouldInterruptAfterDeadline,
} from "quickjs-emscripten";

/** The limits of one run. */
export interface SandboxOptions {
  /** How long the code may run. The clock starts once the engine is loaded. */
  timeoutMs: number;
  /** How much memory the code may allocate in the engine's heap. */
  memoryBytes: number;
}

/**
 * What a run came to: the value of the code's last statement, or why there is none. `message`
 * says what was thrown, as `name: message` when it was an error (`SyntaxError: nothing to
 * repeat`) and as `threw <JSON>` when it was anything else, or that the time ran out.
 *
 * `timeout` is set only when the deadline fired, and code cannot fake it. `memory` can be faked.
 * It is the engine's out-of-memory error reaching the end of the run, and code can catch that
 * error and carry on, or throw an error with the same name and message. A caller may rely on the
 * label only for code that is fixed and has no `try` or `throw` of its own, as the regex
 * scorer's program is. For any other code, `memory` means only that the run ended with an error
 * that says it ran out of memory.
 */
export type SandboxResult =
  | { ok: true; value: unknown }
  | { ok: false; error: "timeout" | "memory" | "exception"; message: string };

/** How much of the engine's stack the code may use. */
const MAX_STACK_BYTES = 1_048_576;
/** A message is for a log. Code that throws a long text does not get to carry it out. */
const MAX_MESSAGE_LENGTH = 500;
/** How the engine starts the message of an allocation that goes past the limit. */
const OUT_OF_MEMORY = "out of memory";

/**
 * The engine: QuickJS compiled to WebAssembly, loaded on the first run and shared by the runs
 * after it. A run that damages it drops it. No run starts on a dropped engine: the runs that
 * come later load a new one, and so do the ones that were already waiting for the dropped one.
 */
let engine: Promise<QuickJSWASMModule> | undefined;

function loadEngine(): Promise<QuickJSWASMModule> {
  if (engine === undefined) {
    const loading = newQuickJSWASMModule();
    engine = loading;
    // A load that failed is not kept: the next run tries again.
    loading.catch(() => dropEngine(loading));
  }
  return engine;
}

function dropEngine(damaged: Promise<QuickJSWASMModule>): void {
  if (engine === damaged) engine = undefined;
}

/**
 * Runs `code` as a script in a fresh QuickJS runtime and returns the value of its last statement.
 * The runtime has no host functions: the code sees the language's own built-ins and nothing
 * else (no `fetch`, `require`, `process`, timers or console), and each run starts from a new
 * runtime, so nothing is carried from one run to the next.
 *
 * It costs its caller at most `timeoutMs` and `memoryBytes`: past the deadline the engine
 * interrupts the code (`timeout`; this includes a regex that backtracks without end, and code
 * that runs while the value is read), and past the limit the allocation fails (`memory`, which
 * `SandboxResult` says how far to trust). Anything else the code throws, syntax errors and the
 * engine's own stack overflow included, is an `exception`. The value is what the engine's `dump`
 * makes of the last statement's value: plain data.
 *
 * The engine runs on the caller's thread, so a run that uses its whole budget stops everything
 * else on that thread for as long. Run it where that is acceptable.
 *
 * Total in the code: whatever the code does, the result says so and this does not throw. It
 * rejects only when the engine cannot be loaded or a runtime cannot be started, which is the
 * host's trouble and not the code's. A load that failed is tried again by the next run.
 *
 * When the host itself fails inside the engine (the host's stack runs out in a deep recursion,
 * or the engine hits one of its own assertions), the runtime is left in the middle of a call. It
 * is neither freed, which makes the engine abort the whole module for good, nor used again: the
 * engine is dropped, and every run that starts on an engine after that, the runs that were
 * already waiting for the dropped one included, uses a new one. The failed run is an
 * `exception`. A runtime that cannot be started drops the engine in the same way, and rejects.
 * The runs beside a failed one keep their results and their own budgets, and can wait for a new
 * engine to load, which takes a few milliseconds.
 */
export async function runInSandbox(code: string, opts: SandboxOptions): Promise<SandboxResult> {
  let loading = loadEngine();
  let quickJS = await loading;
  // Runs that start together wait for the same load and resume one after another, so one of them
  // may have damaged the engine and dropped it by the time this one resumes. This one starts over
  // on the engine that replaced it. Nothing is awaited between this check and the end of the run,
  // so no other run can drop the engine in between.
  while (engine !== loading) {
    loading = loadEngine();
    quickJS = await loading;
  }

  // The engine counts as damaged until it has made this run a runtime: if it cannot, there is
  // nothing to free, and it is in no state to be asked again.
  let damaged = true;
  let runtime: QuickJSRuntime | undefined;
  let context: QuickJSContext | undefined;
  // Whether the deadline cut anything short. The engine reports an interrupt as an error, and
  // swallows it where it reads the value (a `toJSON` that loops). So the run is a timeout when
  // the handler fired, whatever the result says.
  let interrupted = false;
  try {
    runtime = quickJS.newRuntime();
    damaged = false;
    runtime.setMemoryLimit(opts.memoryBytes);
    runtime.setMaxStackSize(MAX_STACK_BYTES);
    const deadline = shouldInterruptAfterDeadline(Date.now() + opts.timeoutMs);
    runtime.setInterruptHandler((rt) => {
      const stop = deadline(rt);
      if (stop) interrupted = true;
      return stop;
    });
    context = runtime.newContext();
    try {
      const outcome = evaluate(context, code);
      if (!interrupted) return outcome;
      return { ok: false, error: "timeout", message: `interrupted after ${opts.timeoutMs} ms` };
    } catch (error) {
      damaged = true;
      return { ok: false, error: "exception", message: describeHostError(error) };
    }
  } finally {
    if (!damaged) {
      try {
        context?.dispose();
        runtime?.dispose();
      } catch {
        // Freeing it failed, so the engine is in no state to be used again.
        damaged = true;
      }
    }
    if (damaged) dropEngine(loading);
  }
}

/** Evaluates `code` in `context`, and frees what it made. Throws only if the host fails. */
function evaluate(context: QuickJSContext, code: string): SandboxResult {
  // Always a script. Without a type the engine guesses from the text, and a guess of "module"
  // runs `export` and `import` and returns a promise or the exports instead of a value.
  const result = context.evalCode(code, undefined, { type: "global" });
  const outcome: SandboxResult = result.error
    ? failure(context.dump(result.error))
    : { ok: true, value: context.dump(result.value) };
  // `dump` already disposed the handle of a promise.
  if (result.alive) result.dispose();
  return outcome;
}

function failure(thrown: unknown): SandboxResult {
  const message = describeThrown(thrown).slice(0, MAX_MESSAGE_LENGTH);
  return { ok: false, error: isOutOfMemory(thrown) ? "memory" : "exception", message };
}

/**
 * Whether `thrown` is what the engine throws when an allocation goes past the limit: an
 * `InternalError` whose message starts with "out of memory" (the regex matcher adds "in regexp
 * execution"), or, from the regex compiler, a `SyntaxError` with just that message. Code can
 * catch such an error, or throw one just like it, so this names the error and proves nothing
 * about where it came from.
 */
function isOutOfMemory(thrown: unknown): boolean {
  if (!isError(thrown)) return false;
  if (thrown.name === "InternalError") return thrown.message.startsWith(OUT_OF_MEMORY);
  return thrown.name === "SyntaxError" && thrown.message === OUT_OF_MEMORY;
}

function describeThrown(thrown: unknown): string {
  if (isError(thrown)) return `${thrown.name}: ${thrown.message}`;
  try {
    return `threw ${JSON.stringify(thrown) ?? String(thrown)}`;
  } catch {
    // A bigint is the one value `dump` returns that JSON cannot write.
    return `threw ${String(thrown)}`;
  }
}

function describeHostError(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.slice(0, MAX_MESSAGE_LENGTH);
}

function isError(value: unknown): value is { name: string; message: string } {
  if (typeof value !== "object" || value === null) return false;
  const { name, message } = value as Record<string, unknown>;
  return typeof name === "string" && typeof message === "string";
}
