import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type EntryScore, scoreExact, scoreJsonSchema, scoreRegexCases } from "@tender/judge";
import {
  BriefSchema,
  canonicalJson,
  type Heldout,
  HeldoutSchema,
  heldoutMatchesCriteria,
  NETWORKS,
  type PublicCriteria,
  PublicCriteriaSchema,
  sha256Hex,
} from "@tender/shared";
import { describe, expect, test } from "vitest";

// Every seed task in seeds/<slug>/ is scored by the Judge's own scorers, so that a seed that pays
// nobody (its solution misses the pass mark), pays everybody (its weak answer passes) or gives its
// answer away (a public example is also held out) fails here, before it is posted. Nothing is
// mocked: a regex seed runs in the same QuickJS sandbox that judges a real entry.

const SEEDS_DIR = import.meta.dirname;
const SLUGS = readdirSync(SEEDS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const SEED_FILES = [
  "task.json",
  "brief.json",
  "criteria.json",
  "heldout.json",
  "solution.txt",
  "weak.txt",
];

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

/** The output format a brief must name for the kinds whose scorer insists on one answer shape. */
const FORMAT_OF_KIND: Partial<Record<PublicCriteria["kind"], string>> = {
  regex_cases: "regex_json",
  json_schema: "json",
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

/** A seed's documents, once the schemas have read them, and the solution's bytes. */
function load(slug: string) {
  return {
    brief: BriefSchema.parse(readJson(slug, "brief.json")),
    criteria: PublicCriteriaSchema.parse(readJson(slug, "criteria.json")),
    heldout: HeldoutSchema.parse(readJson(slug, "heldout.json")),
    solution: readBytes(slug, "solution.txt"),
  };
}

/**
 * `answer` scored as the Judge scores a revealed entry: by the scorer of the criteria's kind, on
 * the held-out document. A regex seed's held-out cases replace its public examples (P05-R4).
 */
async function scoreAnswer(
  criteria: PublicCriteria,
  heldout: Heldout,
  answer: Uint8Array,
): Promise<EntryScore> {
  if (criteria.kind === "exact" && "exact" in heldout) {
    return scoreExact(criteria, heldout.exact, answer);
  }
  if (criteria.kind === "json_schema" && "json_schema" in heldout) {
    return scoreJsonSchema(criteria, heldout.json_schema, answer);
  }
  if (criteria.kind === "regex_cases" && "regex_cases" in heldout) {
    return scoreRegexCases(criteria, heldout.regex_cases, answer);
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
function caseSensitiveStrings(criteria: PublicCriteria, heldout: Heldout): string[] {
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
async function expectItemCountFixed(slug: string, array: string, extra: unknown): Promise<void> {
  const { criteria, heldout, solution } = load(slug);
  if (criteria.kind !== "json_schema" || !("json_schema" in heldout)) {
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

test("the_ten_p0_seeds_are_all_there", () => {
  const missing = Object.keys(P0_SEEDS).filter((slug) => !SLUGS.includes(slug));
  expect(missing, "seeds missing from seeds/").toEqual([]);

  const lacking = Object.keys(P0_SEEDS).flatMap((slug) =>
    SEED_FILES.filter((name) => !existsSync(seedPath(slug, name))).map((name) => `${slug}/${name}`),
  );
  expect(lacking, "files missing from the P0 seeds").toEqual([]);

  const kinds = Object.fromEntries(Object.keys(P0_SEEDS).map((s) => [s, load(s).criteria.kind]));
  expect(kinds).toEqual(P0_SEEDS);
});

test("every_brief_has_its_own_hash", () => {
  // The offline solver finds a seed's answer by the hash of its brief, so no two may share one.
  const hashes = SLUGS.map((slug) => sha256Hex(canonicalJson(readJson(slug, "brief.json"))));
  expect(new Set(hashes).size).toBe(SLUGS.length);
});

describe.each(SLUGS)("seed %s", (slug) => {
  test("documents_follow_the_schemas", () => {
    const { criteria, heldout } = load(slug);

    expect(criteria.has_heldout, "has_heldout").toBe(true);
    // Every brief says the reward goes only to a perfect answer, and the known-wrong regexes
    // below are refused on that pass mark alone: lower it and a near-miss is paid.
    expect(criteria.min_score, "min_score").toBe(100);
    expect(heldoutMatchesCriteria(criteria, heldout), "held-out kind is the criteria's").toBe(true);
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

  test("solution_passes_its_held_out_checks", async () => {
    const { criteria, heldout, solution } = load(slug);

    const result = await scoreAnswer(criteria, heldout, solution);
    expect(result.score, result.reasons.join("; ")).toBeGreaterThanOrEqual(criteria.min_score);
    expect(result.passed).toBe(true);

    if (criteria.kind === "regex_cases" && "regex_cases" in heldout) {
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
    const { criteria, heldout, solution } = load(slug);

    const best = await scoreAnswer(criteria, heldout, solution);
    const weak = await scoreAnswer(criteria, heldout, readBytes(slug, "weak.txt"));
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
    const { brief, criteria, solution } = load(slug);

    const format = FORMAT_OF_KIND[criteria.kind];
    if (format !== undefined) expect(brief.output.format).toBe(format);
    expect(solution.byteLength, "solution.txt bytes").toBeLessThanOrEqual(brief.output.max_bytes);
    if (existsSync(seedPath(slug, "weak.txt"))) {
      expect(readBytes(slug, "weak.txt").byteLength, "weak.txt bytes").toBeLessThanOrEqual(
        brief.output.max_bytes,
      );
    }
  });

  test("public_examples_are_not_held_out", () => {
    const { brief, criteria, heldout } = load(slug);

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

  test("held_out_strings_keep_the_briefs_letter_case", () => {
    const { brief, criteria, heldout } = load(slug);

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

  test("documents_round_trip_as_canonical_json", () => {
    // The poster script uploads `canonicalJson` bytes, the upload route refuses any other, and the
    // hash on chain is the SHA-256 of them. So each document must read back as itself. For the
    // three the schemas cover, a parse must not change them either (a default added, a key
    // dropped): a reader who parses and hashes again would get another hash than the one on chain.
    const schemas = {
      "brief.json": BriefSchema,
      "criteria.json": PublicCriteriaSchema,
      "heldout.json": HeldoutSchema,
    } as const;

    for (const name of ["task.json", "brief.json", "criteria.json", "heldout.json"] as const) {
      const document = readJson(slug, name);
      const canonical = utf8(canonicalJson(document));
      expect(JSON.parse(canonical), name).toEqual(document);
      if (name !== "task.json") {
        const parsed = schemas[name].parse(JSON.parse(canonical));
        expect(utf8(canonicalJson(parsed)), `${name} after a schema parse`).toBe(canonical);
      }
    }
  });
});

test("product_table_extract_fixes_the_product_count", async () => {
  // The key asserts products[0] to products[8] and excluded_skus, and an assertion cannot see an
  // extra products[9], so a solver that keeps the discontinued item and puts it last would match
  // every one of them. The public schema fixes the count to close that.
  await expectItemCountFixed("product-table-extract", "products", {
    sku: "RM-1080",
    name: 'Laptop sleeve 15"',
    price_kobo: 1599900,
    stock: 0,
  });
});

test("invoice_extract_fixes_the_line_item_count", async () => {
  // The key asserts line_items[0] to line_items[3], so a solver that lists the VAT row under the
  // table as a line of its own would match every one of them. The public schema fixes the count.
  await expectItemCountFixed("invoice-extract", "line_items", {
    description: "VAT (7.5%)",
    quantity: 1,
    unit_price: 102.17,
    amount: 102.17,
  });
});

test("meeting_actions_extract_fixes_the_action_count", async () => {
  // The key asserts action_count 8 and actions[0] to actions[7], so a solver that lists the item the
  // notes only float (Ada, "may look at the logging costs") yet counts the eight real ones would
  // match every one of them. The public schema fixes the count of actions.
  await expectItemCountFixed("meeting-actions-extract", "actions", {
    owner: "Ada",
    task: "look at the logging costs",
    due: null,
  });
});

test("meeting_actions_extract_refuses_a_blank_task", async () => {
  // The brief says the task is "not checked word for word", so no assertion reads it, and the
  // schema is all that stands between an action with an empty task and the reward.
  const { criteria, heldout, solution } = load("meeting-actions-extract");
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

test("invoice_extract_brief_says_descriptions_are_copied_as_written", () => {
  // The key compares a description letter for letter, "(per day)" included, so the brief has to say
  // that it is copied as written. Otherwise a solver that shortens it loses the reward unfairly.
  const { brief, heldout } = load("invoice-extract");
  if (!("json_schema" in heldout)) throw new Error("invoice-extract is not a json_schema seed");
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
  test("every_value_of_the_solution_is_checked_by_the_key", () => {
    // A value that the key does not look at can be wrong and still be paid in full, and a judge
    // reading the scorecard sees a wrong answer rewarded. So each value of the solution, changed to
    // another that the schema accepts, has to cost the reward, unless UNCHECKED_VALUES says why not.
    const { criteria, heldout, solution } = load(slug);
    if (criteria.kind !== "json_schema" || !("json_schema" in heldout)) {
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
const KNOWN_WRONG_REGEXES: Record<string, { why: string; pattern: string }[]> = {
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
};

describe.each(Object.keys(KNOWN_WRONG_REGEXES))("regex seed %s", (slug) => {
  test("known_wrong_regexes_are_not_paid", async () => {
    const { criteria, heldout } = load(slug);

    const paid: string[] = [];
    const broken: string[] = [];
    for (const { why, pattern } of KNOWN_WRONG_REGEXES[slug] ?? []) {
      const answer = new TextEncoder().encode(JSON.stringify({ pattern, flags: "" }));
      const result = await scoreAnswer(criteria, heldout, answer);
      if (result.passed) paid.push(why);
      if (result.score < NEAR_MISS_SCORE) broken.push(`${why} (scores ${result.score})`);
    }
    expect(paid, "wrong regexes that the held-out cases pay in full").toEqual([]);
    expect(broken, "known-wrong regexes that are no longer near-misses").toEqual([]);
  });
});
