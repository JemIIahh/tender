import {
  canonicalJson,
  type PublicCriteria,
  ScorecardSchema,
  sha256Hex,
  type TaskView,
} from "@tender/shared";
import { expect, test } from "vitest";
import {
  buildScorecard,
  chooseWinners,
  rankEntries,
  type ScoredEntry,
  scoreJsonSchema,
} from "../src/index";

// The shared package has no name for the type of a split, so it is taken from the criteria.
type Split = PublicCriteria["split"];
type ScorecardInput = Parameters<typeof buildScorecard>[0];

/** Basis points in a whole. */
const WHOLE = 10_000;
const MIN_SCORE = 50;

/** An entry as the scorers leave it: `passed` says whether `score` reaches `MIN_SCORE`. */
function entry(account: string, score: number, block = 100n): ScoredEntry {
  return {
    account,
    contentHash: sha256Hex(`the answer of ${account}`),
    uri: `https://tender.test/v1/blobs/${account}`,
    committedAtBlock: block,
    score,
    passed: score >= MIN_SCORE,
    reasons: score === 100 ? [] : [`scored ${score}`],
  };
}

/** `passing` entries that pass (p0.near, ...) and `failing` that do not (f0.near, ...), ranked. */
function field(passing: number, failing = 0): ScoredEntry[] {
  return rankEntries([
    ...Array.from({ length: passing }, (_, i) => entry(`p${i}.near`, 100 - i, BigInt(i))),
    ...Array.from({ length: failing }, (_, i) => entry(`f${i}.near`, MIN_SCORE - 1 - i, BigInt(i))),
  ]);
}

const criteriaOf = (split: Split) => ({ min_score: MIN_SCORE, split });
const accounts = (list: { account: string }[]): string[] => list.map((item) => item.account);
const shares = (list: { bps: number }[]): number[] => list.map((item) => item.bps);
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const codePoints = (value: string): number => Array.from(value).length;

const freeze = <T>(value: T): T => {
  if (typeof value === "object" && value !== null) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

/** Every order the items can be in. */
function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
  );
}

