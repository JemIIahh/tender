//! Tender: a non-custodial NEAR task-bounty contract.
//!
//! All token balances sit in an internal vault, so function-call keys never attach deposits.
//! Task ids are sequential, so views paginate without iterating a map. The phase of a task is
//! derived from block time, never stored.

mod admin;
mod auth;
mod entries;
mod events;
mod registry;
mod storage;
mod tasks;
#[cfg(test)]
mod test_utils;
mod types;
mod vault;

use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{env, near, AccountId, BorshStorageKey, PanicOnDefault, PublicKey};

use crate::types::{
    err, AgentProfile, DelegateCaps, Entry, StorageAccount, Task, TokenConfig, MAX_FEE_BPS,
    MAX_WINDOW_SECS,
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
            next_task_id: 1,
            tokens: IterableMap::new(StorageKey::Tokens),
            vault: LookupMap::new(StorageKey::Vault),
            storage: LookupMap::new(StorageKey::Storage),
            tasks: LookupMap::new(StorageKey::Tasks),
            entries: LookupMap::new(StorageKey::Entries),
            entrant_at: LookupMap::new(StorageKey::EntrantAt),
            agents: LookupMap::new(StorageKey::Agents),
            delegates: LookupMap::new(StorageKey::Delegates),
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
