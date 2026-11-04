//! Tender: a non-custodial NEAR task-bounty contract.
//!
//! All token balances sit in an internal vault, so function-call keys never attach deposits.
//! Task ids are sequential, so views paginate without iterating a map. The phase of a task is
//! derived from block time, never stored.
//!
//! The methods that accounts call to change state refuse a top-level argument they do not take
//! (`#[deny_unknown_arguments]`), so a misspelled or misplaced key is an error instead of a
//! silently absent option. The exceptions are the standard NEP-141 and NEP-145 methods
//! (`ft_on_transfer`, `storage_deposit`, `storage_withdraw`), whose callers may send extra
//! arguments.

mod admin;
mod auth;
mod entries;
mod events;
#[cfg(test)]
mod props;
mod registry;
mod settle;
mod storage;
mod tasks;
#[cfg(test)]
mod test_utils;
mod types;
mod vault;

use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{env, near, AccountId, BorshStorageKey, PanicOnDefault, PublicKey};

use crate::types::{
    err, AgentProfile, Bond, DelegateCaps, Entry, StorageAccount, Task, TokenConfig,
    DEFAULT_BOND_COOLDOWN_SECS, MAX_FEE_BPS, MAX_WINDOW_SECS,
};

/// Storage prefixes, one per collection in `Tender`, in field order.
#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Tokens,
    Vault,
    Storage,
    Tasks,
    Entries,
    EntrantAt,
    Agents,
    Delegates,
    DelegateCounts,
}

/// The contract state: configuration, the internal vault, and every task, entry and agent.
#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Tender {
    /// Layout version, checked by `migrate`.
    version: u16,
    owner: AccountId,
    pending_owner: Option<AccountId>,
    treasury: AccountId,
    fee_bps: u16,
    min_window_secs: u32,
    paused: bool,
    /// The bond `register_agent` takes; `None` until the owner sets one.
    agent_bond: Option<Bond>,
    /// Seconds from `unregister_agent` to when `claim_agent_bond` pays back.
    agent_bond_cooldown_secs: u64,
    next_task_id: u64,
    /// Token allowlist.
    tokens: IterableMap<AccountId, TokenConfig>,
    /// `(account, token)` to balance.
    vault: LookupMap<(AccountId, AccountId), u128>,
    storage: LookupMap<AccountId, StorageAccount>,
    tasks: LookupMap<u64, Task>,
    /// `(task id, account)` to entry.
    entries: LookupMap<(u64, AccountId), Entry>,
    /// `(task id, entry index)` to account.
    entrant_at: LookupMap<(u64, u32), AccountId>,
    agents: LookupMap<AccountId, AgentProfile>,
    /// `(account, public key)` to spending caps.
    delegates: LookupMap<(AccountId, PublicKey), DelegateCaps>,
    /// How many delegate keys each account has registered, for the accounts that have any.
    delegate_counts: LookupMap<AccountId, u32>,
}

#[near]
impl Tender {
    /// Initialises the contract. `fee_bps` is capped at `MAX_FEE_BPS` (`E_FEE`) and
    /// `min_window_secs` must be in `1..=MAX_WINDOW_SECS` (`E_WINDOW`).
    ///
    /// Callable only by the contract account itself, so deploy and `new` go in one transaction.
    #[init]
    #[private]
    pub fn new(owner: AccountId, treasury: AccountId, fee_bps: u16, min_window_secs: u32) -> Self {
        if fee_bps > MAX_FEE_BPS {
            env::panic_str(&format!(
                "{}: fee_bps {fee_bps} exceeds the cap of {MAX_FEE_BPS}",
                err::E_FEE
            ));
        }
        if !(1..=MAX_WINDOW_SECS).contains(&min_window_secs) {
            env::panic_str(&format!(
                "{}: min_window_secs {min_window_secs} must be between 1 and {MAX_WINDOW_SECS}",
                err::E_WINDOW
            ));
        }
        Self {
            version: 1,
            owner,
            pending_owner: None,
            treasury,
            fee_bps,
            min_window_secs,
            paused: false,
            agent_bond: None,
            agent_bond_cooldown_secs: DEFAULT_BOND_COOLDOWN_SECS,
            next_task_id: 1,
            tokens: IterableMap::new(StorageKey::Tokens),
            vault: LookupMap::new(StorageKey::Vault),
            storage: LookupMap::new(StorageKey::Storage),
            tasks: LookupMap::new(StorageKey::Tasks),
            entries: LookupMap::new(StorageKey::Entries),
            entrant_at: LookupMap::new(StorageKey::EntrantAt),
            agents: LookupMap::new(StorageKey::Agents),
            delegates: LookupMap::new(StorageKey::Delegates),
            delegate_counts: LookupMap::new(StorageKey::DelegateCounts),
        }
    }
}

