import { z } from "zod";
import { CriteriaKindSchema, JsonValueSchema } from "./criteria";
import { AccountIdSchema, HashHexSchema, U64StringSchema } from "./primitives";

/**
 * What a `judge.software` may be: 1 to 64 of the ASCII letters, digits, `.`, `_`, `/` and `-`. No
 * space, and nothing outside ASCII, so no other hyphen or zero-width character can pass for one of
 * these (P03-R29).
 */
const SOFTWARE_NAME = /^[A-Za-z0-9._/-]{1,64}$/;

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
  /** When the verifier wrote the scorecard, ISO 8601 with a time zone. */
  generated_at: z.iso.datetime({ offset: true }),
  /**
   * What produced the scores. Any account a task names as its verifier may publish a scorecard, so
   * `software` is a name and not one fixed value: the team's Judge writes `tender-judge/1`, and
   * another verifier names its own software, since none may claim to be the Judge. It is 1 to 64
   * characters of ASCII letters, digits, `.`, `_`, `/` and `-`, with no space. That leaves no
   * look-alike of the Judge's name to fold (another hyphen, a zero-width character): see
   * `isJudgeBranded`, which tells the Judge's name from the rest, and which the API holds to the
   * Judge's account.
   */
  judge: z.strictObject({
    software: z
      .string()
      .regex(
        SOFTWARE_NAME,
        "expected 1 to 64 characters from A-Z, a-z, 0-9, '.', '_', '/' and '-'",
      ),
    /** The model that scored a `rubric` task, `null` when none did. */
    model: z.string().nullable(),
  }),
});
export type Scorecard = z.infer<typeof ScorecardSchema>;

/**
 * Whether `software` is the team's Judge's name: lowercased, with everything that is not a letter or
 * a digit taken out, it starts with `tenderjudge`. So `tender-judge/1`, `Tender_Judge` and
 * `TENDERJUDGE-x` are, and `my-judge` and `tender-agent` are not. Only the Judge's account may
 * publish a scorecard with such a name (the API refuses it from any other, P03-R29), and the MCP
 * server and the web are meant to tell the Judge's scorecards from the rest with this one function
 * as well, so that they agree.
 *
 * `ScorecardSchema` takes ASCII only for `software`, so on a scorecard that parsed there is nothing
 * to fold but case and punctuation. The function does not lean on that for what sits between the
 * letters: whatever is not an ASCII letter or digit is taken out, another hyphen or a zero-width
 * character included. A letter of another script that stands in for one of the name's is no such
 * letter, and only the schema keeps it out.
 */
export function isJudgeBranded(software: string): boolean {
  return software
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .startsWith("tenderjudge");
}