/** What `pick` demands of winners: other accounts, whole shares of 1 or more, 10_000 in all. */
function unpayable(winners: { account: string; bps: number }[]): string[] {
  const problems: string[] = [];
  if (new Set(accounts(winners)).size !== winners.length) problems.push("an account twice");
  for (const { bps } of winners) {
    if (!Number.isInteger(bps) || bps < 1) problems.push(`a share of ${bps}`);
  }
  const sum = shares(winners).reduce((total, bps) => total + bps, 0);
  if (sum !== WHOLE) problems.push(`shares add up to ${sum}`);
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------------------------

test("tie_break_is_deterministic", () => {
  // Score decides first: bob has the latest block of all and still leads, dan the earliest and
  // still trails. Of the three on 80, the earlier block comes first (7 before 9), and cat and zed
  // share block 7, so the smaller account decides.
  const entries = [
    entry("zed.near", 80, 7n),
    entry("amy.near", 80, 9n),
    entry("bob.near", 90, 12n),
    entry("cat.near", 80, 7n),
    entry("dan.near", 60, 1n),
  ];
  const order = ["bob.near", "cat.near", "zed.near", "amy.near", "dan.near"];

  // The chain lists entries by when their agent first committed, which says nothing about the
  // order of the ranking. Whatever order they arrive in, the ranking is the same.
  for (const arrival of permutations(entries)) {
    expect(accounts(rankEntries(arrival))).toEqual(order);
  }
  expect(rankEntries([])).toEqual([]);
});

test("ranking_compares_blocks_as_bigints", () => {
  // Each pair has the accounts the other way round, so a wrong block comparison shows.
  const lead = (a: ScoredEntry, b: ScoredEntry) => accounts(rankEntries([a, b]))[0];

  // As text, "10" sorts before "9".
  expect(lead(entry("a.near", 70, 10n), entry("b.near", 70, 9n))).toBe("b.near");
  // As Numbers, the two largest u64 values are the same value.
  const last = 2n ** 64n - 1n;
  expect(lead(entry("a.near", 70, last), entry("b.near", 70, last - 1n))).toBe("b.near");
});

test("ranking_compares_accounts_by_utf16_code_units", () => {
  // '-' (0x2D) < '1' (0x31) < '_' (0x5F). ICU's collation, which `localeCompare` uses here, puts
  // '_' first and '1' last, so a ranking built on it fails this.
  const ids = ["a-b.near", "a1.near", "a_b.near"];
  for (const arrival of permutations(ids.map((id) => entry(id, 70)))) {
    expect(accounts(rankEntries(arrival))).toEqual(ids);
  }
  // Real ids are ASCII, so this only pins the rule: by code unit, U+10000 (D800 DC00) is before
  // U+FF21, which is not the order of the code points.
  const astral = String.fromCodePoint(0x10000);
  const fullwidth = String.fromCodePoint(0xff21);
  expect(accounts(rankEntries([entry(fullwidth, 70), entry(astral, 70)]))).toEqual([
    astral,
    fullwidth,
  ]);
});

test("ranking_does_not_mutate_its_input", () => {
  const input = freeze([entry("b.near", 60), entry("a.near", 90)]);
  const ranked = rankEntries(input);

  expect(accounts(ranked)).toEqual(["a.near", "b.near"]);
  expect(accounts(input)).toEqual(["b.near", "a.near"]);
  expect(ranked).not.toBe(input);
});

// ---------------------------------------------------------------------------------------------
// Winners
// ---------------------------------------------------------------------------------------------

test("equal_split_three", () => {
  // 10_000 / 3 leaves 1 basis point over, and the first winner takes it.
  expect(chooseWinners(field(3), criteriaOf("equal"), 5)).toEqual([
    { account: "p0.near", bps: 3334 },
    { account: "p1.near", bps: 3333 },
    { account: "p2.near", bps: 3333 },
  ]);
});

test("array_split_renormalized_when_fewer_eligible", () => {
  const c = criteriaOf([7000, 3000]);
  const both = [
    { account: "p0.near", bps: 7000 },
    { account: "p1.near", bps: 3000 },
  ];

  // One entry passed, so the first place is filled and the second is not: it takes the whole.
  expect(chooseWinners(field(1, 2), c, 5)).toEqual([{ account: "p0.near", bps: 10_000 }]);
  // Both places filled: the shares as listed. A third entry that passed gets nothing.
  expect(chooseWinners(field(2), c, 5)).toEqual(both);
  expect(chooseWinners(field(4), c, 5)).toEqual(both);
  // The task pays one winner at most, so only the first place is filled.
  expect(chooseWinners(field(4), c, 1)).toEqual([{ account: "p0.near", bps: 10_000 }]);
});

test("none_eligible_returns_empty", () => {
  for (const split of ["winner_take_all", "equal", [6000, 4000]] satisfies Split[]) {
    expect(chooseWinners(field(0, 3), criteriaOf(split), 5)).toEqual([]);
    expect(chooseWinners([], criteriaOf(split), 5)).toEqual([]);
  }
});

test("winner_take_all_pays_the_best_passing_entry", () => {
  const c = criteriaOf("winner_take_all");

  expect(chooseWinners(field(3, 2), c, 5)).toEqual([{ account: "p0.near", bps: 10_000 }]);
  expect(chooseWinners(field(3, 2), c, 1)).toEqual([{ account: "p0.near", bps: 10_000 }]);
});

test("equal_split_is_limited_by_max_winners_and_by_passing_entries", () => {
  const c = criteriaOf("equal");

  expect(shares(chooseWinners(field(5), c, 2))).toEqual([5000, 5000]);
  // Two entries passed, three did not, and the task would pay up to five.
  expect(accounts(chooseWinners(field(2, 3), c, 5))).toEqual(["p0.near", "p1.near"]);
  expect(shares(chooseWinners(field(2, 3), c, 5))).toEqual([5000, 5000]);
  expect(shares(chooseWinners(field(4), c, 1))).toEqual([10_000]);
  expect(shares(chooseWinners(field(4), c, 4))).toEqual([2500, 2500, 2500, 2500]);
  expect(shares(chooseWinners(field(5), c, 5))).toEqual([2000, 2000, 2000, 2000, 2000]);
});

test("array_split_is_scaled_to_the_places_that_are_filled", () => {
  const c = criteriaOf([4000, 2500, 1500, 1200, 800]);

  // All five places: the shares as listed.
  expect(shares(chooseWinners(field(5), c, 5))).toEqual([4000, 2500, 1500, 1200, 800]);
  // Four places: 4000, 2500, 1500 and 1200 scaled by 10_000 / 9200 and rounded down add up to
  // 9998, and the first winner takes the 2 that are left.
  expect(shares(chooseWinners(field(5), c, 4))).toEqual([4349, 2717, 1630, 1304]);
  // Three places: exactly 5000, 3125 and 1875. Two places: 6153 and 3846, and 1 over.
  expect(shares(chooseWinners(field(5), c, 3))).toEqual([5000, 3125, 1875]);
  expect(shares(chooseWinners(field(5), c, 2))).toEqual([6154, 3846]);
  expect(shares(chooseWinners(field(5), c, 1))).toEqual([10_000]);
  // The same when it is the entries that run out, not the task's limit.
  expect(shares(chooseWinners(field(3, 4), c, 5))).toEqual([5000, 3125, 1875]);

  // Rounded down, not to the nearest: 2000 and 5000 of 7000 are 2857.14 and 7142.86 in 10_000.
  // Rounding would give 2857 and 7143. Rounding down gives 2857 and 7142, and the first winner
  // takes the 1 that is left.
  const skewed = criteriaOf([2000, 5000, 3000]);
  expect(shares(chooseWinners(field(3), skewed, 2))).toEqual([2858, 7142]);
});

test("only_entries_that_passed_can_win", () => {
  // The ranking puts the 95 first, but it did not pass, so it is not paid.
  const ranked = rankEntries([
    { ...entry("a.near", 95), passed: false },
    entry("b.near", 70),
    entry("c.near", 60),
  ]);

  expect(chooseWinners(ranked, criteriaOf("winner_take_all"), 3)).toEqual([
    { account: "b.near", bps: 10_000 },
  ]);
  expect(accounts(chooseWinners(ranked, criteriaOf("equal"), 3))).toEqual(["b.near", "c.near"]);
});

test("max_winners_below_one_pays_nobody", () => {
  const splits: Split[] = [
    "winner_take_all",
    "equal",
    [7000, 3000],
    [2000, 2000, 2000, 2000, 2000],
  ];

  for (const split of splits) {
    // A negative number must not reach `slice`, which would count it from the end.
    for (const max of [0, -1, -100, 0.5]) {
      expect(chooseWinners(field(3), criteriaOf(split), max), `${split} / ${max}`).toEqual([]);
    }
  }
});

test("winners_do_not_touch_the_ranking", () => {
  const ranked = freeze(field(3, 1));

  expect(accounts(chooseWinners(ranked, criteriaOf("equal"), 5))).toEqual([
    "p0.near",
    "p1.near",
    "p2.near",
  ]);
  expect(accounts(ranked)).toEqual(["p0.near", "p1.near", "p2.near", "f0.near"]);
});

test("shares_add_up_to_a_whole_and_none_is_zero", () => {
  const problems: string[] = [];

  // `equal`, with 1 to 5 winners.
  for (let n = 1; n <= 5; n++) {
    const winners = chooseWinners(field(5), criteriaOf("equal"), n);
    if (winners.length !== n) problems.push(`equal / ${n}: ${winners.length} winners`);
    problems.push(...unpayable(winners).map((problem) => `equal / ${n}: ${problem}`));
  }

  // Five shares, cut to the first 1 to 4 by the task's limit and by the number of entries that
  // passed. 9996/1/1/1/1 and its mirror are the hardest: one big share, and four of 1 basis point.
  const lists = [
    [2000, 2000, 2000, 2000, 2000],
    [4000, 2500, 1500, 1200, 800],
    [9996, 1, 1, 1, 1],
    [1, 1, 1, 1, 9996],
    [3334, 3333, 1, 1, 3331],
  ];
  for (const list of lists) {
    for (let n = 1; n <= 4; n++) {
      const label = `${list.join("/")} cut to ${n}`;
      for (const winners of [
        chooseWinners(field(5), criteriaOf(list), n),
        chooseWinners(field(n, 5 - n), criteriaOf(list), 5),
      ]) {
        if (winners.length !== n) problems.push(`${label}: ${winners.length} winners`);
        problems.push(...unpayable(winners).map((problem) => `${label}: ${problem}`));
      }
    }
  }

  expect(problems).toEqual([]);
});

test("winner_count_is_the_fewest_of_places_limit_and_passing_entries", () => {
  const placesIn = (split: Split): number => {
    if (split === "winner_take_all") return 1;
    return split === "equal" ? Number.POSITIVE_INFINITY : split.length;
  };
  const splits: Split[] = ["winner_take_all", "equal", [7000, 3000], [4000, 2500, 1500, 1200, 800]];

  for (const split of splits) {
    for (let passing = 0; passing <= 7; passing++) {
      for (let max = 0; max <= 7; max++) {
        const winners = chooseWinners(field(passing, 2), criteriaOf(split), max);
        const count = Math.min(placesIn(split), passing, max);
        const label = `${split} with ${passing} passing, up to ${max}`;

        // The best entries that passed, in the order of the ranking.
        expect(accounts(winners), label).toEqual(
          Array.from({ length: count }, (_, i) => `p${i}.near`),
        );
        if (count > 0) expect(unpayable(winners), label).toEqual([]);
      }
    }
  }
});

test("shares_match_exact_arithmetic_for_any_split", () => {
  // Every split of 1 to 5 shares whose first shares come from a few awkward values (tiny, odd and
  // large ones) and whose last share is what is left of 10_000.
  const pool = [1, 2, 3, 7, 100, 999, 2000, 3333, 5000];
  const splits: number[][] = [];
  const extend = (head: number[]): void => {
    const left = WHOLE - head.reduce((sum, share) => sum + share, 0);
    splits.push([...head, left]);
    if (head.length === 4) return;
    for (const share of pool) if (share < left) extend([...head, share]);
  };
  extend([]);
  // The same sum in BigInt, where division is exact: the first `n` shares scaled to a whole and
  // rounded down, the rest going to the first.
  const reference = (split: number[], n: number): number[] => {
    const kept = split.slice(0, n).map(BigInt);
    const total = kept.reduce((sum, share) => sum + share, 0n);
    const floored = kept.map((share) => (share * BigInt(WHOLE)) / total);
    const left = BigInt(WHOLE) - floored.reduce((sum, share) => sum + share, 0n);
    return floored.map((share, i) => Number(i === 0 ? share + left : share));
  };

  // Not a sweep of nothing.
  expect(splits.length).toBeGreaterThan(5000);
  const ranked = field(5);
  const problems: string[] = [];
  for (const split of splits) {
    for (let n = 1; n <= split.length; n++) {
      const winners = chooseWinners(ranked, criteriaOf(split), n);
      const label = `${split.join("/")} cut to ${n}`;

      if (JSON.stringify(shares(winners)) !== JSON.stringify(reference(split, n))) {
        problems.push(`${label}: ${shares(winners)} instead of ${reference(split, n)}`);
      }
      problems.push(...unpayable(winners).map((problem) => `${label}: ${problem}`));
    }
  }

  expect(problems).toEqual([]);
});

// ---------------------------------------------------------------------------------------------
// Scorecards
// ---------------------------------------------------------------------------------------------

const HELDOUT = { exact: { expected: ["42", "forty-two"] } };
const HELDOUT_COMMITMENT = sha256Hex(canonicalJson(HELDOUT));
const NOW = new Date("2026-10-30T12:34:56.789Z");

const TASK: TaskView = {
  id: "42",
  poster: "poster.near",
  token: "usdc.near",
  reward: "5000000",
  fee_bps: 500,
  brief_uri: "https://tender.test/v1/blobs/brief",
  brief_hash: sha256Hex("brief"),
  criteria_hash: sha256Hex("criteria"),
  heldout_commitment: HELDOUT_COMMITMENT,
  verifier: "judge.near",
  created_at: "1793307169820229000",
  commit_deadline: "1793307289820229000",
  reveal_deadline: "1793307409820229000",
  pick_deadline: "1793307529820229000",
  fallback_deadline: "1793307649820229000",
  max_entries: 0,
  max_winners: 2,
  invited: [],
  parent: null,
  commit_count: 3,
  reveal_count: 3,
  cleaned: 0,
  funders: [{ account: "poster.near", amount: "5000000" }],
  outcome: null,
  phase: "judging",
};

const AMY = entry("amy.near", 100, 5n);
const BOB = entry("bob.near", 80, 6n);
const CAT = entry("cat.near", 20, 7n);

/** A judged task: three entries, two winners (70% and 30%), and a held-out document. */
function scorecardInput(overrides: Partial<ScorecardInput> = {}): ScorecardInput {
  const ranked = rankEntries([CAT, AMY, BOB]);
  return {
    task: TASK,
    kind: "exact",
    criteriaHash: TASK.criteria_hash,
    heldoutCommitment: HELDOUT_COMMITMENT,
    heldout: HELDOUT,
    ranked,
    winners: chooseWinners(ranked, criteriaOf([7000, 3000]), TASK.max_winners),
    model: null,
    now: NOW,
    ...overrides,
  };
}

/**
 * `scorecardInput` for a task whose held-out part is `heldout`, committed to the way it is on
 * chain: the task and the scorecard both carry the SHA-256 of the document's canonical bytes.
 */
function heldoutInput(heldout: unknown, overrides: Partial<ScorecardInput> = {}): ScorecardInput {
  const commitment = sha256Hex(canonicalJson(heldout));
  return scorecardInput({
    task: { ...TASK, heldout_commitment: commitment },
    heldout,
    heldoutCommitment: commitment,
    ...overrides,
  });
}

/** The scorecard as a reader gets it: the bytes parsed as JSON, with nothing converted back. */
const published = (bytes: Uint8Array): Record<string, unknown> => JSON.parse(text(bytes));

/** The bytes of a scorecard with one entry, scored with `reasons`. */
function scoredWith(...reasons: string[]): Uint8Array {
  const crowded = { ...entry("amy.near", 10), reasons };
  return buildScorecard(scorecardInput({ ranked: [freeze(crowded)], winners: [] }));
}

/** The reasons that scorecard gives its one entry. */
function reasonsIn(bytes: Uint8Array): string[] {
  const [first] = (published(bytes) as { entries: { reasons: string[] }[] }).entries;
  return first?.reasons ?? [];
}

/**
 * A `\uD800` to `\uDFFF` escape in JSON text, which is how a string with a surrogate half that has
 * no partner is written. The backslash must not itself be escaped: `\\ud800` is the text of one.
 */
const SURROGATE_ESCAPE = /(?<!\\)(?:\\\\)*\\u[dD][89a-fA-F][0-9a-fA-F]{2}/;

/** `value` with the keys of every plain object put in the opposite order. */
function reverseKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reverseKeys) as T;
  if (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    const members = Object.entries(value).reverse();
    return Object.fromEntries(members.map(([key, member]) => [key, reverseKeys(member)])) as T;
  }
  return value;
}

