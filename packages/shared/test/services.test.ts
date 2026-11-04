import { expect, test } from "vitest";
import {
  BoardTextSchema,
  BriefSchema,
  CreateServiceRequestSchema,
  canonicalJson,
  HIRE_REQUEST_MAX_CHARS,
  HIRER_ACCEPTS_CRITERIA,
  HIRER_ACCEPTS_CRITERIA_HASH,
  type HiredService,
  hireCriteriaHash,
  hireDocuments,
  hireeOf,
  hireMismatch,
  hireTerms,
  isHireCriteriaOf,
  isHireTask,
  PublicCriteriaSchema,
  rubricCriteriaProblem,
  type Service,
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
  expect(() => hireDocuments(SERVICE, "hidden\u200bwords")).toThrow(/U\+200B/);
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
    verification: {
      kind: "judge",
      criteria,
      criteria_hash: sha256Hex(canonicalJson(criteria)),
      judge: "judge.near",
    },
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
  // The Judge the hirer knows must be the one the service names, or the agent would not take it.
  expect(() => hireTerms(judged, "another-judge.near")).toThrow(/the Judge here is another-judge/);
  expect(hireTerms(SERVICE, null).verifier).toBeUndefined();
});

test("a_task_is_a_hire_when_it_invites_one_agent_once_with_a_hires_criteria", () => {
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
    verification: {
      kind: "judge",
      criteria,
      criteria_hash: sha256Hex(canonicalJson(criteria)),
      judge: "judge.near",
    },
  };
  // A hire as each kind of service posts it: its terms and its documents' criteria hash.
  const posted = (service: HiredService) => {
    const terms = hireTerms(service, "judge.near");
    return {
      invited: terms.invited,
      max_entries: terms.maxEntries,
      criteria_hash: hireDocuments(service, "a request").criteriaHash,
    };
  };
  const JUDGED_HASH = sha256Hex(canonicalJson(criteria));
  const services = [SERVICE, judged];
  expect(isHireTask(posted(SERVICE), services)).toBe(true);
  // The hirer-accepts criteria are the same for every service, so no listing is needed for them.
  expect(isHireTask(posted(SERVICE), [])).toBe(true);
  expect(isHireTask(posted(judged), services)).toBe(true);
  // A Judge-checked hire is told by its service's criteria, so it needs the listing...
  expect(isHireTask(posted(judged), [SERVICE])).toBe(false);
  // ...of the invited agent: the same criteria on another agent's service make no hire of this one.
  expect(isHireTask(posted(judged), [{ ...judged, agent: "other.near" }])).toBe(false);

  // Pinned to one agent, once: anything else is not a hire, whatever its criteria.
  const hire = posted(SERVICE);
  expect(isHireTask({ ...hire, max_entries: 0 }, services)).toBe(false);
  expect(isHireTask({ ...hire, max_entries: 2 }, services)).toBe(false);
  expect(isHireTask({ ...hire, invited: [] }, services)).toBe(false);
  expect(isHireTask({ ...hire, invited: ["writer.acme.near", "other.near"] }, services)).toBe(
    false,
  );
  // Other criteria: a pinned task, and no hire.
  expect(isHireTask({ ...hire, criteria_hash: "ab".repeat(32) }, services)).toBe(false);
  expect(hireCriteriaHash(SERVICE)).toBe(HIRER_ACCEPTS_CRITERIA_HASH);

  // The shape half of the rule: the one account a task is pinned to, as a hire is, or none.
  expect(hireeOf(hire)).toBe("writer.acme.near");
  expect(hireeOf({ ...hire, max_entries: 0 })).toBeNull();
  expect(hireeOf({ ...hire, max_entries: 2 })).toBeNull();
  expect(hireeOf({ ...hire, invited: [] })).toBeNull();
  expect(hireeOf({ ...hire, invited: ["writer.acme.near", "other.near"] })).toBeNull();

  // The criteria half of the rule, which the agent runner asks of a task that invites its agent.
  expect(isHireCriteriaOf(HIRER_ACCEPTS_CRITERIA_HASH, "anyone.near", [])).toBe(true);
  expect(isHireCriteriaOf(JUDGED_HASH, "writer.acme.near", [judged])).toBe(true);
  expect(isHireCriteriaOf(JUDGED_HASH, "other.near", [judged])).toBe(false);
  expect(isHireCriteriaOf("cd".repeat(32), "writer.acme.near", services)).toBe(false);
});

