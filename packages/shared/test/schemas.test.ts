import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import type { ZodType } from "zod";
import {
  AccountIdSchema,
  AgentViewSchema,
  BriefSchema,
  ConfigViewSchema,
  canonicalJson,
  DelegateViewSchema,
  EntryViewSchema,
  formatTokenAmount,
  HashHexSchema,
  HeldoutSchema,
  heldoutMatchesCriteria,
  NETWORKS,
  PhaseSchema,
  PublicCriteriaSchema,
  parseTokenAmount,
  ScorecardSchema,
  StorageViewSchema,
  sha256Hex,
  TaskViewSchema,
  tokenMeta,
  U64StringSchema,
  U128StringSchema,
} from "../src/index";

const FIXTURES = new URL("./fixtures/", import.meta.url);

/** A view sample captured from the contract's wasm: `test/fixtures/<name>.json`. */
function sample(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), "utf8"));
}

/** The dotted paths zod reports for `value`, and nothing when it parses. */
function failures(schema: ZodType, value: unknown): string[] {
  const result = schema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join("."));
}

const accepts = (schema: ZodType, value: unknown): boolean => schema.safeParse(value).success;
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const U64_MAX = "18446744073709551615";
const U128_MAX = "340282366920938463463374607431768211455";
const HASH = "ab".repeat(32);
// Digits that are not ASCII. A parser that takes any Unicode digit for a digit would accept them.
const ARABIC_INDIC_THREE = String.fromCodePoint(0x0663);
const FULLWIDTH_ONE = String.fromCodePoint(0xff11);

// ---------------------------------------------------------------------------------------------
// Views: the real samples
// ---------------------------------------------------------------------------------------------
// A schema drops keys it does not know, so `parse(sample)` equal to `sample` shows that the
// schema names every field the contract sends. A field added to a contract view fails these.

test("task_view_accepts_contract_sample", () => {
  const real = sample("task_view");
  const parsed = TaskViewSchema.parse(real);
  expect(parsed).toEqual(real);
  expect(parsed.phase).toBe("settled");
  expect(parsed.outcome?.kind).toBe("picked");
});

test("entry_view_accepts_contract_sample", () => {
  const real = sample("entry_view");
  expect(EntryViewSchema.parse(real)).toEqual(real);
});

test("agent_view_accepts_contract_sample", () => {
  const real = sample("agent_view");
  expect(AgentViewSchema.parse(real)).toEqual(real);
});

test("config_view_accepts_contract_sample", () => {
  const real = sample("config_view");
  expect(ConfigViewSchema.parse(real)).toEqual(real);
});

test("storage_view_accepts_contract_sample", () => {
  const real = sample("storage_view");
  expect(StorageViewSchema.parse(real)).toEqual(real);
});

// ---------------------------------------------------------------------------------------------
// Views: variants derived from the real samples
// ---------------------------------------------------------------------------------------------
// The sandbox run produced one instance of each view. The cases it did not produce are copies of
// the real sample with only the named fields changed.

test("task_view_accepts_unsettled_task_derived", () => {
  // Derived: the real task as it looks before `pick`.
  const open = { ...sample("task_view"), outcome: null, phase: "open" };
  expect(TaskViewSchema.parse(open)).toEqual(open);
  // Derived again: nobody invited so entries are unlimited, no held-out checks, a parent task.
  const loose = { ...open, invited: [], max_entries: 0, heldout_commitment: null, parent: "7" };
  expect(TaskViewSchema.parse(loose)).toEqual(loose);
});

test("task_view_accepts_voided_outcomes_derived", () => {
  const real = sample("task_view");
  const picked = real.outcome as { scorecard_hash: string; scorecard_uri: string };
  // Derived: `void_task` stores no scorecard, so both scorecard fields are null.
  const byVoidTask = {
    ...real,
    outcome: { kind: "voided", reason: "expired", scorecard_hash: null, scorecard_uri: null },
  };
  expect(TaskViewSchema.parse(byVoidTask)).toEqual(byVoidTask);
  // Derived: a `pick` with no winners voids the task and keeps its scorecard (the hash and URI
  // are the real pick's).
  const byEmptyPick = {
    ...real,
    outcome: {
      kind: "voided",
      reason: "no_award",
      scorecard_hash: picked.scorecard_hash,
      scorecard_uri: picked.scorecard_uri,
    },
  };
  expect(TaskViewSchema.parse(byEmptyPick)).toEqual(byEmptyPick);
  const noReveals = { ...byVoidTask, outcome: { ...byVoidTask.outcome, reason: "no_reveals" } };
  expect(accepts(TaskViewSchema, noReveals)).toBe(true);
});

test("entry_view_accepts_unrevealed_entry_derived", () => {
  // Derived: until `reveal` the contract sends null for the content hash and the URI.
  const hidden = { ...sample("entry_view"), content_hash: null, uri: null };
  expect(EntryViewSchema.parse(hidden)).toEqual(hidden);
});

test("agent_view_accepts_agent_without_provider_derived", () => {
  // Derived: an account with no parent account has `asp: null`; a new agent has no tags or earnings.
  const solo = { ...sample("agent_view"), asp: null, tags: [], earned: [] };
  expect(AgentViewSchema.parse(solo)).toEqual(solo);
});

test("config_view_accepts_pending_owner_derived", () => {
  // Derived: while an ownership transfer waits for acceptance, and with the contract paused.
  const handover = {
    ...sample("config_view"),
    pending_owner: "next-owner.test.near",
    paused: true,
  };
  expect(ConfigViewSchema.parse(handover)).toEqual(handover);
});

// Hand-written, not captured: the contract has no delegate keys yet. The fields are those of
// `get_delegate` in plan 01 Task 15. Replace this with a captured sample when that task lands.
test("delegate_view_matches_the_task_15_shape", () => {
  const delegate = {
    token: "token.test.near",
    per_task_cap: "5000",
    total_cap: "10000",
    spent: "4000",
  };
  expect(DelegateViewSchema.parse(delegate)).toEqual(delegate);
  for (const field of ["per_task_cap", "total_cap", "spent"]) {
    expect(failures(DelegateViewSchema, { ...delegate, [field]: 5000 }), field).toEqual([field]);
  }
  expect(failures(DelegateViewSchema, { ...delegate, spent: undefined })).toEqual(["spent"]);
  expect(failures(DelegateViewSchema, { ...delegate, token: "Token" })).toEqual(["token"]);
});

// ---------------------------------------------------------------------------------------------
// Views: numbers (u64 and u128 are decimal strings; u8, u16 and u32 are JSON integers)
// ---------------------------------------------------------------------------------------------