#[cfg(test)]
mod tests {
    use near_sdk::testing_env;

    use crate::test_utils::ctx;
    use crate::types::MAX_WINDOW_SECS;
    use crate::Tender;

    #[test]
    #[should_panic(expected = "E_FEE")]
    fn new_rejects_fee_above_cap() {
        testing_env!(ctx("owner.test").build());
        Tender::new(
            "owner.test".parse().unwrap(),
            "treasury.test".parse().unwrap(),
            1_001,
            60,
        );
    }

    #[test]
    #[should_panic(expected = "E_WINDOW")]
    fn new_rejects_zero_min_window() {
        testing_env!(ctx("owner.test").build());
        Tender::new(
            "owner.test".parse().unwrap(),
            "treasury.test".parse().unwrap(),
            500,
            0,
        );
    }

    #[test]
    #[should_panic(expected = "E_WINDOW")]
    fn new_rejects_min_window_above_max() {
        testing_env!(ctx("owner.test").build());
        Tender::new(
            "owner.test".parse().unwrap(),
            "treasury.test".parse().unwrap(),
            500,
            MAX_WINDOW_SECS + 1,
        );
    }

    /// The storage layout as it is frozen (ruling R33): the collections' prefixes, the Borsh tags
    /// of the stored enums, a fresh contract's root state, a task record and an agent record,
    /// byte for byte. Once
    /// deployed, any of these may change only together with a `migrate` that reads the old form.
    /// A failure here means a change moved the layout: undo it, or write that migration and then
    /// update the pins.
    #[test]
    fn storage_layout_is_pinned() {
        use near_sdk::{borsh, env, AccountId};

        use crate::types::{AgentProfile, AgentStatus, Bond, Outcome, Payout, Task, VoidReason};
        use crate::StorageKey;

        let acct = |id: &str| id.parse::<AccountId>().unwrap();
        let prefixes = [
            StorageKey::Tokens,
            StorageKey::Vault,
            StorageKey::Storage,
            StorageKey::Tasks,
            StorageKey::Entries,
            StorageKey::EntrantAt,
            StorageKey::Agents,
            StorageKey::Delegates,
            StorageKey::DelegateCounts,
        ];
        for (tag, key) in prefixes.iter().enumerate() {
            assert_eq!(borsh::to_vec(key).unwrap(), [tag as u8], "prefix {tag}");
        }
        for (tag, reason) in [
            VoidReason::NoReveals,
            VoidReason::NoAward,
            VoidReason::Expired,
        ]
        .iter()
        .enumerate()
        {
            assert_eq!(borsh::to_vec(reason).unwrap(), [tag as u8], "{reason:?}");
        }
        let voided = Outcome::Voided {
            reason: VoidReason::Expired,
            scorecard_hash: None,
            scorecard_uri: None,
        };
        assert_eq!(borsh::to_vec(&voided).unwrap(), [1, 2, 0, 0]);

        testing_env!(ctx("owner.test").build());
        let fresh = Tender::new(acct("owner.test"), acct("treasury.test"), 500, 60);
        assert_eq!(hex::encode(borsh::to_vec(&fresh).unwrap()), FRESH_STATE);

        let task = Task {
            id: 7,
            poster: acct("poster.test"),
            token: acct("usdc.test"),
            reward: 1_000_000,
            fee_bps: 500,
            brief_uri: "ipfs://brief".to_string(),
            brief_hash: [1; 32],
            criteria_hash: [2; 32],
            heldout_commitment: Some([3; 32]),
            verifier: acct("judge.test"),
            created_at: 10,
            commit_deadline: 20,
            reveal_deadline: 30,
            pick_deadline: 40,
            fallback_deadline: 50,
            max_entries: 2,
            max_winners: 1,
            invited: vec![acct("bob.test"), acct("carol.test")],
            parent: Some(3),
            commit_count: 2,
            reveal_count: 1,
            cleaned: 0,
            funders: vec![(acct("poster.test"), 900_000), (acct("bob.test"), 100_000)],
            outcome: Some(Outcome::Picked {
                winners: vec![Payout {
                    account: acct("bob.test"),
                    bps: 10_000,
                    amount: 950_000,
                }],
                fee: 50_000,
                scorecard_hash: [4; 32],
                scorecard_uri: "ipfs://scorecard".to_string(),
            }),
        };
        let encoded = borsh::to_vec(&task).unwrap();
        let digest = hex::encode(env::sha256(&encoded));
        assert_eq!((encoded.len(), digest.as_str()), TASK_RECORD);

        // An agent record with every field set, and the status tags.
        for (tag, status) in [
            AgentStatus::Active,
            AgentStatus::Unregistering,
            AgentStatus::Retired,
        ]
        .iter()
        .enumerate()
        {
            assert_eq!(borsh::to_vec(status).unwrap(), [tag as u8], "{status:?}");
        }
        let agent = AgentProfile {
            profile_uri: "ipfs://profile".to_string(),
            profile_hash: [5; 32],
            tags: vec!["rust".to_string()],
            asp: Some(acct("acme.test")),
            registered_at: 11,
            entries: 3,
            reveals: 2,
            wins: 1,
            earned: vec![(acct("usdc.test"), 950_000)],
            picks_made: 4,
            voids_after_reveals: 1,
            status: AgentStatus::Unregistering,
            bond: Some(Bond {
                token: acct("usdc.test"),
                amount: 5_000_000,
            }),
            unregistering_since: 12,
            claimable_at: 13,
            locked_until: 14,
        };
        let encoded = borsh::to_vec(&agent).unwrap();
        let digest = hex::encode(env::sha256(&encoded));
        assert_eq!((encoded.len(), digest.as_str()), AGENT_RECORD);
    }

