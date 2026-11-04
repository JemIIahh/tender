//! Owner configuration: the token allowlist, the fee and the treasury, the shortest window, the
//! agent registration bond and its cooldown, the pause switch and two-step ownership. Also the
//! `get_config` view and the `migrate` template for upgrades.
//!
//! These methods are the contract's trust surface, so there are few of them and they all work the
//! same way. Each needs exactly 1 yoctoNEAR (`assert_one_yocto`), which a function-call key cannot
//! attach, and the owner as the caller (`accept_owner`: the pending owner). The checks run in this
//! order, so a rejection names the first rule that was broken: the deposit; the caller
//! (`E_OWNER`); the arguments; and last, the storage the call needs. The caller is the
//! predecessor, never the signer. None of them logs an event.
//!
//! None of them can change a balance, a task or an entry; the vault slots they add are empty. A
//! pause or a disabled token refuses new tasks and top-ups, and a disabled token refuses new
//! deposits; neither stands in the way of `withdraw`, `pick`, `void_task` or `cleanup`, which look
//! at neither the pause switch nor the allowlist.

use near_sdk::json_types::{U128, U64};
use near_sdk::{assert_one_yocto, env, near, AccountId};

use crate::types::{
    err, Bond, ConfigView, TokenConfig, TokenConfigView, MAX_BOND_COOLDOWN_SECS, MAX_FEE_BPS,
    MAX_REWARD_LIMIT, MAX_WINDOW_SECS,
};
use crate::{Tender, TenderExt};

#[near]
impl Tender {
    /// The contract's configuration, including the token allowlist.
    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            owner: self.owner.clone(),
            pending_owner: self.pending_owner.clone(),
            treasury: self.treasury.clone(),
            fee_bps: self.fee_bps,
            min_window_secs: self.min_window_secs,
            max_window_secs: MAX_WINDOW_SECS,
            paused: self.paused,
            version: self.version,
            tokens: self
                .tokens
                .iter()
                .map(|(token, c)| TokenConfigView {
                    token: token.clone(),
                    min_reward: U128(c.min_reward),
                    max_reward: U128(c.max_reward),
                    enabled: c.enabled,
                })
                .collect(),
            agent_bond_token: self.agent_bond.as_ref().map(|b| b.token.clone()),
            agent_bond_amount: self.agent_bond.as_ref().map(|b| U128(b.amount)),
            agent_bond_cooldown_secs: U64(self.agent_bond_cooldown_secs),
        }
    }

    /// Allowlists `token`, or changes the limits and the `enabled` flag of one that is on the
    /// list. A task posted from now on must carry a reward from `min_reward` to `max_reward`, in
    /// the token's smallest unit, and `1 <= min_reward <= max_reward <= MAX_REWARD_LIMIT`
    /// (`E_REWARD`), so a task can never carry a zero reward, nor one too large to pick.
    ///
    /// Disabling a token refuses new tasks, top-ups and new deposits in it, and nothing else. Its
    /// balances and the tasks already posted in it are untouched, and `withdraw`, `pick`,
    /// `void_task` and `cleanup` do not look at the allowlist, so no money is ever trapped. Limits
    /// are checked when a task is posted or topped up, so narrowing them leaves the rewards of
    /// the tasks that exist as they are, and only caps what a top-up may take them to.
    ///
    /// Also gives the treasury a vault slot for `token`, if it has none, because a pick pays the
    /// fee into it and settling must never need new storage. The owner pays for that slot and for
    /// the token's own record out of its storage balance, so it needs one (`E_STORAGE`;
    /// `storage_deposit` first). Requires 1 yoctoNEAR and the owner.
    #[payable]
    #[deny_unknown_arguments]
    pub fn set_token(
        &mut self,
        token: AccountId,
        min_reward: U128,
        max_reward: U128,
        enabled: bool,
    ) {
        let owner = self.assert_owner();
        if min_reward.0 == 0 || min_reward.0 > max_reward.0 {
            env::panic_str(&format!(
                "{}: the limits must satisfy 1 <= min_reward <= max_reward, got {} and {}",
                err::E_REWARD,
                min_reward.0,
                max_reward.0
            ));
        }
        if max_reward.0 > MAX_REWARD_LIMIT {
            env::panic_str(&format!(
                "{}: max_reward {} exceeds the cap of {MAX_REWARD_LIMIT}",
                err::E_REWARD,
                max_reward.0
            ));
        }
        let before = self.storage_mark();
        self.put_token(
            token.clone(),
            TokenConfig {
                min_reward: min_reward.0,
                max_reward: max_reward.0,
                enabled,
            },
        );
        let treasury = self.treasury.clone();
        self.ensure_vault_slot(&treasury, &token);
        self.settle_storage(&owner, before);
    }

    /// Sets the protocol fee, in basis points, and the treasury that receives it. The fee is at
    /// most `MAX_FEE_BPS`, 10% (`E_FEE`).
    ///
    /// A task keeps the `fee_bps` it was posted with, so a new fee applies to the tasks posted
    /// from now on. The treasury works the other way: a pick pays the fee to the treasury in force
    /// when it is made, not the one in force when the task was posted. So before switching, this
    /// gives the new treasury a vault slot for every allowlisted token, the disabled ones too (a
    /// task in a disabled token can still be picked). The owner pays for the slots out of its
    /// storage balance (`E_STORAGE`); the new treasury needs no storage balance. What the old
    /// treasury has earned stays in its vault, and it withdraws it as any account does. Requires 1
    /// yoctoNEAR and the owner.
    #[payable]
    #[deny_unknown_arguments]
    pub fn set_fee(&mut self, fee_bps: u16, treasury: AccountId) {
        let owner = self.assert_owner();
        if fee_bps > MAX_FEE_BPS {
            env::panic_str(&format!(
                "{}: fee_bps {fee_bps} exceeds the cap of {MAX_FEE_BPS}",
                err::E_FEE
            ));
        }
        let tokens: Vec<AccountId> = self.tokens.keys().cloned().collect();
        let before = self.storage_mark();
        for token in &tokens {
            self.ensure_vault_slot(&treasury, token);
        }
        self.settle_storage(&owner, before);
        self.fee_bps = fee_bps;
        self.treasury = treasury;
    }

    /// Sets the shortest window a task may use, for each of its four phases, in seconds: from 1
    /// to `MAX_WINDOW_SECS` (`E_WINDOW`). A minimum above the maximum would make posting
    /// impossible for good. It applies to the tasks posted from now on. Requires 1 yoctoNEAR and
    /// the owner.
    #[payable]
    #[deny_unknown_arguments]
    pub fn set_min_window(&mut self, min_window_secs: u32) {
        self.assert_owner();
        if !(1..=MAX_WINDOW_SECS).contains(&min_window_secs) {
            env::panic_str(&format!(
                "{}: min_window_secs {min_window_secs} must be between 1 and {MAX_WINDOW_SECS}",
                err::E_WINDOW
            ));
        }
        self.min_window_secs = min_window_secs;
    }

    /// Sets the bond that `register_agent` takes from the vault of an agent that registers from
    /// now on: `amount` of `token`, in its smallest unit. `token` must be allowlisted and enabled
    /// (`E_TOKEN`), since a disabled token takes no deposits to pay a bond with, and `amount` more
    /// than 0 (`E_LIMIT`). There is no way back to no bond.
    ///
    /// Each agent keeps the bond it paid, so a change applies only to registrations from now on:
    /// `claim_agent_bond` pays back exactly what was taken, and an agent that registered for
    /// nothing before the first bond was set stays registered. Requires 1 yoctoNEAR and the owner.
    #[payable]
    #[deny_unknown_arguments]
    pub fn set_agent_bond(&mut self, token: AccountId, amount: U128) {
        self.assert_owner();
        if !self.tokens.get(&token).is_some_and(|c| c.enabled) {
            env::panic_str(&format!(
                "{}: {token} is not an allowlisted, enabled token",
                err::E_TOKEN
            ));
        }
        if amount.0 == 0 {
            env::panic_str(&format!(
                "{}: the agent bond must be more than 0",
                err::E_LIMIT
            ));
        }
        self.agent_bond = Some(Bond {
            token,
            amount: amount.0,
        });
    }

    /// Sets how long, in seconds, an agent waits from `unregister_agent` until `claim_agent_bond`
    /// pays its bond back: from the shortest window, `min_window_secs` as it is now, to
    /// `MAX_BOND_COOLDOWN_SECS`, 56 days (`E_WINDOW`). It applies to the agents that unregister
    /// from now on; one that has unregistered keeps the time it was given.
    ///
    /// The cooldown does not decide whether one bond can seat several accounts in one task: each
    /// open-task entry locks its agent's bond until that task's commit deadline (`locked_until`),
    /// whatever the cooldown. The bound is checked when the cooldown is set; a later
    /// `set_min_window` above it leaves it as it is, which is harmless for the same reason.
    /// Requires 1 yoctoNEAR and the owner.
    #[payable]
    #[deny_unknown_arguments]
    pub fn set_agent_bond_cooldown(&mut self, secs: U64) {
        self.assert_owner();
        let shortest = u64::from(self.min_window_secs);
        if !(shortest..=MAX_BOND_COOLDOWN_SECS).contains(&secs.0) {
            env::panic_str(&format!(
                "{}: the cooldown must be {shortest} to {MAX_BOND_COOLDOWN_SECS} seconds, got {}",
                err::E_WINDOW,
                secs.0
            ));
        }
        self.agent_bond_cooldown_secs = secs.0;
    }

    /// Pauses or resumes new money into tasks. While paused, `post_task` and `top_up_task` are
    /// refused (`E_PAUSED`). Nothing else is paused, so a pause never traps money: deposits,
    /// withdrawals, commits, reveals, picks, voids and cleanups all keep working, and so do
    /// `register_agent`, `unregister_agent` and `claim_agent_bond`. Requires 1 yoctoNEAR and the
    /// owner.
    #[payable]
    #[deny_unknown_arguments]
    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.paused = paused;
    }

    /// Offers ownership to `new_owner`, replacing any offer made before. The offer gives
    /// `new_owner` no power and takes none from the owner until `new_owner` calls `accept_owner`,
    /// so a mistyped account costs nothing: the owner proposes again. Requires 1 yoctoNEAR and the
    /// owner.
    #[payable]
    #[deny_unknown_arguments]
    pub fn propose_owner(&mut self, new_owner: AccountId) {
        self.assert_owner();
        self.pending_owner = Some(new_owner);
    }

    /// Takes over as owner, and clears the offer. The previous owner loses every power at once.
    /// Requires 1 yoctoNEAR and that the caller is the account `propose_owner` named (`E_OWNER`).
    ///
    /// The generated wrapper of a method without arguments never reads its input, so
    /// `deny_unknown_arguments` has nothing to deny here. It stays so that every public setter
    /// carries the same attribute.
    #[payable]
    #[deny_unknown_arguments]
    pub fn accept_owner(&mut self) {
        assert_one_yocto();
        let caller = env::predecessor_account_id();
        if self.pending_owner.as_ref() != Some(&caller) {
            env::panic_str(&format!(
                "{}: {caller} is not the pending owner",
                err::E_OWNER
            ));
        }
        self.owner = caller;
        self.pending_owner = None;
    }

    /// Brings the stored state up to this build's layout, after the contract code has been
    /// replaced. This build's layout is version 1, so for now it only checks that the stored
    /// state is version 1 and returns it unchanged. It is the template for the next change.
    ///
    /// Only the contract account can call it (`#[private]`): the upgrade transaction deploys the
    /// new code and calls `migrate` in the same batch. Panics `E_NOT_FOUND` if no state is
    /// stored, and `E_VERSION` if the stored version is not 1.
    ///
    /// A build that changes the layout keeps the old struct under another name, say `TenderV1`,
    /// reads it here with `env::state_read::<TenderV1>()`, requires its version, and builds the
    /// new `Tender` from its fields with `version` raised. The version check is also what stops a
    /// second `migrate` from running on a state that has been migrated already.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let Some(state) = env::state_read::<Self>() else {
            env::panic_str(&format!("{}: no contract state", err::E_NOT_FOUND));
        };
        if state.version != 1 {
            env::panic_str(&format!(
                "{}: cannot migrate state version {}; this build migrates version 1",
                err::E_VERSION,
                state.version
            ));
        }
        state
    }
}

