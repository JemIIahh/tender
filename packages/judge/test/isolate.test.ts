import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Heldout } from "@tender/shared";
import { expect, onTestFinished, test, vi } from "vitest";
import type { P0Criteria } from "../src/intake";
import {
  checkJsonSchemaIsolated,
  openTaskScorer,
  type Scoring,
  WarmWorker,
  type WorkerOptions,
} from "../src/isolate";
import { ScorerUnavailableError, scoreEntry } from "../src/score";
import type { EntryScore } from "../src/types";
import { MALFORMED } from "./fixtures/malformed";

// Scoring in a worker (P05-R1). Most tests start the rogue worker, which scores like the Judge's
// own worker except on cue (see fixtures/rogue-worker.ts). Timing bounds are generous: they must
// hold on a busy machine.
//
// A worker loads TypeScript and the scorers when it starts, and compiles the criteria before its
// first entry. On a machine that runs a hundred other jobs that takes tens of seconds, where the
// Judge's limits (10 s to start, 2 s to compile) are for one that does not. A test that is not
// about how long a start or a compile may take gives them time enough (`UNHURRIED`), so that what
// it shows does not depend on the machine's load. The tests of a limit keep the limit, and show
// it by what the scorer reports (`scoring timed out`, `cut`, `late`), which only the limit says,
// and not by how long the wall clock took: a bound from above on the wall clock can only say how
// busy the machine was, so those are set far above the limit, to catch a stop that never comes
// (the limit of a loop that does not end is still a bound from below, which load cannot break).

const ROGUE = new URL("./fixtures/rogue-worker.ts", import.meta.url);
/** The Judge's own worker, 3 s slower to load. */
const SLOW_START = new URL("./fixtures/slow-start-worker.ts", import.meta.url);
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
/** Time for a worker to load and to compile, for the tests that are not about how long they take. */
const UNHURRIED = { startTimeoutMs: 120_000, compileBudgetMs: 120_000 } as const;
/** The same for `checkJsonSchemaIsolated`, whose compile budget is `budgetMs`. */
const UNHURRIED_CHECK = { startTimeoutMs: 120_000, budgetMs: 120_000 } as const;
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

test("a_worker_scores_as_the_scorers_do_on_this_thread", { timeout: 120_000 }, async () => {
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
    const scorer = openTaskScorer({ criteria, heldout }, { ...UNHURRIED, entryTimeoutMs: 60_000 });
    for (const content of contents) {
      expect(await scorer.score(content)).toEqual(
        scored(await scoreEntry({ criteria, heldout, content })),
      );
    }
    await scorer.close();
  }
});

test("a_scorer_that_loops_forever_times_out_and_the_next_entry_is_scored", {
  timeout: 120_000,
}, async () => {
  const onCrash = vi.fn();
  const scorer = openTaskScorer(EXACT_TASK, {
    ...UNHURRIED,
    workerUrl: ROGUE,
    entryTimeoutMs: 1_500,
    onCrash,
  });
  // The worker is loaded, so that what is timed is the entry alone.
  expect(await scorer.score(bytes("42"))).toEqual(RIGHT);

  const started = performance.now();
  expect(await scorer.score(bytes("rogue:loop"))).toEqual(failed("scoring timed out"));
  const took = performance.now() - started;
  // Not before its limit (a busy machine only makes it later), and it is ended: a loop that
  // nothing stops never answers. What load can stretch is how long the stop takes to come, and
  // only a stop that never does is a failure of the scorer's.
  expect(took).toBeGreaterThan(750);
  expect(took).toBeLessThan(1_500 + 20_000);

  // A new worker scores the entries after it.
  expect(await scorer.score(bytes("41"))).toEqual(WRONG);
  expect(await scorer.score(bytes("42"))).toEqual(RIGHT);
  expect(onCrash).not.toHaveBeenCalled();
  await scorer.close();
});

test("a_scorer_that_allocates_without_bound_runs_out_of_memory", { timeout: 180_000 }, async () => {
  // Time enough for the heap to fill, so that the memory limit is what ends it.
  const onCrash = vi.fn();
  const scorer = openTaskScorer(EXACT_TASK, {
    ...UNHURRIED,
    workerUrl: ROGUE,
    entryTimeoutMs: 60_000,
    onCrash,
  });
  expect(await scorer.score(bytes("rogue:alloc"))).toEqual(failed("scoring ran out of memory"));
  expect(await scorer.score(bytes("42"))).toEqual(RIGHT);
  expect(onCrash).not.toHaveBeenCalled();
  await scorer.close();
});

