//! Posting tasks, the task views, and the phase a task is in.
//!
//! A poster escrows a reward from its vault into a task with four consecutive windows: commit,
//! reveal, pick and fallback. Each window is half-open, `[start, end)`, and the phase is derived
//! from the block time and the outcome on every read, never stored, so no transaction is needed
//! to move a task along. Task ids run from 1 with no gaps, so the views page through them by id.

use near_sdk::json_types::{U128, U64};
use near_sdk::{env, near, AccountId};

use crate::events::{emit, TaskCreated};
use crate::types::{
    check_uri, err, hex32, parse_hash, FunderView, Outcome, OutcomeView, PayoutView, Phase,
    PostTaskArgs, Task, TaskView, MAX_INVITED, MAX_PAGE, MAX_WINDOW_SECS, MAX_WINNERS,
    OUTCOME_RESERVE_BYTES,
};
use crate::{Tender, TenderExt};

const NS_PER_SEC: u64 = 1_000_000_000;

/// The phase of `t` at `now` (nanoseconds).
///
/// A task with an outcome is `Settled`, whatever the time. Otherwise each window runs from one
/// deadline up to, but not including, the next: `Open` before `commit_deadline`, then
/// `Revealing`, `Judging` and `Fallback`, and `Expired` from `fallback_deadline` on.
pub(crate) fn phase(t: &Task, now: u64) -> Phase {
    if t.outcome.is_some() {
        Phase::Settled
    } else if now < t.commit_deadline {
        Phase::Open
    } else if now < t.reveal_deadline {
        Phase::Revealing
    } else if now < t.pick_deadline {
        Phase::Judging
    } else if now < t.fallback_deadline {
        Phase::Fallback
    } else {
        Phase::Expired
    }
}

/// The end of a window of `secs` seconds that starts at `start` (nanoseconds). The window caps
/// keep every deadline far below `u64::MAX`; the arithmetic is checked anyway (`E_WINDOW`) so it
/// can never wrap.
fn window_end(start: u64, secs: u32) -> u64 {
    u64::from(secs)
        .checked_mul(NS_PER_SEC)
        .and_then(|ns| start.checked_add(ns))
        .unwrap_or_else(|| {
            env::panic_str(&format!(
                "{}: a deadline would pass the largest timestamp",
                err::E_WINDOW
            ))
        })
}

/// Panics `E_INVITE` if `invited` names more than `MAX_INVITED` accounts, names one twice, or
/// names the poster or the verifier, who cannot enter their own task.
fn check_invited(invited: &[AccountId], poster: &AccountId, verifier: &AccountId) {
    if invited.len() > MAX_INVITED {
        env::panic_str(&format!(
            "{}: at most {MAX_INVITED} invited accounts, got {}",
            err::E_INVITE,
            invited.len()
        ));
    }
    // At most 20 accounts, so the quadratic duplicate check is at most 190 comparisons.
    for (i, account) in invited.iter().enumerate() {
        if account == poster {
            env::panic_str(&format!(
                "{}: the poster {account} cannot be invited",
                err::E_INVITE
            ));
        }
        if account == verifier {
            env::panic_str(&format!(
                "{}: the verifier {account} cannot be invited",
                err::E_INVITE
            ));
        }
        if invited[..i].contains(account) {
            env::panic_str(&format!("{}: {account} is invited twice", err::E_INVITE));
        }
    }
}

impl From<&Outcome> for OutcomeView {
    fn from(o: &Outcome) -> Self {
        match o {
            Outcome::Picked {
                winners,
                fee,
                scorecard_hash,
                scorecard_uri,
            } => OutcomeView::Picked {
                winners: winners
                    .iter()
                    .map(|p| PayoutView {
                        account: p.account.clone(),
                        bps: p.bps,
                        amount: U128(p.amount),
                    })
                    .collect(),
                fee: U128(*fee),
                scorecard_hash: hex32(scorecard_hash),
                scorecard_uri: scorecard_uri.clone(),
            },
            Outcome::Voided {
                reason,
                scorecard_hash,
                scorecard_uri,
            } => OutcomeView::Voided {
                reason: *reason,
                scorecard_hash: scorecard_hash.as_ref().map(hex32),
                scorecard_uri: scorecard_uri.clone(),
            },
        }
    }
}

impl Task {
    /// This task as the views show it, in the phase it is in at `now`.
    fn view(&self, now: u64) -> TaskView {
        // No `..`: a field added to `Task` is a compile error here until the view shows it.
        let Task {
            id,
            poster,
            token,
            reward,
            fee_bps,
            brief_uri,
            brief_hash,
            criteria_hash,
            heldout_commitment,
            verifier,
            created_at,
            commit_deadline,
            reveal_deadline,
            pick_deadline,
            fallback_deadline,
            max_entries,
            max_winners,
            invited,
            parent,
            commit_count,
            reveal_count,
            cleaned,
            funders,
            outcome,
        } = self;
        TaskView {
            id: U64(*id),
            poster: poster.clone(),
            token: token.clone(),
            reward: U128(*reward),
            fee_bps: *fee_bps,
            brief_uri: brief_uri.clone(),
            brief_hash: hex32(brief_hash),
            criteria_hash: hex32(criteria_hash),
            heldout_commitment: heldout_commitment.as_ref().map(hex32),
            verifier: verifier.clone(),
            created_at: U64(*created_at),
            commit_deadline: U64(*commit_deadline),
            reveal_deadline: U64(*reveal_deadline),
            pick_deadline: U64(*pick_deadline),
            fallback_deadline: U64(*fallback_deadline),
            max_entries: *max_entries,
            max_winners: *max_winners,
            invited: invited.clone(),
            parent: parent.map(U64),
            commit_count: *commit_count,
            reveal_count: *reveal_count,
            cleaned: *cleaned,
            funders: funders
                .iter()
                .map(|(account, amount)| FunderView {
                    account: account.clone(),
                    amount: U128(*amount),
                })
                .collect(),
            outcome: outcome.as_ref().map(OutcomeView::from),
            phase: phase(self, now),
        }
    }
}

