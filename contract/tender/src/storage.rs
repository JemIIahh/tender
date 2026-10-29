//! Storage balances and measured charging.
//!
//! An account prepays NEAR for the bytes its records occupy, in the usual NEP-145 shape:
//! `storage_deposit`, `storage_withdraw`, `storage_balance_of` and `storage_balance_bounds`. A
//! method that grows contract state charges the growth to a payer through `settle_storage`.
//!
//! `near_sdk::store` collections cache their writes until `flush` or drop, so
//! `env::storage_usage()` read in the middle of a method does not see that method's inserts and
//! removes. Every state-growing method therefore follows one pattern:
//!
//! ```text
//! let before = self.storage_mark();      // flushes, then reads the usage
//! // ... insert and remove records ...
//! self.settle_storage(&payer, before);   // flushes, reads the usage, charges or refunds the change
//! ```
//!
//! Leaving a flush out does not fail loudly. It measures 0 bytes, which is free storage.

use near_sdk::json_types::{U128, U64};
use near_sdk::{assert_one_yocto, env, near, AccountId, NearToken, Promise};

use crate::events::{emit, StorageDeposit};
use crate::types::{err, StorageAccount, StorageBalanceBounds, StorageView, STORAGE_MIN_DEPOSIT};
use crate::{Tender, TenderExt};

/// What `bytes` of contract state cost at the protocol's storage price. It saturates, so an
/// absurd byte count reads as unaffordable instead of wrapping.
pub(crate) fn bytes_cost(bytes: u64) -> u128 {
    u128::from(bytes).saturating_mul(env::storage_byte_cost().as_yoctonear())
}

fn not_registered() -> ! {
    env::panic_str(&format!("{}: not registered", err::E_STORAGE))
}

fn insufficient() -> ! {
    env::panic_str(&format!(
        "{}: insufficient storage balance; call storage_deposit",
        err::E_STORAGE
    ))
}

impl StorageAccount {
    /// The deposit not yet spent on bytes. Zero if the bytes ever cost more than the deposit.
    fn available(&self) -> u128 {
        self.deposited.saturating_sub(bytes_cost(self.used_bytes))
    }

    /// Charges `bytes`, panicking `E_STORAGE` if the deposit no longer covers them.
    ///
    /// Charging nothing always goes through. Otherwise an account whose deposit fell short of the
    /// bytes it already uses, which only a rise in the storage price can cause, could not even
    /// make a call that adds no bytes.
    fn charge(&mut self, bytes: u64) {
        if bytes == 0 {
            return;
        }
        let used = self
            .used_bytes
            .checked_add(bytes)
            .unwrap_or_else(|| insufficient());
        if bytes_cost(used) > self.deposited {
            insufficient();
        }
        self.used_bytes = used;
    }

    /// Gives `bytes` back, stopping at zero.
    fn refund(&mut self, bytes: u64) {
        self.used_bytes = self.used_bytes.saturating_sub(bytes);
    }

    fn view(&self) -> StorageView {
        StorageView {
            total: U128(self.deposited),
            available: U128(self.available()),
            used_bytes: U64(self.used_bytes),
        }
    }
}

#[near]
impl Tender {
    /// Credits `account_id` (default: the caller) with the attached NEAR as storage balance.
    /// Anyone may deposit for anyone.
    ///
    /// The first deposit for an account registers it. It must be at least `STORAGE_MIN_DEPOSIT`,
    /// the `min` of `storage_balance_bounds` (`E_STORAGE`), and covers the new record's own bytes,
    /// which are charged to the account. Later deposits just add, with no minimum.
    ///
    /// With `registration_only: true` the call only registers, as NEP-145 has it: an account that
    /// is not registered yet is credited exactly `STORAGE_MIN_DEPOSIT`, one that is is credited
    /// nothing, and the rest of the attached NEAR goes back to the caller in a transfer.
    ///
    /// Emits `storage_deposit` with what was credited. A `registration_only` call that credits
    /// nothing emits nothing.
    #[payable]
    pub fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageView {
        let account = account_id.unwrap_or_else(env::predecessor_account_id);
        let attached = env::attached_deposit().as_yoctonear();
        let registration_only = registration_only.unwrap_or(false);
        // What the call credits: `None` when it only registers and the account already is.
        let (view, credited) = match self.storage.get_mut(&account) {
            Some(record) if registration_only => (record.view(), None),
            Some(record) => {
                record.deposited += attached;
                (record.view(), Some(attached))
            }
            None => {
                if attached < STORAGE_MIN_DEPOSIT {
                    env::panic_str(&format!(
                        "{}: a first deposit must be at least {STORAGE_MIN_DEPOSIT} yoctoNEAR, got {attached}",
                        err::E_STORAGE
                    ));
                }
                let credited = if registration_only {
                    STORAGE_MIN_DEPOSIT
                } else {
                    attached
                };
                (self.register(&account, credited), Some(credited))
            }
        };
        let refund = attached - credited.unwrap_or(0);
        if refund > 0 {
            // Detached on purpose, as in `storage_withdraw`: the caller gets the view, and the
            // receipt is created either way.
            Promise::new(env::predecessor_account_id())
                .transfer(NearToken::from_yoctonear(refund))
                .detach();
        }
        if let Some(amount) = credited {
            emit(
                "storage_deposit",
                &StorageDeposit {
                    account,
                    amount: U128(amount),
                    total: view.total,
                },
            );
        }
        view
    }

