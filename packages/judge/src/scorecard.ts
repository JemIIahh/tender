import {
  type CriteriaKind,
  canonicalJson,
  type Scorecard,
  ScorecardSchema,
  sha256Hex,
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
 * the Judge, not something an agent wrote, and nothing that fails to parse may be published. It
 * throws too when the hashes do not agree: `criteriaHash` and `heldoutCommitment` have to be the
 * task's own, and a `heldout` document has to hash to `heldoutCommitment` (a commitment needs its
 * document), so that a scorecard nobody could check is never published. The block of an entry is
 * written as a decimal string, as the views write every u64.
 *
 * `heldout` is the document that `heldoutCommitment` stands for, as parsed from its bytes, and it
 * is written as it is given. It has to be a value that the shared `JsonValueSchema` takes (JSON
 * only, with no `__proto__` key and not nested too deeply), and this throws when it is not.
 *
 * An agent does write the text of a reason: Ajv, for one, puts the keys of the agent's JSON in its
 * messages. So each entry keeps at most 3 reasons, each at most 200 code points; one that is
 * longer is cut and ends with `…`. A surrogate half with no partner in a reason, which a key
 * written as `\ud800` leaves in an Ajv message, is replaced by U+FFFD, so that the bytes are text
 * any JSON reader takes. A reader must still escape reasons when it shows them.
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
  // The schema and the hash checks look at the scorecard built here, and the bytes are written
  // from that same object, not from the copy the schema returns, so that what is published is what
  // was checked.
  ScorecardSchema.parse(scorecard);
  checkHashes(input.task, input.criteriaHash, input.heldoutCommitment, input.heldout);
  return canonicalJson(scorecard);
}

/**
 * Throws unless `criteriaHash` and `heldoutCommitment` are the task's own, and `heldout` is the
 * document that `heldoutCommitment` stands for. The schema does not ask for this: a scorecard that
 * fails it parses, and then nobody who reads it can check it.
 */
function checkHashes(
  task: TaskView,
  criteriaHash: string,
  heldoutCommitment: string | null,
  heldout: unknown,
): void {
  if (criteriaHash !== task.criteria_hash) {
    throw new Error(`criteriaHash is not the criteria_hash of task ${task.id}`);
  }
  if (heldoutCommitment !== task.heldout_commitment) {
    throw new Error(`heldoutCommitment is not the heldout_commitment of task ${task.id}`);
  }
  if (heldout === null) {
    // A task with no held-out part has neither the document nor its commitment.
    if (heldoutCommitment !== null) {
      throw new Error("heldoutCommitment is set but there is no held-out document");
    }
    return;
  }
  // The commitment is the SHA-256 of the document's canonical bytes.
  if (sha256Hex(canonicalJson(heldout)) !== heldoutCommitment) {
    throw new Error("the held-out document does not hash to heldoutCommitment");
  }
}

/**
 * `reason` made well-formed, or its first 199 code points and `…` when it has more than 200. Only
 * the start of the text is read, however long an agent made it.
 */
function clampReason(reason: string): string {
  // A string has no more code points than UTF-16 units, so this one is short enough as it is.
  if (reason.length <= MAX_REASON_CODE_POINTS) return wellFormed(reason);

  // `for...of` walks code points, so the cut never lands inside a surrogate pair. One more than
  // the limit is enough to tell that the reason is longer, and the rest is not read.
  const kept: string[] = [];
  for (const codePoint of reason) {
    kept.push(codePoint);
    if (kept.length > MAX_REASON_CODE_POINTS) break;
  }
  if (kept.length <= MAX_REASON_CODE_POINTS) return wellFormed(reason);
  return wellFormed(`${kept.slice(0, MAX_REASON_CODE_POINTS - 1).join("")}…`);
}

/**
 * `text` with each surrogate half that has no partner replaced by U+FFFD. Such a string has no
 * UTF-8 form, and `JSON.stringify` writes it as an escape (`\ud800`) that is not I-JSON and that a
 * strict reader, Rust's serde_json for one, refuses. One code point for one, so lengths counted in
 * code points do not change. (`String.prototype.toWellFormed` does this, but the TypeScript library
 * this package compiles against does not declare it.)
 */
function wellFormed(text: string): string {
  return text.replace(/\p{Cs}/gu, "\uFFFD");
}
