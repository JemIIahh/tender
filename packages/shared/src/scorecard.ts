import { z } from "zod";
import { CriteriaKindSchema, JsonValueSchema } from "./criteria";
import { AccountIdSchema, HashHexSchema, U64StringSchema } from "./views";

/** One revealed entry's result. */
const ScorecardEntrySchema = z.strictObject({
  account: AccountIdSchema,
  content_hash: HashHexSchema,
  uri: z.string().min(1),
  /** The entry's block as a decimal string, as in `EntryView`. */
  committed_at_block: U64StringSchema,
  score: z.int().min(0).max(100),
  /** Whether `score` reaches the criteria's `min_score`. */
  passed: z.boolean(),
  /** Why the entry got its score, one line each. */
  reasons: z.array(z.string()),
});

/**
 * The scorecard a verifier publishes with `pick`: how every revealed entry scored, who won, and
 * what the scores rest on. It is stored as `canonicalJson` bytes, and the `scorecard_hash` that
 * `pick` records on chain is the SHA-256 of them.
 *
 * Anyone can check it. `criteria_hash` is the task's. `heldout` is the published held-out
 * document, and the SHA-256 of its `canonicalJson` bytes is `heldout_commitment`; for a task with
 * no held-out part both are `null`. The schema does not check that hash: a verifier that publishes
 * a document that does not match its commitment is something to report, not a parse failure.
 * `heldout` is any JSON value here; parse it with `HeldoutSchema` to use it.
 *
 * Ids, block heights and other u64 values are decimal strings, as in the views; `score` and `bps`
 * are JSON integers. The schema is strict, so a key it does not list fails.
 */
export const ScorecardSchema = z.strictObject({
  version: z.literal(1),
  task_id: U64StringSchema,
  verifier: AccountIdSchema,
  kind: CriteriaKindSchema,
  criteria_hash: HashHexSchema,
  heldout_commitment: HashHexSchema.nullable(),
  heldout: JsonValueSchema,
  /** How equal scores are ordered, written out so a reader can re-run the ranking. */
  tie_break: z.literal("score desc, committed_at_block asc, account asc"),
  entries: z.array(ScorecardEntrySchema),
  /** What `pick` was called with. Empty for a pick that awards nothing. */
  winners: z.array(
    z.strictObject({
      account: AccountIdSchema,
      /** The winner's share of the reward after the fee, in basis points. */
      bps: z.int().min(1).max(10_000),
    }),
  ),
  /** When the Judge wrote the scorecard, ISO 8601 with a time zone. */
  generated_at: z.iso.datetime({ offset: true }),
  judge: z.strictObject({
    software: z.literal("tender-judge/1"),
    /** The model that scored a `rubric` task, `null` when none did. */
    model: z.string().nullable(),
  }),
});
export type Scorecard = z.infer<typeof ScorecardSchema>;