test("amounts_must_be_strings", () => {
  const task = sample("task_view");
  expect(failures(TaskViewSchema, { ...task, reward: 1 })).toEqual(["reward"]);

  // Every u64 and u128 field of a task, as a JSON number. The contract never sends one, and above
  // 2^53 a number would lose digits.
  const fields = [
    "id",
    "reward",
    "created_at",
    "commit_deadline",
    "reveal_deadline",
    "pick_deadline",
    "fallback_deadline",
  ];
  for (const field of fields) {
    const asNumber = Number(task[field]);
    expect(failures(TaskViewSchema, { ...task, [field]: asNumber }), field).toEqual([field]);
  }
  expect(failures(TaskViewSchema, { ...task, parent: 7 })).toEqual(["parent"]);

  // The nested amounts.
  const picked = task.outcome as { winners: Record<string, unknown>[] };
  expect(
    failures(TaskViewSchema, { ...task, funders: [{ account: "poster.test.near", amount: 5 }] }),
  ).toEqual(["funders.0.amount"]);
  expect(failures(TaskViewSchema, { ...task, outcome: { ...picked, fee: 50000 } })).toEqual([
    "outcome.fee",
  ]);
  const winners = [{ ...picked.winners[0], amount: 665003 }, picked.winners[1]];
  expect(failures(TaskViewSchema, { ...task, outcome: { ...picked, winners } })).toEqual([
    "outcome.winners.0.amount",
  ]);

  // The other views.
  expect(failures(EntryViewSchema, { ...sample("entry_view"), task_id: 1 })).toEqual(["task_id"]);
  expect(failures(EntryViewSchema, { ...sample("entry_view"), committed_at_block: 65 })).toEqual([
    "committed_at_block",
  ]);
  expect(failures(AgentViewSchema, { ...sample("agent_view"), registered_at: 1 })).toEqual([
    "registered_at",
  ]);
  const earned = [{ token: "token.test.near", amount: 665003 }];
  expect(failures(AgentViewSchema, { ...sample("agent_view"), earned })).toEqual([
    "earned.0.amount",
  ]);
  for (const field of ["total", "available", "used_bytes"]) {
    expect(failures(StorageViewSchema, { ...sample("storage_view"), [field]: 1 }), field).toEqual([
      field,
    ]);
  }
  const tokens = [{ token: "token.test.near", min_reward: 1, max_reward: "2", enabled: true }];
  expect(failures(ConfigViewSchema, { ...sample("config_view"), tokens })).toEqual([
    "tokens.0.min_reward",
  ]);
});

test("decimal_strings_round_trip_at_range_edges", () => {
  // These have to survive JSON -> bigint -> Postgres -> JSON unchanged (plan 02, review focus 1).
  for (const ok of ["0", "1", "9007199254740993", "1793307169820229000", U64_MAX]) {
    expect(U64StringSchema.parse(ok), ok).toBe(ok);
  }
  for (const ok of ["0", U64_MAX, "18446744073709551616", U128_MAX]) {
    expect(U128StringSchema.parse(ok), ok).toBe(ok);
  }
  // One past the top of each type.
  expect(accepts(U64StringSchema, "18446744073709551616")).toBe(false);
  expect(accepts(U128StringSchema, "340282366920938463463374607431768211456")).toBe(false);

  // Only the form `U64` and `U128` write: ASCII digits, no sign, no leading zero.
  const notCanonical = ["", " ", "-1", "-0", "+1", "00", "01", "1.0", "1e3", "0x1", " 1", "1 "];
  for (const bad of [...notCanonical, "1_000", "1\n", ARABIC_INDIC_THREE, FULLWIDTH_ONE]) {
    expect(accepts(U128StringSchema, bad), JSON.stringify(bad)).toBe(false);
    expect(accepts(U64StringSchema, bad), JSON.stringify(bad)).toBe(false);
  }
  // Not strings at all.
  for (const bad of [1, 0, 2 ** 53, 1n, null, undefined, true, ["1"]]) {
    expect(accepts(U128StringSchema, bad), String(bad)).toBe(false);
  }
  // A huge digit string is refused before anything parses it.
  expect(accepts(U128StringSchema, "9".repeat(100_000))).toBe(false);
});

test("small_integers_stay_json_integers", () => {
  const task = sample("task_view");
  // u16, u8 and u32 at the top of their range, and one past it.
  const bounds: [string, number][] = [
    ["fee_bps", 65_535],
    ["max_winners", 255],
    ["max_entries", 4_294_967_295],
    ["commit_count", 4_294_967_295],
    ["reveal_count", 4_294_967_295],
    ["cleaned", 4_294_967_295],
  ];
  for (const [field, max] of bounds) {
    expect(accepts(TaskViewSchema, { ...task, [field]: max }), `${field} = ${max}`).toBe(true);
    expect(failures(TaskViewSchema, { ...task, [field]: max + 1 }), `${field} past`).toEqual([
      field,
    ]);
    expect(failures(TaskViewSchema, { ...task, [field]: -1 }), `${field} -1`).toEqual([field]);
    expect(failures(TaskViewSchema, { ...task, [field]: 1.5 }), `${field} 1.5`).toEqual([field]);
    // The contract sends these as numbers; a string is a schema/contract mismatch.
    expect(failures(TaskViewSchema, { ...task, [field]: "1" }), `${field} "1"`).toEqual([field]);
  }
  const picked = task.outcome as { winners: Record<string, unknown>[] };
  const winners = [{ ...picked.winners[0], bps: "7000" }, picked.winners[1]];
  expect(failures(TaskViewSchema, { ...task, outcome: { ...picked, winners } })).toEqual([
    "outcome.winners.0.bps",
  ]);

  expect(failures(EntryViewSchema, { ...sample("entry_view"), index: "0" })).toEqual(["index"]);
  for (const field of ["entries", "reveals", "wins", "picks_made", "voids_after_reveals"]) {
    expect(failures(AgentViewSchema, { ...sample("agent_view"), [field]: "1" }), field).toEqual([
      field,
    ]);
  }
  for (const field of ["fee_bps", "min_window_secs", "max_window_secs", "version"]) {
    expect(failures(ConfigViewSchema, { ...sample("config_view"), [field]: "1" }), field).toEqual([
      field,
    ]);
  }
  expect(failures(ConfigViewSchema, { ...sample("config_view"), version: 65_536 })).toEqual([
    "version",
  ]);
});

// ---------------------------------------------------------------------------------------------
// Views: hashes, account ids, closed vocabularies
// ---------------------------------------------------------------------------------------------

