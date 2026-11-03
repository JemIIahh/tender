import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PublicCriteria } from "@tender/shared";
import { afterAll, expect, test, vi } from "vitest";
import { scoreEntry, scoreTests } from "../src/index";
import { openTaskScorer, type Scoring } from "../src/isolate";
import type { HeldoutOf } from "../src/kinds/common";
import { runInSandbox, Sandbox } from "../src/sandbox";

// The `tests` kind runs an entrant's JavaScript, so most of this file is about what that code
// cannot do. The hostile entries are real attempts, and each of them has to score 0 without
// stopping the Judge and in the time the kind allows: 1 s for a case, so `cases × 1.2 s` for all.
// docs/research/S8-sandbox.md records what each one came to.
//
// These tests must give the same answer on a busy machine, so what they bound is the work an entry
// costs, not the time it waits for a CPU (see `cpuMeter`), and a test about what happens when a
// case runs out of memory gives the case time enough for the memory to run out first (see
// `withTimeBudget`). The tests of the time limit itself (a loop that is ended at its second) keep
// the production limit: the engine's deadline is a wall clock, and ending a loop is what they show.

type TestsCriteria = Extract<PublicCriteria, { kind: "tests" }>;
type TestsHeldout = HeldoutOf<"tests">;
type Case = { input: unknown; output: unknown };

function criteria(examples: Case[] = [], minScore = 100, entry = "f"): TestsCriteria {
  return {
    version: 1,
    kind: "tests",
    min_score: minScore,
    split: "winner_take_all",
    has_heldout: true,
    language: "js",
    entry,
    examples,
  };
}

const heldout = (cases: Case[]): TestsHeldout => ({ cases });
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/**
 * A meter of the CPU time that this thread uses, in milliseconds, from now. A bound on how long
 * code took by the clock on the wall is a bound on how busy the machine was as well: the same
 * entry takes seconds on a host that is running dozens of other jobs. The CPU time of the thread
 * that runs the sandbox is what the entry cost, whatever else the machine was doing, and it is
 * never more than the time on the wall. (Only for work that runs on this thread, as the sandbox's
 * does here.)
 */
function cpuMeter(): () => number {
  const from = process.threadCpuUsage();
  return () => {
    const used = process.threadCpuUsage(from);
    return (used.user + used.system) / 1_000;
  };
}

/**
 * Runs `body` with every run in the sandbox given `timeoutMs`, whatever limit its caller asked
 * for, and puts the limit back after. For a test of what a case that runs out of memory comes to:
 * the memory is the limit that has to end it, and the production second can be spent on a busy
 * machine before an allocation loop has filled the engine (its 128 MiB takes 0.2 s of CPU). The
 * memory limits are the production ones, and the time given is far longer than any allocation
 * loop can live: the engine's memory cannot grow past its cap.
 */
async function withTimeBudget<T>(timeoutMs: number, body: () => Promise<T>): Promise<T> {
  const run = Sandbox.prototype.run;
  const spy = vi.spyOn(Sandbox.prototype, "run").mockImplementation(function (
    this: Sandbox,
    code,
    opts,
  ) {
    return run.call(this, code, { ...opts, timeoutMs });
  });
  try {
    return await body();
  } finally {
    spy.mockRestore();
  }
}

// Written as code points, so that the characters can be seen in the source.
const LINE_SEPARATOR = String.fromCodePoint(0x2028);
/** Three bytes in UTF-8. */
const EURO = String.fromCodePoint(0x20ac);
const E_ACUTE = String.fromCodePoint(0xe9);

/** `f(x)` is `x + 1`: these are its cases, and the answers that fail them are a variation. */
const PLUS_ONE: Case[] = [
  { input: 1, output: 2 },
  { input: 2, output: 3 },
  { input: 3, output: 4 },
  { input: 10, output: 11 },
];
const RIGHT = "function f(x) { return x + 1; }";

/** Scores `source` on the held-out `cases`, which decide the whole score. */
const score = (source: string, cases: Case[] = PLUS_ONE, entry = "f") =>
  scoreTests(criteria([], 100, entry), heldout(cases), bytes(source));

const zero = (...reasons: string[]) => ({ score: 0, passed: false, reasons });

