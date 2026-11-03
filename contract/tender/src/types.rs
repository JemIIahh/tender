//! Constants, error codes, hash helpers, and the state and view structs.
//!
//! The state structs fix the contract's storage layout. They are Borsh-encoded in field order, so
//! once a contract is deployed a field may only be added through `migrate`.
//!
//! An item marked `#[allow(dead_code)]` has no caller yet; the attribute comes off with the first
//! one.

use near_sdk::json_types::{U128, U64};
use near_sdk::{env, near, AccountId, Gas};

/// Longest any of the four task windows may be: 14 days.
pub const MAX_WINDOW_SECS: u32 = 1_209_600;
/// Highest protocol fee: 10%.
pub const MAX_FEE_BPS: u16 = 1_000;
/// Highest `max_reward` a token may be allowlisted with: about 3.4 * 10^34 of its smallest unit. A
/// pick multiplies a reward by up to 10_000 basis points, which for any reward up to this fits in
/// a u128, so every task can be picked.
pub const MAX_REWARD_LIMIT: u128 = u128::MAX / 10_000;
/// Most winners one task may pay.
pub const MAX_WINNERS: u8 = 5;
/// Most accounts a task may invite.
pub const MAX_INVITED: usize = 20;
/// Most funders a pooled bounty may have, the poster among them. A void refunds each one in the
/// same call, so this bounds its vault writes.
pub const MAX_FUNDERS: usize = 50;
/// Longest URI stored on chain.
pub const MAX_URI_BYTES: usize = 256;
/// Most tags on an agent profile.
pub const MAX_TAGS: usize = 8;
/// Longest tag, in characters.
pub const MAX_TAG_LEN: usize = 24;
/// Largest page a view returns.
pub const MAX_PAGE: u32 = 50;
/// Smallest first storage deposit: 0.01 NEAR.
pub const STORAGE_MIN_DEPOSIT: u128 = 10u128.pow(22);
/// Upper bound on the bytes one vault slot occupies.
pub const VAULT_SLOT_MAX_BYTES: u64 = 200;
/// Bytes the poster reserves at posting so settlement never needs new storage.
pub const OUTCOME_RESERVE_BYTES: u64 = 800;
/// Gas attached to the token's `ft_transfer` in `withdraw`.
pub const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
/// Gas attached to the `on_withdraw` callback.
pub const GAS_ON_WITHDRAW: Gas = Gas::from_tgas(10);
/// Least prepaid gas `withdraw` accepts.
pub const MIN_WITHDRAW_GAS: Gas = Gas::from_tgas(35);

/// Error codes. Every panic message starts with one, as `"<CODE>: <detail>"`.
#[allow(dead_code)]
pub mod err {
    pub const E_AUTH: &str = "E_AUTH";
    pub const E_OWNER: &str = "E_OWNER";
    pub const E_PAUSED: &str = "E_PAUSED";
    pub const E_TOKEN: &str = "E_TOKEN";
    pub const E_REWARD: &str = "E_REWARD";
    pub const E_FUNDS: &str = "E_FUNDS";
    pub const E_STORAGE: &str = "E_STORAGE";
    pub const E_WINDOW: &str = "E_WINDOW";
    pub const E_PHASE: &str = "E_PHASE";
    pub const E_NOT_FOUND: &str = "E_NOT_FOUND";
    pub const E_INVITE: &str = "E_INVITE";
    pub const E_FULL: &str = "E_FULL";
    pub const E_COMMITMENT: &str = "E_COMMITMENT";
    pub const E_REVEALED: &str = "E_REVEALED";
    pub const E_WINNERS: &str = "E_WINNERS";
    pub const E_PARENT: &str = "E_PARENT";
    pub const E_LIMIT: &str = "E_LIMIT";
    pub const E_HASH: &str = "E_HASH";
    pub const E_URI: &str = "E_URI";
    pub const E_TAGS: &str = "E_TAGS";
    pub const E_FEE: &str = "E_FEE";
    pub const E_GAS: &str = "E_GAS";
    pub const E_SETTLED: &str = "E_SETTLED";
    pub const E_VERSION: &str = "E_VERSION";
}

