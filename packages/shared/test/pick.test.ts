import { expect, test } from "vitest";
import {
  canonicalJson,
  checkPickOnTask,
  checkPickScorecard,
  checkPickShares,
  HAND_PICK_REASON_MAX,
  HAND_PICK_SOFTWARE,
  type HandPickInput,
  handPickedScorecard,
  PickRefusal,
  type Scorecard,
  ScorecardSchema,
  scorecardUpload,
  sha256Hex,
  splitReward,
  type TaskDetailResponse,
} from "../src/index";

// The pick that the MCP tool and the web app both send: the checks before anything is published,
// the bytes that are published, the payout the contract makes, and the scorecard of a pick made by
// hand.

const CRITERIA = "22".repeat(32);
const HELDOUT = "33".repeat(32);
const HASH_A = "aa".repeat(32);
const HASH_B = "bb".repeat(32);
const HASH_C = "cc".repeat(32);

/**
 * A pick by hand, fixed in every field. The MCP's and the web app's tests build their scorecard
 * from this same input and hold it to the same hash (`HAND_PICK_HASH`), so that a change to how
 * either side writes or uploads a scorecard fails a test.
 */
const HAND_PICK: HandPickInput = {
  taskId: "7",
  picker: "poster.testnet",
  kind: "regex_cases",
  minScore: 80,
  criteriaHash: CRITERIA,
  heldoutCommitment: HELDOUT,
  entries: [
    {
      account: "bob.testnet",
      content_hash: HASH_B,
      uri: `http://api.test/v1/blobs/${HASH_B}`,
      committed_height: "120",
      revealed: true,
    },
    {
      account: "alice.testnet",
      content_hash: HASH_A,
      uri: `http://api.test/v1/blobs/${HASH_A}`,
      committed_height: "120",
      revealed: true,
    },
    {
      account: "carol.testnet",
      content_hash: null,
      uri: null,
      committed_height: "100",
      revealed: false,
    },
    {
      account: "dave.testnet",
      content_hash: HASH_C,
      uri: `http://api.test/v1/blobs/${HASH_C}`,
      committed_height: "90",
      revealed: true,
    },
  ],
  winners: [
    { account: "bob.testnet", bps: 6_000 },
    { account: "alice.testnet", bps: 4_000 },
  ],
  reasons: { "alice.testnet": "  Covers every case.  ", "dave.testnet": "" },
  now: new Date("2026-11-04T10:00:00.000Z"),
};

/** The SHA-256 of the scorecard of `HAND_PICK`, which `pick` records on chain. */
const HAND_PICK_HASH = "54ad6282bb3f35bdea6c7e6f77a3b2bde7576298e19ec3e785f797afb2942eb1";

function card(overrides: Partial<Scorecard> = {}): Scorecard {
  return { ...handPickedScorecard(HAND_PICK), ...overrides };
}

