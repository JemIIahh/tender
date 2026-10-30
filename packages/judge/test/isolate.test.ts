import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Heldout } from "@tender/shared";
import { expect, test, vi } from "vitest";
import type { P0Criteria } from "../src/intake";
import {
  checkJsonSchemaIsolated,
  openTaskScorer,
  type Scoring,
  type WorkerOptions,
} from "../src/isolate";
import { ScorerUnavailableError, scoreEntry } from "../src/score";
import type { EntryScore } from "../src/types";
import { MALFORMED } from "./fixtures/malformed";

// Scoring in a worker (P05-R1). Most tests start the rogue worker, which scores like the Judge's
// own worker except on cue (see fixtures/rogue-worker.ts). Timing bounds are generous: they must
// hold on a busy machine.

const ROGUE = new URL("./fixtures/rogue-worker.ts", import.meta.url);
const run = promisify(execFile);

const EXACT: P0Criteria = {
  version: 1,
  kind: "exact",
  min_score: 100,
  split: "winner_take_all",
  has_heldout: true,
  normalize: ["trim"],
};
const EXACT_HELDOUT: Heldout = { exact: { expected: ["42"] } };
const EXACT_TASK = { criteria: EXACT, heldout: EXACT_HELDOUT };

/** json_schema criteria over `schema`, with a pass mark of 100. */
const jsonSchema = (schema: Record<string, unknown>): P0Criteria => ({
  version: 1,
  kind: "json_schema",
  min_score: 100,
  split: "winner_take_all",
  has_heldout: true,
  schema,
});
const X_IS_1: Heldout = { json_schema: { assertions: [{ path: "$.x", equals: 1 }] } };
/** A tree: an array of arrays of arrays, as deep as the document goes. */
const TREE_SCHEMA = {
  $defs: { node: { type: "array", items: { $ref: "#/$defs/node" } } },
  $ref: "#/$defs/node",
};
const ROOT_IS_EMPTY: Heldout = { json_schema: { assertions: [{ path: "$", equals: [] }] } };

const REGEX: P0Criteria = {
  version: 1,
  kind: "regex_cases",
  min_score: 100,
  split: "winner_take_all",
  has_heldout: false,
  examples: { match: ["a", "aa"], no_match: ["b", ""] },
};

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const zero = (reason: string): EntryScore => ({ score: 0, passed: false, reasons: [reason] });
/** What a task's scorer answers for an entry it scored `score`. */
const scored = (score: EntryScore): Scoring => ({ kind: "scored", score });
/** What it answers for an entry it scored 0, for `reason`. */
const failed = (reason: string): Scoring => scored(zero(reason));
const RIGHT = scored({ score: 100, passed: true, reasons: [] });
const TOO_SLOW = "criteria schema is not supported: it takes too long to compile";
const WRONG = failed("expected one of 1 accepted answers");

/**
 * How many workers are running: each shows as a `MessagePort`, which vitest's own workings do not
 * use. (Its timers come and go during a test, so timers are counted in a process of their own.)
 */
const workers = (): number =>
  process.getActiveResourcesInfo().filter((type) => type === "MessagePort").length;

test("a_worker_scores_as_the_scorers_do_on_this_thread", { timeout: 30_000 }, async () => {
  const deep = bytes("[".repeat(100_000) + "]".repeat(100_000));
  const tasks: [P0Criteria, Heldout | null, Uint8Array[]][] = [
    [EXACT, EXACT_HELDOUT, [bytes("42"), bytes(" 42\n"), bytes("41"), Uint8Array.of(0xff)]],
    // One worker scores them all, with the schema compiled once: on this thread each is compiled
    // for itself. Overflowing the stack in the validator leaves it as good as new.
    [
      jsonSchema({ type: "object", required: ["x"], properties: { x: { type: "integer" } } }),
      X_IS_1,
      [bytes('{"x":1}'), bytes('{"x":2}'), bytes('{"x":"1"}'), bytes("{"), bytes('{"x":1}')],
    ],
    [jsonSchema(TREE_SCHEMA), ROOT_IS_EMPTY, [bytes("[[]]"), deep, bytes("[]"), deep, bytes("{}")]],
    [
      REGEX,
      null,
      [bytes('{"pattern":"^a+$"}'), bytes('{"pattern":"a"}'), bytes('{"pattern":"("}'), bytes("")],
    ],
  ];
  for (const [criteria, heldout, contents] of tasks) {
    const scorer = openTaskScorer({ criteria, heldout });
    for (const content of contents) {
      expect(await scorer.score(content)).toEqual(
        scored(await scoreEntry({ criteria, heldout, content })),
      );
    }
    await scorer.close();
  }
});

