import { z } from "zod";

/** Basis points in a whole. */
const BPS_WHOLE = 10_000;
/** The contract pays at most 5 winners (`MAX_WINNERS`), so a split has at most 5 shares. */
const MAX_SPLIT_SHARES = 5;
const SPLIT_RULE = `a split is "winner_take_all", "equal", or 1 to ${MAX_SPLIT_SHARES} whole shares in basis points, each above 0, that add up to ${BPS_WHOLE}`;

/** How many arrays and objects a JSON value in a document may be nested in, one inside another. */
const MAX_JSON_DEPTH = 64;

/**
 * Any JSON value, typed `unknown` because the Judge only compares these: null, a boolean, a finite
 * number, a string, or an array or plain object of such values. `undefined`, NaN and the
 * infinities are not JSON, so they fail, and a missing key fails like `undefined` does.
 *
 * It also fails a value nested more than 64 levels deep, and an object with an own `__proto__` key.
 * A schema that builds a new object cannot keep such a key (it would set the prototype, or skip
 * the key), and a document that lost a key hashes differently from the one that was sent. So
 * parsing returns the value it was given, not a copy, and never recurses: a value nested
 * thousands of levels deep fails like any other.
 */
export const JsonValueSchema: z.ZodType<unknown> = z.custom<unknown>(
  isJsonValue,
  `expected a JSON value, at most ${MAX_JSON_DEPTH} levels deep and with no "__proto__" key`,
);

/** Walks `root` with a stack of its own, so that nesting cannot overflow the call stack. */
function isJsonValue(root: unknown): boolean {
  // Each entry is a value and the number of arrays and objects around it.
  const pending: Array<[value: unknown, depth: number]> = [[root, 0]];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [value, depth] = next;
    if (value === null || typeof value === "string" || typeof value === "boolean") continue;
    if (typeof value === "number") {
      if (Number.isFinite(value)) continue;
      return false;
    }
    if (typeof value !== "object" || depth >= MAX_JSON_DEPTH) return false;

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const item: unknown = value[i];
        // A hole of a sparse array reads as `undefined`. Stopping here also keeps an array that
        // claims a length of billions from being walked to the end.
        if (item === undefined) return false;
        pending.push([item, depth + 1]);
      }
    } else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return false;
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record);
      if (keys.includes("__proto__") || Object.getOwnPropertySymbols(record).length > 0)
        return false;
      for (const key of keys) pending.push([record[key], depth + 1]);
    }
  }
  return true;
}

/** A JSON object: a `JsonValueSchema` value that is neither an array nor a scalar. */
const JsonObjectSchema = JsonValueSchema.refine(
  (value): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value),
  "expected a JSON object",
);

/** How a task's entries are scored. */
export const CriteriaKindSchema = z.enum([
  "exact",
  "json_schema",
  "regex_cases",
  "tests",
  "rubric",
]);
export type CriteriaKind = z.infer<typeof CriteriaKindSchema>;

/**
 * How the prize is shared among the winners: all to one, in equal parts, or in the listed shares,
 * in basis points. The shares are whole numbers above 0 (the contract refuses a winner with a
 * `bps` of 0), there are at most 5, and they add up to 10_000.
 */
const SplitSchema = z.union(
  [
    z.literal("winner_take_all"),
    z.literal("equal"),
    z.array(z.number()).refine(isShareList, SPLIT_RULE),
  ],
  { error: SPLIT_RULE },
);

function isShareList(shares: number[]): boolean {
  return (
    shares.length >= 1 &&
    shares.length <= MAX_SPLIT_SHARES &&
    shares.every((share) => Number.isInteger(share) && share >= 1) &&
    shares.reduce((sum, share) => sum + share, 0) === BPS_WHOLE
  );
}

/** The fields every kind of public criteria has. */
const common = {
  version: z.literal(1),
  /** The pass mark: an entry below it is not paid. */
  min_score: z.int().min(0).max(100),
  split: SplitSchema,
  /** Whether a held-out document stands behind these criteria (`heldout_commitment` on chain). */
  has_heldout: z.boolean(),
};

