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

const path = (slug: string, name: string) => join(SEEDS_DIR, slug, name);
const readBytes = (slug: string, name: string): Buffer => readFileSync(path(slug, name));
const readJson = (slug: string, name: string): unknown =>
  JSON.parse(readBytes(slug, name).toString("utf8"));
const utf8 = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

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

/** Every string inside `value`, in however many arrays and objects. Object keys are not strings. */
function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(stringsIn);
  return [];
}

/**
 * The strings of a held-out document that its scorer compares letter for letter: every string in
 * a json_schema assertion, and the answers of an exact task whose criteria do not lowercase. A
 * regex case is a test vector, and the case of a letter is often what it tests.
 */
function caseSensitiveStrings(criteria: PublicCriteria, heldout: Heldout): string[] {
  if ("json_schema" in heldout) {
    return heldout.json_schema.assertions.flatMap(({ equals }) => stringsIn(equals));
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

/**
 * `answer` must fall under the pass mark because the key's assertion on `path` fails: the answer
 * fits the schema, so a reason that starts with `path` is the key refusing it.
 */
async function expectKeyRefuses(slug: string, answer: unknown, path: string): Promise<void> {
  const { criteria, heldout } = load(slug);
  const bytes = new TextEncoder().encode(JSON.stringify(answer));
  const result = await scoreAnswer(criteria, heldout, bytes);
  const why = result.reasons.join("; ");
  expect(result.score, why).toBeLessThan(criteria.min_score);
  expect(
    result.reasons.some((reason) => reason.startsWith(`${path} `)),
    `no reason for ${path}: ${why}`,
  ).toBe(true);
}

test("the_ten_p0_seeds_are_all_there", () => {
  const missing = Object.keys(P0_SEEDS).filter((slug) => !SLUGS.includes(slug));
  expect(missing, "seeds missing from seeds/").toEqual([]);

  const lacking = Object.keys(P0_SEEDS).flatMap((slug) =>
    SEED_FILES.filter((name) => !existsSync(path(slug, name))).map((name) => `${slug}/${name}`),
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
    if (!existsSync(path(slug, "weak.txt"))) return skip("this seed has no weak answer");
    const { criteria, heldout, solution } = load(slug);

    const best = await scoreAnswer(criteria, heldout, solution);
    const weak = await scoreAnswer(criteria, heldout, readBytes(slug, "weak.txt"));
    expect(weak.score).toBeLessThan(best.score);
    // A weak answer is meant to lose. If it passed, a task with only that entry would pay it.
    expect(weak.passed, "weak answer passes").toBe(false);
  });

  test("answers_fit_the_briefs_output_rules", () => {
    const { brief, criteria, solution } = load(slug);

    const format = FORMAT_OF_KIND[criteria.kind];
    if (format !== undefined) expect(brief.output.format).toBe(format);
    expect(solution.byteLength, "solution.txt bytes").toBeLessThanOrEqual(brief.output.max_bytes);
    if (existsSync(path(slug, "weak.txt"))) {
      expect(readBytes(slug, "weak.txt").byteLength, "weak.txt bytes").toBeLessThanOrEqual(
        brief.output.max_bytes,
      );
    }
  });

  test("public_examples_are_not_held_out", () => {
    const { brief, criteria, heldout } = load(slug);

    // A json_schema seed publishes a schema and no examples, so there is nothing to compare.
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
    // hash on chain is the SHA-256 of them. So each document must read back as itself and come
    // out the same when written again. For the three the schemas cover, a parse must not change
    // them either (a default added, a key dropped): a reader who parses and hashes again would
    // get another hash than the one on chain.
    const schemas = {
      "brief.json": BriefSchema,
      "criteria.json": PublicCriteriaSchema,
      "heldout.json": HeldoutSchema,
    } as const;

    for (const name of ["task.json", "brief.json", "criteria.json", "heldout.json"] as const) {
      const document = readJson(slug, name);
      const canonical = utf8(canonicalJson(document));
      expect(JSON.parse(canonical), name).toEqual(document);
      expect(utf8(canonicalJson(JSON.parse(canonical))), name).toBe(canonical);
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
  // The key asserts line_items[1] to line_items[3], so a solver that lists the VAT row under the
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

/** One wrong value for each of the four fields of the invoice's first line. */
const MISREAD_FIRST_LINES: [field: string, wrong: string | number][] = [
  ["description", "Pallet wrap"],
  ["quantity", 21],
  ["unit_price", 228],
  ["amount", 19],
];

test.each(MISREAD_FIRST_LINES)("invoice_extract_checks_the_first_line_%s", async (field, wrong) => {
  // The key did not look at line_items[0], so a solver that misread the first line was still paid
  // in full. It asserts the whole item now, and each of the four values counts.
  const answer = JSON.parse(utf8(load("invoice-extract").solution)) as {
    line_items: Record<string, unknown>[];
  };
  const [first, ...rest] = answer.line_items;
  const misread = { ...answer, line_items: [{ ...first, [field]: wrong }, ...rest] };
  await expectKeyRefuses("invoice-extract", misread, "$.line_items[0]");
});

test("invoice_extract_checks_its_customer", async () => {
  // The customer is the company that is billed. The key did not assert it, so a solver that put the
  // vendor there (the other company on the page) was still paid in full.
  const answer = JSON.parse(utf8(load("invoice-extract").solution)) as { vendor: string };
  await expectKeyRefuses("invoice-extract", { ...answer, customer: answer.vendor }, "$.customer");
});