impl Tender {
    /// The start of every owner-only method: exactly 1 yoctoNEAR is attached, then the caller is
    /// the owner (`E_OWNER`). Returns the owner, who pays for any storage the call adds.
    fn assert_owner(&self) -> AccountId {
        assert_one_yocto();
        let caller = env::predecessor_account_id();
        if caller != self.owner {
            env::panic_str(&format!("{}: {caller} is not the owner", err::E_OWNER));
        }
        caller
    }

    /// Inserts `token` into the allowlist, or overwrites its limits and `enabled` flag. It checks
    /// nothing and charges nobody: `set_token` wraps it with the owner check, the bounds and the
    /// storage window, and the unit tests use it to set a world up directly.
    pub(crate) fn put_token(&mut self, token: AccountId, cfg: TokenConfig) {
        self.tokens.insert(token, cfg);
    }
}

#[cfg(test)]
mod tests {
    use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
    use near_sdk::json_types::{U128, U64};
    use near_sdk::mock::MockAction;
    use near_sdk::serde_json::{self, json, Value};
    use near_sdk::test_utils::{get_created_receipts, get_logs};
    use near_sdk::{env, testing_env, AccountId, NearToken, PromiseOrValue};

    use crate::entries::commitment_of;
    use crate::test_utils::{ctx, fresh, panic_message};
    use crate::types::{
        err, hex32, OutcomeView, PostTaskArgs, TokenBalance, TokenConfig, WinnerArg,
        MAX_WINDOW_SECS,
    };
    use crate::Tender;

    const OWNER: &str = "owner.test";
    /// The treasury that `fresh` configures.
    const TREASURY: &str = "treasury.test";
    /// A treasury that `set_fee` can switch to.
    const NEW_TREASURY: &str = "new-treasury.test";
    /// A second one to switch to. Its name is as long as `NEW_TREASURY`'s, so the vault slots of
    /// the two take the same number of bytes.
    const ALT_TREASURY: &str = "alt-treasury.test";
    const USDC: &str = "usdc.test";
    const DAI: &str = "dai.test";
    /// The verifier of the default task.
    const JUDGE: &str = "judge.test";
    /// An account with no part in any task, as the keeper that voids tasks is.
    const KEEPER: &str = "keeper.test";
    const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
    const NO_DEPOSIT: NearToken = NearToken::from_yoctonear(0);
    /// What near-sdk's `assert_one_yocto` panics with.
    const ONE_YOCTO_MESSAGE: &str = "Requires attached deposit of exactly 1 yoctoNEAR";
    const STORAGE_SHORT_MESSAGE: &str =
        "E_STORAGE: insufficient storage balance; call storage_deposit";
    /// The block time the tests post at: above 2^53 nanoseconds, which a JSON number could not
    /// carry.
    const T1: u64 = 1_793_028_278_935_742_660;
    const SEC: u64 = 1_000_000_000;
    /// The deadlines of the default task posted at `T1`: windows of 60 s to commit, then 120 s to
    /// reveal.
    const COMMIT_DEADLINE: u64 = T1 + 60 * SEC;
    const REVEAL_DEADLINE: u64 = T1 + 180 * SEC;
    /// What alice, the poster, holds in her vault at the start: 100 USDC.
    const FUNDS: u128 = 100_000_000;
    /// The reward of the default task: 1 USDC. The fee of 500 bps leaves 950_000 to the winner.
    const REWARD: u128 = 1_000_000;
    /// The USDC reward limits: 10 units to 50 USDC.
    const MIN_REWARD: u128 = 10;
    const MAX_REWARD: u128 = 50_000_000;
    const BRIEF_URI: &str = "https://api.tender.example/v1/blobs/b94d27b9";
    /// sha256("hello world").
    const BRIEF_HASH: &str = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";
    /// sha256("foo").
    const CRITERIA_HASH: &str = "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae";
    /// Where the tests' entrants publish their work.
    const URI: &str = "https://api.tender.example/v1/results/2c26b46b";
    /// sha256("bar"), standing in for the hash of a scorecard.
    const SCORECARD_HASH: &str = "fcde2b2edba56bf408601fb721fe9b5c338d10ee429ea04fae5511b68fbf8fb9";
    const SCORECARD_URI: &str = "https://api.tender.example/v1/blobs/fcde2b2e";

    fn acct(id: &str) -> AccountId {
        id.parse().unwrap()
    }

    fn byte_cost() -> u128 {
        env::storage_byte_cost().as_yoctonear()
    }

    fn one_yocto() -> Result<(), String> {
        Err(ONE_YOCTO_MESSAGE.to_string())
    }

    fn token_balance(token: &str, amount: u128) -> TokenBalance {
        TokenBalance {
            token: acct(token),
            amount: U128(amount),
        }
    }