    /// Pays the caller `amount` of its available storage balance, or all of it if `None`
    /// (`E_STORAGE` if `amount` is more than is available). Bytes already in use stay funded.
    ///
    /// Requires exactly 1 yoctoNEAR, so a function-call key cannot withdraw. That yocto stays in
    /// the contract. A zero amount sends nothing.
    #[payable]
    pub fn storage_withdraw(&mut self, amount: Option<U128>) -> StorageView {
        assert_one_yocto();
        let account = env::predecessor_account_id();
        let record = self
            .storage
            .get_mut(&account)
            .unwrap_or_else(|| not_registered());
        let available = record.available();
        let amount = match amount {
            None => available,
            Some(U128(wanted)) if wanted <= available => wanted,
            Some(U128(wanted)) => env::panic_str(&format!(
                "{}: cannot withdraw {wanted}; only {available} is available",
                err::E_STORAGE
            )),
        };
        // Debit before the transfer is scheduled.
        record.deposited -= amount;
        let view = record.view();
        if amount > 0 {
            // Detached on purpose: the caller gets the view, and the receipt is created either way.
            Promise::new(account)
                .transfer(NearToken::from_yoctonear(amount))
                .detach();
        }
        view
    }

    /// The storage balance of `account_id`, or `None` if it has never deposited.
    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageView> {
        self.storage.get(&account_id).map(StorageAccount::view)
    }

    /// NEP-145's bounds on a storage balance: `min` is `STORAGE_MIN_DEPOSIT`, the least a first
    /// deposit must be, and there is no `max`.
    pub fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        StorageBalanceBounds {
            min: U128(STORAGE_MIN_DEPOSIT),
            max: None,
        }
    }
}

impl Tender {
    /// Writes every collection's cached changes to storage.
    ///
    /// `self` is destructured without `..`, so a field added to `Tender` is a compile error here
    /// until it is dealt with. A collection left out of this flush would be free storage.
    pub(crate) fn flush_all(&mut self) {
        let Self {
            version: _,
            owner: _,
            pending_owner: _,
            treasury: _,
            fee_bps: _,
            min_window_secs: _,
            paused: _,
            next_task_id: _,
            tokens,
            vault,
            storage,
            tasks,
            entries,
            entrant_at,
            agents,
            delegates,
        } = self;
        tokens.flush();
        vault.flush();
        storage.flush();
        tasks.flush();
        entries.flush();
        entrant_at.flush();
        agents.flush();
        delegates.flush();
    }

    /// Flushes, then returns the contract's storage usage. This is the `before` that a
    /// state-growing method hands to `settle_storage`.
    pub(crate) fn storage_mark(&mut self) -> u64 {
        self.flush_all();
        env::storage_usage()
    }

    /// Charges `account` for the growth in storage usage since `before`, or refunds the
    /// shrinkage. Panics `E_STORAGE` if `account` is not registered, or if the growth is more than
    /// it has available.
    pub(crate) fn settle_storage(&mut self, account: &AccountId, before: u64) {
        // The flush is what makes the inserts and removes of the caller visible to the runtime.
        self.flush_all();
        let after = env::storage_usage();
        let record = self
            .storage
            .get_mut(account)
            .unwrap_or_else(|| not_registered());
        if after >= before {
            record.charge(after - before);
        } else {
            record.refund(before - after);
        }
    }

    /// What `account` could withdraw now, in yoctoNEAR. Zero if it is not registered.
    pub(crate) fn storage_available(&self, account: &AccountId) -> u128 {
        self.storage
            .get(account)
            .map_or(0, StorageAccount::available)
    }

