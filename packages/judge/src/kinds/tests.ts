import type { PublicCriteria } from "@tender/shared";
import { Sandbox, type SandboxOptions } from "../sandbox";
import type { EntryScore } from "../types";
import { decodeUtf8, type HeldoutOf, scored } from "./common";

type TestsCriteria = Extract<PublicCriteria, { kind: "tests" }>;
type TestCase = TestsCriteria["examples"][number];

/** The largest source an entry may have, in bytes. */
const MAX_SOURCE_BYTES = 65_536;
/**
 * What running one case may cost the Judge: its own runtime, of which the engine ends the code
 * after a second, and the allocation of more than 32 MiB at once. (The engine's whole memory has a
 * cap of its own, 128 MiB: `ENGINE_MEMORY_CAP_BYTES`.)
 */
const SANDBOX_LIMITS: SandboxOptions = { timeoutMs: 1_000, memoryBytes: 32 * 1024 * 1024 };
/**
 * The longest text a case may answer with, in characters. The expected output is part of a
 * document of at most 262_144 bytes, so a correct answer is far shorter; a longer one is not
 * parsed.
 */
const MAX_OUTPUT_CHARS = 1_048_576;
/** How many failed cases the reasons name. */
const MAX_REASONS = 3;
/** How much of a case's input a reason shows, in characters (code points). */
const MAX_INPUT_LENGTH = 60;

const NOT_A_NAME = "criteria entry is not a function name";

/** Why a case failed. The words are the reasons' own. */
type Failure =
  | "wrong output"
  | "no JSON output"
  | "output too large"
  | "threw an exception"
  | "timed out"
  | "ran out of memory";

/**
 * Words that cannot name a function, and names that a function there would not be a function:
 * `entry` is called as `(entry)(input)`.
 */
const NOT_NAMES: ReadonlySet<string> = new Set(
  (
    "arguments await break case catch class const continue debugger default delete do else enum " +
    "eval export extends false finally for function if implements import in instanceof interface " +
    "let new null package private protected public return static super switch this throw true " +
    "try typeof var void while with yield undefined NaN Infinity"
  ).split(" "),
);

/** Whether `entry` can name a function in the entry's source: a plain ASCII identifier. */
function isFunctionName(entry: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(entry) && !NOT_NAMES.has(entry);
}

/**
 * Why `tests` criteria cannot be scored with, or `null`: the rules intake checks, and judging
 * checks again.
 *
 * - `entry` must be a function name: letters, digits, `_` and `$`, not starting with a digit, and
 *   not a reserved word. It becomes part of the program the sandbox runs, so it is never anything
 *   else.
 * - Without held-out checks the published examples are the cases, so there must be one.
 */
export function testsCriteriaProblem(c: TestsCriteria): string | null {
  if (!isFunctionName(c.entry)) {
    return "kind tests needs an entry that is a function name: letters, digits, _ and $, not starting with a digit, and not a reserved word";
  }
  if (!c.has_heldout && c.examples.length === 0) {
    return "kind tests needs at least one example when it has no held-out checks";
  }
  return null;
}

/**
 * Scores a `tests` entry: the share of the test cases that the entry's function gets right, with
 * a pass mark of the criteria's `min_score`.
 *
 * The entry is JavaScript source, valid UTF-8 of at most 65_536 bytes, that defines the function
 * `c.entry` as a script would: `function f(x) { … }`, `const f = …`. It is not a module (`export`
 * and `import` are errors), the function is called synchronously with the case's input as its one
 * argument, and what it returns is compared as JSON: `JSON.stringify` of the result, parsed
 * again, has to equal the case's `output` (objects with the same keys in any order, arrays
 * element by element, numbers and strings as they are). Anything JSON cannot say, `NaN` and
 * `undefined` included, is what JSON makes of it, and a function that returns a promise (an
 * `async` function) returns `{}`. A leading byte order mark is dropped, as `TextDecoder` does by
 * default.
 *
 * The cases are the held-out document's when there is one, and otherwise the criteria's published
 * examples. They are not combined. With no case at all there is nothing to score and the score is
 * 0. The score is `round(100 × passed / total)`, and never above 99 while one case has failed
 * (as for `regex_cases`: with 200 cases or more, one failure would round up to 100). The reasons
 * name the first three failed cases, with the start of the input and one of `wrong output`,
 * `no JSON output`, `output too large`, `threw an exception`, `timed out` and `ran out of memory`;
 * nothing the entry wrote is repeated in them.
 *
 * Every case runs in a runtime of its own in the sandbox (WebAssembly QuickJS: see `sandbox.ts`),
 * 1 s and 32 MiB for the case, so nothing one case does is seen by the next, and the program is
 * the entry's source, then `JSON.stringify((entry)(input))` with the input as a JSON literal, a
 * string or array or object that is data, never code. The entry has an engine of its own, so that
 * no other entry's run decides what it is given. A case that runs out of time ends the run: the
 * cases after it are not run, and count as failed, so that an entry that loops costs the Judge
 * one second and not one for each case. A case that runs out of memory fails alone, and the cases
 * after it run on a new engine.
 *
 * The sandbox gives the code the language's own built-ins and nothing of the host: no `require`,
 * `process`, `fetch`, timers, `WebAssembly` or `import()` that loads anything. The run is bounded
 * in time by the engine's interrupt check, which native loops over huge sparse arrays never reach
 * (`new Array(2 ** 32 - 1).indexOf(1)`): nothing in this process ends those, so this must run in a
 * score worker (`isolate.ts`), whose stop ends the entry at its time limit. See
 * docs/research/S8-sandbox.md for what each hostile entry came to. Called here, on the caller's
 * thread, such an entry blocks it for as long as the loop runs.
 *
 * Total in the bytes: whatever an agent wrote, this returns a score and does not throw. It
 * rejects only when the sandbox cannot be started, which is the host's trouble and not the
 * agent's.
 */
