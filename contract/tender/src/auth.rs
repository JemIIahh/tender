//! Spending authorisation and delegate keys: the gate in front of every method that spends from an
//! account's vault.
//!
//! A spending method (`post_task` and `top_up_task`, and no other) calls `authorize_spend` right
//! before it debits. There are two ways through, and every other call is refused `E_AUTH`:
//!
//! - **1 yoctoNEAR attached.** A function-call access key cannot attach a deposit, so the call was
//!   signed with a full-access key, or made by a contract spending its own vault, and it spends
//!   the predecessor's vault without limit.
//! - **A delegate key within its caps** (spec 6.8). With no deposit attached, the call is let
//!   through when the key that signed it is one its account registered with `add_delegate`, the
//!   call came straight from that account (signer, predecessor and the account debited are one),
//!   the spend is in the key's token, it is at most the key's `per_task_cap`, and it keeps what the
//!   key has spent in all within its `total_cap`. The spend is then added to `spent`. Despite its
//!   name, `per_task_cap` caps each call: a post and then top-ups of the same task by the same
//!   key are counted one by one, so only `total_cap` bounds what one task can get from the key.
//!
//! So an agent can hold a function-call key that posts and tops up tasks on its own, while a leak
//! of that key costs at most `total_cap` of one token. `withdraw`, `storage_withdraw`, the owner's
//! setters, `add_delegate` and `remove_delegate` never come here: they require 1 yoctoNEAR
//! (`assert_one_yocto`), which no function-call key can attach, so a delegate key can neither move
//! money out nor raise its own caps. And `pick` refuses a call signed by a delegate key of the
//! verifier or poster (`signed_by_delegate`), whatever methods the access key allows, so the key
//! cannot award an escrow either; the account picks with any other key.
//!
//! `spent` is written before the debit and the rest of the spending method. Every panic after it
//! (`E_FUNDS`, `E_STORAGE`) fails the receipt, and NEAR rolls back all of a failed receipt's state
//! changes, `spent` with them; the sandbox suite shows it on a real node. Only a spend that happens
//! counts against the caps.

use near_sdk::json_types::U128;
use near_sdk::{assert_one_yocto, env, near, AccountId, PublicKey};

use crate::events::{emit, DelegateAdded, DelegateRemoved};
use crate::types::{err, DelegateCaps, DelegateView};
use crate::{Tender, TenderExt};

fn refused() -> ! {
    env::panic_str(&format!(
        "{}: attach exactly 1 yoctoNEAR or use a delegate key within caps",
        err::E_AUTH
    ))
}

/// The key, in `delegates`, of the record that would make this call one by a delegate key of
/// `account`: `(account, the public key that signed the transaction)`. `None` unless the call
/// came straight from `account`, that is unless the signer and the predecessor are both
/// `account`; through another contract the signing key is not `account`'s to vouch for.
///
/// `authorize_spend` and `pick` both look a delegate up this way, so a key counts as a delegate
/// for refusing a pick exactly when it would count as one for spending.
fn direct_signing_key(account: &AccountId) -> Option<(AccountId, PublicKey)> {
    let signer = env::signer_account_id();
    (signer == *account && signer == env::predecessor_account_id())
        .then(|| (signer, env::signer_account_pk()))
}

impl DelegateCaps {
    fn view(&self) -> DelegateView {
        DelegateView {
            token: self.token.clone(),
            per_task_cap: U128(self.per_task_cap),
            total_cap: U128(self.total_cap),
            spent: U128(self.spent),
        }
    }
}