test("hashes_must_be_64_lowercase_hex", () => {
  const task = sample("task_view");
  const picked = task.outcome as Record<string, unknown>;
  const badHashes = [
    "AB".repeat(32),
    "ab".repeat(31),
    `${"ab".repeat(32)}a`,
    `g${"ab".repeat(31)}f`,
    `0x${"ab".repeat(32)}`,
    "",
  ];
  for (const bad of badHashes) {
    expect(accepts(HashHexSchema, bad), bad).toBe(false);
    for (const field of ["brief_hash", "criteria_hash", "heldout_commitment"]) {
      expect(failures(TaskViewSchema, { ...task, [field]: bad }), `${field} ${bad}`).toEqual([
        field,
      ]);
    }
    expect(
      failures(TaskViewSchema, { ...task, outcome: { ...picked, scorecard_hash: bad } }),
    ).toEqual(["outcome.scorecard_hash"]);
    for (const field of ["commitment", "content_hash"]) {
      expect(failures(EntryViewSchema, { ...sample("entry_view"), [field]: bad }), field).toEqual([
        field,
      ]);
    }
    expect(failures(AgentViewSchema, { ...sample("agent_view"), profile_hash: bad })).toEqual([
      "profile_hash",
    ]);
  }
  expect(accepts(HashHexSchema, HASH)).toBe(true);
  expect(accepts(HashHexSchema, sha256Hex("anything"))).toBe(true);
});

test("account_ids_follow_near_rules", () => {
  const valid = [
    "poster.test.near",
    "a1",
    "near",
    "usdc.sandbox",
    "a-b.c_d.near",
    "a".repeat(64),
    // Implicit accounts: 32 bytes of hex (the testnet USDC account) and an Ethereum address.
    NETWORKS.testnet.usdc ?? "",
    `0x${"ab".repeat(20)}`,
  ];
  for (const id of valid) expect(accepts(AccountIdSchema, id), id).toBe(true);

  const invalid = [
    "",
    "a",
    "a".repeat(65),
    "Alice.near",
    "alice.NEAR",
    "alice..near",
    ".alice",
    "alice.",
    "-alice",
    "alice-",
    "al--ice",
    "al_-ice",
    "alice near",
    "alice@near",
    "ålice.near",
    "alice.near\n",
  ];
  for (const id of invalid) expect(accepts(AccountIdSchema, id), JSON.stringify(id)).toBe(false);
  // An account id that is far too long is refused without being matched against the pattern.
  expect(accepts(AccountIdSchema, `${"a".repeat(100_000)}!`)).toBe(false);

  // The views use it for every account field.
  const task = sample("task_view");
  expect(failures(TaskViewSchema, { ...task, poster: "Poster" })).toEqual(["poster"]);
  expect(failures(TaskViewSchema, { ...task, invited: ["alice.test.near", "Bob"] })).toEqual([
    "invited.1",
  ]);
  expect(failures(AgentViewSchema, { ...sample("agent_view"), asp: "" })).toEqual(["asp"]);
  expect(failures(ConfigViewSchema, { ...sample("config_view"), pending_owner: "X" })).toEqual([
    "pending_owner",
  ]);
});

test("phases_and_outcomes_are_closed_sets", () => {
  for (const phase of ["open", "revealing", "judging", "fallback", "expired", "settled"]) {
    expect(PhaseSchema.parse(phase)).toBe(phase);
  }
  expect(PhaseSchema.options).toHaveLength(6);
  for (const bad of ["Open", "paused", "", "settling", 1, null]) {
    expect(accepts(PhaseSchema, bad), String(bad)).toBe(false);
  }

  const task = sample("task_view");
  expect(failures(TaskViewSchema, { ...task, phase: "paused" })).toEqual(["phase"]);
  expect(failures(TaskViewSchema, { ...task, outcome: { kind: "cancelled" } })).toEqual([
    "outcome.kind",
  ]);
  const voided = { kind: "voided", reason: "other", scorecard_hash: null, scorecard_uri: null };
  expect(failures(TaskViewSchema, { ...task, outcome: voided })).toEqual(["outcome.reason"]);
  // A picked task always has its scorecard; only a void may lack one.
  const picked = task.outcome as Record<string, unknown>;
  expect(
    failures(TaskViewSchema, { ...task, outcome: { ...picked, scorecard_uri: null } }),
  ).toEqual(["outcome.scorecard_uri"]);
});

test("views_ignore_fields_the_contract_may_add_later", () => {
  // A contract upgrade that adds a field must not break clients that predate it, so a view drops
  // what it does not know. The sample tests above are what notice such a field.
  const task = sample("task_view");
  const parsed = TaskViewSchema.parse({ ...task, added_later: true });
  expect(parsed).toEqual(task);
  expect("added_later" in parsed).toBe(false);
});

test("views_reject_missing_fields", () => {
  // Every field, including the ones that may be null: the contract always writes them.
  const task = sample("task_view");
  for (const field of Object.keys(task)) {
    const { [field]: _removed, ...rest } = task;
    expect(failures(TaskViewSchema, rest), `without ${field}`).toEqual([field]);
  }
});

// ---------------------------------------------------------------------------------------------
// Brief
// ---------------------------------------------------------------------------------------------

// Shaped like the drafted seed tasks in tender-prep/seeds.
const BRIEF = {
  version: 1,
  title: "Regex for real ISO dates (YYYY-MM-DD)",
  summary:
    "Write one JavaScript regex that accepts only real calendar dates written as YYYY-MM-DD.",
  instructions: "Write an ECMAScript regex that accepts exactly the real calendar dates.",
  category: "coding",
  tags: ["coding", "regex", "dates"],
  output: { format: "regex_json", max_bytes: 4096 },
};

test("brief_accepts_valid_rejects_bad_tags", () => {
  expect(BriefSchema.parse(BRIEF)).toEqual(BRIEF);

  const good = [
    [],
    ["a"],
    ["x".repeat(24)],
    ["web3", "near-protocol", "0-9"],
    ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"],
  ];
  for (const tags of good) expect(accepts(BriefSchema, { ...BRIEF, tags }), `${tags}`).toBe(true);

  // Each case breaks the rule on its own: tag 1 of a good pair, so the failure names `tags.1`.
  const badTags = [
    "Regex",
    "x".repeat(25),
    "",
    "snake_case",
    "two words",
    "émoji",
    "dot.ted",
    "trailing\n",
  ];
  for (const bad of badTags) {
    expect(failures(BriefSchema, { ...BRIEF, tags: ["ok", bad] }), JSON.stringify(bad)).toEqual([
      "tags.1",
    ]);
  }
  const nine = ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9"];
  expect(failures(BriefSchema, { ...BRIEF, tags: nine })).toEqual(["tags"]);
  expect(failures(BriefSchema, { ...BRIEF, tags: "coding" })).toEqual(["tags"]);
});

