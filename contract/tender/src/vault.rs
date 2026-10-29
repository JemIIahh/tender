//! The internal vault: a balance per `(account, token)`, and the only way money enters or leaves.
//!
//! A deposit arrives as a NEP-141 `ft_transfer_call`, which calls `ft_on_transfer`. That method
//! never panics: it either credits the deposit or hands the whole amount back, and the token
//! refunds what is handed back. A withdrawal debits first, asks the token to pay, and restores the
//! balance in a callback if the payment fails. Both paths are built so that money cannot be lost:
//! every check that can refuse a deposit runs before the first write, and every write after it
//! has already been shown to succeed.

use near_contract_standards::fungible_token::core::ext_ft_core;
use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::json_types::U128;
use near_sdk::serde::Deserialize;
use near_sdk::{
    assert_one_yocto, env, near, serde_json, AccountId, Gas, NearToken, Promise, PromiseError,
    PromiseOrValue,
};

use crate::events::{emit, Deposit, Withdraw};
use crate::storage::bytes_cost;
use crate::types::{
    err, TokenBalance, GAS_FT_TRANSFER, GAS_ON_WITHDRAW, MIN_WITHDRAW_GAS, VAULT_SLOT_MAX_BYTES,
};
use crate::{Tender, TenderExt};

/// The only `msg` a deposit may carry besides the empty string: `{"for":"<account>"}`. An unknown
/// or repeated key, or an invalid account id, fails to parse.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct DepositMsg {
    #[serde(rename = "for")]
    beneficiary: AccountId,
}

/// The account that `msg` names, or `None` if `msg` is not exactly `{"for":"<account>"}`.
fn named_beneficiary(msg: &str) -> Option<AccountId> {
    // serde also reads a struct from a JSON array of its fields, so `["bob.test"]` would parse.
    // Only an object is a valid message.
    if !msg.trim_start().starts_with('{') {
        return None;
    }
    serde_json::from_str::<DepositMsg>(msg)
        .ok()
        .map(|m| m.beneficiary)
}

/// Panics `E_GAS` if `prepaid` is less than `MIN_WITHDRAW_GAS`.
fn require_withdraw_gas(prepaid: Gas) {
    if prepaid < MIN_WITHDRAW_GAS {
        env::panic_str(&format!(
            "{}: withdraw needs at least {} Tgas prepaid, got {}",
            err::E_GAS,
            MIN_WITHDRAW_GAS.as_tgas(),
            prepaid.as_tgas()
        ));
    }
}

#[near]
impl Tender {
    /// Pays `amount` of `token` out of the caller's vault to `to` (default: the caller).
    ///
    /// Requires exactly 1 yoctoNEAR (`assert_one_yocto`), so a function-call key cannot call it,
    /// and at least `MIN_WITHDRAW_GAS` prepaid (`E_GAS`). `amount` must be positive and at most
    /// the caller's balance (`E_FUNDS`). It works while paused and for a token that has been
    /// disabled.
    ///
    /// The balance is debited first, then the token is asked to `ft_transfer`. If that fails, for
    /// example because `to` has no storage with the token, `on_withdraw` credits the amount back.
    /// This call itself emits nothing: its receipt succeeds either way, so the outcome is only
    /// known in the callback.
    #[payable]
    #[deny_unknown_arguments]
    pub fn withdraw(&mut self, token: AccountId, amount: U128, to: Option<AccountId>) -> Promise {
        assert_one_yocto();
        require_withdraw_gas(env::prepaid_gas());
        if amount.0 == 0 {
            // A zero `ft_transfer` would fail at the token anyway.
            env::panic_str(&format!("{}: amount must be positive", err::E_FUNDS));
        }
        let account = env::predecessor_account_id();
        let to = to.unwrap_or_else(|| account.clone());
        self.debit(&account, &token, amount.0);
        ext_ft_core::ext(token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(to.clone(), amount, None)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_WITHDRAW)
                    .on_withdraw(account, token, amount, to),
            )
    }

    /// Settles a `withdraw` once the token has answered. Returns whether the token paid.
    ///
    /// If it did, this emits `withdraw`. If not, it credits `amount` back to `account` and emits
    /// `withdraw_failed`. The callback runs once per withdrawal, so the balance is restored at most
    /// once. Only the contract itself may call it.
    #[private]
    pub fn on_withdraw(
        &mut self,
        account: AccountId,
        token: AccountId,
        amount: U128,
        to: AccountId,
        #[callback_result] r: Result<(), PromiseError>,
    ) -> bool {
        // The result is read with no length limit, so an `Err` here is always a failed transfer.
        if r.is_ok() {
            emit(
                "withdraw",
                &Withdraw {
                    account,
                    token,
                    amount,
                    to,
                },
            );
            true
        } else {
            // The slot exists because `withdraw` debited it, and slots are never removed.
            self.credit(&account, &token, amount.0);
            emit(
                "withdraw_failed",
                &Withdraw {
                    account,
                    token,
                    amount,
                    to,
                },
            );
            false
        }
    }

    /// What `account_id` holds of `token` in the vault, zero if it has no slot.
    pub fn balance_of(&self, account_id: AccountId, token: AccountId) -> U128 {
        U128(self.vault.get(&(account_id, token)).copied().unwrap_or(0))
    }

    /// Everything `account_id` holds in the vault: one entry per allowlisted token for which it
    /// has a slot, in allowlist order. A token that has been disabled still shows, so the
    /// balance can be withdrawn, and so does a slot that has been emptied.
    pub fn balances_of(&self, account_id: AccountId) -> Vec<TokenBalance> {
        self.tokens
            .keys()
            .filter_map(|token| {
                self.vault
                    .get(&(account_id.clone(), token.clone()))
                    .map(|amount| TokenBalance {
                        token: token.clone(),
                        amount: U128(*amount),
                    })
            })
            .collect()
    }
}