test("scorecard_validates_and_is_byte_stable", () => {
  // Frozen, so that building the scorecard cannot change what it was built from.
  const bytes = buildScorecard(freeze(structuredClone(scorecardInput())));

  // The schema is strict: it fails on a missing key, an extra one or a wrong type.
  ScorecardSchema.parse(published(bytes));
  // The bytes are canonical: written again from their own contents they come out the same.
  expect(canonicalJson(published(bytes))).toEqual(bytes);

  // The same inputs give the same bytes, whether they are the same objects, copies, or objects
  // whose keys were put together in another order. So the hash that `pick` records is the same.
  expect(buildScorecard(scorecardInput())).toEqual(bytes);
  expect(buildScorecard(reverseKeys(scorecardInput()))).toEqual(bytes);
  expect(sha256Hex(buildScorecard(reverseKeys(scorecardInput())))).toBe(sha256Hex(bytes));
  // The clock is an input too: `generated_at` is part of the bytes.
  expect(buildScorecard(scorecardInput({ now: new Date(NOW.getTime() + 1) }))).not.toEqual(bytes);
});

test("scorecard_fields_come_from_the_inputs", () => {
  expect(published(buildScorecard(scorecardInput()))).toEqual({
    version: 1,
    task_id: "42",
    verifier: "judge.near",
    kind: "exact",
    criteria_hash: TASK.criteria_hash,
    heldout_commitment: HELDOUT_COMMITMENT,
    heldout: HELDOUT,
    tie_break: "score desc, committed_at_block asc, account asc",
    // In the order given, which is the ranking.
    entries: [
      {
        account: "amy.near",
        content_hash: AMY.contentHash,
        uri: AMY.uri,
        committed_at_block: "5",
        score: 100,
        passed: true,
        reasons: [],
      },
      {
        account: "bob.near",
        content_hash: BOB.contentHash,
        uri: BOB.uri,
        committed_at_block: "6",
        score: 80,
        passed: true,
        reasons: ["scored 80"],
      },
      {
        account: "cat.near",
        content_hash: CAT.contentHash,
        uri: CAT.uri,
        committed_at_block: "7",
        score: 20,
        passed: false,
        reasons: ["scored 20"],
      },
    ],
    winners: [
      { account: "amy.near", bps: 7000 },
      { account: "bob.near", bps: 3000 },
    ],
    generated_at: "2026-10-30T12:34:56.789Z",
    judge: { software: "tender-judge/1", model: null },
  });

  // A task with no held-out part has neither the document nor its commitment, and a `rubric`
  // task names the model that scored it. A pick that awards nothing, or a task nobody revealed
  // an entry in, has empty lists.
  expect(
    published(
      buildScorecard(
        scorecardInput({
          task: { ...TASK, heldout_commitment: null },
          kind: "rubric",
          heldout: null,
          heldoutCommitment: null,
          model: "judge-model-1",
          winners: [],
        }),
      ),
    ),
  ).toMatchObject({
    kind: "rubric",
    heldout: null,
    heldout_commitment: null,
    winners: [],
    judge: { software: "tender-judge/1", model: "judge-model-1" },
  });
  expect(published(buildScorecard(scorecardInput({ ranked: [], winners: [] })))).toMatchObject({
    entries: [],
    winners: [],
  });
});