    /// `storage_layout_is_pinned`'s fresh contract, hex-encoded.
    const FRESH_STATE: &str = "01000a0000006f776e65722e74657374000d00000074726561737572792e74657374f4013c0000000000007512000000000001000000000000000000000002000000007602000000006d01000000010100000002010000000301000000040100000005010000000601000000070100000008";
    /// `storage_layout_is_pinned`'s task record: its length and the SHA-256 of its encoding.
    const TASK_RECORD: (usize, &str) = (
        444,
        "88e61c51eaf368c7f13e662de31431982f7a53555e8ce8a13621e06a1f33212a",
    );
    /// `storage_layout_is_pinned`'s agent record: its length and the SHA-256 of its encoding.
    const AGENT_RECORD: (usize, &str) = (
        192,
        "f404ecdae5f24b6c591857ce91a5cb558a2cf43c5c6a8b23610b89815e3296f2",
    );

    #[test]
    fn new_accepts_min_window_bounds() {
        testing_env!(ctx("owner.test").build());
        for secs in [1, MAX_WINDOW_SECS] {
            let t = Tender::new(
                "owner.test".parse().unwrap(),
                "treasury.test".parse().unwrap(),
                500,
                secs,
            );
            assert_eq!(t.get_config().min_window_secs, secs);
        }
    }
}
