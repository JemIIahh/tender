import {
  type CriteriaKind,
  canonicalJson,
  type Scorecard,
  ScorecardSchema,
  type TaskView,
} from "@tender/shared";
import type { ScoredEntry } from "./rank";

/** The most reasons an entry keeps on the scorecard. */
const MAX_REASONS = 3;
/** The most code points in a reason on the scorecard, the `…` of a cut one included. */
const MAX_REASON_CODE_POINTS = 200;

/**
 * The scorecard of a judged task, as the bytes the Judge stores: `canonicalJson` of a `Scorecard`.
 * The SHA-256 of these bytes is the `scorecard_hash` that `pick` records on chain.
 *
 * `ranked` is the output of `rankEntries` and is listed as it comes, so the order of `entries` is
 * the ranking the scorecard's `tie_break` describes. `winners` is what `pick` is called with.
 * `heldout` and `heldoutCommitment` are both `null` for a task with no held-out part. `model` is
 * the model that scored a `rubric` task, `null` when none did. The same inputs give the same
 * bytes, `now` being one of them.
 *
 * The scorecard has to fit `ScorecardSchema`, and this throws when it does not. That is a bug in
 * the Judge, not something an agent wrote, and nothing that fails to parse may be published. The
 * block of an entry is written as a decimal string, as the views write every u64.
 *
 * An agent does write the text of a reason: Ajv, for one, puts the keys of the agent's JSON in its
 * messages. So each entry keeps at most 3 reasons, each at most 200 code points; one that is
 * longer is cut and ends with `…`. A reader must still escape reasons when it shows them.
 */
export function buildScorecard(input: {
  task: TaskView;
  kind: CriteriaKind;
  criteriaHash: string;
  heldoutCommitment: string | null;
  heldout: unknown | null;
  ranked: ScoredEntry[];
  winners: { account: string; bps: number }[];
  model: string | null;
  now: Date;
}): Uint8Array {
  const scorecard: Scorecard = {
    version: 1,
    task_id: input.task.id,
    verifier: input.task.verifier,
    kind: input.kind,
    criteria_hash: input.criteriaHash,
    heldout_commitment: input.heldoutCommitment,
    heldout: input.heldout,
    tie_break: "score desc, committed_at_block asc, account asc",
    entries: input.ranked.map((entry) => ({
      account: entry.account,
      content_hash: entry.contentHash,
      uri: entry.uri,
      committed_at_block: entry.committedAtBlock.toString(),
      score: entry.score,
      passed: entry.passed,
      reasons: entry.reasons.slice(0, MAX_REASONS).map(clampReason),
    })),
    winners: input.winners,
    generated_at: input.now.toISOString(),
    judge: { software: "tender-judge/1", model: input.model },
  };
  return canonicalJson(ScorecardSchema.parse(scorecard));
}

/** `reason`, or its first 199 code points and `…` when it has more than 200. */
function clampReason(reason: string): string {
  // `Array.from` walks code points, so the cut never lands inside a surrogate pair.
  const codePoints = Array.from(reason);
  if (codePoints.length <= MAX_REASON_CODE_POINTS) return reason;
  return `${codePoints.slice(0, MAX_REASON_CODE_POINTS - 1).join("")}…`;
}