test("scorecard_publishes_the_heldout_document_exactly", () => {
  // Anyone can hash the published document and compare it with `heldout_commitment`. A key such
  // as `__proto__` is valid JSON, and an own property once parsed, but a copy made by assignment
  // (a schema's, say) loses it, and the check would then fail for a document that was committed.
  const equals = '{"__proto__":{"a":1},"constructor":2,"10":3,"9":4}';
  const heldout = JSON.parse(`{"json_schema":{"assertions":[{"path":"$.x","equals":${equals}}]}}`);
  // Control: the document does carry the key.
  expect(JSON.stringify(heldout)).toContain('"__proto__"');
  const commitment = sha256Hex(canonicalJson(heldout));

  // The hash check that `buildScorecard` makes is made on the document as given too, so this
  // document, which a copy would change, is not refused as a mismatch.
  const bytes = buildScorecard(heldoutInput(heldout, { kind: "json_schema" }));

  const shown = (published(bytes) as { heldout: unknown }).heldout;
  expect(sha256Hex(canonicalJson(shown))).toBe(commitment);
});

test("scorecard_numbers_follow_r19", () => {
  // Above 2^53 a JSON number loses digits, so ids and blocks are written as decimal strings.
  const last = 2n ** 64n - 1n;
  const late = entry("late.near", 90, last);
  const scorecard = published(
    buildScorecard(
      scorecardInput({
        task: { ...TASK, id: "18446744073709551615" },
        ranked: [AMY, late],
        winners: [
          { account: "amy.near", bps: 6000 },
          { account: "late.near", bps: 4000 },
        ],
      }),
    ),
  ) as { task_id: unknown; entries: Record<string, unknown>[]; winners: Record<string, unknown>[] };

  expect(scorecard.task_id).toBe("18446744073709551615");
  expect(scorecard.entries.map((e) => e.committed_at_block)).toEqual(["5", "18446744073709551615"]);
  // Scores and shares stay JSON integers.
  for (const { score } of scorecard.entries) expect(Number.isInteger(score)).toBe(true);
  for (const { bps } of scorecard.winners) expect(Number.isInteger(bps)).toBe(true);
  expect(scorecard.entries.map((e) => e.score)).toEqual([100, 90]);
  expect(scorecard.winners.map((w) => w.bps)).toEqual([6000, 4000]);
});