#[near]
impl Tender {
    /// Posts a task, moving `reward` of `token` from the caller's vault into its escrow, and
    /// returns its id. Called as `{"task": {...}}` with exactly 1 yoctoNEAR attached.
    ///
    /// The rules, checked in this order, each with its error code:
    /// - posting is not paused (`E_PAUSED`);
    /// - `token` is allowlisted and enabled (`E_TOKEN`);
    /// - `reward` is within the token's `min_reward..=max_reward` (`E_REWARD`);
    /// - `brief_uri` is 1 to 256 bytes (`E_URI`);
    /// - `brief_hash`, `criteria_hash` and any `heldout_commitment` are 64 lowercase hex
    ///   characters (`E_HASH`);
    /// - each window is `min_window_secs..=MAX_WINDOW_SECS` seconds (`E_WINDOW`);
    /// - `max_winners` is 1 to 5 (`E_WINNERS`);
    /// - `invited` has at most 20 accounts, none twice, and neither the poster nor the verifier
    ///   (`E_INVITE`);
    /// - a non-zero `max_entries` comes with a non-empty `invited` (`E_LIMIT`);
    /// - `parent` is `None`, since lineage is not enabled yet (`E_PARENT`);
    /// - the spend is authorised: 1 yoctoNEAR attached (`E_AUTH`);
    /// - the caller's vault holds `reward` (`E_FUNDS`).
    ///
    /// The caller is the predecessor, never the signer. It is the poster, the only funder, and
    /// the verifier unless `verifier` names another account. The deadlines follow one another
    /// from the block time, and the task keeps the protocol fee in force when it is posted. The
    /// poster's storage balance pays for the task record and reserves `OUTCOME_RESERVE_BYTES` for
    /// its outcome (`E_STORAGE` if it cannot), so settling the task never needs new storage.
    /// Emits `task_created` once everything has passed.
    #[payable]
    pub fn post_task(&mut self, task: PostTaskArgs) -> U64 {
        let poster = env::predecessor_account_id();
        if self.paused {
            env::panic_str(&format!("{}: posting new tasks is paused", err::E_PAUSED));
        }
        let reward = task.reward.0;
        self.check_reward(&task.token, reward);
        check_uri("brief_uri", &task.brief_uri);
        let brief_hash = parse_hash(&task.brief_hash);
        let criteria_hash = parse_hash(&task.criteria_hash);
        let heldout_commitment = task.heldout_commitment.as_deref().map(parse_hash);
        for (name, secs) in [
            ("commit_secs", task.commit_secs),
            ("reveal_secs", task.reveal_secs),
            ("pick_secs", task.pick_secs),
            ("fallback_secs", task.fallback_secs),
        ] {
            self.check_window(name, secs);
        }
        let now = env::block_timestamp();
        let commit_deadline = window_end(now, task.commit_secs);
        let reveal_deadline = window_end(commit_deadline, task.reveal_secs);
        let pick_deadline = window_end(reveal_deadline, task.pick_secs);
        let fallback_deadline = window_end(pick_deadline, task.fallback_secs);
        if !(1..=MAX_WINNERS).contains(&task.max_winners) {
            env::panic_str(&format!(
                "{}: max_winners must be 1 to {MAX_WINNERS}, got {}",
                err::E_WINNERS,
                task.max_winners
            ));
        }
        let verifier = task.verifier.unwrap_or_else(|| poster.clone());
        check_invited(&task.invited, &poster, &verifier);
        if task.max_entries > 0 && task.invited.is_empty() {
            env::panic_str(&format!(
                "{}: max_entries {} needs a non-empty invited list",
                err::E_LIMIT,
                task.max_entries
            ));
        }
        if task.parent.is_some() {
            env::panic_str(&format!("{}: lineage not enabled", err::E_PARENT));
        }

        // Everything above only reads. The mark comes before the first write, so the storage
        // this call adds is measured from here.
        let before = self.storage_mark();
        self.authorize_spend(&poster, &task.token, reward);
        self.debit(&poster, &task.token, reward);
        let id = self.next_task_id;
        self.next_task_id += 1;
        let record = Task {
            id,
            poster: poster.clone(),
            token: task.token,
            reward,
            fee_bps: self.fee_bps,
            brief_uri: task.brief_uri,
            brief_hash,
            criteria_hash,
            heldout_commitment,
            verifier,
            created_at: now,
            commit_deadline,
            reveal_deadline,
            pick_deadline,
            fallback_deadline,
            max_entries: task.max_entries,
            max_winners: task.max_winners,
            invited: task.invited,
            parent: task.parent.map(|p| p.0),
            commit_count: 0,
            reveal_count: 0,
            cleaned: 0,
            funders: vec![(poster.clone(), reward)],
            outcome: None,
        };
        let created = TaskCreated::from(record.view(now));
        self.tasks.insert(id, record);
        self.settle_storage(&poster, before);
        self.reserve_bytes(&poster, OUTCOME_RESERVE_BYTES);
        emit("task_created", &created);
        U64(id)
    }

    /// The task with id `task_id`, in the phase it is in at the block time of the call, or `None`
    /// if there is no such task.
    pub fn get_task(&self, task_id: U64) -> Option<TaskView> {
        self.tasks
            .get(&task_id.0)
            .map(|t| t.view(env::block_timestamp()))
    }

    /// Up to `limit` tasks in ascending id order, starting at `from_id` (or at 1 if `from_id` is
    /// 0). `limit` is clamped to 1..=50. The page stops at the last task, so a `from_id` past it
    /// gives an empty page.
    pub fn get_tasks(&self, from_id: U64, limit: u32) -> Vec<TaskView> {
        let now = env::block_timestamp();
        let start = from_id.0.max(1);
        let end = start
            .saturating_add(u64::from(limit.clamp(1, MAX_PAGE)))
            .min(self.next_task_id);
        (start..end)
            .filter_map(|id| self.tasks.get(&id))
            .map(|t| t.view(now))
            .collect()
    }

    /// How many tasks have been posted. Their ids are 1 to this number.
    pub fn task_count(&self) -> U64 {
        U64(self.next_task_id - 1)
    }
}

impl Tender {
    /// Panics `E_TOKEN` unless `token` is allowlisted and enabled, then `E_REWARD` unless
    /// `reward` is within its limits.
    fn check_reward(&self, token: &AccountId, reward: u128) {
        let Some(limits) = self.tokens.get(token).filter(|c| c.enabled) else {
            env::panic_str(&format!(
                "{}: {token} is not an enabled token",
                err::E_TOKEN
            ));
        };
        if !(limits.min_reward..=limits.max_reward).contains(&reward) {
            env::panic_str(&format!(
                "{}: reward {reward} must be {} to {}",
                err::E_REWARD,
                limits.min_reward,
                limits.max_reward
            ));
        }
    }