/**
 * The public half of a task's criteria: the part everyone, agents included, reads before they
 * work. It is stored as `canonicalJson` bytes, and the task's `criteria_hash` on chain is the
 * SHA-256 of them. A union on `kind`, and strict: a key a kind does not list fails.
 *
 * - `exact`: the answer is compared with the held-out answers after the `normalize` steps.
 * - `json_schema`: the answer must fit `schema`; the held-out assertions check values in it.
 * - `regex_cases`: the answer is a regex that must handle the example strings (and the held-out ones).
 * - `tests`: the answer is code that must pass the example cases (and the held-out ones).
 * - `rubric`: an LLM scores the answer against weighted criteria. There is no held-out part.
 */
export const PublicCriteriaSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("exact"),
    ...common,
    normalize: z.array(z.enum(["trim", "lowercase", "collapse_ws"])),
  }),
  z.strictObject({
    kind: z.literal("json_schema"),
    ...common,
    schema: JsonObjectSchema,
  }),
  z.strictObject({
    kind: z.literal("regex_cases"),
    ...common,
    examples: z.strictObject({ match: z.array(z.string()), no_match: z.array(z.string()) }),
  }),
  z.strictObject({
    kind: z.literal("tests"),
    ...common,
    language: z.literal("js"),
    /** The name of the function the answer defines. */
    entry: z.string().min(1),
    examples: z.array(z.strictObject({ input: JsonValueSchema, output: JsonValueSchema })),
  }),
  z.strictObject({
    kind: z.literal("rubric"),
    ...common,
    rubric: z
      .array(z.strictObject({ criterion: z.string().min(1), weight: z.int().min(1).max(10) }))
      .min(1),
  }),
]);
export type PublicCriteria = z.infer<typeof PublicCriteriaSchema>;

const ExactHeldoutSchema = z.strictObject({ expected: z.array(z.string()).min(1) });
const JsonSchemaHeldoutSchema = z.strictObject({
  assertions: z.array(z.strictObject({ path: z.string().min(1), equals: JsonValueSchema })).min(1),
});
const RegexCasesHeldoutSchema = z.strictObject({
  match: z.array(z.string()),
  no_match: z.array(z.string()),
});
const TestsHeldoutSchema = z.strictObject({
  cases: z.array(z.strictObject({ input: JsonValueSchema, output: JsonValueSchema })).min(1),
});

/** A held-out document: one key, the criteria kind, whose value has that kind's shape. */
export type Heldout =
  | { exact: z.infer<typeof ExactHeldoutSchema> }
  | { json_schema: z.infer<typeof JsonSchemaHeldoutSchema> }
  | { regex_cases: z.infer<typeof RegexCasesHeldoutSchema> }
  | { tests: z.infer<typeof TestsHeldoutSchema> };

const HELDOUT_RULE =
  "a held-out document has exactly one key: exact, json_schema, regex_cases or tests";

/**
 * The held-out half of a task's criteria: the hidden answers and cases the Judge scores with. It
 * is stored as `canonicalJson` bytes, the task's `heldout_commitment` on chain is the SHA-256 of
 * them, and the scorecard publishes the document so anyone can check that.
 *
 * An object with exactly one key, the criteria kind, whose value has that kind's shape:
 * `{"regex_cases": {"match": [...], "no_match": [...]}}`. A `rubric` has no held-out document.
 * The schema checks the shape; `heldoutMatchesCriteria` checks that the kind is the task's.
 *
 * The key picks the shape, so a mistake inside it is reported where it is, such as a missing
 * `regex_cases.no_match`, and not as a failure to match any of the four.
 */
export const HeldoutSchema = z
  .strictObject({
    exact: z.exactOptional(ExactHeldoutSchema),
    json_schema: z.exactOptional(JsonSchemaHeldoutSchema),
    regex_cases: z.exactOptional(RegexCasesHeldoutSchema),
    tests: z.exactOptional(TestsHeldoutSchema),
  })
  // Checked last, once the keys that are there are known and well formed, so it is the only
  // thing reported for `{}` and for two kinds at once.
  .refine((document) => Object.keys(document).length === 1, {
    error: HELDOUT_RULE,
    when: (payload) => payload.issues.length === 0,
  })
  // Exactly one of the four keys is set, so the document is one member of `Heldout`.
  .transform((document) => document as Heldout);

/**
 * Whether `heldout` is of the kind `criteria` asks for. A held-out document that is valid on its
 * own still belongs to another task if its kind differs. A `rubric` has no held-out part, so no
 * document matches it.
 */
export function heldoutMatchesCriteria(criteria: PublicCriteria, heldout: Heldout): boolean {
  const keys = Object.keys(heldout);
  return keys.length === 1 && keys[0] === criteria.kind;
}