test("scorecard_reasons_are_clamped", () => {
  // The pattern that finds surrogate escapes in the bytes: it finds an escape, and not the text
  // of one that a backslash escaped, and it stops at the edges of the surrogate range.
  expect(SURROGATE_ESCAPE.test('"\\ud800"')).toBe(true);
  expect(SURROGATE_ESCAPE.test('"\\uDFFF"')).toBe(true);
  expect(SURROGATE_ESCAPE.test('"\\\\ud800"')).toBe(false);
  expect(SURROGATE_ESCAPE.test('"\\ud7ff \\ue000 \\u0041"')).toBe(false);

  // At most 3 reasons: the first 3, in order.
  expect(reasonsIn(scoredWith("one", "two", "three", "four", "five"))).toEqual([
    "one",
    "two",
    "three",
  ]);
  expect(reasonsIn(scoredWith())).toEqual([]);

  // A reason of 200 code points or fewer is kept as it is. 200 emoji are 400 UTF-16 units, so
  // they show that it is code points that are counted.
  const kept = ["e".repeat(200), "😀".repeat(200), ""];
  expect(reasonsIn(scoredWith(...kept))).toEqual(kept);

  // A surrogate half with no partner: a high one should lead a pair and a low one end it.
  const HIGH = "\ud800";
  const LOW = "\udc00";
  const REPLACEMENT = "\uFFFD";
  const cases: [string, string, string][] = [
    // A longer reason is cut to its first 199 code points and ends with `…`: 200 in all.
    ["201 letters", "y".repeat(201), `${"y".repeat(199)}…`],
    // Cutting at 199 UTF-16 units would leave half of the first emoji, a surrogate with no partner.
    ["a pair at the cut", `${"x".repeat(198)}${"😀".repeat(3)}`, `${"x".repeat(198)}😀…`],
    ["201 emoji", "😀".repeat(201), `${"😀".repeat(199)}…`],
    ["300,000 letters", "k".repeat(300_000), `${"k".repeat(199)}…`],

    // A reason an agent shaped can hold such a half: Ajv names the keys of the agent's JSON in its
    // messages, and a key written as the escape \ud800 is one. JSON that a standard reader accepts
    // has none, so each is replaced by U+FFFD, one for one, and the limit of 200 stays what it was.
    ["a lone high half", HIGH, REPLACEMENT],
    ["a lone low half", LOW, REPLACEMENT],
    // A low half and then a high half is the wrong way round for a pair: both are alone.
    ["two halves the wrong way round", `${LOW}${HIGH}`, `${REPLACEMENT}${REPLACEMENT}`],
    ["a message about a key", `/${HIGH} must be string`, `/${REPLACEMENT} must be string`],
    // A pair is a character like any other and stays whole, next to a half or not.
    ["a pair", `${HIGH}${LOW}`, "\u{10000}"],
    ["a lone half before a pair", `${HIGH}😀`, `${REPLACEMENT}😀`],
    // 199 emoji and a half are 200 code points but 399 UTF-16 units: kept, not cut, and repaired.
    ["a lone half as the 200th", `${"😀".repeat(199)}${HIGH}`, `${"😀".repeat(199)}${REPLACEMENT}`],
    // The cut keeps the first 199 code points, so a half that is the 199th stays (as U+FFFD).
    [
      "a lone high half as code point 199",
      `${"x".repeat(198)}${HIGH}${"y".repeat(5)}`,
      `${"x".repeat(198)}${REPLACEMENT}…`,
    ],
    [
      "a lone low half as code point 199",
      `${"x".repeat(198)}${LOW}${"y".repeat(5)}`,
      `${"x".repeat(198)}${REPLACEMENT}…`,
    ],
    [
      "a lone half and a pair at the cut",
      `${"x".repeat(197)}${HIGH}😀tail`,
      `${"x".repeat(197)}${REPLACEMENT}😀…`,
    ],
    ["a lone half past the cut", `${"x".repeat(250)}${HIGH}`, `${"x".repeat(199)}…`],
  ];
  for (const [label, reason, expected] of cases) {
    const bytes = scoredWith(reason);
    const clamped = reasonsIn(bytes)[0] ?? "";

    expect(clamped, label).toBe(expected);
    // 200 code points at most, and a reason that fits keeps all of its own.
    expect(codePoints(clamped), label).toBe(Math.min(codePoints(reason), 200));
    expect(/\p{Cs}/u.test(clamped), `${label}: a surrogate with no partner`).toBe(false);
    expect(SURROGATE_ESCAPE.test(text(bytes)), `${label}: an escape in the bytes`).toBe(false);
  }
});

