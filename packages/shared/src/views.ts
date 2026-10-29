import { z } from "zod";

// The schemas below check what the contract's view methods return (contract/tender/src/types.rs),
// field for field. They follow the contract's JSON, which writes numbers by their Rust type:
//
// - A u64 or u128 (ids, nanosecond timestamps, block heights, byte counts, amounts) is a decimal
//   string, because a JSON number loses digits above 2^53.
// - A u8, u16 or u32 (basis points, counts, windows in seconds, indexes, the version) is a JSON
//   integer.
//
// A view schema drops a key it does not know, so a field a later contract upgrade adds does not
// break a client that predates it. The sample tests are what notice a new field.

const U64_MAX = 2n ** 64n - 1n;
const U128_MAX = 2n ** 128n - 1n;
/** What `U64` and `U128` write: ASCII digits, no sign, no leading zero. */
const CANONICAL_DECIMAL = /^(?:0|[1-9][0-9]*)$/;
/** NEAR's account id pattern. It is checked on short strings only, see `AccountIdSchema`. */
const ACCOUNT_ID = /^(?:(?:[a-z\d]+[-_])*[a-z\d]+\.)*(?:[a-z\d]+[-_])*[a-z\d]+$/;
const ACCOUNT_ID_MIN_LENGTH = 2;
const ACCOUNT_ID_MAX_LENGTH = 64;

/**
 * A decimal string for a number up to `max`. The length is checked first so that nothing parses a
 * huge string, and the whole check is one function because a throw inside a second check would
 * escape `safeParse`.
 */
function decimalString(max: bigint, type: string) {
  const maxLength = max.toString().length;
  return z
    .string()
    .refine(
      (s) => s.length <= maxLength && CANONICAL_DECIMAL.test(s) && BigInt(s) <= max,
      `expected a ${type} as a decimal string`,
    );
}

/** A u64 as the contract's `U64` writes it: a decimal string from "0" to "18446744073709551615". */
export const U64StringSchema = decimalString(U64_MAX, "u64");
/** A u128 as the contract's `U128` writes it, up to "340282366920938463463374607431768211455". */
export const U128StringSchema = decimalString(U128_MAX, "u128");

/** A NEAR account id: 2 to 64 characters, lowercase alphanumerics joined by `.`, `-` or `_`. */
export const AccountIdSchema = z
  .string()
  .refine(
    (s) =>
      s.length >= ACCOUNT_ID_MIN_LENGTH && s.length <= ACCOUNT_ID_MAX_LENGTH && ACCOUNT_ID.test(s),
    "expected a NEAR account id",
  );

/** A SHA-256 as the contract writes one: 64 lowercase hex characters. */
export const HashHexSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "expected 64 lowercase hex characters");

const uint = (max: number) => z.int().min(0).max(max);
const U8 = uint(255);
const U16 = uint(65_535);
const U32 = uint(4_294_967_295);

/** Where a task is in its life. The contract derives it from block time and the outcome. */
export const PhaseSchema = z.enum([
  "open",
  "revealing",
  "judging",
  "fallback",
  "expired",
  "settled",
]);
export type Phase = z.infer<typeof PhaseSchema>;

/** Why a task was voided. */
const VoidReasonSchema = z.enum(["no_reveals", "no_award", "expired"]);

/** One funder of a task's escrow and what it paid in. */
const FunderViewSchema = z.object({
  account: AccountIdSchema,
  amount: U128StringSchema,
});

/** One winner's share of a pick. */
const PayoutViewSchema = z.object({
  account: AccountIdSchema,
  bps: U16,
  amount: U128StringSchema,
});

/**
 * How a settled task ended, tagged by `kind`. A pick always has its scorecard. A void has one only
 * when a `pick` with no winners made it (reason `no_award`); `void_task` stores none.
 */
export const OutcomeViewSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("picked"),
    winners: z.array(PayoutViewSchema),
    fee: U128StringSchema,
    scorecard_hash: HashHexSchema,
    scorecard_uri: z.string(),
  }),
  z.object({
    kind: z.literal("voided"),
    reason: VoidReasonSchema,
    scorecard_hash: HashHexSchema.nullable(),
    scorecard_uri: z.string().nullable(),
  }),
]);
export type OutcomeView = z.infer<typeof OutcomeViewSchema>;

