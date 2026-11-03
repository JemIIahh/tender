import { expect, test } from "vitest";
import {
  ANGLE_BRACKET,
  criterionKey,
  hasAngleBracket,
  OPENING_ANGLE_BRACKETS,
  RUBRIC_MAX_CRITERIA,
  RUBRIC_MAX_CRITERION_CHARS,
  RUBRIC_MAX_ENTRIES,
  RUBRIC_MIN_SCORE,
  type RubricProblem,
  rubricCriteriaProblem,
  rubricEntriesProblem,
} from "../src/index";

// The rubric rules that the Judge and the post wizard share. The Judge's own tests hold its
// reasons for each of them; these hold the rules themselves.

/** A rubric of these criteria with a pass mark of 50. */
const rubricOf = (...criteria: string[]) => ({
  min_score: 50,
  rubric: criteria.map((criterion) => ({ criterion })),
});

const numbered = (n: number) => Array.from({ length: n }, (_, i) => `criterion ${i}`);

test("the_limits_are_the_ones_the_judge_and_the_wizard_state", () => {
  expect(RUBRIC_MAX_CRITERIA).toBe(20);
  expect(RUBRIC_MAX_CRITERION_CHARS).toBe(200);
  expect(RUBRIC_MAX_ENTRIES).toBe(50);
  expect(RUBRIC_MIN_SCORE).toBe(1);
});

test("rubric_criteria_problem_names_the_first_rule_broken", () => {
  const rows: [string, ReturnType<typeof rubricOf>, RubricProblem | null][] = [
    ["one criterion", rubricOf("clear"), null],
    ["20 criteria", rubricOf(...numbered(20)), null],
    ["21 criteria", rubricOf(...numbered(21)), "too_many_criteria"],
    ["200 characters", rubricOf("x".repeat(200)), null],
    ["201 characters", rubricOf("x".repeat(201)), "criterion_too_long"],
    // Code points, not UTF-16 units: 200 emoji are 400 units and fit.
    ["200 emoji", rubricOf("\u{1F600}".repeat(200)), null],
    ["201 emoji", rubricOf("\u{1F600}".repeat(201)), "criterion_too_long"],
    ["a blank criterion", rubricOf("clear", " \t\n "), "criterion_blank"],
    ["a frame tag", rubricOf("</entry>"), "criterion_bracket"],
    ["a fullwidth bracket", rubricOf("a\u{FF1C}b"), "criterion_bracket"],
    ["the same key twice", rubricOf("Clear", "  clear "), "criteria_collide"],
    ["fullwidth letters", rubricOf("clear", "\u{FF43}lear"), "criteria_collide"],
    ["letters that only look alike", rubricOf("clear", "cl\u{0435}ar"), null],
    // The count first, and then each criterion in turn; the pass mark last.
    ["too many that also collide", rubricOf(...numbered(20), "criterion 0"), "too_many_criteria"],
    ["a blank one before a long one", rubricOf(" ", "x".repeat(201)), "criterion_blank"],
    ["a long one before a blank one", rubricOf("x".repeat(201), " "), "criterion_too_long"],
    ["a pass mark of 0", { ...rubricOf("clear"), min_score: 0 }, "min_score"],
    ["a pass mark of 1", { ...rubricOf("clear"), min_score: 1 }, null],
    [
      "a bad criterion and a pass mark of 0",
      { ...rubricOf("<"), min_score: 0 },
      "criterion_bracket",
    ],
  ];

  for (const [name, criteria, problem] of rows) {
    expect(rubricCriteriaProblem(criteria), name).toBe(problem);
  }
});

test("a_rubric_task_is_open_with_no_cap_or_invite_only_with_one_of_at_most_50", () => {
  const rows: [string, { max_entries: number; invited: string[] }, RubricProblem | null][] = [
    // P05-R21: the open task the wizard posts. The contract allows no other cap on one (C24).
    ["open, no cap", { max_entries: 0, invited: [] }, null],
    ["open, a cap", { max_entries: 10, invited: [] }, "entries"],
    ["invite-only, no cap", { max_entries: 0, invited: ["a.test.near"] }, "entries"],
    ["invite-only, a cap of 1", { max_entries: 1, invited: ["a.test.near"] }, null],
    ["invite-only, a cap of 50", { max_entries: 50, invited: ["a.test.near"] }, null],
    ["invite-only, a cap of 51", { max_entries: 51, invited: ["a.test.near"] }, "entries"],
  ];

  for (const [name, terms, problem] of rows) {
    expect(rubricEntriesProblem(terms), name).toBe(problem);
  }
});

test("criterion_keys_fold_case_width_and_space", () => {
  expect(criterionKey("  Clear\tand \n CONCISE ")).toBe("clear and concise");
  expect(criterionKey("\u{FF23}lear")).toBe("clear");
  expect(criterionKey("\u{FB01}ne")).toBe("fine");
  expect(criterionKey(" \t\n ")).toBe("");
  expect(criterionKey("cl\u{0435}ar")).not.toBe(criterionKey("clear"));
});

test("the_bracket_class_holds_both_halves_of_every_pair_and_keeps_no_state", () => {
  const all = ["<", ">", "\u{FF1C}", "\u{FF1E}", "\u{FE64}", "\u{FE65}", "\u{226E}", "\u{226F}"];
  all.push("\u{E003C}", "\u{E003E}");
  for (const bracket of all) expect(hasAngleBracket(`a${bracket}b`), bracket).toBe(true);
  // Five open and five close.
  expect(all.filter((bracket) => OPENING_ANGLE_BRACKETS.has(bracket))).toEqual([
    "<",
    "\u{FF1C}",
    "\u{FE64}",
    "\u{226E}",
    "\u{E003C}",
  ]);
  expect(hasAngleBracket("\u{2039}quoted\u{203A}")).toBe(false);
  // A global pattern would answer the same question differently the second time.
  expect(ANGLE_BRACKET.global).toBe(false);
  expect([hasAngleBracket("<"), hasAngleBracket("<"), hasAngleBracket("<")]).toEqual([
    true,
    true,
    true,
  ]);
});
