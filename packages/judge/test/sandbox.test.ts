import { expect, test } from "vitest";
import { runInSandbox } from "../src/sandbox";

/** What the Judge gives a regex: two seconds and 32 MiB. */
const LIMITS = { timeoutMs: 2_000, memoryBytes: 32 * 1024 * 1024 };
const run = (code: string) => runInSandbox(code, LIMITS);

test("sandbox_returns_values", async () => {
  expect(await run("1 + 1")).toEqual({ ok: true, value: 2 });
  expect(await run('"qu" + "ick"')).toEqual({ ok: true, value: "quick" });
  expect(await run("true")).toEqual({ ok: true, value: true });
  expect(await run("null")).toEqual({ ok: true, value: null });
  // The value of the last statement, as plain data.
  expect(
    await run(
      "const xs = [1, 2, 3]; ({ sum: xs.reduce((a, b) => a + b), xs, flags: [true, [false]] })",
    ),
  ).toEqual({ ok: true, value: { sum: 6, xs: [1, 2, 3], flags: [true, [false]] } });
});

test("sandbox_has_no_host_access", async () => {
  expect(
    await run(
      'typeof fetch==="undefined"&&typeof require==="undefined"&&typeof process==="undefined"',
    ),
  ).toEqual({ ok: true, value: true });

  // Nor anything else the host has: no timers, console, modules, binary buffers or WebAssembly.
  const hostNames = [
    "console",
    "setTimeout",
    "setInterval",
    "setImmediate",
    "queueMicrotask",
    "structuredClone",
    "Buffer",
    "global",
    "module",
    "exports",
    "__dirname",
    "WebAssembly",
    "XMLHttpRequest",
    "TextEncoder",
    "std",
    "os",
    "print",
  ];
  expect(
    await run(
      `${JSON.stringify(hostNames)}.filter((name) => typeof globalThis[name] !== "undefined")`,
    ),
  ).toEqual({ ok: true, value: [] });
});

test("infinite_loop_times_out", { timeout: 10_000 }, async () => {
  // The first run loads the engine. Loading is not part of the budget, and not of this clock.
  await run("1");

  const started = performance.now();
  const result = await run("while(true){}");
  expect(performance.now() - started).toBeLessThan(2_500);
  expect(result).toMatchObject({ ok: false, error: "timeout" });

  // The next run is a fresh runtime with a fresh budget.
  expect(await run("1 + 1")).toEqual({ ok: true, value: 2 });
});

test("a_loop_in_reading_the_value_times_out", { timeout: 10_000 }, async () => {
  // The value is read after the code has finished, and reading it can run the code's own
  // functions. The deadline still holds there. The engine swallows the interrupt it raises in
  // that place, and would hand back a placeholder text for the value as if all had gone well.
  const budget = { timeoutMs: 200, memoryBytes: 32 * 1024 * 1024 };
  for (const code of [
    "({ toJSON() { while (true) {} } })",
    "({ get x() { while (true) {} } })",
    "new Proxy({}, { ownKeys() { while (true) {} } })",
    "throw { toJSON() { while (true) {} } }",
  ]) {
    const started = performance.now();
    expect(await runInSandbox(code, budget), code).toMatchObject({ ok: false, error: "timeout" });
    expect(performance.now() - started).toBeLessThan(1_500);
  }
});

test("memory_bomb_contained", { timeout: 10_000 }, async () => {
  const result = await run("let a=[];while(true)a.push(new Array(1e6))");
  expect(result.ok).toBe(false);
  expect(["memory", "exception"]).toContain(result.ok ? undefined : result.error);

  // What the bomb allocated was freed with its runtime: the next run is not short of memory.
  expect(await run("new Array(1e6).length")).toEqual({ ok: true, value: 1_000_000 });
});

test("out_of_memory_in_a_regex_is_memory", async () => {
  // The engine runs out of its budget in two places for a regex, with two messages that are not
  // the one a plain allocation gives: while the regex runs, and while it is compiled.
  expect(await run('new RegExp("(?:|){2147483647}").test("x")')).toEqual({
    ok: false,
    error: "memory",
    message: "InternalError: out of memory in regexp execution",
  });
  const tightBudget = { timeoutMs: 2_000, memoryBytes: 1024 * 1024 };
  expect(await runInSandbox('new RegExp("\\\\p{L}".repeat(400), "iu")', tightBudget)).toEqual({
    ok: false,
    error: "memory",
    message: "SyntaxError: out of memory",
  });

  // Errors that only mention it are exceptions, and so is every other SyntaxError.
  for (const thrown of [
    'new Error("out of memory")',
    'new RangeError("out of memory")',
    'new SyntaxError("out of memory in a pattern")',
    'new InternalError("not out of memory")',
  ]) {
    expect(await run(`throw ${thrown}`), thrown).toMatchObject({ ok: false, error: "exception" });
  }
  expect(await run('new RegExp("(")')).toMatchObject({ ok: false, error: "exception" });
});