    /// Charges `bytes` to `account` without writing anything, for bytes that will be written
    /// later. Panics `E_STORAGE` if `account` is not registered or cannot afford them.
    pub(crate) fn reserve_bytes(&mut self, account: &AccountId, bytes: u64) {
        self.storage
            .get_mut(account)
            .unwrap_or_else(|| not_registered())
            .charge(bytes);
    }

    /// Gives `bytes` back to `account`, stopping at zero. It never panics, so a cleanup path
    /// cannot get stuck on it, and it ignores an account that is not registered.
    pub(crate) fn release_bytes(&mut self, account: &AccountId, bytes: u64) {
        if let Some(record) = self.storage.get_mut(account) {
            record.refund(bytes);
        }
    }

    /// Charges `bytes` to `account` without checking that its deposit covers them, stopping at
    /// `u64::MAX`. It never panics, and it ignores an account that is not registered.
    ///
    /// Only for bytes the account has paid for another way. Settlement charges a task's outcome
    /// to its poster with it, right after releasing the larger reserve that paid for the outcome
    /// at posting, so that settling never fails on storage.
    pub(crate) fn add_used_bytes_unchecked(&mut self, account: &AccountId, bytes: u64) {
        if let Some(record) = self.storage.get_mut(account) {
            record.used_bytes = record.used_bytes.saturating_add(bytes);
        }
    }

    /// Creates the record for an account's first deposit, of `deposit`, and charges it its own
    /// bytes. `storage_deposit` has checked that the deposit is at least `STORAGE_MIN_DEPOSIT`.
    fn register(&mut self, account: &AccountId, deposit: u128) -> StorageView {
        let before = self.storage_mark();
        self.storage.insert(
            account.clone(),
            StorageAccount {
                deposited: deposit,
                used_bytes: 0,
            },
        );
        self.settle_storage(account, before);
        self.storage
            .get(account)
            .map(StorageAccount::view)
            .unwrap_or_else(|| not_registered())
    }
}

#[cfg(test)]
mod tests {
    use near_sdk::json_types::U128;
    use near_sdk::mock::MockAction;
    use near_sdk::test_utils::{get_created_receipts, get_logs};
    use near_sdk::{borsh, env, testing_env, AccountId, CurveType, NearToken, PublicKey};

    use crate::test_utils::{ctx, fresh, panic_message};
    use crate::types::{
        AgentProfile, DelegateCaps, Entry, StorageAccount, StorageView, Task, TokenConfig,
        STORAGE_MIN_DEPOSIT,
    };
    use crate::Tender;

    const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
    /// 0.05 NEAR, the deposit most tests start from.
    const DEPOSIT: NearToken = NearToken::from_millinear(50);
    const DEPOSIT_YOCTO: u128 = 5 * 10u128.pow(22);

    fn acct(id: &str) -> AccountId {
        id.parse().unwrap()
    }

    fn byte_cost() -> u128 {
        env::storage_byte_cost().as_yoctonear()
    }

    /// Makes `who` the caller, attaching `deposit`.
    fn call_as(who: &str, deposit: NearToken) {
        testing_env!(ctx(who).attached_deposit(deposit).build());
    }

    /// A contract in which `who` has deposited `deposit` and nothing else is stored. `who` stays
    /// the caller.
    fn registered(who: &str, deposit: NearToken) -> Tender {
        let mut t = fresh();
        call_as(who, deposit);
        t.storage_deposit(None, None);
        t
    }

    fn view(t: &Tender, who: &str) -> StorageView {
        t.storage_balance_of(acct(who)).expect("registered")
    }

    fn used(t: &Tender, who: &str) -> u64 {
        view(t, who).used_bytes.0
    }

    /// Yocto sent to `who` by the receipts created so far.
    fn transfers_to(who: &str) -> Vec<u128> {
        get_created_receipts()
            .iter()
            .filter(|r| r.receiver_id == acct(who))
            .flat_map(|r| r.actions.iter())
            .filter_map(|a| match a {
                MockAction::Transfer { deposit, .. } => Some(deposit.as_yoctonear()),
                _ => None,
            })
            .collect()
    }

    fn agent(value_len: usize) -> AgentProfile {
        let mut p = AgentProfile {
            profile_uri: String::new(),
            profile_hash: [0; 32],
            tags: vec![],
            asp: None,
            registered_at: 0,
            entries: 0,
            reveals: 0,
            wins: 0,
            earned: vec![],
            picks_made: 0,
            voids_after_reveals: 0,
        };
        // Pad the URI until the record's Borsh value is exactly `value_len` bytes.
        let fixed = borsh::to_vec(&p).unwrap().len();
        p.profile_uri = "x".repeat(value_len - fixed);
        assert_eq!(borsh::to_vec(&p).unwrap().len(), value_len);
        p
    }