test("brief_enforces_field_limits", () => {
  const limit = (field: string, ok: unknown[], bad: unknown[]) => {
    for (const value of ok) {
      expect(accepts(BriefSchema, { ...BRIEF, [field]: value }), field).toBe(true);
    }
    for (const value of bad) {
      expect(failures(BriefSchema, { ...BRIEF, [field]: value }), `${field}`).toEqual([field]);
    }
  };
  limit("title", ["t", "t".repeat(120)], ["", "t".repeat(121), 5]);
  limit("summary", ["", "s".repeat(280)], ["s".repeat(281)]);
  limit("instructions", ["i", "i".repeat(8000)], ["", "i".repeat(8001)]);
  limit(
    "category",
    ["extraction", "coding", "research", "data", "writing", "other"],
    ["misc", "Coding", ""],
  );

  const output = (format: string, max_bytes: unknown) => ({
    ...BRIEF,
    output: { format, max_bytes },
  });
  for (const format of ["text", "json", "regex_json", "code_js"]) {
    expect(accepts(BriefSchema, output(format, 1)), format).toBe(true);
  }
  expect(failures(BriefSchema, output("xml", 1))).toEqual(["output.format"]);
  // `max_bytes` runs from 1 to the largest result the store keeps, 256 KiB.
  expect(accepts(BriefSchema, output("text", 262_144))).toBe(true);
  for (const bad of [0, -1, 262_145, 1.5, "4096", null]) {
    expect(failures(BriefSchema, output("text", bad)), String(bad)).toEqual(["output.max_bytes"]);
  }
});

test("brief_rejects_unknown_fields_and_other_versions", () => {
  for (const version of [2, 0, "1", null]) {
    expect(failures(BriefSchema, { ...BRIEF, version }), String(version)).toEqual(["version"]);
  }
  const { version: _v, ...noVersion } = BRIEF;
  expect(failures(BriefSchema, noVersion)).toEqual(["version"]);
  // A misspelt optional key must fail, not be read as an absent one: the brief is hashed on
  // chain, and a dropped `attachements` would change what the poster meant.
  expect(accepts(BriefSchema, { ...BRIEF, attachements: [] })).toBe(false);
  expect(accepts(BriefSchema, { ...BRIEF, output: { ...BRIEF.output, extra: 1 } })).toBe(false);
  const { tags: _tags, ...noTags } = BRIEF;
  expect(failures(BriefSchema, noTags)).toEqual(["tags"]);
});

test("brief_attachments_are_optional_and_pinned_by_hash", () => {
  const attachment = { name: "invoice.pdf", uri: "ipfs://bafyattachment", sha256: HASH };
  const withFiles = { ...BRIEF, attachments: [attachment] };
  expect(BriefSchema.parse(withFiles)).toEqual(withFiles);
  expect(accepts(BriefSchema, { ...BRIEF, attachments: [] })).toBe(true);

  const bad = (change: Record<string, unknown>) => ({
    ...BRIEF,
    attachments: [{ ...attachment, ...change }],
  });
  expect(failures(BriefSchema, bad({ sha256: HASH.toUpperCase() }))).toEqual([
    "attachments.0.sha256",
  ]);
  expect(failures(BriefSchema, bad({ sha256: "ab" }))).toEqual(["attachments.0.sha256"]);
  expect(failures(BriefSchema, bad({ uri: "" }))).toEqual(["attachments.0.uri"]);
  expect(failures(BriefSchema, bad({ name: "" }))).toEqual(["attachments.0.name"]);
  expect(accepts(BriefSchema, bad({ size: 10 }))).toBe(false);
  const { sha256: _hash, ...noHash } = attachment;
  expect(failures(BriefSchema, { ...BRIEF, attachments: [noHash] })).toEqual([
    "attachments.0.sha256",
  ]);
});

// ---------------------------------------------------------------------------------------------
// Public criteria and held-out checks
// ---------------------------------------------------------------------------------------------

const COMMON = { version: 1, min_score: 100, split: "winner_take_all", has_heldout: true };
const CRITERIA = {
  exact: { kind: "exact", ...COMMON, normalize: ["trim", "lowercase", "collapse_ws"] },
  json_schema: {
    kind: "json_schema",
    ...COMMON,
    schema: { type: "object", required: ["total"], properties: { total: { type: "number" } } },
  },
  regex_cases: {
    kind: "regex_cases",
    ...COMMON,
    examples: { match: ["2024-02-29"], no_match: ["2024-13-01"] },
  },
  tests: {
    kind: "tests",
    ...COMMON,
    language: "js",
    entry: "solve",
    examples: [{ input: [1, 2], output: 3 }],
  },
  rubric: {
    kind: "rubric",
    ...COMMON,
    has_heldout: false,
    rubric: [{ criterion: "Answers the question that was asked", weight: 5 }],
  },
};
const HELDOUT = {
  exact: { exact: { expected: ["42", "42.0"] } },
  json_schema: {
    json_schema: {
      assertions: [
        { path: "$.total", equals: [redacted] },
        { path: "$.line_items[3]", equals: { description: "Customs", quantity: 1 } },
        { path: "$.discount", equals: null },
      ],
    },
  },
  regex_cases: { regex_cases: { match: ["0001-01-01", "2000-02-29"], no_match: ["1900-02-29"] } },
  tests: {
    tests: {
      cases: [
        { input: [2, 3], output: 5 },
        { input: [], output: null },
      ],
    },
  },
};

test("criteria_accepts_each_kind", () => {
  for (const [kind, doc] of Object.entries(CRITERIA)) {
    expect(PublicCriteriaSchema.parse(doc), kind).toEqual(doc);
  }
  const kinds = Object.values(CRITERIA).map((doc) => PublicCriteriaSchema.parse(doc).kind);
  expect(kinds).toEqual(["exact", "json_schema", "regex_cases", "tests", "rubric"]);
});

test("criteria_split_must_sum_10000", () => {
  const withSplit = (split: unknown) => ({ ...CRITERIA.exact, split });
  const good: unknown[] = [
    "winner_take_all",
    "equal",
    [10_000],
    [7000, 3000],
    [5000, 3000, 2000],
    [2000, 2000, 2000, 2000, 2000],
  ];
  for (const split of good) {
    expect(accepts(PublicCriteriaSchema, withSplit(split)), JSON.stringify(split)).toBe(true);
  }

  const bad: [string, unknown][] = [
    ["short by one", [7000, 2999]],
    ["over by one", [7000, 3001]],
    ["empty", []],
    ["six shares", [2000, 2000, 2000, 2000, 1000, 1000]],
    ["a zero share, which the contract refuses", [10_000, 0]],
    ["a negative share that cancels an excess", [12_000, -2000]],
    ["fractions that add up", [5000.5, 4999.5]],
    ["strings", ["7000", "3000"]],
    ["a share above the whole", [10_001]],
    ["an unknown word", "half"],
    ["a number", 10_000],
    ["null", null],
  ];
  for (const [what, split] of bad) {
    expect(failures(PublicCriteriaSchema, withSplit(split)), what).toEqual(["split"]);
  }
  // The split is a required field of every kind.
  for (const doc of Object.values(CRITERIA)) {
    const { split: _split, ...noSplit } = doc;
    expect(failures(PublicCriteriaSchema, noSplit), doc.kind).toEqual(["split"]);
  }
});