test("exceptions_are_reported", async () => {
  // An error is described as `name: message`: the regex scorer tells a SyntaxError by it.
  expect(await run("throw new Error('boom')")).toEqual({
    ok: false,
    error: "exception",
    message: "Error: boom",
  });
  expect(await run("null.x")).toMatchObject({
    ok: false,
    error: "exception",
    message: expect.stringMatching(/^TypeError: /),
  });
  expect(await run("new RegExp('(')")).toMatchObject({
    ok: false,
    error: "exception",
    message: expect.stringMatching(/^SyntaxError: /),
  });
  expect(await run("(")).toMatchObject({
    ok: false,
    error: "exception",
    message: expect.stringMatching(/^SyntaxError: /),
  });

  // Anything can be thrown, and none of it is an error object.
  for (const [thrown, described] of [
    ["42", "threw 42"],
    ['"text"', 'threw "text"'],
    ["null", "threw null"],
    ["undefined", "threw undefined"],
    ["({ a: 1 })", 'threw {"a":1}'],
  ] as const) {
    expect(await run(`throw ${thrown}`), thrown).toEqual({
      ok: false,
      error: "exception",
      message: described,
    });
  }

  // A message is a line for a log, not a way to carry the thrown text out.
  const long = await run("throw new Error('x'.repeat(100000))");
  expect(long).toMatchObject({ ok: false, error: "exception" });
  expect(long.ok ? 0 : long.message.length).toBeLessThanOrEqual(500);
});

test("each_run_starts_clean", async () => {
  expect(await run("globalThis.leaked = 1; Array.prototype.leaked = 2; leaked")).toEqual({
    ok: true,
    value: 1,
  });
  expect(await run("[typeof leaked, typeof [].leaked]")).toEqual({
    ok: true,
    value: ["undefined", "undefined"],
  });
});

test("promise_results_are_cleaned_up", async () => {
  // `dump` disposes the handle of a promise itself, and a second dispose throws.
  expect(await run("Promise.resolve(1)")).toMatchObject({ ok: true });
  expect(await run("new Promise(() => {})")).toMatchObject({ ok: true });
  expect(await run("Promise.reject(new Error('x'))")).toMatchObject({ ok: true });
  expect(await run("1 + 1")).toEqual({ ok: true, value: 2 });
});

test("code_is_a_script_not_a_module", async () => {
  // Without an explicit type the engine guesses, and a guess could return a promise of exports.
  expect(await run("export const a = 1; 5")).toMatchObject({
    ok: false,
    error: "exception",
    message: expect.stringMatching(/^SyntaxError: /),
  });
  expect(await run('import { a } from "b"; 5')).toMatchObject({
    ok: false,
    error: "exception",
    message: expect.stringMatching(/^SyntaxError: /),
  });
});

test("many_runs_dispose_cleanly", async () => {
  // An undisposed handle makes the engine abort the whole module when its runtime is freed.
  for (let i = 0; i < 200; i++) {
    expect(await run(`[${i}, "x", { n: ${i} }]`)).toEqual({
      ok: true,
      value: [i, "x", { n: i }],
    });
  }
});

test("deep_recursion_is_contained", { timeout: 20_000 }, async () => {
  // Recursion that nothing stops. Depending on the thread's stack, the engine ends it with a
  // stack overflow of its own or the host's stack runs out first, and the engine is left in the
  // middle of a call: freeing that runtime would abort the whole module for the rest of the
  // process. A run ends in an exception whichever way, and the results of the runs that follow it
  // are not affected: one after another here, and in one batch in the test after this one.
  const recursion = [
    "function f() { f() } f()",
    "const o = { get x() { return o.x } }; o.x",
    "function f() { return [1].map(f) } f()",
    // Source text for the sandbox, like the rest of this list. The sandbox's parser recurses in C,
    // and only the host's stack ends it.
    "eval('['.repeat(200000))",
  ];
  for (let round = 0; round < 3; round++) {
    for (const code of recursion) {
      expect(await run(code), code).toMatchObject({ ok: false, error: "exception" });
    }
    expect(await run("[1, 2, 3].map((n) => n * 2)")).toEqual({ ok: true, value: [2, 4, 6] });
  }

  // The limits still hold afterwards: the budget is the one passed, not a stale one.
  const started = performance.now();
  expect(
    await runInSandbox("while(true){}", { timeoutMs: 200, memoryBytes: 32 * 1024 * 1024 }),
  ).toMatchObject({ ok: false, error: "timeout" });
  expect(performance.now() - started).toBeLessThan(1_500);
});

test("deep_recursion_does_not_break_the_runs_beside_it", { timeout: 20_000 }, async () => {
  // Runs that start together share the engine until one of them damages it. Twenty recursions
  // damage it twenty times in a batch, and the runs between them are as good as any others.
  const codes = Array.from({ length: 40 }, (_, i) =>
    i % 2 === 0 ? "function f() { f() } f()" : `[${i}, ${i} * 2]`,
  );
  const results = await Promise.all(codes.map((code) => run(code)));
  results.forEach((result, i) => {
    expect(result, codes[i]).toMatchObject(
      i % 2 === 0 ? { ok: false, error: "exception" } : { ok: true, value: [i, i * 2] },
    );
  });
});