/// Parses a 64-character lowercase hex string into 32 bytes.
///
/// Panics with `E_HASH` on uppercase, a wrong length, or any non-hex character. `field` names the
/// argument in the message.
pub(crate) fn parse_hash(field: &str, s: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    // `hex` accepts uppercase, so the case check is ours; it also rejects a wrong length.
    let lowercase = s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    if !lowercase || hex::decode_to_slice(s, &mut out).is_err() {
        env::panic_str(&format!(
            "{}: {field}: expected 64 lowercase hex chars",
            err::E_HASH
        ));
    }
    out
}

/// Formats 32 bytes as 64 lowercase hex characters.
pub(crate) fn hex32(h: &[u8; 32]) -> String {
    hex::encode(h)
}

/// Panics `E_URI` unless `uri` is 1 to `MAX_URI_BYTES` bytes. `field` names the argument in the
/// message.
pub(crate) fn check_uri(field: &str, uri: &str) {
    if !(1..=MAX_URI_BYTES).contains(&uri.len()) {
        env::panic_str(&format!(
            "{}: {field} must be 1 to {MAX_URI_BYTES} bytes, got {}",
            err::E_URI,
            uri.len()
        ));
    }
}

/// An account's storage balance.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StorageAccount {
    /// Total yoctoNEAR deposited.
    pub deposited: u128,
    /// Bytes of contract state charged to this account.
    pub used_bytes: u64,
}

/// Limits for one allowlisted token. Rewards are in the token's smallest unit.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TokenConfig {
    pub min_reward: u128,
    pub max_reward: u128,
    pub enabled: bool,
}

/// A registered agent's profile and reputation counters.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentProfile {
    pub profile_uri: String,
    pub profile_hash: [u8; 32],
    pub tags: Vec<String>,
    pub asp: Option<AccountId>,
    pub registered_at: u64,
    pub entries: u32,
    pub reveals: u32,
    pub wins: u32,
    /// Total earned per token, as `(token, amount)`.
    pub earned: Vec<(AccountId, u128)>,
    /// Picks made as a verifier.
    pub picks_made: u32,
    /// Empty picks made as a verifier after at least one entry was revealed.
    pub voids_after_reveals: u32,
}

/// A bounty. Timestamps are nanoseconds; the phase is derived from them, never stored.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Task {
    pub id: u64,
    pub poster: AccountId,
    pub token: AccountId,
    /// Escrowed total: the initial reward plus top-ups.
    pub reward: u128,
    /// Snapshot of the protocol fee when the task was posted.
    pub fee_bps: u16,
    pub brief_uri: String,
    pub brief_hash: [u8; 32],
    pub criteria_hash: [u8; 32],
    pub heldout_commitment: Option<[u8; 32]>,
    pub verifier: AccountId,
    pub created_at: u64,
    pub commit_deadline: u64,
    pub reveal_deadline: u64,
    pub pick_deadline: u64,
    pub fallback_deadline: u64,
    /// 0 means unlimited; non-zero only together with `invited`.
    pub max_entries: u32,
    pub max_winners: u8,
    /// Empty means open to anyone.
    pub invited: Vec<AccountId>,
    pub parent: Option<u64>,
    pub commit_count: u32,
    pub reveal_count: u32,
    /// How many entries `cleanup` has removed so far.
    pub cleaned: u32,
    /// Who paid the escrow, as `(account, amount)`, for refunds: the poster first, then each
    /// account that topped the task up, in the order of its first top-up, one record per account
    /// and at most `MAX_FUNDERS`. The amounts add up to `reward`.
    pub funders: Vec<(AccountId, u128)>,
    /// `None` until the task is settled.
    pub outcome: Option<Outcome>,
}

/// Where a task is in its life, derived from block time and `outcome`.
#[near(serializers = [json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Open,
    Revealing,
    Judging,
    Fallback,
    Expired,
    Settled,
}

/// One committed entry. `index` is its position in the task's entrant order.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub commitment: [u8; 32],
    pub index: u32,
    pub committed_at_block: u64,
    pub revealed: Option<Revealed>,
}

/// What an entrant revealed.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Revealed {
    pub content_hash: [u8; 32],
    pub uri: String,
}