test("criteria_enforces_common_fields", () => {
  const exact = CRITERIA.exact;
  expect(accepts(PublicCriteriaSchema, { ...exact, min_score: 0 })).toBe(true);
  for (const bad of [-1, 101, 50.5, "100", null]) {
    expect(failures(PublicCriteriaSchema, { ...exact, min_score: bad }), String(bad)).toEqual([
      "min_score",
    ]);
  }
  for (const bad of ["true", 1, null]) {
    expect(failures(PublicCriteriaSchema, { ...exact, has_heldout: bad })).toEqual(["has_heldout"]);
  }
  for (const bad of [2, "1", null]) {
    expect(failures(PublicCriteriaSchema, { ...exact, version: bad })).toEqual(["version"]);
  }
  expect(accepts(PublicCriteriaSchema, { ...exact, unexpected: 1 })).toBe(false);
});

test("criteria_enforces_kind_specific_fields", () => {
  const bad = (kind: keyof typeof CRITERIA, change: Record<string, unknown>) =>
    failures(PublicCriteriaSchema, { ...CRITERIA[kind], ...change });

  expect(accepts(PublicCriteriaSchema, { ...CRITERIA.exact, normalize: [] })).toBe(true);
  expect(bad("exact", { normalize: ["trim", "uppercase"] })).toEqual(["normalize.1"]);

  expect(bad("json_schema", { schema: [] })).toEqual(["schema"]);
  expect(bad("json_schema", { schema: null })).toEqual(["schema"]);
  expect(bad("json_schema", { schema: "object" })).toEqual(["schema"]);
  expect(accepts(PublicCriteriaSchema, { ...CRITERIA.json_schema, schema: {} })).toBe(true);

  expect(bad("regex_cases", { examples: { match: ["a"] } })).toEqual(["examples.no_match"]);
  expect(bad("regex_cases", { examples: { match: [1], no_match: [] } })).toEqual([
    "examples.match.0",
  ]);

  expect(bad("tests", { language: "python" })).toEqual(["language"]);
  expect(bad("tests", { entry: "" })).toEqual(["entry"]);
  expect(bad("tests", { examples: [{ input: 1 }] })).toEqual(["examples.0.output"]);
  // An example's input and output are JSON values; null is one, undefined is not.
  expect(
    accepts(PublicCriteriaSchema, { ...CRITERIA.tests, examples: [{ input: null, output: null }] }),
  ).toBe(true);
  expect(
    accepts(PublicCriteriaSchema, {
      ...CRITERIA.tests,
      examples: [{ input: 1, output: undefined }],
    }),
  ).toBe(false);

  const rubric = (...weights: unknown[]) => ({
    rubric: weights.map((weight) => ({ criterion: "c", weight })),
  });
  expect(accepts(PublicCriteriaSchema, { ...CRITERIA.rubric, ...rubric(1, 10) })).toBe(true);
  for (const weight of [0, 11, 5.5, "5", null]) {
    expect(bad("rubric", rubric(weight)), String(weight)).toEqual(["rubric.0.weight"]);
  }
  // A rubric with no criteria has no score to compute.
  expect(bad("rubric", { rubric: [] })).toEqual(["rubric"]);
  expect(bad("rubric", { rubric: [{ criterion: "", weight: 3 }] })).toEqual(["rubric.0.criterion"]);
});

test("criteria_rejects_unknown_kinds_and_fields_of_other_kinds", () => {
  expect(failures(PublicCriteriaSchema, { ...CRITERIA.exact, kind: "fuzzy" })).toEqual(["kind"]);
  const { kind: _kind, ...noKind } = CRITERIA.exact;
  expect(failures(PublicCriteriaSchema, noKind)).toEqual(["kind"]);
  // `exact` has no `schema`; `rubric` has no `normalize`.
  expect(accepts(PublicCriteriaSchema, { ...CRITERIA.exact, schema: {} })).toBe(false);
  expect(accepts(PublicCriteriaSchema, { ...CRITERIA.rubric, normalize: [] })).toBe(false);
  // Each kind needs its own field.
  expect(failures(PublicCriteriaSchema, { ...COMMON, kind: "exact" })).toEqual(["normalize"]);
  expect(failures(PublicCriteriaSchema, { ...COMMON, kind: "rubric" })).toEqual(["rubric"]);
});

test("heldout_accepts_one_document_per_kind", () => {
  for (const [kind, doc] of Object.entries(HELDOUT)) {
    expect(HeldoutSchema.parse(doc), kind).toEqual(doc);
  }
  // The shape the drafted seeds use.
  const seedStyle = { regex_cases: { match: ["a"], no_match: ["b"] } };
  expect(HeldoutSchema.parse(seedStyle)).toEqual(seedStyle);
  // `match` and `no_match` may each be empty; the other kinds need at least one entry.
  expect(accepts(HeldoutSchema, { regex_cases: { match: [], no_match: [] } })).toBe(true);
});

test("heldout_rejects_malformed_documents", () => {
  const bad: [string, unknown][] = [
    ["no key", {}],
    ["two keys", { ...HELDOUT.exact, ...HELDOUT.regex_cases }],
    ["a key that is no kind", { fuzzy: { expected: ["x"] } }],
    ["rubric, which has no held-out part", { rubric: [{ criterion: "c", weight: 1 }] }],
    ["not an object", ["exact"]],
    ["null", null],
    ["a bare shape", { expected: ["x"] }],
    ["exact without answers", { exact: { expected: [] } }],
    ["exact with a number", { exact: { expected: [42] } }],
    ["json_schema without assertions", { json_schema: { assertions: [] } }],
    ["an assertion with no value", { json_schema: { assertions: [{ path: "$.a" }] } }],
    ["an assertion with no path", { json_schema: { assertions: [{ equals: 1 }] } }],
    ["tests without cases", { tests: { cases: [] } }],
    ["a case with no output", { tests: { cases: [{ input: 1 }] } }],
    ["regex_cases without no_match", { regex_cases: { match: ["a"] } }],
    ["a shape of another kind", { exact: { match: [], no_match: [] } }],
    ["a stray key in the shape", { exact: { expected: ["x"], note: "hint" } }],
  ];
  for (const [what, doc] of bad) expect(accepts(HeldoutSchema, doc), what).toBe(false);
});

test("heldout_kind_must_match", () => {
  const criteria = PublicCriteriaSchema.parse(CRITERIA.regex_cases);
  const regexHeldout = HeldoutSchema.parse(HELDOUT.regex_cases);
  // Valid on its own, but it answers a different kind of task.
  const exactHeldout = HeldoutSchema.parse(HELDOUT.exact);
  expect(heldoutMatchesCriteria(criteria, regexHeldout)).toBe(true);
  expect(heldoutMatchesCriteria(criteria, exactHeldout)).toBe(false);

  // Every kind matches itself and no other.
  const kinds = ["exact", "json_schema", "regex_cases", "tests"] as const;
  for (const task of kinds) {
    for (const held of kinds) {
      const result = heldoutMatchesCriteria(
        PublicCriteriaSchema.parse(CRITERIA[task]),
        HeldoutSchema.parse(HELDOUT[held]),
      );
      expect(result, `${task} criteria, ${held} held-out`).toBe(task === held);
    }
  }
  // A rubric has no held-out part, so no document belongs to it.
  const rubric = PublicCriteriaSchema.parse(CRITERIA.rubric);
  for (const doc of Object.values(HELDOUT)) {
    expect(heldoutMatchesCriteria(rubric, HeldoutSchema.parse(doc))).toBe(false);
  }
});