#[near]
impl FungibleTokenReceiver for Tender {
    /// Credits a deposit that `sender_id` made with `ft_transfer_call` on the calling token.
    /// Returns the amount it did not take: zero when it credited the deposit, all of it when it
    /// refused. It never panics, because a panic here could strand funds sent by a contract that
    /// gets no refund (spec 6.1).
    ///
    /// The beneficiary is `sender_id` if `msg` is empty, or the account named in
    /// `{"for":"<account>"}`. The deposit is credited only if all of these hold, and refused,
    /// with no event, otherwise (spec C20):
    /// - the caller is an allowlisted token that is enabled;
    /// - `msg` is one of the two forms above;
    /// - the beneficiary has a storage balance;
    /// - if the beneficiary has no slot for this token yet, it can pay for one, which its storage
    ///   balance must cover up to `VAULT_SLOT_MAX_BYTES` (the slot is charged to the beneficiary,
    ///   never to the sender);
    /// - its balance does not overflow.
    ///
    /// It works while paused, so a pause never traps a deposit in flight.
    fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let token = env::predecessor_account_id();
        let Some(beneficiary) = self.deposit_beneficiary(&token, &sender_id, amount.0, &msg) else {
            return PromiseOrValue::Value(amount);
        };
        // Past this point nothing can panic: the beneficiary has a record, can afford the slot
        // (a slot is at most `VAULT_SLOT_MAX_BYTES`, so `settle_storage` has enough to charge)
        // and cannot overflow.
        if !self.has_slot(&beneficiary, &token) {
            let before = self.storage_mark();
            self.ensure_vault_slot(&beneficiary, &token);
            self.settle_storage(&beneficiary, before);
        }
        self.credit(&beneficiary, &token, amount.0);
        emit(
            "deposit",
            &Deposit {
                account: beneficiary,
                token,
                amount,
                sender: sender_id,
            },
        );
        PromiseOrValue::Value(U128(0))
    }
}

impl Tender {
    /// Who a deposit would be credited to, or `None` if it has to be refunded. This only reads
    /// state and cannot panic, so `ft_on_transfer` checks everything before it writes anything.
    fn deposit_beneficiary(
        &self,
        token: &AccountId,
        sender: &AccountId,
        amount: u128,
        msg: &str,
    ) -> Option<AccountId> {
        // Depositing nothing would only make an empty slot and an event for nothing.
        if amount == 0 || !self.tokens.get(token).is_some_and(|c| c.enabled) {
            return None;
        }
        let beneficiary = if msg.is_empty() {
            sender.clone()
        } else {
            named_beneficiary(msg)?
        };
        if !self.storage.contains_key(&beneficiary) {
            return None;
        }
        let credits = match self.vault.get(&(beneficiary.clone(), token.clone())) {
            Some(balance) => balance.checked_add(amount).is_some(),
            None => self.storage_available(&beneficiary) >= bytes_cost(VAULT_SLOT_MAX_BYTES),
        };
        credits.then_some(beneficiary)
    }

    fn has_slot(&self, account: &AccountId, token: &AccountId) -> bool {
        self.vault.contains_key(&(account.clone(), token.clone()))
    }

    /// Gives `account` an empty slot for `token` if it has none. This grows storage, so the
    /// caller wraps it in `storage_mark` and `settle_storage` and chooses who pays.
    pub(crate) fn ensure_vault_slot(&mut self, account: &AccountId, token: &AccountId) {
        if !self.has_slot(account, token) {
            self.vault.insert((account.clone(), token.clone()), 0);
        }
    }

    /// Adds `amount` to a balance. The slot must exist already (`E_FUNDS`; settlement code makes
    /// slots earlier, so a missing one is a bug), and the sum must fit in a `u128` (`E_FUNDS`).
    pub(crate) fn credit(&mut self, account: &AccountId, token: &AccountId, amount: u128) {
        let balance = self
            .vault
            .get_mut(&(account.clone(), token.clone()))
            .unwrap_or_else(|| env::panic_str(&format!("{}: no vault slot", err::E_FUNDS)));
        *balance = balance.checked_add(amount).unwrap_or_else(|| {
            env::panic_str(&format!("{}: vault balance overflow", err::E_FUNDS))
        });
    }