    /// Panics `E_WINDOW` unless the window `name` of `secs` seconds is `min_window_secs` to
    /// `MAX_WINDOW_SECS`.
    fn check_window(&self, name: &str, secs: u32) {
        if !(self.min_window_secs..=MAX_WINDOW_SECS).contains(&secs) {
            env::panic_str(&format!(
                "{}: {name} must be {} to {MAX_WINDOW_SECS}, got {secs}",
                err::E_WINDOW,
                self.min_window_secs
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
    use near_sdk::json_types::{U128, U64};
    use near_sdk::serde_json::{self, Value};
    use near_sdk::test_utils::get_logs;
    use near_sdk::{borsh, env, testing_env, AccountId, NearToken};

    use super::phase;
    use crate::test_utils::{ctx, fresh, panic_message};
    use crate::types::{
        parse_hash, FunderView, Outcome, OutcomeView, Payout, PayoutView, Phase, PostTaskArgs,
        TaskView, TokenConfig, VoidReason, MAX_INVITED, MAX_URI_BYTES, MAX_WINDOW_SECS,
        MAX_WINNERS, OUTCOME_RESERVE_BYTES,
    };
    use crate::Tender;

    const USDC: &str = "usdc.test";
    const BRIEF_URI: &str = "https://api.tender.example/v1/blobs/b94d27b9";
    /// sha256("hello world").
    const BRIEF_HASH: &str = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";
    /// sha256("foo").
    const CRITERIA_HASH: &str = "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae";
    /// sha256("bar").
    const HELDOUT_HASH: &str = "fcde2b2edba56bf408601fb721fe9b5c338d10ee429ea04fae5511b68fbf8fb9";
    const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
    const NO_DEPOSIT: NearToken = NearToken::from_yoctonear(0);
    /// The USDC reward limits: 10 units to 50 USDC.
    const MIN_REWARD: u128 = 10;
    const MAX_REWARD: u128 = 50_000_000;
    /// The reward of the default task: 1 USDC.
    const REWARD: u128 = 1_000_000;
    /// What alice holds in her vault at the start: 100 USDC.
    const FUNDS: u128 = 100_000_000;
    /// A block time above 2^53 nanoseconds, which a JSON number could not carry.
    const T1: u64 = 1_793_028_278_935_742_660;
    const SEC: u64 = 1_000_000_000;
    const AUTH_MESSAGE: &str =
        "E_AUTH: attach exactly 1 yoctoNEAR or use a delegate key within caps";

    fn acct(id: &str) -> AccountId {
        id.parse().unwrap()
    }

    fn accounts(ids: &[&str]) -> Vec<AccountId> {
        ids.iter().map(|id| acct(id)).collect()
    }

    fn byte_cost() -> u128 {
        env::storage_byte_cost().as_yoctonear()
    }

    fn usdc(enabled: bool) -> TokenConfig {
        TokenConfig {
            min_reward: MIN_REWARD,
            max_reward: MAX_REWARD,
            enabled,
        }
    }

    /// A task that meets every rule: 1 USDC, windows of 60, 120, 180 and 240 seconds, open to
    /// anyone, one winner, and the poster as verifier.
    fn args() -> PostTaskArgs {
        PostTaskArgs {
            token: acct(USDC),
            reward: U128(REWARD),
            brief_uri: BRIEF_URI.to_string(),
            brief_hash: BRIEF_HASH.to_string(),
            criteria_hash: CRITERIA_HASH.to_string(),
            heldout_commitment: None,
            verifier: None,
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

    /// The arguments the task in `v` was posted with, read back from the view. The verifier comes
    /// back named, even if it was posted as `None`.
    fn args_of(v: &TaskView) -> PostTaskArgs {
        let secs = |from: U64, to: U64| u32::try_from((to.0 - from.0) / SEC).unwrap();
        PostTaskArgs {
            token: v.token.clone(),
            reward: v.reward,
            brief_uri: v.brief_uri.clone(),
            brief_hash: v.brief_hash.clone(),
            criteria_hash: v.criteria_hash.clone(),
            heldout_commitment: v.heldout_commitment.clone(),
            verifier: Some(v.verifier.clone()),
            commit_secs: secs(v.created_at, v.commit_deadline),
            reveal_secs: secs(v.commit_deadline, v.reveal_deadline),
            pick_secs: secs(v.reveal_deadline, v.pick_deadline),
            fallback_secs: secs(v.pick_deadline, v.fallback_deadline),
            max_entries: v.max_entries,
            max_winners: v.max_winners,
            invited: v.invited.clone(),
            parent: v.parent,
        }
    }

    /// Adds `deposit` to `who`'s storage balance, registering it if need be.
    fn register(t: &mut Tender, who: &str, deposit: NearToken) {
        testing_env!(ctx(who).attached_deposit(deposit).build());
        t.storage_deposit(None);
    }

    /// `who` deposits `amount` of USDC, as the token reports it to `ft_on_transfer`.
    fn fund(t: &mut Tender, who: &str, amount: u128) {
        testing_env!(ctx(USDC).build());
        let _ = t.ft_on_transfer(acct(who), U128(amount), String::new());
    }

    /// A contract with USDC enabled, and alice with 1 NEAR of storage and `FUNDS` in her vault.
    fn world() -> Tender {
        let mut t = fresh();
        t.put_token(acct(USDC), usdc(true));
        register(&mut t, "alice.test", NearToken::from_near(1));
        fund(&mut t, "alice.test", FUNDS);
        t
    }

    /// alice posts `task` at block time `now`, attaching 1 yoctoNEAR. Returns the new id.
    fn post_at(t: &mut Tender, now: u64, task: PostTaskArgs) -> u64 {
        testing_env!(ctx("alice.test")
            .attached_deposit(ONE_YOCTO)
            .block_timestamp(now)
            .build());
        t.post_task(task).0
    }

    fn post(t: &mut Tender, task: PostTaskArgs) -> u64 {
        post_at(t, T1, task)
    }

    /// `who` posts `task` at block time `now`, attaching `deposit`. `Err` holds the message the
    /// contract panicked with.
    fn try_post_at(
        t: &mut Tender,
        who: &str,
        deposit: NearToken,
        now: u64,
        task: PostTaskArgs,
    ) -> Result<u64, String> {
        testing_env!(ctx(who)
            .attached_deposit(deposit)
            .block_timestamp(now)
            .build());
        let mut id = None;
        match panic_message(|| id = Some(t.post_task(task).0)) {
            Some(message) => Err(message),
            None => Ok(id.expect("post_task returned")),
        }
    }

    fn try_post(
        t: &mut Tender,
        who: &str,
        deposit: NearToken,
        task: PostTaskArgs,
    ) -> Result<u64, String> {
        try_post_at(t, who, deposit, T1, task)
    }

    /// Asserts that `who` posting `task` with `deposit` attached is rejected with `code`, and
    /// that the rejection logged nothing. Returns the message.
    fn assert_rejected(
        t: &mut Tender,
        what: &str,
        code: &str,
        who: &str,
        deposit: NearToken,
        task: PostTaskArgs,
    ) -> String {
        let result = try_post(t, who, deposit, task);
        let message = result.expect_err(&format!("{what}: expected {code}, but it posted"));
        assert!(
            message.starts_with(&format!("{code}: ")),
            "{what}: expected {code}, got {message:?}"
        );
        // A failed receipt keeps its logs (spec 6.9), so the event must come after the last check.
        assert!(get_logs().is_empty(), "{what}: a rejection logs nothing");
        message
    }

    fn balance(t: &Tender, who: &str) -> u128 {
        t.balance_of(acct(who), acct(USDC)).0
    }

    fn used(t: &Tender, who: &str) -> u64 {
        t.storage_balance_of(acct(who))
            .expect("has a storage balance")
            .used_bytes
            .0
    }

    /// Spends `who`'s storage balance down to exactly `bytes` to spare.
    fn leave_spare(t: &mut Tender, who: &str, bytes: u64) {
        let who = acct(who);
        let spare = u64::try_from(t.storage_available(&who) / byte_cost()).unwrap();
        t.reserve_bytes(&who, spare - bytes);
        assert_eq!(t.storage_available(&who), u128::from(bytes) * byte_cost());
    }

    fn view(t: &Tender, id: u64) -> TaskView {
        t.get_task(U64(id)).expect("the task exists")
    }

    fn ids(views: &[TaskView]) -> Vec<u64> {
        views.iter().map(|v| v.id.0).collect()
    }

    fn funded_by(account: &str, amount: u128) -> Vec<FunderView> {
        vec![FunderView {
            account: acct(account),
            amount: U128(amount),
        }]
    }

    // Posting.

    #[test]
    fn post_escrows_reward_and_returns_id() {
        let mut t = world();
        assert_eq!(t.task_count(), U64(0));
        assert_eq!(post(&mut t, args()), 1);
        assert_eq!(balance(&t, "alice.test"), FUNDS - REWARD);
        let bigger = PostTaskArgs {
            reward: U128(3 * REWARD),
            ..args()
        };
        assert_eq!(post(&mut t, bigger), 2);
        assert_eq!(balance(&t, "alice.test"), FUNDS - 4 * REWARD);
        assert_eq!(t.task_count(), U64(2));

        // Each task holds its own escrow, and records who paid it.
        let (first, second) = (view(&t, 1), view(&t, 2));
        assert_eq!((first.id, first.reward), (U64(1), U128(REWARD)));
        assert_eq!((second.id, second.reward), (U64(2), U128(3 * REWARD)));
        assert_eq!(first.poster, acct("alice.test"));
        assert_eq!(first.funders, funded_by("alice.test", REWARD));
        assert_eq!(second.funders, funded_by("alice.test", 3 * REWARD));
        // The task is stored as it was posted.
        assert_eq!(
            args_of(&first),
            PostTaskArgs {
                verifier: Some(acct("alice.test")),
                ..args()
            }
        );
        // Nothing has happened to it yet.
        assert_eq!(
            (first.commit_count, first.reveal_count, first.cleaned),
            (0, 0, 0)
        );
        assert_eq!(first.outcome, None);
        assert_eq!(first.phase, Phase::Open);
    }

    #[test]
    fn deadlines_from_secs() {
        let mut t = world();
        // Windows of 60, 120, 180 and 240 seconds, each starting where the one before ends.
        let id = post_at(&mut t, 1_000, args());
        let v = view(&t, id);
        assert_eq!(v.created_at, U64(1_000));
        assert_eq!(v.commit_deadline, U64(1_000 + 60_000_000_000));
        assert_eq!(v.reveal_deadline, U64(1_000 + 180_000_000_000));
        assert_eq!(v.pick_deadline, U64(1_000 + 360_000_000_000));
        assert_eq!(v.fallback_deadline, U64(1_000 + 600_000_000_000));

        // The longest windows, from a block time above 2^53, are exact too.
        let longest = PostTaskArgs {
            commit_secs: MAX_WINDOW_SECS,
            reveal_secs: MAX_WINDOW_SECS,
            pick_secs: MAX_WINDOW_SECS,
            fallback_secs: MAX_WINDOW_SECS,
            ..args()
        };
        let id = post_at(&mut t, T1, longest);
        let v = view(&t, id);
        let window = u64::from(MAX_WINDOW_SECS) * SEC;
        assert_eq!(v.created_at, U64(T1));
        assert_eq!(
            [
                v.commit_deadline,
                v.reveal_deadline,
                v.pick_deadline,
                v.fallback_deadline
            ]
            .map(|d| d.0),
            [
                T1 + window,
                T1 + 2 * window,
                T1 + 3 * window,
                T1 + 4 * window
            ]
        );
    }

    #[test]
    fn a_deadline_past_u64_max_is_rejected_not_wrapped() {
        // Out of reach on a real chain: block time is far below u64::MAX and the windows are
        // capped. The sums are checked anyway, so they can never wrap.
        let mut t = world();
        for (what, now) in [
            ("the commit deadline", u64::MAX - 59 * SEC),
            ("a later deadline", u64::MAX - 100 * SEC),
        ] {
            let result = try_post_at(&mut t, "alice.test", ONE_YOCTO, now, args());
            assert!(
                result.as_ref().is_err_and(|m| m.starts_with("E_WINDOW: ")),
                "{what}: {result:?}"
            );
            assert!(get_logs().is_empty(), "{what}");
        }
        assert_eq!(t.task_count(), U64(0));
        assert_eq!(balance(&t, "alice.test"), FUNDS);
    }

    #[test]
    fn verifier_defaults_to_poster() {
        let mut t = world();
        let own = post(&mut t, args());
        assert_eq!(view(&t, own).verifier, acct("alice.test"));
        let judged = post(
            &mut t,
            PostTaskArgs {
                verifier: Some(acct("judge.test")),
                ..args()
            },
        );
        assert_eq!(view(&t, judged).verifier, acct("judge.test"));
        // Naming herself is the same as leaving it out.
        let named = post(
            &mut t,
            PostTaskArgs {
                verifier: Some(acct("alice.test")),
                ..args()
            },
        );
        assert_eq!(view(&t, named).verifier, acct("alice.test"));
    }

    #[test]
    fn fee_bps_is_snapshotted() {
        let mut t = world();
        let id = post(&mut t, args());
        assert_eq!(view(&t, id).fee_bps, 500);
        // `set_fee` arrives with the admin methods; until then the test sets the field itself.
        t.fee_bps = 900;
        assert_eq!(view(&t, id).fee_bps, 500, "a posted task keeps its fee");
        let later = post(&mut t, args());
        assert_eq!(
            view(&t, later).fee_bps,
            900,
            "a new task takes the current fee"
        );
    }

    #[test]
    fn invited_cannot_include_poster_or_verifier() {
        let mut t = world();
        let task = |verifier: Option<&str>, invited: &[&str]| PostTaskArgs {
            verifier: verifier.map(acct),
            invited: accounts(invited),
            ..args()
        };
        for (what, task) in [
            (
                "the poster, who is also the default verifier",
                task(None, &["bob.test", "alice.test"]),
            ),
            (
                "the poster, with someone else as verifier",
                task(Some("judge.test"), &["alice.test"]),
            ),
            (
                "the verifier",
                task(Some("judge.test"), &["bob.test", "judge.test"]),
            ),
            (
                "the poster, named as verifier",
                task(Some("alice.test"), &["alice.test"]),
            ),
        ] {
            assert_rejected(&mut t, what, "E_INVITE", "alice.test", ONE_YOCTO, task);
        }
        assert_eq!(t.task_count(), U64(0));
        assert_eq!(balance(&t, "alice.test"), FUNDS);

        // Anyone else can be invited.
        let id = post(
            &mut t,
            task(Some("judge.test"), &["bob.test", "carol.test"]),
        );
        assert_eq!(view(&t, id).invited, accounts(&["bob.test", "carol.test"]));
    }

    #[test]
    fn max_entries_requires_invited() {
        let mut t = world();
        let capped = PostTaskArgs {
            max_entries: 3,
            ..args()
        };
        assert_rejected(
            &mut t,
            "a cap on a task open to anyone",
            "E_LIMIT",
            "alice.test",
            ONE_YOCTO,
            capped,
        );
        // Open and unlimited is fine...
        let open = post(&mut t, args());
        assert_eq!(view(&t, open).max_entries, 0);
        // ...and so is a cap on an invited list, even one below the list's length.
        let pinned = post(
            &mut t,
            PostTaskArgs {
                max_entries: 1,
                invited: accounts(&["bob.test", "carol.test"]),
                ..args()
            },
        );
        let v = view(&t, pinned);
        assert_eq!((v.max_entries, v.invited.len()), (1, 2));
    }

    #[test]
    fn rejects_each_rule() {
        let mut t = world();
        // bob holds one unit less than the default reward; carol has no vault slot at all.
        register(&mut t, "bob.test", NearToken::from_millinear(100));
        fund(&mut t, "bob.test", REWARD - 1);
        let alice_used = used(&t, "alice.test");
        let as_alice = |t: &mut Tender, what: &str, code: &str, task: PostTaskArgs| {
            assert_rejected(t, what, code, "alice.test", ONE_YOCTO, task)
        };

        t.paused = true;
        as_alice(&mut t, "while paused", "E_PAUSED", args());
        t.paused = false;

        let dai = PostTaskArgs {
            token: acct("dai.test"),
            ..args()
        };
        as_alice(&mut t, "a token that is not allowlisted", "E_TOKEN", dai);
        t.put_token(acct(USDC), usdc(false));
        as_alice(&mut t, "a disabled token", "E_TOKEN", args());
        t.put_token(acct(USDC), usdc(true));

        let twenty_one = (0..=MAX_INVITED)
            .map(|i| acct(&format!("agent{i}.test")))
            .collect();
        let cases = [
            (
                "a reward below the minimum",
                "E_REWARD",
                PostTaskArgs {
                    reward: U128(MIN_REWARD - 1),
                    ..args()
                },
            ),
            (
                "a reward above the maximum",
                "E_REWARD",
                PostTaskArgs {
                    reward: U128(MAX_REWARD + 1),
                    ..args()
                },
            ),
            (
                "an empty brief_uri",
                "E_URI",
                PostTaskArgs {
                    brief_uri: String::new(),
                    ..args()
                },
            ),
            (
                "a 257-byte brief_uri",
                "E_URI",
                PostTaskArgs {
                    brief_uri: "u".repeat(MAX_URI_BYTES + 1),
                    ..args()
                },
            ),
            (
                "an uppercase brief_hash",
                "E_HASH",
                PostTaskArgs {
                    brief_hash: BRIEF_HASH.to_uppercase(),
                    ..args()
                },
            ),
            (
                "a 63-character criteria_hash",
                "E_HASH",
                PostTaskArgs {
                    criteria_hash: CRITERIA_HASH[..63].to_string(),
                    ..args()
                },
            ),
            (
                "a heldout_commitment that is not hex",
                "E_HASH",
                PostTaskArgs {
                    heldout_commitment: Some(format!("g{}", &HELDOUT_HASH[1..])),
                    ..args()
                },
            ),
            (
                "a commit window below the minimum",
                "E_WINDOW",
                PostTaskArgs {
                    commit_secs: 59,
                    ..args()
                },
            ),
            (
                "a reveal window above the maximum",
                "E_WINDOW",
                PostTaskArgs {
                    reveal_secs: MAX_WINDOW_SECS + 1,
                    ..args()
                },
            ),
            (
                "a zero pick window",
                "E_WINDOW",
                PostTaskArgs {
                    pick_secs: 0,
                    ..args()
                },
            ),
            (
                "a fallback window of u32::MAX seconds",
                "E_WINDOW",
                PostTaskArgs {
                    fallback_secs: u32::MAX,
                    ..args()
                },
            ),
            (
                "no winners",
                "E_WINNERS",
                PostTaskArgs {
                    max_winners: 0,
                    ..args()
                },
            ),
            (
                "six winners",
                "E_WINNERS",
                PostTaskArgs {
                    max_winners: MAX_WINNERS + 1,
                    ..args()
                },
            ),
            (
                "21 invited accounts",
                "E_INVITE",
                PostTaskArgs {
                    invited: twenty_one,
                    ..args()
                },
            ),
            (
                "an account invited twice",
                "E_INVITE",
                PostTaskArgs {
                    invited: accounts(&["bob.test", "carol.test", "bob.test"]),
                    ..args()
                },
            ),
            (
                "the poster invited",
                "E_INVITE",
                PostTaskArgs {
                    invited: accounts(&["alice.test"]),
                    ..args()
                },
            ),
            (
                "the verifier invited",
                "E_INVITE",
                PostTaskArgs {
                    verifier: Some(acct("judge.test")),
                    invited: accounts(&["judge.test"]),
                    ..args()
                },
            ),
            (
                "a cap on a task open to anyone",
                "E_LIMIT",
                PostTaskArgs {
                    max_entries: 2,
                    ..args()
                },
            ),
        ];
        for (what, code, task) in cases {
            as_alice(&mut t, what, code, task);
        }
        let parent = PostTaskArgs {
            parent: Some(U64(1)),
            ..args()
        };
        assert_eq!(
            as_alice(&mut t, "a parent", "E_PARENT", parent),
            "E_PARENT: lineage not enabled"
        );
        assert_rejected(
            &mut t,
            "no deposit",
            "E_AUTH",
            "alice.test",
            NO_DEPOSIT,
            args(),
        );
        assert_rejected(
            &mut t,
            "a reward above the balance",
            "E_FUNDS",
            "bob.test",
            ONE_YOCTO,
            args(),
        );
        assert_rejected(
            &mut t,
            "no vault slot",
            "E_FUNDS",
            "carol.test",
            ONE_YOCTO,
            args(),
        );

        // Nothing was written along the way.
        assert_eq!(t.task_count(), U64(0));
        assert_eq!(balance(&t, "alice.test"), FUNDS);
        assert_eq!(balance(&t, "bob.test"), REWARD - 1);
        assert_eq!(used(&t, "alice.test"), alice_used);
        // The default task meets every rule.
        assert_eq!(post(&mut t, args()), 1);
    }

    #[test]
    fn rules_are_checked_in_the_listed_order() {
        // bob posts a task that breaks every rule it can at once. Each step mends the rule that
        // was reported, so the next one in the list has to be the next one reported.
        type Mend = fn(&mut Tender, &mut PostTaskArgs, &mut NearToken);
        let mut t = world();
        register(&mut t, "bob.test", NearToken::from_millinear(100));
        fund(&mut t, "bob.test", REWARD - 1);
        t.paused = true;
        t.put_token(acct(USDC), usdc(false));
        let mut task = PostTaskArgs {
            reward: U128(0),
            brief_uri: String::new(),
            brief_hash: "x".to_string(),
            commit_secs: 0,
            max_winners: 0,
            // Inviting the poster breaks E_INVITE. Uninviting him then leaves a capped task open
            // to anyone, which breaks E_LIMIT: the two cannot be broken at once.
            invited: accounts(&["bob.test"]),
            max_entries: 1,
            parent: Some(U64(1)),
            ..args()
        };
        let mut deposit = NO_DEPOSIT;
        let steps: [(&str, Mend); 12] = [
            ("E_PAUSED", |t, _, _| t.paused = false),
            ("E_TOKEN", |t, _, _| t.put_token(acct(USDC), usdc(true))),
            ("E_REWARD", |_, a, _| a.reward = U128(REWARD)),
            ("E_URI", |_, a, _| a.brief_uri = BRIEF_URI.to_string()),
            ("E_HASH", |_, a, _| a.brief_hash = BRIEF_HASH.to_string()),
            ("E_WINDOW", |_, a, _| a.commit_secs = 60),
            ("E_WINNERS", |_, a, _| a.max_winners = 1),
            ("E_INVITE", |_, a, _| a.invited.clear()),
            ("E_LIMIT", |_, a, _| a.max_entries = 0),
            ("E_PARENT", |_, a, _| a.parent = None),
            ("E_AUTH", |_, _, d| *d = ONE_YOCTO),
            ("E_FUNDS", |t, _, _| fund(t, "bob.test", 1)),
        ];
        for (code, mend) in steps {
            assert_rejected(&mut t, code, code, "bob.test", deposit, task.clone());
            mend(&mut t, &mut task, &mut deposit);
        }
        assert_eq!(try_post(&mut t, "bob.test", deposit, task), Ok(1));
        assert_eq!(balance(&t, "bob.test"), 0);
    }

    #[test]
    fn accepts_every_limit_at_its_bound() {
        let mut t = world();
        let min = t.get_config().min_window_secs;
        let cases = [
            (
                "the minimum reward",
                PostTaskArgs {
                    reward: U128(MIN_REWARD),
                    ..args()
                },
            ),
            (
                "the maximum reward",
                PostTaskArgs {
                    reward: U128(MAX_REWARD),
                    ..args()
                },
            ),
            (
                "a 1-byte brief_uri",
                PostTaskArgs {
                    brief_uri: "u".to_string(),
                    ..args()
                },
            ),
            (
                "a 256-byte brief_uri",
                PostTaskArgs {
                    brief_uri: "u".repeat(MAX_URI_BYTES),
                    ..args()
                },
            ),
            (
                "the shortest windows",
                PostTaskArgs {
                    commit_secs: min,
                    reveal_secs: min,
                    pick_secs: min,
                    fallback_secs: min,
                    ..args()
                },
            ),
            (
                "the longest windows",
                PostTaskArgs {
                    commit_secs: MAX_WINDOW_SECS,
                    reveal_secs: MAX_WINDOW_SECS,
                    pick_secs: MAX_WINDOW_SECS,
                    fallback_secs: MAX_WINDOW_SECS,
                    ..args()
                },
            ),
            (
                "five winners",
                PostTaskArgs {
                    max_winners: MAX_WINNERS,
                    ..args()
                },
            ),
            (
                "20 invited accounts, all of whom may enter",
                PostTaskArgs {
                    invited: (1..=MAX_INVITED)
                        .map(|i| acct(&format!("agent{i}.test")))
                        .collect(),
                    max_entries: 20,
                    ..args()
                },
            ),
            (
                "a held-out commitment and another verifier",
                PostTaskArgs {
                    heldout_commitment: Some(HELDOUT_HASH.to_string()),
                    verifier: Some(acct("judge.test")),
                    ..args()
                },
            ),
        ];
        for (n, (what, task)) in cases.into_iter().enumerate() {
            let expected = PostTaskArgs {
                verifier: task.verifier.clone().or(Some(acct("alice.test"))),
                ..task.clone()
            };
            let id = try_post(&mut t, "alice.test", ONE_YOCTO, task)
                .unwrap_or_else(|m| panic!("{what}: {m}"));
            assert_eq!(id, n as u64 + 1, "{what}");
            assert_eq!(args_of(&view(&t, id)), expected, "{what}");
        }
    }

    #[test]
    fn requires_one_yocto() {
        let mut t = world();
        for (what, deposit) in [
            ("no deposit", NO_DEPOSIT),
            ("2 yoctoNEAR", NearToken::from_yoctonear(2)),
            ("1 NEAR", NearToken::from_near(1)),
        ] {
            let message = assert_rejected(&mut t, what, "E_AUTH", "alice.test", deposit, args());
            assert_eq!(message, AUTH_MESSAGE, "{what}");
        }
        assert_eq!(t.task_count(), U64(0));
        assert_eq!(balance(&t, "alice.test"), FUNDS);
        assert_eq!(try_post(&mut t, "alice.test", ONE_YOCTO, args()), Ok(1));
    }

    #[test]
    fn post_task_spends_predecessor_not_signer() {
        let mut t = world();
        // mallory has a storage balance and nothing in her vault.
        register(&mut t, "mallory.test", NearToken::from_millinear(100));
        let (alice_used, mallory_used) = (used(&t, "alice.test"), used(&t, "mallory.test"));

        // mallory signs a transaction whose call reaches Tender from alice (a contract account,
        // say). The caller is alice: she pays the reward and the storage, and she is the poster
        // and the default verifier.
        testing_env!(ctx("alice.test")
            .signer_account_id(acct("mallory.test"))
            .attached_deposit(ONE_YOCTO)
            .block_timestamp(T1)
            .build());
        let id = t.post_task(args()).0;
        let v = view(&t, id);
        assert_eq!(v.poster, acct("alice.test"));
        assert_eq!(v.verifier, acct("alice.test"));
        assert_eq!(v.funders, funded_by("alice.test", REWARD));
        assert_eq!(balance(&t, "alice.test"), FUNDS - REWARD);
        assert!(
            used(&t, "alice.test") > alice_used,
            "the caller pays the storage"
        );
        assert_eq!(balance(&t, "mallory.test"), 0);
        assert_eq!(
            used(&t, "mallory.test"),
            mallory_used,
            "the signer pays nothing"
        );

        // The other way round: alice signs and the call comes from mallory. The post would spend
        // mallory's empty vault, so it fails, and alice keeps her balance.
        testing_env!(ctx("mallory.test")
            .signer_account_id(acct("alice.test"))
            .attached_deposit(ONE_YOCTO)
            .block_timestamp(T1)
            .build());
        let rejected = panic_message(|| {
            t.post_task(args());
        });
        assert!(
            rejected
                .as_ref()
                .is_some_and(|m| m.starts_with("E_FUNDS: ")),
            "{rejected:?}"
        );
        assert_eq!(balance(&t, "alice.test"), FUNDS - REWARD);
        assert_eq!(t.task_count(), U64(1));
    }

    // Storage.

    #[test]
    fn post_charges_task_bytes_plus_outcome_reserve() {
        let mut t = world();
        let start = used(&t, "alice.test");
        // The mocked VM restarts `storage_usage` with every context, so the mark is taken in the
        // context of the post itself.
        testing_env!(ctx("alice.test")
            .attached_deposit(ONE_YOCTO)
            .block_timestamp(T1)
            .build());
        let usage = t.storage_mark();
        let id = t.post_task(args()).0;
        let grown = env::storage_usage() - usage;
        // The task record: 40 bytes of overhead, the key (a 1-byte prefix and the 8-byte id) and
        // the Borsh value. Nothing else grows: alice's vault slot exists already.
        let value = borsh::to_vec(t.tasks.get(&id).unwrap()).unwrap().len() as u64;
        assert_eq!(grown, 40 + 1 + 8 + value);
        // alice pays for the record, and reserves the bytes its outcome will take.
        assert_eq!(
            used(&t, "alice.test"),
            start + grown + OUTCOME_RESERVE_BYTES
        );
    }

    #[test]
    fn post_needs_storage_for_the_task_and_its_outcome_reserve() {
        let mut t = world();
        let alice = acct("alice.test");
        // What one post costs alice, in bytes.
        let start = used(&t, "alice.test");
        post(&mut t, args());
        let cost = used(&t, "alice.test") - start;

        // With exactly that much to spare, the same post goes through and leaves nothing.
        leave_spare(&mut t, "alice.test", cost);
        post(&mut t, args());
        assert_eq!(t.storage_available(&alice), 0);

        // One byte short, it fails: the record fits, the outcome reserve does not.
        let short = u128::from(cost - 1) * byte_cost();
        register(&mut t, "alice.test", NearToken::from_yoctonear(short));
        let message = assert_rejected(
            &mut t,
            "one byte short",
            "E_STORAGE",
            "alice.test",
            ONE_YOCTO,
            args(),
        );
        assert_eq!(
            message,
            "E_STORAGE: insufficient storage balance; call storage_deposit"
        );
    }

    // Phases.

    #[test]
    fn phase_boundaries() {
        let mut t = world();
        let id = post(&mut t, args());
        let mut task = t.tasks.get(&id).unwrap().clone();
        let (commit, reveal, pick, fallback) = (
            task.commit_deadline,
            task.reveal_deadline,
            task.pick_deadline,
            task.fallback_deadline,
        );
        // Every window is half-open: it starts at one deadline and ends just before the next.
        let expected = [
            (T1, Phase::Open),
            (commit - 1, Phase::Open),
            (commit, Phase::Revealing),
            (reveal - 1, Phase::Revealing),
            (reveal, Phase::Judging),
            (pick - 1, Phase::Judging),
            (pick, Phase::Fallback),
            (fallback - 1, Phase::Fallback),
            (fallback, Phase::Expired),
            (u64::MAX, Phase::Expired),
        ];
        for (now, then) in expected {
            assert_eq!(phase(&task, now), then, "at {now}");
            // The views derive the same phase from the block time of the call.
            testing_env!(ctx("bob.test").block_timestamp(now).build());
            assert_eq!(view(&t, id).phase, then, "get_task at {now}");
            assert_eq!(t.get_tasks(U64(id), 1)[0].phase, then, "get_tasks at {now}");
        }

        // Once it has an outcome a task is settled, whatever the time.
        let voided = Outcome::Voided {
            reason: VoidReason::NoReveals,
            scorecard_hash: None,
            scorecard_uri: None,
        };
        task.outcome = Some(voided.clone());
        for (now, _) in expected {
            assert_eq!(phase(&task, now), Phase::Settled, "at {now}");
        }
        t.tasks.get_mut(&id).unwrap().outcome = Some(voided.clone());
        testing_env!(ctx("bob.test").block_timestamp(commit - 1).build());
        let v = view(&t, id);
        assert_eq!(v.phase, Phase::Settled);
        assert_eq!(v.outcome, Some(OutcomeView::from(&voided)));
    }

    // Views and events.

    #[test]
    fn task_created_event_fields() {
        let mut t = world();
        let task = PostTaskArgs {
            heldout_commitment: Some(HELDOUT_HASH.to_string()),
            verifier: Some(acct("judge.test")),
            max_entries: 2,
            max_winners: 2,
            invited: accounts(&["bob.test", "carol.test"]),
            ..args()
        };
        let id = post(&mut t, task);
        let logs = get_logs();
        assert_eq!(logs.len(), 1, "one event: {logs:?}");
        let (commit, reveal, pick, fallback) = (
            T1 + 60 * SEC,
            T1 + 180 * SEC,
            T1 + 360 * SEC,
            T1 + 600 * SEC,
        );
        // The whole line, which also pins the field order: `TaskView`'s.
        assert_eq!(
            logs[0],
            format!(
                r#"EVENT_JSON:{{"standard":"tender","version":"1.0.0","event":"task_created","data":[{{"id":"1","poster":"alice.test","token":"usdc.test","reward":"1000000","fee_bps":500,"brief_uri":"{BRIEF_URI}","brief_hash":"{BRIEF_HASH}","criteria_hash":"{CRITERIA_HASH}","heldout_commitment":"{HELDOUT_HASH}","verifier":"judge.test","created_at":"{T1}","commit_deadline":"{commit}","reveal_deadline":"{reveal}","pick_deadline":"{pick}","fallback_deadline":"{fallback}","max_entries":2,"max_winners":2,"invited":["bob.test","carol.test"],"parent":null}}]}}"#
            )
        );

        // Parsed, as an indexer reads it.
        let envelope: Value =
            serde_json::from_str(logs[0].strip_prefix("EVENT_JSON:").unwrap()).unwrap();
        assert_eq!(envelope["event"], "task_created");
        let data = &envelope["data"][0];
        let fields = [
            "id",
            "poster",
            "token",
            "reward",
            "fee_bps",
            "brief_uri",
            "brief_hash",
            "criteria_hash",
            "heldout_commitment",
            "verifier",
            "created_at",
            "commit_deadline",
            "reveal_deadline",
            "pick_deadline",
            "fallback_deadline",
            "max_entries",
            "max_winners",
            "invited",
            "parent",
        ];
        let mut keys: Vec<&str> = data
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        let mut expected = fields.to_vec();
        keys.sort_unstable();
        expected.sort_unstable();
        assert_eq!(keys, expected);
        // Amounts and timestamps are strings, and hashes are hex.
        assert!(data["reward"].is_string());
        assert_eq!(data["reward"], "1000000");
        assert_eq!(data["id"], "1");
        assert_eq!(data["created_at"], T1.to_string());
        assert_eq!(data["fallback_deadline"], fallback.to_string());
        assert_eq!(data["brief_hash"], BRIEF_HASH);
        assert_eq!(data["criteria_hash"], CRITERIA_HASH);
        assert_eq!(data["heldout_commitment"], HELDOUT_HASH);
        assert_eq!(data["verifier"], "judge.test");
        assert_eq!(data["parent"], Value::Null);
        // Every field agrees with what get_task returns.
        let view = serde_json::to_value(view(&t, id)).unwrap();
        for field in fields {
            assert_eq!(data[field], view[field], "{field}");
        }
    }

    #[test]
    fn task_view_json_uses_strings_and_hex() {
        let mut t = world();
        let id = post(&mut t, args());
        let (commit, reveal, pick, fallback) = (
            T1 + 60 * SEC,
            T1 + 180 * SEC,
            T1 + 360 * SEC,
            T1 + 600 * SEC,
        );
        assert_eq!(
            serde_json::to_string(&view(&t, id)).unwrap(),
            format!(
                r#"{{"id":"1","poster":"alice.test","token":"usdc.test","reward":"1000000","fee_bps":500,"brief_uri":"{BRIEF_URI}","brief_hash":"{BRIEF_HASH}","criteria_hash":"{CRITERIA_HASH}","heldout_commitment":null,"verifier":"alice.test","created_at":"{T1}","commit_deadline":"{commit}","reveal_deadline":"{reveal}","pick_deadline":"{pick}","fallback_deadline":"{fallback}","max_entries":0,"max_winners":1,"invited":[],"parent":null,"commit_count":0,"reveal_count":0,"cleaned":0,"funders":[{{"account":"alice.test","amount":"1000000"}}],"outcome":null,"phase":"open"}}"#
            )
        );
    }

    #[test]
    fn outcome_view_converts_both_variants() {
        let picked = Outcome::Picked {
            winners: vec![
                Payout {
                    account: acct("alice.test"),
                    bps: 7_000,
                    amount: 665_000,
                },
                Payout {
                    account: acct("bob.test"),
                    bps: 3_000,
                    amount: u128::MAX,
                },
            ],
            fee: 50_000,
            scorecard_hash: parse_hash(CRITERIA_HASH),
            scorecard_uri: "ipfs://scorecard".to_string(),
        };
        let view = OutcomeView::from(&picked);
        assert_eq!(
            view,
            OutcomeView::Picked {
                winners: vec![
                    PayoutView {
                        account: acct("alice.test"),
                        bps: 7_000,
                        amount: U128(665_000),
                    },
                    PayoutView {
                        account: acct("bob.test"),
                        bps: 3_000,
                        amount: U128(u128::MAX),
                    },
                ],
                fee: U128(50_000),
                scorecard_hash: CRITERIA_HASH.to_string(),
                scorecard_uri: "ipfs://scorecard".to_string(),
            }
        );
        assert_eq!(
            serde_json::to_string(&view).unwrap(),
            format!(
                r#"{{"kind":"picked","winners":[{{"account":"alice.test","bps":7000,"amount":"665000"}},{{"account":"bob.test","bps":3000,"amount":"340282366920938463463374607431768211455"}}],"fee":"50000","scorecard_hash":"{CRITERIA_HASH}","scorecard_uri":"ipfs://scorecard"}}"#
            )
        );

        let no_award = Outcome::Voided {
            reason: VoidReason::NoAward,
            scorecard_hash: Some(parse_hash(HELDOUT_HASH)),
            scorecard_uri: Some("ipfs://scorecard".to_string()),
        };
        assert_eq!(
            serde_json::to_string(&OutcomeView::from(&no_award)).unwrap(),
            format!(
                r#"{{"kind":"voided","reason":"no_award","scorecard_hash":"{HELDOUT_HASH}","scorecard_uri":"ipfs://scorecard"}}"#
            )
        );
        // Without a scorecard both of its fields are null.
        for (reason, name) in [
            (VoidReason::NoReveals, "no_reveals"),
            (VoidReason::Expired, "expired"),
        ] {
            let voided = Outcome::Voided {
                reason,
                scorecard_hash: None,
                scorecard_uri: None,
            };
            assert_eq!(
                serde_json::to_string(&OutcomeView::from(&voided)).unwrap(),
                format!(
                    r#"{{"kind":"voided","reason":"{name}","scorecard_hash":null,"scorecard_uri":null}}"#
                )
            );
        }
    }

    #[test]
    fn get_tasks_paginates() {
        let mut t = world();
        assert!(t.get_tasks(U64(1), 50).is_empty(), "no tasks yet");
        for expected in 1..=3 {
            assert_eq!(post(&mut t, args()), expected);
        }
        assert_eq!(ids(&t.get_tasks(U64(2), 50)), [2, 3]);
        // Id 0 starts the page at 1, and a limit of 0 means 1.
        assert_eq!(ids(&t.get_tasks(U64(0), 2)), [1, 2]);
        assert_eq!(ids(&t.get_tasks(U64(3), 0)), [3]);
        // Past the end the page is empty, even from the largest id.
        assert!(t.get_tasks(U64(4), 50).is_empty());
        assert!(t.get_tasks(U64(u64::MAX), 50).is_empty());
        // get_task agrees with the pages, and knows no task 0.
        assert_eq!(t.get_task(U64(2)), Some(t.get_tasks(U64(2), 1)[0].clone()));
        assert_eq!(t.get_task(U64(0)), None);
        assert_eq!(t.get_task(U64(4)), None);

        // A page holds at most 50 tasks, however large the limit.
        for expected in 4..=55 {
            assert_eq!(post(&mut t, args()), expected);
        }
        assert_eq!(t.task_count(), U64(55));
        assert_eq!(ids(&t.get_tasks(U64(1), 500)), (1..=50).collect::<Vec<_>>());
        assert_eq!(ids(&t.get_tasks(U64(1), u32::MAX)).len(), 50);
        assert_eq!(ids(&t.get_tasks(U64(51), 500)), [51, 52, 53, 54, 55]);
    }
}