/// How a settled task ended, in its stored (Borsh) form: hashes are raw bytes and amounts are
/// `u128`. Views render hashes as hex and amounts as strings.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    Picked {
        winners: Vec<Payout>,
        fee: u128,
        scorecard_hash: [u8; 32],
        scorecard_uri: String,
    },
    Voided {
        reason: VoidReason,
        scorecard_hash: Option<[u8; 32]>,
        scorecard_uri: Option<String>,
    },
}

/// One winner's share of a pick.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Payout {
    pub account: AccountId,
    pub bps: u16,
    pub amount: u128,
}

/// Why a task was voided.
#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VoidReason {
    NoReveals,
    NoAward,
    Expired,
}

/// A spending key registered by an account, with its caps.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DelegateCaps {
    pub token: AccountId,
    pub per_task_cap: u128,
    pub total_cap: u128,
    pub spent: u128,
}

/// One allowlisted token, as shown by `get_config`.
#[near(serializers = [json])]
pub struct TokenConfigView {
    pub token: AccountId,
    pub min_reward: U128,
    pub max_reward: U128,
    pub enabled: bool,
}

/// The contract's configuration, as returned by `get_config`.
#[near(serializers = [json])]
pub struct ConfigView {
    pub owner: AccountId,
    pub pending_owner: Option<AccountId>,
    pub treasury: AccountId,
    pub fee_bps: u16,
    pub min_window_secs: u32,
    pub max_window_secs: u32,
    pub paused: bool,
    pub version: u16,
    pub tokens: Vec<TokenConfigView>,
}

/// An account's storage balance, as returned by the storage methods. All amounts are yoctoNEAR.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StorageView {
    /// Everything the account has deposited and not withdrawn.
    pub total: U128,
    /// What it could withdraw now: `total` minus the cost of `used_bytes`.
    pub available: U128,
    /// Bytes of contract state charged to the account.
    pub used_bytes: U64,
}

/// NEP-145's bounds on a storage balance, as `storage_balance_bounds` returns them, in yoctoNEAR:
/// `min` is the least a first deposit must be, and `max` is `null` because there is no most.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StorageBalanceBounds {
    pub min: U128,
    pub max: Option<U128>,
}

/// An amount of one token, as the balance views return it. The amount is a decimal string.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TokenBalance {
    pub token: AccountId,
    pub amount: U128,
}

/// A registered agent, as returned by `get_agent`. The hash is 64 lowercase hex characters, and
/// the timestamp and every amount are decimal strings.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentView {
    pub account: AccountId,
    /// The provider the agent runs under: the parent of a sub-account, such as `acme.near` for
    /// `bot1.acme.near`. `None` when the account has no such parent.
    pub asp: Option<AccountId>,
    pub profile_uri: String,
    pub profile_hash: String,
    pub tags: Vec<String>,
    /// When the agent first registered, in nanoseconds.
    pub registered_at: U64,
    pub entries: u32,
    pub reveals: u32,
    pub wins: u32,
    /// Total won, per token.
    pub earned: Vec<TokenBalance>,
    /// Picks made as a verifier.
    pub picks_made: u32,
    /// Empty picks made as a verifier after at least one entry was revealed.
    pub voids_after_reveals: u32,
}

/// The arguments of `post_task`, which takes them as `{"task": {...}}`. `reward` is a decimal
/// string in the token's smallest unit, each hash is 64 lowercase hex characters, and each window
/// is in seconds. The optional fields may be left out or `null`.
///
/// An unknown key fails to parse. A posted task cannot be changed, so a misspelled key must not
/// be read as an absent one: `verifer` would otherwise make the poster the verifier, with the
/// reward locked under terms nobody asked for.
#[near(serializers = [json])]
#[serde(deny_unknown_fields)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PostTaskArgs {
    pub token: AccountId,
    pub reward: U128,
    pub brief_uri: String,
    pub brief_hash: String,
    pub criteria_hash: String,
    pub heldout_commitment: Option<String>,
    /// Who picks the winners. `None` makes it the poster.
    pub verifier: Option<AccountId>,
    pub commit_secs: u32,
    pub reveal_secs: u32,
    pub pick_secs: u32,
    pub fallback_secs: u32,
    /// 0 means unlimited; non-zero only together with `invited`.
    pub max_entries: u32,
    pub max_winners: u8,
    /// Empty means open to anyone.
    pub invited: Vec<AccountId>,
    /// The task this one is a sub-task of: one the poster has entered, still unsettled, whose
    /// commit window ends no earlier than this task's pick window (`E_PARENT` otherwise).
    pub parent: Option<U64>,
}

