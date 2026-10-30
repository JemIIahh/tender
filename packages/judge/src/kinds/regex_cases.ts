import type { PublicCriteria } from "@tender/shared";
import { runInSandbox, type SandboxOptions, type SandboxResult } from "../sandbox";
import type { EntryScore } from "../types";
import { decodeUtf8, type HeldoutOf, scored } from "./common";

type RegexCriteria = Extract<PublicCriteria, { kind: "regex_cases" }>;

const ANSWER_SHAPE = 'answer must be JSON {"pattern": string, "flags"?: string}';
const MAX_PATTERN_LENGTH = 2_000;
/** The flags an answer may set. */
const ALLOWED_FLAGS = new Set(["i", "m", "s", "u"]);
/** What running one answer on all its cases may cost the Judge. */
const SANDBOX_LIMITS: SandboxOptions = { timeoutMs: 2_000, memoryBytes: 32 * 1024 * 1024 };
/** How many failed cases the reasons name. */
const MAX_REASONS = 3;
/** How much of a case a reason shows, in characters (code points). */
const MAX_CASE_LENGTH = 60;

/**
 * Scores a `regex_cases` entry: the share of the test strings the regex gets right, with a pass
 * mark of the criteria's `min_score`. A string that should match counts when the regex's `test`
 * finds a match in it, and a string that should not match counts when it finds none. The
 * regex is not anchored for the answer, so it needs its own `^` and `$` to take a whole string.
 *
 * The answer is valid UTF-8 holding JSON `{"pattern": string, "flags"?: string}`; other keys are
 * ignored. The pattern is at most 2000 characters (`pattern.length`). The flags are some of
 * `i`, `m`, `s` and `u`, each at most once. `g` and `y` are refused (`stateful flags not
 * allowed`): they make `test` remember where it stopped, so a case would be judged by the cases
 * before it. A leading byte order mark is dropped, as `TextDecoder` does by default.
 *
 * The cases are the held-out document's `match` and `no_match` when there is one, and otherwise
 * the criteria's published examples. They are not combined. With no case at all there is nothing
 * to score and the score is 0.
 *
 * The score is `round(100 × passed / total)`, and never above 99 while one case has failed, so a
 * score of 100 always means that every case was right. The reasons name the first three failed
 * cases (those that should match first), each cut to 60 characters and written as a JSON string
 * so that a reason stays one line.
 *
 * The regex runs only inside the sandbox (WebAssembly QuickJS, 2 s and 32 MiB for the whole
 * entry), never in this process: the pattern is not compiled here, not even to check it, and
 * reaches the sandbox as a JSON string, with the cases, in a fixed program. A regex that
 * backtracks without end, or one the sandbox's engine does not accept, scores 0 for its entry and
 * changes no other entry's score. The engine is QuickJS's, so a pattern is judged by its rules,
 * not V8's.
 *
 * The sandbox blocks this thread while it runs: for as long as 2 seconds, on a regex that uses
 * its budget.
 *
 * Total in the bytes: whatever an agent wrote, this returns a score and does not throw. It
 * rejects only when the sandbox cannot be started, which is the host's trouble and not the
 * agent's.
 */
