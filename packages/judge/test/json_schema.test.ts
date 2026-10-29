import type { Heldout, PublicCriteria } from "@tender/shared";
import { afterEach, expect, test, vi } from "vitest";
import { checkJsonSchemaUsable, type EntryScore, scoreJsonSchema } from "../src/index";

type JsonSchemaCriteria = Extract<PublicCriteria, { kind: "json_schema" }>;
// `Heldout` is a union, so `Heldout["json_schema"]` does not compile: pick the member first.
type JsonSchemaHeldout = Extract<Heldout, { json_schema: unknown }>["json_schema"];
type Assertion = JsonSchemaHeldout["assertions"][number];

/** A small invoice: the shape of the `invoice-extract` seed, cut down. */
const INVOICE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["invoice_number", "issue_date", "currency", "line_items", "total"],
  properties: {
    invoice_number: { type: "string", minLength: 1 },
    issue_date: { type: "string", format: "date" },
    currency: { type: "string", pattern: "^[A-Z]{3}$" },
    line_items: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["description", "quantity", "amount"],
        properties: {
          description: { type: "string" },
          quantity: { type: "number" },
          amount: { type: "number" },
        },
      },
    },
    total: { type: "number", minimum: 0 },
    note: { type: ["string", "null"] },
  },
};

const INVOICE = {
  invoice_number: "INV-2026-00417",
  issue_date: "[redacted]",
  currency: "USD",
  line_items: [
    { description: "Pallet wrapping film", quantity: 12, amount: 228 },
    { description: "Container handling", quantity: 3, amount: 735 },
    { description: "Cold storage (per day)", quantity: 5, amount: 277.5 },
  ],
  total: 1240.5,
  note: null,
};

function criteria(schema: Record<string, unknown> = INVOICE_SCHEMA, minScore = 100) {
  const c: JsonSchemaCriteria = {
    version: 1,
    kind: "json_schema",
    min_score: minScore,
    split: "winner_take_all",
    has_heldout: true,
    schema,
  };
  return c;
}

const check = (path: string, equals: unknown): Assertion => ({ path, equals });
const heldout = (...assertions: Assertion[]): JsonSchemaHeldout => ({ assertions });
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const json = (value: unknown): Uint8Array => bytes(JSON.stringify(value));

/** The three held-out checks of the invoice; the document `INVOICE` satisfies all of them. */
const INVOICE_CHECKS = heldout(
  check("$.invoice_number", "INV-2026-00417"),
  check("$.line_items[1].quantity", 3),
  check("$.total", 1240.5),
);

/** Scores `document` against the schema `{}` (anything fits) and one held-out check. */
function single(document: unknown, path: string, equals: unknown): EntryScore {
  return scoreJsonSchema(criteria({}), heldout(check(path, equals)), json(document));
}

// Written as a code point, so that the character can be seen in the source.
const REPLACEMENT_CHARACTER = String.fromCodePoint(0xfffd);

/** A tree: an array of arrays of arrays, as deep as the document goes. */
const TREE_SCHEMA = {
  $defs: { node: { type: "array", items: { $ref: "#/$defs/node" } } },
  $ref: "#/$defs/node",
};

const NOT_COMPILED = /^criteria schema cannot be compiled: /;
const NOT_EVALUATED = /^criteria schema cannot be evaluated: /;

/**
 * Schemas that cannot be used to score, with the start of the reason given for each. Some do not
 * compile. An `$async` schema compiles, but its validator returns a Promise, which is truthy
 * whatever the document. A dynamic reference to a name every object has compiles too, and then
 * throws when it is evaluated.
 */
const UNUSABLE: Record<string, { schema: Record<string, unknown>; reason: RegExp }> = {
  "an unknown type": { schema: { type: "banana" }, reason: NOT_COMPILED },
  "a reference that cannot be resolved": {
    schema: { $ref: "http://example.com/schema.json" },
    reason: NOT_COMPILED,
  },
  "a draft-07 $schema": {
    schema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object" },
    reason: NOT_COMPILED,
  },
  "a pattern that is not a regular expression": {
    schema: { type: "object", properties: { a: { pattern: "[" } } },
    reason: NOT_COMPILED,
  },
  "an async schema": {
    schema: { $async: true, type: "object", required: ["x"] },
    reason: NOT_COMPILED,
  },
  "an async schema whose flag is not literally true": {
    schema: { $async: "yes", type: "object", required: ["x"] },
    reason: NOT_COMPILED,
  },
  "a dynamic reference to constructor": {
    schema: { $dynamicRef: "#constructor" },
    reason: NOT_EVALUATED,
  },
  "a dynamic reference to __proto__": {
    schema: { $dynamicRef: "#__proto__" },
    reason: NOT_EVALUATED,
  },
  "a dynamic reference to valueOf": { schema: { $dynamicRef: "#valueOf" }, reason: NOT_EVALUATED },
};