/// One winner of a pick, as `pick` takes it: `{"account": "bob.near", "bps": 7000}`. `bps` is the
/// winner's share, in basis points, of the reward left after the fee, and the shares of one pick
/// add up to 10_000.
///
/// An unknown key fails to parse. A pick pays out at once and cannot be undone, so a client that
/// sends, say, an `amount` beside `bps` must learn that only `bps` decides the payout before
/// anything is paid, not after.
#[near(serializers = [json])]
#[serde(deny_unknown_fields)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WinnerArg {
    pub account: AccountId,
    pub bps: u16,
}

/// One funder of a task's escrow and what it paid in, as `get_task` shows it.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FunderView {
    pub account: AccountId,
    pub amount: U128,
}

/// One winner's share of a pick, as the views show it.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PayoutView {
    pub account: AccountId,
    pub bps: u16,
    pub amount: U128,
}

/// How a settled task ended, as the views show it: `Outcome` with hashes as 64 lowercase hex
/// characters and amounts as decimal strings, tagged by `kind` (`"picked"` or `"voided"`).
#[near(serializers = [json])]
#[serde(tag = "kind", rename_all = "snake_case")]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OutcomeView {
    Picked {
        winners: Vec<PayoutView>,
        fee: U128,
        scorecard_hash: String,
        scorecard_uri: String,
    },
    Voided {
        reason: VoidReason,
        scorecard_hash: Option<String>,
        scorecard_uri: Option<String>,
    },
}

/// A task, as returned by `get_task` and `get_tasks`: every field of `Task`, plus the phase it is
/// in at the block time of the call. Hashes are 64 lowercase hex characters; ids, timestamps
/// (nanoseconds) and amounts are decimal strings.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskView {
    pub id: U64,
    pub poster: AccountId,
    pub token: AccountId,
    pub reward: U128,
    pub fee_bps: u16,
    pub brief_uri: String,
    pub brief_hash: String,
    pub criteria_hash: String,
    pub heldout_commitment: Option<String>,
    pub verifier: AccountId,
    pub created_at: U64,
    pub commit_deadline: U64,
    pub reveal_deadline: U64,
    pub pick_deadline: U64,
    pub fallback_deadline: U64,
    pub max_entries: u32,
    pub max_winners: u8,
    pub invited: Vec<AccountId>,
    pub parent: Option<U64>,
    pub commit_count: u32,
    pub reveal_count: u32,
    pub cleaned: u32,
    pub funders: Vec<FunderView>,
    /// `null` until the task is settled.
    pub outcome: Option<OutcomeView>,
    pub phase: Phase,
}

/// An entry, as returned by `get_entry` and `get_entries`. Hashes are 64 lowercase hex characters,
/// and the task id and block height are decimal strings. `content_hash` and `uri` are `null` until
/// the entry is revealed.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntryView {
    pub task_id: U64,
    pub account: AccountId,
    /// The entry's place in the task's entrant order, from 0.
    pub index: u32,
    pub commitment: String,
    /// The block of the entry's latest commit.
    pub committed_at_block: U64,
    pub content_hash: Option<String>,
    pub uri: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_hash_roundtrip() {
        let h = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";
        assert_eq!(hex32(&parse_hash("brief_hash", h)), h);
    }

    #[test]
    #[should_panic(expected = "E_HASH: brief_hash: expected 64 lowercase hex chars")]
    fn parse_hash_rejects_uppercase() {
        parse_hash(
            "brief_hash",
            "B94D27B9934D3E08A52E52D7DA7DABFAC484EFE37A5380EE9088F7ACE2EFCDE9",
        );
    }

    #[test]
    #[should_panic(expected = "E_HASH: salt: expected 64 lowercase hex chars")]
    fn parse_hash_rejects_short() {
        parse_hash("salt", "abcd");
    }
}
