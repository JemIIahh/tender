import type {
  AgentSummary,
  Scorecard,
  TaskDetailResponse,
  TaskEntry,
  TaskSummary,
} from "@tender/shared";

// Builders for the task data the unit tests feed the pages and components. Each gives a value that
// fits the shared schemas, with the fields a test cares about overridden.

export const SECOND = 1_000_000_000n;

/** A nanosecond time above 2^53, where a `Number` cannot tell neighbours apart. */
export const CREATED = 1_793_307_169_820_229_000n;

/** The windows of a seed task, in seconds: commit 600, reveal 300, pick 600, fallback 600. */
export const WINDOW_SECS = { commit: 600n, reveal: 300n, pick: 600n, fallback: 600n } as const;

/** The deadlines of a task created at `CREATED` with the seed windows, as decimal strings. */
export const DEADLINES = {
  created_at: CREATED.toString(),
  commit_deadline: (CREATED + WINDOW_SECS.commit * SECOND).toString(),
  reveal_deadline: (CREATED + (WINDOW_SECS.commit + WINDOW_SECS.reveal) * SECOND).toString(),
  pick_deadline: (
    CREATED +
    (WINDOW_SECS.commit + WINDOW_SECS.reveal + WINDOW_SECS.pick) * SECOND
  ).toString(),
  fallback_deadline: (
    CREATED +
    (WINDOW_SECS.commit + WINDOW_SECS.reveal + WINDOW_SECS.pick + WINDOW_SECS.fallback) * SECOND
  ).toString(),
};

/** The same deadlines as bigints. */
export const AT = {
  created: BigInt(DEADLINES.created_at),
  commit: BigInt(DEADLINES.commit_deadline),
  reveal: BigInt(DEADLINES.reveal_deadline),
  pick: BigInt(DEADLINES.pick_deadline),
  fallback: BigInt(DEADLINES.fallback_deadline),
};

export const HASH_A = "a".repeat(64);
export const HASH_B = "b".repeat(64);
export const HASH_C = "c".repeat(64);

export const POSTER = "poster.tender-team.testnet";
export const VERIFIER = "judge.tender-team.testnet";
export const TOKEN = "tusdc.tender-team.testnet";

export function summary(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: "7",
    title: "Extract invoice totals",
    category: "extraction",
    tags: ["extraction", "json"],
    token: TOKEN,
    reward: "1500000",
    phase: "open",
    poster: POSTER,
    verifier: VERIFIER,
    ...DEADLINES,
    commit_count: 2,
    reveal_count: 0,
    working_count: 1,
    judge_status: null,
    judge_reason: null,
    is_team_poster: true,
    parent: null,
    outcome_kind: null,
    ...overrides,
  };
}

export function entry(account: string, overrides: Partial<TaskEntry> = {}): TaskEntry {
  return {
    account,
    entry_index: 0,
    committed_height: "123456",
    content_hash: null,
    uri: null,
    revealed: false,
    is_team: false,
    ...overrides,
  };
}

/** A revealed entry: it has a content hash and the address of its content. */
export function revealed(account: string, hash: string, overrides: Partial<TaskEntry> = {}) {
  return entry(account, {
    content_hash: hash,
    uri: `http://api.test/v1/blobs/${hash}`,
    revealed: true,
    ...overrides,
  });
}

export function agent(overrides: Partial<AgentSummary> = {}): AgentSummary {
  return {
    account: VERIFIER,
    asp: null,
    name: "Tender Judge",
    tags: ["judge"],
    profile_uri: "http://api.test/v1/blobs/profile",
    profile_hash: HASH_C,
    registered_height: "100",
    entries: 0,
    reveals: 0,
    wins: 0,
    earned: {},
    picks_made: 12,
    voids_after_reveals: 1,
    is_team: true,
    ...overrides,
  };
}

/** A scorecard for task 7: alice passes with 90, bob fails with 40. */
export function scorecard(overrides: Partial<Scorecard> = {}): Scorecard {
  return {
    version: 1,
    task_id: "7",
    verifier: VERIFIER,
    kind: "regex_cases",
    criteria_hash: HASH_B,
    heldout_commitment: HASH_A,
    heldout: { regex_cases: { match: ["alice.near"], no_match: ["-bad"] } },
    tie_break: "score desc, committed_at_block asc, account asc",
    entries: [
      {
        account: "alice.testnet",
        content_hash: HASH_A,
        uri: `http://api.test/v1/blobs/${HASH_A}`,
        committed_at_block: "123456",
        score: 90,
        passed: true,
        reasons: ["matches 9 of 10 cases", "rejects every bad id"],
      },
      {
        account: "bob.testnet",
        content_hash: HASH_B,
        uri: `http://api.test/v1/blobs/${HASH_B}`,
        committed_at_block: "123460",
        score: 40,
        passed: false,
        reasons: ["accepts `-bad`"],
      },
    ],
    winners: [{ account: "alice.testnet", bps: 10_000 }],
    generated_at: "2026-10-29T21:10:00Z",
    judge: { software: "tender-judge/1", model: null },
    ...overrides,
  };
}

/**
 * A task page's data for task 7, open, with two sealed entries and one funder. `task` overrides
 * fields of the task (its summary and its terms), `rest` the other parts of the response.
 */
export function detail(
  task: Partial<TaskDetailResponse["task"]> = {},
  rest: Partial<Omit<TaskDetailResponse, "task">> = {},
): TaskDetailResponse {
  return {
    task: {
      ...summary(),
      brief_uri: "http://api.test/v1/blobs/brief",
      brief_hash: HASH_A,
      criteria_hash: HASH_B,
      heldout_commitment: HASH_A,
      max_entries: 0,
      max_winners: 1,
      invited: [],
      fee_bps: 500,
      outcome: null,
      ...task,
    },
    brief: {
      version: 1,
      title: task.title ?? "Extract invoice totals",
      summary: "Pull the total from each invoice.",
      instructions: "Return the total as a number.\nIgnore tax lines.",
      category: "extraction",
      tags: ["extraction", "json"],
      output: { format: "json", max_bytes: 4096 },
    },
    criteria: {
      kind: "regex_cases",
      version: 1,
      min_score: 80,
      split: "winner_take_all",
      has_heldout: true,
      examples: { match: ["alice.near"], no_match: ["-bad"] },
    },
    entries: [entry("alice.testnet"), entry("bob.testnet", { entry_index: 1 })],
    funders: [{ account: POSTER, amount: "1500000" }],
    children: [],
    scorecard: null,
    ...rest,
  };
}