    /// Grows storage through a real collection insert: an `agents` record whose Borsh value is
    /// `value_len` bytes. The insert is only cached until a flush. Returns the bytes the record
    /// adds to contract storage: the protocol's 40 bytes of overhead per record, the key (a
    /// 1-byte prefix, a 4-byte length and the account id) and the value.
    fn insert_agent(t: &mut Tender, id: &str, value_len: usize) -> u64 {
        t.agents.insert(acct(id), agent(value_len));
        (40 + 1 + 4 + id.len() + value_len) as u64
    }

    #[test]
    #[should_panic(expected = "E_STORAGE: a first deposit must be at least")]
    fn first_deposit_below_minimum_rejected() {
        let mut t = fresh();
        call_as(
            "alice.test",
            NearToken::from_yoctonear(STORAGE_MIN_DEPOSIT - 1),
        );
        t.storage_deposit(None, None);
    }

    #[test]
    fn first_deposit_at_minimum_registers() {
        let mut t = fresh();
        call_as("alice.test", NearToken::from_yoctonear(STORAGE_MIN_DEPOSIT));
        let v = t.storage_deposit(None, None);
        assert_eq!(v.total.0, STORAGE_MIN_DEPOSIT);
    }

    #[test]
    fn deposit_registers_and_charges_record_bytes() {
        let mut t = fresh();
        call_as("alice.test", DEPOSIT);
        let v = t.storage_deposit(None, None);
        assert_eq!(v.total.0, DEPOSIT_YOCTO);
        assert!(v.used_bytes.0 > 0);
        assert!(v.available.0 < v.total.0);
        // The record's own bytes: 40 of overhead, the key (1 + 4 + the 10-byte account id) and the
        // 24-byte value (a u128 and a u64).
        assert_eq!(v.used_bytes.0, 40 + (1 + 4 + 10) + 24);
        assert_eq!(v.available.0, v.total.0 - 79 * byte_cost());
        assert_eq!(t.storage_balance_of(acct("alice.test")), Some(v.clone()));
        assert_eq!(t.storage_available(&acct("alice.test")), v.available.0);
    }

    #[test]
    fn storage_view_json_uses_strings() {
        let mut t = fresh();
        call_as("alice.test", DEPOSIT);
        let v = t.storage_deposit(None, None);
        assert_eq!(
            near_sdk::serde_json::to_string(&v).unwrap(),
            r#"{"total":"50000000000000000000000","available":"49210000000000000000000","used_bytes":"79"}"#
        );
    }

    #[test]
    fn deposit_for_other_account() {
        let mut t = fresh();
        call_as("alice.test", DEPOSIT);
        let v = t.storage_deposit(Some(acct("bob.test")), None);
        assert_eq!(v.total.0, DEPOSIT_YOCTO);
        assert_eq!(view(&t, "bob.test"), v);
        // Paying for bob does not register alice.
        assert_eq!(t.storage_balance_of(acct("alice.test")), None);
    }

    #[test]
    fn deposit_to_registered_account_has_no_minimum() {
        let mut t = registered("alice.test", DEPOSIT);
        let first = view(&t, "alice.test");
        call_as("carol.test", ONE_YOCTO);
        let v = t.storage_deposit(Some(acct("alice.test")), None);
        assert_eq!(v.total.0, first.total.0 + 1);
        // The record already exists, so there is nothing new to charge.
        assert_eq!(v.used_bytes, first.used_bytes);
    }

    #[test]
    fn storage_deposit_emits_event() {
        let mut t = fresh();
        call_as("alice.test", DEPOSIT);
        t.storage_deposit(Some(acct("bob.test")), None);
        // A context change clears the logs, so read each call's logs before the next one.
        assert_eq!(
            get_logs(),
            [
                r#"EVENT_JSON:{"standard":"tender","version":"1.0.0","event":"storage_deposit","data":[{"account":"bob.test","amount":"50000000000000000000000","total":"50000000000000000000000"}]}"#
            ]
        );
        // `total` is bob's balance after the deposit, not the amount.
        call_as("alice.test", NearToken::from_yoctonear(7));
        t.storage_deposit(Some(acct("bob.test")), None);
        assert_eq!(
            get_logs(),
            [
                r#"EVENT_JSON:{"standard":"tender","version":"1.0.0","event":"storage_deposit","data":[{"account":"bob.test","amount":"7","total":"50000000000000000000007"}]}"#
            ]
        );
    }