test("deep_recursion_is_contained", { timeout: 120_000 }, async () => {
  const onCrash = vi.fn();
  const scorer = openTaskScorer(EXACT_TASK, { ...UNHURRIED, workerUrl: ROGUE, onCrash });
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
  const tree = openTaskScorer(
    { criteria: jsonSchema(TREE_SCHEMA), heldout: ROOT_IS_EMPTY },
    UNHURRIED,
  );
  const deep = bytes("[".repeat(100_000) + "]".repeat(100_000));
  expect(await tree.score(deep)).toEqual(failed("too deeply nested to validate"));
  await tree.close();
});

test("a_worker_that_answers_with_anything_but_a_score_fails_the_entry", {
  timeout: 120_000,
}, async () => {
  const onCrash = vi.fn();
  const scorer = openTaskScorer(EXACT_TASK, { ...UNHURRIED, workerUrl: ROGUE, onCrash });
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

test("a_scorer_that_cannot_run_rejects", { timeout: 120_000 }, async () => {
  // The worker says so: a held-out part that is missing is a slip of the Judge's own.
  const slip = openTaskScorer({ criteria: EXACT, heldout: null }, UNHURRIED);
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
  const rogue = openTaskScorer(EXACT_TASK, { ...UNHURRIED, workerUrl: ROGUE });
  await expect(rogue.score(bytes("rogue:unavailable"))).rejects.toBeInstanceOf(
    ScorerUnavailableError,
  );
  expect(await rogue.score(bytes("42"))).toEqual(RIGHT);
  await rogue.close();
});

test("the_time_left_bounds_each_part_of_the_work", { timeout: 120_000 }, async () => {
  // P05-R15: the time left before the stop line bounds a worker's start, its compile and each
  // score, as each one's own limit does. A score that the line cuts short is no failure of the
  // entry's: `cut`. A start or a compile that it cuts short is the Judge's own lateness: `late`.
  const onCrash = vi.fn();
  const scorer = openTaskScorer(EXACT_TASK, {
    ...UNHURRIED,
    workerUrl: ROGUE,
    entryTimeoutMs: 20_000,
    onCrash,
  });
  expect(await scorer.score(bytes("42"), 60_000)).toEqual(RIGHT);
  const started = performance.now();
  expect(await scorer.score(bytes("rogue:loop"), 300)).toEqual({ kind: "cut" });
  // `cut` is the stop line's own word: the entry's limit is 20 s, and the loop would have run on.
  // The time it took to come is the machine's as much as the line's, so it is only held under the
  // entry's limit.
  expect(performance.now() - started).toBeLessThan(15_000);
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

test("a_compile_longer_than_an_entrys_limit_is_not_charged_to_any_entry", {
  timeout: 180_000,
}, async () => {
  // The review's shape: a leaf of 100 properties that the schema refers to 100 times, which Ajv
  // writes out at each reference. It takes over a second to compile: an entry that paid for that
  // would time out at the 500 ms each one has here. The worker does it all before it takes an
  // entry. V8's own compile of what Ajv wrote, on its first run, costs about 230 ms more, which is
  // under that limit on an idle machine, so this does not pin the warm-up that pays for it before
  // any entry: json_schema.test.ts does. Mallory's string makes the poster's pattern backtrack
  // without end, and times out; the entry after it gets a new worker, which compiles again first,
  // and is scored.
  const leaf: Record<string, unknown> = {};
  for (let i = 0; i < 100; i++) leaf[`q${i}`] = { type: "integer", minimum: i, maximum: i + 9 };
  const properties: Record<string, unknown> = {
    s: { type: "string", pattern: "^(a+)+$" },
  };
  for (let i = 0; i < 100; i++) properties[`p${i}`] = { $ref: "#/$defs/leaf" };
  const schema = {
    type: "object",
    $defs: { leaf: { type: "object", properties: leaf } },
    properties,
  };
  const scorer = openTaskScorer(
    { criteria: jsonSchema(schema), heldout: X_IS_1 },
    // The compile's budget is not what this is about: room enough for a machine that is very busy.
    { ...UNHURRIED, entryTimeoutMs: 500 },
  );
  const backtracking = `{"x":1,"s":"${"a".repeat(40)}!"}`;
  for (const [content, scoring] of [
    ['{"x":1}', RIGHT],
    [backtracking, failed("scoring timed out")],
    ['{"x":1}', RIGHT],
    ['{"x":2}', failed("$.x expected 1")],
  ] as const) {
    expect(await scorer.score(bytes(content)), content.slice(0, 20)).toEqual(scoring);
  }
  await scorer.close();
});

test("a_warm_worker_is_ready_when_a_scorer_needs_one", { timeout: 120_000 }, async () => {
  // Workers that take 3 s more to load, and scorers that wait 1 s for one. A scorer that starts
  // its own cannot score. One that takes the warm worker, loaded ahead, can, and taking it starts
  // the next one loading, for the scorer after it. Closing it leaves no worker.
  const before = workers();
  const own = openTaskScorer(EXACT_TASK, {
    ...UNHURRIED,
    workerUrl: SLOW_START,
    startTimeoutMs: 1_000,
  });
  await expect(own.score(bytes("42"))).rejects.toThrow(ScorerUnavailableError);
  await own.close();

  const warm = new WarmWorker({ workerUrl: SLOW_START });
  try {
    for (const answer of ["42", "41"]) {
      expect(await warm.ready()).toBe(true);
      const scorer = openTaskScorer(EXACT_TASK, {
        ...UNHURRIED,
        workers: warm,
        startTimeoutMs: 1_000,
      });
      expect(await scorer.score(bytes(answer))).toEqual(answer === "42" ? RIGHT : WRONG);
      await scorer.close();
    }
  } finally {
    await warm.close();
  }
  expect(workers()).toBe(before);
});

test("only_a_tasks_first_compile_can_reject_its_criteria", { timeout: 120_000 }, async () => {
  // The second compile of these criteria, and every one after it, takes 8 s in any worker, and the
  // budget is 4 s. The first compile fits. When an entry's loop gets its worker stopped, the next
  // worker cannot compile them in time: that is load, not the criteria (`unavailable`). So it is
  // for a scorer opened for a task whose criteria compiled on an earlier tick. Only a task's first
  // compile refuses them. (The budget is far over what a compile that does nothing takes, so that
  // the first one fits on a busy machine, and the second is a busy loop of a wall clock's length.)
  const mark = join(mkdtempSync(join(tmpdir(), "tender-judge-")), "compiled");
  onTestFinished(() => rmSync(dirname(mark), { recursive: true, force: true }));
  const task = {
    criteria: jsonSchema({ title: `rogue:slow-again:8000:${mark}`, type: "object" }),
    heldout: X_IS_1,
  };
  const options = {
    startTimeoutMs: UNHURRIED.startTimeoutMs,
    workerUrl: ROGUE,
    compileBudgetMs: 4_000,
    onCrash: () => undefined,
  };
  const scorer = openTaskScorer(task, { ...options, entryTimeoutMs: 3_000 });
  expect(scorer.compiled).toBe(false);
  expect(await scorer.score(bytes('{"x":1}'))).toEqual(RIGHT);
  expect(scorer.compiled).toBe(true);
  expect(await scorer.score(bytes("rogue:loop"))).toEqual(failed("scoring timed out"));
  expect(await scorer.score(bytes('{"x":1}'))).toEqual({ kind: "unavailable" });
  await scorer.close();

  const later = openTaskScorer(task, { ...options, compiled: true });
  expect(await later.score(bytes('{"x":1}'))).toEqual({ kind: "unavailable" });
  await later.close();
  const first = openTaskScorer(task, options);
  expect(await first.score(bytes('{"x":1}'))).toEqual({ kind: "rejected", reason: TOO_SLOW });
  expect(first.compiled).toBe(false);
  await first.close();
});

test("the_criteria_compile_before_any_entry", { timeout: 180_000 }, async () => {
  // P05-R17: a worker compiles the criteria before it takes an entry, within its compile budget,
  // so a compile of 4 s costs the first entry nothing of its 2 s. A worker that replaces one an
  // entry crashed compiles them again, under the same budget. (The compile is a busy loop of a wall
  // clock's length, so it is longer than the entry's limit on any machine; the budget is far over
  // it, and the entry's limit far over what scoring one entry costs, so that neither is reached
  // by a machine that is busy. A compile that was charged to the entry would time it out.)
  const slow = {
    criteria: jsonSchema({ title: "rogue:slow:4000", type: "object" }),
    heldout: X_IS_1,
  };
  const scorer = openTaskScorer(slow, {
    ...UNHURRIED,
    workerUrl: ROGUE,
    entryTimeoutMs: 2_000,
    compileBudgetMs: 60_000,
    onCrash: () => undefined,
  });
  expect(await scorer.score(bytes('{"x":1}'))).toEqual(RIGHT);
  expect(await scorer.score(bytes("rogue:throw"))).toEqual(failed("scoring failed"));
  expect(await scorer.score(bytes('{"x":2}'))).toEqual(failed("$.x expected 1"));
  await scorer.close();

  // Criteria that cannot be compiled are refused, and no entry is scored with them: past the
  // budget, a schema that does not compile, a compile that crashes the worker.
  const refused: [P0Criteria, WorkerOptions & { compileBudgetMs?: number }, unknown][] = [
    [slow.criteria, { ...UNHURRIED, workerUrl: ROGUE, compileBudgetMs: 100 }, TOO_SLOW],
    [
      jsonSchema({ type: 12 }),
      UNHURRIED,
      expect.stringMatching(/^criteria schema cannot be compiled: /),
    ],
    [
      jsonSchema({ title: "rogue:compile-throws" }),
      { ...UNHURRIED, workerUrl: ROGUE },
      "criteria could not be checked",
    ],
  ];
  for (const [criteria, options, reason] of refused) {
    const refusing = openTaskScorer({ criteria, heldout: X_IS_1 }, options);
    expect(await refusing.score(bytes('{"x":1}'))).toEqual({ kind: "rejected", reason });
    await refusing.close();
  }
});

test("an_answer_out_of_turn_is_a_crash", { timeout: 120_000 }, async () => {
  // Each request carries an id, and its answer the same one. An answer to a request that was
  // never sent, while one is in flight, is that one's crash. A message that comes when nothing is
  // asked ends the worker, and the next entry gets a new one: its count starts again.
  const onCrash = vi.fn();
  const before = workers();
  const scorer = openTaskScorer(EXACT_TASK, { ...UNHURRIED, workerUrl: ROGUE, onCrash });
  expect(await scorer.score(bytes("rogue:wrong-id"))).toEqual(failed("scoring failed"));
  expect(onCrash.mock.calls.map(([error]) => error.name)).toEqual(["ScoreWorkerError"]);
  expect(await scorer.score(bytes("rogue:seen"))).toEqual(failed("1 seen"));
  expect(await scorer.score(bytes("rogue:twice"))).toEqual(WRONG);
  await vi.waitFor(() => expect(workers()).toBe(before), { timeout: 60_000 });
  expect(await scorer.score(bytes("rogue:seen"))).toEqual(failed("1 seen"));
  expect(onCrash).toHaveBeenCalledTimes(1);
  await scorer.close();
});

test("a_worker_has_none_of_the_judges_environment", { timeout: 120_000 }, async () => {
  // The scorers need none of it, the Judge's keys among it, and nor does tsx's loader.
  const scorer = openTaskScorer(EXACT_TASK, { ...UNHURRIED, workerUrl: ROGUE });
  expect(await scorer.score(bytes("rogue:env"))).toEqual(
    scored({ score: 0, passed: false, reasons: [] }),
  );
  await scorer.close();
});

test("no_worker_is_left_after_a_task", { timeout: 120_000 }, async () => {
  const before = workers();
  const scorer = openTaskScorer(EXACT_TASK, {
    ...UNHURRIED,
    workerUrl: ROGUE,
    entryTimeoutMs: 2_000,
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
  expect(await checkJsonSchemaIsolated({ type: "object" }, UNHURRIED_CHECK)).toEqual({ ok: true });
  const crashing = checkJsonSchemaIsolated(
    { title: "rogue:throw" },
    { ...UNHURRIED_CHECK, workerUrl: ROGUE },
  );
  await expect(crashing).rejects.toThrow();
  expect(
    await checkJsonSchemaIsolated(
      { title: "rogue:loop" },
      { workerUrl: ROGUE, budgetMs: 200, startTimeoutMs: UNHURRIED.startTimeoutMs },
    ),
  ).toMatchObject({ ok: false });
  expect(workers()).toBe(before);
});

test("under_tsx_the_workers_load_and_nothing_is_left_running", { timeout: 240_000 }, async () => {
  // The tsx CLI, as `pnpm serve` runs the Judge: the workers inherit its loader, a warm one's too.
  // The script prints the workers and timers still running once its scorers and the warm worker
  // are closed, and must then exit by itself, which it cannot while a worker or a timer is left.
  const cli = createRequire(import.meta.url).resolve("tsx/cli");
  const script = fileURLToPath(new URL("./fixtures/score-under-tsx.ts", import.meta.url));
  const { stdout } = await run(process.execPath, [cli, script], { timeout: 180_000 });
  expect(JSON.parse(stdout)).toEqual({
    scores: [
      RIGHT,
      WRONG,
      failed("scoring timed out"),
      failed("scoring failed"),
      RIGHT,
      scored({ score: 0, passed: false, reasons: [] }),
      RIGHT,
    ],
    check: { ok: true },
    left: [],
  });
});

test("a_heavy_json_schema_entry_times_out_within_the_limit", { timeout: 120_000 }, async () => {
  // `uniqueItems` over items with no type compares every pair of them: an honest schema, and a
  // document of 256 KiB of small arrays that takes about 9 s to check here (224 KiB of them took
  // about 5.7 s). The entry has 1 s, so that the outcome does not hang on how fast the machine is.
  // (The reason, `scoring timed out`, is the stop's alone: an entry that was left to finish would
  // be scored. The time is only held under what the check takes when nothing stops it, which a
  // busy machine makes longer too, so it is not tight.)
  const items: number[][][] = [];
  for (let size = 2; size + `[[${items.length}]],`.length <= 262_144; ) {
    size += `[[${items.length}]],`.length;
    items.push([[items.length]]);
  }
  const heavy = bytes(JSON.stringify(items));
  expect(heavy.byteLength).toBeLessThanOrEqual(262_144);
  const scorer = openTaskScorer(
    {
      criteria: jsonSchema({ type: "array", uniqueItems: true }),
      heldout: { json_schema: { assertions: [{ path: "$[0][0][0]", equals: 0 }] } },
    },
    { ...UNHURRIED, entryTimeoutMs: 2_000 },
  );
  expect(await scorer.score(bytes("[[[0]],[[1]]]"))).toEqual(RIGHT);

  const started = performance.now();
  expect(await scorer.score(heavy)).toEqual(failed("scoring timed out"));
  expect(performance.now() - started).toBeLessThan(2_000 + 15_000);
  await scorer.close();
});

test("the_compile_check_has_a_budget", { timeout: 120_000 }, async () => {
  // A schema near the size cap takes a few hundred milliseconds to compile.
  const properties: Record<string, unknown> = {};
  for (let i = 0; i < 3_000; i++) {
    properties[`p${i}`] = { type: "string", pattern: "^[a-z]{1,8}$", maxLength: 8 };
  }
  const loaded = { startTimeoutMs: UNHURRIED.startTimeoutMs };
  expect(
    await checkJsonSchemaIsolated({ type: "object", properties }, { ...loaded, budgetMs: 50 }),
  ).toEqual({ ok: false, reason: TOO_SLOW });
  // A compile that never ends.
  const looping = { title: "rogue:loop" };
  expect(
    await checkJsonSchemaIsolated(looping, { ...loaded, workerUrl: ROGUE, budgetMs: 300 }),
  ).toEqual({ ok: false, reason: TOO_SLOW });

  // Within the budget, the result is the check's own.
  expect(await checkJsonSchemaIsolated({ type: "object" }, UNHURRIED_CHECK)).toEqual({ ok: true });
  expect(await checkJsonSchemaIsolated({ type: 12 }, UNHURRIED_CHECK)).toEqual({
    ok: false,
    reason: expect.stringMatching(/^criteria schema cannot be compiled: /),
  });

  // A check that crashes its worker, or answers with something else, has no result: the schema
  // did that, and it is no `ScorerUnavailableError`.
  for (const title of ["rogue:throw", "rogue:malformed"]) {
    const failed = checkJsonSchemaIsolated({ title }, { ...UNHURRIED_CHECK, workerUrl: ROGUE });
    await expect(failed).rejects.toThrow();
    await expect(failed).rejects.not.toBeInstanceOf(ScorerUnavailableError);
  }
  await expect(checkJsonSchemaIsolated({}, { startTimeoutMs: 1 })).rejects.toBeInstanceOf(
    ScorerUnavailableError,
  );
});