test("scorecard_has_no_lone_surrogate_from_the_keys_of_an_answer", () => {
  // The case that matters: an agent's answer is JSON whose only key is the escape \ud800. Ajv
  // names the key in its message, so the scorer's reason carries the lone surrogate, and
  // `JSON.stringify` would write it into the scorecard as an escape that a strict JSON reader
  // (Rust's serde_json, say) refuses, so that the whole scorecard could not be read.
  const criteria: Extract<PublicCriteria, { kind: "json_schema" }> = {
    kind: "json_schema",
    version: 1,
    min_score: MIN_SCORE,
    split: "winner_take_all",
    has_heldout: true,
    schema: { type: "object", additionalProperties: { type: "string" } },
  };
  const heldout = { json_schema: { assertions: [{ path: "$.x", equals: "y" }] } };
  const answer = new TextEncoder().encode('{"\\ud800": 1}');
  const scored = scoreJsonSchema(criteria, heldout.json_schema, answer);
  // Control: the scorer does hand over a reason with the half in it.
  expect(scored.reasons.some((reason) => /\p{Cs}/u.test(reason))).toBe(true);

  const bytes = buildScorecard(
    heldoutInput(heldout, {
      kind: "json_schema",
      ranked: [{ ...entry("amy.near", 0), ...scored }],
      winners: [],
    }),
  );

  expect(SURROGATE_ESCAPE.test(text(bytes))).toBe(false);
  // What the scorecard says is what the scorer said, with U+FFFD for the half.
  expect(reasonsIn(bytes)).toEqual(
    scored.reasons.slice(0, 3).map((reason) => reason.replace(/\p{Cs}/gu, "\uFFFD")),
  );
});