#[near]
impl Tender {
    /// Registers `public_key` as a delegate key of the caller's account: a call it signs with no
    /// deposit attached may spend the caller's vault in `token`, at most `per_task_cap` per
    /// `post_task` or `top_up_task` and at most `total_cap` in all. Requires exactly 1 yoctoNEAR,
    /// so only a full-access key can call it. The key itself is added to the account the usual
    /// way, as a function-call access key for this contract.
    ///
    /// Adding a key that is a delegate already replaces its caps. What it has spent stays counted
    /// if `token` is the one it had, so re-running a setup script grants nothing new; with another
    /// token it starts from 0, since the old spending was in another unit. A `total_cap` below what
    /// the key has spent leaves it nothing to spend. To give a key a fresh budget, remove it and
    /// add it again.
    ///
    /// The caps are not checked against anything: they only narrow what the account's full-access
    /// key can do anyway, and the spending methods still check the token and the reward. The
    /// caller's storage balance pays for the record (`E_STORAGE` if it cannot). Works while posting
    /// is paused. Emits `delegate_added`.
    #[payable]
    #[deny_unknown_arguments]
    pub fn add_delegate(
        &mut self,
        public_key: PublicKey,
        token: AccountId,
        per_task_cap: U128,
        total_cap: U128,
    ) {
        assert_one_yocto();
        let account = env::predecessor_account_id();
        let key = (account.clone(), public_key.clone());
        let spent = match self.delegates.get(&key) {
            Some(caps) if caps.token == token => caps.spent,
            _ => 0,
        };
        let before = self.storage_mark();
        self.delegates.insert(
            key,
            DelegateCaps {
                token: token.clone(),
                per_task_cap: per_task_cap.0,
                total_cap: total_cap.0,
                spent,
            },
        );
        self.settle_storage(&account, before);
        emit(
            "delegate_added",
            &DelegateAdded {
                account,
                public_key,
                token,
                per_task_cap,
                total_cap,
            },
        );
    }

    /// Takes back the caps of the caller's delegate key `public_key` (`E_NOT_FOUND` if it has
    /// none), so the key can spend nothing more, and gives the record's storage back to the
    /// caller. Requires exactly 1 yoctoNEAR. It does not delete the access key from the account;
    /// a key that can still call `post_task` is refused `E_AUTH`. Works while posting is paused.
    /// Emits `delegate_removed`.
    #[payable]
    #[deny_unknown_arguments]
    pub fn remove_delegate(&mut self, public_key: PublicKey) {
        assert_one_yocto();
        let account = env::predecessor_account_id();
        let before = self.storage_mark();
        if self
            .delegates
            .remove(&(account.clone(), public_key.clone()))
            .is_none()
        {
            env::panic_str(&format!(
                "{}: {account} has no delegate key {}",
                err::E_NOT_FOUND,
                String::from(&public_key)
            ));
        }
        self.settle_storage(&account, before);
        emit(
            "delegate_removed",
            &DelegateRemoved {
                account,
                public_key,
            },
        );
    }

    /// The caps of `account_id`'s delegate key `public_key`, with what it has spent, or `None` if
    /// it is not one.
    pub fn get_delegate(
        &self,
        account_id: AccountId,
        public_key: PublicKey,
    ) -> Option<DelegateView> {
        self.delegates
            .get(&(account_id, public_key))
            .map(DelegateCaps::view)
    }
}

impl Tender {
    /// Panics `E_AUTH` unless this call may spend `amount` of `token` from `account`'s vault, and
    /// counts the spend against the signing key's caps when it is a delegate's (see the module
    /// doc). The caller passes the account it is about to debit, which is always the predecessor.
    ///
    /// The delegate path takes no deposit at all: a function-call key can attach none, and NEAR a
    /// client attached by mistake would stay in the contract. With no delegate record for the
    /// signing key, or through another contract, the message is the generic one; with a record,
    /// it says which cap or token the spend breaks.
    pub(crate) fn authorize_spend(&mut self, account: &AccountId, token: &AccountId, amount: u128) {
        let attached = env::attached_deposit().as_yoctonear();
        if attached == 1 {
            return;
        }
        if attached != 0 {
            refused();
        }
        let Some(key) = direct_signing_key(account) else {
            refused()
        };
        let Some(caps) = self.delegates.get_mut(&key) else {
            refused()
        };
        if caps.token != *token {
            env::panic_str(&format!(
                "{}: this delegate key may spend only {}, not {token}",
                err::E_AUTH,
                caps.token
            ));
        }
        if amount > caps.per_task_cap {
            env::panic_str(&format!(
                "{}: {amount} is over this delegate key's per-call cap (per_task_cap) of {}",
                err::E_AUTH,
                caps.per_task_cap
            ));
        }
        match caps.spent.checked_add(amount) {
            Some(spent) if spent <= caps.total_cap => caps.spent = spent,
            _ => env::panic_str(&format!(
                "{}: {amount} more would take this delegate key past its total cap of {} (spent {})",
                err::E_AUTH,
                caps.total_cap,
                caps.spent
            )),
        }
    }