export async function scoreRegexCases(
  c: RegexCriteria,
  h: HeldoutOf<"regex_cases"> | null,
  content: Uint8Array,
): Promise<EntryScore> {
  const text = decodeUtf8(content);
  if (text === null) return scored(c, 0, ["not valid UTF-8"]);

  const answer = parseAnswer(text);
  if (answer === null) return scored(c, 0, [ANSWER_SHAPE]);
  const { pattern, flags } = answer;
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return scored(c, 0, [`pattern longer than ${MAX_PATTERN_LENGTH} characters`]);
  }
  const flagsProblem = checkFlags(flags);
  if (flagsProblem !== null) return scored(c, 0, [flagsProblem]);

  const { match, no_match: noMatch } = h ?? c.examples;
  const total = match.length + noMatch.length;
  // Without a case, 100 × 0 / 0 would be NaN.
  if (total === 0) return scored(c, 0, ["no test cases"]);

  const ran = await runInSandbox(program(pattern, flags, match, noMatch), SANDBOX_LIMITS);
  if (!ran.ok) return scored(c, 0, [sandboxFailure(ran)]);
  const verdicts = readVerdicts(ran.value, match.length, noMatch.length);
  if (verdicts === null) return scored(c, 0, ["sandbox returned an unexpected value"]);

  let failed = 0;
  const reasons: string[] = [];
  const tally = (cases: string[], rightOnes: boolean[], should: string) => {
    cases.forEach((testCase, i) => {
      if (rightOnes[i]) return;
      failed++;
      if (reasons.length < MAX_REASONS) reasons.push(`${should} ${quote(testCase)}`);
    });
  };
  tally(match, verdicts[0], "should match");
  tally(noMatch, verdicts[1], "should not match");

  const rounded = Math.round((100 * (total - failed)) / total);
  // 100 means that every case was right. With 200 cases or more, one failure would round up to it.
  return scored(c, failed > 0 ? Math.min(rounded, 99) : rounded, reasons);
}

/** The pattern and flags of an answer, or `null` when it is not `{"pattern", "flags"?}`. */
function parseAnswer(text: string): { pattern: string; flags: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;

  const { pattern, flags = "" } = parsed as Record<string, unknown>;
  if (typeof pattern !== "string" || typeof flags !== "string") return null;
  return { pattern, flags };
}

/**
 * Why `flags` cannot be used, or `null` when they can. `g` and `y` are checked first, so flags
 * with one of them always get the reason that says why.
 */
function checkFlags(flags: string): string | null {
  if (/[gy]/.test(flags)) return "stateful flags not allowed";

  const each = [...flags];
  if (each.some((flag) => !ALLOWED_FLAGS.has(flag)) || new Set(each).size !== each.length) {
    return "unsupported flags";
  }
  return null;
}

/**
 * The program the sandbox runs. The pattern, the flags and the cases go in as JSON, which is a
 * string or array literal in JavaScript, and in no other way: no text of an answer or of a task
 * is ever code. It evaluates to `[matches, nonMatches]`, one boolean for each case: whether the
 * regex got it right.
 */
function program(pattern: string, flags: string, match: string[], noMatch: string[]): string {
  return (
    `const re=new RegExp(${JSON.stringify(pattern)},${JSON.stringify(flags)});` +
    `[${JSON.stringify(match)}.map(s=>re.test(s)),${JSON.stringify(noMatch)}.map(s=>!re.test(s))]`
  );
}

/**
 * The sandbox's answer as one list of verdicts for the cases that should match and one for those
 * that should not, or `null` when it is anything but exactly that.
 */
function readVerdicts(
  value: unknown,
  matches: number,
  noMatches: number,
): [boolean[], boolean[]] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [forMatch, forNoMatch] = value;
  return isVerdicts(forMatch, matches) && isVerdicts(forNoMatch, noMatches)
    ? [forMatch, forNoMatch]
    : null;
}

function isVerdicts(value: unknown, length: number): value is boolean[] {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((verdict) => typeof verdict === "boolean")
  );
}

function sandboxFailure(failure: Extract<SandboxResult, { ok: false }>): string {
  switch (failure.error) {
    case "timeout":
      return "timed out (likely catastrophic backtracking)";
    case "memory":
      // Code could fake this label, but the program is fixed and has no `try` or `throw`: only
      // the engine can have raised the error behind it.
      return "ran out of memory";
    case "exception":
      // The program throws nothing of its own: a SyntaxError is `new RegExp` refusing the pattern.
      return failure.message.startsWith("SyntaxError:")
        ? "invalid pattern"
        : "regex evaluation failed";
  }
}

/** `text` cut to its first 60 characters (whole code points), as a JSON string. */
function quote(text: string): string {
  // A code point takes at most two UTF-16 units, so the first 120 hold the first 60 code points,
  // and a case of any length costs the same.
  const head = text.slice(0, 2 * MAX_CASE_LENGTH);
  return JSON.stringify([...head].slice(0, MAX_CASE_LENGTH).join(""));
}