/** The unhandled rejections Node reports while `work` runs, and for a moment after it. */
async function rejectionsDuring(work: () => void): Promise<unknown[]> {
  const seen: unknown[] = [];
  const record = (reason: unknown): void => {
    seen.push(reason);
  };
  process.on("unhandledRejection", record);
  try {
    work();
    // Node reports a rejection that nothing handles once the microtask queue has drained.
    await new Promise((resolve) => setTimeout(resolve, 25));
  } finally {
    process.off("unhandledRejection", record);
  }
  return seen;
}

afterEach(() => {
  vi.restoreAllMocks();
});

test("schema_failure_scores_zero_with_errors", () => {
  // Both held-out checks hold in every document below, so only the schema can score one 0.
  const checks = heldout(check("$.note", null), check("$.line_items[0].quantity", 12));

  // One violation: one error, written `instancePath message`.
  const oneError = { ...INVOICE, total: "1240.5" };
  expect(scoreJsonSchema(criteria(), checks, json(oneError))).toEqual({
    score: 0,
    passed: false,
    reasons: ["/total must be number"],
  });

  // Many violations: the first three errors, in the order Ajv finds them (the unknown key, then
  // the properties in schema order). The fourth, /total, is cut.
  const manyErrors = {
    ...INVOICE,
    extra: true,
    issue_date: "2026-02-31",
    currency: "usd",
    total: "1240.5",
  };
  expect(scoreJsonSchema(criteria(), checks, json(manyErrors))).toEqual({
    score: 0,
    passed: false,
    reasons: [
      "must NOT have additional properties",
      '/issue_date must match format "date"',
      '/currency must match pattern "^[A-Z]{3}$"',
    ],
  });

  // Deep inside the document, and a missing property.
  const nested = structuredClone(INVOICE);
  nested.line_items[1] = { description: "Container handling", quantity: 3, amount: "735" as never };
  expect(scoreJsonSchema(criteria(), checks, json(nested)).reasons).toEqual([
    "/line_items/1/amount must be number",
  ]);
  const { invoice_number: _removed, ...incomplete } = INVOICE;
  expect(scoreJsonSchema(criteria(), checks, json(incomplete)).reasons).toEqual([
    "must have required property 'invoice_number'",
  ]);
});

test("partial_assertions_round", () => {
  // The document fits the schema, and one of the three checked values is wrong.
  expect(scoreJsonSchema(criteria(), INVOICE_CHECKS, json({ ...INVOICE, total: 1240 }))).toEqual({
    score: 67,
    passed: false,
    reasons: ["$.total expected 1240.5"],
  });

  // One reason per failed check, in the order of the held-out document.
  const twoWrong = { ...INVOICE, invoice_number: "INV-1", total: 1240 };
  expect(scoreJsonSchema(criteria(), INVOICE_CHECKS, json(twoWrong))).toEqual({
    score: 33,
    passed: false,
    reasons: ['$.invoice_number expected "INV-2026-00417"', "$.total expected 1240.5"],
  });

  // Rounding: .5 goes up.
  const ratio = (passing: number, failing: number): number =>
    scoreJsonSchema(
      criteria({}),
      heldout(
        ...Array.from({ length: passing }, () => check("$.n", 1)),
        ...Array.from({ length: failing }, () => check("$.n", 2)),
      ),
      json({ n: 1 }),
    ).score;
  expect(ratio(2, 1)).toBe(67);
  expect(ratio(1, 2)).toBe(33);
  expect(ratio(5, 3)).toBe(63); // 62.5
  expect(ratio(7, 1)).toBe(88); // 87.5
  expect(ratio(0, 3)).toBe(0);
});

test("array_index_paths", () => {
  const document = {
    line_items: [
      { description: "a", amount: 10, tags: ["x", "y"] },
      { description: "b", amount: 20 },
    ],
  };

  expect(single(document, "$.line_items[0].amount", 10).score).toBe(100);
  expect(single(document, "$.line_items[1].amount", 20).score).toBe(100);
  expect(single(document, "$.line_items[0].tags[1]", "y").score).toBe(100);
  // The index matters: element 1 is not element 0.
  expect(single(document, "$.line_items[1].amount", 10).score).toBe(0);
  // There is no element 2, and the reason names the path as it was written.
  expect(single(document, "$.line_items[2].amount", 20)).toEqual({
    score: 0,
    passed: false,
    reasons: ["$.line_items[2].amount expected 20"],
  });

  // A path may start at an array, and `$` alone is the whole document.
  expect(single([[1], [2, 3]], "$[1][0]", 2).score).toBe(100);
  expect(single([[1], [2, 3]], "$[0][1]", 3).score).toBe(0);
  expect(single(document, "$", document).score).toBe(100);
});