    fn config_json(t: &Tender) -> String {
        serde_json::to_string(&t.get_config()).unwrap()
    }

    fn balance(t: &Tender, token: &str, who: &str) -> u128 {
        t.balance_of(acct(who), acct(token)).0
    }

    fn used(t: &Tender, who: &str) -> u64 {
        t.storage_balance_of(acct(who))
            .expect("has a storage balance")
            .used_bytes
            .0
    }

    /// The bytes a vault slot takes: 40 of record overhead, the key (a 1-byte prefix, then the two
    /// account ids with 4-byte lengths) and a 16-byte value.
    fn slot_bytes(account: &str, token: &str) -> u64 {
        (40 + 1 + (4 + account.len()) + (4 + token.len()) + 16) as u64
    }

    /// Spends `who`'s storage balance down to exactly `bytes` to spare.
    fn leave_spare(t: &mut Tender, who: &str, bytes: u64) {
        let who = acct(who);
        let spare = u64::try_from(t.storage_available(&who) / byte_cost()).unwrap();
        t.reserve_bytes(&who, spare - bytes);
        assert_eq!(t.storage_available(&who), u128::from(bytes) * byte_cost());
    }

    /// Adds `deposit` to `who`'s storage balance, registering it if need be.
    fn register(t: &mut Tender, who: &str, deposit: NearToken) {
        testing_env!(ctx(who).attached_deposit(deposit).build());
        t.storage_deposit(None, None);
    }

    /// `who` deposits `amount` of `token`, as the token reports it to `ft_on_transfer`. Returns
    /// what the contract hands back, which the token then refunds.
    fn fund(t: &mut Tender, token: &str, who: &str, amount: u128) -> u128 {
        testing_env!(ctx(token).build());
        match t.ft_on_transfer(acct(who), U128(amount), String::new()) {
            PromiseOrValue::Value(unused) => unused.0,
            PromiseOrValue::Promise(_) => panic!("ft_on_transfer must answer with a value"),
        }
    }

    /// `who` calls `call` with `deposit` attached. `Err` holds the message the contract panicked
    /// with.
    fn try_as(
        t: &mut Tender,
        who: &str,
        deposit: NearToken,
        call: impl FnOnce(&mut Tender),
    ) -> Result<(), String> {
        testing_env!(ctx(who).attached_deposit(deposit).build());
        match panic_message(|| call(t)) {
            Some(message) => Err(message),
            None => Ok(()),
        }
    }

    /// The owner calls `call` with 1 yoctoNEAR. Panics if the contract rejects the call.
    fn as_owner(t: &mut Tender, call: impl FnOnce(&mut Tender)) {
        try_as(t, OWNER, ONE_YOCTO, call)
            .unwrap_or_else(|message| panic!("the owner's call was rejected: {message}"));
    }

    /// Asserts that `result` is a rejection with `code`. Returns the message.
    fn assert_rejected(result: Result<(), String>, code: &str, what: &str) -> String {
        let message = result.expect_err(&format!(
            "{what}: expected {code}, but the call went through"
        ));
        assert!(
            message.starts_with(&format!("{code}: ")),
            "{what}: expected {code}, got {message:?}"
        );
        message
    }

    /// A contract whose owner has 1 NEAR of storage and has allowlisted USDC with `set_token`;
    /// alice, the poster, with 1 NEAR of storage and `FUNDS` in her vault; and bob, carol and the
    /// judge with 0.1 NEAR of storage and no vault slot. bob and carol are registered agents, with
    /// no bond, since none is set, so they may enter open tasks.
    fn world() -> Tender {
        let mut t = fresh();
        register(&mut t, OWNER, NearToken::from_near(1));
        as_owner(&mut t, |t| {
            t.set_token(acct(USDC), U128(MIN_REWARD), U128(MAX_REWARD), true)
        });
        register(&mut t, "alice.test", NearToken::from_near(1));
        assert_eq!(fund(&mut t, USDC, "alice.test", FUNDS), 0);
        for who in ["bob.test", "carol.test", JUDGE] {
            register(&mut t, who, NearToken::from_millinear(100));
        }
        for who in ["bob.test", "carol.test"] {
            try_as(&mut t, who, ONE_YOCTO, |t| {
                t.register_agent(URI.to_string(), BRIEF_HASH.to_string(), vec![])
            })
            .unwrap_or_else(|message| panic!("{who} could not register: {message}"));
        }
        t
    }

    /// A task that meets every rule: 1 USDC, windows of 60, 120, 180 and 240 seconds, open to
    /// anyone, one winner, and `JUDGE` as the verifier.
    fn args() -> PostTaskArgs {
        PostTaskArgs {
            token: acct(USDC),
            reward: U128(REWARD),
            brief_uri: BRIEF_URI.to_string(),
            brief_hash: BRIEF_HASH.to_string(),
            criteria_hash: CRITERIA_HASH.to_string(),
            heldout_commitment: None,
            verifier: Some(acct(JUDGE)),
            commit_secs: 60,
            reveal_secs: 120,
            pick_secs: 180,
            fallback_secs: 240,
            max_entries: 0,
            max_winners: 1,
            invited: vec![],
            parent: None,
        }
    }

    /// alice posts `task` at `T1`. `Err` holds the message the contract panicked with.
    fn try_post(t: &mut Tender, task: PostTaskArgs) -> Result<u64, String> {
        testing_env!(ctx("alice.test")
            .attached_deposit(ONE_YOCTO)
            .block_timestamp(T1)
            .build());
        let mut id = None;
        match panic_message(|| id = Some(t.post_task(task).0)) {
            Some(message) => Err(message),
            None => Ok(id.expect("post_task returned")),
        }
    }

    fn post(t: &mut Tender, task: PostTaskArgs) -> u64 {
        try_post(t, task).unwrap_or_else(|message| panic!("the post was rejected: {message}"))
    }

    /// `who` tops task `id` up by `amount` at `T1`, with 1 yoctoNEAR. `Err` holds the message the
    /// contract panicked with.
    fn try_top_up(t: &mut Tender, who: &str, id: u64, amount: u128) -> Result<(), String> {
        testing_env!(ctx(who)
            .attached_deposit(ONE_YOCTO)
            .block_timestamp(T1)
            .build());
        match panic_message(|| t.top_up_task(U64(id), U128(amount))) {
            Some(message) => Err(message),
            None => Ok(()),
        }
    }

    /// The work that `seed` stands for: its content hash and the salt it is committed with.
    fn work(seed: u8) -> ([u8; 32], [u8; 32]) {
        (env::sha256_array([seed]), [seed; 32])
    }

    /// `who` enters task `id` with the work `seed`, at `T1`.
    fn enter(t: &mut Tender, who: &str, id: u64, seed: u8) {
        let (content_hash, salt) = work(seed);
        let commitment = commitment_of(id, &acct(who), &content_hash, &salt);
        testing_env!(ctx(who).block_timestamp(T1).build());
        t.commit(U64(id), hex32(&commitment));
    }

    /// `who` reveals the work `seed` in task `id`, at the commit deadline.
    fn reveal(t: &mut Tender, who: &str, id: u64, seed: u8) {
        let (content_hash, salt) = work(seed);
        testing_env!(ctx(who).block_timestamp(COMMIT_DEADLINE).build());
        t.reveal(U64(id), hex32(&content_hash), hex32(&salt), URI.to_string());
    }

    /// The judge picks `list`, as `(account, bps)` pairs, in task `id` when its verifier window
    /// opens.
    fn pick(t: &mut Tender, id: u64, list: &[(&str, u16)]) {
        testing_env!(ctx(JUDGE).block_timestamp(REVEAL_DEADLINE).build());
        let winners = list
            .iter()
            .map(|&(account, bps)| WinnerArg {
                account: acct(account),
                bps,
            })
            .collect();
        t.pick(
            U64(id),
            winners,
            SCORECARD_HASH.to_string(),
            SCORECARD_URI.to_string(),
        );
    }

    /// `who` voids task `id` when its verifier window opens.
    fn void(t: &mut Tender, who: &str, id: u64) {
        testing_env!(ctx(who).block_timestamp(REVEAL_DEADLINE).build());
        t.void_task(U64(id));
    }

    /// `who` cleans up to 50 entries of the settled task `id`. Returns how many it went through.
    fn cleanup(t: &mut Tender, who: &str, id: u64) -> u32 {
        testing_env!(ctx(who).block_timestamp(REVEAL_DEADLINE).build());
        t.cleanup(U64(id), 50)
    }

