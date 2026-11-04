import { expect, test } from "vitest";
import {
  BoardTextSchema,
  BriefSchema,
  CreateServiceRequestSchema,
  canonicalJson,
  HIRE_REQUEST_MAX_CHARS,
  HIRER_ACCEPTS_CRITERIA,
  type HiredService,
  hireDocuments,
  hireTerms,
  PublicCriteriaSchema,
  rubricCriteriaProblem,
  serviceTermsProblem,
  sha256Hex,
  UpdateServiceRequestSchema,
} from "../src/index";

// The rules of a service and of a hire, which the API, the MCP server and the web app all take
// from here, so that each makes the same documents and refuses the same terms.

const SERVICE: HiredService = {
  id: "7",
  provider: "acme.near",
  agent: "writer.acme.near",
  title: "Summarise a filing",
  description: "Reads a public filing and returns a plain summary.",
  tags: ["research"],
  category: "research",
  output_format: "text",
  token: "usdc.near",
  price: "2500000",
  commit_secs: 600,
  reveal_secs: 300,
  pick_secs: 900,
  verification: { kind: "hirer" },
};

test("the_hirer_accepts_criteria_are_valid_public_criteria_with_one_point", () => {
  expect(PublicCriteriaSchema.parse(HIRER_ACCEPTS_CRITERIA)).toEqual(HIRER_ACCEPTS_CRITERIA);
  if (HIRER_ACCEPTS_CRITERIA.kind !== "rubric") throw new Error("a rubric");
  expect(rubricCriteriaProblem(HIRER_ACCEPTS_CRITERIA)).toBeNull();
});

test("a_hire_brief_is_the_request_then_the_reference_and_the_same_bytes_each_time", () => {
  const request = "  Summarise Example Corp's 2026 filing.\n";
  const one = hireDocuments(SERVICE, request);
  const two = hireDocuments(SERVICE, request.trim());
  expect(one.briefHash).toBe(two.briefHash);
  expect(one.briefHash).toBe(sha256Hex(canonicalJson(one.brief)));
  expect(BriefSchema.parse(one.brief)).toEqual(one.brief);
  expect(one.brief).toMatchObject({
    version: 1,
    title: "Hire: Summarise a filing",
    category: "research",
    tags: ["research"],
    output: { format: "text", max_bytes: 262_144 },
  });
  expect(one.brief.instructions.startsWith("Summarise Example Corp's 2026 filing.\n\n---\n")).toBe(
    true,
  );
  expect(one.brief.instructions).toContain(
    'This task hires service 7 on Tender, "Summarise a filing"',
  );
  expect(one.brief.instructions).toContain("offered by writer.acme.near (provider acme.near)");
  expect(one.criteria).toEqual(HIRER_ACCEPTS_CRITERIA);
  expect(one.criteriaHash).toBe(sha256Hex(canonicalJson(HIRER_ACCEPTS_CRITERIA)));

  // The longest request and the longest description fit the brief's instructions.
  const longest = hireDocuments(
    {
      ...SERVICE,
      title: "t".repeat(80),
      description: "d".repeat(1000),
      agent: `${"a".repeat(54)}.acme.near`,
    },
    "r".repeat(HIRE_REQUEST_MAX_CHARS),
  );
  expect(longest.brief.instructions.length).toBeLessThan(8000);
  expect(() => hireDocuments(SERVICE, "r".repeat(HIRE_REQUEST_MAX_CHARS + 1))).toThrow();
  expect(() => hireDocuments(SERVICE, "hidden​words")).toThrow(/U\+200B/);
});

test("a_judge_checked_hire_carries_the_services_criteria_and_names_the_judge", () => {
  const criteria = {
    version: 1 as const,
    kind: "regex_cases" as const,
    min_score: 100,
    split: "winner_take_all" as const,
    has_heldout: false,
    examples: { match: ["a"], no_match: ["b"] },
  };
  const judged: HiredService = {
    ...SERVICE,
    output_format: "regex_json",
    verification: { kind: "judge", criteria, criteria_hash: sha256Hex(canonicalJson(criteria)) },
  };
  expect(hireDocuments(judged, "x").criteriaHash).toBe(sha256Hex(canonicalJson(criteria)));
  expect(hireTerms(judged, "judge.near")).toEqual({
    token: "usdc.near",
    reward: 2_500_000n,
    verifier: "judge.near",
    invited: ["writer.acme.near"],
    maxEntries: 1,
    maxWinners: 1,
    commitSecs: 600,
    revealSecs: 300,
    pickSecs: 900,
    fallbackSecs: 900,
  });
  expect(() => hireTerms(judged, null)).toThrow(RangeError);
  expect(hireTerms(SERVICE, null).verifier).toBeUndefined();
});