test("deep_equal_objects", () => {
  const document = {
    line_items: [{ description: "Customs paperwork", quantity: 1, amount: 150 }],
    tags: ["x", "y"],
    nested: { a: { b: [1, { c: true }] } },
    note: null,
  };
  const item = "$.line_items[0]";
  const same = { description: "Customs paperwork", quantity: 1, amount: 150 };

  // Objects are equal by key set and values, whatever the order of the keys.
  expect(single(document, item, same).score).toBe(100);
  expect(
    single(document, item, { amount: 150, quantity: 1, description: same.description }).score,
  ).toBe(100);
  expect(single(document, item, { ...same, extra: 1 }).score).toBe(0);
  expect(single(document, item, { description: same.description, quantity: 1 }).score).toBe(0);
  expect(single(document, item, { ...same, amount: 151 }).score).toBe(0);

  // Arrays are equal by order and length.
  expect(single(document, "$.tags", ["x", "y"]).score).toBe(100);
  expect(single(document, "$.tags", ["y", "x"]).score).toBe(0);
  expect(single(document, "$.tags", ["x"]).score).toBe(0);
  expect(single(document, "$.tags", ["x", "y", "z"]).score).toBe(0);

  // The comparison goes all the way down.
  expect(single(document, "$.nested", { a: { b: [1, { c: true }] } }).score).toBe(100);
  expect(single(document, "$.nested", { a: { b: [1, { c: false }] } }).score).toBe(0);

  // Nothing is coerced, and an object is not an array even when both are empty.
  expect(single({ n: 3 }, "$.n", "3").score).toBe(0);
  expect(single({ ok: true }, "$.ok", 1).score).toBe(0);
  expect(single({ v: {} }, "$.v", []).score).toBe(0);
  expect(single({ v: [] }, "$.v", {}).score).toBe(0);

  // null equals null and nothing else; a key that is not there is not null.
  expect(single(document, "$.note", null).score).toBe(100);
  for (const other of [0, "", false, [], {}]) {
    expect(single(document, "$.note", other).score, JSON.stringify(other)).toBe(0);
  }
  expect(single(document, "$.absent", null).score).toBe(0);
});

test("not_json_scores_zero", () => {
  const notJson = [
    "",
    "   ",
    "not json",
    '{"total": 1,}',
    "{'total': 1}",
    "[1, 2",
    "NaN",
    "undefined",
    '{"a": 1} {"b": 2}',
    "\u0000",
  ];
  for (const text of notJson) {
    const result = scoreJsonSchema(criteria({}), heldout(check("$", 1)), bytes(text));
    expect(result, JSON.stringify(text)).toEqual({
      score: 0,
      passed: false,
      reasons: ["not JSON"],
    });
  }

  // JSON of the wrong type is a failure of the schema, not "not JSON".
  for (const text of ["null", "42", "[]", '"text"']) {
    const result = scoreJsonSchema(criteria(), INVOICE_CHECKS, bytes(text));
    expect(result.reasons, text).toEqual(["must be object"]);
  }
});

test("all_assertions_pass_scores_100", () => {
  expect(scoreJsonSchema(criteria(), INVOICE_CHECKS, json(INVOICE))).toEqual({
    score: 100,
    passed: true,
    reasons: [],
  });
});

