import type { QuickJSRuntime, QuickJSWASMModule } from "quickjs-emscripten";
import { expect, test, vi } from "vitest";

// The engine loads for real unless a test queues another one, with `mockResolvedValueOnce`.
vi.mock("quickjs-emscripten", async (importOriginal) => {
  const actual = await importOriginal<typeof import("quickjs-emscripten")>();
  return { ...actual, newQuickJSWASMModule: vi.fn(actual.newQuickJSWASMModule) };
});

const LIMITS = { timeoutMs: 2_000, memoryBytes: 32 * 1024 * 1024 };

/** The sandbox as if it had just been imported (no engine loaded), and the loads it makes. */
async function freshSandbox() {
  vi.resetModules();
  const { newQuickJSWASMModule } = await import("quickjs-emscripten");
  const { runInSandbox } = await import("../src/sandbox");
  return { runInSandbox, loads: vi.mocked(newQuickJSWASMModule) };
}

/** The host's stack running out in the middle of a call into the engine, in every run on it. */
function overflowWhenEvaluating(runtime: QuickJSRuntime) {
  const newContext = runtime.newContext.bind(runtime);
  runtime.newContext = (...args) => {
    const context = newContext(...args);
    context.evalCode = () => {
      throw new RangeError("Maximum call stack size exceeded");
    };
    return context;
  };
}

/** A real engine whose runtimes are handed to `sabotage` as they are made. */
async function sabotagedEngine(sabotage: (runtime: QuickJSRuntime) => void) {
  const actual = await vi.importActual<typeof import("quickjs-emscripten")>("quickjs-emscripten");
  const engine: QuickJSWASMModule = await actual.newQuickJSWASMModule();
  const runtimes: QuickJSRuntime[] = [];
  const newRuntime = engine.newRuntime.bind(engine);
  engine.newRuntime = (...args) => {
    const runtime = newRuntime(...args);
    runtimes.push(runtime);
    vi.spyOn(runtime, "dispose");
    sabotage(runtime);
    return runtime;
  };
  return { engine, runtimes };
}

test("the_engine_is_loaded_once_and_shared", async () => {
  const { runInSandbox, loads } = await freshSandbox();

  expect(loads).not.toHaveBeenCalled();
  // Runs that start together share the one load, and so do the ones after them.
  const together = await Promise.all([1, 2, 3].map((n) => runInSandbox(`${n} * 10`, LIMITS)));
  expect(together.map((result) => result.ok && result.value)).toEqual([10, 20, 30]);
  expect(await runInSandbox("1 + 1", LIMITS)).toEqual({ ok: true, value: 2 });
  expect(loads).toHaveBeenCalledTimes(1);

  // A run that fails, however it fails, does not cost the engine.
  expect(await runInSandbox("throw new Error('x')", LIMITS)).toMatchObject({ error: "exception" });
  expect(await runInSandbox("while(true){}", { ...LIMITS, timeoutMs: 100 })).toMatchObject({
    error: "timeout",
  });
  expect(await runInSandbox("1 + 1", LIMITS)).toEqual({ ok: true, value: 2 });
  expect(loads).toHaveBeenCalledTimes(1);
});

test("a_failed_load_is_tried_again", async () => {
  const { runInSandbox, loads } = await freshSandbox();
  loads.mockRejectedValueOnce(new Error("the WebAssembly file is missing"));

  // This is one of the two cases that reject: no code ran, and nothing about it is the code's fault.
  await expect(runInSandbox("1 + 1", LIMITS)).rejects.toThrow("the WebAssembly file is missing");
  expect(await runInSandbox("1 + 1", LIMITS)).toEqual({ ok: true, value: 2 });
  expect(loads).toHaveBeenCalledTimes(2);
});