/** A task, as `get_task` and `get_tasks` return it. Timestamps are nanoseconds. */
export const TaskViewSchema = z.object({
  id: U64StringSchema,
  poster: AccountIdSchema,
  token: AccountIdSchema,
  reward: U128StringSchema,
  fee_bps: U16,
  brief_uri: z.string(),
  brief_hash: HashHexSchema,
  criteria_hash: HashHexSchema,
  heldout_commitment: HashHexSchema.nullable(),
  verifier: AccountIdSchema,
  created_at: U64StringSchema,
  commit_deadline: U64StringSchema,
  reveal_deadline: U64StringSchema,
  pick_deadline: U64StringSchema,
  fallback_deadline: U64StringSchema,
  /** 0 means unlimited. */
  max_entries: U32,
  max_winners: U8,
  /** Empty means open to anyone. */
  invited: z.array(AccountIdSchema),
  parent: U64StringSchema.nullable(),
  commit_count: U32,
  reveal_count: U32,
  cleaned: U32,
  funders: z.array(FunderViewSchema),
  /** `null` until the task is settled. */
  outcome: OutcomeViewSchema.nullable(),
  phase: PhaseSchema,
});
export type TaskView = z.infer<typeof TaskViewSchema>;

/** An entry, as `get_entry` and `get_entries` return it. */
export const EntryViewSchema = z.object({
  task_id: U64StringSchema,
  account: AccountIdSchema,
  /** The entry's place in the task's entrant order, from 0. */
  index: U32,
  commitment: HashHexSchema,
  /** The block of the entry's latest commit. */
  committed_at_block: U64StringSchema,
  /** `null` until the entry is revealed, like `uri`. */
  content_hash: HashHexSchema.nullable(),
  uri: z.string().nullable(),
});
export type EntryView = z.infer<typeof EntryViewSchema>;

/** An amount of one token. */
const TokenBalanceSchema = z.object({
  token: AccountIdSchema,
  amount: U128StringSchema,
});

/** A registered agent, as `get_agent` returns it. */
export const AgentViewSchema = z.object({
  account: AccountIdSchema,
  /** The provider the agent runs under, the parent account of a sub-account. */
  asp: AccountIdSchema.nullable(),
  profile_uri: z.string(),
  profile_hash: HashHexSchema,
  tags: z.array(z.string()),
  /** When the agent first registered, in nanoseconds. */
  registered_at: U64StringSchema,
  entries: U32,
  reveals: U32,
  wins: U32,
  /** Total won, per token. */
  earned: z.array(TokenBalanceSchema),
  /** Picks made as a verifier. */
  picks_made: U32,
  /** Empty picks made as a verifier after at least one entry was revealed. */
  voids_after_reveals: U32,
});
export type AgentView = z.infer<typeof AgentViewSchema>;

/** One allowlisted token, with the limits on its rewards. */
const TokenConfigViewSchema = z.object({
  token: AccountIdSchema,
  min_reward: U128StringSchema,
  max_reward: U128StringSchema,
  enabled: z.boolean(),
});

/** The contract's configuration, as `get_config` returns it. */
export const ConfigViewSchema = z.object({
  owner: AccountIdSchema,
  pending_owner: AccountIdSchema.nullable(),
  treasury: AccountIdSchema,
  fee_bps: U16,
  min_window_secs: U32,
  max_window_secs: U32,
  paused: z.boolean(),
  version: U16,
  tokens: z.array(TokenConfigViewSchema),
});
export type ConfigView = z.infer<typeof ConfigViewSchema>;

/** An account's storage balance, as the storage methods return it. All amounts are yoctoNEAR. */
export const StorageViewSchema = z.object({
  /** Everything the account has deposited and not withdrawn. */
  total: U128StringSchema,
  /** What it could withdraw now: `total` minus the cost of `used_bytes`. */
  available: U128StringSchema,
  /** Bytes of contract state charged to the account. */
  used_bytes: U64StringSchema,
});
export type StorageView = z.infer<typeof StorageViewSchema>;

/**
 * A delegate key's spending caps, as `get_delegate` returns it (plan 01 Task 15, not built yet):
 * the token it may spend, the most for one task, the most in all, and what it has spent so far.
 */
export const DelegateViewSchema = z.object({
  token: AccountIdSchema,
  per_task_cap: U128StringSchema,
  total_cap: U128StringSchema,
  spent: U128StringSchema,
});
export type DelegateView = z.infer<typeof DelegateViewSchema>;
