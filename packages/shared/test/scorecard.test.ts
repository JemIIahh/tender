import { expect, test } from "vitest";
import type { ZodType } from "zod";
import { ScorecardSchema } from "../src/index";

// Any account that a task names as its verifier may publish a scorecard (the poster, a script, a
// person), not only the team's Judge. The Judge writes `tender-judge/1`; another verifier names its
// own software, and none may claim to be the Judge, so the schema asks for a name and no more.

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
    "poster-script/0.2",
    "reviewed by hand",
    "verifier ✓ (rubric v4)",
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