test("a_failure_inside_the_engine_replaces_it", async () => {
  const { runInSandbox, loads } = await freshSandbox();
  const { engine, runtimes } = await sabotagedEngine(overflowWhenEvaluating);
  loads.mockResolvedValueOnce(engine);

  expect(await runInSandbox("1 + 1", LIMITS)).toEqual({
    ok: false,
    error: "exception",
    message: "RangeError: Maximum call stack size exceeded",
  });
  // The runtime it left is not freed: freeing one in that state makes the engine abort.
  expect(runtimes).toHaveLength(1);
  expect(runtimes[0]?.dispose).not.toHaveBeenCalled();

  // The next run does not use that engine.
  expect(loads).toHaveBeenCalledTimes(1);
  expect(await runInSandbox("1 + 1", LIMITS)).toEqual({ ok: true, value: 2 });
  expect(loads).toHaveBeenCalledTimes(2);
  expect(runtimes).toHaveLength(1);
});

test("runs_waiting_for_a_dropped_engine_use_the_next_one", async () => {
  const { runInSandbox, loads } = await freshSandbox();
  const { engine, runtimes } = await sabotagedEngine(overflowWhenEvaluating);
  loads.mockResolvedValueOnce(engine);

  // Runs that start together wait for one load and resume one after another. The first one damages
  // the engine and drops it before the other two get to run, and they must not run on it: every
  // run on this engine fails, so one that did would show.
  const results = await Promise.all([
    runInSandbox("1 + 1", LIMITS),
    runInSandbox("2 + 2", LIMITS),
    runInSandbox("3 + 3", LIMITS),
  ]);
  expect(results).toEqual([
    { ok: false, error: "exception", message: "RangeError: Maximum call stack size exceeded" },
    { ok: true, value: 4 },
    { ok: true, value: 6 },
  ]);
  // Only the first run was on the damaged engine. The other two used the second load, which they
  // shared.
  expect(runtimes).toHaveLength(1);
  expect(loads).toHaveBeenCalledTimes(2);
});

test("a_runtime_that_cannot_start_replaces_the_engine", async () => {
  const { runInSandbox, loads } = await freshSandbox();
  const { engine } = await sabotagedEngine(() => {});
  engine.newRuntime = () => {
    throw new Error("memory access out of bounds");
  };
  loads.mockResolvedValueOnce(engine);

  // No code ran, so this is the host's trouble and the other case that rejects. The engine is
  // in no state to be asked again, though.
  await expect(runInSandbox("1 + 1", LIMITS)).rejects.toThrow("memory access out of bounds");
  expect(await runInSandbox("1 + 1", LIMITS)).toEqual({ ok: true, value: 2 });
  expect(loads).toHaveBeenCalledTimes(2);
});

test("a_failure_to_free_replaces_the_engine", async () => {
  const { runInSandbox, loads } = await freshSandbox();
  const { engine } = await sabotagedEngine((runtime) => {
    runtime.dispose = () => {
      throw new Error("Aborted(Assertion failed)");
    };
  });
  loads.mockResolvedValueOnce(engine);

  // The code ran and finished: its value is its value, whatever happens when the runtime is freed.
  expect(await runInSandbox("6 * 7", LIMITS)).toEqual({ ok: true, value: 42 });
  expect(loads).toHaveBeenCalledTimes(1);
  expect(await runInSandbox("1 + 1", LIMITS)).toEqual({ ok: true, value: 2 });
  expect(loads).toHaveBeenCalledTimes(2);
});

test("a_run_that_ends_normally_frees_its_runtime", async () => {
  const { runInSandbox, loads } = await freshSandbox();
  const { engine, runtimes } = await sabotagedEngine(() => {});
  loads.mockResolvedValueOnce(engine);

  // Whatever the code did, even when it did not finish: the runtime is freed, and once.
  await runInSandbox("1 + 1", LIMITS);
  await runInSandbox("throw new Error('x')", LIMITS);
  await runInSandbox("while(true){}", { ...LIMITS, timeoutMs: 100 });
  await runInSandbox("let a=[];while(true)a.push(new Array(1e6))", LIMITS);
  expect(runtimes).toHaveLength(4);
  for (const runtime of runtimes) expect(runtime.dispose).toHaveBeenCalledTimes(1);
  expect(loads).toHaveBeenCalledTimes(1);
});