test("inputs_are_not_modified", () => {
  const freeze = <T>(value: T): T => {
    if (typeof value === "object" && value !== null) {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  };
  const c = freeze(structuredClone(criteria()));
  const h = freeze(structuredClone(INVOICE_CHECKS));
  const content = json(INVOICE);
  const before = Array.from(content);

  const first = scoreJsonSchema(c, h, content);
  expect(first.score).toBe(100);
  // The same inputs give the same score, however often they are scored.
  expect(scoreJsonSchema(c, h, content)).toEqual(first);
  expect(Array.from(content)).toEqual(before);
});

test("invalid_utf8_scores_zero", () => {
  const c = criteria({ type: "object" });
  const checks = heldout(check("$.name", REPLACEMENT_CHARACTER));
  // A decoder that replaces bad bytes would read this as the name U+FFFD, which fits and matches.
  const raw = Uint8Array.from([...bytes('{"name":"'), 0xff, ...bytes('"}')]);

  expect(scoreJsonSchema(c, checks, raw)).toEqual({
    score: 0,
    passed: false,
    reasons: ["not valid UTF-8"],
  });
  // The same document, encoded properly, scores 100.
  expect(scoreJsonSchema(c, checks, bytes(`{"name":"${REPLACEMENT_CHARACTER}"}`)).score).toBe(100);
});

test("passed_means_score_reaches_min_score", () => {
  const twoOfThree = json({ ...INVOICE, total: 1240 });

  expect(scoreJsonSchema(criteria(INVOICE_SCHEMA, 67), INVOICE_CHECKS, twoOfThree)).toMatchObject({
    score: 67,
    passed: true,
  });
  expect(scoreJsonSchema(criteria(INVOICE_SCHEMA, 68), INVOICE_CHECKS, twoOfThree)).toMatchObject({
    score: 67,
    passed: false,
  });
  // A pass mark of 0 lets every entry through, a score of 0 included.
  expect(scoreJsonSchema(criteria(INVOICE_SCHEMA, 0), INVOICE_CHECKS, bytes("nope"))).toEqual({
    score: 0,
    passed: true,
    reasons: ["not JSON"],
  });
});

test("unusable_paths_never_match", () => {
  const content = bytes('{"a":[10,20],"b":5,"s":"text","__proto__":{"x":1}}');
  const at = (path: string, equals: unknown): number =>
    scoreJsonSchema(criteria({}), heldout(check(path, equals)), content).score;

  // Controls. A key called __proto__ is an ordinary key to JSON.parse, and to the path.
  expect(at("$.a[1]", 20)).toBe(100);
  expect(at("$.b", 5)).toBe(100);
  expect(at("$.__proto__.x", 1)).toBe(100);

  // Not in the syntax (`$`, then `.key` or `[n]`), though a looser parser would find a value.
  const malformed = [
    "b",
    "$b",
    "$.",
    "$.b.",
    "$..b",
    "$.a[",
    "$.a[0",
    "$.a[0]]",
    "$.a[]",
    "$.a[x]",
    "$.a[-1]",
    "$.a[00]",
    "$.a[+0]",
    "$.a[ 0 ]",
    "$.a['0']",
    '$["b"]',
    "$.a.0",
    " $.b",
    "$.b ",
  ];
  for (const path of malformed) {
    for (const equals of [10, 5]) expect(at(path, equals), `${path} = ${equals}`).toBe(0);
  }

  // Only the own keys of an object and the elements of an array can be reached: not an array's
  // length, a string's length or characters, or a member every object inherits.
  expect(at("$.a.length", 2)).toBe(0);
  expect(at("$.s.length", 4)).toBe(0);
  expect(at("$.s[0]", "t")).toBe(0);
  expect(at("$.constructor.name", "Object")).toBe(0);
  expect(at("$.a.constructor.name", "Array")).toBe(0);
});

test("unusable_schema_scores_zero", async () => {
  const rejections = await rejectionsDuring(() => {
    for (const [label, { schema, reason }] of Object.entries(UNUSABLE)) {
      // The held-out check holds for `{}`, so a score above 0 can only come from the schema.
      const result = scoreJsonSchema(criteria(schema), heldout(check("$", {})), json({}));
      expect(result.score, label).toBe(0);
      expect(result.passed, label).toBe(false);
      expect(result.reasons, label).toHaveLength(1);
      expect(result.reasons[0], label).toMatch(reason);
    }
  });

  // An async schema is never run: its validator would return a Promise, and that rejects with
  // nobody to handle it for every document that does not fit.
  expect(rejections).toEqual([]);
});

test("schema_check_rejects_unusable_schemas", async () => {
  const rejections = await rejectionsDuring(() => {
    for (const [label, { schema, reason }] of Object.entries(UNUSABLE)) {
      const usable = checkJsonSchemaUsable(schema);
      expect(usable.ok, label).toBe(false);
      if (!usable.ok) expect(usable.reason, label).toMatch(reason);
    }
  });
  expect(rejections).toEqual([]);

  // A schema that refers to itself without end overflows the stack on any document, even the
  // smallest, so the trial run finds it.
  expect(checkJsonSchemaUsable({ $ref: "#" })).toEqual({
    ok: false,
    reason: expect.stringMatching(NOT_EVALUATED),
  });

  // A schema may throw for some types of document only, so the trial has one of each type. Here
  // `then` is evaluated for documents of one type. (It is parsed from JSON text because Biome takes
  // a `then` in an object literal for a thenable; to the schema it is a keyword.)
  for (const type of ["null", "boolean", "number", "string", "array", "object"]) {
    const reachedByOneType = JSON.parse(
      `{"if":{"type":"${type}"},"then":{"$dynamicRef":"#constructor"}}`,
    );
    expect(checkJsonSchemaUsable(reachedByOneType).ok, type).toBe(false);
  }

  // Schemas the scorer can use. A trial document that does not fit is no reason to refuse, and
  // neither is a keyword or a format Ajv does not know: the check uses the scorer's own options.
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const workable = [
    INVOICE_SCHEMA,
    TREE_SCHEMA,
    {},
    { type: "object", required: ["a"] },
    { type: "string", minLength: 10 },
    { type: "string", format: "no-such-format", "x-note": "nobody knows this keyword" },
  ];
  for (const schema of workable) expect(checkJsonSchemaUsable(schema)).toEqual({ ok: true });
  expect(warn).not.toHaveBeenCalled();
});

test("formats_are_enforced", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const schema = {
    type: "object",
    properties: {
      day: { type: "string", format: "date" },
      other: { type: "string", format: "no-such-format" },
    },
  };
  const score = (document: unknown): EntryScore =>
    scoreJsonSchema(criteria(schema), heldout(check("$.other", "x")), json(document));

  // A real leap day fits, and a day that does not exist does not.
  expect(score({ day: "2024-02-29", other: "x" }).score).toBe(100);
  expect(score({ day: "2026-02-29", other: "x" })).toEqual({
    score: 0,
    passed: false,
    reasons: ['/day must match format "date"'],
  });
  // A format nobody knows is ignored, and scoring stays silent about it.
  expect(warn).not.toHaveBeenCalled();
});

