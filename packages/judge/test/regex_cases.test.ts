import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HeldoutSchema, type PublicCriteria, PublicCriteriaSchema } from "@tender/shared";
import { expect, test, vi } from "vitest";
import { heldoutFileOf, privateDirOf, solutionFileOf } from "../../../scripts/lib/private-dir";
import { ScorerUnavailableError, scoreEntry, scoreRegexCases } from "../src/index";
import type { HeldoutOf } from "../src/kinds/common";
import { runInSandbox } from "../src/sandbox";

// The real sandbox runs unless a test queues an answer for it, with `mockResolvedValueOnce`.
vi.mock("../src/sandbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/sandbox")>();
  return { ...actual, runInSandbox: vi.fn(actual.runInSandbox) };
});

type RegexCriteria = Extract<PublicCriteria, { kind: "regex_cases" }>;
type RegexHeldout = HeldoutOf<"regex_cases">;

const ANSWER_SHAPE = 'answer must be JSON {"pattern": string, "flags"?: string}';
/** What `^(a+)+$` takes 2^40 steps to refuse: it fits until the last character. */
const BACKTRACKING_CASE = `${"a".repeat(40)}!`;

function criteria(
  examples: { match?: string[]; no_match?: string[] } = {},
  minScore = 100,
): RegexCriteria {
  return {
    version: 1,
    kind: "regex_cases",
    min_score: minScore,
    split: "winner_take_all",
    has_heldout: true,
    examples: { match: examples.match ?? [], no_match: examples.no_match ?? [] },
  };
}

const heldout = (match: string[], noMatch: string[]): RegexHeldout => ({
  match,
  no_match: noMatch,
});
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const answer = (pattern: string, flags?: string): Uint8Array =>
  bytes(JSON.stringify(flags === undefined ? { pattern } : { pattern, flags }));

/** Scores `pattern` on held-out cases that decide the whole score. */
function score(pattern: string, match: string[], noMatch: string[], flags?: string) {
  return scoreRegexCases(criteria(), heldout(match, noMatch), answer(pattern, flags));
}

/** `^a$` on `passing` strings that should match and `failing` that should but do not. */
function withCases(passing: number, failing: number) {
  return score(
    "^a$",
    [...Array.from({ length: passing }, () => "a"), ...Array.from({ length: failing }, () => "b")],
    [],
  );
}

/**
 * Where the `near-account-regex` seed's held-out cases and solution are: not in the seed's folder,
 * which is public, but in the private directory (`TENDER_SEEDS_PRIVATE_DIR`, see seeds/README.md).
 */
const NEAR_ACCOUNT_HELDOUT = heldoutFileOf(privateDirOf(), "near-account-regex");
const NEAR_ACCOUNT_SOLUTION = solutionFileOf(privateDirOf(), "near-account-regex");
/** Whether this machine has them. Where it has not (CI), the tests that score the seed are skipped. */
const hasNearAccountSeed = existsSync(NEAR_ACCOUNT_HELDOUT) && existsSync(NEAR_ACCOUNT_SOLUTION);
const seedTest = test.skipIf(!hasNearAccountSeed);
if (!hasNearAccountSeed) {
  console.warn(
    `regex_cases: held-out and solution for near-account-regex not found in ${privateDirOf()}; set TENDER_SEEDS_PRIVATE_DIR. ` +
      "The tests that score the seed are skipped.",
  );
}

/** The `near-account-regex` seed: its criteria, held-out cases and two answers. */
function nearAccountSeed() {
  const dir = join(import.meta.dirname, "../../../seeds/near-account-regex");
  const read = (name: string) => readFileSync(join(dir, name));
  const c = PublicCriteriaSchema.parse(JSON.parse(read("criteria.json").toString("utf8")));
  const h = HeldoutSchema.parse(JSON.parse(readFileSync(NEAR_ACCOUNT_HELDOUT, "utf8")));
  if (c.kind !== "regex_cases" || !("regex_cases" in h)) throw new Error("not a regex_cases seed");
  return {
    c,
    h: h.regex_cases,
    solution: readFileSync(NEAR_ACCOUNT_SOLUTION),
    weak: read("weak.txt"),
  };
}