// ---------------------------------------------------------------------------------------------
// Scorecard
// ---------------------------------------------------------------------------------------------

function scorecard(): Record<string, unknown> {
  const task = sample("task_view");
  const entry = sample("entry_view");
  const picked = task.outcome as { winners: { account: string; bps: number }[] };
  return {
    version: 1,
    task_id: task.id,
    verifier: task.verifier,
    kind: "regex_cases",
    criteria_hash: task.criteria_hash,
    heldout_commitment: task.heldout_commitment,
    heldout: HELDOUT.regex_cases,
    tie_break: "score desc, committed_at_block asc, account asc",
    entries: [
      {
        account: entry.account,
        content_hash: entry.content_hash,
        uri: entry.uri,
        committed_at_block: entry.committed_at_block,
        score: 100,
        passed: true,
        reasons: [],
      },
      {
        account: "bob.test.near",
        content_hash: HASH,
        uri: "ipfs://bob-work",
        committed_at_block: "66",
        score: 92,
        passed: false,
        reasons: ["accepts 2023-02-30", "rejects 2024-02-29"],
      },
    ],
    winners: picked.winners.map(({ account, bps }) => ({ account, bps })),
    generated_at: "2026-10-29T22:13:10.123Z",
    judge: { software: "tender-judge/1", model: null },
  };
}

test("scorecard_accepts_a_judged_task", () => {
  const card = scorecard();
  expect(ScorecardSchema.parse(card)).toEqual(card);
  expect((card.winners as unknown[]).length).toBe(2);
});

test("scorecard_accepts_unscored_and_subjective_variants", () => {
  // No award: an empty `winners` list and entries that all failed.
  const noAward = { ...scorecard(), winners: [], entries: [] };
  expect(accepts(ScorecardSchema, noAward)).toBe(true);
  // A rubric task has no held-out part, so both fields are an explicit null, and a model scored it.
  const subjective = {
    ...scorecard(),
    kind: "rubric",
    heldout_commitment: null,
    heldout: null,
    judge: { software: "tender-judge/1", model: "some-model" },
  };
  expect(ScorecardSchema.parse(subjective)).toEqual(subjective);
  // The published held-out document is any JSON value here; HeldoutSchema checks it where needed.
  expect(
    accepts(ScorecardSchema, { ...scorecard(), heldout: { exact: { expected: ["x"] } } }),
  ).toBe(true);
});

test("scorecard_rejects_bad_scores_and_fields", () => {
  const card = scorecard();
  const entries = card.entries as Record<string, unknown>[];
  const entry = (change: Record<string, unknown>) => [{ ...entries[0], ...change }];
  for (const score of [-1, 101, 99.5, "100", null]) {
    expect(
      failures(ScorecardSchema, { ...card, entries: entry({ score }) }),
      String(score),
    ).toEqual(["entries.0.score"]);
  }
  for (const score of [0, 100]) {
    expect(accepts(ScorecardSchema, { ...card, entries: entry({ score }) })).toBe(true);
  }
  expect(failures(ScorecardSchema, { ...card, entries: entry({ passed: "yes" }) })).toEqual([
    "entries.0.passed",
  ]);
  expect(failures(ScorecardSchema, { ...card, entries: entry({ reasons: "ok" }) })).toEqual([
    "entries.0.reasons",
  ]);
  expect(failures(ScorecardSchema, { ...card, entries: entry({ reasons: [1] }) })).toEqual([
    "entries.0.reasons.0",
  ]);
  // u64 values are decimal strings here too.
  expect(
    failures(ScorecardSchema, { ...card, entries: entry({ committed_at_block: 65 }) }),
  ).toEqual(["entries.0.committed_at_block"]);
  expect(failures(ScorecardSchema, { ...card, task_id: 1 })).toEqual(["task_id"]);
  expect(failures(ScorecardSchema, { ...card, entries: entry({ content_hash: "abc" }) })).toEqual([
    "entries.0.content_hash",
  ]);
  expect(failures(ScorecardSchema, { ...card, entries: entry({ account: "Alice" }) })).toEqual([
    "entries.0.account",
  ]);
  expect(failures(ScorecardSchema, { ...card, criteria_hash: HASH.toUpperCase() })).toEqual([
    "criteria_hash",
  ]);
  expect(failures(ScorecardSchema, { ...card, kind: "fuzzy" })).toEqual(["kind"]);
  expect(failures(ScorecardSchema, { ...card, verifier: "" })).toEqual(["verifier"]);

  // The commitment and the published document are required, if only as null.
  expect(failures(ScorecardSchema, { ...card, heldout_commitment: undefined })).toEqual([
    "heldout_commitment",
  ]);
  expect(failures(ScorecardSchema, { ...card, heldout: undefined })).toEqual(["heldout"]);
  expect(accepts(ScorecardSchema, { ...card, heldout: Number.NaN })).toBe(false);
});

test("scorecard_pins_version_tie_break_and_judge", () => {
  const card = scorecard();
  expect(failures(ScorecardSchema, { ...card, version: 2 })).toEqual(["version"]);
  expect(failures(ScorecardSchema, { ...card, tie_break: "score desc, account asc" })).toEqual([
    "tie_break",
  ]);
  expect(
    failures(ScorecardSchema, { ...card, judge: { software: "tender-judge/2", model: null } }),
  ).toEqual(["judge.software"]);
  expect(failures(ScorecardSchema, { ...card, judge: { software: "tender-judge/1" } })).toEqual([
    "judge.model",
  ]);
  expect(
    failures(ScorecardSchema, { ...card, judge: { software: "tender-judge/1", model: 4 } }),
  ).toEqual(["judge.model"]);
  expect(accepts(ScorecardSchema, { ...card, unexpected: true })).toBe(false);
});

test("scorecard_winners_are_account_and_bps", () => {
  const card = scorecard();
  const winners = (...list: unknown[]) => ({ ...card, winners: list });
  expect(accepts(ScorecardSchema, winners({ account: "alice.test.near", bps: 10_000 }))).toBe(true);
  for (const bps of [0, -1, 10_001, 33.3, "7000", null]) {
    expect(
      failures(ScorecardSchema, winners({ account: "alice.test.near", bps })),
      String(bps),
    ).toEqual(["winners.0.bps"]);
  }
  expect(failures(ScorecardSchema, winners({ account: "Alice", bps: 10_000 }))).toEqual([
    "winners.0.account",
  ]);
  // The contract's `pick` takes only these two keys; the scorecard lists the same two.
  expect(
    accepts(ScorecardSchema, winners({ account: "alice.test.near", bps: 1, amount: "5" })),
  ).toBe(false);
});