test("a_scorer_that_loops_forever_times_out_and_the_next_entry_is_scored", {
  timeout: 60_000,
}, async () => {
  const onCrash = vi.fn();
  const scorer = openTaskScorer(EXACT_TASK, { workerUrl: ROGUE, entryTimeoutMs: 500, onCrash });
  // The worker is loaded, so that what is timed is the entry alone.
  expect(await scorer.score(bytes("42"))).toEqual(RIGHT);

  const started = performance.now();
  expect(await scorer.score(bytes("rogue:loop"))).toEqual(failed("scoring timed out"));
  const took = performance.now() - started;
  expect(took).toBeGreaterThan(250);
  expect(took).toBeLessThan(500 + 4_000);

  // A new worker scores the entries after it.
  expect(await scorer.score(bytes("41"))).toEqual(WRONG);
  expect(await scorer.score(bytes("42"))).toEqual(RIGHT);
  expect(onCrash).not.toHaveBeenCalled();
  await scorer.close();
});

test("a_scorer_that_allocates_without_bound_runs_out_of_memory", { timeout: 90_000 }, async () => {
  // Time enough for the heap to fill, so that the memory limit is what ends it.
  const onCrash = vi.fn();
  const scorer = openTaskScorer(EXACT_TASK, {
    workerUrl: ROGUE,
    entryTimeoutMs: 60_000,
    onCrash,
  });
  expect(await scorer.score(bytes("rogue:alloc"))).toEqual(failed("scoring ran out of memory"));
  expect(await scorer.score(bytes("42"))).toEqual(RIGHT);
  expect(onCrash).not.toHaveBeenCalled();
  await scorer.close();
});

test("deep_recursion_is_contained", { timeout: 30_000 }, async () => {
  const onCrash = vi.fn();
  const scorer = openTaskScorer(EXACT_TASK, { workerUrl: ROGUE, onCrash });
  // Recursion that nothing catches ends its worker, and this thread goes on.
  expect(await scorer.score(bytes("rogue:recurse"))).toEqual(failed("scoring failed"));
  expect(onCrash.mock.calls).toEqual([[expect.objectContaining({ name: "RangeError" })]]);
  // With the worker's 4 MiB of stack, the sandbox engine's own check stops a recursion, not V8's
  // stack running out ("RangeError: Maximum call stack size exceeded" on a default thread).
  expect(await scorer.score(bytes("rogue:sandbox-recursion"))).toEqual(
    failed("InternalError: stack overflow"),
  );
  expect(await scorer.score(bytes("42"))).toEqual(RIGHT);
  await scorer.close();

  // A real scorer meets a document nested far deeper than the stack with a check of its own.
  const tree = openTaskScorer({ criteria: jsonSchema(TREE_SCHEMA), heldout: ROOT_IS_EMPTY });
  const deep = bytes("[".repeat(100_000) + "]".repeat(100_000));
  expect(await tree.score(deep)).toEqual(failed("too deeply nested to validate"));
  await tree.close();
});

test("a_worker_that_answers_with_anything_but_a_score_fails_the_entry", {
  timeout: 60_000,
}, async () => {
  const onCrash = vi.fn();
  const scorer = openTaskScorer(EXACT_TASK, { workerUrl: ROGUE, onCrash });
  for (const [i, answer] of MALFORMED.entries()) {
    expect(await scorer.score(bytes(`rogue:malformed:${i}`)), JSON.stringify(answer)).toEqual(
      failed("scoring failed"),
    );
  }
  // A worker that ends itself, and a scorer that throws, are crashes too.
  expect(await scorer.score(bytes("rogue:exit"))).toEqual(failed("scoring failed"));
  expect(await scorer.score(bytes("rogue:throw"))).toEqual(failed("scoring failed"));
  // Each crash is told once, with the error when there is one, and never its message.
  expect(onCrash.mock.calls.map(([error]) => error.name)).toEqual([
    ...MALFORMED.map(() => "ScoreWorkerError"),
    "ScoreWorkerError",
    "TypeError",
  ]);
  expect(await scorer.score(bytes("42"))).toEqual(RIGHT);
  await scorer.close();
});