    /// `who` withdraws `amount` of USDC to itself. Returns the `ft_transfer`s the contract
    /// scheduled, as `(token, receiver, amount)`.
    fn withdraw(t: &mut Tender, who: &str, amount: u128) -> Vec<(String, String, String)> {
        testing_env!(ctx(who).attached_deposit(ONE_YOCTO).build());
        // Dropping the promise is what creates its receipts.
        let _ = t.withdraw(acct(USDC), U128(amount), None);
        get_created_receipts()
            .iter()
            .flat_map(|receipt| {
                receipt
                    .actions
                    .iter()
                    .filter_map(move |action| match action {
                        MockAction::FunctionCallWeight {
                            method_name, args, ..
                        } if method_name.as_slice() == b"ft_transfer" => {
                            let args: Value = serde_json::from_slice(args).unwrap();
                            Some((
                                receipt.receiver_id.to_string(),
                                args["receiver_id"].as_str().unwrap().to_string(),
                                args["amount"].as_str().unwrap().to_string(),
                            ))
                        }
                        _ => None,
                    })
            })
            .collect()
    }

    fn transfer(token: &str, receiver: &str, amount: u128) -> (String, String, String) {
        (token.to_string(), receiver.to_string(), amount.to_string())
    }

    /// A call to the contract, with its arguments fixed.
    type Call = fn(&mut Tender);