export async function scoreTests(
  c: TestsCriteria,
  h: HeldoutOf<"tests"> | null,
  content: Uint8Array,
): Promise<EntryScore> {
  // Not trusted to have been through intake: the entry becomes code.
  if (!isFunctionName(c.entry)) return scored(c, 0, [NOT_A_NAME]);
  if (content.byteLength > MAX_SOURCE_BYTES) {
    return scored(c, 0, [`source larger than ${MAX_SOURCE_BYTES} bytes`]);
  }
  const source = decodeUtf8(content);
  if (source === null) return scored(c, 0, ["not valid UTF-8"]);

  const cases = h?.cases ?? c.examples;
  const total = cases.length;
  // Without a case, 100 × 0 / 0 would be NaN.
  if (total === 0) return scored(c, 0, ["no test cases"]);

  // An engine of this entry's own, so that nothing an earlier entry did to its engine (the memory
  // it grew, the layout it left) decides what this one is given: the same entry scores the same
  // first, after a bomb, and after a worker was stopped.
  const sandbox = new Sandbox();
  let passed = 0;
  let notRun = 0;
  const reasons: string[] = [];
  for (const [i, testCase] of cases.entries()) {
    const failure = await runCase(sandbox, source, c.entry, testCase);
    if (failure === null) {
      passed++;
      continue;
    }
    if (reasons.length < MAX_REASONS) {
      reasons.push(`case ${i + 1} (${showInput(testCase.input)}): ${failure}`);
    }
    // What a case that runs out of its limits costs the entry (controller ruling, S8 fix round 1):
    // - It runs out of time: the run ends here. The cases after it are not run and count as
    //   failed, and the score is over all the cases, `round(100 × passed / total)`. That bounds a
    //   looping entry to one second and not one for each case, and an entry that is slow once
    //   loses what is after it: tasks should keep their cases well under a second each.
    // - It runs out of memory: that case fails, and the cases after it run, on a new engine. One
    //   case's allocation must not zero the entry, and the label is the weaker signal (code can
    //   fake it, and it says what the engine's allocator had left).
    if (failure === "timed out") {
      notRun = total - i - 1;
      break;
    }
    if (failure === "ran out of memory") sandbox.renew();
  }
  if (notRun > 0) reasons.push(`${notRun} more ${notRun === 1 ? "case" : "cases"} not run`);

  const rounded = Math.round((100 * passed) / total);
  return scored(c, passed < total ? Math.min(rounded, 99) : rounded, reasons);
}

/** Runs the entry on one case: `null` when it passes, otherwise why it does not. */
async function runCase(
  sandbox: Sandbox,
  source: string,
  entry: string,
  testCase: TestCase,
): Promise<Failure | null> {
  // A newline and a semicolon after the source: it may end in a line comment or an expression.
  // `entry` is a name (checked above) and the input is JSON, which is a JavaScript literal.
  const program = `${source}\n;JSON.stringify((${entry})(${JSON.stringify(testCase.input)}))`;
  const ran = await sandbox.run(program, SANDBOX_LIMITS);
  if (!ran.ok) {
    // `memory` can be faked by code that throws the engine's error, which only ends its own run.
    if (ran.error === "timeout") return "timed out";
    return ran.error === "memory" ? "ran out of memory" : "threw an exception";
  }
  // `undefined` when the function returned nothing JSON can write, and a string otherwise, unless
  // the entry replaced `JSON.stringify`: it is not trusted to have returned a string.
  if (typeof ran.value !== "string") return "no JSON output";
  if (ran.value.length > MAX_OUTPUT_CHARS) return "output too large";
  let answer: unknown;
  try {
    answer = JSON.parse(ran.value);
  } catch {
    return "no JSON output";
  }
  return sameJson(answer, testCase.output) ? null : "wrong output";
}

/**
 * Whether the JSON value `actual` equals `expected`: objects have the same keys, whatever their
 * order, and arrays the same elements. It follows `expected`, which `JsonValueSchema` keeps to 64
 * levels, so a deeply nested answer cannot overflow the stack here.
 */
function sameJson(actual: unknown, expected: unknown): boolean {
  if (typeof expected !== "object" || expected === null) return actual === expected;
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item, i) => sameJson(actual[i], item))
    );
  }
  if (typeof actual !== "object" || actual === null || Array.isArray(actual)) return false;
  const keys = Object.keys(expected);
  const record = actual as Record<string, unknown>;
  return (
    Object.keys(record).length === keys.length &&
    keys.every(
      (key) =>
        Object.hasOwn(record, key) &&
        sameJson(record[key], (expected as Record<string, unknown>)[key]),
    )
  );
}

/** The start of `input` as JSON: its first 60 characters (whole code points). */
function showInput(input: unknown): string {
  const json = JSON.stringify(input);
  // A code point takes at most two UTF-16 units, so the first 120 hold the first 60 code points,
  // and an input of any length costs the same.
  const points = [...json.slice(0, 2 * MAX_INPUT_LENGTH + 1)];
  return points.length > MAX_INPUT_LENGTH ? `${points.slice(0, MAX_INPUT_LENGTH).join("")}…` : json;
}