    /// The `storage_deposit` event for a credit of `amount` that leaves `account` with `total`.
    fn deposit_event(account: &str, amount: u128, total: u128) -> String {
        format!(
            r#"EVENT_JSON:{{"standard":"tender","version":"1.0.0","event":"storage_deposit","data":[{{"account":"{account}","amount":"{amount}","total":"{total}"}}]}}"#
        )
    }

    #[test]
    fn storage_balance_bounds_is_the_registration_floor() {
        let mut t = fresh();
        let bounds = t.storage_balance_bounds();
        // NEP-145's shape: the least balance as a decimal string, and no most.
        assert_eq!(
            near_sdk::serde_json::to_string(&bounds).unwrap(),
            r#"{"min":"10000000000000000000000","max":null}"#
        );
        // `min` is what a first deposit has to be: one yocto less is refused...
        call_as("alice.test", NearToken::from_yoctonear(bounds.min.0 - 1));
        let rejected = panic_message(|| {
            t.storage_deposit(None, None);
        });
        assert!(
            rejected
                .as_ref()
                .is_some_and(|m| m.starts_with("E_STORAGE: a first deposit must be at least")),
            "{rejected:?}"
        );
        assert_eq!(t.storage_balance_of(acct("alice.test")), None);
        // ...and `min` itself registers.
        call_as("alice.test", NearToken::from_yoctonear(bounds.min.0));
        assert_eq!(t.storage_deposit(None, None).total, bounds.min);
    }

    #[test]
    fn registration_only_registers_with_the_minimum_and_refunds_the_rest() {
        let mut t = fresh();
        // alice pays for bob, who has no storage balance yet, and asks only to register him.
        call_as("alice.test", DEPOSIT);
        let v = t.storage_deposit(Some(acct("bob.test")), Some(true));
        // bob is registered with exactly the minimum, which pays for his record: 40 bytes of
        // overhead, the key (1 + 4 + the 8-byte account id) and the 24-byte value.
        assert_eq!(v.total.0, STORAGE_MIN_DEPOSIT);
        assert_eq!(v.used_bytes.0, 40 + (1 + 4 + 8) + 24);
        assert_eq!(view(&t, "bob.test"), v);
        // The rest goes back to alice, who sent it, in one transfer.
        assert_eq!(
            transfers_to("alice.test"),
            vec![DEPOSIT_YOCTO - STORAGE_MIN_DEPOSIT]
        );
        assert!(transfers_to("bob.test").is_empty());
        // The event says what was credited, not what was attached.
        assert_eq!(
            get_logs(),
            [deposit_event(
                "bob.test",
                STORAGE_MIN_DEPOSIT,
                STORAGE_MIN_DEPOSIT
            )]
        );

        // With exactly the minimum attached, there is nothing to send back.
        call_as("carol.test", NearToken::from_yoctonear(STORAGE_MIN_DEPOSIT));
        assert_eq!(
            t.storage_deposit(None, Some(true)).total.0,
            STORAGE_MIN_DEPOSIT
        );
        assert!(get_created_receipts().is_empty());
    }

    #[test]
    #[should_panic(expected = "E_STORAGE: a first deposit must be at least")]
    fn registration_only_below_the_minimum_rejected() {
        let mut t = fresh();
        call_as(
            "alice.test",
            NearToken::from_yoctonear(STORAGE_MIN_DEPOSIT - 1),
        );
        t.storage_deposit(None, Some(true));
    }

    #[test]
    fn registration_only_for_a_registered_account_refunds_everything() {
        let mut t = registered("alice.test", DEPOSIT);
        let before = view(&t, "alice.test");
        // carol asks to register alice, who is registered already.
        call_as("carol.test", DEPOSIT);
        assert_eq!(
            t.storage_deposit(Some(acct("alice.test")), Some(true)),
            before
        );
        // Nothing is credited, all of it goes back to carol, and with nothing credited there is
        // no event.
        assert_eq!(view(&t, "alice.test"), before);
        assert_eq!(transfers_to("carol.test"), vec![DEPOSIT_YOCTO]);
        assert!(transfers_to("alice.test").is_empty());
        assert!(get_logs().is_empty());

        // With nothing attached, nothing goes back either.
        call_as("alice.test", NearToken::from_yoctonear(0));
        assert_eq!(t.storage_deposit(None, Some(true)), before);
        assert!(get_created_receipts().is_empty());
        assert!(get_logs().is_empty());
    }