    /// Whether this call was signed by one of `account`'s delegate keys and came straight from
    /// `account`: the lookup `authorize_spend` makes. `pick` refuses such a call, because a key
    /// that may spend within caps must not also decide where an escrow goes.
    pub(crate) fn signed_by_delegate(&self, account: &AccountId) -> bool {
        direct_signing_key(account).is_some_and(|key| self.delegates.contains_key(&key))
    }
}

#[cfg(test)]
mod tests {
    use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
    use near_sdk::json_types::{U128, U64};
    use near_sdk::serde_json::{self, json};
    use near_sdk::test_utils::{get_logs, VMContextBuilder};
    use near_sdk::{testing_env, AccountId, CurveType, NearToken, PublicKey};

    use crate::test_utils::{ctx, fresh, panic_message};
    use crate::types::{DelegateView, PostTaskArgs, TokenConfig};
    use crate::Tender;

    const USDC: &str = "usdc.test";
    /// A second allowlisted token, for the delegate key that may not spend it.
    const WNEAR: &str = "wnear.test";
    const ALICE: &str = "alice.test";
    const ROUTER: &str = "router.test";
    const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
    const NO_DEPOSIT: NearToken = NearToken::from_yoctonear(0);
    /// The caps of the plan's sandbox test: 5_000 per call and 10_000 in all.
    const PER_TASK: u128 = 5_000;
    const TOTAL: u128 = 10_000;
    /// What alice holds of each token at the start.
    const FUNDS: u128 = 1_000_000;
    const AUTH_MESSAGE: &str =
        "E_AUTH: attach exactly 1 yoctoNEAR or use a delegate key within caps";
    const ONE_YOCTO_MESSAGE: &str = "Requires attached deposit of exactly 1 yoctoNEAR";

    fn acct(id: &str) -> AccountId {
        id.parse().unwrap()
    }

    /// The key alice registers as a delegate.
    fn key() -> PublicKey {
        PublicKey::from_parts(CurveType::ED25519, vec![7; 32]).unwrap()
    }

    /// Another key of alice's, never registered.
    fn other_key() -> PublicKey {
        PublicKey::from_parts(CurveType::ED25519, vec![9; 32]).unwrap()
    }

    /// A contract with USDC and WNEAR allowlisted for rewards of 1 to 50_000_000, and alice with
    /// 1 NEAR of storage and `FUNDS` of each token in her vault.
    fn world() -> Tender {
        let mut t = fresh();
        for token in [USDC, WNEAR] {
            t.put_token(
                acct(token),
                TokenConfig {
                    min_reward: 1,
                    max_reward: 50_000_000,
                    enabled: true,
                },
            );
        }
        register(&mut t, ALICE);
        for token in [USDC, WNEAR] {
            testing_env!(ctx(token).build());
            let _ = t.ft_on_transfer(acct(ALICE), U128(FUNDS), String::new());
        }
        t
    }

    fn register(t: &mut Tender, who: &str) {
        testing_env!(ctx(who).attached_deposit(NearToken::from_near(1)).build());
        t.storage_deposit(None, None);
    }