/** What `fn` throws, as a refusal: its code and its message. */
function refusal(fn: () => unknown): { code: string; message: string } {
  try {
    fn();
  } catch (error) {
    if (error instanceof PickRefusal) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error("expected a refusal");
}

function detail(overrides: Partial<TaskDetailResponse["task"]> = {}): TaskDetailResponse {
  const revealed = (account: string, hash: string) => ({
    account,
    entry_index: 0,
    committed_height: "120",
    content_hash: hash,
    uri: `http://api.test/v1/blobs/${hash}`,
    revealed: true,
    is_team: false,
  });
  return {
    task: {
      id: "7",
      title: "A task",
      category: null,
      tags: [],
      token: "tusdc.testnet",
      reward: "1000000",
      phase: "judging",
      poster: "poster.testnet",
      verifier: "poster.testnet",
      created_at: "1",
      commit_deadline: "2",
      reveal_deadline: "3",
      pick_deadline: "4",
      fallback_deadline: "5",
      commit_count: 3,
      reveal_count: 2,
      working_count: 0,
      judge_status: null,
      judge_reason: null,
      is_team_poster: false,
      parent: null,
      outcome_kind: null,
      brief_uri: "http://api.test/v1/blobs/brief",
      brief_hash: HASH_C,
      criteria_hash: CRITERIA,
      heldout_commitment: HELDOUT,
      max_entries: 0,
      max_winners: 2,
      invited: [],
      fee_bps: 500,
      outcome: null,
      ...overrides,
    },
    brief: null,
    criteria: null,
    entries: [revealed("alice.testnet", HASH_A), revealed("bob.testnet", HASH_B)],
    funders: [],
    children: [],
    scorecard: null,
  };
}

test("a_pick_by_hand_scores_its_winners_100_and_lists_every_revealed_entry_in_tie_break_order", () => {
  const scorecard = handPickedScorecard(HAND_PICK);

  expect(ScorecardSchema.parse(scorecard)).toEqual(scorecard);
  expect(scorecard).toMatchObject({
    version: 1,
    task_id: "7",
    verifier: "poster.testnet",
    kind: "regex_cases",
    criteria_hash: CRITERIA,
    heldout_commitment: HELDOUT,
    heldout: null,
    tie_break: "score desc, committed_at_block asc, account asc",
    winners: HAND_PICK.winners,
    generated_at: "2026-11-04T10:00:00.000Z",
    judge: { software: HAND_PICK_SOFTWARE, model: null },
  });
  // The winners first (100), then the rest (0); a tie on the score goes to the earlier block, and
  // one on the block to the smaller account. The entry that was not revealed is not scored.
  expect(
    scorecard.entries.map(({ account, score, passed, reasons }) => ({
      account,
      score,
      passed,
      reasons,
    })),
  ).toEqual([
    { account: "alice.testnet", score: 100, passed: true, reasons: ["Covers every case."] },
    { account: "bob.testnet", score: 100, passed: true, reasons: [] },
    { account: "dave.testnet", score: 0, passed: false, reasons: [] },
  ]);
  expect(scorecard.entries[2]).toMatchObject({
    content_hash: HASH_C,
    uri: `http://api.test/v1/blobs/${HASH_C}`,
    committed_at_block: "90",
  });

  // A pass mark of 0 is reached by a score of 0.
  const lenient = handPickedScorecard({ ...HAND_PICK, minScore: 0 });
  expect(lenient.entries.every((entry) => entry.passed)).toBe(true);
});

test("the_scorecard_of_a_pick_by_hand_is_the_same_bytes_for_the_same_input", () => {
  const upload = scorecardUpload(handPickedScorecard(HAND_PICK));

  expect(upload.kind).toBe("scorecard");
  expect(upload.contentType).toBe("application/json");
  expect(upload.bytes).toEqual(canonicalJson(handPickedScorecard(HAND_PICK)));
  expect(upload.hash).toBe(sha256Hex(upload.bytes));
  // Pinned: the MCP's and the web app's tests hold their own uploads of this input to it too.
  expect(upload.hash).toBe(HAND_PICK_HASH);
});

test("a_pick_by_hand_refuses_a_reason_that_is_too_long_and_mends_a_lone_surrogate", () => {
  const long = "x".repeat(HAND_PICK_REASON_MAX + 1);
  expect(() => handPickedScorecard({ ...HAND_PICK, reasons: { "alice.testnet": long } })).toThrow(
    RangeError,
  );
  expect(
    handPickedScorecard({
      ...HAND_PICK,
      reasons: { "alice.testnet": "x".repeat(HAND_PICK_REASON_MAX) },
    }).entries[0]?.reasons,
  ).toEqual(["x".repeat(HAND_PICK_REASON_MAX)]);

  const mended = handPickedScorecard({ ...HAND_PICK, reasons: { "alice.testnet": "a\ud800b" } });
  expect(mended.entries[0]?.reasons).toEqual(["a\u{FFFD}b"]);
  expect(() => canonicalJson(mended)).not.toThrow();
});

test("an_empty_pick_by_hand_scores_every_revealed_entry_0", () => {
  const scorecard = handPickedScorecard({ ...HAND_PICK, winners: [] });
  expect(scorecard.winners).toEqual([]);
  expect(scorecard.entries.map((entry) => entry.score)).toEqual([0, 0, 0]);
  // With every score the same, the order is by block, then account.
  expect(scorecard.entries.map((entry) => entry.account)).toEqual([
    "dave.testnet",
    "alice.testnet",
    "bob.testnet",
  ]);
});

test("a_scorecard_must_go_with_its_pick", () => {
  const pick = {
    taskId: "7",
    picker: "poster.testnet",
    judgeAccount: "judge.testnet",
    winners: HAND_PICK.winners,
  };
  expect(() => checkPickScorecard(card(), pick)).not.toThrow();

  expect(refusal(() => checkPickScorecard(card(), { ...pick, taskId: "8" }))).toEqual({
    code: "SCORECARD_MISMATCH",
    message: "the scorecard is for task 7, not task 8",
  });
  const other = refusal(() => checkPickScorecard(card(), { ...pick, picker: "mallory.testnet" }));
  expect(other.code).toBe("SCORECARD_MISMATCH");
  expect(other.message).toContain("poster.testnet as its verifier");
  expect(other.message).toContain("mallory.testnet");

  // Only the Judge's account may carry the Judge's name; with none set, nobody may.
  const branded = card({ judge: { software: "tender-judge/1", model: null } });
  expect(refusal(() => checkPickScorecard(branded, pick)).message).toMatch(/tender-judge/);
  expect(refusal(() => checkPickScorecard(branded, { ...pick, judgeAccount: null })).code).toBe(
    "SCORECARD_MISMATCH",
  );
  const asJudge = card({
    verifier: "judge.testnet",
    judge: { software: "tender-judge/1", model: null },
  });
  expect(() => checkPickScorecard(asJudge, { ...pick, picker: "judge.testnet" })).not.toThrow();

  // The winners are the scorecard's, in order and share by share.
  for (const winners of [
    [...HAND_PICK.winners].reverse(),
    [{ account: "bob.testnet", bps: 10_000 }],
    [
      { account: "bob.testnet", bps: 5_000 },
      { account: "alice.testnet", bps: 5_000 },
    ],
  ]) {
    expect(refusal(() => checkPickScorecard(card(), { ...pick, winners }))).toEqual({
      code: "SCORECARD_MISMATCH",
      message: "winners must be the scorecard's winners, in order",
    });
  }
});

test("the_shares_must_add_up_to_exactly_10000_and_name_each_account_once", () => {
  expect(() => checkPickShares([])).not.toThrow();
  expect(() => checkPickShares([{ account: "a.testnet", bps: 10_000 }])).not.toThrow();
  for (const [winners, message] of [
    [
      [{ account: "a.testnet", bps: 9_999 }],
      "the shares add up to 9999, and they must add up to exactly 10000",
    ],
    [
      [
        { account: "a.testnet", bps: 6_000 },
        { account: "b.testnet", bps: 5_000 },
      ],
      "the shares add up to 11000, and they must add up to exactly 10000",
    ],
    [
      [
        { account: "a.testnet", bps: 5_000 },
        { account: "a.testnet", bps: 5_000 },
      ],
      "a.testnet is named more than once",
    ],
  ] as const) {
    expect(refusal(() => checkPickShares(winners))).toEqual({ code: "INVALID_WINNERS", message });
  }
});

test("a_pick_rests_on_its_task_as_the_api_lists_it", () => {
  const winners = HAND_PICK.winners;
  expect(() => checkPickOnTask(detail(), { taskId: "7", winners, card: card() })).not.toThrow();

  expect(refusal(() => checkPickOnTask(null, { taskId: "7", winners, card: card() }))).toEqual({
    code: "NO_TASK",
    message: "the API has no task 7, so there is nothing to pick",
  });
  const criteria = refusal(() =>
    checkPickOnTask(detail({ criteria_hash: HASH_A }), { taskId: "7", winners, card: card() }),
  );
  expect(criteria.code).toBe("SCORECARD_MISMATCH");
  expect(criteria.message).toContain(`criteria_hash is not task 7's (${HASH_A})`);
  const heldout = refusal(() =>
    checkPickOnTask(detail({ heldout_commitment: null }), { taskId: "7", winners, card: card() }),
  );
  expect(heldout.message).toContain("null: the task has no held-out part");
  // An empty pick is held to the hashes too: its scorecard goes up all the same.
  expect(
    refusal(() =>
      checkPickOnTask(detail({ criteria_hash: HASH_A }), {
        taskId: "7",
        winners: [],
        card: card({ winners: [] }),
      }),
    ).code,
  ).toBe("SCORECARD_MISMATCH");

  expect(
    refusal(() =>
      checkPickOnTask(detail({ max_winners: 1 }), { taskId: "7", winners, card: card() }),
    ),
  ).toEqual({
    code: "INVALID_WINNERS",
    message: "task 7 pays at most 1 winners, and 2 were named",
  });
  const unrevealed = detail();
  unrevealed.entries = unrevealed.entries.map((entry) =>
    entry.account === "alice.testnet" ? { ...entry, revealed: false } : entry,
  );
  const late = refusal(() => checkPickOnTask(unrevealed, { taskId: "7", winners, card: card() }));
  expect(late.code).toBe("INVALID_WINNERS");
  expect(late.message).toMatch(/^alice\.testnet has no revealed entry in task 7/);
});

test("the_payout_is_the_contracts_split_reward", () => {
  // contract/tender/src/settle.rs, dust_goes_to_first_winner: 50_000.15 of fee rounds down, and the
  // 2 units of rounding go to the first winner.
  expect(splitReward(1_000_003n, 500, [3_333, 3_333, 3_334])).toEqual({
    fee: 50_000n,
    amounts: [316_637n, 316_635n, 316_731n],
    dust: 2n,
  });
  // pick_after_zero_fee_pays_full_reward.
  expect(splitReward(1_000_000n, 0, [7_000, 3_000])).toEqual({
    fee: 0n,
    amounts: [700_000n, 300_000n],
    dust: 0n,
  });
  // dust_pick_reward_one_two_winners.
  expect(splitReward(1n, 500, [5_000, 5_000])).toEqual({ fee: 0n, amounts: [1n, 0n], dust: 1n });
  // Nothing is made or lost, whatever the reward and the shares.
  for (const reward of [1n, 7n, 999_999n, 1_000_003n, 10n ** 30n + 17n]) {
    for (const bps of [
      [10_000],
      [1, 9_999],
      [3_334, 3_333, 3_333],
      [2_000, 2_000, 2_000, 2_000, 2_000],
    ]) {
      const { fee, amounts } = splitReward(reward, 1_000, bps);
      expect(fee + amounts.reduce((sum, amount) => sum + amount, 0n)).toBe(reward);
    }
  }
});