    /// Every owner-only setter, called with arguments that are valid. `set_agent_bond` comes after
    /// `set_token`, which allowlists its token.
    fn setters() -> [(&'static str, Call); 8] {
        [
            ("set_token", |t| {
                t.set_token(acct(USDC), U128(10), U128(1_000), true)
            }),
            ("set_fee", |t| t.set_fee(100, acct(NEW_TREASURY))),
            ("set_min_window", |t| t.set_min_window(120)),
            ("set_agent_bond", |t| t.set_agent_bond(acct(USDC), U128(5))),
            ("set_agent_bond_cooldown", |t| {
                t.set_agent_bond_cooldown(U64(3_600))
            }),
            ("set_paused", |t| t.set_paused(true)),
            ("propose_owner", |t| t.propose_owner(acct("alice.test"))),
            ("accept_owner", |t| t.accept_owner()),
        ]
    }

    // The two tests that came with `put_token` and `new`.

    #[test]
    fn put_token_inserts_and_overwrites() {
        let mut t = fresh();
        let cfg = |min_reward, max_reward, enabled| TokenConfig {
            min_reward,
            max_reward,
            enabled,
        };
        t.put_token("usdc.test".parse().unwrap(), cfg(1, 10, true));
        t.put_token("dai.test".parse().unwrap(), cfg(2, 20, false));
        t.put_token("usdc.test".parse().unwrap(), cfg(3, 30, false));
        let tokens = t.get_config().tokens;
        // usdc was overwritten in place, not added twice.
        assert_eq!(tokens.len(), 2);
        assert_eq!(tokens[0].token.as_str(), "usdc.test");
        assert_eq!(
            (
                tokens[0].min_reward.0,
                tokens[0].max_reward.0,
                tokens[0].enabled
            ),
            (3, 30, false)
        );
        assert_eq!(tokens[1].token.as_str(), "dai.test");
        assert_eq!(
            (
                tokens[1].min_reward.0,
                tokens[1].max_reward.0,
                tokens[1].enabled
            ),
            (2, 20, false)
        );
    }

    #[test]
    fn new_sets_config() {
        let c = fresh().get_config();
        assert_eq!(
            (c.fee_bps, c.min_window_secs, c.paused, c.version),
            (500, 60, false, 1)
        );
        assert_eq!(c.max_window_secs, 1_209_600);
    }

    // Who may call, and in which order the checks run (I6, I9).

    #[test]
    fn admin_methods_require_owner_and_one_yocto() {
        let mut t = fresh();
        register(&mut t, OWNER, NearToken::from_near(1));
        let before = config_json(&t);
        for (name, call) in setters() {
            // Without exactly 1 yoctoNEAR, not even the owner gets through.
            for deposit in [
                NO_DEPOSIT,
                NearToken::from_yoctonear(2),
                NearToken::from_near(1),
            ] {
                assert_eq!(
                    try_as(&mut t, OWNER, deposit, call),
                    one_yocto(),
                    "{name} with {deposit:?}"
                );
            }
            // With it, anyone else is turned away.
            assert_rejected(
                try_as(&mut t, "alice.test", ONE_YOCTO, call),
                "E_OWNER",
                name,
            );
        }
        assert_eq!(config_json(&t), before, "a refused call changes nothing");
        assert!(get_logs().is_empty());

        // The owner's own call goes through, which is what the refusals above are measured
        // against. `accept_owner` is the pending owner's call, not the owner's.
        for (name, call) in setters() {
            if name != "accept_owner" {
                try_as(&mut t, OWNER, ONE_YOCTO, call).unwrap_or_else(|m| panic!("{name}: {m}"));
            }
        }
        try_as(&mut t, "alice.test", ONE_YOCTO, Tender::accept_owner).unwrap();
        let config = t.get_config();
        assert_eq!(config.owner, acct("alice.test"));
        assert_eq!(
            (config.fee_bps, config.min_window_secs, config.paused),
            (100, 120, true)
        );
        assert_eq!(
            (
                config.agent_bond_token,
                config.agent_bond_amount,
                config.agent_bond_cooldown_secs
            ),
            (Some(acct(USDC)), Some(U128(5)), U64(3_600))
        );
    }

    #[test]
    fn admin_checks_run_in_the_listed_order() {
        // The owner has no storage balance, so a storage check could fail too.
        let mut t = fresh();
        // A call whose arguments break one rule, with the code of that rule.
        let broken: [(&str, Call, &str); 5] = [
            (
                "set_token",
                |t| t.set_token(acct(USDC), U128(0), U128(10), true),
                "E_REWARD",
            ),
            ("set_fee", |t| t.set_fee(1_001, acct(NEW_TREASURY)), "E_FEE"),
            ("set_min_window", |t| t.set_min_window(0), "E_WINDOW"),
            (
                "set_agent_bond",
                |t| t.set_agent_bond(acct(USDC), U128(5)),
                "E_TOKEN",
            ),
            (
                "set_agent_bond_cooldown",
                |t| t.set_agent_bond_cooldown(U64(0)),
                "E_WINDOW",
            ),
        ];
        for (name, call, code) in broken {
            // First the deposit, whoever calls...
            assert_eq!(
                try_as(&mut t, "alice.test", NO_DEPOSIT, call),
                one_yocto(),
                "{name}"
            );
            assert_eq!(
                try_as(&mut t, OWNER, NO_DEPOSIT, call),
                one_yocto(),
                "{name}"
            );
            // ...then the owner...
            assert_rejected(
                try_as(&mut t, "alice.test", ONE_YOCTO, call),
                "E_OWNER",
                name,
            );
            // ...then the arguments, and for `set_token` before any storage is touched.
            assert_rejected(try_as(&mut t, OWNER, ONE_YOCTO, call), code, name);
        }
        // Valid arguments come last: now only the owner's missing storage balance is wrong.
        let result = try_as(&mut t, OWNER, ONE_YOCTO, |t| {
            t.set_token(acct(USDC), U128(10), U128(100), true)
        });
        assert_eq!(
            assert_rejected(result, "E_STORAGE", "set_token"),
            "E_STORAGE: not registered"
        );

        // `accept_owner` checks the deposit, then that the caller is the pending owner.
        as_owner(&mut t, |t| t.propose_owner(acct("alice.test")));
        assert_eq!(
            try_as(&mut t, "alice.test", NO_DEPOSIT, Tender::accept_owner),
            one_yocto()
        );
        assert_eq!(
            try_as(&mut t, "bob.test", NO_DEPOSIT, Tender::accept_owner),
            one_yocto()
        );
        assert_rejected(
            try_as(&mut t, "bob.test", ONE_YOCTO, Tender::accept_owner),
            "E_OWNER",
            "accept_owner",
        );
        try_as(&mut t, "alice.test", ONE_YOCTO, Tender::accept_owner).unwrap();
    }

    #[test]
    fn admin_acts_for_the_predecessor_not_the_signer() {
        let mut t = fresh();
        register(&mut t, OWNER, NearToken::from_near(1));
        as_owner(&mut t, |t| t.propose_owner(acct("alice.test")));
        let before = config_json(&t);
        // The owner signs a transaction whose call reaches Tender from another contract. That
        // contract is the caller, and it is not the owner. The same holds for the pending owner.
        for (name, call) in setters() {
            testing_env!(ctx("evil.test")
                .signer_account_id(acct(if name == "accept_owner" {
                    "alice.test"
                } else {
                    OWNER
                }))
                .attached_deposit(ONE_YOCTO)
                .build());
            let result = match panic_message(|| call(&mut t)) {
                Some(message) => Err(message),
                None => Ok(()),
            };
            assert_rejected(result, "E_OWNER", name);
        }
        assert_eq!(config_json(&t), before);

        // The other way round, the owner's own call goes through whoever signed it.
        testing_env!(ctx(OWNER)
            .signer_account_id(acct("evil.test"))
            .attached_deposit(ONE_YOCTO)
            .build());
        t.set_paused(true);
        assert!(t.get_config().paused);
    }

    #[test]
    fn admin_setters_emit_no_events() {
        let mut t = fresh();
        register(&mut t, OWNER, NearToken::from_near(1));
        for (name, call) in setters() {
            if name != "accept_owner" {
                as_owner(&mut t, call);
                assert!(get_logs().is_empty(), "{name} logged {:?}", get_logs());
            }
        }
        try_as(&mut t, "alice.test", ONE_YOCTO, Tender::accept_owner).unwrap();
        assert!(
            get_logs().is_empty(),
            "accept_owner logged {:?}",
            get_logs()
        );
    }

    // set_token.

    #[test]
    fn set_token_creates_treasury_slot() {
        let mut t = fresh();
        register(&mut t, OWNER, NearToken::from_near(1));
        let treasury = acct(TREASURY);
        assert!(t.balances_of(treasury.clone()).is_empty());
        let start = used(&t, OWNER);

        testing_env!(ctx(OWNER).attached_deposit(ONE_YOCTO).build());
        let usage = t.storage_mark();
        t.set_token(acct(USDC), U128(MIN_REWARD), U128(MAX_REWARD), true);
        let grown = env::storage_usage() - usage;

        // The treasury has an empty slot now, though it never registered or paid for anything.
        assert_eq!(
            t.balances_of(treasury.clone()),
            vec![token_balance(USDC, 0)]
        );
        assert_eq!(t.storage_balance_of(treasury.clone()), None);
        // The owner paid for the slot and for the token's record in the allowlist.
        assert_eq!(used(&t, OWNER), start + grown);
        let slot = slot_bytes(TREASURY, USDC);
        assert_eq!(slot, 87);
        assert!(grown > slot, "the allowlist record is paid for too");

        // A slot that exists is left alone: it keeps its balance, and nothing more is charged.
        t.credit(&treasury, &acct(USDC), 5);
        as_owner(&mut t, |t| {
            t.set_token(acct(USDC), U128(20), U128(100), false)
        });
        assert_eq!(balance(&t, USDC, TREASURY), 5);
        assert_eq!(used(&t, OWNER), start + grown);

        // Another token costs its own record and another slot.
        as_owner(&mut t, |t| t.set_token(acct(DAI), U128(1), U128(100), true));
        assert_eq!(
            t.balances_of(treasury),
            vec![token_balance(USDC, 5), token_balance(DAI, 0)]
        );
        assert!(used(&t, OWNER) > start + grown);
    }

    #[test]
    fn set_token_needs_a_storage_balance() {
        let mut t = fresh();
        let result = try_as(&mut t, OWNER, ONE_YOCTO, |t| {
            t.set_token(acct(USDC), U128(10), U128(100), true)
        });
        assert_eq!(
            assert_rejected(result, "E_STORAGE", "an owner with no storage balance"),
            "E_STORAGE: not registered"
        );
    }

    #[test]
    fn set_token_is_paid_from_the_owners_storage_balance() {
        let mut t = fresh();
        register(&mut t, OWNER, NearToken::from_near(1));
        let start = used(&t, OWNER);
        as_owner(&mut t, |t| {
            t.set_token(acct("tok-a.test"), U128(1), U128(9), true)
        });
        let cost = used(&t, OWNER) - start;

        // A token whose name is as long costs the same. With exactly that to spare, it goes
        // through and leaves nothing...
        leave_spare(&mut t, OWNER, cost);
        let reserved = used(&t, OWNER);
        as_owner(&mut t, |t| {
            t.set_token(acct("tok-b.test"), U128(1), U128(9), true)
        });
        assert_eq!(used(&t, OWNER) - reserved, cost);
        assert_eq!(t.storage_available(&acct(OWNER)), 0);

        // ...and with one byte less, it fails.
        register(
            &mut t,
            OWNER,
            NearToken::from_yoctonear(u128::from(cost - 1) * byte_cost()),
        );
        let result = try_as(&mut t, OWNER, ONE_YOCTO, |t| {
            t.set_token(acct("tok-c.test"), U128(1), U128(9), true)
        });
        assert_eq!(
            assert_rejected(result, "E_STORAGE", "one byte short"),
            STORAGE_SHORT_MESSAGE
        );
    }

    #[test]
    fn set_token_bounds() {
        let mut t = fresh();
        register(&mut t, OWNER, NearToken::from_near(1));
        let cap = u128::MAX / 10_000;
        // A reward of zero must be impossible, and so must a range that is empty, and one that
        // goes past the cap.
        for (min, max) in [
            (0, 0),
            (0, 10),
            (0, u128::MAX),
            (11, 10),
            (u128::MAX, 1),
            (1, cap + 1),
            (1, u128::MAX),
            (u128::MAX, u128::MAX),
        ] {
            let result = try_as(&mut t, OWNER, ONE_YOCTO, |t| {
                t.set_token(acct(USDC), U128(min), U128(max), true)
            });
            assert_rejected(result, "E_REWARD", &format!("{min} to {max}"));
        }
        assert!(t.get_config().tokens.is_empty(), "nothing was allowlisted");
        assert!(t.balances_of(acct(TREASURY)).is_empty(), "no slot was made");

        // A single reward, and any range from 1 up to the cap, is fine.
        for (min, max) in [(1, 1), (1, cap), (7, 7), (10, 20), (cap, cap)] {
            as_owner(&mut t, |t| {
                t.set_token(acct(USDC), U128(min), U128(max), true)
            });
            let token = &t.get_config().tokens[0];
            assert_eq!((token.min_reward.0, token.max_reward.0), (min, max));
        }
    }

    #[test]
    fn set_token_caps_max_reward() {
        // A pick multiplies a reward by up to 10_000 basis points. A reward above u128::MAX /
        // 10_000 could then only be voided (`E_REWARD` at the pick), so no token takes one.
        let mut t = fresh();
        register(&mut t, OWNER, NearToken::from_near(1));
        let cap = u128::MAX / 10_000;
        let result = try_as(&mut t, OWNER, ONE_YOCTO, |t| {
            t.set_token(acct(USDC), U128(1), U128(cap + 1), true)
        });
        assert_eq!(
            assert_rejected(result, "E_REWARD", "one above the cap"),
            format!("E_REWARD: max_reward {} exceeds the cap of {cap}", cap + 1)
        );
        assert!(t.get_config().tokens.is_empty(), "nothing was allowlisted");

        // The cap itself is allowed.
        as_owner(&mut t, |t| {
            t.set_token(acct(USDC), U128(1), U128(cap), true)
        });
        assert_eq!(t.get_config().tokens[0].max_reward, U128(cap));
    }

    // set_fee.

    #[test]
    fn set_fee_cap() {
        let mut t = fresh();
        register(&mut t, OWNER, NearToken::from_near(1));
        let before = config_json(&t);
        for fee in [1_001, 1_500, u16::MAX] {
            let result = try_as(&mut t, OWNER, ONE_YOCTO, |t| {
                t.set_fee(fee, acct(NEW_TREASURY))
            });
            assert_rejected(result, "E_FEE", &format!("{fee} bps"));
        }
        // A rejected call changes neither the fee nor the treasury.
        assert_eq!(config_json(&t), before);

        // The cap itself is allowed, and so is no fee at all.
        for fee in [1_000, 0, 1] {
            as_owner(&mut t, |t| t.set_fee(fee, acct(NEW_TREASURY)));
            let config = t.get_config();
            assert_eq!((config.fee_bps, config.treasury), (fee, acct(NEW_TREASURY)));
        }
    }

    #[test]
    fn set_fee_creates_the_new_treasurys_slots_for_every_token() {
        let mut t = world();
        as_owner(&mut t, |t| t.set_token(acct(DAI), U128(1), U128(100), true));
        // A disabled token keeps its tasks, which a pick still pays a fee on, so it needs a slot.
        as_owner(&mut t, |t| {
            t.set_token(acct("old.test"), U128(1), U128(100), false)
        });
        let tokens = [USDC, DAI, "old.test"];
        let start = used(&t, OWNER);

        as_owner(&mut t, |t| t.set_fee(700, acct(NEW_TREASURY)));
        let config = t.get_config();
        assert_eq!((config.fee_bps, config.treasury), (700, acct(NEW_TREASURY)));
        assert_eq!(
            t.balances_of(acct(NEW_TREASURY)),
            tokens.map(|token| token_balance(token, 0)).to_vec()
        );
        // The owner paid for exactly those slots. The new treasury never registered.
        let slots: u64 = tokens
            .iter()
            .map(|token| slot_bytes(NEW_TREASURY, token))
            .sum();
        assert_eq!(used(&t, OWNER), start + slots);
        assert_eq!(t.storage_balance_of(acct(NEW_TREASURY)), None);

        // The slots of a treasury that has them already cost nothing: switching back to the old
        // one, and changing only the fee.
        as_owner(&mut t, |t| t.set_fee(300, acct(TREASURY)));
        as_owner(&mut t, |t| t.set_fee(200, acct(TREASURY)));
        let config = t.get_config();
        assert_eq!((config.fee_bps, config.treasury), (200, acct(TREASURY)));
        assert_eq!(used(&t, OWNER), start + slots);
        assert_eq!(
            t.balances_of(acct(TREASURY)),
            tokens.map(|token| token_balance(token, 0)).to_vec(),
            "the old treasury keeps its slots"
        );
    }

    #[test]
    fn set_fee_is_paid_from_the_owners_storage_balance() {
        let mut t = world();
        as_owner(&mut t, |t| t.set_token(acct(DAI), U128(1), U128(100), true));
        let needed = slot_bytes(NEW_TREASURY, USDC) + slot_bytes(NEW_TREASURY, DAI);
        assert_eq!(
            needed,
            slot_bytes(ALT_TREASURY, USDC) + slot_bytes(ALT_TREASURY, DAI)
        );

        // With exactly the two slots' worth to spare, the switch goes through and leaves nothing.
        leave_spare(&mut t, OWNER, needed);
        as_owner(&mut t, |t| t.set_fee(700, acct(NEW_TREASURY)));
        assert_eq!(t.storage_available(&acct(OWNER)), 0);
        let before = config_json(&t);

        // One byte short of the next treasury's slots, it fails and the config stays put.
        register(
            &mut t,
            OWNER,
            NearToken::from_yoctonear(u128::from(needed - 1) * byte_cost()),
        );
        let result = try_as(&mut t, OWNER, ONE_YOCTO, |t| {
            t.set_fee(900, acct(ALT_TREASURY))
        });
        assert_eq!(
            assert_rejected(result, "E_STORAGE", "one byte short"),
            STORAGE_SHORT_MESSAGE
        );
        assert_eq!(config_json(&t), before);
    }

    #[test]
    fn pick_after_set_fee_pays_new_treasury() {
        let mut t = world();
        // Two tasks, posted at 500 bps, with bob's work revealed in both.
        let (first, second) = (post(&mut t, args()), post(&mut t, args()));
        for (id, seed) in [(first, 1), (second, 2)] {
            enter(&mut t, "bob.test", id, seed);
            reveal(&mut t, "bob.test", id, seed);
        }
        // The first is picked under the treasury in force when it was posted.
        pick(&mut t, first, &[("bob.test", 10_000)]);
        assert_eq!(balance(&t, USDC, TREASURY), 50_000);

        // The owner moves the fee to 900 bps and the treasury to another account.
        as_owner(&mut t, |t| t.set_fee(900, acct(NEW_TREASURY)));
        assert_eq!(
            t.balances_of(acct(NEW_TREASURY)),
            vec![token_balance(USDC, 0)]
        );

        // The second task keeps the 500 bps it was posted with, but its fee goes to the treasury
        // in force at the pick: the new one gets it and the old one gets nothing more.
        pick(&mut t, second, &[("bob.test", 10_000)]);
        assert_eq!(balance(&t, USDC, NEW_TREASURY), 50_000);
        assert_eq!(balance(&t, USDC, TREASURY), 50_000);
        assert_eq!(balance(&t, USDC, "bob.test"), 2 * 950_000);
        let view = t.get_task(U64(second)).expect("the task exists");
        assert_eq!(view.fee_bps, 500);
        let Some(OutcomeView::Picked { fee, .. }) = view.outcome else {
            panic!("the task is picked");
        };
        assert_eq!(fee, U128(50_000));

        // A task posted after the change takes the new fee, and the new treasury gets that too.
        let third = post(&mut t, args());
        assert_eq!(t.get_task(U64(third)).unwrap().fee_bps, 900);
        enter(&mut t, "bob.test", third, 3);
        reveal(&mut t, "bob.test", third, 3);
        pick(&mut t, third, &[("bob.test", 10_000)]);
        assert_eq!(balance(&t, USDC, NEW_TREASURY), 50_000 + 90_000);
        assert_eq!(balance(&t, USDC, TREASURY), 50_000);

        // What the old treasury earned is still its own to withdraw.
        assert_eq!(
            withdraw(&mut t, TREASURY, 50_000),
            vec![transfer(USDC, TREASURY, 50_000)]
        );
        assert_eq!(balance(&t, USDC, TREASURY), 0);
        // Nothing was lost on the way: alice paid three rewards, and all of it was paid out.
        let paid_out = balance(&t, USDC, "bob.test") + balance(&t, USDC, NEW_TREASURY) + 50_000;
        assert_eq!(paid_out, 3 * REWARD);
        assert_eq!(balance(&t, USDC, "alice.test"), FUNDS - 3 * REWARD);
    }

    // set_min_window.

    #[test]
    fn set_min_window_bounds() {
        let mut t = world();
        let early = post(&mut t, args());
        let early_view = t.get_task(U64(early)).expect("the task exists");

        for secs in [0, MAX_WINDOW_SECS + 1, u32::MAX] {
            let result = try_as(&mut t, OWNER, ONE_YOCTO, |t| t.set_min_window(secs));
            assert_rejected(result, "E_WINDOW", &format!("{secs} s"));
        }
        assert_eq!(
            t.get_config().min_window_secs,
            60,
            "a rejected call changes nothing"
        );

        // Both ends of the range are allowed.
        for secs in [1, MAX_WINDOW_SECS, 120] {
            as_owner(&mut t, |t| t.set_min_window(secs));
            assert_eq!(t.get_config().min_window_secs, secs);
        }

        // The minimum binds the windows of tasks posted from now on...
        let message = try_post(&mut t, args()).unwrap_err();
        assert!(message.starts_with("E_WINDOW: "), "{message}");
        let longer = PostTaskArgs {
            commit_secs: 120,
            reveal_secs: 120,
            pick_secs: 120,
            fallback_secs: 120,
            ..args()
        };
        assert_eq!(try_post(&mut t, longer), Ok(2));
        // ...and leaves the task posted earlier as it was.
        assert_eq!(t.get_task(U64(early)), Some(early_view));
    }

    // The agent bond.

    #[test]
    fn set_agent_bond_owner_only_and_token_allowlisted() {
        let mut t = world();
        // DAI is on the list but switched off; WNEAR is not on it at all.
        as_owner(&mut t, |t| {
            t.set_token(acct(DAI), U128(1), U128(1_000), false)
        });
        let config = t.get_config();
        assert_eq!(
            (config.agent_bond_token, config.agent_bond_amount),
            (None, None),
            "until the owner sets one, there is no bond"
        );
        let before = config_json(&t);
        let set = |token: &'static str, amount: u128| {
            move |t: &mut Tender| t.set_agent_bond(acct(token), U128(amount))
        };

        // 1 yoctoNEAR exactly, then the owner, then the arguments.
        for deposit in [NO_DEPOSIT, NearToken::from_yoctonear(2)] {
            assert_eq!(
                try_as(&mut t, OWNER, deposit, set(USDC, 5_000_000)),
                one_yocto(),
                "{deposit:?}"
            );
        }
        for who in ["alice.test", TREASURY] {
            assert_rejected(
                try_as(&mut t, who, ONE_YOCTO, set(USDC, 5_000_000)),
                "E_OWNER",
                who,
            );
        }
        // Another contract the owner's transaction went through is not the owner.
        testing_env!(ctx("evil.test")
            .signer_account_id(acct(OWNER))
            .attached_deposit(ONE_YOCTO)
            .build());
        let through = panic_message(|| t.set_agent_bond(acct(USDC), U128(5_000_000)));
        assert!(through.is_some_and(|m| m.starts_with("E_OWNER: ")));
        for (what, call, code) in [
            ("a token not on the list", set("wnear.test", 5), "E_TOKEN"),
            ("a disabled token", set(DAI, 5), "E_TOKEN"),
            ("a zero bond", set(USDC, 0), "E_LIMIT"),
        ] {
            assert_rejected(try_as(&mut t, OWNER, ONE_YOCTO, call), code, what);
        }
        assert_eq!(config_json(&t), before, "a refused call changes nothing");
        assert!(get_logs().is_empty(), "a refusal logs nothing");

        // The owner sets it, and changes it.
        as_owner(&mut t, set(USDC, 5_000_000));
        let config = t.get_config();
        assert_eq!(
            (config.agent_bond_token, config.agent_bond_amount),
            (Some(acct(USDC)), Some(U128(5_000_000)))
        );
        as_owner(&mut t, set(USDC, 1));
        assert_eq!(t.get_config().agent_bond_amount, Some(U128(1)));
        assert!(get_logs().is_empty(), "an owner setter logs nothing");
    }