    /// Takes `amount` out of a balance, panicking `E_FUNDS` if the balance, or the slot, does not
    /// hold that much.
    pub(crate) fn debit(&mut self, account: &AccountId, token: &AccountId, amount: u128) {
        match self.vault.get_mut(&(account.clone(), token.clone())) {
            Some(balance) if *balance >= amount => *balance -= amount,
            _ => env::panic_str(&format!("{}: insufficient vault balance", err::E_FUNDS)),
        }
    }
}

#[cfg(test)]
mod tests {
    use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
    use near_sdk::json_types::{U128, U64};
    use near_sdk::mock::MockAction;
    use near_sdk::serde_json::{self, json};
    use near_sdk::test_utils::{get_created_receipts, get_logs};
    use near_sdk::{
        env, testing_env, AccountId, Gas, NearToken, PromiseError, PromiseOrValue, PromiseResult,
    };

    use crate::test_utils::{ctx, fresh, panic_message};
    use crate::types::{
        TokenBalance, TokenConfig, GAS_FT_TRANSFER, GAS_ON_WITHDRAW, MIN_WITHDRAW_GAS,
        STORAGE_MIN_DEPOSIT, VAULT_SLOT_MAX_BYTES,
    };
    use crate::vault::require_withdraw_gas;
    use crate::Tender;

    const USDC: &str = "usdc.test";
    const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

    fn acct(id: &str) -> AccountId {
        id.parse().unwrap()
    }

    fn byte_cost() -> u128 {
        env::storage_byte_cost().as_yoctonear()
    }

    fn token_config(enabled: bool) -> TokenConfig {
        TokenConfig {
            min_reward: 1,
            max_reward: u128::MAX,
            enabled,
        }
    }

    /// Gives `who` a storage balance of `deposit`. `who` stays the caller.
    fn register(t: &mut Tender, who: &str, deposit: NearToken) {
        testing_env!(ctx(who).attached_deposit(deposit).build());
        t.storage_deposit(None);
    }

    /// A contract with `usdc.test` allowlisted and enabled, and `alice.test` and `bob.test`
    /// registered for storage (0.05 NEAR each). No vault slot exists yet.
    fn world() -> Tender {
        let mut t = fresh();
        t.put_token(acct(USDC), token_config(true));
        register(&mut t, "alice.test", NearToken::from_millinear(50));
        register(&mut t, "bob.test", NearToken::from_millinear(50));
        t
    }

    /// `token` reports a transfer of `amount` from `sender` with `msg`. Returns what
    /// `ft_on_transfer` hands back, which the token then refunds to the sender.
    fn deposit_from(t: &mut Tender, token: &str, sender: &str, amount: u128, msg: &str) -> u128 {
        testing_env!(ctx(token).build());
        match t.ft_on_transfer(acct(sender), U128(amount), msg.to_string()) {
            PromiseOrValue::Value(unused) => unused.0,
            PromiseOrValue::Promise(_) => panic!("ft_on_transfer must answer with a value"),
        }
    }

    /// The same, from the allowlisted token `usdc.test`.
    fn deposit(t: &mut Tender, sender: &str, amount: u128, msg: &str) -> u128 {
        deposit_from(t, USDC, sender, amount, msg)
    }

    fn balance(t: &Tender, who: &str) -> u128 {
        t.balance_of(acct(who), acct(USDC)).0
    }

    fn used_bytes(t: &Tender, who: &str) -> u64 {
        t.storage_balance_of(acct(who))
            .expect("registered")
            .used_bytes
            .0
    }

    /// `who` withdraws `amount` of USDC to `to` (default: `who`), attaching 1 yocto and plenty of
    /// gas.
    fn withdraw(t: &mut Tender, who: &str, amount: u128, to: Option<&str>) {
        testing_env!(ctx(who).attached_deposit(ONE_YOCTO).build());
        // Dropping the promise is what creates its receipts.
        let _ = t.withdraw(acct(USDC), U128(amount), to.map(acct));
    }

    /// Runs `on_withdraw` as the contract itself, after a transfer that succeeded (`ok`) or failed.
    fn call_back(t: &mut Tender, account: &str, amount: u128, to: &str, ok: bool) -> bool {
        let (promise, outcome) = if ok {
            (PromiseResult::Successful(vec![]), Ok(()))
        } else {
            (PromiseResult::Failed, Err(PromiseError::Failed))
        };
        testing_env!(
            ctx("tender.test").build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![promise]
        );
        t.on_withdraw(acct(account), acct(USDC), U128(amount), acct(to), outcome)
    }

    /// A function call the contract has scheduled.
    struct Scheduled {
        receiver: AccountId,
        method: String,
        args: serde_json::Value,
        deposit: u128,
        gas: Gas,
    }