    /// `who` signing with `pk` and calling the contract directly, with `deposit` attached.
    fn signed(who: &str, pk: PublicKey, deposit: NearToken) -> VMContextBuilder {
        let mut c = ctx(who);
        c.signer_account_pk(pk).attached_deposit(deposit);
        c
    }

    /// alice signing with `pk`, through the contract `ROUTER`: the predecessor is the router.
    fn via_router(pk: PublicKey) -> VMContextBuilder {
        let mut c = signed(ALICE, pk, NO_DEPOSIT);
        c.predecessor_account_id(acct(ROUTER));
        c
    }

    /// `who` registers `pk` as a delegate key for `token` with the caps given, with 1 yocto.
    fn add(t: &mut Tender, who: &str, pk: PublicKey, token: &str, per_task: u128, total: u128) {
        testing_env!(ctx(who).attached_deposit(ONE_YOCTO).build());
        t.add_delegate(pk, acct(token), U128(per_task), U128(total));
    }

    /// alice's delegate key with the plan's caps for USDC.
    fn delegated() -> Tender {
        let mut t = world();
        add(&mut t, ALICE, key(), USDC, PER_TASK, TOTAL);
        t
    }

    fn task(token: &str, reward: u128) -> PostTaskArgs {
        PostTaskArgs {
            token: acct(token),
            reward: U128(reward),
            brief_uri: "ipfs://brief".to_string(),
            brief_hash: "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
                .to_string(),
            criteria_hash: "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae"
                .to_string(),
            heldout_commitment: None,
            verifier: None,
            commit_secs: 60,
            reveal_secs: 60,
            pick_secs: 60,
            fallback_secs: 60,
            max_entries: 0,
            max_winners: 1,
            invited: vec![],
            parent: None,
        }
    }

    /// Posts `task` in context `c`. `Err` holds the message the contract panicked with.
    fn try_post(t: &mut Tender, c: VMContextBuilder, task: PostTaskArgs) -> Result<u64, String> {
        testing_env!(c.build());
        let mut id = None;
        match panic_message(|| id = Some(t.post_task(task).0)) {
            Some(message) => Err(message),
            None => Ok(id.expect("post_task returned")),
        }
    }

    /// Tops task `id` up by `amount` in context `c`. `Err` holds the panic message.
    fn try_top_up(
        t: &mut Tender,
        c: VMContextBuilder,
        id: u64,
        amount: u128,
    ) -> Result<(), String> {
        testing_env!(c.build());
        match panic_message(|| t.top_up_task(U64(id), U128(amount))) {
            Some(message) => Err(message),
            None => Ok(()),
        }
    }

    /// Calls `authorize_spend` for `account` directly in context `c`.
    fn try_authorize(
        t: &mut Tender,
        c: VMContextBuilder,
        account: &str,
        token: &str,
        amount: u128,
    ) -> Result<(), String> {
        testing_env!(c.build());
        match panic_message(|| t.authorize_spend(&acct(account), &acct(token), amount)) {
            Some(message) => Err(message),
            None => Ok(()),
        }
    }

    /// Asserts that `result` is an `E_AUTH` rejection that logged nothing, and returns its message.
    fn rejected<T: std::fmt::Debug>(what: &str, result: Result<T, String>) -> String {
        let message = result.expect_err(&format!("{what}: expected E_AUTH, but it went through"));
        assert!(message.starts_with("E_AUTH: "), "{what}: {message}");
        assert!(get_logs().is_empty(), "{what}: a rejection logs nothing");
        message
    }

    fn caps(t: &Tender, who: &str, pk: PublicKey) -> Option<DelegateView> {
        t.get_delegate(acct(who), pk)
    }

    fn spent(t: &Tender) -> u128 {
        caps(t, ALICE, key())
            .expect("alice's key is a delegate")
            .spent
            .0
    }

    fn balance(t: &Tender, token: &str) -> u128 {
        t.balance_of(acct(ALICE), acct(token)).0
    }