test("scorecard_generated_at_is_iso_8601", () => {
  const card = scorecard();
  for (const ok of [
    "2026-10-29T22:13:10.123Z",
    "2026-10-29T22:13:10Z",
    "2026-10-29T23:13:10+01:00",
  ]) {
    expect(accepts(ScorecardSchema, { ...card, generated_at: ok }), ok).toBe(true);
  }
  const notIso = [
    "yesterday",
    "2026-10-29",
    "2026-10-29 22:13:10",
    "2026-10-29T22:13:10",
    "2026-02-30T00:00:00Z",
    "2026-13-01T00:00:00Z",
    "",
  ];
  for (const bad of notIso) {
    expect(failures(ScorecardSchema, { ...card, generated_at: bad }), bad).toEqual([
      "generated_at",
    ]);
  }
  expect(failures(ScorecardSchema, { ...card, generated_at: 1793307169820 })).toEqual([
    "generated_at",
  ]);
});

// ---------------------------------------------------------------------------------------------
// Canonical JSON
// ---------------------------------------------------------------------------------------------

test("canonical_json_sorts_keys", () => {
  const bytes = canonicalJson({ b: [2, { d: 4, c: 3 }], a: 1 });
  expect(bytes).toBeInstanceOf(Uint8Array);
  expect(text(bytes)).toBe('{"a":1,"b":[2,{"c":3,"d":4}]}');
  // Arrays keep their order; only object keys are sorted.
  expect(text(canonicalJson([3, 1, 2]))).toBe("[3,1,2]");
  expect(text(canonicalJson({ z: { y: { x: 1, w: 2 } }, a: [] }))).toBe(
    '{"a":[],"z":{"y":{"w":2,"x":1}}}',
  );
});

test("canonical_json_orders_keys_as_strings", () => {
  // JavaScript lists integer-like keys first and numerically, so sorting an object's keys and
  // stringifying it would give {"9":3,"10":2,...}. The canonical order is that of the key strings.
  expect(text(canonicalJson({ b: 1, 10: 2, 9: 3, a: 0 }))).toBe('{"10":2,"9":3,"a":0,"b":1}');
  // Keys compare by UTF-16 code unit (RFC 8785): U+10000 is the pair D800 DC00, which sorts below
  // U+FF61 (one unit, FF61), although its code point is above.
  const astral = String.fromCodePoint(0x10000);
  const bmp = String.fromCodePoint(0xff61);
  expect(text(canonicalJson({ [bmp]: 1, [astral]: 2 }))).toBe(`{"${astral}":2,"${bmp}":1}`);
  expect(text(canonicalJson({ B: 1, a: 2, "": 3 }))).toBe('{"":3,"B":1,"a":2}');
});

test("canonical_json_is_compact_utf8", () => {
  // No whitespace between tokens; whitespace inside strings is kept.
  expect(text(canonicalJson({ a: " x  y ", b: [1, 2] }))).toBe('{"a":" x  y ","b":[1,2]}');
  // Characters are written as UTF-8, not as \u escapes.
  expect([...canonicalJson("é")]).toEqual([0x22, 0xc3, 0xa9, 0x22]);
  expect([...canonicalJson("\u{1f600}")]).toEqual([0x22, 0xf0, 0x9f, 0x98, 0x80, 0x22]);
  // The quote, the backslash and control characters are escaped, and nothing else is.
  expect(text(canonicalJson('a"b\\c\nd\u0001'))).toBe('"a\\"b\\\\c\\nd\\u0001"');
  // A lone surrogate cannot be written as UTF-8, so it is escaped.
  expect(text(canonicalJson("\ud800"))).toBe('"\\ud800"');
  // Numbers use the shortest round-trip form; -0 is 0.
  expect(text(canonicalJson([1, 1.5, -0, 1e21, 0.1, 100]))).toBe("[1,1.5,0,1e+21,0.1,100]");
  expect(text(canonicalJson([null, true, false, "", {}]))).toBe('[null,true,false,"",{}]');
});

test("canonical_json_ignores_key_order_and_absent_values", () => {
  const a = canonicalJson({ x: 1, y: { p: [1, { s: 1, r: 2 }], q: null }, z: "z" });
  const b = canonicalJson({ z: "z", y: { q: null, p: [1, { r: 2, s: 1 }] }, x: 1 });
  expect(text(a)).toBe(text(b));
  expect(sha256Hex(a)).toBe(sha256Hex(b));
  // An undefined property is an absent one, as in JSON.stringify.
  expect(text(canonicalJson({ a: 1, b: undefined }))).toBe('{"a":1}');
});

test("canonical_json_hash_is_sha256_of_the_bytes", () => {
  const doc = { b: [2, { d: 4, c: 3 }], a: 1 };
  const expected = createHash("sha256").update('{"a":1,"b":[2,{"c":3,"d":4}]}').digest("hex");
  expect(sha256Hex(canonicalJson(doc))).toBe(expected);
});

test("canonical_json_round_trips_the_real_samples", () => {
  for (const name of ["task_view", "entry_view", "agent_view", "config_view", "storage_view"]) {
    const real = sample(name);
    const bytes = canonicalJson(real);
    expect(JSON.parse(text(bytes)), name).toEqual(real);
    // The samples hold no whitespace inside their strings, so there is none anywhere.
    expect(text(bytes), name).not.toMatch(/\s/);
    // Writing the canonical form again changes nothing.
    expect(text(canonicalJson(JSON.parse(text(bytes))))).toBe(text(bytes));
  }
});

test("canonical_json_rejects_values_json_cannot_hold", () => {
  const bad: [string, unknown][] = [
    ["undefined", undefined],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["a bigint", 1n],
    ["a function", () => 1],
    ["a symbol", Symbol("s")],
    ["undefined in an array", [1, undefined]],
    ["a nested NaN", { a: { b: [Number.NaN] } }],
    ["a Date", new Date(0)],
    ["a Map", new Map([["a", 1]])],
    ["a Uint8Array", new Uint8Array([1])],
  ];
  for (const [what, value] of bad) expect(() => canonicalJson(value), what).toThrow(TypeError);
  // The message says where.
  expect(() => canonicalJson({ entries: [{ score: Number.NaN }] })).toThrow(/entries\[0\]\.score/);
});

// ---------------------------------------------------------------------------------------------
// Token amounts
// ---------------------------------------------------------------------------------------------

