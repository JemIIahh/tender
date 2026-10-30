import { expect, test } from "vitest";
import type { ZodType } from "zod";
import { isJudgeBranded, ScorecardSchema } from "../src/index";

// Any account that a task names as its verifier may publish a scorecard (the poster, a script, a
// person), not only the team's Judge. The Judge writes `tender-judge/1`; another verifier names its
// own software, and none may claim to be the Judge. The API holds the Judge's name to the Judge's
// account, and `isJudgeBranded` says what that name is. The schema asks for a plain ASCII name, so
// that a look-alike of the Judge's name (another hyphen, a zero-width character) cannot be written.

const HASH = "ab".repeat(32);

/** The dotted paths zod reports for `value`, and nothing when it parses. */
function failures(schema: ZodType, value: unknown): string[] {
  const result = schema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join("."));
}

/** The scorecard of a rubric task that its poster judged by hand, with `software` as its author. */
function scorecard(software: unknown, model: unknown = null): Record<string, unknown> {
  return {
    version: 1,
    task_id: "7",
    verifier: "poster.test.near",
    kind: "rubric",
    criteria_hash: HASH,
    heldout_commitment: null,
    heldout: null,
    tie_break: "score desc, committed_at_block asc, account asc",
    entries: [
      {
        account: "alice.test.near",
        content_hash: HASH,
        uri: "ipfs://alice-work",
        committed_at_block: "42",
        score: 100,
        passed: true,
        reasons: ["covers every point of the brief"],
      },
    ],
    winners: [{ account: "alice.test.near", bps: 10_000 }],
    generated_at: "2026-10-30T12:00:00.000Z",
    judge: { software, model },
  };
}

test("scorecard_accepts_the_judge_and_any_other_named_software", () => {
  for (const software of [
    "tender-judge/1",
    "my-judge/2",
    "poster-script/0.2",
    "reviewed_by_hand",
    "Rubric.v4",
    "A/b_C.9-z",
    "x",
  ]) {
    const card = scorecard(software);
    expect(ScorecardSchema.parse(card), software).toEqual(card);
  }
  // The model stays a string or null, whoever the software is.
  expect(ScorecardSchema.parse(scorecard("poster-script/0.2", "some-model"))).toEqual(
    scorecard("poster-script/0.2", "some-model"),
  );
  expect(failures(ScorecardSchema, scorecard("poster-script/0.2", 4))).toEqual(["judge.model"]);
});

test("scorecard_software_is_a_name_of_one_to_64_characters", () => {
  // The edges: 1 and 64 characters pass, none and 65 do not.
  expect(failures(ScorecardSchema, scorecard("a".repeat(64)))).toEqual([]);
  expect(failures(ScorecardSchema, scorecard(""))).toEqual(["judge.software"]);
  expect(failures(ScorecardSchema, scorecard("a".repeat(65)))).toEqual(["judge.software"]);
  // It is a string, and it is there.
  for (const software of [undefined, null, 1, true, ["tender-judge/1"], { name: "x" }]) {
    expect(failures(ScorecardSchema, scorecard(software)), String(software)).toEqual([
      "judge.software",
    ]);
  }
});

test("scorecard_software_is_ascii_without_spaces", () => {
  // Only letters, digits and `. _ / -` are a name. What follows are names that a reader could take
  // for the Judge's, or that hide in plain sight: none of them parses, whatever the rest says.
  const names: Array<[string, string]> = [
    ["a space", "reviewed by hand"],
    ["a space in the Judge's name", "tender judge/1"],
    ["a leading space", " tender-judge/1"],
    ["a trailing space", "tender-judge/1 "],
    ["a trailing newline", "tender-judge/1\n"],
    ["a tab", "tender-judge\t1"],
    ["a Unicode hyphen (U+2010)", "tender\u{2010}judge/1"],
    ["a non-breaking hyphen (U+2011)", "tender\u{2011}judge/1"],
    ["a minus sign (U+2212)", "tender\u{2212}judge/1"],
    ["a soft hyphen (U+00AD)", "tender\u{00ad}judge/1"],
    ["a zero-width joiner (U+200D)", "tender\u{200d}judge/1"],
    ["a zero-width space (U+200B)", "tender\u{200b}judge/1"],
    ["a byte order mark (U+FEFF)", "\u{feff}tender-judge/1"],
    ["a Cyrillic e (U+0435)", "t\u{0435}nder-judge/1"],
    ["an accented e (U+00E9)", "tend\u{00e9}r-judge/1"],
    ["a full-width digit (U+FF11)", "tender-judge/\u{ff11}"],
    ["an emoji", "judge-\u{1f9d1}"],
    ["punctuation outside the set", "tender:judge@1"],
  ];
  for (const [what, software] of names) {
    expect(failures(ScorecardSchema, scorecard(software)), what).toEqual(["judge.software"]);
  }
});

test("is_judge_branded_is_the_judges_name_in_any_case_and_punctuation", () => {
  // The name of the Judge, however it is cased or joined, and whatever follows it.
  for (const software of [
    "tender-judge/1",
    "Tender_Judge",
    "TENDERJUDGE-x",
    "tenderjudge",
    "tender.judge/2",
    "tender/judge",
    "tender-judge-but-better",
    // Every character that is not a letter or a digit is taken out, wherever it is.
    "t-e-n-d-e-r_j-u-d-g-e",
  ]) {
    expect(isJudgeBranded(software), software).toBe(true);
  }
  for (const software of [
    "my-judge",
    "tender-agent",
    "judge/tender",
    // The brand is how a name starts: the name of somebody else's that holds it is not branded.
    "my-tender-judge/1",
    "tender-jud",
    "tender",
    "",
  ]) {
    expect(isJudgeBranded(software), software).toBe(false);
  }
  // The schema takes none of these, but if one reached the function it would fold away rather
  // than hide the brand: they are not letters or digits.
  for (const software of [
    "tender\u{2010}judge/1",
    "tender\u{200d}judge/1",
    "TENDER\u{00a0}JUDGE",
  ]) {
    expect(isJudgeBranded(software), software).toBe(true);
  }
});
