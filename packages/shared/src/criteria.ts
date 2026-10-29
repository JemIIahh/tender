import { z } from "zod";

/** Basis points in a whole. */
const BPS_WHOLE = 10_000;
/** The contract pays at most 5 winners (`MAX_WINNERS`), so a split has at most 5 shares. */
const MAX_SPLIT_SHARES = 5;
const SPLIT_RULE = `a split is "winner_take_all", "equal", or 1 to ${MAX_SPLIT_SHARES} whole shares in basis points, each above 0, that add up to ${BPS_WHOLE}`;

/**
 * Any JSON value, typed `unknown` because the Judge only compares these. `undefined`, NaN and the
 * infinities are not JSON, so they fail, and a missing key fails like `undefined` does.
 */
export const JsonValueSchema: z.ZodType<unknown> = z.json();

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
    schema: z.record(z.string(), JsonValueSchema),
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

/**
 * The held-out half of a task's criteria: the hidden answers and cases the Judge scores with. It
 * is stored as `canonicalJson` bytes, the task's `heldout_commitment` on chain is the SHA-256 of
 * them, and the scorecard publishes the document so anyone can check that.
 *
 * An object with exactly one key, the criteria kind, whose value has that kind's shape:
 * `{"regex_cases": {"match": [...], "no_match": [...]}}`. A `rubric` has no held-out document.
 * The schema checks the shape; `heldoutMatchesCriteria` checks that the kind is the task's.
 */
export const HeldoutSchema = z.union([
  z.strictObject({ exact: z.strictObject({ expected: z.array(z.string()).min(1) }) }),
  z.strictObject({
    json_schema: z.strictObject({
      assertions: z
        .array(z.strictObject({ path: z.string().min(1), equals: JsonValueSchema }))
        .min(1),
    }),
  }),
  z.strictObject({
    regex_cases: z.strictObject({ match: z.array(z.string()), no_match: z.array(z.string()) }),
  }),
  z.strictObject({
    tests: z.strictObject({
      cases: z.array(z.strictObject({ input: JsonValueSchema, output: JsonValueSchema })).min(1),
    }),
  }),
]);
export type Heldout = z.infer<typeof HeldoutSchema>;

/** The kinds that have a held-out document. */
export type HeldoutKind = Exclude<CriteriaKind, "rubric">;

/**
 * Whether `heldout` is of the kind `criteria` asks for. A held-out document that is valid on its
 * own still belongs to another task if its kind differs. A `rubric` has no held-out part, so no
 * document matches it.
 */
export function heldoutMatchesCriteria(criteria: PublicCriteria, heldout: Heldout): boolean {
  const keys = Object.keys(heldout);
  return keys.length === 1 && keys[0] === criteria.kind;
}