test("correct_function_scores_100", async () => {
  expect(await score(RIGHT)).toEqual({ score: 100, passed: true, reasons: [] });
  // Any way of defining the function the criteria name.
  for (const source of [
    "const f = (x) => x + 1;",
    "var f = function (x) { return x + 1; };",
    "function helper(x) { return x + 1; }\nconst f = (x) => helper(x);",
    "'use strict';\nfunction f(x) { return x + 1; }",
    "function f(x) { return x + 1; } // a comment with no newline at the end",
  ]) {
    expect(await score(source), source).toEqual({ score: 100, passed: true, reasons: [] });
  }
  // A leading byte order mark is dropped, as it is for the other kinds.
  expect(
    await scoreTests(
      criteria(),
      heldout(PLUS_ONE),
      Uint8Array.from([0xef, 0xbb, 0xbf, ...bytes(RIGHT)]),
    ),
  ).toMatchObject({ score: 100 });
});

test("half_wrong_scores_50", async () => {
  // Right for the first two inputs, wrong for the other two.
  const result = await score("function f(x) { return x <= 2 ? x + 1 : 0; }");
  expect(result.score).toBe(50);
  expect(result.passed).toBe(false);
  expect(result.reasons).toEqual(["case 3 (3): wrong output", "case 4 (10): wrong output"]);
  // The pass mark is the criteria's.
  const lenient = await scoreTests(
    criteria([], 50),
    heldout(PLUS_ONE),
    bytes("function f(x) { return x <= 2 ? x + 1 : 0; }"),
  );
  expect(lenient).toMatchObject({ score: 50, passed: true });
});

test("the_score_is_the_rounded_share_of_cases_passed", async () => {
  const three: Case[] = [1, 2, 3].map((n) => ({ input: n, output: n + 1 }));
  expect((await score("function f(x) { return x === 1 ? 2 : 0; }", three)).score).toBe(33);
  expect((await score("function f(x) { return x === 3 ? 0 : x + 1; }", three)).score).toBe(67);
  expect((await score("function f(x) { return 0; }", three)).score).toBe(0);
  // 100 means every case was right: one failure in 300 would round up to it.
  const many: Case[] = Array.from({ length: 300 }, (_, i) => ({ input: i, output: i + 1 }));
  const almost = await score("function f(x) { return x === 7 ? 0 : x + 1; }", many);
  expect(almost.score).toBe(99);
});

test("the_published_examples_are_the_cases_without_a_held_out_document", async () => {
  const c = criteria([
    { input: 1, output: 2 },
    { input: 5, output: 6 },
  ]);
  expect(await scoreTests(c, null, bytes(RIGHT))).toEqual({
    score: 100,
    passed: true,
    reasons: [],
  });
  expect(await scoreTests(c, null, bytes("function f(x) { return 2; }"))).toMatchObject({
    score: 50,
  });
  // The held-out cases replace the examples, they are not added to them.
  expect(
    await scoreTests(
      c,
      heldout([{ input: 9, output: 10 }]),
      bytes("function f(x) { return x + 1; }"),
    ),
  ).toMatchObject({ score: 100 });
  expect(
    await scoreTests(c, heldout([{ input: 1, output: 2 }]), bytes("function f(x) { return 99; }")),
  ).toMatchObject({ score: 0 });
  // No case at all: nothing to score, not a score of NaN.
  expect(await scoreTests(criteria([]), null, bytes(RIGHT))).toEqual(zero("no test cases"));
});

test("outputs_are_compared_as_JSON_values", async () => {
  const cases: Case[] = [
    { input: 0, output: { b: [1, { c: null }], a: "x" } },
    { input: 1, output: [] },
    { input: 2, output: null },
    { input: 3, output: "" },
    { input: 4, output: 1.5 },
  ];
  const source = `function f(n) {
    switch (n) {
      case 0: return { a: "x", b: [1, { c: null }] };   // key order does not matter
      case 1: return [];
      case 2: return NaN;                                  // JSON writes it as null
      case 3: return "";
      default: return 3 / 2;
    }
  }`;
  expect(await score(source, cases)).toEqual({ score: 100, passed: true, reasons: [] });

  const wrong: [string, unknown][] = [
    ["a string for a number", { input: 0, output: 1 }],
    ["a number for a string", { input: 0, output: "1" }],
    ["an array for an object", { input: 0, output: {} }],
    ["an object for an array", { input: 0, output: [] }],
    ["an extra key", { input: 0, output: { a: 1 } }],
    ["a missing key", { input: 0, output: { a: 1, b: 2 } }],
    ["null for an empty object", { input: 0, output: {} }],
  ];
  const answers = [`"1"`, `1`, `[]`, `{}`, `{ a: 1, b: 2 }`, `{ a: 1 }`, `null`];
  for (const [i, [what, testCase]] of wrong.entries()) {
    const result = await score(`function f() { return ${answers[i]}; }`, [testCase as Case]);
    expect(result.score, what).toBe(0);
  }
  // A function that returns nothing writes no JSON, and the reason says so.
  expect(await score("function f() {}", [{ input: 0, output: null }])).toMatchObject({
    score: 0,
    reasons: ["case 1 (0): no JSON output"],
  });
});

