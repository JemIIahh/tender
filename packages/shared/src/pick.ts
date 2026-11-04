import type { BlobUpload, TaskDetailResponse, TaskEntry } from "./api";
import { canonicalJson } from "./canonical";
import type { CriteriaKind } from "./criteria";
import { sha256Hex } from "./hash";
import { isJudgeBranded, type Scorecard, ScorecardSchema } from "./scorecard";

// A pick, as every client that sends one makes it: the checks a scorecard and its winners must pass
// before the scorecard is published, the bytes that are published, the payout the contract will
// make, and the scorecard of a pick made by hand. The MCP tool `pick_winners` and the web app's task
// page both build their pick from here, so that the same scorecard goes up the same way from either
// and is refused for the same reasons.
//
// A scorecard is public, immutable and pinned on chain by its hash, so everything that can be
// checked is checked before it is uploaded: a pick that the API or the chain then refused would
// leave the scorecard public all the same.

/** Basis points in a whole: the winners' shares of one pick add up to exactly this. */
export const PICK_BPS_WHOLE = 10_000;

/** A winner as `pick` takes it: an account and its share of the reward after the fee. */
export interface PickWinner {
  account: string;
  bps: number;
}

/**
 * Why a pick is refused before anything is published:
 * - `SCORECARD_MISMATCH`: the scorecard does not go with this pick or this task;
 * - `INVALID_WINNERS`: the winners break the contract's rules (`E_WINNERS`);
 * - `NO_TASK`: the API has no such task.
 */
export type PickRefusalCode = "SCORECARD_MISMATCH" | "INVALID_WINNERS" | "NO_TASK";

/** A pick that would be refused, with the reason in words. Nothing was published or sent. */
export class PickRefusal extends Error {
  readonly code: PickRefusalCode;

  constructor(code: PickRefusalCode, message: string) {
    super(message);
    this.name = "PickRefusal";
    this.code = code;
  }
}

/**
 * Throws a `PickRefusal` unless `card` goes with the pick: it is for task `taskId`, it names
 * `picker` as its verifier (the API publishes a scorecard only in the name of the account that
 * uploads it, P03-R29), it carries the Judge's name only if `picker` is the Judge's account, and its
 * winners are `winners`, account by account and share by share, in order. `card` has passed
 * `ScorecardSchema` already. An unset `judgeAccount` is no account, so then no scorecard may carry
 * the Judge's name.
 */
export function checkPickScorecard(
  card: Scorecard,
  pick: {
    taskId: string;
    picker: string;
    judgeAccount: string | null | undefined;
    winners: readonly PickWinner[];
  },
): void {
  if (card.task_id !== pick.taskId) {
    throw new PickRefusal(
      "SCORECARD_MISMATCH",
      `the scorecard is for task ${card.task_id}, not task ${pick.taskId}`,
    );
  }
  if (card.verifier !== pick.picker) {
    throw new PickRefusal(
      "SCORECARD_MISMATCH",
      `the scorecard names ${card.verifier} as its verifier, but the pick is sent as ` +
        `${pick.picker}, and a scorecard is published in the name of the account that picks ` +
        `with it. Make your own, naming ${pick.picker} as its verifier; do not reuse another's, ` +
        "the Judge's included",
    );
  }
  // The name is only a brand, and what the API holds to the Judge's account (P03-R29). Whose the
  // scorecard is, is the account that it names, and never what its software is called.
  if (isJudgeBranded(card.judge.software) && card.verifier !== pick.judgeAccount) {
    throw new PickRefusal(
      "SCORECARD_MISMATCH",
      "the scorecard's judge.software names the Tender Judge (tender-judge, in any case and " +
        "with or without punctuation), which only the Judge's account may use: name your own " +
        "software",
    );
  }
  const same =
    card.winners.length === pick.winners.length &&
    card.winners.every(
      (winner, index) =>
        winner.account === pick.winners[index]?.account && winner.bps === pick.winners[index]?.bps,
    );
  if (!same) {
    throw new PickRefusal(
      "SCORECARD_MISMATCH",
      "winners must be the scorecard's winners, in order",
    );
  }
}

/**
 * Throws a `PickRefusal` unless a non-empty `winners` has shares that add up to exactly 10,000 and
 * names no account twice: the part of the contract's `E_WINNERS` rules that needs nothing but the
 * winners. An empty `winners` awards nothing, and passes.
 */