    #[test]
    fn set_agent_bond_cooldown_bounds() {
        let mut t = world();
        assert_eq!(
            t.get_config().agent_bond_cooldown_secs,
            U64(1_209_600),
            "until the owner sets one, the cooldown is the longest window"
        );
        let set = |secs: u64| move |t: &mut Tender| t.set_agent_bond_cooldown(U64(secs));
        assert_eq!(try_as(&mut t, OWNER, NO_DEPOSIT, set(600)), one_yocto());
        assert_rejected(
            try_as(&mut t, "alice.test", ONE_YOCTO, set(600)),
            "E_OWNER",
            "alice",
        );
        // From the shortest window, 60 s here, to four times the longest, 56 days.
        for secs in [0, 59, 4_838_401, u64::MAX] {
            assert_rejected(
                try_as(&mut t, OWNER, ONE_YOCTO, set(secs)),
                "E_WINDOW",
                &format!("{secs} s"),
            );
        }
        assert_eq!(t.get_config().agent_bond_cooldown_secs, U64(1_209_600));
        for secs in [60, 4_838_400, 600] {
            as_owner(&mut t, set(secs));
            assert_eq!(t.get_config().agent_bond_cooldown_secs, U64(secs));
        }
        // The bound follows the shortest window as it is when the call is made.
        as_owner(&mut t, |t| t.set_min_window(900));
        assert_rejected(
            try_as(&mut t, OWNER, ONE_YOCTO, set(899)),
            "E_WINDOW",
            "below the new shortest window",
        );
        as_owner(&mut t, set(900));
        assert!(get_logs().is_empty());
    }