test("a_scorer_that_cannot_run_rejects", { timeout: 60_000 }, async () => {
  // The worker says so: a held-out part that is missing is a slip of the Judge's own.
  const slip = openTaskScorer({ criteria: EXACT, heldout: null });
  await expect(slip.score(bytes("42"))).rejects.toBeInstanceOf(ScorerUnavailableError);
  await slip.close();

  // The worker cannot be loaded, or not in time.
  for (const options of [
    { workerUrl: new URL("./fixtures/no-such-worker.ts", import.meta.url) },
    { startTimeoutMs: 1 },
  ]) {
    const scorer = openTaskScorer(EXACT_TASK, options);
    await expect(scorer.score(bytes("42"))).rejects.toBeInstanceOf(ScorerUnavailableError);
    await scorer.close();
  }

  // The worker is replaced: the entry after it is scored.
  const rogue = openTaskScorer(EXACT_TASK, { workerUrl: ROGUE });
  await expect(rogue.score(bytes("rogue:unavailable"))).rejects.toBeInstanceOf(
    ScorerUnavailableError,
  );
  expect(await rogue.score(bytes("42"))).toEqual(RIGHT);
  await rogue.close();
});

test("the_time_left_bounds_each_part_of_the_work", { timeout: 30_000 }, async () => {
  // P05-R15: the time left before the stop line bounds a worker's start, its compile and each
  // score, as each one's own limit does. A score that the line cuts short is no failure of the
  // entry's: `cut`. A start or a compile that it cuts short is the Judge's own lateness: `late`.
  const onCrash = vi.fn();
  const scorer = openTaskScorer(EXACT_TASK, { workerUrl: ROGUE, entryTimeoutMs: 20_000, onCrash });
  expect(await scorer.score(bytes("42"), 60_000)).toEqual(RIGHT);
  const started = performance.now();
  expect(await scorer.score(bytes("rogue:loop"), 300)).toEqual({ kind: "cut" });
  expect(performance.now() - started).toBeLessThan(300 + 4_000);
  // No time left starts nothing, not even a worker in place of the one that was stopped; and a
  // worker cannot load in a millisecond.
  expect(await scorer.score(bytes("42"), 0)).toEqual({ kind: "late" });
  expect(await scorer.score(bytes("42"), 1)).toEqual({ kind: "late" });
  expect(onCrash).not.toHaveBeenCalled();
  await scorer.close();

  // A compile of 2 s, with 600 ms left and 8 s of budget.
  const slow = openTaskScorer(
    { criteria: jsonSchema({ title: "rogue:slow:2000", type: "object" }), heldout: X_IS_1 },
    { workerUrl: ROGUE, compileBudgetMs: 8_000 },
  );
  expect(await slow.score(bytes('{"x":1}'), 600)).toEqual({ kind: "late" });
  await slow.close();
});

test("the_criteria_compile_before_any_entry", { timeout: 60_000 }, async () => {
  // P05-R17: a worker compiles the criteria before it takes an entry, within its compile budget,
  // so a compile of 2 s costs the first entry nothing of its 1 s. A worker that replaces one an
  // entry crashed compiles them again, under the same budget.
  const slow = {
    criteria: jsonSchema({ title: "rogue:slow:2000", type: "object" }),
    heldout: X_IS_1,
  };
  const scorer = openTaskScorer(slow, {
    workerUrl: ROGUE,
    entryTimeoutMs: 1_000,
    compileBudgetMs: 4_000,
    onCrash: () => undefined,
  });
  expect(await scorer.score(bytes('{"x":1}'))).toEqual(RIGHT);
  expect(await scorer.score(bytes("rogue:throw"))).toEqual(failed("scoring failed"));
  expect(await scorer.score(bytes('{"x":2}'))).toEqual(failed("$.x expected 1"));
  await scorer.close();

  // Criteria that cannot be compiled are refused, and no entry is scored with them: past the
  // budget, a schema that does not compile, a compile that crashes the worker.
  const refused: [P0Criteria, WorkerOptions & { compileBudgetMs?: number }, unknown][] = [
    [slow.criteria, { workerUrl: ROGUE, compileBudgetMs: 100 }, TOO_SLOW],
    [jsonSchema({ type: 12 }), {}, expect.stringMatching(/^criteria schema cannot be compiled: /)],
    [
      jsonSchema({ title: "rogue:compile-throws" }),
      { workerUrl: ROGUE },
      "criteria could not be checked",
    ],
  ];
  for (const [criteria, options, reason] of refused) {
    const refusing = openTaskScorer({ criteria, heldout: X_IS_1 }, options);
    expect(await refusing.score(bytes('{"x":1}'))).toEqual({ kind: "rejected", reason });
    await refusing.close();
  }
});