export function checkPickShares(winners: readonly PickWinner[]): void {
  if (winners.length === 0) return;
  const total = winners.reduce((sum, winner) => sum + winner.bps, 0);
  if (total !== PICK_BPS_WHOLE) {
    throw new PickRefusal(
      "INVALID_WINNERS",
      `the shares add up to ${total}, and they must add up to exactly ${PICK_BPS_WHOLE}`,
    );
  }
  const named = new Set<string>();
  for (const { account } of winners) {
    if (named.has(account)) {
      throw new PickRefusal("INVALID_WINNERS", `${account} is named more than once`);
    }
    named.add(account);
  }
}

/**
 * Throws a `PickRefusal` unless the pick rests on task `taskId` as the API lists it (`detail`, null
 * when the API has no such task): the scorecard's `criteria_hash` and `heldout_commitment` are the
 * task's (the API refuses a scorecard whose are not, and would not show one that was stored), and,
 * for a non-empty pick, the task pays that many winners and each of them revealed an entry. The
 * hashes are held for an empty pick too, since its scorecard goes up all the same.
 *
 * The index can be a few blocks behind the chain, so an entry revealed a moment ago may not show
 * as revealed yet: the refusal says to wait and try again.
 */
export function checkPickOnTask(
  detail: TaskDetailResponse | null,
  pick: { taskId: string; winners: readonly PickWinner[]; card: Scorecard },
): void {
  const { taskId, winners, card } = pick;
  if (detail === null) {
    throw new PickRefusal("NO_TASK", `the API has no task ${taskId}, so there is nothing to pick`);
  }
  if (card.criteria_hash !== detail.task.criteria_hash) {
    throw new PickRefusal(
      "SCORECARD_MISMATCH",
      `the scorecard's criteria_hash is not task ${taskId}'s (${detail.task.criteria_hash}): ` +
        "copy it from the task. The API would refuse the scorecard, and would not show one " +
        "that is picked with",
    );
  }
  if (card.heldout_commitment !== detail.task.heldout_commitment) {
    throw new PickRefusal(
      "SCORECARD_MISMATCH",
      `the scorecard's heldout_commitment is not task ${taskId}'s ` +
        `(${detail.task.heldout_commitment ?? "null: the task has no held-out part"}): copy it ` +
        "from the task. The API would refuse the scorecard, and would not show one that is " +
        "picked with",
    );
  }
  if (winners.length === 0) return;

  const most = detail.task.max_winners;
  if (winners.length > most) {
    throw new PickRefusal(
      "INVALID_WINNERS",
      `task ${taskId} pays at most ${most} winners, and ${winners.length} were named`,
    );
  }
  for (const { account } of winners) {
    if (!detail.entries.some((entry) => entry.account === account && entry.revealed)) {
      throw new PickRefusal(
        "INVALID_WINNERS",
        `${account} has no revealed entry in task ${taskId}, as far as the API knows. Only an ` +
          "account that revealed can win; if it revealed a moment ago, the index may not have " +
          "caught up yet, so wait a few seconds and try again",
      );
    }
  }
}

/**
 * What a pick uploads for its scorecard: the `canonicalJson` bytes of `card`, as a scorecard blob
 * (`POST /v1/blobs`), and their SHA-256, which is the `scorecard_hash` that `pick` records on chain.
 * The API answers the upload with the address the scorecard is served at, which is the pick's
 * `scorecard_uri`.
 */
export function scorecardUpload(card: Scorecard): BlobUpload & { hash: string } {
  const bytes = canonicalJson(card);
  return { kind: "scorecard", contentType: "application/json", bytes, hash: sha256Hex(bytes) };
}

/**
 * The payout of a pick, as the contract makes it (`split_reward` in contract/tender/src/settle.rs):
 * the fee is `reward * feeBps / 10_000`, and each winner gets `net * bps / 10_000` of the
 * `net = reward - fee` that is left, all rounded down. The amounts then fall short of `net` by less
 * than one unit per winner, and that `dust` goes to the first winner, whose amount includes it, so
 * that the fee and the amounts add up to `reward` exactly. `bps` is in the winners' order. An empty
 * `bps` pays nobody: `amounts` is empty and `dust` is `net`, which a pick that awards nothing does
 * not pay out but refunds, with the fee, to the funders.
 */
export function splitReward(
  reward: bigint,
  feeBps: number,
  bps: readonly number[],
): { fee: bigint; amounts: bigint[]; dust: bigint } {
  const whole = BigInt(PICK_BPS_WHOLE);
  const fee = (reward * BigInt(feeBps)) / whole;
  const net = reward - fee;
  const amounts = bps.map((share) => (net * BigInt(share)) / whole);
  const dust = net - amounts.reduce((sum, amount) => sum + amount, 0n);
  if (amounts.length > 0) amounts[0] = (amounts[0] ?? 0n) + dust;
  return { fee, amounts, dust };
}