test("scorecard_hashes_must_match_the_task", () => {
  // The task says what its criteria and held-out part hash to, and the Judge is handed the same
  // hashes again with the documents. If the two disagree, or the held-out document is not the
  // one committed to, nobody could check the scorecard, so it throws and nothing is published.
  const other = sha256Hex("not the hash on chain");
  const noHeldout = { ...TASK, heldout_commitment: null };

  const refused: [string, Partial<ScorecardInput>, RegExp][] = [
    [
      "criteria that are not the task's",
      { criteriaHash: other },
      /criteriaHash is not the criteria_hash of task 42/,
    ],
    [
      "a commitment that is not the task's",
      { heldoutCommitment: other },
      /heldoutCommitment is not the heldout_commitment of task 42/,
    ],
    [
      "no commitment, for a task that has one",
      { heldoutCommitment: null, heldout: null },
      /heldoutCommitment is not the heldout_commitment of task 42/,
    ],
    [
      "a commitment, for a task that has none",
      { task: noHeldout },
      /heldoutCommitment is not the heldout_commitment of task 42/,
    ],
    [
      "a document that is not the one committed to",
      { heldout: { exact: { expected: ["43", "forty-three"] } } },
      /held-out document does not hash to heldoutCommitment/,
    ],
    [
      "a document and no commitment",
      { task: noHeldout, heldoutCommitment: null },
      /held-out document does not hash to heldoutCommitment/,
    ],
    [
      "a commitment and no document",
      { heldout: null },
      /heldoutCommitment is set but there is no held-out document/,
    ],
  ];
  for (const [label, overrides, message] of refused) {
    expect(() => buildScorecard(scorecardInput(overrides)), label).toThrow(message);
  }

  // Controls: hashes that agree build, with a document and without one. A document with a
  // `__proto__` key is hashed as it was given: see
  // scorecard_publishes_the_heldout_document_exactly.
  expect(() => buildScorecard(scorecardInput())).not.toThrow();
  expect(() =>
    buildScorecard(
      scorecardInput({ task: noHeldout, kind: "rubric", heldout: null, heldoutCommitment: null }),
    ),
  ).not.toThrow();
});