    fn scheduled_calls() -> Vec<Scheduled> {
        get_created_receipts()
            .iter()
            .flat_map(|r| {
                r.actions.iter().filter_map(move |a| match a {
                    MockAction::FunctionCallWeight {
                        method_name,
                        args,
                        attached_deposit,
                        prepaid_gas,
                        ..
                    } => Some(Scheduled {
                        receiver: r.receiver_id.clone(),
                        method: String::from_utf8(method_name.clone()).unwrap(),
                        args: serde_json::from_slice(args).unwrap(),
                        deposit: attached_deposit.as_yoctonear(),
                        gas: *prepaid_gas,
                    }),
                    _ => None,
                })
            })
            .collect()
    }

    fn event(name: &str, data: &str) -> String {
        format!(
            r#"EVENT_JSON:{{"standard":"tender","version":"1.0.0","event":"{name}","data":[{data}]}}"#
        )
    }

    // Ported from the validation spike.

    #[test]
    fn ft_on_transfer_never_panics_and_refunds_bad_input() {
        let mut t = world();
        assert_eq!(deposit(&mut t, "alice.test", 100, ""), 0);
        assert_eq!(deposit(&mut t, "alice.test", 50, "garbage{"), 50);
        assert_eq!(
            deposit(&mut t, "alice.test", 50, r#"{"for":"NOT VALID ID"}"#),
            50
        );
        assert_eq!(deposit(&mut t, "alice.test", 7, r#"{"for":"bob.test"}"#), 0);
        // Alice holds 100 already, so u128::MAX overflows her balance and goes back in full.
        assert_eq!(deposit(&mut t, "alice.test", u128::MAX, ""), u128::MAX);
        // A token that is not allowlisted is refunded in full.
        assert_eq!(deposit_from(&mut t, "evil.test", "alice.test", 9, ""), 9);
        assert_eq!(balance(&t, "alice.test"), 100);
        assert_eq!(balance(&t, "bob.test"), 7);
    }

    #[test]
    fn failed_withdraw_restores_exactly_once() {
        let mut t = world();
        deposit(&mut t, "alice.test", 100, "");
        withdraw(&mut t, "alice.test", 30, None);
        assert_eq!(balance(&t, "alice.test"), 70);
        // The transfer failed. The callback gives the 30 back, once.
        assert!(!call_back(&mut t, "alice.test", 30, "alice.test", false));
        assert_eq!(balance(&t, "alice.test"), 100);
        let failed = get_logs()
            .iter()
            .filter(|l| l.contains("withdraw_failed"))
            .count();
        assert_eq!(failed, 1);
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn withdraw_requires_one_yocto() {
        let mut t = world();
        deposit(&mut t, "alice.test", 100, "");
        testing_env!(ctx("alice.test").build());
        let _ = t.withdraw(acct(USDC), U128(1), None);
    }

    #[test]
    fn u64_crosses_json_as_string() {
        testing_env!(ctx("owner.test")
            .block_timestamp(1_793_028_278_935_742_660)
            .build());
        let now = U64(env::block_timestamp());
        assert_eq!(
            serde_json::to_string(&now).unwrap(),
            "\"1793028278935742660\""
        );
        // The same value as a JSON number loses precision in JavaScript (f64).
        assert_ne!(
            (1_793_028_278_935_742_660u64 as f64) as u64,
            1_793_028_278_935_742_660u64
        );
    }

    // Deposits: what is credited, and what is refunded.

    #[test]
    fn deposit_credits_the_beneficiary_and_emits_an_event() {
        let mut t = world();
        assert_eq!(deposit(&mut t, "alice.test", 100, ""), 0);
        assert_eq!(
            get_logs(),
            [event(
                "deposit",
                r#"{"account":"alice.test","token":"usdc.test","amount":"100","sender":"alice.test"}"#
            )]
        );
        // `for` credits someone else; the event names both.
        assert_eq!(deposit(&mut t, "alice.test", 7, r#"{"for":"bob.test"}"#), 0);
        assert_eq!(
            get_logs(),
            [event(
                "deposit",
                r#"{"account":"bob.test","token":"usdc.test","amount":"7","sender":"alice.test"}"#
            )]
        );
        assert_eq!(balance(&t, "alice.test"), 100);
        assert_eq!(balance(&t, "bob.test"), 7);
    }

    #[test]
    fn deposit_for_a_registered_beneficiary_needs_no_registered_sender() {
        let mut t = world();
        assert_eq!(
            deposit(&mut t, "nobody.test", 7, r#"{"for":"bob.test"}"#),
            0
        );
        assert_eq!(balance(&t, "bob.test"), 7);
    }

    #[test]
    fn unregistered_beneficiary_refunded() {
        let mut t = world();
        let alice_used = used_bytes(&t, "alice.test");
        assert_eq!(
            deposit(&mut t, "alice.test", 40, r#"{"for":"nobody.test"}"#),
            40
        );
        assert_eq!(balance(&t, "nobody.test"), 0);
        assert!(get_logs().is_empty(), "a refusal emits no event");
        // With an empty msg the sender is the beneficiary, so an unregistered sender is refused too.
        assert_eq!(deposit(&mut t, "nobody.test", 40, ""), 40);
        assert_eq!(balance(&t, "nobody.test"), 0);
        assert!(get_logs().is_empty());
        // Nothing was made at the expense of the sender.
        assert_eq!(used_bytes(&t, "alice.test"), alice_used);
    }

    #[test]
    fn a_slot_does_not_stand_in_for_a_storage_record() {
        // No code path makes a slot for an unregistered account today, but the rule is that a
        // beneficiary needs a storage record, whether or not it already has a slot.
        let mut t = world();
        t.ensure_vault_slot(&acct("ghost.test"), &acct(USDC));
        assert_eq!(deposit(&mut t, "ghost.test", 5, ""), 5);
        assert_eq!(balance(&t, "ghost.test"), 0);
        assert!(get_logs().is_empty());
    }

    #[test]
    fn beneficiary_without_enough_storage_refunded() {
        let mut t = world();
        let carol = acct("carol.test");
        register(
            &mut t,
            "carol.test",
            NearToken::from_yoctonear(STORAGE_MIN_DEPOSIT),
        );
        // Leave Carol one byte short of a slot.
        let spare = u64::try_from(t.storage_available(&carol) / byte_cost()).unwrap();
        t.reserve_bytes(&carol, spare - VAULT_SLOT_MAX_BYTES + 1);
        assert!(t.storage_available(&carol) < u128::from(VAULT_SLOT_MAX_BYTES) * byte_cost());
        let used = used_bytes(&t, "carol.test");

        assert_eq!(
            deposit(&mut t, "alice.test", 40, r#"{"for":"carol.test"}"#),
            40
        );
        assert_eq!(balance(&t, "carol.test"), 0);
        assert!(get_logs().is_empty());
        assert_eq!(used_bytes(&t, "carol.test"), used, "no slot was made");
        assert!(t.balances_of(carol).is_empty());
    }

    #[test]
    fn beneficiary_with_exactly_the_slot_budget_is_credited() {
        let mut t = world();
        let carol = acct("carol.test");
        register(
            &mut t,
            "carol.test",
            NearToken::from_yoctonear(STORAGE_MIN_DEPOSIT),
        );
        let spare = u64::try_from(t.storage_available(&carol) / byte_cost()).unwrap();
        t.reserve_bytes(&carol, spare - VAULT_SLOT_MAX_BYTES);
        assert_eq!(
            t.storage_available(&carol),
            u128::from(VAULT_SLOT_MAX_BYTES) * byte_cost()
        );

        assert_eq!(
            deposit(&mut t, "alice.test", 40, r#"{"for":"carol.test"}"#),
            0
        );
        assert_eq!(balance(&t, "carol.test"), 40);
    }

    #[test]
    fn deposit_to_an_existing_slot_needs_no_spare_storage() {
        let mut t = world();
        let carol = acct("carol.test");
        register(
            &mut t,
            "carol.test",
            NearToken::from_yoctonear(STORAGE_MIN_DEPOSIT),
        );
        assert_eq!(deposit(&mut t, "carol.test", 5, ""), 0);
        // Carol spends every byte she has left.
        let spare = u64::try_from(t.storage_available(&carol) / byte_cost()).unwrap();
        t.reserve_bytes(&carol, spare);
        assert_eq!(t.storage_available(&carol), 0);

        assert_eq!(deposit(&mut t, "carol.test", 5, ""), 0);
        assert_eq!(balance(&t, "carol.test"), 10);
    }

    #[test]
    fn a_new_slot_is_charged_to_the_beneficiary_once() {
        let mut t = world();
        let alice_used = used_bytes(&t, "alice.test");
        let bob_used = used_bytes(&t, "bob.test");

        // Alice pays tokens for Bob's deposit; Bob's storage pays for his slot.
        testing_env!(ctx(USDC).build());
        let usage = env::storage_usage();
        let _ = t.ft_on_transfer(
            acct("alice.test"),
            U128(7),
            r#"{"for":"bob.test"}"#.to_string(),
        );
        // The record's 40 bytes of overhead, the key (1-byte prefix, then the two account ids with
        // 4-byte lengths) and the 16-byte value.
        let slot = (40 + 1 + (4 + "bob.test".len()) + (4 + USDC.len()) + 16) as u64;
        assert_eq!(slot, 82);
        assert_eq!(env::storage_usage() - usage, slot);
        assert_eq!(used_bytes(&t, "bob.test"), bob_used + slot);
        assert_eq!(used_bytes(&t, "alice.test"), alice_used);

        // The next deposit finds the slot and charges nothing.
        assert_eq!(deposit(&mut t, "alice.test", 7, r#"{"for":"bob.test"}"#), 0);
        assert_eq!(used_bytes(&t, "bob.test"), bob_used + slot);
    }

    #[test]
    fn a_slot_fits_the_budget_for_the_longest_account_ids() {
        // `ft_on_transfer` checks that the beneficiary can afford `VAULT_SLOT_MAX_BYTES`, and then
        // relies on `settle_storage` not panicking. That holds only if no slot is larger.
        let mut t = world();
        let (long_account, long_token) = ("a".repeat(64), "b".repeat(64));
        t.put_token(acct(&long_token), token_config(true));
        register(&mut t, &long_account, NearToken::from_millinear(50));

        testing_env!(ctx(&long_token).build());
        let usage = env::storage_usage();
        let msg = format!(r#"{{"for":"{long_account}"}}"#);
        let unused = t.ft_on_transfer(acct("alice.test"), U128(1), msg);
        assert!(matches!(unused, PromiseOrValue::Value(U128(0))));
        let slot = env::storage_usage() - usage;
        // 40 bytes of record overhead, a 1-byte prefix, two 64-byte ids with 4-byte lengths, and
        // a 16-byte value.
        assert_eq!(slot, 40 + 1 + 2 * (4 + 64) + 16);
        assert!(slot <= VAULT_SLOT_MAX_BYTES);
    }

    #[test]
    fn disabled_token_refunded() {
        let mut t = world();
        assert_eq!(deposit(&mut t, "alice.test", 10, ""), 0);
        t.put_token(acct(USDC), token_config(false));
        assert_eq!(deposit(&mut t, "alice.test", 10, ""), 10);
        assert_eq!(balance(&t, "alice.test"), 10);
        assert!(get_logs().is_empty());
        // Enabling it again lets deposits through.
        t.put_token(acct(USDC), token_config(true));
        assert_eq!(deposit(&mut t, "alice.test", 10, ""), 0);
        assert_eq!(balance(&t, "alice.test"), 20);
    }

    #[test]
    fn deposit_works_while_paused() {
        let mut t = world();
        t.paused = true;
        assert_eq!(deposit(&mut t, "alice.test", 10, ""), 0);
        assert_eq!(balance(&t, "alice.test"), 10);
    }

    #[test]
    fn zero_amount_deposit_is_ignored() {
        let mut t = world();
        let used = used_bytes(&t, "alice.test");
        assert_eq!(deposit(&mut t, "alice.test", 0, ""), 0);
        assert!(get_logs().is_empty(), "no event for nothing");
        assert_eq!(used_bytes(&t, "alice.test"), used, "no slot for nothing");
        assert!(t.balances_of(acct("alice.test")).is_empty());
    }

    #[test]
    fn malformed_msg_is_refused_without_a_trace() {
        let mut t = world();
        assert_eq!(deposit(&mut t, "alice.test", 100, ""), 0);
        let bob_used = used_bytes(&t, "bob.test");
        for msg in [
            "garbage{",
            "{",
            "null",
            "[]",
            r#"["bob.test"]"#,
            "bob.test",
            " ",
            "{}",
            r#"{"for":""}"#,
            r#"{"for":"NOT VALID ID"}"#,
            r#"{"for":5}"#,
            r#"{"for":null}"#,
            r#"{"for":["bob.test"]}"#,
            r#"{"to":"bob.test"}"#,
            // Bob is registered, so these would be credited if the extra or repeated key were
            // ignored.
            r#"{"for":"bob.test","extra":1}"#,
            r#"{"for":"bob.test","for":"alice.test"}"#,
            r#"{"for":"bob.test"} trailing"#,
        ] {
            assert_eq!(deposit(&mut t, "alice.test", 50, msg), 50, "msg {msg:?}");
            assert!(get_logs().is_empty(), "msg {msg:?} emitted an event");
        }
        assert_eq!(balance(&t, "alice.test"), 100);
        assert_eq!(balance(&t, "bob.test"), 0);
        assert_eq!(used_bytes(&t, "bob.test"), bob_used);
        // A well-formed one still works, whitespace and all.
        assert_eq!(
            deposit(&mut t, "alice.test", 3, r#"{ "for" : "bob.test" }"#),
            0
        );
        assert_eq!(balance(&t, "bob.test"), 3);
    }

    // Withdrawals.

    #[test]
    fn withdraw_debits_first_and_schedules_the_transfer_and_the_callback() {
        let mut t = world();
        deposit(&mut t, "alice.test", 100, "");
        withdraw(&mut t, "alice.test", 100, None);
        // The whole balance is debited before anything has run, and the slot stays.
        assert_eq!(balance(&t, "alice.test"), 0);
        // Only the callback reports the outcome.
        assert!(get_logs().is_empty());

        let calls = scheduled_calls();
        assert_eq!(calls.len(), 2);
        let transfer = &calls[0];
        assert_eq!(transfer.receiver, acct(USDC));
        assert_eq!(transfer.method, "ft_transfer");
        assert_eq!(transfer.args["receiver_id"], "alice.test");
        assert_eq!(transfer.args["amount"], "100");
        assert_eq!(transfer.deposit, 1);
        assert_eq!(transfer.gas, GAS_FT_TRANSFER);
        let callback = &calls[1];
        assert_eq!(callback.receiver, acct("tender.test"));
        assert_eq!(callback.method, "on_withdraw");
        assert_eq!(
            callback.args,
            json!({"account":"alice.test","token":"usdc.test","amount":"100","to":"alice.test"})
        );
        assert_eq!(callback.deposit, 0);
        assert_eq!(callback.gas, GAS_ON_WITHDRAW);
    }

    #[test]
    fn withdraw_to_other_account_uses_to() {
        let mut t = world();
        deposit(&mut t, "alice.test", 100, "");
        withdraw(&mut t, "alice.test", 30, Some("bob.test"));
        let calls = scheduled_calls();
        assert_eq!(calls.len(), 2);
        // The token is asked to pay Bob...
        assert_eq!(calls[0].receiver, acct(USDC));
        assert_eq!(calls[0].method, "ft_transfer");
        assert_eq!(calls[0].args["receiver_id"], "bob.test");
        assert_eq!(calls[0].args["amount"], "30");
        // ...and the callback remembers both parties.
        assert_eq!(
            calls[1].args,
            json!({"account":"alice.test","token":"usdc.test","amount":"30","to":"bob.test"})
        );
        // Alice pays; Bob's vault balance is not involved.
        assert_eq!(balance(&t, "alice.test"), 70);
        assert_eq!(balance(&t, "bob.test"), 0);
    }

    #[test]
    #[should_panic(expected = "E_GAS")]
    fn withdraw_requires_gas() {
        let mut t = world();
        deposit(&mut t, "alice.test", 100, "");
        testing_env!(ctx("alice.test")
            .attached_deposit(ONE_YOCTO)
            .prepaid_gas(Gas::from_tgas(20))
            .build());
        let _ = t.withdraw(acct(USDC), U128(1), None);
    }

    #[test]
    fn the_gas_guard_accepts_exactly_the_minimum() {
        // The boundary is tested on the guard itself: a whole `withdraw` at the minimum would
        // spend the gas on its promises in the mocked VM before it returned.
        require_withdraw_gas(MIN_WITHDRAW_GAS);
        require_withdraw_gas(Gas::from_gas(MIN_WITHDRAW_GAS.as_gas() + 1));
    }

    #[test]
    #[should_panic(expected = "E_GAS: withdraw needs at least 35 Tgas prepaid, got 34")]
    fn the_gas_guard_rejects_one_unit_less() {
        require_withdraw_gas(Gas::from_gas(MIN_WITHDRAW_GAS.as_gas() - 1));
    }

    #[test]
    #[should_panic(expected = "E_FUNDS: amount must be positive")]
    fn withdraw_rejects_zero() {
        let mut t = world();
        deposit(&mut t, "alice.test", 100, "");
        withdraw(&mut t, "alice.test", 0, None);
    }

    #[test]
    #[should_panic(expected = "E_FUNDS: insufficient vault balance")]
    fn withdraw_rejects_more_than_the_balance() {
        let mut t = world();
        deposit(&mut t, "alice.test", 100, "");
        withdraw(&mut t, "alice.test", 101, None);
    }

    #[test]
    fn withdraw_uses_predecessor_not_signer() {
        // alice signs a transaction whose call reaches Tender from evil.test, a contract. The
        // caller is evil.test, so the withdrawal spends evil.test's vault, which is empty, and
        // never the signer's.
        let mut t = world();
        deposit(&mut t, "alice.test", 100, "");
        testing_env!(ctx("evil.test")
            .signer_account_id(acct("alice.test"))
            .attached_deposit(ONE_YOCTO)
            .build());
        let rejected = panic_message(|| {
            let _ = t.withdraw(acct(USDC), U128(100), None);
        });
        assert!(
            rejected
                .as_ref()
                .is_some_and(|m| m.starts_with("E_FUNDS: ")),
            "{rejected:?}"
        );
        assert_eq!(balance(&t, "alice.test"), 100);
        assert!(scheduled_calls().is_empty(), "no transfer was scheduled");
    }

    #[test]
    #[should_panic(expected = "E_FUNDS: insufficient vault balance")]
    fn withdraw_rejects_a_token_with_no_slot() {
        let mut t = world();
        withdraw(&mut t, "alice.test", 1, None);
    }

    #[test]
    fn successful_withdraw_callback_emits_withdraw() {
        let mut t = world();
        deposit(&mut t, "alice.test", 100, "");
        withdraw(&mut t, "alice.test", 30, Some("bob.test"));
        assert!(call_back(&mut t, "alice.test", 30, "bob.test", true));
        // The tokens left, so nothing comes back.
        assert_eq!(balance(&t, "alice.test"), 70);
        assert_eq!(
            get_logs(),
            [event(
                "withdraw",
                r#"{"account":"alice.test","token":"usdc.test","amount":"30","to":"bob.test"}"#
            )]
        );
    }

    #[test]
    fn failed_withdraw_callback_emits_withdraw_failed() {
        let mut t = world();
        deposit(&mut t, "alice.test", 100, "");
        withdraw(&mut t, "alice.test", 30, Some("bob.test"));
        assert!(!call_back(&mut t, "alice.test", 30, "bob.test", false));
        // The 30 go back to Alice, not to the account she meant to pay.
        assert_eq!(balance(&t, "alice.test"), 100);
        assert_eq!(balance(&t, "bob.test"), 0);
        assert_eq!(
            get_logs(),
            [event(
                "withdraw_failed",
                r#"{"account":"alice.test","token":"usdc.test","amount":"30","to":"bob.test"}"#
            )]
        );
    }

    #[test]
    fn money_is_never_trapped_by_a_pause_or_a_disabled_token() {
        let mut t = world();
        deposit(&mut t, "alice.test", 100, "");
        t.paused = true;
        t.put_token(acct(USDC), token_config(false));
        // Alice can still withdraw...
        withdraw(&mut t, "alice.test", 60, None);
        assert_eq!(balance(&t, "alice.test"), 40);
        // ...and a failed transfer is still restored, whatever the owner did in between.
        assert!(!call_back(&mut t, "alice.test", 60, "alice.test", false));
        assert_eq!(balance(&t, "alice.test"), 100);
    }

    // Balances.

    #[test]
    fn balance_of_is_zero_without_a_slot() {
        let t = world();
        assert_eq!(t.balance_of(acct("alice.test"), acct(USDC)), U128(0));
        assert_eq!(
            t.balance_of(acct("nobody.test"), acct("evil.test")),
            U128(0)
        );
    }

    #[test]
    fn balances_of_lists_slots() {
        let mut t = world();
        let alice = acct("alice.test");
        assert!(t.balances_of(alice.clone()).is_empty());

        t.put_token(acct("dai.test"), token_config(true));
        t.put_token(acct("old.test"), token_config(true));
        t.put_token(acct("unused.test"), token_config(true));
        assert_eq!(deposit(&mut t, "alice.test", 100, ""), 0);
        assert_eq!(deposit_from(&mut t, "dai.test", "alice.test", 5, ""), 0);
        assert_eq!(deposit_from(&mut t, "old.test", "alice.test", 1, ""), 0);
        // A disabled token still shows what Alice has in it, so she can withdraw it.
        t.put_token(acct("old.test"), token_config(false));

        let balances = |t: &Tender| t.balances_of(alice.clone());
        assert_eq!(
            balances(&t),
            vec![
                TokenBalance {
                    token: acct(USDC),
                    amount: U128(100)
                },
                TokenBalance {
                    token: acct("dai.test"),
                    amount: U128(5)
                },
                TokenBalance {
                    token: acct("old.test"),
                    amount: U128(1)
                },
            ],
            "one entry per allowlisted token with a slot; unused.test has none"
        );
        assert_eq!(
            serde_json::to_string(&balances(&t)).unwrap(),
            r#"[{"token":"usdc.test","amount":"100"},{"token":"dai.test","amount":"5"},{"token":"old.test","amount":"1"}]"#
        );

        // Emptying a slot does not remove it.
        testing_env!(ctx("alice.test").attached_deposit(ONE_YOCTO).build());
        let _ = t.withdraw(acct("dai.test"), U128(5), None);
        let after = balances(&t);
        assert_eq!(after.len(), 3);
        assert_eq!(after[1].amount, U128(0));
        // Bob has no slot anywhere.
        assert!(t.balances_of(acct("bob.test")).is_empty());
    }

    // The crate-level helpers the later tasks build on.

    #[test]
    #[should_panic(expected = "E_FUNDS: no vault slot")]
    fn credit_requires_a_slot() {
        let mut t = world();
        t.credit(&acct("alice.test"), &acct(USDC), 1);
    }

    #[test]
    #[should_panic(expected = "E_FUNDS")]
    fn credit_overflow_panics() {
        let mut t = world();
        let (alice, usdc) = (acct("alice.test"), acct(USDC));
        t.ensure_vault_slot(&alice, &usdc);
        t.credit(&alice, &usdc, u128::MAX);
        t.credit(&alice, &usdc, 1);
    }

    #[test]
    #[should_panic(expected = "E_FUNDS: insufficient vault balance")]
    fn debit_beyond_the_balance_panics() {
        let mut t = world();
        let (alice, usdc) = (acct("alice.test"), acct(USDC));
        t.ensure_vault_slot(&alice, &usdc);
        t.credit(&alice, &usdc, 5);
        t.debit(&alice, &usdc, 6);
    }

    #[test]
    #[should_panic(expected = "E_FUNDS: insufficient vault balance")]
    fn debit_without_a_slot_panics() {
        let mut t = world();
        t.debit(&acct("alice.test"), &acct(USDC), 1);
    }

    #[test]
    fn ensure_vault_slot_adds_an_empty_slot_and_keeps_a_balance() {
        let mut t = world();
        let (alice, usdc) = (acct("alice.test"), acct(USDC));
        t.ensure_vault_slot(&alice, &usdc);
        assert_eq!(
            t.balances_of(alice.clone()),
            vec![TokenBalance {
                token: usdc.clone(),
                amount: U128(0)
            }]
        );
        t.credit(&alice, &usdc, 5);
        t.ensure_vault_slot(&alice, &usdc);
        t.debit(&alice, &usdc, 2);
        assert_eq!(balance(&t, "alice.test"), 3);
    }
}