    // Ownership.

    #[test]
    fn owner_transfer_is_two_step() {
        let mut t = fresh();
        let (alice, bob, carol) = ("alice.test", "bob.test", "carol.test");
        as_owner(&mut t, |t| t.propose_owner(acct(alice)));
        // A proposal gives no power: the owner stays the owner, and alice is only pending.
        let config = t.get_config();
        assert_eq!(
            (config.owner, config.pending_owner),
            (acct(OWNER), Some(acct(alice)))
        );
        assert_rejected(
            try_as(&mut t, alice, ONE_YOCTO, |t| t.set_paused(true)),
            "E_OWNER",
            "alice before she accepts",
        );
        as_owner(&mut t, |t| t.set_paused(true));

        // Only the pending account can accept, and only with 1 yoctoNEAR: not the owner, not a
        // stranger.
        for who in [OWNER, bob] {
            assert_rejected(
                try_as(&mut t, who, ONE_YOCTO, Tender::accept_owner),
                "E_OWNER",
                who,
            );
        }
        assert_eq!(
            try_as(&mut t, alice, NO_DEPOSIT, Tender::accept_owner),
            one_yocto()
        );
        assert_eq!(t.get_config().owner, acct(OWNER));

        // alice accepts, and the change is total at once.
        try_as(&mut t, alice, ONE_YOCTO, Tender::accept_owner).unwrap();
        let config = t.get_config();
        assert_eq!((config.owner, config.pending_owner), (acct(alice), None));
        assert_rejected(
            try_as(&mut t, OWNER, ONE_YOCTO, |t| t.set_paused(false)),
            "E_OWNER",
            "the old owner",
        );
        try_as(&mut t, alice, ONE_YOCTO, |t| t.set_paused(false)).unwrap();
        // There is nothing left to accept.
        assert_rejected(
            try_as(&mut t, alice, ONE_YOCTO, Tender::accept_owner),
            "E_OWNER",
            "accepting twice",
        );

        // A new proposal replaces the one before it.
        try_as(&mut t, alice, ONE_YOCTO, |t| t.propose_owner(acct(bob))).unwrap();
        try_as(&mut t, alice, ONE_YOCTO, |t| t.propose_owner(acct(carol))).unwrap();
        assert_rejected(
            try_as(&mut t, bob, ONE_YOCTO, Tender::accept_owner),
            "E_OWNER",
            "bob after the proposal moved on",
        );
        try_as(&mut t, carol, ONE_YOCTO, Tender::accept_owner).unwrap();
        assert_eq!(t.get_config().owner, acct(carol));
    }

    // Pausing and disabling never trap money.

    #[test]
    fn pause_blocks_only_new_tasks() {
        let mut t = world();
        // Four tasks, posted before the pause. bob enters the first two.
        let ids = [(); 4].map(|_| post(&mut t, args()));
        assert_eq!(ids, [1, 2, 3, 4]);
        enter(&mut t, "bob.test", ids[0], 1);
        enter(&mut t, "bob.test", ids[1], 2);

        as_owner(&mut t, |t| t.set_paused(true));
        assert!(t.get_config().paused);

        // A new task is refused, and nothing moves.
        let alice_before = balance(&t, USDC, "alice.test");
        let message = try_post(&mut t, args()).unwrap_err();
        assert_eq!(message, "E_PAUSED: posting new tasks is paused");
        assert_eq!(t.task_count(), U64(4));
        assert_eq!(balance(&t, USDC, "alice.test"), alice_before);
        // So is a top-up of a task that is still open, and nothing moves either.
        let message = try_top_up(&mut t, "alice.test", ids[2], 5).unwrap_err();
        assert_eq!(message, "E_PAUSED: topping up tasks is paused");
        assert_eq!(t.get_task(U64(ids[2])).unwrap().reward, U128(REWARD));
        assert_eq!(balance(&t, USDC, "alice.test"), alice_before);

        // Everything else works. A deposit...
        assert_eq!(fund(&mut t, USDC, "alice.test", 5), 0);
        // ...a commit, and a reveal...
        enter(&mut t, "carol.test", ids[2], 3);
        reveal(&mut t, "bob.test", ids[0], 1);
        reveal(&mut t, "bob.test", ids[1], 2);
        // ...a pick that pays a winner, and an empty pick that refunds the poster...
        pick(&mut t, ids[0], &[("bob.test", 10_000)]);
        pick(&mut t, ids[1], &[]);
        // ...a void and a cleanup by a stranger...
        void(&mut t, KEEPER, ids[3]);
        assert_eq!(cleanup(&mut t, KEEPER, ids[0]), 1);
        // ...a withdrawal...
        assert_eq!(
            withdraw(&mut t, "alice.test", 3),
            vec![transfer(USDC, "alice.test", 3)]
        );
        // ...and the storage and registry methods.
        register(&mut t, "bob.test", NearToken::from_millinear(1));
        testing_env!(ctx("bob.test")
            .block_timestamp(T1)
            .attached_deposit(ONE_YOCTO)
            .build());
        t.register_agent(URI.to_string(), BRIEF_HASH.to_string(), vec![]);

        // The money went where each call said: the winner and the treasury were paid, the two
        // refunds came back to alice, and the third task still holds its escrow.
        assert_eq!(balance(&t, USDC, "bob.test"), 950_000);
        assert_eq!(balance(&t, USDC, TREASURY), 50_000);
        assert_eq!(
            balance(&t, USDC, "alice.test"),
            FUNDS - 4 * REWARD + 5 + 2 * REWARD - 3
        );
        assert_eq!(t.get_task(U64(ids[2])).unwrap().outcome, None);
        assert!(t.get_config().paused);

        // Unpausing lets new tasks and top-ups in again.
        as_owner(&mut t, |t| t.set_paused(false));
        assert_eq!(try_post(&mut t, args()), Ok(5));
        assert_eq!(try_top_up(&mut t, "alice.test", ids[2], 5), Ok(()));
        assert_eq!(t.get_task(U64(ids[2])).unwrap().reward, U128(REWARD + 5));
    }