const zero = (...reasons: string[]) => ({ score: 0, passed: false, reasons });

// Written as code points, so that the characters can be seen in the source.
const GRINNING_FACE = String.fromCodePoint(0x1f600);
const LINE_SEPARATOR = String.fromCodePoint(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCodePoint(0x2029);
const LONE_SURROGATE = String.fromCodePoint(0xd800);

seedTest("near_account_regex_scores_100", async () => {
  const { c, h, solution } = nearAccountSeed();

  expect(await scoreRegexCases(c, h, solution)).toEqual({ score: 100, passed: true, reasons: [] });
  // With no held-out document the published examples are the cases, and they hold too.
  expect(await scoreRegexCases(c, null, solution)).toEqual({
    score: 100,
    passed: true,
    reasons: [],
  });
});

seedTest("weak_regex_scores_lower", async () => {
  const { c, h, weak } = nearAccountSeed();

  const result = await scoreRegexCases(c, h, weak);
  expect(result.score).toBeGreaterThan(0);
  expect(result.score).toBeLessThan(100);
  expect(result.passed).toBe(false);
  expect(result.reasons).toHaveLength(3);
  for (const reason of result.reasons) expect(reason).toMatch(/^should (not )?match ".*"$/);
  // It passes every published example. That is what the held-out cases are for.
  expect(await scoreRegexCases(c, null, weak)).toEqual({ score: 100, passed: true, reasons: [] });
});

test("catastrophic_backtracking_times_out", { timeout: 10_000 }, async () => {
  const started = performance.now();
  const result = await score("^(a+)+$", [], [BACKTRACKING_CASE]);

  expect(result).toEqual(zero("timed out (likely catastrophic backtracking)"));
  // The budget is two seconds. Without a limit this would run for minutes.
  expect(performance.now() - started).toBeLessThan(5_000);
  // One slow case costs the whole entry, whatever the other cases would have said.
  expect(await score("^(a+)+$", ["a", "aa"], ["b", BACKTRACKING_CASE])).toEqual(
    zero("timed out (likely catastrophic backtracking)"),
  );
});

test("invalid_pattern_scores_zero", async () => {
  for (const pattern of ["(", "[", "*a", "a{2,1}", "[b-a]", "(?<n>a)(?<n>b)", "\\", "a**"]) {
    expect(await score(pattern, ["a"], ["b"]), pattern).toEqual(zero("invalid pattern"));
  }
  // Some escapes are errors only with the `u` flag.
  expect(await score("\\-", ["-"], [], "")).toEqual({ score: 100, passed: true, reasons: [] });
  expect(await score("\\-", ["-"], [], "u")).toEqual(zero("invalid pattern"));
});

test("g_flag_rejected", async () => {
  for (const flags of ["g", "y", "gi", "iy", "gy", "gg", "yy", "gx", "ixg"]) {
    expect(await score("a", ["a"], [], flags), flags).toEqual(zero("stateful flags not allowed"));
  }
  // Every other flag the engine knows, and anything else, is not allowed either; so is a repeat.
  for (const flags of ["x", "d", "v", "ii", "I", "i m", "im,", "iu\u0000", GRINNING_FACE]) {
    expect(await score("a", ["a"], [], flags), flags).toEqual(zero("unsupported flags"));
  }
  // The four that are allowed, alone and together.
  for (const flags of ["", "i", "m", "s", "u", "imsu", "usmi"]) {
    expect(await score("a", ["a"], [], flags), flags).toEqual({
      score: 100,
      passed: true,
      reasons: [],
    });
  }
});

test("flags_are_applied", async () => {
  // `i`
  expect((await score("^a$", ["A"], [], "i")).score).toBe(100);
  expect((await score("^a$", ["A"], [], "")).score).toBe(0);
  // `m`: ^ and $ match at line breaks.
  expect((await score("^b$", ["a\nb\nc"], [], "m")).score).toBe(100);
  expect((await score("^b$", ["a\nb\nc"], [], "")).score).toBe(0);
  // `s`: . matches a line break.
  expect((await score("^a.b$", ["a\nb"], [], "s")).score).toBe(100);
  expect((await score("^a.b$", ["a\nb"], [], "")).score).toBe(0);
  // `u`: . matches a code point, not half of one.
  expect((await score("^.$", [GRINNING_FACE], [], "u")).score).toBe(100);
  expect((await score("^.$", [GRINNING_FACE], [], "")).score).toBe(0);
});

test("answer_shape_is_checked", async () => {
  const c = criteria();
  const h = heldout(["a"], []);
  const wrong: [string, Uint8Array][] = [
    ["empty", bytes("")],
    ["not JSON", bytes("^a$")],
    ["trailing comma", bytes('{"pattern":"a",}')],
    ["an array", bytes('["a"]')],
    ["null", bytes("null")],
    ["a string", bytes('"^a$"')],
    ["a number", bytes("5")],
    ["no pattern", bytes('{"flags":"i"}')],
    ["a pattern that is not a string", bytes('{"pattern":5}')],
    ["a pattern that is null", bytes('{"pattern":null}')],
    ["flags that are not a string", bytes('{"pattern":"a","flags":5}')],
    ["flags that are null", bytes('{"pattern":"a","flags":null}')],
    ["flags that are a list", bytes('{"pattern":"a","flags":["i"]}')],
  ];
  for (const [label, content] of wrong) {
    expect(await scoreRegexCases(c, h, content), label).toEqual(zero(ANSWER_SHAPE));
  }

  // Other keys are ignored, `__proto__` among them; flags are optional.
  const extra = bytes('{"pattern":"^A$","flags":"i","note":"hi","__proto__":{"flags":"g"}}');
  expect(await scoreRegexCases(c, heldout(["a"], ["b"]), extra)).toEqual({
    score: 100,
    passed: true,
    reasons: [],
  });
  expect((await scoreRegexCases(c, h, bytes('{"pattern":"a"}'))).score).toBe(100);
});

test("invalid_utf8_scores_zero", async () => {
  const c = criteria();
  const h = heldout(["a"], []);
  const invalid: [string, number[]][] = [
    ["a byte that never occurs in UTF-8", [0xff]],
    ["a truncated sequence", [0xe2, 0x82]],
    ["an overlong encoding", [0xc0, 0xaf]],
    ["an encoded surrogate", [0xed, 0xa0, 0x80]],
    ["bad bytes after a valid answer", [...bytes('{"pattern":"a"}'), 0xff]],
  ];
  for (const [label, raw] of invalid) {
    expect(await scoreRegexCases(c, h, Uint8Array.from(raw)), label).toEqual(
      zero("not valid UTF-8"),
    );
  }
});

test("leading_bom_is_dropped", async () => {
  const c = criteria();
  const h = heldout(["a"], []);
  const withBom = (...rest: number[]): Uint8Array => Uint8Array.from([0xef, 0xbb, 0xbf, ...rest]);
  const json = bytes('{"pattern":"^a$"}');

  // The three bytes EF BB BF at the start are a byte order mark, and the decoder drops them.
  expect(await scoreRegexCases(c, h, withBom(...json))).toEqual({
    score: 100,
    passed: true,
    reasons: [],
  });
  // It drops one, and only at the start. Any other mark is not JSON.
  expect(await scoreRegexCases(c, h, withBom(...withBom(...json)))).toEqual(zero(ANSWER_SHAPE));
});

test("pattern_length_is_limited", async () => {
  const longest = `^${"a".repeat(1_998)}$`;
  expect(longest).toHaveLength(2_000);
  expect(await score(longest, ["a".repeat(1_998)], ["a"])).toEqual({
    score: 100,
    passed: true,
    reasons: [],
  });

  const tooLong = `^${"a".repeat(1_999)}$`;
  expect(await score(tooLong, ["a".repeat(1_999)], [])).toEqual(
    zero("pattern longer than 2000 characters"),
  );
  // The limit counts the pattern's length in UTF-16 units, as `pattern.length` does.
  expect(await score(GRINNING_FACE.repeat(1_001), [], [])).toEqual(
    zero("pattern longer than 2000 characters"),
  );
});

test("cases_come_from_heldout_else_examples", async () => {
  const c = criteria({ match: ["a"], no_match: ["b"] });

  // No held-out document: the published examples are the cases.
  expect((await scoreRegexCases(c, null, answer("^a$"))).score).toBe(100);
  expect(await scoreRegexCases(c, null, answer("^b$"))).toEqual({
    score: 0,
    passed: false,
    reasons: ['should match "a"', 'should not match "b"'],
  });
  // With one, only its cases count, and the examples do not. `^a$` is right about both
  // examples, and wrong about both held-out cases: were the examples counted, it would score 50.
  const h = heldout(["x"], ["a"]);
  expect(await scoreRegexCases(c, h, answer("^x$"))).toEqual({
    score: 100,
    passed: true,
    reasons: [],
  });
  expect(await scoreRegexCases(c, h, answer("^a$"))).toEqual({
    score: 0,
    passed: false,
    reasons: ['should match "x"', 'should not match "a"'],
  });
});

test("no_test_cases_scores_zero", async () => {
  expect(await scoreRegexCases(criteria(), null, answer("a"))).toEqual(zero("no test cases"));
  expect(await scoreRegexCases(criteria(), heldout([], []), answer("a"))).toEqual(
    zero("no test cases"),
  );
  // Held-out cases that are empty do not fall back to the examples.
  expect(await scoreRegexCases(criteria({ match: ["a"] }), heldout([], []), answer("a"))).toEqual(
    zero("no test cases"),
  );
  // A bad answer is reported first, whether or not there is anything to score it on.
  expect(await scoreRegexCases(criteria(), null, bytes("5"))).toEqual(zero(ANSWER_SHAPE));
  // One list may be empty.
  expect((await score("^a$", ["a"], [])).score).toBe(100);
  expect((await score("^a$", [], ["b"])).score).toBe(100);
});

test("partial_cases_round", async () => {
  expect((await withCases(2, 1)).score).toBe(67);
  expect((await withCases(1, 2)).score).toBe(33);
  expect((await withCases(1, 1)).score).toBe(50);
  expect((await withCases(7, 1)).score).toBe(88);
  expect((await withCases(0, 3)).score).toBe(0);
  expect((await withCases(3, 0)).score).toBe(100);
});

test("one_failed_case_never_scores_100", async () => {
  // One failure in 200 is 99.5, and rounds to 100: a pass mark of 100 would be met by a regex
  // that gets a case wrong (ruling P05-R3).
  const result = await withCases(199, 1);
  expect(result.score).toBe(99);
  expect(result.passed).toBe(false);
  expect(result.reasons).toEqual(['should match "b"']);

  expect((await withCases(1_999, 1)).score).toBe(99);
  expect((await withCases(200, 0)).score).toBe(100);

  // The pass mark is still the criteria's.
  const lenient = await scoreRegexCases(
    criteria({}, 99),
    heldout([...Array.from({ length: 199 }, () => "a"), "b"], []),
    answer("^a$"),
  );
  expect(lenient).toMatchObject({ score: 99, passed: true });
  // And so is a score of 0 against a pass mark of 0.
  expect(await scoreRegexCases(criteria({}, 0), heldout(["b"], []), answer("^a$"))).toMatchObject({
    score: 0,
    passed: true,
  });
});

test("reasons_name_the_first_three_failed_cases", async () => {
  // Fails "b1", "b2" (should match) and the two "a" (should not): four failures, three shown,
  // the cases that should match first, each list in order.
  const result = await score("^a$", ["b1", "a", "b2"], ["a", "z", "a"]);
  expect(result).toEqual({
    score: 33,
    passed: false,
    reasons: ['should match "b1"', 'should match "b2"', 'should not match "a"'],
  });
});

test("reasons_cut_and_escape_the_case", async () => {
  // Cut to 60 characters, whole code points: no half of a surrogate pair is left behind.
  expect((await score("^a$", ["x".repeat(100)], [])).reasons).toEqual([
    `should match "${"x".repeat(60)}"`,
  ]);
  expect((await score("^a$", ["x".repeat(60)], [])).reasons).toEqual([
    `should match "${"x".repeat(60)}"`,
  ]);
  expect((await score("^a$", [GRINNING_FACE.repeat(100)], [])).reasons).toEqual([
    `should match "${GRINNING_FACE.repeat(60)}"`,
  ]);

  // Each reason is one line, whatever the case holds: the case is written as a JSON string, so
  // a quote, a backslash, a line break or a lone surrogate is an escape and not the character.
  // (The empty pattern matches everything, so all three of these fail.)
  expect((await score("", [], ['a"b\\c\nd\u0000', LONE_SURROGATE, "tab\t"])).reasons).toEqual([
    'should not match "a\\"b\\\\c\\nd\\u0000"',
    'should not match "\\ud800"',
    'should not match "tab\\t"',
  ]);
});

test("cases_reach_the_sandbox_only_as_json", async () => {
  const pattern = '"); throw new Error("injected"); ("';
  const trouble = `\`\${globalThis}\`${LINE_SEPARATOR}${PARAGRAPH_SEPARATOR}"\\'\n</script>`;
  const noMatch = `${trouble}x`;
  vi.mocked(runInSandbox).mockClear();

  await scoreRegexCases(criteria(), heldout([trouble], [noMatch]), answer(pattern, "i"));

  expect(vi.mocked(runInSandbox)).toHaveBeenCalledTimes(1);
  const [code, limits] = vi.mocked(runInSandbox).mock.calls[0] ?? [];
  expect(code).toBe(
    `const re=new RegExp(${JSON.stringify(pattern)},"i");` +
      `[${JSON.stringify([trouble])}.map(s=>re.test(s)),${JSON.stringify([noMatch])}.map(s=>!re.test(s))]`,
  );
  // Two seconds and 32 MiB.
  expect(limits).toEqual({ timeoutMs: 2_000, memoryBytes: 32 * 1024 * 1024 });
});

test("cases_arrive_in_the_sandbox_exactly", async () => {
  // Strings that would break out of a quoted string, end a line, or lose a character on the way
  // into the engine. The pattern is the string itself, escaped, so a single changed character
  // anywhere on the way in makes it fail.
  const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const strings = [
    '"); throw new Error("injected"); ("',
    "'); throw 1; ('",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a string that looks like a template is the point
    "`${globalThis.x = 1}`",
    "\\",
    '\\"',
    "line\nbreak\r\n",
    `${LINE_SEPARATOR}${PARAGRAPH_SEPARATOR}`,
    "</script><!--",
    "nul\u0000nul",
    `lone${LONE_SURROGATE}surrogate`,
    GRINNING_FACE,
    "é",
    "",
  ];
  for (const text of strings) {
    expect(await score(`^${escapeRegex(text)}$`, [text], [`${text}x`, `x${text}`]), text).toEqual({
      score: 100,
      passed: true,
      reasons: [],
    });
  }
  // And the same strings as one list: nothing leaked from one case into the next.
  expect(await score("^.*$", strings, [], "s")).toEqual({ score: 100, passed: true, reasons: [] });
});

test("sandbox_answer_is_checked", async () => {
  const unexpected = zero("sandbox returned an unexpected value");
  // One case on each side, so a good answer is two arrays of one boolean.
  const wrong: unknown[] = [
    "oops",
    null,
    undefined,
    42,
    [],
    [[true]],
    [[true], [true], [true]],
    [[true, true], [true]],
    [[true], []],
    [[], []],
    [[1], [true]],
    [["true"], [true]],
    [[true], [null]],
    [[true], [undefined]],
    { 0: [true], 1: [true], length: 2 },
    [[true], { 0: true, length: 1 }],
    [[[true]], [true]],
  ];
  for (const value of wrong) {
    vi.mocked(runInSandbox).mockResolvedValueOnce({ ok: true, value });
    expect(await score("a", ["a"], ["b"]), JSON.stringify(value)).toEqual(unexpected);
  }

  // The same answer, well formed, is read as it should be.
  vi.mocked(runInSandbox).mockResolvedValueOnce({ ok: true, value: [[true], [false]] });
  expect(await score("a", ["a"], ["a"])).toEqual({
    score: 50,
    passed: false,
    reasons: ['should not match "a"'],
  });
});

test("out_of_memory_is_named", async () => {
  // The engine runs out of memory while it runs this regex. It says so with a message of its own
  // ("out of memory in regexp execution"), and the reason must still be the one for memory.
  expect(await score("(?:|){2147483647}", ["x"], [])).toEqual(zero("ran out of memory"));
});

test("a_sandbox_that_cannot_start_makes_the_scorer_unavailable", async () => {
  // The engine cannot be loaded: that is the Judge's trouble, not the entry's. The regex scorer
  // rejects, and `scoreEntry`, which every scorer the Judge runs goes through, says why with
  // `ScorerUnavailableError`, so that the task is judged again later and no entry scores 0 for it.
  // The next run has an engine.
  vi.mocked(runInSandbox).mockRejectedValueOnce(new Error("the engine could not be loaded"));
  const input = { criteria: criteria({ match: ["a"] }), heldout: null, content: answer("^a$") };
  await expect(scoreEntry(input)).rejects.toBeInstanceOf(ScorerUnavailableError);
  expect(await scoreEntry(input)).toEqual({ score: 100, passed: true, reasons: [] });
});

test("sandbox_failures_become_reasons", async () => {
  const fail = (error: "timeout" | "memory" | "exception", message: string) =>
    vi.mocked(runInSandbox).mockResolvedValueOnce({ ok: false, error, message });
  const reasonFor = async () => (await score("a", ["a"], ["b"])).reasons;

  fail("timeout", "InternalError: interrupted");
  expect(await reasonFor()).toEqual(["timed out (likely catastrophic backtracking)"]);
  fail("memory", "InternalError: out of memory in regexp execution");
  expect(await reasonFor()).toEqual(["ran out of memory"]);

  // A SyntaxError is the pattern's fault. Any other exception is the evaluation's.
  fail("exception", "SyntaxError: nothing to repeat");
  expect(await reasonFor()).toEqual(["invalid pattern"]);
  fail("exception", "SyntaxError: ");
  expect(await reasonFor()).toEqual(["invalid pattern"]);
  for (const message of [
    "InternalError: stack overflow",
    "RangeError: Maximum call stack size exceeded",
    "RuntimeError: Aborted(Assertion failed)",
    "TypeError: not a function",
    "NotASyntaxError: x",
    "threw 1",
    " SyntaxError: x",
    "",
  ]) {
    fail("exception", message);
    expect(await reasonFor(), message).toEqual(["regex evaluation failed"]);
  }

  // A failure scores 0 and is judged against the criteria's pass mark like any other score.
  fail("timeout", "InternalError: interrupted");
  expect(await scoreRegexCases(criteria({}, 0), heldout(["a"], []), answer("a"))).toMatchObject({
    score: 0,
    passed: true,
  });
});

seedTest("entries_score_independently", { timeout: 10_000 }, async () => {
  const { c, h, solution, weak } = nearAccountSeed();

  // Scored together, as the Judge will. Each entry gets a runtime and a budget of its own, so a
  // slow or broken entry cannot change what its neighbours score. It can delay them, since the
  // engine runs on this thread.
  const results = await Promise.all([
    scoreRegexCases(c, h, solution),
    scoreRegexCases(c, h, answer("^(a+)+$")),
    scoreRegexCases(c, h, weak),
    scoreRegexCases(c, h, answer("(")),
    scoreRegexCases(c, h, solution),
  ]);
  expect(results.map((result) => result.score)).toEqual([100, 0, expect.any(Number), 0, 100]);
  // The weak answer's score follows from the seed's held-out cases, so only its range is fixed.
  expect(results[2]?.score).toBeGreaterThan(0);
  expect(results[2]?.score).toBeLessThan(100);
  expect(results[2]?.passed).toBe(false);
  expect(results[1]?.reasons).toEqual(["timed out (likely catastrophic backtracking)"]);
  expect(results[3]?.reasons).toEqual(["invalid pattern"]);
});