test("the_input_reaches_the_function_as_data_and_never_as_code", async () => {
  const inputs = [
    `a${LINE_SEPARATOR}b`, // JSON is JavaScript since ES2019, so a raw line separator is fine in the source
    '"); while (true) {} ("',
    "\\u0022 + (function(){ while(true){} })() + \\u0022",
    { __proto__x: 1, "a'b": [null, true, -0, 1e21] },
    [[], [[]], ""],
  ];
  const cases = inputs.map((input) => ({ input, output: input }));
  expect(await score("function f(x) { return x; }", cases)).toEqual({
    score: 100,
    passed: true,
    reasons: [],
  });
});

test("every_case_runs_in_a_runtime_of_its_own", async () => {
  // A counter the function keeps would be 1, 2, 3 if the cases shared a runtime, and so would a
  // property it leaves on a built-in.
  const source = `var calls = 0;
    function f(x) { Array.prototype.marked = (Array.prototype.marked || 0) + 1; return ++calls + [].marked; }`;
  const cases: Case[] = [1, 2, 3].map((n) => ({ input: n, output: 2 }));
  expect((await score(source, cases)).score).toBe(100);
});

test("the_source_may_be_65536_bytes_and_no_more", async () => {
  const pad = (bytesWanted: number) => `${RIGHT}\n//${"x".repeat(bytesWanted - RIGHT.length - 3)}`;
  expect(bytes(pad(65_536)).byteLength).toBe(65_536);
  expect(await score(pad(65_536))).toMatchObject({ score: 100 });
  expect(await score(pad(65_537))).toEqual(zero("source larger than 65536 bytes"));
  // The size is of the bytes, not of the characters: 3 bytes each.
  const wide = `${RIGHT}\n//${EURO.repeat(21_845)}`;
  expect(bytes(wide).byteLength).toBeGreaterThan(65_536);
  expect(await score(wide)).toEqual(zero("source larger than 65536 bytes"));
});

test("an_entry_that_is_no_code_scores_zero_and_does_not_throw", async () => {
  expect(await scoreTests(criteria(), heldout(PLUS_ONE), Uint8Array.of(0xff, 0xfe, 0x66))).toEqual(
    zero("not valid UTF-8"),
  );
  for (const source of [
    "",
    "function f(x) {",
    "export function f(x) { return x + 1; }", // a script, not a module
    "import fs from 'fs';\nfunction f(x) { return x + 1; }",
    "/* never closed\nfunction f(x) { return x + 1; }",
    "function f(x) { return x + 1; }\n/*",
    "const g = 1;", // defines no f
    "const f = 3;", // not a function
    "function f(x) { throw new Error('no'); }",
    "function f(x) { throw 42; }",
    "function f(x) { throw { toString() { while (true) {} } }; }",
    "function f(x) { return x + 1; }\nthrow new Error('at the top');",
    "function f(x) { return async () => x + 1; }",
    "async function f(x) { return x + 1; }", // a promise is no JSON value
    "function f(x) { return Symbol('s'); }",
    "function f(x) { return 10n; }",
  ]) {
    const result = await score(source);
    expect(result.score, source).toBe(0);
    expect(result.passed, source).toBe(false);
  }
});

test("an_entry_that_names_what_it_wants_to_be_called_cannot_change_the_cases", async () => {
  // The answer cannot see the cases or the expected outputs, only the input it is called with.
  const peek =
    "function f(x) { return typeof expected + typeof cases + typeof globalThis.heldout; }";
  const result = await score(peek, [{ input: 1, output: "undefinedundefinedundefined" }]);
  expect(result.score).toBe(100);
});