    fn used(t: &Tender, who: &str) -> u64 {
        t.storage_balance_of(acct(who))
            .expect("registered")
            .used_bytes
            .0
    }

    fn delegate_key() -> VMContextBuilder {
        signed(ALICE, key(), NO_DEPOSIT)
    }

    #[test]
    fn delegate_within_caps_posts() {
        let mut t = delegated();
        assert_eq!(try_post(&mut t, delegate_key(), task(USDC, 4_000)), Ok(1));
        assert_eq!(spent(&t), 4_000);
        assert_eq!(try_post(&mut t, delegate_key(), task(USDC, 4_000)), Ok(2));
        assert_eq!(spent(&t), 8_000);
        assert_eq!(balance(&t, USDC), FUNDS - 8_000);
        assert_eq!(t.get_task(U64(2)).unwrap().poster, acct(ALICE));
    }

    #[test]
    fn delegate_over_per_task_cap_rejected() {
        let mut t = delegated();
        let message = rejected(
            "one over the per-call cap",
            try_post(&mut t, delegate_key(), task(USDC, PER_TASK + 1)),
        );
        assert_eq!(
            message,
            "E_AUTH: 5001 is over this delegate key's per-call cap (per_task_cap) of 5000"
        );
        assert_eq!(spent(&t), 0);
        assert_eq!(t.task_count(), U64(0));
        assert_eq!(balance(&t, USDC), FUNDS);
        // Exactly the cap is within it.
        assert_eq!(
            try_post(&mut t, delegate_key(), task(USDC, PER_TASK)),
            Ok(1)
        );
        assert_eq!(spent(&t), PER_TASK);
    }

    #[test]
    fn delegate_over_total_cap_rejected() {
        let mut t = delegated();
        assert_eq!(try_post(&mut t, delegate_key(), task(USDC, 4_000)), Ok(1));
        assert_eq!(try_post(&mut t, delegate_key(), task(USDC, 4_000)), Ok(2));
        let message = rejected(
            "a third 4_000",
            try_post(&mut t, delegate_key(), task(USDC, 4_000)),
        );
        assert_eq!(
            message,
            "E_AUTH: 4000 more would take this delegate key past its total cap of 10000 (spent 8000)"
        );
        assert_eq!(spent(&t), 8_000);
        assert_eq!(t.task_count(), U64(2));
        // What is left of the total cap, exactly, still goes through, and then nothing does.
        assert_eq!(try_post(&mut t, delegate_key(), task(USDC, 2_000)), Ok(3));
        assert_eq!(spent(&t), TOTAL);
        rejected(
            "1 past the total",
            try_post(&mut t, delegate_key(), task(USDC, 1)),
        );
        assert_eq!(spent(&t), TOTAL);
        assert_eq!(balance(&t, USDC), FUNDS - TOTAL);
    }

    #[test]
    fn delegate_wrong_token_rejected() {
        let mut t = delegated();
        let message = rejected(
            "a WNEAR task",
            try_post(&mut t, delegate_key(), task(WNEAR, 1_000)),
        );
        assert_eq!(
            message,
            "E_AUTH: this delegate key may spend only usdc.test, not wnear.test"
        );
        assert_eq!(spent(&t), 0);
        assert_eq!(balance(&t, WNEAR), FUNDS);
        assert_eq!(t.task_count(), U64(0));
    }

    #[test]
    fn delegate_via_other_contract_rejected() {
        let mut t = delegated();
        // Through a contract, the poster would be the router, and the signer is not it.
        let message = rejected(
            "post_task through a router",
            try_post(&mut t, via_router(key()), task(USDC, 1_000)),
        );
        assert_eq!(message, AUTH_MESSAGE);
        // Even a spend from alice herself is refused when another contract called in between.
        let message = rejected(
            "alice's spend through a router",
            try_authorize(&mut t, via_router(key()), ALICE, USDC, 1_000),
        );
        assert_eq!(message, AUTH_MESSAGE);
        assert_eq!(spent(&t), 0);
        assert_eq!(t.task_count(), U64(0));
    }