    #[test]
    fn disabling_a_token_never_traps_funds() {
        let mut t = world();
        let (to_pick, to_void) = (post(&mut t, args()), post(&mut t, args()));
        enter(&mut t, "bob.test", to_pick, 1);
        reveal(&mut t, "bob.test", to_pick, 1);
        assert_eq!(fund(&mut t, USDC, "bob.test", 400), 0);

        // The owner narrows the limits below the escrowed rewards, then switches the token off.
        as_owner(&mut t, |t| t.set_token(acct(USDC), U128(1), U128(5), true));
        as_owner(&mut t, |t| {
            t.set_token(acct(USDC), U128(MIN_REWARD), U128(MAX_REWARD), false)
        });
        assert!(!t.get_config().tokens[0].enabled);

        // New tasks, top-ups and new deposits in it are refused...
        let message = try_post(&mut t, args()).unwrap_err();
        assert!(message.starts_with("E_TOKEN: "), "{message}");
        let message = try_top_up(&mut t, "alice.test", to_void, 1).unwrap_err();
        assert!(message.starts_with("E_TOKEN: "), "{message}");
        assert_eq!(fund(&mut t, USDC, "alice.test", 7), 7);

        // ...but nothing already inside is stuck. A balance can be withdrawn...
        assert_eq!(
            withdraw(&mut t, "alice.test", 1_000),
            vec![transfer(USDC, "alice.test", 1_000)]
        );
        assert_eq!(
            withdraw(&mut t, "bob.test", 400),
            vec![transfer(USDC, "bob.test", 400)]
        );
        // ...a task in the token can still be picked, and its fee reaches the treasury...
        pick(&mut t, to_pick, &[("bob.test", 10_000)]);
        assert_eq!(balance(&t, USDC, "bob.test"), 950_000);
        assert_eq!(balance(&t, USDC, TREASURY), 50_000);
        // ...or voided, which refunds the poster in full...
        void(&mut t, KEEPER, to_void);
        assert_eq!(
            balance(&t, USDC, "alice.test"),
            FUNDS - 2 * REWARD - 1_000 + REWARD
        );
        // ...the treasury can take its fee out...
        assert_eq!(
            withdraw(&mut t, TREASURY, 50_000),
            vec![transfer(USDC, TREASURY, 50_000)]
        );
        // ...and the vault view still lists the token, so a client sees what it can withdraw.
        assert_eq!(
            t.balances_of(acct("bob.test")),
            vec![token_balance(USDC, 950_000)]
        );

        // Enabling it again lets deposits and new tasks back in.
        as_owner(&mut t, |t| {
            t.set_token(acct(USDC), U128(MIN_REWARD), U128(MAX_REWARD), true)
        });
        assert_eq!(fund(&mut t, USDC, "alice.test", 7), 0);
        assert_eq!(try_post(&mut t, args()), Ok(3));
    }

    // The config view.

    #[test]
    fn config_lists_tokens() {
        let mut t = fresh();
        register(&mut t, OWNER, NearToken::from_near(1));
        assert!(t.get_config().tokens.is_empty());

        as_owner(&mut t, |t| {
            t.set_token(acct(USDC), U128(MIN_REWARD), U128(MAX_REWARD), true)
        });
        as_owner(&mut t, |t| {
            t.set_token(acct(DAI), U128(1), U128(1_000), false)
        });
        as_owner(&mut t, |t| {
            t.set_token(acct("wnear.test"), U128(1), U128(u128::MAX / 10_000), true)
        });
        // Setting a token again changes it where it stands. It is not listed twice or moved.
        as_owner(&mut t, |t| {
            t.set_token(acct(USDC), U128(20), U128(40_000_000), false)
        });

        let tokens = serde_json::to_value(t.get_config().tokens).unwrap();
        assert_eq!(
            tokens,
            json!([
                {
                    "token": "usdc.test",
                    "min_reward": "20",
                    "max_reward": "40000000",
                    "enabled": false
                },
                {"token": "dai.test", "min_reward": "1", "max_reward": "1000", "enabled": false},
                {
                    "token": "wnear.test",
                    "min_reward": "1",
                    "max_reward": (u128::MAX / 10_000).to_string(),
                    "enabled": true
                },
            ])
        );

        // The rest of the config follows the setters, and the whole view keeps its wire form.
        as_owner(&mut t, |t| t.set_fee(750, acct(NEW_TREASURY)));
        as_owner(&mut t, |t| t.set_min_window(90));
        as_owner(&mut t, |t| t.set_paused(true));
        as_owner(&mut t, |t| t.propose_owner(acct("alice.test")));
        let mut expected = json!({
            "owner": "owner.test",
            "pending_owner": "alice.test",
            "treasury": "new-treasury.test",
            "fee_bps": 750,
            "min_window_secs": 90,
            "max_window_secs": 1_209_600,
            "paused": true,
            "version": 1,
            "tokens": tokens,
            "agent_bond_token": null,
            "agent_bond_amount": null,
            "agent_bond_cooldown_secs": "1209600",
        });
        assert_eq!(serde_json::to_value(t.get_config()).unwrap(), expected);
        // The bond's amount and the cooldown are decimal strings.
        as_owner(&mut t, |t| {
            t.set_token(acct("wnear.test"), U128(1), U128(1_000), true)
        });
        as_owner(&mut t, |t| {
            t.set_agent_bond(acct("wnear.test"), U128(u128::MAX))
        });
        as_owner(&mut t, |t| t.set_agent_bond_cooldown(U64(4_838_400)));
        expected["tokens"][2]["max_reward"] = json!("1000");
        expected["agent_bond_token"] = json!("wnear.test");
        expected["agent_bond_amount"] = json!(u128::MAX.to_string());
        expected["agent_bond_cooldown_secs"] = json!("4838400");
        assert_eq!(serde_json::to_value(t.get_config()).unwrap(), expected);
    }

    // Upgrades.

    /// Writes `t` to contract storage, as the generated wrapper does after a call.
    fn save(t: &mut Tender) {
        t.flush_all();
        env::state_write(&*t);
    }

    #[test]
    fn migrate_keeps_a_version_one_state() {
        let mut t = world();
        let id = post(&mut t, args());
        enter(&mut t, "bob.test", id, 1);
        as_owner(&mut t, |t| t.set_fee(700, acct(NEW_TREASURY)));
        as_owner(&mut t, |t| t.set_min_window(120));
        as_owner(&mut t, |t| t.set_paused(true));
        as_owner(&mut t, |t| t.propose_owner(acct("alice.test")));

        // The state as it is stored, and as the views show it.
        testing_env!(ctx("tender.test").block_timestamp(T1).build());
        save(&mut t);
        let config = config_json(&t);
        let task = t.get_task(U64(id)).expect("the task exists");
        let alice = balance(&t, USDC, "alice.test");
        drop(t);

        // `migrate` is private, so the contract calls it itself.
        testing_env!(ctx("tender.test").block_timestamp(T1).build());
        let migrated = Tender::migrate();
        assert_eq!(config_json(&migrated), config);
        assert_eq!(migrated.get_config().version, 1);
        assert_eq!(migrated.get_task(U64(id)), Some(task));
        assert_eq!(migrated.task_count(), U64(1));
        assert_eq!(balance(&migrated, USDC, "alice.test"), alice);
        assert_eq!(
            migrated
                .get_entry(U64(id), acct("bob.test"))
                .map(|e| e.index),
            Some(0)
        );
    }

    #[test]
    fn migrate_rejects_other_versions() {
        let mut t = fresh();
        for version in [0, 2, u16::MAX] {
            t.version = version;
            testing_env!(ctx("tender.test").build());
            save(&mut t);
            let message = panic_message(|| {
                let _ = Tender::migrate();
            })
            .expect("migrate refuses the state");
            assert_eq!(
                message,
                format!(
                    "{}: cannot migrate state version {version}; this build migrates version 1",
                    err::E_VERSION
                )
            );
        }
        // The version this build expects goes through.
        t.version = 1;
        testing_env!(ctx("tender.test").build());
        save(&mut t);
        assert_eq!(Tender::migrate().get_config().version, 1);
    }

    #[test]
    fn migrate_without_state_is_not_found() {
        testing_env!(ctx("tender.test").build());
        let message = panic_message(|| {
            let _ = Tender::migrate();
        })
        .expect("there is no state to migrate");
        assert_eq!(message, "E_NOT_FOUND: no contract state");
    }
}