test("a_criteria_entry_that_is_not_a_name_scores_zero_and_runs_nothing", async () => {
  // Intake refuses such criteria; this is the scorer not trusting that it did.
  for (const entry of [
    "",
    "f; while (true) {}",
    "f.g",
    "1f",
    "f g",
    "class",
    "a-b",
    "f(",
    E_ACUTE,
  ]) {
    const result = await score(RIGHT, PLUS_ONE, entry);
    expect(result, entry).toEqual(zero("criteria entry is not a function name"));
  }
});

// ---------------------------------------------------------------------------------------------
// Hostile entries. Each attempts something, and is written so that if the attempt worked the
// entry would answer correctly (a 100) or leave the canary file behind.

const dir = mkdtempSync(join(tmpdir(), "tender-s8-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const CANARY = join(dir, "escaped");
const canaryPath = JSON.stringify(CANARY);

const HOSTILE: Record<string, string> = {
  infinite_loop: "function f(x) { while (true) {} }",
  infinite_loop_with_calls: "function g() { return 1; }\nfunction f(x) { for (;;) { g(); } }",
  memory_bomb_arrays:
    "function f(x) { const a = []; while (true) a.push(new Array(1000).fill(0)); }",
  memory_bomb_objects: "function f(x) { const a = []; while (true) a.push({ a: 1, b: [x] }); }",
  memory_bomb_string: "function f(x) { let s = 'x'; while (true) s += s; }",
  memory_bomb_one_block: "function f(x) { return new Array(1e9).fill(0).length; }",
  // One allocation past the limit, which fails at once (the array above fills until a block grows
  // past it): out of memory in every case, however slow the machine.
  memory_bomb_one_allocation: "function f(x) { return new Uint8Array(1e9).length; }",
  deep_recursion: "function f(x) { return f(x + 1) + 1; }",
  deep_recursion_through_json:
    "function f(x) { let a = []; for (let i = 0; i < 1e6; i++) a = [a]; return a; }",
  regex_backtracking: "function f(x) { return /^(a+)+$/.test('a'.repeat(40) + '!') ? x + 1 : 0; }",
  // `import()` can only answer later, so this returns the promise: a 0 whatever happens. The
  // canary is the evidence, and "dynamic_import_is_refused_by_the_engine" shows the refusal.
  dynamic_import: `function f(x) { return import("node:fs").then((fs) => fs.writeFileSync(${canaryPath}, "x")); }`,
  require_child_process: `function f(x) { require("child_process").execSync("touch " + ${canaryPath}); return x + 1; }`,
  require_fs: `function f(x) { require("fs").writeFileSync(${canaryPath}, "x"); return x + 1; }`,
  constructor_chain_to_process: `function f(x) { const p = globalThis.constructor.constructor("return process")(); p.mainModule.require("fs").writeFileSync(${canaryPath}, "x"); return x + 1; }`,
  function_constructor_to_process: `function f(x) { return (0, Function)("return process.pid")() > 0 ? x + 1 : 0; }`,
  reads_the_host_through_this: `function f(x) { return (function () { return this; })().process === undefined ? 0 : x + 1; }`,
  fetch_the_network: `function f(x) { fetch("http://127.0.0.1:9/").then(() => 0); return typeof fetch === "function" ? x + 1 : 0; }`,
  timers:
    "function f(x) { return typeof setTimeout === 'function' && typeof setInterval === 'function' ? x + 1 : 0; }",
  web_assembly_and_threads:
    "function f(x) { return typeof WebAssembly !== 'undefined' || typeof Atomics !== 'undefined' || typeof Worker !== 'undefined' || typeof MessageChannel !== 'undefined' ? x + 1 : 0; }",
  endless_tojson: "function f(x) { return { toJSON() { while (true) {} } }; }",
  endless_getter: "function f(x) { return { get a() { while (true) {} } }; }",
  endless_proxy: "function f(x) { return new Proxy({}, { ownKeys() { while (true) {} } }); }",
  catches_its_own_timeout: "function f(x) { for (;;) { try { while (true) {} } catch (e) {} } }",
  catches_out_of_memory:
    "function f(x) { for (;;) { try { const a = []; while (true) a.push(new Array(1000).fill(0)); } catch (e) {} } }",
  output_flood: "function f(x) { return 'x'.repeat(30 * 1024 * 1024); }",
  floods_the_job_queue:
    "function f(x) { for (let i = 0; i < 1e6; i++) Promise.resolve().then(() => {}); return 0; }",
};

/** The source of the hostile entry called `name`. */
function hostile(name: string): string {
  const source = HOSTILE[name];
  if (source === undefined) throw new Error(`no hostile entry called ${name}`);
  return source;
}

for (const [name, source] of Object.entries(HOSTILE)) {
  // The timeout is for a hang, which only the test run ends: nothing here is about time on the wall.
  test(`hostile_${name}_scores_0`, { timeout: 120_000 }, async () => {
    const cpu = cpuMeter();
    const result = await score(source);
    const cpuMs = cpu();

    expect(result.score, JSON.stringify(result)).toBe(0);
    expect(result.passed).toBe(false);
    expect(existsSync(CANARY), "the entry reached the host's file system").toBe(false);
    // The cases are 4: 4.8 s is the whole bound, and the first failed case that runs out of time
    // ends the run, so one case's second is what a loop costs. It is the CPU time of the entry
    // that is bounded: its time on the wall also counts the time it waited for a CPU, which is
    // the machine's busyness and not the entry's cost.
    expect(cpuMs, `${name} used ${Math.round(cpuMs)} ms of CPU`).toBeLessThan(
      PLUS_ONE.length * 1_200,
    );
  });
}

test("an_entry_that_replaces_JSON_stringify_controls_only_its_own_answers", async () => {
  // It can write whatever it likes as its answer, as any entry can, and gets the cases whose
  // expected output that happens to be. It cannot read the expected outputs, or see the cases.
  const result = await score("JSON.stringify = () => '2';\nfunction f(x) { return 0; }");
  expect(result.score).toBe(25);
  expect(result.reasons).toEqual([
    "case 2 (2): wrong output",
    "case 3 (3): wrong output",
    "case 4 (10): wrong output",
  ]);
  // Answers that are no JSON text, or no text at all, are failed cases and not crashes.
  for (const replacement of [
    "() => ({})",
    "() => 2",
    "() => '{'",
    "() => undefined",
    "() => { throw 1; }",
  ]) {
    const answer = await score(`JSON.stringify = ${replacement};\nfunction f(x) { return x + 1; }`);
    expect(answer.score, replacement).toBe(0);
  }
});

test("dynamic_import_is_refused_by_the_engine", async () => {
  // `import()` returns a promise at once, and the answer is for later: so look at the answer, in a
  // runtime made as the sandbox makes its own (no module loader), with the jobs run by hand.
  const { newQuickJSWASMModule } = await import("quickjs-emscripten");
  const engine = await newQuickJSWASMModule();
  const runtime = engine.newRuntime();
  const context = runtime.newContext();
  try {
    const run = context.evalCode(
      'var seen = "nothing yet";\n' +
        'import("node:fs").then(() => { seen = "loaded"; }, (e) => { seen = "refused: " + e.message; });\n' +
        'import("data:text/javascript,export default 1").then(() => { seen += " / data loaded"; }, () => { seen += " / data refused"; });',
      undefined,
      { type: "global" },
    );
    if (run.error) run.error.dispose();
    else run.value.dispose();
    runtime.executePendingJobs();
    const seen = context.getProp(context.global, "seen");
    const text = context.dump(seen);
    seen.dispose();
    expect(text).toContain("refused");
    expect(text).not.toContain("loaded");
    expect(text).toMatch(/data refused$/);
  } finally {
    context.dispose();
    runtime.dispose();
  }
});

test("a_hostile_entry_does_not_disturb_the_entries_scored_after_it", {
  timeout: 120_000,
}, async () => {
  // The ones that end a run the hardest: the engine's interrupt, its memory and its stack.
  for (const name of [
    "infinite_loop",
    "memory_bomb_arrays",
    "deep_recursion",
    "deep_recursion_through_json",
    "catches_out_of_memory",
    "constructor_chain_to_process",
  ]) {
    expect((await score(hostile(name))).score, name).toBe(0);
    expect(await score(RIGHT)).toEqual({ score: 100, passed: true, reasons: [] });
  }
});

test("a_case_that_times_out_ends_the_run_and_the_cases_after_it_count_as_failed", async () => {
  // Only the third input loops. The cases after it are not run, and count as failed: the score is
  // over all the cases, 2 of 4 here.
  const source = "function f(x) { if (x === 3) { while (true) {} } return x + 1; }";
  const cpu = cpuMeter();
  const result = await score(source);
  // One second for the loop and nothing for the cases after it: the CPU time it cost, not the
  // time it waited for one.
  expect(cpu()).toBeLessThan(2_500);
  expect(result.score).toBe(50);
  expect(result.reasons).toEqual(["case 3 (3): timed out", "1 more case not run"]);
  // The total is every case, not the ones that ran: 1 of 5.
  const five: Case[] = [1, 2, 3, 4, 5].map((n) => ({ input: n, output: n + 1 }));
  const second = await score(
    "function f(x) { if (x === 2) { while (true) {} } return x + 1; }",
    five,
  );
  expect(second).toMatchObject({
    score: 20,
    reasons: ["case 2 (2): timed out", "3 more cases not run"],
  });
  // One that only throws is not a reason to stop: the cases after it run.
  const throws = await score("function f(x) { if (x === 3) throw new Error('x'); return x + 1; }");
  expect(throws).toMatchObject({ score: 75, reasons: ["case 3 (3): threw an exception"] });
});

test("a_case_that_runs_out_of_memory_does_not_zero_the_entry", { timeout: 120_000 }, async () => {
  // Input 3 allocates until the engine gives out. The cases after it still run, on a new engine,
  // and pass: 4 of 5. Input 5 needs 20 MB of its own, which a used-up engine could not give.
  // The case has all the time it needs, so that it is the memory that ends it on any machine: the
  // second the kind gives a case can run out before an allocation loop has filled the engine on one
  // that is busy, and then the case would end as `timed out` and the run with it.
  const source = `function f(x) {
    if (x === 3) { const a = []; while (true) a.push(new Array(1000).fill(0)); }
    if (x === 5) return new Array(2_500_000).fill(1).length;
    return x + 1;
  }`;
  const cases: Case[] = [
    { input: 1, output: 2 },
    { input: 2, output: 3 },
    { input: 3, output: 4 },
    { input: 4, output: 5 },
    { input: 5, output: 2_500_000 },
  ];
  await withTimeBudget(120_000, async () => {
    const result = await score(source, cases);
    expect(result).toEqual({
      score: 80,
      passed: false,
      reasons: ["case 3 (3): ran out of memory"],
    });
    // One case lost whichever it is: with the bomb on the first input it is the first that fails.
    const first = await score(source.replace("x === 3", "x === 1"), cases);
    expect(first).toMatchObject({ score: 80, reasons: ["case 1 (1): ran out of memory"] });
  });
});

test("the_sandbox_engine_cannot_be_grown_past_its_cap_by_many_small_allocations", {
  timeout: 120_000,
}, async () => {
  // The engine counts one allocation against the limit and not all of them (it has no way to ask
  // how big a block it holds), so 32 MiB stops one block and nothing else. With a time to spare,
  // only the cap on the engine's whole memory can end this run, and it ends it at once.
  const cpu = cpuMeter();
  const result = await runInSandbox("const a = []; while (true) a.push(new Array(1000).fill(0));", {
    timeoutMs: 20_000,
    memoryBytes: 32 * 1024 * 1024,
  });
  expect(result).toMatchObject({ ok: false });
  expect(result.ok ? "" : result.error).not.toBe("timeout");
  // It takes 0.2 s of CPU to fill the engine, and the bound is the CPU time it cost.
  expect(cpu()).toBeLessThan(5_000);
  // And the engine is as good as new for the run after it.
  expect(
    await runInSandbox("[1, 2, 3].map((x) => x * 2)", {
      timeoutMs: 1_000,
      memoryBytes: 32 * 1024 * 1024,
    }),
  ).toEqual({ ok: true, value: [2, 4, 6] });
});

// ---------------------------------------------------------------------------------------------
// In the Judge's own worker, where the scorers run.

const testsTask = { criteria: criteria([], 100), heldout: { tests: heldout(PLUS_ONE) } };
/**
 * Time for a worker to load and compile, and for an entry that is not about its time limit to be
 * scored whole (the engine's own limits, a second a case, are the ones that end its cases): the
 * test is of what a worker scores, not of how long a busy machine takes to start one.
 */
const UNHURRIED = {
  startTimeoutMs: 120_000,
  compileBudgetMs: 120_000,
  entryTimeoutMs: 120_000,
} as const;

test("tests_entries_are_scored_in_a_worker_as_they_are_on_this_thread", {
  timeout: 120_000,
}, async () => {
  const scorer = openTaskScorer(testsTask, UNHURRIED);
  const here = (content: Uint8Array) =>
    scoreEntry({ criteria: testsTask.criteria, heldout: testsTask.heldout, content });
  try {
    // Entries whose cases end the same way on any machine: the very same score, reasons and all.
    for (const source of [
      RIGHT,
      "function f(x) { return x <= 2 ? x + 1 : 0; }",
      "function f(",
      hostile("deep_recursion"),
      hostile("infinite_loop"),
      // An allocation past the limit fails at once, where a loop that fills the engine would end
      // as `timed out` on a machine too busy to fill it in the second a case has.
      hostile("memory_bomb_one_allocation"),
      hostile("constructor_chain_to_process"),
      RIGHT,
    ]) {
      const content = bytes(source);
      expect(await scorer.score(content), source).toEqual({
        kind: "scored",
        score: await here(content),
      });
    }

    // One that fills the engine ends in a case's second or in the engine's memory, whichever the
    // machine reaches first, and the worker and this thread need not reach the same one. Both
    // score it 0, and say only that a case ran out of memory or of time.
    const content = bytes(hostile("memory_bomb_arrays"));
    const scorings: Scoring[] = [
      await scorer.score(content),
      { kind: "scored", score: await here(content) },
    ];
    for (const scoring of scorings) {
      expect(scoring).toMatchObject({ kind: "scored", score: { score: 0, passed: false } });
      const reasons = scoring.kind === "scored" ? scoring.score.reasons : [];
      expect(reasons.length).toBeGreaterThan(0);
      for (const reason of reasons) {
        expect(reason).toMatch(/: (ran out of memory|timed out)$|^\d+ more cases? not run$/);
      }
    }
  } finally {
    await scorer.close();
  }
  expect(existsSync(CANARY)).toBe(false);
});

test("a_loop_the_engine_cannot_interrupt_is_ended_by_the_worker_and_the_next_entry_is_scored", {
  timeout: 120_000,
}, async () => {
  // Natives that loop over a huge sparse array never come back to the engine's interrupt check,
  // so a case's second does not end them. The worker's stop does, at the entry's own limit.
  const scorer = openTaskScorer(testsTask, { ...UNHURRIED, entryTimeoutMs: 2_500 });
  try {
    expect(await scorer.score(bytes(RIGHT))).toMatchObject({
      kind: "scored",
      score: { score: 100 },
    });
    for (const loop of [
      "new Array(2 ** 32 - 1).indexOf(1)",
      "new Array(2 ** 32 - 1).join('a').length",
    ]) {
      const started = performance.now();
      const scoring = await scorer.score(bytes(`function f(x) { return ${loop}; }`));
      const took = performance.now() - started;
      expect(scoring, loop).toEqual({ kind: "scored", score: zero("scoring timed out") });
      // Not before the limit, which load only makes later. The loop itself would run for minutes,
      // so an answer in a fraction of that is the stop's; how soon the stop comes after its limit
      // is as much the machine's as the Judge's, and the bound on it is loose.
      expect(took, loop).toBeGreaterThan(2_000);
      expect(took, loop).toBeLessThan(2_500 + 15_000);
      expect(await scorer.score(bytes(RIGHT))).toMatchObject({
        kind: "scored",
        score: { score: 100 },
      });
    }
  } finally {
    await scorer.close();
  }
});

// ---------------------------------------------------------------------------------------------
// An entry's score does not depend on the entries scored before it.

/** Honest, and needs 20 MB for a moment: under the case's 32 MiB, over what 64 MiB can give. */
const NEEDS_20_MB = "function f(x) { return new Array(2_500_000).fill(1).length + x; }";
const needs20MbCases: Case[] = [1, 2, 3, 4].map((n) => ({ input: n, output: 2_500_000 + n }));

test("the_same_honest_entry_scores_the_same_first_after_a_bomb_and_after_a_worker_kill", {
  timeout: 180_000,
}, async () => {
  const task = { criteria: criteria([], 100), heldout: { tests: heldout(needs20MbCases) } };
  // The native loop is ended by the worker's stop, at this limit, and the next entry runs in a
  // new worker. The limit is also the whole of an honest entry's time (four cases that take 20 MB
  // each) and of a bomb's, so it is far over what they cost: a busy machine that took longer would
  // stop the worker of the entry that this test is about, and show a score that is not the entry's.
  const scorer = openTaskScorer(task, { ...UNHURRIED, entryTimeoutMs: 10_000 });
  const honest = { kind: "scored", score: { score: 100, passed: true, reasons: [] } };
  const scoreHonest = async () => scorer.score(bytes(NEEDS_20_MB));
  try {
    // First in a new worker.
    expect(await scoreHonest(), "first").toEqual(honest);
    // After a small honest entry.
    expect(await scorer.score(bytes("function f(x) { return 2_500_000 + x; }"))).toEqual(honest);
    expect(await scoreHonest(), "after a small entry").toEqual(honest);
    // After memory bombs, which grow an engine that was shared.
    for (const bomb of [HOSTILE.memory_bomb_arrays, HOSTILE.memory_bomb_objects]) {
      expect((await scorer.score(bytes(String(bomb)))).kind).toBe("scored");
      expect(await scoreHonest(), "after a bomb").toEqual(honest);
    }
    // After a native loop, whose worker is stopped: the next entry has an engine of its own.
    const looped = await scorer.score(
      bytes("function f(x) { return new Array(2 ** 32 - 1).indexOf(1); }"),
    );
    expect(looped).toEqual({ kind: "scored", score: zero("scoring timed out") });
    expect(await scoreHonest(), "after a worker kill").toEqual(honest);
  } finally {
    await scorer.close();
  }
});

test("every_entry_gets_an_engine_of_its_own", { timeout: 120_000 }, async () => {
  // In one thread, scored one after another, as the Judge's workers do. Nothing here is about the
  // second a case has: with time to spare, it is the engine's memory that ends the bomb on any
  // machine, and the honest entries are not cut short on a busy one.
  const c = criteria([], 100);
  const h = heldout(needs20MbCases);
  const bomb = bytes(String(HOSTILE.memory_bomb_arrays));
  await withTimeBudget(120_000, async () => {
    expect(await scoreTests(c, h, bytes(NEEDS_20_MB)), "first").toMatchObject({ score: 100 });
    expect((await scoreTests(c, h, bomb)).score).toBe(0);
    expect(await scoreTests(c, h, bytes(NEEDS_20_MB)), "after a bomb").toMatchObject({
      score: 100,
    });
  });
});

test("a_sandbox_has_an_engine_of_its_own_and_renew_replaces_it", { timeout: 120_000 }, async () => {
  // Nothing here is about time. The bomb has the time to fill the engine, so that it is the
  // engine's memory that ends it (`memory`) on any machine, and not a second spent on a busy one
  // (`timeout`); its limit on one block is the case's, 32 MiB.
  const limits = { timeoutMs: 60_000, memoryBytes: 32 * 1024 * 1024 };
  const a = new Sandbox();
  const b = new Sandbox();
  expect(await a.run("var seen = 1; seen", limits)).toEqual({ ok: true, value: 1 });
  // Each run has a runtime of its own, whatever the engine.
  expect(await a.run("typeof seen", limits)).toEqual({ ok: true, value: "undefined" });
  expect(
    await a.run("const a = []; while (true) a.push(new Array(1000).fill(0));", limits),
  ).toMatchObject({ ok: false, error: "memory" });
  // `b` never saw the bomb, and `a` is as good as new once it has a new engine.
  const big = "new Array(2_500_000).fill(1).length";
  expect(await b.run(big, limits)).toEqual({ ok: true, value: 2_500_000 });
  a.renew();
  expect(await a.run(big, limits)).toEqual({ ok: true, value: 2_500_000 });
  // The default sandbox is `runInSandbox`'s, and is another one.
  expect(await runInSandbox("1 + 1", limits)).toEqual({ ok: true, value: 2 });
});