test("a_hire_matches_a_service_only_on_its_terms", () => {
  const listed: Service = {
    ...SERVICE,
    status: "active",
    available: true,
    is_team: false,
    created_at: "2026-11-04T09:00:00.000Z",
    updated_at: "2026-11-04T09:00:00.000Z",
    agent_record: null,
  };
  const s = 1_000_000_000n;
  const created = 1_793_000_000n * s;
  const task = {
    poster: "hirer.near",
    verifier: "hirer.near",
    token: "usdc.near",
    reward: "2500000",
    criteria_hash: HIRER_ACCEPTS_CRITERIA_HASH,
    created_at: String(created),
    commit_deadline: String(created + 600n * s),
    reveal_deadline: String(created + 900n * s),
    pick_deadline: String(created + 1_800n * s),
  };
  expect(HIRER_ACCEPTS_CRITERIA_HASH).toBe(sha256Hex(canonicalJson(HIRER_ACCEPTS_CRITERIA)));
  expect(hireCriteriaHash(listed)).toBe(HIRER_ACCEPTS_CRITERIA_HASH);
  expect(hireMismatch(task, listed)).toBeNull();
  // More than the price is no mismatch.
  expect(hireMismatch({ ...task, reward: "9000000" }, listed)).toBeNull();
  const cases: Array<[Partial<typeof task>, Partial<Service>, string]> = [
    [{}, { status: "paused" }, "service 7 is paused"],
    [{ criteria_hash: "ab".repeat(32) }, {}, "its criteria are not service 7's"],
    [{ token: "dai.near" }, {}, "it pays in dai.near, and service 7 is priced in usdc.near"],
    [{ verifier: "friend.near" }, {}, "the task names friend.near as its verifier, not its poster"],
    [{ reward: "2499999" }, {}, "it pays 2499999, below the 2500000 that service 7 costs"],
    [
      { commit_deadline: String(created + 599n * s) },
      {},
      "its windows are shorter than service 7's",
    ],
    [
      // The reveal window alone a second short: the commit and pick windows are as listed.
      { reveal_deadline: String(created + 899n * s), pick_deadline: String(created + 1_799n * s) },
      {},
      "its windows are shorter than service 7's",
    ],
    [
      { pick_deadline: String(created + 1_799n * s) },
      {},
      "its windows are shorter than service 7's",
    ],
  ];
  for (const [taskOver, serviceOver, why] of cases) {
    expect(hireMismatch({ ...task, ...taskOver }, { ...listed, ...serviceOver }), why).toContain(
      why,
    );
  }
  // A Judge-checked one: the Judge the API names, and its criteria.
  const judgedHash = "cd".repeat(32);
  const judged: Service = {
    ...listed,
    verification: {
      kind: "judge",
      criteria: HIRER_ACCEPTS_CRITERIA,
      criteria_hash: judgedHash,
      judge: "judge.near",
    },
  };
  const judgedTask = { ...task, criteria_hash: judgedHash, verifier: "judge.near" };
  expect(hireMismatch(judgedTask, judged)).toBeNull();
  expect(hireMismatch({ ...judgedTask, verifier: "hirer.near" }, judged)).toContain(
    "checked by the Judge, and the task names hirer.near",
  );
  expect(
    hireMismatch(judgedTask, {
      ...judged,
      verification: { ...judged.verification, judge: null } as Service["verification"],
    }),
  ).toContain("checked by the Judge");
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
