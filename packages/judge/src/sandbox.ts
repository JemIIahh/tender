import {
  newQuickJSWASMModule,
  type QuickJSContext,
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
 */
export type SandboxResult =
  | { ok: true; value: unknown }
  | { ok: false; error: "timeout" | "memory" | "exception"; message: string };

/** How much of the engine's stack the code may use. */
const MAX_STACK_BYTES = 1_048_576;
/** A message is for a log. Code that throws a long text does not get to carry it out. */
const MAX_MESSAGE_LENGTH = 500;

/**
 * The engine: QuickJS compiled to WebAssembly, loaded on the first run and shared by the runs
 * after it. A run that finds it damaged drops it, so the next run loads a fresh one.
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
 * that runs while the value is read), and past the limit the allocation fails (`memory`).
 * Anything else the code throws, syntax errors and the engine's own stack overflow included, is
 * an `exception`. The value is what the engine's `dump` makes of the last statement's value:
 * plain data.
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
 * is neither freed, which makes the engine abort the whole module for good, nor reused: the
 * module is dropped and the next run loads a new one. The failed run is an `exception`.
 */
export async function runInSandbox(code: string, opts: SandboxOptions): Promise<SandboxResult> {
  const loading = loadEngine();
  const quickJS = await loading;

  const runtime = quickJS.newRuntime();
  let context: QuickJSContext | undefined;
  let damaged = false;
  // Whether the deadline cut anything short. The interrupt is an error that nothing in the code
  // can catch, but the engine swallows it where it reads the value (a `toJSON` that loops), so
  // the run is a timeout when the handler fired, and not when an error says so.
  let interrupted = false;
  try {
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
        runtime.dispose();
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
  // How the engine reports an allocation past the limit: an error that nothing in the code can
  // catch.
  if (isError(thrown) && thrown.name === "InternalError" && thrown.message === "out of memory") {
    return { ok: false, error: "memory", message };
  }
  return { ok: false, error: "exception", message };
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
