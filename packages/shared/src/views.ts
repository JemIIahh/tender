import { z } from "zod";
import {
  AccountIdSchema,
  HashHexSchema,
  U8Schema,
  U16Schema,
  U32Schema,
  U64StringSchema,
  U128StringSchema,
} from "./primitives";

// The schemas below check what the contract's view methods return (contract/tender/src/types.rs),
// field for field. They follow the contract's JSON, which writes numbers by their Rust type: a u64
// or u128 is a decimal string and a u8, u16 or u32 a JSON integer (see `primitives.ts`).
//
// A view schema drops a key it does not know, so a field a later contract upgrade adds does not
// break a client that predates it. The sample tests notice a new field once a sample is captured
// again from the new contract.
//
// A uri (`brief_uri`, `uri`, `scorecard_uri`, `profile_uri`) is any UTF-8 text of 1 to 256 bytes,
// which is all the contract checks of one (`check_uri`). It need not be a URL, and it can hold a
// NUL or another control character. The schemas let these through on purpose: refusing one would
// fail the whole view over a field that anyone can fill. A consumer that stores a uri must clean it
// first: neither a `text` column nor `jsonb` holds a NUL, so the indexer replaces each one with
// U+FFFD.

// Defined in `primitives.ts`. These four stay exported from here, where `index.ts` finds them.
export { AccountIdSchema, HashHexSchema, U64StringSchema, U128StringSchema };

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
  bps: U16Schema,
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
    /** A uri: arbitrary text from the chain, see the note at the top. */
    scorecard_uri: z.string(),
  }),
  z.object({
    kind: z.literal("voided"),
    reason: VoidReasonSchema,
    scorecard_hash: HashHexSchema.nullable(),
    /** A uri when there is one: arbitrary text from the chain, see the note at the top. */
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
  fee_bps: U16Schema,
  /** A uri: arbitrary text from the chain, see the note at the top. */
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
  max_entries: U32Schema,
  max_winners: U8Schema,
  /** Empty means open to anyone. */
  invited: z.array(AccountIdSchema),
  parent: U64StringSchema.nullable(),
  commit_count: U32Schema,
  reveal_count: U32Schema,
  cleaned: U32Schema,
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
  index: U32Schema,
  commitment: HashHexSchema,
  /** The block of the entry's latest commit. */
  committed_at_block: U64StringSchema,
  /** `null` until the entry is revealed, like `uri`. */
  content_hash: HashHexSchema.nullable(),
  /** A uri: arbitrary text from the chain, which the entrant chose. See the note at the top. */
  uri: z.string().nullable(),
});
export type EntryView = z.infer<typeof EntryViewSchema>;

/** An amount of one token. */
const TokenBalanceSchema = z.object({
  token: AccountIdSchema,
  amount: U128StringSchema,
});

/**
 * Where a registered agent stands (contract Task 16b). Only an `active` agent may enter an open
 * task. An `unregistering` one has called `unregister_agent` and waits out the cooldown, and a
 * `retired` one has claimed its bond back; its profile and counters stay.
 */
export const AgentStatusSchema = z.enum(["active", "unregistering", "retired"]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

/** A registered agent, as `get_agent` returns it. */
export const AgentViewSchema = z.object({
  account: AccountIdSchema,
  /** The provider the agent runs under, the parent account of a sub-account. */
  asp: AccountIdSchema.nullable(),
  /** A uri: arbitrary text from the chain, see the note at the top. */
  profile_uri: z.string(),
  profile_hash: HashHexSchema,
  tags: z.array(z.string()),
  /** When the agent first registered, in nanoseconds. */
  registered_at: U64StringSchema,
  entries: U32Schema,
  reveals: U32Schema,
  wins: U32Schema,
  /** Total won, per token. */
  earned: z.array(TokenBalanceSchema),
  /** Picks made as a verifier. */
  picks_made: U32Schema,
  /** Empty picks made as a verifier after at least one entry was revealed. */
  voids_after_reveals: U32Schema,
  status: AgentStatusSchema,
  /**
   * The bond the contract holds for the agent: its token and amount. Both `null` if the agent paid
   * none (it registered before the owner set one), and once `claim_agent_bond` has paid it back.
   */
  bond_token: AccountIdSchema.nullable(),
  bond_amount: U128StringSchema.nullable(),
  /** While the agent is `unregistering`, from when it can claim its bond (ns); else `null`. */
  claimable_at: U64StringSchema.nullable(),
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
  fee_bps: U16Schema,
  min_window_secs: U32Schema,
  max_window_secs: U32Schema,
  paused: z.boolean(),
  version: U16Schema,
  tokens: z.array(TokenConfigViewSchema),
  /**
   * The bond `register_agent` takes from a new agent's vault: its token and amount. Both `null`
   * until the owner sets one with `set_agent_bond`.
   */
  agent_bond_token: AccountIdSchema.nullable(),
  agent_bond_amount: U128StringSchema.nullable(),
  /** How many seconds an agent waits from `unregister_agent` until it can claim its bond. */
  agent_bond_cooldown_secs: U64StringSchema,
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
 * A delegate key's spending caps, as `get_delegate` returns it: the token it may spend, the most
 * for one task, the most in all, and what it has spent so far. The shape is from plan 01 Task 15's
 * brief; re-check when delegates land.
 */
export const DelegateViewSchema = z.object({
  token: AccountIdSchema,
  per_task_cap: U128StringSchema,
  total_cap: U128StringSchema,
  spent: U128StringSchema,
});
export type DelegateView = z.infer<typeof DelegateViewSchema>;
