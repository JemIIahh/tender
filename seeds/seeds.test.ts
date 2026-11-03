import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type EntryScore,
  scoreExact,
  scoreJsonSchema,
  scoreRegexCases,
  scoreRubric,
  scoreTests,
  testsCriteriaProblem,
} from "@tender/judge";
import {
  type Brief,
  BriefSchema,
  canonicalJson,
  type Heldout,
  HeldoutSchema,
  heldoutMatchesCriteria,
  NETWORKS,
  type PublicCriteria,
  PublicCriteriaSchema,
  RUBRIC_MIN_SCORE,
  rubricCriteriaProblem,
  rubricEntriesProblem,
  sha256Hex,
} from "@tender/shared";
import { describe, expect, test } from "vitest";
import { type LlmHandler, startFakeLlm } from "../packages/judge/test/fake-llm";
import {
  heldoutFileOf,
  missingPrivateFiles,
  PRIVATE_DIR_VARIABLE,
  privateDirOf,
  scenariosFileOf,
  solutionFileOf,
} from "../scripts/lib/private-dir";
import { dropOneGrader, STAND_IN, standInGrader, standInScore } from "./rubric-stand-in";

// Every seed task in seeds/<slug>/ is scored by the Judge's own scorers, so that a seed that pays
// nobody (its solution misses the pass mark), pays everybody (its weak answer passes) or gives its
// answer away (a public example is also held out) fails here, before it is posted. Nothing is
// mocked: a regex seed runs in the same QuickJS sandbox that judges a real entry, and so does a
// tests seed. The one kind with a model in it, rubric, is scored by the Judge's own rubric scorer
// against a fake model server that grades by a few plain checks (rubric-stand-in.ts).
//
// The private half of a seed is not in seeds/: its held-out checks are secret until a task is
// judged, and its solution.txt passes those checks by construction, so a copy of it would win the
// task. Both are read from the private directory (`TENDER_SEEDS_PRIVATE_DIR`, else `seeds-private/`,
// see README.md). Where that has no file for a seed, which is every clean checkout and CI, a test
// that has to score the seed's solution or its checks is skipped, with one message at the top of the
// run; the tests that read only the public files (the schemas, the counts, the briefs, the weak
// answers) run everywhere.