    #[test]
    fn removed_delegate_rejected() {
        let mut t = delegated();
        assert_eq!(try_post(&mut t, delegate_key(), task(USDC, 1_000)), Ok(1));
        testing_env!(ctx(ALICE).attached_deposit(ONE_YOCTO).build());
        t.remove_delegate(key());
        assert_eq!(caps(&t, ALICE, key()), None);
        let message = rejected(
            "a removed key",
            try_post(&mut t, delegate_key(), task(USDC, 1_000)),
        );
        assert_eq!(message, AUTH_MESSAGE);
        assert_eq!(t.task_count(), U64(1));
        assert_eq!(balance(&t, USDC), FUNDS - 1_000);
    }

    /// Ported from the 10-26 spike: a registered key counts only when it signs a call that
    /// reaches the contract directly.
    #[test]
    fn delegate_key_matches_signer_pk_only_on_direct_calls() {
        let mut t = delegated();
        assert_eq!(
            try_authorize(&mut t, delegate_key(), ALICE, USDC, 1),
            Ok(())
        );
        let message = rejected(
            "a key alice never registered",
            try_authorize(
                &mut t,
                signed(ALICE, other_key(), NO_DEPOSIT),
                ALICE,
                USDC,
                1,
            ),
        );
        assert_eq!(message, AUTH_MESSAGE);
        rejected(
            "the same key through a router",
            try_authorize(&mut t, via_router(key()), ALICE, USDC, 1),
        );
        assert_eq!(spent(&t), 1);
    }

    #[test]
    fn delegate_spends_only_its_own_account() {
        let mut t = world();
        register(&mut t, "bob.test");
        // bob registers the key. alice has the same public key on her account and signs with it.
        add(&mut t, "bob.test", key(), USDC, PER_TASK, TOTAL);
        let message = rejected(
            "alice spending from bob's vault",
            try_authorize(&mut t, delegate_key(), "bob.test", USDC, 1),
        );
        assert_eq!(message, AUTH_MESSAGE);
        // Nor does bob's entry let alice spend her own vault with that key.
        rejected(
            "alice spending her own vault with bob's delegate key",
            try_post(&mut t, delegate_key(), task(USDC, 1)),
        );
        assert_eq!(caps(&t, "bob.test", key()).unwrap().spent, U128(0));
        assert_eq!(t.task_count(), U64(0));
    }

    #[test]
    fn delegate_path_takes_no_deposit_but_one_yocto() {
        let mut t = delegated();
        for (what, deposit) in [
            ("2 yoctoNEAR", NearToken::from_yoctonear(2)),
            ("1 NEAR", NearToken::from_near(1)),
        ] {
            let message = rejected(
                what,
                try_post(&mut t, signed(ALICE, key(), deposit), task(USDC, 1)),
            );
            assert_eq!(message, AUTH_MESSAGE, "{what}");
        }
        assert_eq!(spent(&t), 0);
        assert_eq!(t.task_count(), U64(0));
    }

    #[test]
    fn one_yocto_spend_is_not_capped_or_counted() {
        let mut t = delegated();
        // A full-access key attaches 1 yocto. Its spend is not a delegate's, whatever key signs.
        let full = signed(ALICE, key(), ONE_YOCTO);
        assert_eq!(try_post(&mut t, full, task(USDC, TOTAL + 1)), Ok(1));
        assert_eq!(spent(&t), 0);
        assert_eq!(balance(&t, USDC), FUNDS - TOTAL - 1);
    }