test("no_worker_is_left_after_a_task", { timeout: 60_000 }, async () => {
  const before = workers();
  const scorer = openTaskScorer(EXACT_TASK, {
    workerUrl: ROGUE,
    entryTimeoutMs: 1_000,
    onCrash: () => undefined,
  });
  expect(await scorer.score(bytes("42"))).toEqual(RIGHT);
  // The count sees the worker while it runs.
  expect(workers()).toBe(before + 1);
  for (const cue of ["rogue:loop", "rogue:recurse", "rogue:malformed:0", "rogue:exit", "42"]) {
    await scorer.score(bytes(cue));
  }
  await expect(scorer.score(bytes("rogue:unavailable"))).rejects.toThrow();
  await scorer.close();
  expect(workers()).toBe(before);

  // The check stops its worker, whatever came of it.
  expect(await checkJsonSchemaIsolated({ type: "object" })).toEqual({ ok: true });
  const crashing = checkJsonSchemaIsolated({ title: "rogue:throw" }, { workerUrl: ROGUE });
  await expect(crashing).rejects.toThrow();
  expect(
    await checkJsonSchemaIsolated({ title: "rogue:loop" }, { workerUrl: ROGUE, budgetMs: 200 }),
  ).toMatchObject({ ok: false });
  expect(workers()).toBe(before);
});

test("under_tsx_the_workers_load_and_nothing_is_left_running", { timeout: 90_000 }, async () => {
  // The tsx CLI, as `pnpm serve` runs the Judge: the workers inherit its loader. The script
  // prints the workers and timers still running once its scorers are closed, and must then exit
  // by itself, which it cannot while a worker or a timer is left.
  const cli = createRequire(import.meta.url).resolve("tsx/cli");
  const script = fileURLToPath(new URL("./fixtures/score-under-tsx.ts", import.meta.url));
  const { stdout } = await run(process.execPath, [cli, script], { timeout: 60_000 });
  expect(JSON.parse(stdout)).toEqual({
    scores: [RIGHT, WRONG, failed("scoring timed out"), failed("scoring failed"), RIGHT],
    check: { ok: true },
    left: [],
  });
});

test("a_heavy_json_schema_entry_times_out_within_the_limit", { timeout: 60_000 }, async () => {
  // `uniqueItems` over items with no type compares every pair of them: an honest schema, and a
  // document of 256 KiB of small arrays that takes about 9 s to check here (224 KiB of them took
  // about 5.7 s). The entry has the default 5 s.
  const items: number[][][] = [];
  for (let size = 2; size + `[[${items.length}]],`.length <= 262_144; ) {
    size += `[[${items.length}]],`.length;
    items.push([[items.length]]);
  }
  const heavy = bytes(JSON.stringify(items));
  expect(heavy.byteLength).toBeLessThanOrEqual(262_144);
  const scorer = openTaskScorer({
    criteria: jsonSchema({ type: "array", uniqueItems: true }),
    heldout: { json_schema: { assertions: [{ path: "$[0][0][0]", equals: 0 }] } },
  });
  expect(await scorer.score(bytes("[[[0]],[[1]]]"))).toEqual(RIGHT);

  const started = performance.now();
  expect(await scorer.score(heavy)).toEqual(failed("scoring timed out"));
  expect(performance.now() - started).toBeLessThan(5_000 + 2_500);
  await scorer.close();
});

test("the_compile_check_has_a_budget", { timeout: 30_000 }, async () => {
  // A schema near the size cap takes a few hundred milliseconds to compile.
  const properties: Record<string, unknown> = {};
  for (let i = 0; i < 3_000; i++) {
    properties[`p${i}`] = { type: "string", pattern: "^[a-z]{1,8}$", maxLength: 8 };
  }
  expect(await checkJsonSchemaIsolated({ type: "object", properties }, { budgetMs: 50 })).toEqual({
    ok: false,
    reason: TOO_SLOW,
  });
  // A compile that never ends.
  const looping = { title: "rogue:loop" };
  expect(await checkJsonSchemaIsolated(looping, { workerUrl: ROGUE, budgetMs: 300 })).toEqual({
    ok: false,
    reason: TOO_SLOW,
  });

  // Within the budget, the result is the check's own.
  expect(await checkJsonSchemaIsolated({ type: "object" })).toEqual({ ok: true });
  expect(await checkJsonSchemaIsolated({ type: 12 })).toEqual({
    ok: false,
    reason: expect.stringMatching(/^criteria schema cannot be compiled: /),
  });

  // A check that crashes its worker, or answers with something else, has no result: the schema
  // did that, and it is no `ScorerUnavailableError`.
  for (const title of ["rogue:throw", "rogue:malformed"]) {
    const failed = checkJsonSchemaIsolated({ title }, { workerUrl: ROGUE });
    await expect(failed).rejects.toThrow();
    await expect(failed).rejects.not.toBeInstanceOf(ScorerUnavailableError);
  }
  await expect(checkJsonSchemaIsolated({}, { startTimeoutMs: 1 })).rejects.toBeInstanceOf(
    ScorerUnavailableError,
  );
});