test("inherited_keys_do_not_count", () => {
  // The held-out check holds for every document here, so only the schema can score one 0.
  const score = (schema: Record<string, unknown>, document: string): EntryScore =>
    scoreJsonSchema(criteria(schema), heldout(check("$", JSON.parse(document))), bytes(document));

  // `{}` has no key `toString`, though every object has a member of that name.
  expect(score({ required: ["toString"] }, "{}")).toEqual({
    score: 0,
    passed: false,
    reasons: ["must have required property 'toString'"],
  });
  expect(score({ dependentRequired: { a: ["valueOf"] } }, '{"a":1}').score).toBe(0);
  // And a key that is not there is not checked against its schema.
  expect(score({ properties: { constructor: { type: "string" } } }, "{}").score).toBe(100);
  // A key that is there is.
  expect(
    score({ properties: { constructor: { type: "string" } } }, '{"constructor":"x"}').score,
  ).toBe(100);
  expect(
    score({ properties: { constructor: { type: "string" } } }, '{"constructor":1}').score,
  ).toBe(0);
});

test("non_finite_numbers_fail", () => {
  // 1e999 is JSON syntax, but JSON.parse turns it into Infinity, which is no amount to pay on.
  const schema = {
    type: "object",
    properties: { total: { type: "number" }, count: { type: "integer" } },
  };
  const result = scoreJsonSchema(
    criteria(schema),
    heldout(check("$.total", 1)),
    bytes('{"total": 1e999, "count": -1e999}'),
  );

  expect(result).toEqual({
    score: 0,
    passed: false,
    reasons: ["/total must be number", "/count must be integer"],
  });
});

test("deep_nesting_scores_zero", () => {
  const tooDeep = { score: 0, passed: false, reasons: ["too deeply nested to validate"] };
  const checks = heldout(check("$", []));

  expect(
    scoreJsonSchema(criteria(TREE_SCHEMA), heldout(check("$[0][0]", [])), bytes("[[[]]]")).score,
  ).toBe(100);
  // JSON.parse reads this, and Ajv overflows the stack validating it: a result, not an exception.
  const deep = bytes("[".repeat(100_000) + "]".repeat(100_000));
  expect(scoreJsonSchema(criteria(TREE_SCHEMA), checks, deep)).toEqual(tooDeep);
  // A schema that refers to itself without end overflows the same way, for any document.
  expect(scoreJsonSchema(criteria({ $ref: "#" }), checks, bytes("{}"))).toEqual(tooDeep);
});

test("no_assertions_scores_zero", () => {
  // The held-out schema asks for at least one assertion. If none arrives, the score is 0, not
  // 100 * 0 / 0 = NaN, which would make the ranking depend on the sort.
  expect(scoreJsonSchema(criteria(), heldout(), json(INVOICE))).toEqual({
    score: 0,
    passed: false,
    reasons: ["held-out document has no assertions"],
  });
});