    #[test]
    fn delegate_spent_overflow_rejected() {
        let mut t = world();
        add(&mut t, ALICE, key(), USDC, u128::MAX, u128::MAX);
        assert_eq!(
            try_authorize(&mut t, delegate_key(), ALICE, USDC, u128::MAX - 1),
            Ok(())
        );
        assert_eq!(spent(&t), u128::MAX - 1);
        rejected(
            "a spend that overflows spent",
            try_authorize(&mut t, delegate_key(), ALICE, USDC, 2),
        );
        assert_eq!(spent(&t), u128::MAX - 1);
        assert_eq!(
            try_authorize(&mut t, delegate_key(), ALICE, USDC, 1),
            Ok(())
        );
        assert_eq!(spent(&t), u128::MAX);
    }

    #[test]
    fn delegate_top_up_counts_against_the_same_caps() {
        let mut t = delegated();
        let id = try_post(&mut t, delegate_key(), task(USDC, 4_000)).unwrap();
        assert_eq!(try_top_up(&mut t, delegate_key(), id, 4_000), Ok(()));
        assert_eq!(spent(&t), 8_000);
        assert_eq!(t.get_task(U64(id)).unwrap().reward, U128(8_000));
        rejected(
            "a top-up over the per-call cap",
            try_top_up(&mut t, delegate_key(), id, PER_TASK + 1),
        );
        rejected(
            "a top-up past the total cap",
            try_top_up(&mut t, delegate_key(), id, 2_001),
        );
        assert_eq!(spent(&t), 8_000);
        assert_eq!(balance(&t, USDC), FUNDS - 8_000);
    }

    #[test]
    fn add_and_remove_delegate_require_one_yocto() {
        let mut t = world();
        for deposit in [NO_DEPOSIT, NearToken::from_yoctonear(2)] {
            testing_env!(signed(ALICE, key(), deposit).build());
            let message =
                panic_message(|| t.add_delegate(key(), acct(USDC), U128(PER_TASK), U128(TOTAL)));
            assert_eq!(message.as_deref(), Some(ONE_YOCTO_MESSAGE));
        }
        assert_eq!(caps(&t, ALICE, key()), None);
        add(&mut t, ALICE, key(), USDC, PER_TASK, TOTAL);
        for deposit in [NO_DEPOSIT, NearToken::from_yoctonear(2)] {
            testing_env!(signed(ALICE, key(), deposit).build());
            let message = panic_message(|| t.remove_delegate(key()));
            assert_eq!(message.as_deref(), Some(ONE_YOCTO_MESSAGE));
        }
        assert!(caps(&t, ALICE, key()).is_some());
    }

    #[test]
    fn add_delegate_charges_storage_and_remove_refunds_it() {
        let mut t = world();
        let before = used(&t, ALICE);
        add(&mut t, ALICE, key(), USDC, PER_TASK, TOTAL);
        let with = used(&t, ALICE);
        assert!(with > before, "add_delegate charged nothing");
        // A second key costs as much again; replacing the first one's caps costs nothing.
        add(&mut t, ALICE, other_key(), USDC, PER_TASK, TOTAL);
        assert_eq!(used(&t, ALICE) - with, with - before);
        add(&mut t, ALICE, key(), USDC, 1, 2);
        assert_eq!(used(&t, ALICE) - with, with - before);
        for pk in [key(), other_key()] {
            testing_env!(ctx(ALICE).attached_deposit(ONE_YOCTO).build());
            t.remove_delegate(pk);
        }
        assert_eq!(used(&t, ALICE), before);
        // An account with no storage balance cannot add one.
        testing_env!(ctx("nobody.test").attached_deposit(ONE_YOCTO).build());
        let message =
            panic_message(|| t.add_delegate(key(), acct(USDC), U128(PER_TASK), U128(TOTAL)));
        assert_eq!(message.as_deref(), Some("E_STORAGE: not registered"));
    }