const SEEDS_DIR = import.meta.dirname;
const SLUGS = readdirSync(SEEDS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const PRIVATE_DIR = privateDirOf();
/** The seeds that lack their solution, or their held-out checks, in the private directory. */
const MISSING_PRIVATE = missingPrivateFiles(SEEDS_DIR, PRIVATE_DIR, SLUGS);
const PRIVATE_NOTE = `solutions and held-out checks not found in ${PRIVATE_DIR}; set ${PRIVATE_DIR_VARIABLE}`;
if (MISSING_PRIVATE.length > 0) {
  console.warn(
    `seeds: ${PRIVATE_NOTE}. The tests that score a seed's solution or its checks are skipped ` +
      `for ${MISSING_PRIVATE.length} seeds: ${MISSING_PRIVATE.join(", ")}.`,
  );
}

/** The public files of a seed. Its solution and held-out checks are not (see `PRIVATE_DIR`). */
const SEED_FILES = ["task.json", "brief.json", "criteria.json", "weak.txt"];

/** The ten P0 seeds (plan 05, Task 9) and the kind of check each one has. */
const P0_SEEDS: Record<string, PublicCriteria["kind"]> = {
  "near-account-regex": "regex_cases",
  "iso-date-regex": "regex_cases",
  "semver-regex": "regex_cases",
  "invoice-extract": "json_schema",
  "near-receipt-summary": "json_schema",
  "product-table-extract": "json_schema",
  "meeting-actions-extract": "json_schema",
  "sum-of-transfers": "exact",
  "distinct-signers-count": "exact",
  "base58-decoded-length": "exact",
};

/** The twenty P1 seeds (plan 05, Task 11) and the kind of check each one has. */
const P1_SEEDS: Record<string, PublicCriteria["kind"]> = {
  "longest-ok-streak": "exact",
  "mixed-currency-total": "exact",
  "paper-screen-count": "exact",
  "signup-overlap-count": "exact",
  "contacts-clean": "json_schema",
  "changelog-sections": "json_schema",
  "survey-summary": "json_schema",
  "bibliography-parse": "json_schema",
  "ipv4-regex": "regex_cases",
  "hex-color-regex": "regex_cases",
  "duration-regex": "regex_cases",
  "slugify-title": "tests",
  "near-to-yocto": "tests",
  "latest-per-id": "tests",
  "wrap-text": "tests",
  "release-notes-plain": "rubric",
  "plain-terms-rewrite": "rubric",
  "source-conflict-brief": "rubric",
  "incident-summary-plain": "rubric",
  "vendor-pick-memo": "rubric",
};

/** The output format a brief must name for the kinds whose scorer insists on one answer shape. */
const FORMAT_OF_KIND: Partial<Record<PublicCriteria["kind"], string>> = {
  regex_cases: "regex_json",
  json_schema: "json",
  tests: "code_js",
  rubric: "text",
};

/**
 * The values of a json_schema solution that the key does not check, and why each may stay that
 * way. The audit of the keys lets nothing else go unchecked: a wrong value anywhere else must cost
 * the reward, or a wrong answer is paid in full.
 */
const UNCHECKED_VALUES: Record<string, { match: RegExp; why: string }[]> = {
  "meeting-actions-extract": [
    {
      match: /^\$\.actions\[\d+\]\.task$/,
      why: "free text in the solver's own words, as the brief says: an equality check would turn away a good paraphrase, and the owner and the due date carry the facts",
    },
  ],
};

const seedPath = (slug: string, name: string) => join(SEEDS_DIR, slug, name);
const readBytes = (slug: string, name: string): Buffer => readFileSync(seedPath(slug, name));
const readJson = (slug: string, name: string): unknown =>
  JSON.parse(readBytes(slug, name).toString("utf8"));
const heldoutPath = (slug: string) => heldoutFileOf(PRIVATE_DIR, slug);
const solutionPath = (slug: string) => solutionFileOf(PRIVATE_DIR, slug);
const utf8 = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/**
 * The seeds whose key reads the values of a JSON answer by path. This runs when the file is
 * loaded, before any test, so a folder with no criteria.json is named here and not left to a bare
 * ENOENT that stops every test in the file.
 */
const JSON_SCHEMA_SLUGS = SLUGS.filter((slug) => {
  if (!existsSync(seedPath(slug, "criteria.json"))) {
    throw new Error(`seeds/${slug} has no criteria.json, so its kind of check is unknown`);
  }
  return (readJson(slug, "criteria.json") as { kind?: unknown }).kind === "json_schema";
});

/**
 * A seed's public documents, once the schemas have read them, and its private ones from the private
 * directory. `heldout` and `solution` are `null` when that has no file for the seed: `heldout` of a
 * rubric seed always, which has no checks, and both on a machine without the private directory. A
 * test that needs them takes the seed with `loadPrivate`.
 */
function load(slug: string) {
  return {
    brief: BriefSchema.parse(readJson(slug, "brief.json")),
    criteria: PublicCriteriaSchema.parse(readJson(slug, "criteria.json")),
    heldout: existsSync(heldoutPath(slug))
      ? HeldoutSchema.parse(JSON.parse(readFileSync(heldoutPath(slug), "utf8")))
      : null,
    solution: existsSync(solutionPath(slug)) ? readFileSync(solutionPath(slug)) : null,
  };
}

/**
 * `load`, for a test that scores the seed's solution or its held-out checks. It skips the test, as
 * `skip` does, when the private directory lacks the seed's solution or, for a seed with a held-out
 * part, its checks. Pass the `skip` of the test's context.
 */
function loadPrivate(slug: string, skip: (note?: string) => never) {
  const seed = load(slug);
  if (seed.solution === null || (seed.criteria.has_heldout && seed.heldout === null)) {
    skip(PRIVATE_NOTE);
  }
  return { ...seed, solution: seed.solution as Buffer };
}

/**
 * A rubric answer scored as the Judge scores it: by `scoreRubric`, against a fake model server
 * that answers with `handler`. The one entry is the only one graded, so its score is the whole of
 * the result.
 */
async function scoreRubricWith(
  handler: LlmHandler,
  slug: string,
  brief: Brief,
  criteria: Extract<PublicCriteria, { kind: "rubric" }>,
  answer: Uint8Array,
): Promise<EntryScore> {
  const llm = await startFakeLlm(handler);
  const account = "solver.test.near";
  const result = await scoreRubric(criteria, brief, [{ account, text: utf8(answer) }], {
    baseUrl: llm.baseUrl,
    apiKey: "test-key",
    model: "stand-in",
  });
  const score = result.scores.get(account);
  if (result.failClosed || score === undefined) {
    throw new Error(`the Judge could not score ${slug} with the fake grader: ${result.reason}`);
  }
  return score;
}

/** A rubric answer scored by the fake model server that grades by the seed's stand-in checks. */
function scoreRubricAnswer(
  slug: string,
  brief: Brief,
  criteria: Extract<PublicCriteria, { kind: "rubric" }>,
  answer: Uint8Array,
): Promise<EntryScore> {
  return scoreRubricWith(standInGrader(slug, criteria.rubric), slug, brief, criteria, answer);
}

/**
 * `answer` scored as the Judge scores a revealed entry: by the scorer of the criteria's kind, on
 * the held-out document. A regex seed's held-out cases replace its public examples (P05-R4). A
 * rubric seed has no held-out document and needs `seed`, its slug and brief, for the grader.
 */
async function scoreAnswer(
  criteria: PublicCriteria,
  heldout: Heldout | null,
  answer: Uint8Array,
  seed?: { slug: string; brief: Brief },
): Promise<EntryScore> {
  if (criteria.kind === "rubric") {
    if (seed === undefined) throw new Error("scoring a rubric seed needs its slug and brief");
    return scoreRubricAnswer(seed.slug, seed.brief, criteria, answer);
  }
  if (heldout === null) throw new Error(`a "${criteria.kind}" seed has no held-out document`);
  if (criteria.kind === "exact" && "exact" in heldout) {
    return scoreExact(criteria, heldout.exact, answer);
  }
  if (criteria.kind === "json_schema" && "json_schema" in heldout) {
    return scoreJsonSchema(criteria, heldout.json_schema, answer);
  }
  if (criteria.kind === "regex_cases" && "regex_cases" in heldout) {
    return scoreRegexCases(criteria, heldout.regex_cases, answer);
  }
  if (criteria.kind === "tests" && "tests" in heldout) {
    return scoreTests(criteria, heldout.tests, answer);
  }
  throw new Error(
    `seeds.test.ts has no scorer for a "${criteria.kind}" seed with a "${Object.keys(heldout)}" held-out document`,
  );
}

/** Every string and number inside `value`, in however many arrays and objects. Keys are not values. */
function scalarsIn(value: unknown): (string | number)[] {
  if (typeof value === "string" || typeof value === "number") return [value];
  if (Array.isArray(value)) return value.flatMap(scalarsIn);
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(scalarsIn);
  return [];
}

/**
 * The strings of a held-out document that its scorer compares letter for letter: every string in
 * a json_schema assertion, and the answers of an exact task whose criteria do not lowercase. A
 * regex case is a test vector, and the case of a letter is often what it tests.
 */
function caseSensitiveStrings(criteria: PublicCriteria, heldout: Heldout | null): string[] {
  if (heldout === null) return [];
  if ("json_schema" in heldout) {
    return heldout.json_schema.assertions
      .flatMap(({ equals }) => scalarsIn(equals))
      .filter((value) => typeof value === "string");
  }
  if (
    "exact" in heldout &&
    criteria.kind === "exact" &&
    !criteria.normalize.includes("lowercase")
  ) {
    return heldout.exact.expected;
  }
  return [];
}

/**
 * The cases a regex answer gets wrong in V8, the engine of Node and of the browsers. The Judge
 * scores in QuickJS, but a solver tries its pattern in V8 first, so a seed's own solution must
 * mean the same in both. The pattern is the repository's own, so it can run here.
 */
function v8Misses(answer: Uint8Array, cases: { match: string[]; no_match: string[] }): string[] {
  const { pattern, flags } = JSON.parse(utf8(answer)) as { pattern: string; flags?: string };
  const regex = new RegExp(pattern, flags);
  return [
    ...cases.match.filter((s) => !regex.test(s)).map((s) => `should match ${JSON.stringify(s)}`),
    ...cases.no_match
      .filter((s) => regex.test(s))
      .map((s) => `should not match ${JSON.stringify(s)}`),
  ];
}

/**
 * Holds an extract seed to its item count. A held-out assertion reads one path, so a key that
 * asserts an array's items one by one cannot see an item added after the last. The public schema
 * has to fix the count at the solution's, and this shows that it does: with `extra` added at the end
 * of `array`, the solution still scores 100 once the schema's bounds on that array are taken away,
 * and falls under the pass mark with them.
 */
async function expectItemCountFixed(
  slug: string,
  array: string,
  extra: unknown,
  skip: (note?: string) => never,
): Promise<void> {
  const { criteria, heldout, solution } = loadPrivate(slug, skip);
  if (criteria.kind !== "json_schema" || heldout === null || !("json_schema" in heldout)) {
    throw new Error(`${slug} is not a json_schema seed`);
  }
  const answer = JSON.parse(utf8(solution)) as Record<string, unknown>;
  const items = answer[array];
  if (!Array.isArray(items)) throw new Error(`${slug}'s solution has no ${array} array`);

  // The key reaches the solution's last item and no further, so the count it knows is the solution's.
  const reached = heldout.json_schema.assertions.flatMap(({ path }) => {
    const index = new RegExp(`^\\$\\.${array}\\[(\\d+)\\]`).exec(path)?.[1];
    return index === undefined ? [] : [Number(index) + 1];
  });
  expect(Math.max(...reached), "the key's last item is the solution's last").toBe(items.length);

  const properties = criteria.schema.properties as Record<string, Record<string, unknown>>;
  const { minItems, maxItems, ...withoutBounds } = properties[array] ?? {};
  const extended = new TextEncoder().encode(
    JSON.stringify({ ...answer, [array]: [...items, extra] }),
  );

  // Take the bounds away and the schema and the key pay the extended answer in full ...
  const looseCriteria = {
    ...criteria,
    schema: { ...criteria.schema, properties: { ...properties, [array]: withoutBounds } },
  };
  const loose = scoreJsonSchema(looseCriteria, heldout.json_schema, extended);
  expect(loose.score, loose.reasons.join("; ")).toBe(100);

  // ... so the count is all that stands between that answer and the reward.
  expect({ minItems, maxItems }).toEqual({ minItems: items.length, maxItems: items.length });
  const result = await scoreAnswer(criteria, heldout, extended);
  expect(result.score, result.reasons.join("; ")).toBeLessThan(criteria.min_score);
}

/** A key or an index on the way into a JSON document. */
type Step = string | number;

/** The assertion path of the value that `steps` lead to: `$`, then `.key` and `[n]`. */
const pathOf = (steps: Step[]): string =>
  `$${steps.map((step) => (typeof step === "number" ? `[${step}]` : `.${step}`)).join("")}`;

/** Every value of `document` that is not an object or an array, with the steps that lead to it. */
function leavesOf(document: unknown, steps: Step[] = []): { steps: Step[]; value: unknown }[] {
  if (Array.isArray(document) || (typeof document === "object" && document !== null)) {
    const children = Object.entries(document);
    if (children.length === 0) throw new Error(`${pathOf(steps)} is empty, so it has no value`);
    return children.flatMap(([key, child]) =>
      leavesOf(child, [...steps, Array.isArray(document) ? Number(key) : key]),
    );
  }
  return [{ steps, value: document }];
}

/** `document` with the value at `steps` replaced by `value`. */
function replaceAt(document: unknown, steps: Step[], value: unknown): unknown {
  const [step, ...rest] = steps;
  if (step === undefined) return value;
  if (Array.isArray(document)) {
    return document.map((item, i) => (i === step ? replaceAt(item, rest, value) : item));
  }
  const object = document as Record<string, unknown>;
  return { ...object, [step]: replaceAt(object[step], rest, value) };
}

/**
 * Other values for `value`, one change each, the likeliest first: the next number, the other
 * boolean, a date for a null (a deadline the notes do not give), or the string with one digit or
 * letter changed, from the last one back. A schema's patterns and formats let some of these
 * through and not others, so the caller tries them in turn.
 */
function otherValues(value: unknown): unknown[] {
  if (typeof value === "number") return [value + 1, value - 1];
  if (typeof value === "boolean") return [!value];
  if (value === null) return ["2026-01-01", "x"];
  if (typeof value !== "string")
    throw new Error(`no other value to try for ${JSON.stringify(value)}`);
  const chars = [...value];
  const alphabets = ["0123456789", "abcdefghijklmnopqrstuvwxyz", "ABCDEFGHIJKLMNOPQRSTUVWXYZ"];
  return chars
    .map((char, i) =>
      [...(alphabets.find((alphabet) => alphabet.includes(char)) ?? "")]
        .filter((other) => other !== char)
        .map((other) => [...chars.slice(0, i), other, ...chars.slice(i + 1)].join("")),
    )
    .reverse()
    .flat();
}

/** Whether `reason` says that an assertion on the value at `at`, or on one that holds it, failed. */
function refusesValueAt(reason: string, at: string): boolean {
  const asserted = /^(\$\S*) expected /.exec(reason)?.[1];
  return (
    asserted !== undefined &&
    (at === asserted || at.startsWith(`${asserted}.`) || at.startsWith(`${asserted}[`))
  );
}

/**
 * Whether the key notices a wrong value at `steps` of the solution. Other values are tried in turn
 * until the schema lets one through, and then either an assertion on that value refuses the answer
 * (the key checks it) or the answer is paid (it does not).
 */
function keyChecksValueAt(
  criteria: Parameters<typeof scoreJsonSchema>[0],
  key: Parameters<typeof scoreJsonSchema>[1],
  solution: unknown,
  steps: Step[],
  value: unknown,
): boolean {
  const at = pathOf(steps);
  for (const other of otherValues(value)) {
    const bytes = new TextEncoder().encode(JSON.stringify(replaceAt(solution, steps, other)));
    const result = scoreJsonSchema(criteria, key, bytes);
    if (result.score >= criteria.min_score) return false;
    if (result.reasons.some((reason) => refusesValueAt(reason, at))) return true;
  }
  throw new Error(`no other value for ${at} fits the schema, so the key was not tried on it`);
}

const THIRTY_SEEDS = { ...P0_SEEDS, ...P1_SEEDS };

test("the_thirty_seeds_are_all_there", () => {
  expect(Object.keys(P0_SEEDS)).toHaveLength(10);
  expect(Object.keys(P1_SEEDS)).toHaveLength(20);
  expect(Object.keys(THIRTY_SEEDS), "a slug is both a P0 and a P1 seed").toHaveLength(30);

  const missing = Object.keys(THIRTY_SEEDS).filter((slug) => !SLUGS.includes(slug));
  expect(missing, "seeds missing from seeds/").toEqual([]);

  const kinds = Object.fromEntries(
    Object.keys(THIRTY_SEEDS).map((s) => [s, load(s).criteria.kind]),
  );
  expect(kinds).toEqual(THIRTY_SEEDS);

  const lacking = Object.keys(THIRTY_SEEDS).flatMap((slug) =>
    SEED_FILES.filter((name) => !existsSync(seedPath(slug, name))).map((name) => `${slug}/${name}`),
  );
  expect(lacking, "files missing from the seeds").toEqual([]);
  // Nothing but the public files: above all no heldout.json, whose checks are secret until the task
  // is judged, and no solution.txt, which passes them. Both live in the private directory
  // (README.md), never in a folder that git tracks.
  const extra = Object.keys(THIRTY_SEEDS).flatMap((slug) =>
    readdirSync(join(SEEDS_DIR, slug))
      .filter((name) => !SEED_FILES.includes(name))
      .map((name) => `${slug}/${name}`),
  );
  expect(extra, "files in a seed that are not its public files").toEqual([]);
});

test("twenty_five_of_the_thirty_seeds_have_a_held_out_part_and_five_are_rubric_seeds", () => {
  // The counts that do not need the checks themselves: the criteria say which seeds have them.
  const withChecks = Object.keys(THIRTY_SEEDS).filter((slug) => load(slug).criteria.has_heldout);
  expect(withChecks).toHaveLength(25);
  expect(Object.values(THIRTY_SEEDS).filter((kind) => kind === "rubric")).toHaveLength(5);
  expect(withChecks.sort()).toEqual(
    Object.entries(THIRTY_SEEDS)
      .filter(([, kind]) => kind !== "rubric")
      .map(([slug]) => slug)
      .sort(),
  );
});

test("the_private_directory_holds_every_solution_and_held_out_file_or_none", () => {
  // Some but not all would skip the tests of the seeds that lack one without a word to say so. A
  // directory that is not there, or holds none, is the clean checkout, which skips them all.
  const complete = SLUGS.filter((slug) => !MISSING_PRIVATE.includes(slug));
  expect(
    complete.length === 0 || MISSING_PRIVATE.length === 0,
    `${PRIVATE_DIR} lacks the solution or the held-out checks of ${MISSING_PRIVATE.join(", ")}`,
  ).toBe(true);
});

test("the_twenty_p1_seeds_cover_five_kinds_and_the_research_data_and_writing_categories", () => {
  const kinds = Object.values(P1_SEEDS);
  const countOf = (kind: PublicCriteria["kind"]) => kinds.filter((k) => k === kind).length;
  // Plan 05, Task 11: at least 4 rubric seeds, at least 3 tests seeds (Task 6 passed), the rest
  // spread over the P0 kinds.
  expect(countOf("rubric"), "rubric seeds").toBeGreaterThanOrEqual(4);
  expect(countOf("tests"), "tests seeds").toBeGreaterThanOrEqual(3);
  for (const kind of ["exact", "json_schema", "regex_cases"] as const) {
    expect(countOf(kind), `${kind} seeds`).toBeGreaterThanOrEqual(3);
  }

  const categories = Object.keys(P1_SEEDS).map((slug) => load(slug).brief.category);
  for (const category of ["research", "data", "writing"] as const) {
    expect(
      categories.filter((c) => c === category).length,
      `${category} seeds`,
    ).toBeGreaterThanOrEqual(3);
  }
});

test("every_brief_has_its_own_hash", () => {
  // The offline solver finds a seed's answer by the hash of its brief, so no two may share one.
  const hashes = SLUGS.map((slug) => sha256Hex(canonicalJson(readJson(slug, "brief.json"))));
  expect(new Set(hashes).size).toBe(SLUGS.length);
});

describe.each(SLUGS)("seed %s", (slug) => {
  test("documents_follow_the_schemas", () => {
    const { criteria, heldout } = load(slug);

    if (criteria.kind === "rubric") {
      // A model scores it against the public criteria: no key, so no held-out part.
      expect(criteria.has_heldout, "has_heldout").toBe(false);
      expect(heldout, "a rubric seed has no heldout.json").toBeNull();
      // The rules of @tender/shared, which the Judge turns a rubric task away at intake for
      // breaking: at most 20 criteria of at most 200 characters, no angle brackets, none alike.
      expect(rubricCriteriaProblem(criteria), "rubric rules").toBeNull();
      // Seeds are posted open to anyone, so they are an open task: no cap on entries, no invites.
      expect(rubricEntriesProblem({ max_entries: 0, invited: [] }), "entry terms").toBeNull();
      // A pass mark a model can reach. 100 would need ten out of ten on every criterion, and
      // under the minimum a disqualified entry (a score of 0) would pass.
      expect(criteria.min_score, "min_score").toBeGreaterThanOrEqual(RUBRIC_MIN_SCORE);
      expect(criteria.min_score, "min_score").toBeLessThan(100);
      return;
    }

    expect(criteria.has_heldout, "has_heldout").toBe(true);
    // Every brief says the reward goes only to a perfect answer, and the known-wrong regexes
    // below are refused on that pass mark alone: lower it and a near-miss is paid.
    expect(criteria.min_score, "min_score").toBe(100);
    if (criteria.kind === "tests") {
      expect(testsCriteriaProblem(criteria), "tests rules").toBeNull();
    }
  });

  test("held_out_document_is_of_the_criterias_kind", ({ skip }) => {
    const { criteria, heldout } = loadPrivate(slug, skip);
    if (!criteria.has_heldout) return;
    expect(
      heldout !== null && heldoutMatchesCriteria(criteria, heldout),
      "held-out kind is the criteria's",
    ).toBe(true);
  });

  test("task_terms_are_in_range", () => {
    const task = readJson(slug, "task.json") as Record<string, unknown>;

    expect(Object.keys(task).sort()).toEqual([
      "commit_secs",
      "fallback_secs",
      "max_winners",
      "pick_secs",
      "reveal_secs",
      "reward",
      "token",
      "verifier",
    ]);
    expect(["usdc", "tusdc"]).toContain(task.token);
    expect(["judge", "poster"]).toContain(task.verifier);

    // Token units with two decimals, from 0.25 to 2.00: counted in hundredths, not as a float.
    expect(task.reward).toMatch(/^\d\.\d{2}$/);
    const hundredths = Number(String(task.reward).replace(".", ""));
    expect(hundredths).toBeGreaterThanOrEqual(25);
    expect(hundredths).toBeLessThanOrEqual(200);

    // The windows are sized for testnet, whose contract accepts none shorter than a minute.
    for (const window of ["commit_secs", "reveal_secs", "pick_secs", "fallback_secs"]) {
      expect(Number.isInteger(task[window]), window).toBe(true);
      expect(task[window] as number, window).toBeGreaterThanOrEqual(NETWORKS.testnet.minWindowSecs);
    }
    // `post_task` takes 1 to 5 winners.
    expect(Number.isInteger(task.max_winners), "max_winners").toBe(true);
    expect(task.max_winners as number).toBeGreaterThanOrEqual(1);
    expect(task.max_winners as number).toBeLessThanOrEqual(5);
  });

  test("solution_passes_its_held_out_checks", async ({ skip }) => {
    const { brief, criteria, heldout, solution } = loadPrivate(slug, skip);

    const result = await scoreAnswer(criteria, heldout, solution, { slug, brief });
    expect(result.score, result.reasons.join("; ")).toBeGreaterThanOrEqual(criteria.min_score);
    expect(result.passed).toBe(true);

    if (criteria.kind === "regex_cases" && heldout !== null && "regex_cases" in heldout) {
      expect(v8Misses(solution, heldout.regex_cases), "cases wrong in V8").toEqual([]);
      // The published examples are cases too, and a solution that fails them contradicts the task.
      const onExamples = await scoreRegexCases(criteria, null, solution);
      expect(onExamples.score, onExamples.reasons.join("; ")).toBeGreaterThanOrEqual(
        criteria.min_score,
      );
    }
  });

  test("weak_answer_scores_below_the_solution", async ({ skip }) => {
    if (!existsSync(seedPath(slug, "weak.txt"))) return skip("this seed has no weak answer");
    const { brief, criteria, heldout, solution } = loadPrivate(slug, skip);

    const best = await scoreAnswer(criteria, heldout, solution, { slug, brief });
    const weak = await scoreAnswer(criteria, heldout, readBytes(slug, "weak.txt"), { slug, brief });
    expect(weak.score).toBeLessThan(best.score);
    // A weak answer is meant to lose. If it passed, a task with only that entry would pay it.
    expect(weak.passed, "weak answer passes").toBe(false);
    // It is also meant to show partial credit, which only a kind with scores between 0 and 100
    // can give. An answer the schema turns away, or a pattern that fails to compile, scores 0 and
    // shows the scorecard no more than an empty entry does.
    if (criteria.kind !== "exact") {
      expect(weak.score, `weak answer's score (${weak.reasons.join("; ")})`).toBeGreaterThan(0);
    }
  });

  test("answers_fit_the_briefs_output_rules", () => {
    const { brief, criteria } = load(slug);

    const format = FORMAT_OF_KIND[criteria.kind];
    if (format !== undefined) expect(brief.output.format).toBe(format);
    if (existsSync(seedPath(slug, "weak.txt"))) {
      expect(readBytes(slug, "weak.txt").byteLength, "weak.txt bytes").toBeLessThanOrEqual(
        brief.output.max_bytes,
      );
    }
  });

  test("the_solution_fits_the_briefs_output_rules", ({ skip }) => {
    const { brief, solution } = loadPrivate(slug, skip);
    expect(solution.byteLength, "solution.txt bytes").toBeLessThanOrEqual(brief.output.max_bytes);
  });

  test("public_examples_are_not_held_out", ({ skip }) => {
    const { brief, criteria, heldout } = loadPrivate(slug, skip);

    if (heldout === null) return;

    if (criteria.kind === "regex_cases" && "regex_cases" in heldout) {
      const hidden = [...heldout.regex_cases.match, ...heldout.regex_cases.no_match];
      const shown = [...criteria.examples.match, ...criteria.examples.no_match];
      expect(
        shown.filter((example) => hidden.includes(example)),
        "published examples that are also held out",
      ).toEqual([]);
      // A string held out twice counts twice in the score, and one on both lists can never be
      // got right.
      expect(
        hidden.filter((held, i) => hidden.indexOf(held) !== i),
        "held-out strings listed twice",
      ).toEqual([]);
    }

    if (criteria.kind === "tests" && "tests" in heldout) {
      // The published cases are a sample to try the function on. A case that is also held out
      // counts twice in the score and tells the solver a part of the key.
      const shown = criteria.examples.map(({ input }) => JSON.stringify(input));
      const hidden = heldout.tests.cases.map(({ input }) => JSON.stringify(input));
      expect(
        shown.filter((example) => hidden.includes(example)),
        "published cases that are also held out",
      ).toEqual([]);
      expect(
        hidden.filter((held, i) => hidden.indexOf(held) !== i),
        "held-out cases listed twice",
      ).toEqual([]);
    }

    if (criteria.kind === "exact" && "exact" in heldout) {
      // An exact task has no examples of its own, but its brief shows a sample answer to fix the
      // format ("for example 4,9"). That sample must not be the answer. The data block after
      // BEGIN DATA is the question, not an example.
      const squash = (text: string) => text.toLowerCase().replace(/\s+/g, " ");
      const prose = brief.instructions.split("-----BEGIN DATA-----")[0] ?? "";
      const exampleLines = prose.split("\n").filter((line) => /\bexamples?\b/i.test(line));
      expect(
        exampleLines.filter((line) =>
          heldout.exact.expected.some((answer) => squash(line).includes(squash(answer.trim()))),
        ),
        "example lines in the brief that show a held-out answer",
      ).toEqual([]);
    }

    if (criteria.kind === "json_schema" && "json_schema" in heldout) {
      // A json_schema task publishes a schema and no examples, but its brief explains the rules
      // with values of its own ("8,000.50 naira is [redacted] kobo"), and one of them can be a value
      // the key holds. Nothing the key asserts may be shown in the words above the data block: the
      // data is the question. Short values are left out, as they turn up in any text ("Ada" in
      // "adapt", 2 in "2 decimals"): a string of 4 characters or more, a number of 4 digits or more.
      const prose = [
        brief.title,
        brief.summary,
        brief.instructions.split("-----BEGIN DATA-----")[0] ?? "",
      ].join("\n");
      const text = prose.toLowerCase();
      // "8,000.50" is the number 8000.5: thousands commas go, and every other number is read whole.
      const shown = new Set(
        (prose.replace(/(\d),(?=\d{3}\b)/g, "$1").match(/\d+(?:\.\d+)?/g) ?? []).map(Number),
      );
      const held = heldout.json_schema.assertions.flatMap(({ equals }) => scalarsIn(equals));
      expect(
        held.filter((value) =>
          typeof value === "string"
            ? value.length >= 4 && text.includes(value.toLowerCase())
            : String(value).replace(/\D/g, "").length >= 4 && shown.has(value),
        ),
        "held-out values that the brief shows above the data",
      ).toEqual([]);
    }
  });

  test("held_out_strings_keep_the_briefs_letter_case", ({ skip }) => {
    const { brief, criteria, heldout } = loadPrivate(slug, skip);

    // An agent echoes the brief's wording. If the brief prints "ACME LTD" and the key expects
    // "Acme Ltd", a correct copy is marked wrong, and nothing in the brief says how to avoid it.
    // A string that the brief does not contain in any case (a date worked out, a total) is fine.
    const text = [brief.title, brief.summary, brief.instructions].join("\n");
    expect(
      caseSensitiveStrings(criteria, heldout).filter(
        (held) => !text.includes(held) && text.toLowerCase().includes(held.toLowerCase()),
      ),
      "held-out strings that the brief spells in another letter case",
    ).toEqual([]);
  });

  test("the_documents_claim_nothing_the_protocol_does_not_do", () => {
    // Tender does not claim to be trustless, provably fair or private, so neither may a seed's
    // brief or criteria, which are what an agent or a judge reads first.
    const { brief, criteria } = load(slug);
    const words = [
      brief.title,
      brief.summary,
      brief.instructions,
      ...(criteria.kind === "rubric" ? criteria.rubric.map(({ criterion }) => criterion) : []),
    ].join("\n");
    expect(words).not.toMatch(/trustless|provably fair|private/i);
  });

  test("documents_round_trip_as_canonical_json", () => {
    // The poster script uploads `canonicalJson` bytes, the upload route refuses any other, and the
    // hash on chain is the SHA-256 of them. So each document must read back as itself. For the
    // three the schemas cover, a parse must not change them either (a default added, a key
    // dropped): a reader who parses and hashes again would get another hash than the one on chain.
    const schemas = {
      "brief.json": BriefSchema,
      "criteria.json": PublicCriteriaSchema,
    } as const;

    for (const name of ["task.json", "brief.json", "criteria.json"] as const) {
      const document = readJson(slug, name);
      const canonical = utf8(canonicalJson(document));
      expect(JSON.parse(canonical), name).toEqual(document);
      if (name !== "task.json") {
        const parsed = schemas[name].parse(JSON.parse(canonical));
        expect(utf8(canonicalJson(parsed)), `${name} after a schema parse`).toBe(canonical);
      }
    }
  });

  test("the_held_out_document_round_trips_as_canonical_json", ({ skip }) => {
    // The same for the checks, which are uploaded as canonical bytes and committed to by their
    // hash. The file is the private directory's, and a seed without checks has none to read.
    const { heldout } = loadPrivate(slug, skip);
    if (heldout === null) return;
    const document: unknown = JSON.parse(readFileSync(heldoutPath(slug), "utf8"));
    const canonical = utf8(canonicalJson(document));
    expect(JSON.parse(canonical), "heldout.json").toEqual(document);
    expect(utf8(canonicalJson(HeldoutSchema.parse(JSON.parse(canonical)))), "after a parse").toBe(
      canonical,
    );
  });
});

test("product_table_extract_fixes_the_product_count", async ({ skip }) => {
  // The key asserts products[0] to products[8] and excluded_skus, and an assertion cannot see an
  // extra products[9], so a solver that keeps the discontinued item and puts it last would match
  // every one of them. The public schema fixes the count to close that.
  await expectItemCountFixed(
    "product-table-extract",
    "products",
    {
      sku: "RM-1080",
      name: 'Laptop sleeve 15"',
      price_kobo: 1599900,
      stock: 0,
    },
    skip,
  );
});

test("invoice_extract_fixes_the_line_item_count", async ({ skip }) => {
  // The key asserts line_items[0] to line_items[3], so a solver that lists the VAT row under the
  // table as a line of its own would match every one of them. The public schema fixes the count.
  await expectItemCountFixed(
    "invoice-extract",
    "line_items",
    {
      description: "VAT (7.5%)",
      quantity: 1,
      unit_price: 102.17,
      amount: 102.17,
    },
    skip,
  );
});

test("meeting_actions_extract_fixes_the_action_count", async ({ skip }) => {
  // The key asserts action_count 8 and actions[0] to actions[7], so a solver that lists the item the
  // notes only float (Ada, "may look at the logging costs") yet counts the eight real ones would
  // match every one of them. The public schema fixes the count of actions.
  await expectItemCountFixed(
    "meeting-actions-extract",
    "actions",
    {
      owner: "Ada",
      task: "look at the logging costs",
      due: null,
    },
    skip,
  );
});

test("meeting_actions_extract_refuses_a_blank_task", async ({ skip }) => {
  // The brief says the task is "not checked word for word", so no assertion reads it, and the
  // schema is all that stands between an action with an empty task and the reward.
  const { criteria, heldout, solution } = loadPrivate("meeting-actions-extract", skip);
  const answer: unknown = JSON.parse(utf8(solution));

  for (const blank of ["", " ", "\t\n", "\u00a0"]) {
    const blanked = replaceAt(answer, ["actions", 0, "task"], blank);
    const result = await scoreAnswer(
      criteria,
      heldout,
      new TextEncoder().encode(JSON.stringify(blanked)),
    );
    expect(result.score, `a task of ${JSON.stringify(blank)}`).toBe(0);
    expect(
      result.reasons.join("; "),
      `why a task of ${JSON.stringify(blank)} is refused`,
    ).toContain("/actions/0/task");
  }
});

test("invoice_extract_brief_says_descriptions_are_copied_as_written", ({ skip }) => {
  // The key compares a description letter for letter, "(per day)" included, so the brief has to say
  // that it is copied as written. Otherwise a solver that shortens it loses the reward unfairly.
  const { brief, heldout } = loadPrivate("invoice-extract", skip);
  if (heldout === null || !("json_schema" in heldout)) {
    throw new Error("invoice-extract is not a json_schema seed");
  }
  const [prose = "", data = ""] = brief.instructions.split("-----BEGIN DATA-----");
  expect(prose).toMatch(/\bcopy\b[^.\n]*\bdescription\b[^.\n]*\bas written\b/i);

  // And each description the key holds is a whole cell of the table, as the data prints it. The
  // columns are two spaces or more apart, so the first cell of a row ends at the first such gap.
  const kept = heldout.json_schema.assertions.flatMap(({ equals }) =>
    typeof equals === "object" && equals !== null && "description" in equals
      ? [equals.description]
      : [],
  );
  const firstCells = data.split("\n").map((line) => line.split(/ {2,}/)[0]);
  expect(kept.length, "descriptions held out").toBeGreaterThan(0);
  expect(
    kept.filter((description) => !firstCells.includes(String(description))),
    "held-out descriptions that are not a cell of the table",
  ).toEqual([]);
});

describe.each(JSON_SCHEMA_SLUGS)("json_schema seed %s", (slug) => {
  test("every_value_of_the_solution_is_checked_by_the_key", ({ skip }) => {
    // A value that the key does not look at can be wrong and still be paid in full, and a judge
    // reading the scorecard sees a wrong answer rewarded. So each value of the solution, changed to
    // another that the schema accepts, has to cost the reward, unless UNCHECKED_VALUES says why not.
    const { criteria, heldout, solution } = loadPrivate(slug, skip);
    if (criteria.kind !== "json_schema" || heldout === null || !("json_schema" in heldout)) {
      throw new Error(`${slug} is not a json_schema seed`);
    }
    const answer: unknown = JSON.parse(utf8(solution));
    const excuses = UNCHECKED_VALUES[slug] ?? [];

    const values = leavesOf(answer).map(({ steps, value }) => ({
      at: pathOf(steps),
      checked: keyChecksValueAt(criteria, heldout.json_schema, answer, steps, value),
    }));
    const excused = (at: string) => excuses.some(({ match }) => match.test(at));

    expect(
      values.filter(({ at, checked }) => !checked && !excused(at)).map(({ at }) => at),
      "values that can be wrong in an answer that is paid in full",
    ).toEqual([]);
    expect(
      values.filter(({ at, checked }) => checked && excused(at)).map(({ at }) => at),
      "values the key checks after all, which UNCHECKED_VALUES excuses for nothing",
    ).toEqual([]);
    expect(
      excuses
        .filter(({ match }) => !values.some(({ at }) => match.test(at)))
        .map(({ match }) => String(match)),
      "excuses in UNCHECKED_VALUES that match no value of the solution",
    ).toEqual([]);
  });
});

/**
 * Regexes a careless solver would write for the regex seeds, each breaking one rule of its brief.
 * The Judge scores a regex seed on its held-out cases alone (P05-R4), so a rule that no held-out
 * case tests pays every regex that breaks it. None of these may reach the pass mark, and each must
 * still score at least `NEAR_MISS_SCORE`: a regex that stops compiling (0), turns into "^$" (about
 * 50) or into some other wrong regex is not paid either, and then it tests nothing.
 */
const NEAR_MISS_SCORE = 90;
const KNOWN_WRONG_REGEXES: Record<
  string,
  { why: string; pattern: string; flags?: string; near?: number }[]
> = {
  "iso-date-regex": [
    {
      why: "[redacted]",
      pattern:
        "[redacted]",
    },
    {
      why: "[redacted]",
      pattern:
        "[redacted]",
    },
    {
      why: "[redacted]",
      pattern:
        "[redacted]",
    },
    {
      why: "[redacted]",
      pattern:
        "[redacted]",
    },
    {
      why: "[redacted]",
      pattern:
        "[redacted]",
    },
    {
      why: "[redacted]",
      pattern:
        "[redacted]",
    },
    {
      why: "[redacted]",
      pattern:
        "[redacted]",
    },
    {
      why: "[redacted]",
      pattern:
        "[redacted]",
    },
  ],
  "semver-regex": [
    {
      why: "[redacted]",
      pattern:
        "[redacted]",
    },
    {
      why: "[redacted]",
      pattern:
        "[redacted]",
    },
    {
      why: "[redacted]",
      pattern:
        "[redacted]",
    },
    {
      why: "[redacted]",
      pattern:
        "[redacted]",
    },
    {
      why: "[redacted]",
      pattern:
        "[redacted]",
    },
  ],
  "near-account-regex": [
    {
      why: "[redacted]",
      pattern: "[redacted]",
    },
    {
      why: "[redacted]",
      pattern: "[redacted]",
    },
    {
      why: "[redacted]",
      pattern: "[redacted]",
    },
  ],
  "ipv4-regex": [
    {
      why: "[redacted]",
      pattern: "[redacted]",
    },
    {
      why: "[redacted]",
      pattern:
        "[redacted]",
    },
    {
      why: "[redacted]",
      pattern:
        "[redacted]",
    },
    {
      why: "[redacted]",
      pattern:
        "[redacted]",
    },
    {
      why: "[redacted]",
      pattern:
        "[redacted]",
    },
  ],
  "hex-color-regex": [
    {
      why: "[redacted]",
      pattern: "[redacted]",
    },
    {
      // [redacted]
      // [redacted]
      why: "[redacted]",
      pattern: "[redacted]",
      near: 80,
    },
    {
      why: "[redacted]",
      pattern: "[redacted]",
      near: 85,
    },
    {
      why: "[redacted]",
      pattern: "[redacted]",
    },
    {
      why: "[redacted]",
      pattern: "[redacted]",
    },
  ],
  "duration-regex": [
    {
      why: "[redacted]",
      pattern: "[redacted]",
    },
    {
      why: "[redacted]",
      pattern: "[redacted]",
    },
    {
      why: "[redacted]",
      pattern: "[redacted]",
    },
    {
      why: "[redacted]",
      pattern: "[redacted]",
    },
    {
      why: "[redacted]",
      pattern: "[redacted]",
      flags: "[redacted]",
    },
  ],
};

describe.each(Object.keys(KNOWN_WRONG_REGEXES))("regex seed %s", (slug) => {
  test("known_wrong_regexes_are_not_paid", async ({ skip }) => {
    const { criteria, heldout } = loadPrivate(slug, skip);

    const paid: string[] = [];
    const broken: string[] = [];
    for (const { why, pattern, flags = "", near = NEAR_MISS_SCORE } of KNOWN_WRONG_REGEXES[slug] ??
      []) {
      const answer = new TextEncoder().encode(JSON.stringify({ pattern, flags }));
      const result = await scoreAnswer(criteria, heldout, answer);
      if (result.passed) paid.push(why);
      if (result.score < near) broken.push(`${why} (scores ${result.score})`);
    }
    expect(paid, "wrong regexes that the held-out cases pay in full").toEqual([]);
    expect(broken, "known-wrong regexes that are no longer near-misses").toEqual([]);
  });
});

/**
 * Functions a careless solver would write for the tests seeds, each breaking one rule of its brief.
 * A rule that no held-out case tests pays every function that breaks it, so none of these may
 * reach the pass mark. They must also run: one that throws on every case tests nothing, so each
 * has to pass at least one case.
 */
const KNOWN_WRONG_TESTS: Record<string, { why: string; source: string }[]> = {
  "slugify-title": [
    {
      why: "[redacted]",
      source:
        '[redacted]',
    },
    {
      why: "[redacted]",
      source:
        '[redacted]',
    },
    {
      why: "[redacted]",
      source:
        '[redacted]',
    },
    {
      why: "[redacted]",
      source:
        '[redacted]',
    },
    {
      why: "[redacted]",
      source:
        '[redacted]',
    },
  ],
  "near-to-yocto": [
    {
      why: "[redacted]",
      source:
        '[redacted]',
    },
    {
      why: "[redacted]",
      source:
        '[redacted]',
    },
    {
      why: "[redacted]",
      source:
        '[redacted]',
    },
    {
      why: "[redacted]",
      source:
        '[redacted]',
    },
    {
      why: "[redacted]",
      source:
        '[redacted]',
    },
    {
      why: "[redacted]",
      source:
        '[redacted]',
    },
  ],
  "latest-per-id": [
    {
      why: "[redacted]",
      source:
        "[redacted]",
    },
    {
      why: "[redacted]",
      source:
        "[redacted]",
    },
    {
      why: "[redacted]",
      source:
        "[redacted]",
    },
    {
      why: "[redacted]",
      source:
        "[redacted]",
    },
    {
      why: "[redacted]",
      source:
        "[redacted]",
    },
  ],
  "wrap-text": [
    {
      why: "[redacted]",
      source:
        '[redacted]',
    },
    {
      why: "[redacted]",
      source:
        '[redacted]',
    },
    {
      why: "[redacted]",
      source:
        '[redacted]',
    },
    {
      why: "[redacted]",
      source:
        '[redacted]',
    },
    {
      why: "[redacted]",
      source:
        '[redacted]',
    },
  ],
};

const TESTS_SLUGS = SLUGS.filter((slug) => load(slug).criteria.kind === "tests");

describe.each(TESTS_SLUGS)("tests seed %s", (slug) => {
  test("known_wrong_functions_are_not_paid", async ({ skip }) => {
    const { criteria, heldout } = loadPrivate(slug, skip);
    const wrong = KNOWN_WRONG_TESTS[slug] ?? [];
    expect(wrong.length, "known-wrong functions written for this seed").toBeGreaterThanOrEqual(4);

    const paid: string[] = [];
    const broken: string[] = [];
    for (const { why, source } of wrong) {
      const result = await scoreAnswer(criteria, heldout, new TextEncoder().encode(source));
      if (result.passed) paid.push(why);
      if (result.score === 0) broken.push(`${why} (${result.reasons.join("; ")})`);
    }
    expect(paid, "wrong functions that the held-out cases pay in full").toEqual([]);
    expect(broken, "known-wrong functions that fail every case, so they test nothing").toEqual([]);
  });

  test("the_solution_runs_well_inside_the_judges_limits", async ({ skip }) => {
    // The Judge gives a case 1 s and 32 MiB, and an entry up to 65_536 bytes of source. A seed's
    // own solution should not need a tenth of them, or a slow machine would fail an honest entry.
    const { criteria, heldout, solution } = loadPrivate(slug, skip);
    if (heldout === null || !("tests" in heldout)) throw new Error(`${slug} has no held-out cases`);
    expect(solution.byteLength, "solution bytes").toBeLessThan(6_554);
    expect(heldout.tests.cases.length, "held-out cases").toBeGreaterThanOrEqual(10);
    expect(
      criteria.kind === "tests" && criteria.examples.length,
      "published cases",
    ).toBeGreaterThanOrEqual(3);

    await scoreAnswer(criteria, heldout, solution); // the first run starts the engine
    const started = performance.now();
    const result = await scoreAnswer(criteria, heldout, solution);
    const perCase = (performance.now() - started) / heldout.tests.cases.length;
    expect(result.score, result.reasons.join("; ")).toBe(100);
    expect(perCase, "milliseconds for a case").toBeLessThan(100);
  });
});

const RUBRIC_SLUGS = SLUGS.filter((slug) => load(slug).criteria.kind === "rubric");

/**
 * The weight from which a criterion is one the task is about: an entry that loses it must not be
 * paid, however well it does on the rest. With a pass mark of 85, losing a criterion of 16% of the
 * weight or more puts the score under it.
 */
const HEAVY_WEIGHT = 8;

/**
 * For each rubric seed, entries that are the solution with one core element taken out or spoiled:
 * `edits` are the changes to the text of the solution, each a piece that occurs once and what
 * takes its place, and `drops` are the criteria (0-based, in the order of the rubric) that the
 * entry loses, which the stand-in must score 5 or less. No such entry may reach the pass mark. A
 * pass mark that the solution alone clears is not enough: an entry that gets the central point of
 * the task wrong, or leaves it out, must fail it too.
 *
 * The edits quote the solution, which is private, so they are private too: an array of these in
 * `<private dir>/<slug>/scenarios.json` (see README.md). A copy of them here would be a copy of the
 * answer, a piece at a time.
 */
type Scenario = { why: string; drops: number[]; edits: [find: string, replace: string][] };

const scenariosPath = (slug: string) => scenariosFileOf(PRIVATE_DIR, slug);

/** The scenarios of a rubric seed from the private directory, checked for shape; null where it has none. */
function scenariosOf(slug: string): Scenario[] | null {
  if (!existsSync(scenariosPath(slug))) return null;
  const document: unknown = JSON.parse(readFileSync(scenariosPath(slug), "utf8"));
  const bad = (what: string) => new Error(`${scenariosPath(slug)}: ${what}`);
  if (!Array.isArray(document)) throw bad("not an array of scenarios");
  for (const one of document as Partial<Scenario>[]) {
    if (typeof one?.why !== "string") throw bad("a scenario has no `why`");
    if (!Array.isArray(one.drops) || !one.drops.every(Number.isInteger)) {
      throw bad(`"${one.why}": \`drops\` is not a list of criteria`);
    }
    const pairs = Array.isArray(one.edits) ? one.edits : [];
    if (
      pairs.length === 0 ||
      !pairs.every(
        (p) => Array.isArray(p) && p.length === 2 && p.every((q) => typeof q === "string"),
      )
    ) {
      throw bad(`"${one.why}": \`edits\` is not a list of [find, replace] pairs`);
    }
  }
  return document as Scenario[];
}

/** `solution` with each edit made once; a piece that is not there exactly once is a mistake. */
function withEdits(solution: string, edits: Scenario["edits"]): string {
  return edits.reduce((text, [find, replace]) => {
    const pieces = text.split(find);
    if (pieces.length !== 2) {
      throw new Error(`"${find.slice(0, 50)}" occurs ${pieces.length - 1} times, not once`);
    }
    return pieces.join(replace);
  }, solution);
}

/** The text between the BEGIN DATA and END DATA lines of a brief: the source the task works on. */
function dataBlockOf(brief: Brief): string {
  const match = /-----BEGIN DATA-----\n([\s\S]*)\n-----END DATA-----/.exec(brief.instructions);
  if (match?.[1] === undefined) throw new Error("the brief has no data block");
  return match[1];
}

describe.each(RUBRIC_SLUGS)("rubric seed %s", (slug) => {
  test("every_criterion_has_stand_in_checks_and_the_solution_meets_all_of_them", ({ skip }) => {
    const { criteria, solution } = loadPrivate(slug, skip);
    if (criteria.kind !== "rubric") throw new Error(`${slug} is not a rubric seed`);
    expect(STAND_IN[slug]?.length, "criteria with stand-in checks").toBe(criteria.rubric.length);
    const scores = criteria.rubric.map((_, i) => standInScore(slug, i, utf8(solution)));
    expect(scores, "stand-in score of the solution on each criterion").toEqual(
      criteria.rubric.map(() => 10),
    );
  });

  test("the_weak_answer_misses_several_criteria_and_a_nonsense_answer_misses_the_pass_mark", async ({
    skip,
  }) => {
    const { brief, criteria, solution } = loadPrivate(slug, skip);
    if (criteria.kind !== "rubric") throw new Error(`${slug} is not a rubric seed`);
    const weak = utf8(readBytes(slug, "weak.txt"));
    const missed = criteria.rubric.filter(
      (_, i) => standInScore(slug, i, weak) < standInScore(slug, i, utf8(solution)),
    );
    expect(missed.length, "criteria on which the weak answer does worse").toBeGreaterThanOrEqual(3);

    const nonsense = await scoreAnswer(criteria, null, new TextEncoder().encode("Lorem."), {
      slug,
      brief,
    });
    expect(nonsense.passed, "a one-word answer passes").toBe(false);
  });

  test("an_entry_that_loses_one_core_element_misses_the_pass_mark", async ({ skip }) => {
    // The pass mark must stop an entry that leaves out, or gets wrong, the point of the task, and
    // not only the weak answer. Each case is the solution with one such change.
    const { brief, criteria, solution } = loadPrivate(slug, skip);
    if (criteria.kind !== "rubric") throw new Error(`${slug} is not a rubric seed`);
    const scenarios = scenariosOf(slug);
    if (scenarios === null) return skip(PRIVATE_NOTE);
    expect(scenarios.length, "core scenarios written for this seed").toBeGreaterThanOrEqual(3);

    const text = utf8(solution);
    const paid: string[] = [];
    const notLost: string[] = [];
    for (const { why, drops, edits } of scenarios) {
      const entry = withEdits(text, edits);
      const result = await scoreRubricAnswer(
        slug,
        brief,
        criteria,
        new TextEncoder().encode(entry),
      );
      if (result.score >= criteria.min_score) paid.push(`${why} (${result.score})`);
      for (const index of drops) {
        const score = standInScore(slug, index, entry);
        if (score > 5) notLost.push(`${why}: criterion ${index + 1} still scores ${score}`);
      }
    }
    expect(paid, "entries that lose a core element and still pass").toEqual([]);
    expect(notLost, "scenarios that do not lose the criterion they name").toEqual([]);
  });

  test("every_heavy_criterion_is_lost_by_a_scenario", ({ skip }) => {
    // The scenarios are private (they quote the solution), so this runs where the private
    // directory has them.
    const { criteria } = load(slug);
    if (criteria.kind !== "rubric") throw new Error(`${slug} is not a rubric seed`);
    const heavy = criteria.rubric.flatMap(({ weight }, index) =>
      weight >= HEAVY_WEIGHT ? [index] : [],
    );
    const scenarios = scenariosOf(slug);
    if (scenarios === null) return skip(PRIVATE_NOTE);
    const named = new Set(scenarios.flatMap(({ drops }) => drops));
    expect(
      heavy.filter((index) => !named.has(index)),
      "heavy criteria that no scenario loses",
    ).toEqual([]);
  });

  test("losing_any_one_heavy_criterion_alone_misses_the_pass_mark", async () => {
    // The weights and the pass mark by themselves: an entry that does perfectly on every
    // criterion but one, which it loses altogether, is under the pass mark when that criterion is
    // 8 or more of the weight. Every such criterion also has a scenario (next test).
    const { brief, criteria } = load(slug);
    if (criteria.kind !== "rubric") throw new Error(`${slug} is not a rubric seed`);
    const heavy = criteria.rubric.flatMap(({ weight }, index) =>
      weight >= HEAVY_WEIGHT ? [index] : [],
    );
    expect(heavy.length, "heavy criteria").toBeGreaterThanOrEqual(2);

    const paid: string[] = [];
    for (const index of heavy) {
      const result = await scoreRubricWith(
        dropOneGrader(criteria.rubric, index),
        slug,
        brief,
        criteria,
        new TextEncoder().encode("An entry that the fake grader scores without reading."),
      );
      if (result.score >= criteria.min_score) paid.push(`criterion ${index + 1} (${result.score})`);
    }
    expect(paid, "criteria whose loss alone still passes").toEqual([]);
  });

  test("the_source_text_pasted_back_is_not_paid", async () => {
    // The laziest entry for a task that asks to rewrite or sum up a text is the text itself.
    const { brief, criteria } = load(slug);
    if (criteria.kind !== "rubric") throw new Error(`${slug} is not a rubric seed`);
    const pasted = await scoreRubricAnswer(
      slug,
      brief,
      criteria,
      new TextEncoder().encode(dataBlockOf(brief)),
    );
    expect(pasted.passed, `the source pasted back scores ${pasted.score}`).toBe(false);
  });

  test("the_brief_tells_the_solver_how_the_answer_is_graded", () => {
    // Honest about the grader: a model scores it, and the brief says so, as the other kinds say
    // how theirs are checked.
    const { brief } = load(slug);
    expect(brief.instructions).toMatch(
      /an AI model scores your answer from 0 to 10 on each criterion/,
    );
  });
});