test("format_and_parse_round_trip", () => {
  expect(parseTokenAmount("1.25", 6)).toBe(1_250_000n);
  expect(() => parseTokenAmount("1.2345678", 6)).toThrow();

  const cases: [bigint, number, string][] = [
    [1_250_000n, 6, "1.25"],
    [1n, 6, "0.000001"],
    [0n, 6, "0.00"],
    [1_000_000n, 6, "1.00"],
    [1_500_000n, 6, "1.50"],
    [1_230_000n, 6, "1.23"],
    [123_456_789n, 6, "123.456789"],
    [50_000_000n, 6, "50.00"],
    [999_999n, 6, "0.999999"],
    [10n ** 24n, 24, "1.00"],
    [1n, 24, "0.000000000000000000000001"],
    [5n * 10n ** 23n, 24, "0.50"],
    // Fewer than two decimals: never more digits than the token has.
    [5n, 1, "0.5"],
    [50n, 1, "5.0"],
    [5n, 0, "5"],
    [0n, 0, "0"],
    [123n, 0, "123"],
    [12_345n, 2, "123.45"],
    [100n, 2, "1.00"],
    [BigInt(U128_MAX), 6, "340282366920938463463374607431768.211455"],
  ];
  for (const [amount, decimals, formatted] of cases) {
    expect(formatTokenAmount(amount, decimals), `${amount} / ${decimals}`).toBe(formatted);
    // A decimal string, as the contract's views carry amounts, formats the same.
    expect(formatTokenAmount(amount.toString(), decimals), `"${amount}" / ${decimals}`).toBe(
      formatted,
    );
    expect(parseTokenAmount(formatted, decimals), `parse ${formatted}`).toBe(amount);
  }
  // Typing fewer digits parses to the same amount.
  expect(parseTokenAmount("1.5", 6)).toBe(1_500_000n);
  expect(parseTokenAmount("1", 6)).toBe(1_000_000n);
  expect(parseTokenAmount("0.000001", 6)).toBe(1n);
  expect(parseTokenAmount("007.50", 2)).toBe(750n);
  expect(parseTokenAmount("0", 6)).toBe(0n);
  expect(parseTokenAmount("5", 0)).toBe(5n);
});

test("parse_token_amount_rejects_what_is_not_an_amount", () => {
  // More fraction digits than the token has, even when the extra digits are zeros.
  expect(() => parseTokenAmount("1.2345678", 6)).toThrow(/fraction digits/);
  expect(() => parseTokenAmount("1.0000000", 6)).toThrow(/fraction digits/);
  expect(() => parseTokenAmount("1.5", 0)).toThrow(/fraction digits/);
  expect(() => parseTokenAmount("0.1", 0)).toThrow(/fraction digits/);

  expect(() => parseTokenAmount("-1", 6)).toThrow(/negative/);
  expect(() => parseTokenAmount("-0.5", 6)).toThrow(/negative/);
  expect(() => parseTokenAmount("-0", 6)).toThrow(/negative/);

  const notNumbers = [
    "",
    " ",
    "abc",
    "NaN",
    "Infinity",
    "1.",
    ".5",
    ".",
    "1.2.3",
    "1e3",
    "0x10",
    "1,000",
    "1 000",
    "+1",
    " 1",
    "1 ",
    "1\n",
    "1_000",
    ARABIC_INDIC_THREE,
    FULLWIDTH_ONE,
    `1.${FULLWIDTH_ONE}`,
  ];
  for (const bad of notNumbers) {
    expect(() => parseTokenAmount(bad, 6), JSON.stringify(bad)).toThrow();
  }
});

test("format_token_amount_rejects_bad_input", () => {
  expect(() => formatTokenAmount(-1n, 6)).toThrow(RangeError);
  expect(() => formatTokenAmount("-1", 6)).toThrow();
  for (const bad of ["", "abc", "1.5", "1e3", "0x10", " 1", "1 ", "+1"]) {
    expect(() => formatTokenAmount(bad, 6), JSON.stringify(bad)).toThrow();
  }
  // The decimals must be a whole number from 0 to 255 (NEP-148 stores them in a u8).
  for (const decimals of [-1, 1.5, 256, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => formatTokenAmount(1n, decimals), String(decimals)).toThrow(RangeError);
    expect(() => parseTokenAmount("1", decimals), String(decimals)).toThrow(RangeError);
  }
  expect(formatTokenAmount(1n, 255)).toBe(`0.${"0".repeat(254)}1`);
});

test("token_meta_names_known_tokens_and_never_guesses_decimals", () => {
  const mainnetUsdc = NETWORKS.mainnet.usdc ?? "";
  const testnetUsdc = NETWORKS.testnet.usdc ?? "";
  expect(mainnetUsdc).not.toBe("");
  expect(tokenMeta(mainnetUsdc, "mainnet")).toEqual({ symbol: "USDC", decimals: 6 });
  expect(tokenMeta(testnetUsdc, "testnet")).toEqual({ symbol: "USDC", decimals: 6 });

  // The test tokens.
  expect(tokenMeta("usdc.sandbox", "sandbox")).toEqual({ symbol: "tUSDC", decimals: 6 });
  expect(tokenMeta("tusdc.test.near", "sandbox")).toEqual({ symbol: "tUSDC", decimals: 6 });
  expect(tokenMeta("tusdc.tender.testnet", "testnet")).toEqual({ symbol: "tUSDC", decimals: 6 });

  expect(tokenMeta("wrap.near", "mainnet")).toEqual({ symbol: "wNEAR", decimals: 24 });
  expect(tokenMeta("wrap.testnet", "testnet")).toEqual({ symbol: "wNEAR", decimals: 24 });

  // Anything else is shown in raw units under its own id.
  expect(tokenMeta("mystery.near", "mainnet")).toEqual({ symbol: "mystery.near", decimals: 0 });
  expect(tokenMeta("token.test.near", "sandbox")).toEqual({
    symbol: "token.test.near",
    decimals: 0,
  });
  // `tusdc` must be a whole first label: a lookalike is not a test token.
  expect(tokenMeta("tusdc-fake.near", "mainnet").decimals).toBe(0);
  expect(tokenMeta("faketusdc.near", "mainnet").decimals).toBe(0);
  expect(tokenMeta("usdc.near", "mainnet")).toEqual({ symbol: "usdc.near", decimals: 0 });
  // An id is a real token only on its own network.
  expect(tokenMeta(mainnetUsdc, "testnet")).toEqual({ symbol: mainnetUsdc, decimals: 0 });
  expect(tokenMeta(testnetUsdc, "mainnet")).toEqual({ symbol: testnetUsdc, decimals: 0 });
  expect(tokenMeta(testnetUsdc, "sandbox")).toEqual({ symbol: testnetUsdc, decimals: 0 });
  expect(tokenMeta("wrap.near", "testnet")).toEqual({ symbol: "wrap.near", decimals: 0 });
  expect(tokenMeta("", "sandbox")).toEqual({ symbol: "", decimals: 0 });
});