// ---- A pick by hand ---------------------------------------------------------------------------

/**
 * The `judge.software` of a scorecard written for a pick made by hand: a person chose the winners
 * on the web app, and no software scored the entries.
 */
export const HAND_PICK_SOFTWARE = "tender-web/1";

/** The most code points in the reason a person gives for an entry of a pick by hand. */
export const HAND_PICK_REASON_MAX = 200;

/** The tie-break every scorecard writes out. */
const TIE_BREAK = "score desc, committed_at_block asc, account asc" as const;

export interface HandPickInput {
  taskId: string;
  /** The account that picks, which the scorecard names as its verifier. */
  picker: string;
  /** The task's criteria, as the task's criteria document has them. */
  kind: CriteriaKind;
  minScore: number;
  /** The task's own hashes. */
  criteriaHash: string;
  heldoutCommitment: string | null;
  /** The task's entries as the API lists them. Only the revealed ones are scored. */
  entries: ReadonlyArray<
    Pick<TaskEntry, "account" | "content_hash" | "uri" | "committed_height" | "revealed">
  >;
  /** The winners, in the order `pick` is called with: the first gets the rounding dust. */
  winners: readonly PickWinner[];
  /** The reason the person gave for an entry, by account. Blank or missing gives none. */
  reasons?: Readonly<Record<string, string>>;
  now: Date;
}

/**
 * The scorecard of a pick made by hand, to publish with it. A person picks: nothing scored the
 * entries, so the scores are the pick written down, and the scorecard says so by its software
 * (`HAND_PICK_SOFTWARE`). Each revealed entry is listed: a winner with 100, anyone else with 0, and
 * `passed` when that reaches the criteria's pass mark (`minScore`). The entries are in the order the
 * tie-break names (score, then the earlier commit block, then the smaller account), and the
 * reason given for an entry, if any, is its one reason. The held-out document is not published:
 * `heldout` is null and `heldout_commitment` is the task's, which the page of the task shows as
 * "the verifier has not published the held-out checks".
 *
 * Throws a `RangeError` for a reason longer than `HAND_PICK_REASON_MAX` code points, which the
 * page's field does not let through, and whatever `ScorecardSchema` throws for a scorecard that does
 * not fit it: nothing that fails to parse may be published. The checks of the pick itself
 * (`checkPickScorecard`, `checkPickShares`, `checkPickOnTask`) are the caller's, as for any other
 * scorecard. The same input gives the same scorecard, `now` being one of it.
 */
export function handPickedScorecard(input: HandPickInput): Scorecard {
  const won = new Set(input.winners.map((winner) => winner.account));
  const scored = input.entries
    .filter((entry) => entry.revealed && entry.content_hash !== null && entry.uri !== null)
    .map((entry) => {
      const score = won.has(entry.account) ? 100 : 0;
      return {
        account: entry.account,
        content_hash: entry.content_hash ?? "",
        uri: entry.uri ?? "",
        committed_at_block: entry.committed_height,
        score,
        passed: score >= input.minScore,
        reasons: reasonOf(input.reasons?.[entry.account]),
      };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        compareBlocks(a.committed_at_block, b.committed_at_block) ||
        (a.account < b.account ? -1 : a.account > b.account ? 1 : 0),
    );
  const scorecard: Scorecard = {
    version: 1,
    task_id: input.taskId,
    verifier: input.picker,
    kind: input.kind,
    criteria_hash: input.criteriaHash,
    heldout_commitment: input.heldoutCommitment,
    heldout: null,
    tie_break: TIE_BREAK,
    entries: scored,
    winners: input.winners.map(({ account, bps }) => ({ account, bps })),
    generated_at: input.now.toISOString(),
    judge: { software: HAND_PICK_SOFTWARE, model: null },
  };
  // The bytes are written from this object and not from the copy the schema returns, so that what
  // is published is what was checked.
  ScorecardSchema.parse(scorecard);
  return scorecard;
}

/** Two block heights, u64 decimal strings, in order. */
function compareBlocks(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * The reasons of an entry: none for a blank one, else the reason trimmed and with each surrogate
 * half that has no partner replaced by U+FFFD, which `canonicalJson` would refuse.
 */
function reasonOf(text: string | undefined): string[] {
  const reason = (text ?? "").trim().replace(/\p{Cs}/gu, "\u{FFFD}");
  if (reason === "") return [];
  if ([...reason].length > HAND_PICK_REASON_MAX) {
    throw new RangeError(`a reason is at most ${HAND_PICK_REASON_MAX} characters`);
  }
  return [reason];
}