test("the_rules_that_span_fields", () => {
  const judge = (criteria: object, output_format = "regex_json") =>
    serviceTermsProblem({
      output_format: output_format as "regex_json",
      verification: { kind: "judge", criteria: PublicCriteriaSchema.parse(criteria) },
    });
  const regex = {
    version: 1,
    kind: "regex_cases",
    min_score: 100,
    split: "winner_take_all",
    has_heldout: false,
    examples: { match: ["a"], no_match: [] },
  };
  expect(judge(regex)).toBeNull();
  expect(judge({ ...regex, has_heldout: true })).toMatch(/has_heldout must be false/);
  expect(judge({ ...regex, split: [5000, 5000] })).toMatch(/winner_take_all/);
  expect(judge({ ...regex, examples: { match: [], no_match: [] } })).toMatch(
    /at least one example/,
  );
  expect(judge(regex, "text")).toMatch(/regex_json/);
  const tests = {
    version: 1,
    kind: "tests",
    min_score: 100,
    split: "winner_take_all",
    has_heldout: false,
    language: "js",
    entry: "solve",
    examples: [{ input: 1, output: 2 }],
  };
  expect(judge(tests, "code_js")).toBeNull();
  expect(judge({ ...tests, examples: [] }, "code_js")).toMatch(/at least one example case/);
  expect(judge(tests, "json")).toMatch(/code_js/);
  const rubric = {
    version: 1,
    kind: "rubric",
    min_score: 50,
    split: "winner_take_all",
    has_heldout: false,
    rubric: [{ criterion: "Clear", weight: 2 }],
  };
  expect(judge(rubric, "text")).toBeNull();
  expect(judge({ ...rubric, rubric: [{ criterion: "<b>", weight: 1 }] }, "text")).toMatch(
    /criterion_bracket/,
  );
  expect(judge(rubric, "regex_json")).toMatch(/text or json/);
  for (const kind of ["exact", "json_schema"]) {
    const criteria =
      kind === "exact"
        ? { ...regex, kind, normalize: [], examples: undefined }
        : { ...regex, kind, schema: { type: "object" }, examples: undefined };
    delete (criteria as { examples?: unknown }).examples;
    expect(judge(criteria, "json"), kind).toMatch(/needs held-out checks/);
  }
  expect(
    serviceTermsProblem({ output_format: "code_js", verification: { kind: "hirer" } }),
  ).toBeNull();
});

test("a_request_body_is_strict_and_an_update_names_something", () => {
  const body = {
    agent: "writer.acme.near",
    title: "Summarise",
    description: "d",
    tags: [],
    category: "other",
    output_format: "text",
    token: "usdc.near",
    price: "1",
    commit_secs: 60,
    reveal_secs: 60,
    pick_secs: 60,
    verification: { kind: "hirer" },
  };
  expect(CreateServiceRequestSchema.safeParse(body).success).toBe(true);
  expect(CreateServiceRequestSchema.safeParse({ ...body, extra: 1 }).success).toBe(false);
  expect(CreateServiceRequestSchema.safeParse({ ...body, commit_secs: 1_209_601 }).success).toBe(
    false,
  );
  expect(
    CreateServiceRequestSchema.safeParse({ ...body, verification: { kind: "poster" } }).success,
  ).toBe(false);
  expect(UpdateServiceRequestSchema.safeParse({}).success).toBe(false);
  expect(UpdateServiceRequestSchema.safeParse({ status: "paused" }).success).toBe(true);
  expect(UpdateServiceRequestSchema.safeParse({ status: "deleted" }).success).toBe(false);
});

test("the_board_text_keeps_its_rules_after_the_factory", () => {
  expect(BoardTextSchema.safeParse("x".repeat(1000)).success).toBe(true);
  const over = BoardTextSchema.safeParse("x".repeat(1001));
  expect(over.success).toBe(false);
  expect(over.error?.issues[0]?.message).toBe("expected at most 1000 characters");
  expect(BoardTextSchema.parse("  hi  ")).toBe("hi");
});