    #[test]
    fn registration_only_false_or_absent_credits_everything() {
        let mut t = fresh();
        for (who, flag) in [("alice.test", None), ("dave.test", Some(false))] {
            // A first deposit is credited in full...
            call_as(who, DEPOSIT);
            assert_eq!(
                t.storage_deposit(None, flag).total.0,
                DEPOSIT_YOCTO,
                "{flag:?}"
            );
            assert!(get_created_receipts().is_empty(), "{flag:?}");
            // ...and so is a later one, from anyone.
            call_as("bob.test", NearToken::from_yoctonear(7));
            let v = t.storage_deposit(Some(acct(who)), flag);
            assert_eq!(v.total.0, DEPOSIT_YOCTO + 7, "{flag:?}");
            assert!(
                get_created_receipts().is_empty(),
                "{flag:?}: nothing goes back"
            );
            assert_eq!(get_logs(), [deposit_event(who, 7, DEPOSIT_YOCTO + 7)]);
        }
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn storage_withdraw_requires_one_yocto() {
        let mut t = registered("alice.test", DEPOSIT);
        call_as("alice.test", NearToken::from_yoctonear(0));
        t.storage_withdraw(None);
    }

    #[test]
    #[should_panic(expected = "E_STORAGE: not registered")]
    fn storage_withdraw_requires_registration() {
        let mut t = fresh();
        call_as("alice.test", ONE_YOCTO);
        t.storage_withdraw(None);
    }

    #[test]
    #[should_panic(expected = "E_STORAGE: cannot withdraw")]
    fn storage_withdraw_caps_at_available() {
        let mut t = registered("alice.test", DEPOSIT);
        let available = view(&t, "alice.test").available.0;
        call_as("alice.test", ONE_YOCTO);
        t.storage_withdraw(Some(U128(available + 1)));
    }

    #[test]
    fn storage_withdraw_none_takes_all_available() {
        let mut t = registered("alice.test", DEPOSIT);
        let before = view(&t, "alice.test");
        call_as("alice.test", ONE_YOCTO);
        let after = t.storage_withdraw(None);
        assert_eq!(after.available.0, 0);
        assert_eq!(after.total.0, before.total.0 - before.available.0);
        // Withdrawing frees no bytes, so the bytes in use keep their backing.
        assert_eq!(after.used_bytes, before.used_bytes);
        assert_eq!(after.total.0, before.used_bytes.0 as u128 * byte_cost());
        assert_eq!(view(&t, "alice.test"), after);
        // The NEAR leaves as one transfer to the caller.
        assert_eq!(transfers_to("alice.test"), vec![before.available.0]);
    }

    #[test]
    fn storage_withdraw_part_of_available() {
        let mut t = registered("alice.test", DEPOSIT);
        let before = view(&t, "alice.test");
        call_as("alice.test", ONE_YOCTO);
        let after = t.storage_withdraw(Some(U128(10u128.pow(22))));
        assert_eq!(after.total.0, before.total.0 - 10u128.pow(22));
        assert_eq!(after.available.0, before.available.0 - 10u128.pow(22));
        assert_eq!(transfers_to("alice.test"), vec![10u128.pow(22)]);
    }

    #[test]
    fn storage_withdraw_of_nothing_creates_no_transfer() {
        let mut t = registered("alice.test", DEPOSIT);
        let before = view(&t, "alice.test");
        call_as("alice.test", ONE_YOCTO);
        // An explicit zero changes nothing.
        assert_eq!(t.storage_withdraw(Some(U128(0))), before);
        // `None` with nothing left to take is a no-op too.
        t.storage_withdraw(None);
        let drained = t.storage_withdraw(None);
        assert_eq!(drained.available.0, 0);
        assert_eq!(
            transfers_to("alice.test"),
            vec![before.available.0],
            "only the one real withdrawal sends NEAR"
        );
    }

    #[test]
    fn settle_storage_charges_and_refunds() {
        let mut t = registered("alice.test", DEPOSIT);
        let alice = acct("alice.test");
        let start = used(&t, "alice.test");

        let before = t.storage_mark();
        let bytes = insert_agent(&mut t, "agent.test", 100);
        t.settle_storage(&alice, before);
        // 40 + (1 + 4 + 10) + 100, and exactly what the runtime reports.
        assert_eq!(bytes, 155);
        assert_eq!(env::storage_usage() - before, bytes);
        assert_eq!(used(&t, "alice.test"), start + bytes);

        let before = t.storage_mark();
        t.agents.remove(&acct("agent.test"));
        t.settle_storage(&alice, before);
        assert_eq!(env::storage_usage(), before - bytes);
        assert_eq!(used(&t, "alice.test"), start);
    }

    #[test]
    fn charging_sees_unflushed_inserts() {
        let mut t = registered("alice.test", DEPOSIT);
        let start = used(&t, "alice.test");

        let before = t.storage_mark();
        insert_agent(&mut t, "agent.test", 100);
        // The premise: the insert is cached, so the runtime has not seen it yet.
        assert_eq!(env::storage_usage(), before);
        // No flush here. `settle_storage` has to make the insert visible before it measures.
        t.settle_storage(&acct("alice.test"), before);
        assert!(used(&t, "alice.test") > start, "the insert was not charged");
    }

    #[test]
    fn settle_storage_charges_down_to_the_last_byte() {
        // 0.01 NEAR buys 1,000 bytes and the record takes 79 of them, so 921 bytes remain.
        let mut t = registered("alice.test", NearToken::from_yoctonear(STORAGE_MIN_DEPOSIT));
        let before = t.storage_mark();
        let bytes = insert_agent(&mut t, "agent.test", 866);
        assert_eq!(bytes, 921);
        t.settle_storage(&acct("alice.test"), before);
        assert_eq!(view(&t, "alice.test").available.0, 0);
    }

    #[test]
    #[should_panic(expected = "E_STORAGE: insufficient storage balance; call storage_deposit")]
    fn settle_storage_panics_when_insufficient() {
        // The same insert one byte larger than the 921 bytes that remain.
        let mut t = registered("alice.test", NearToken::from_yoctonear(STORAGE_MIN_DEPOSIT));
        let before = t.storage_mark();
        assert_eq!(insert_agent(&mut t, "agent.test", 867), 922);
        t.settle_storage(&acct("alice.test"), before);
    }

    #[test]
    fn settling_no_growth_passes_an_account_under_water() {
        // A rise in the storage price can leave a deposit short of the bytes it already pays for.
        // Such an account must still be able to make a call that adds no bytes.
        let mut t = registered("alice.test", DEPOSIT);
        let alice = acct("alice.test");
        t.storage.get_mut(&alice).unwrap().deposited = 0;
        let before = view(&t, "alice.test");
        assert!(
            before.used_bytes.0 > 0 && before.total.0 == 0,
            "the premise"
        );

        let mark = t.storage_mark();
        t.settle_storage(&alice, mark);
        assert_eq!(view(&t, "alice.test"), before);

        // A call that does add bytes is still refused, and changes nothing.
        let mark = t.storage_mark();
        insert_agent(&mut t, "agent.test", 100);
        let rejected = panic_message(|| t.settle_storage(&alice, mark));
        assert_eq!(
            rejected.as_deref(),
            Some("E_STORAGE: insufficient storage balance; call storage_deposit")
        );
        assert_eq!(view(&t, "alice.test"), before);
    }

    #[test]
    #[should_panic(expected = "E_STORAGE: not registered")]
    fn settle_storage_requires_registration() {
        let mut t = fresh();
        let before = t.storage_mark();
        t.settle_storage(&acct("alice.test"), before);
    }

    #[test]
    fn storage_mark_flushes_pending_writes() {
        let mut t = fresh();
        let before = env::storage_usage();
        let bytes = insert_agent(&mut t, "agent.test", 100);
        assert_eq!(
            env::storage_usage(),
            before,
            "inserts are cached until a flush"
        );
        assert_eq!(t.storage_mark(), before + bytes);
    }

    #[test]
    fn flush_all_writes_every_collection() {
        let (alice, usdc) = (acct("alice.test"), acct("usdc.test"));
        let key = PublicKey::from_parts(CurveType::ED25519, vec![1; 32]).unwrap();
        let mut t = fresh();
        t.tokens.insert(
            usdc.clone(),
            TokenConfig {
                min_reward: 1,
                max_reward: 2,
                enabled: true,
            },
        );
        t.vault.insert((alice.clone(), usdc.clone()), 5);
        t.storage.insert(
            alice.clone(),
            StorageAccount {
                deposited: 1,
                used_bytes: 0,
            },
        );
        t.tasks.insert(
            1,
            Task {
                id: 1,
                poster: alice.clone(),
                token: usdc.clone(),
                reward: 1,
                fee_bps: 500,
                brief_uri: String::new(),
                brief_hash: [0; 32],
                criteria_hash: [0; 32],
                heldout_commitment: None,
                verifier: alice.clone(),
                created_at: 0,
                commit_deadline: 0,
                reveal_deadline: 0,
                pick_deadline: 0,
                fallback_deadline: 0,
                max_entries: 0,
                max_winners: 1,
                invited: vec![],
                parent: None,
                commit_count: 0,
                reveal_count: 0,
                cleaned: 0,
                funders: vec![],
                outcome: None,
            },
        );
        t.entries.insert(
            (1, alice.clone()),
            Entry {
                commitment: [0; 32],
                index: 0,
                committed_at_block: 1,
                revealed: None,
            },
        );
        t.entrant_at.insert((1, 0), alice.clone());
        t.agents.insert(alice.clone(), agent(100));
        t.delegates.insert(
            (alice, key),
            DelegateCaps {
                token: usdc,
                per_task_cap: 1,
                total_cap: 2,
                spent: 0,
            },
        );

        let before = env::storage_usage();
        t.flush_all();
        let flushed = env::storage_usage();
        assert!(flushed > before);
        // Dropping the contract writes whatever is still cached. Nothing may be left.
        drop(t);
        assert_eq!(
            env::storage_usage(),
            flushed,
            "a collection was not flushed"
        );
    }

    #[test]
    fn reserve_bytes_adds_to_used_bytes() {
        let mut t = registered("alice.test", DEPOSIT);
        let before = view(&t, "alice.test");
        t.reserve_bytes(&acct("alice.test"), 800);
        let after = view(&t, "alice.test");
        assert_eq!(after.used_bytes.0, before.used_bytes.0 + 800);
        assert_eq!(after.available.0, before.available.0 - 800 * byte_cost());
        assert_eq!(after.total, before.total);
    }

    #[test]
    fn reserve_bytes_can_use_the_last_byte() {
        let mut t = registered("alice.test", NearToken::from_yoctonear(STORAGE_MIN_DEPOSIT));
        t.reserve_bytes(&acct("alice.test"), 921);
        assert_eq!(view(&t, "alice.test").available.0, 0);
    }

    #[test]
    #[should_panic(expected = "E_STORAGE: insufficient storage balance; call storage_deposit")]
    fn reserve_bytes_panics_when_insufficient() {
        let mut t = registered("alice.test", NearToken::from_yoctonear(STORAGE_MIN_DEPOSIT));
        t.reserve_bytes(&acct("alice.test"), 922);
    }

    #[test]
    fn release_bytes_refunds_and_saturates_at_zero() {
        let mut t = registered("alice.test", DEPOSIT);
        let alice = acct("alice.test");
        let start = used(&t, "alice.test");
        t.reserve_bytes(&alice, 800);
        t.release_bytes(&alice, 300);
        assert_eq!(used(&t, "alice.test"), start + 500);
        // More than the account has ever used: it stops at zero instead of panicking.
        t.release_bytes(&alice, u64::MAX);
        assert_eq!(used(&t, "alice.test"), 0);
        // An account that was never registered is ignored.
        t.release_bytes(&acct("nobody.test"), 5);
    }

    #[test]
    fn add_used_bytes_unchecked_skips_the_balance_check_and_saturates() {
        // 0.01 NEAR buys 1,000 bytes and the record takes 79 of them. Reserving the other 921
        // leaves nothing available.
        let mut t = registered("alice.test", NearToken::from_yoctonear(STORAGE_MIN_DEPOSIT));
        let alice = acct("alice.test");
        t.reserve_bytes(&alice, 921);
        assert_eq!(view(&t, "alice.test").available.0, 0);
        // Where `reserve_bytes` would panic, this charges the bytes anyway.
        t.add_used_bytes_unchecked(&alice, 5);
        assert_eq!(used(&t, "alice.test"), 1_005);
        assert_eq!(view(&t, "alice.test").available.0, 0);
        assert_eq!(view(&t, "alice.test").total.0, STORAGE_MIN_DEPOSIT);
        // It stops at u64::MAX instead of wrapping or panicking.
        t.add_used_bytes_unchecked(&alice, u64::MAX);
        assert_eq!(used(&t, "alice.test"), u64::MAX);
        // An account that was never registered is ignored, and stays unregistered.
        t.add_used_bytes_unchecked(&acct("nobody.test"), 5);
        assert_eq!(t.storage_balance_of(acct("nobody.test")), None);
    }

    #[test]
    fn storage_available_is_zero_when_unregistered() {
        let t = fresh();
        assert_eq!(t.storage_available(&acct("alice.test")), 0);
        assert_eq!(t.storage_balance_of(acct("alice.test")), None);
    }
}