test("scorecard_rejects_what_the_schema_rejects", () => {
  // A scorecard that does not fit the schema is a bug in the Judge, not something an agent wrote:
  // it throws, naming the field, and nothing is published. The names are in quotes, as the schema
  // writes a path, so that only the schema's error can match: the task's hashes are checked too.
  const capitals = "AB".repeat(32);
  const refused: [string, Partial<ScorecardInput>, RegExp][] = [
    ["a share of 0", { winners: [{ account: "amy.near", bps: 0 }] }, /"bps"/],
    ["a share above a whole", { winners: [{ account: "amy.near", bps: 10_001 }] }, /"bps"/],
    ["a share that is not whole", { winners: [{ account: "amy.near", bps: 99.5 }] }, /"bps"/],
    [
      "a hash in capitals",
      { task: { ...TASK, criteria_hash: capitals }, criteriaHash: capitals },
      /"criteria_hash"/,
    ],
    ["a block below 0", { ranked: [entry("amy.near", 70, -1n)] }, /"committed_at_block"/],
    ["a block above u64", { ranked: [entry("amy.near", 70, 2n ** 64n)] }, /"committed_at_block"/],
    ["a score above 100", { ranked: [entry("amy.near", 101)] }, /"score"/],
    ["a held-out part that is not JSON", { heldout: { exact: undefined } }, /"heldout"/],
    ["a clock that is not a time", { now: new Date(Number.NaN) }, /Invalid time value/],
  ];

  for (const [label, overrides, message] of refused) {
    expect(() => buildScorecard(scorecardInput(overrides)), label).toThrow(message);
  }
  // Control: the same inputs without a fault build.
  expect(() => buildScorecard(scorecardInput())).not.toThrow();
});