    #[test]
    fn re_adding_replaces_caps_and_keeps_spent_for_the_same_token() {
        let mut t = delegated();
        assert_eq!(try_post(&mut t, delegate_key(), task(USDC, 4_000)), Ok(1));
        add(&mut t, ALICE, key(), USDC, 3_000, 20_000);
        assert_eq!(
            caps(&t, ALICE, key()),
            Some(DelegateView {
                token: acct(USDC),
                per_task_cap: U128(3_000),
                total_cap: U128(20_000),
                spent: U128(4_000),
            })
        );
        rejected(
            "over the new per-call cap",
            try_post(&mut t, delegate_key(), task(USDC, 3_001)),
        );
        // Lowering the total cap below what is spent leaves nothing to spend.
        add(&mut t, ALICE, key(), USDC, PER_TASK, 3_000);
        assert_eq!(spent(&t), 4_000);
        rejected(
            "total below spent",
            try_post(&mut t, delegate_key(), task(USDC, 1)),
        );
        // Another token starts from nothing: the old spending was in another unit.
        add(&mut t, ALICE, key(), WNEAR, PER_TASK, TOTAL);
        assert_eq!(spent(&t), 0);
        assert_eq!(
            try_post(&mut t, delegate_key(), task(WNEAR, PER_TASK)),
            Ok(2)
        );
        rejected(
            "USDC after the switch",
            try_post(&mut t, delegate_key(), task(USDC, 1)),
        );
    }

    #[test]
    fn delegate_events_and_view_are_in_the_wire_form() {
        let mut t = world();
        add(&mut t, ALICE, key(), USDC, PER_TASK, TOTAL);
        let pk = String::from(&key());
        assert_eq!(
            get_logs(),
            vec![format!(
                r#"EVENT_JSON:{{"standard":"tender","version":"1.0.0","event":"delegate_added","data":[{{"account":"alice.test","public_key":"{pk}","token":"usdc.test","per_task_cap":"5000","total_cap":"10000"}}]}}"#
            )]
        );
        assert_eq!(try_post(&mut t, delegate_key(), task(USDC, 4_000)), Ok(1));
        assert_eq!(
            serde_json::to_value(caps(&t, ALICE, key())).unwrap(),
            json!({
                "token": "usdc.test",
                "per_task_cap": "5000",
                "total_cap": "10000",
                "spent": "4000",
            })
        );
        assert_eq!(caps(&t, ALICE, other_key()), None);
        assert_eq!(caps(&t, "bob.test", key()), None);
        testing_env!(ctx(ALICE).attached_deposit(ONE_YOCTO).build());
        t.remove_delegate(key());
        assert_eq!(
            get_logs(),
            vec![format!(
                r#"EVENT_JSON:{{"standard":"tender","version":"1.0.0","event":"delegate_removed","data":[{{"account":"alice.test","public_key":"{pk}"}}]}}"#
            )]
        );
    }

    #[test]
    fn removing_an_unknown_delegate_is_not_found() {
        let mut t = delegated();
        testing_env!(ctx(ALICE).attached_deposit(ONE_YOCTO).build());
        let message = panic_message(|| t.remove_delegate(other_key()));
        assert_eq!(
            message,
            Some(format!(
                "E_NOT_FOUND: alice.test has no delegate key {}",
                String::from(&other_key())
            ))
        );
        assert!(get_logs().is_empty());
        assert!(caps(&t, ALICE, key()).is_some());
    }

    #[test]
    fn delegates_can_be_managed_while_paused() {
        let mut t = delegated();
        t.paused = true;
        add(&mut t, ALICE, other_key(), USDC, PER_TASK, TOTAL);
        assert!(caps(&t, ALICE, other_key()).is_some());
        testing_env!(ctx(ALICE).attached_deposit(ONE_YOCTO).build());
        t.remove_delegate(key());
        assert_eq!(caps(&t, ALICE, key()), None);
        // A pause still stops a delegate key from posting.
        let message = try_post(
            &mut t,
            signed(ALICE, other_key(), NO_DEPOSIT),
            task(USDC, 1),
        );
        assert!(message.unwrap_err().starts_with("E_PAUSED: "));
    }
}
