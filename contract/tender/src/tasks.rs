//! Posting tasks, topping them up, the task views, and the phase a task is in.
//!
//! A poster escrows a reward from its vault into a task with four consecutive windows: commit,
//! reveal, pick and fallback. Each window is half-open, `[start, end)`, and the phase is derived
//! from the block time and the outcome on every read, never stored, so no transaction is needed
//! to move a task along. Task ids run from 1 with no gaps, so the views page through them by id.
//!
//! Until its commit deadline, anyone may add to a task's reward from its own vault with
//! `top_up_task`, a pooled bounty: at least the token's `min_reward` to join, then any amount. The
//! task records each funder and what it paid in, so a void can give each one back exactly that.

use near_sdk::json_types::{U128, U64};
use near_sdk::{env, near, AccountId};

use crate::events::{emit, TaskCreated, TaskToppedUp};
use crate::types::{
    check_uri, err, hex32, parse_hash, FunderView, Outcome, OutcomeView, Payout, PayoutView, Phase,
    PostTaskArgs, Task, TaskView, MAX_FUNDERS, MAX_INVITED, MAX_PAGE, MAX_REWARD_LIMIT,
    MAX_WINDOW_SECS, MAX_WINNERS, OUTCOME_RESERVE_BYTES,
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

/// Panics `E_NOT_FOUND` for `task_id`, which no task has. Every method that takes a task id says
/// so the same way.
pub(crate) fn no_task(task_id: u64) -> ! {
    env::panic_str(&format!("{}: no task {task_id}", err::E_NOT_FOUND))
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

impl From<&Payout> for PayoutView {
    fn from(p: &Payout) -> Self {
        PayoutView {
            account: p.account.clone(),
            bps: p.bps,
            amount: U128(p.amount),
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
                winners: winners.iter().map(PayoutView::from).collect(),
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
    /// returns its id. Called as `{"task": {...}}` with exactly 1 yoctoNEAR attached, or with none
    /// by a delegate key within its caps (`add_delegate`; see the `auth` module).
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
    /// - a `parent`, if any, is a task the poster can hire for (`E_PARENT`; see `check_parent`):
    ///   it exists and is not settled, the poster has an entry on it, and this task's pick
    ///   window ends no later than the parent's commit window;
    /// - the spend is authorised: 1 yoctoNEAR attached, or no deposit from a delegate key whose
    ///   token is `token`, with `reward` within its caps, which then count it (`E_AUTH`);
    /// - the caller's vault holds `reward` (`E_FUNDS`).
    ///
    /// The caller is the predecessor, never the signer. It is the poster, the only funder, and
    /// the verifier unless `verifier` names another account. The deadlines follow one another
    /// from the block time, and the task keeps the protocol fee in force when it is posted. The
    /// poster's storage balance pays for the task record and reserves `OUTCOME_RESERVE_BYTES` for
    /// its outcome (`E_STORAGE` if it cannot), so settling the task never needs new storage.
    /// Emits `task_created` once everything has passed.
    #[payable]
    #[deny_unknown_arguments]
    pub fn post_task(&mut self, task: PostTaskArgs) -> U64 {
        let poster = env::predecessor_account_id();
        if self.paused {
            env::panic_str(&format!("{}: posting new tasks is paused", err::E_PAUSED));
        }
        let reward = task.reward.0;
        self.check_reward(&task.token, reward);
        check_uri("brief_uri", &task.brief_uri);
        let brief_hash = parse_hash("brief_hash", &task.brief_hash);
        let criteria_hash = parse_hash("criteria_hash", &task.criteria_hash);
        let heldout_commitment = task
            .heldout_commitment
            .as_deref()
            .map(|h| parse_hash("heldout_commitment", h));
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
        if let Some(parent) = task.parent {
            self.check_parent(&poster, parent.0, pick_deadline);
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

    /// Moves `amount` of task `task_id`'s token from the caller's vault into the task's escrow,
    /// which makes the caller one of its funders: a pooled bounty. Called as `post_task` is: with
    /// exactly 1 yoctoNEAR attached, or with none by a delegate key within its caps.
    ///
    /// The rules, checked in this order, each with its error code:
    /// - top-ups are not paused (`E_PAUSED`);
    /// - the task exists (`E_NOT_FOUND`);
    /// - its commit window is open: the block time is before its `commit_deadline` (`E_PHASE`);
    /// - it is not settled (`E_SETTLED`). No task settles before its commit deadline, so the rule
    ///   above is the one a settled task breaks; this one only keeps the money of a settled task
    ///   from moving whatever happens;
    /// - the caller funds the task already, or it has fewer than `MAX_FUNDERS` funders, the
    ///   poster among them (`E_LIMIT`);
    /// - the task's token is still enabled (`E_TOKEN`);
    /// - `amount` is more than 0; it is at least the token's `min_reward` as it is now if the
    ///   caller does not fund the task yet, so that dust cannot take the funder records; and the
    ///   reward it makes is at most the token's `max_reward` as it is now, and at most
    ///   `MAX_REWARD_LIMIT` (`E_REWARD`);
    /// - the spend is authorised: 1 yoctoNEAR attached, or no deposit from a delegate key whose
    ///   token is the task's, with `amount` within its caps, which then count it (`E_AUTH`);
    /// - the caller's vault holds `amount` (`E_FUNDS`).
    ///
    /// The caller is the predecessor, never the signer. If it funds the task already, the poster
    /// included, its record grows by `amount`. Otherwise it gets a record after the others, and
    /// pays for that record's bytes out of its storage balance (`E_STORAGE` if it cannot); that
    /// is the only storage a top-up adds, and an existing funder needs none.
    ///
    /// Nothing else about the task changes: its terms are the poster's. A pick takes the fee from
    /// the whole reward and pays the winners out of the rest, whoever paid it in; an empty pick or
    /// a void gives each funder back exactly what it paid in, so a refund is pro rata with no
    /// dust. Emits `task_topped_up`, with the reward the top-up made.
    #[payable]
    #[deny_unknown_arguments]
    pub fn top_up_task(&mut self, task_id: U64, amount: U128) {
        let funder = env::predecessor_account_id();
        let (id, amount) = (task_id.0, amount.0);
        if self.paused {
            env::panic_str(&format!("{}: topping up tasks is paused", err::E_PAUSED));
        }
        let task = self.tasks.get(&id).unwrap_or_else(|| no_task(id));
        if env::block_timestamp() >= task.commit_deadline {
            env::panic_str(&format!(
                "{}: task {id} takes top-ups only until its commit deadline",
                err::E_PHASE
            ));
        }
        if task.outcome.is_some() {
            env::panic_str(&format!("{}: task {id} is already settled", err::E_SETTLED));
        }
        let known = task
            .funders
            .iter()
            .position(|(account, _)| *account == funder);
        if known.is_none() && task.funders.len() >= MAX_FUNDERS {
            env::panic_str(&format!(
                "{}: task {id} has {MAX_FUNDERS} funders, the most it can have",
                err::E_LIMIT
            ));
        }
        let token = task.token.clone();
        let reward = self.topped_up_reward(task, amount, known.is_none());

        // Everything above only reads. The mark comes before the first write, so the storage
        // this call adds is measured from here.
        let before = self.storage_mark();
        self.authorize_spend(&funder, &token, amount);
        self.debit(&funder, &token, amount);
        let task = self.tasks.get_mut(&id).unwrap_or_else(|| no_task(id));
        task.reward = reward;
        match known {
            // A record is at most the reward, which has just been shown to fit.
            Some(i) => task.funders[i].1 += amount,
            None => task.funders.push((funder.clone(), amount)),
        }
        self.settle_storage(&funder, before);
        emit(
            "task_topped_up",
            &TaskToppedUp {
                task_id,
                funder,
                amount: U128(amount),
                reward: U128(reward),
            },
        );
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

    /// The reward that topping `task` up by `amount` makes. Panics `E_TOKEN` unless the task's
    /// token is enabled, then `E_REWARD` unless `amount` is more than 0, at least the token's
    /// `min_reward` for a `new_funder`, and the sum is at most both the token's `max_reward` and
    /// `MAX_REWARD_LIMIT`, so that the task can still be picked.
    ///
    /// The minimum for a new funder keeps the `MAX_FUNDERS` records from being taken with dust,
    /// which would shut every later funder out of the task: filling them costs at least
    /// `min_reward` each, all of it in the escrow. A funder already in, the poster included, may
    /// add any amount, since it takes no new record.
    fn topped_up_reward(&self, task: &Task, amount: u128, new_funder: bool) -> u128 {
        let token = &task.token;
        let Some(limits) = self.tokens.get(token).filter(|c| c.enabled) else {
            env::panic_str(&format!(
                "{}: {token} is not an enabled token",
                err::E_TOKEN
            ));
        };
        if amount == 0 {
            env::panic_str(&format!("{}: a top-up must be more than 0", err::E_REWARD));
        }
        if new_funder && amount < limits.min_reward {
            env::panic_str(&format!(
                "{}: a first top-up must be at least the token's min_reward of {}, got {amount}",
                err::E_REWARD,
                limits.min_reward
            ));
        }
        let max = limits.max_reward.min(MAX_REWARD_LIMIT);
        task.reward
            .checked_add(amount)
            .filter(|reward| *reward <= max)
            .unwrap_or_else(|| {
                env::panic_str(&format!(
                    "{}: a top-up of {amount} would take the reward of task {} past {max}",
                    err::E_REWARD,
                    task.id
                ))
            })
    }

    /// Panics `E_PARENT` unless `poster` may name task `parent` as the parent of a task whose
    /// pick window ends at `pick_deadline` (lineage, spec 6.7). The rules, in this order:
    /// - the parent exists, which `parent` 0 and the id of the task being posted do not;
    /// - it is not settled;
    /// - `poster` has an entry on it, so that "this agent hired these sub-agents for that task"
    ///   is a fact of the chain. The parent's poster and verifier can never have one;
    /// - `pick_deadline` is at most the parent's `commit_deadline` (I12): the sub-tasks are
    ///   picked before the lead has to commit its final work, which is why a lead can commit a
    ///   placeholder first and replace it. The deadline is inclusive: a pick window that ends on
    ///   the parent's commit deadline is in time.
    ///
    /// No task settles before its commit deadline, so a parent that is not settled still has its
    /// commit window open whenever the last rule passes. The second rule is kept apart for the
    /// message: it tells a settled parent from one whose time has merely run out.
    fn check_parent(&self, poster: &AccountId, parent: u64, pick_deadline: u64) {
        let Some(p) = self.tasks.get(&parent) else {
            env::panic_str(&format!("{}: parent not found", err::E_PARENT));
        };
        if p.outcome.is_some() {
            env::panic_str(&format!("{}: parent is already settled", err::E_PARENT));
        }
        if self.entries.get(&(parent, poster.clone())).is_none() {
            env::panic_str(&format!("{}: poster has no entry on parent", err::E_PARENT));
        }
        if pick_deadline > p.commit_deadline {
            env::panic_str(&format!(
                "{}: child must settle before parent commit deadline",
                err::E_PARENT
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
    use near_sdk::serde_json::{self, json, Value};
    use near_sdk::test_utils::get_logs;
    use near_sdk::{borsh, env, testing_env, AccountId, NearToken};

    use super::phase;
    use crate::test_utils::{ctx, fresh, panic_message};
    use crate::types::{
        parse_hash, FunderView, Outcome, OutcomeView, Payout, PayoutView, Phase, PostTaskArgs,
        StorageView, Task, TaskView, TokenConfig, VoidReason, MAX_FUNDERS, MAX_INVITED,
        MAX_REWARD_LIMIT, MAX_URI_BYTES, MAX_WINDOW_SECS, MAX_WINNERS, OUTCOME_RESERVE_BYTES,
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
        t.storage_deposit(None, None);
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

    // The arguments on the wire.

    /// What `post_task`'s generated wasm wrapper parses `env::input()` into. The wrapper exists
    /// only in the wasm build (`#[cfg(target_arch = "wasm32")]`), so this mirrors the code
    /// near-sdk-macros 5.29.1 generates: a struct of the method's arguments, read with
    /// `serde_json::from_slice`, which `#[deny_unknown_arguments]` makes `deny_unknown_fields`.
    /// The inner object goes through `PostTaskArgs`' own derive.
    #[derive(near_sdk::serde::Deserialize)]
    #[serde(crate = "near_sdk::serde", deny_unknown_fields)]
    struct Input {
        task: PostTaskArgs,
    }

    /// Parses `{"task": <task>}` as `post_task` receives it. `Err` holds serde's message.
    fn parse_wire(task: &Value) -> Result<PostTaskArgs, String> {
        let input = serde_json::to_vec(&json!({ "task": task })).unwrap();
        serde_json::from_slice::<Input>(&input)
            .map(|input| input.task)
            .map_err(|e| e.to_string())
    }

    #[test]
    fn post_task_args_wire_form() {
        // Every field, as a client sends it: the reward and the parent id are decimal strings.
        let full = json!({
            "token": "usdc.test",
            "reward": "1000000",
            "brief_uri": BRIEF_URI,
            "brief_hash": BRIEF_HASH,
            "criteria_hash": CRITERIA_HASH,
            "heldout_commitment": HELDOUT_HASH,
            "verifier": "judge.test",
            "commit_secs": 60,
            "reveal_secs": 120,
            "pick_secs": 180,
            "fallback_secs": 240,
            "max_entries": 2,
            "max_winners": 2,
            "invited": ["bob.test", "carol.test"],
            "parent": "7",
        });
        let bare = PostTaskArgs {
            max_entries: 2,
            max_winners: 2,
            invited: accounts(&["bob.test", "carol.test"]),
            ..args()
        };
        assert_eq!(
            parse_wire(&full),
            Ok(PostTaskArgs {
                heldout_commitment: Some(HELDOUT_HASH.to_string()),
                verifier: Some(acct("judge.test")),
                parent: Some(U64(7)),
                ..bare.clone()
            })
        );

        // The optional fields may be left out or sent as null. Either way they are `None`.
        let (mut omitted, mut nulls) = (full.clone(), full.clone());
        for key in ["heldout_commitment", "verifier", "parent"] {
            omitted.as_object_mut().unwrap().remove(key);
            nulls[key] = Value::Null;
        }
        assert_eq!(parse_wire(&omitted), Ok(bare.clone()), "left out");
        assert_eq!(parse_wire(&nulls), Ok(bare), "sent as null");

        // The reward is a decimal string. A JSON number is refused.
        let mut number = full.clone();
        number["reward"] = json!(1_000_000);
        let message = parse_wire(&number).unwrap_err();
        assert!(
            message.contains("invalid type: integer `1000000`, expected a string"),
            "{message}"
        );

        // `invited` is required, even for a task open to anyone.
        let mut uninvited = full.clone();
        uninvited.as_object_mut().unwrap().remove("invited");
        let message = parse_wire(&uninvited).unwrap_err();
        assert!(message.contains("missing field `invited`"), "{message}");

        // A misspelled key is an error, not a missing optional field that quietly takes its
        // default: `verifer` would make the poster the verifier.
        for (key, typo) in [
            ("verifier", "verifer"),
            ("heldout_commitment", "heldout_commitement"),
            ("parent", "parnet"),
        ] {
            let mut misspelled = full.clone();
            let task = misspelled.as_object_mut().unwrap();
            let value = task.remove(key).unwrap();
            task.insert(typo.to_string(), value);
            let message = parse_wire(&misspelled).unwrap_err();
            assert!(
                message.contains(&format!("unknown field `{typo}`")),
                "{typo}: {message}"
            );
        }

        // So is any other key `post_task` does not take.
        let mut extra = full.clone();
        extra["colour"] = json!("blue");
        let message = parse_wire(&extra).unwrap_err();
        assert!(message.contains("unknown field `colour`"), "{message}");

        // And so is a key beside `task`: `verifier` sent next to the task, not inside it, would
        // otherwise make the poster the verifier.
        let beside =
            serde_json::to_vec(&json!({ "task": full, "verifier": "judge.test" })).unwrap();
        let message = serde_json::from_slice::<Input>(&beside)
            .map(|_| ())
            .unwrap_err()
            .to_string();
        assert!(message.contains("unknown field `verifier`"), "{message}");
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
        // The owner changes the fee. It pays for any vault slot the call makes, so it needs a
        // storage balance.
        register(&mut t, "owner.test", NearToken::from_near(1));
        testing_env!(ctx("owner.test").attached_deposit(ONE_YOCTO).build());
        t.set_fee(900, acct("treasury.test"));
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
            "E_PARENT: parent not found"
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
    fn hash_rejections_name_the_field() {
        // Three arguments are hashes, so the message says which one is wrong.
        let mut t = world();
        let cases = [
            (
                "brief_hash",
                PostTaskArgs {
                    brief_hash: BRIEF_HASH.to_uppercase(),
                    ..args()
                },
            ),
            (
                "criteria_hash",
                PostTaskArgs {
                    criteria_hash: CRITERIA_HASH[..63].to_string(),
                    ..args()
                },
            ),
            (
                "heldout_commitment",
                PostTaskArgs {
                    heldout_commitment: Some(format!("g{}", &HELDOUT_HASH[1..])),
                    ..args()
                },
            ),
        ];
        for (field, task) in cases {
            let message = assert_rejected(&mut t, field, "E_HASH", "alice.test", ONE_YOCTO, task);
            assert_eq!(
                message,
                format!("E_HASH: {field}: expected 64 lowercase hex chars")
            );
        }
        assert_eq!(t.task_count(), U64(0));
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
            scorecard_hash: parse_hash("scorecard_hash", CRITERIA_HASH),
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
            scorecard_hash: Some(parse_hash("scorecard_hash", HELDOUT_HASH)),
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

    // Top-ups: pooled bounties.

    /// `who` tops task `id` up by `amount` at block time `now`, attaching `deposit`. `Err` holds
    /// the message the contract panicked with.
    fn try_top_up_at(
        t: &mut Tender,
        who: &str,
        deposit: NearToken,
        now: u64,
        id: u64,
        amount: u128,
    ) -> Result<(), String> {
        testing_env!(ctx(who)
            .attached_deposit(deposit)
            .block_timestamp(now)
            .build());
        match panic_message(|| t.top_up_task(U64(id), U128(amount))) {
            Some(message) => Err(message),
            None => Ok(()),
        }
    }

    /// `who` tops task `id` up by `amount` at `T1` with 1 yoctoNEAR, which must go through.
    fn top_up(t: &mut Tender, who: &str, id: u64, amount: u128) {
        try_top_up_at(t, who, ONE_YOCTO, T1, id, amount)
            .unwrap_or_else(|m| panic!("{who} topping task {id} up by {amount}: {m}"));
    }

    /// A would-be funder: `who` with 0.1 NEAR of storage and `amount` of USDC in its vault.
    fn funder(t: &mut Tender, who: &str, amount: u128) {
        register(t, who, NearToken::from_millinear(100));
        fund(t, who, amount);
    }

    /// The bytes a funder record of `who` adds to a task record: its Borsh encoding.
    fn funder_bytes(who: &str) -> u64 {
        borsh::to_vec(&(acct(who), 0u128)).unwrap().len() as u64
    }

    fn funders(list: &[(&str, u128)]) -> Vec<FunderView> {
        list.iter()
            .map(|&(account, amount)| FunderView {
                account: acct(account),
                amount: U128(amount),
            })
            .collect()
    }

    /// What a top-up by `who` into task `id` could change: the task record, `who`'s vault and
    /// `who`'s storage balance.
    type Snapshot = (Option<Task>, u128, Option<StorageView>);

    fn snapshot(t: &Tender, id: u64, who: &str) -> Snapshot {
        (
            t.tasks.get(&id).cloned(),
            balance(t, who),
            t.storage_balance_of(acct(who)),
        )
    }

    /// Asserts that `result` is a rejection with `code`, that it logged nothing, and that the task
    /// `id` and `who`'s vault and storage are as `before` holds them. Returns the message.
    fn assert_top_up_rejected(
        t: &Tender,
        what: &str,
        code: &str,
        result: Result<(), String>,
        (id, who, before): (u64, &str, &Snapshot),
    ) -> String {
        let message = result.expect_err(&format!("{what}: expected {code}, but it went through"));
        assert!(
            message.starts_with(&format!("{code}: ")),
            "{what}: expected {code}, got {message:?}"
        );
        assert!(get_logs().is_empty(), "{what}: a rejection logs nothing");
        assert_eq!(
            &snapshot(t, id, who),
            before,
            "{what}: a rejection changes nothing"
        );
        message
    }

    #[test]
    fn top_up_adds_reward_and_funder() {
        let mut t = world();
        funder(&mut t, "bob.test", 5 * REWARD);
        let id = post(&mut t, args());
        let posted = t.tasks.get(&id).unwrap().clone();
        let (alice_used, bob_used) = (used(&t, "alice.test"), used(&t, "bob.test"));

        top_up(&mut t, "bob.test", id, 2 * REWARD);

        let v = view(&t, id);
        assert_eq!(v.reward, U128(3 * REWARD));
        assert_eq!(
            v.funders,
            funders(&[("alice.test", REWARD), ("bob.test", 2 * REWARD)])
        );
        assert_eq!(v.phase, Phase::Open);
        // Nothing else about the task changed: its terms are the poster's.
        let task = t.tasks.get(&id).unwrap().clone();
        assert_eq!(
            Task {
                reward: posted.reward,
                funders: posted.funders.clone(),
                ..task
            },
            posted
        );
        // The money left bob's vault for the escrow, and nobody else's moved.
        assert_eq!(balance(&t, "bob.test"), 3 * REWARD);
        assert_eq!(balance(&t, "alice.test"), FUNDS - REWARD);
        // bob pays for his record, which is all that grew, and alice pays nothing more.
        assert_eq!(used(&t, "bob.test"), bob_used + funder_bytes("bob.test"));
        assert_eq!(used(&t, "alice.test"), alice_used);
        // One event, with the reward the top-up made.
        assert_eq!(
            get_logs(),
            [
                r#"EVENT_JSON:{"standard":"tender","version":"1.0.0","event":"task_topped_up","data":[{"task_id":"1","funder":"bob.test","amount":"2000000","reward":"3000000"}]}"#
            ]
        );
    }

    #[test]
    fn top_up_same_funder_accumulates() {
        let mut t = world();
        funder(&mut t, "bob.test", 5 * REWARD);
        let id = post(&mut t, args());
        top_up(&mut t, "bob.test", id, REWARD);
        let bob_used = used(&t, "bob.test");

        // A second top-up adds to bob's record. There is no second record, so no storage either.
        top_up(&mut t, "bob.test", id, 2 * REWARD);
        assert_eq!(
            view(&t, id).funders,
            funders(&[("alice.test", REWARD), ("bob.test", 3 * REWARD)])
        );
        assert_eq!(used(&t, "bob.test"), bob_used);
        // So it needs no spare storage at all.
        leave_spare(&mut t, "bob.test", 0);
        top_up(&mut t, "bob.test", id, 1);

        // The poster is a funder already, so her record grows the same way.
        let alice_used = used(&t, "alice.test");
        top_up(&mut t, "alice.test", id, 500_000);
        let v = view(&t, id);
        assert_eq!(
            v.funders,
            funders(&[
                ("alice.test", REWARD + 500_000),
                ("bob.test", 3 * REWARD + 1)
            ])
        );
        assert_eq!(v.reward, U128(4 * REWARD + 500_001));
        assert_eq!(used(&t, "alice.test"), alice_used);
        assert_eq!(balance(&t, "bob.test"), 2 * REWARD - 1);
        assert_eq!(balance(&t, "alice.test"), FUNDS - REWARD - 500_000);
    }

    #[test]
    fn top_up_after_commit_deadline_rejected() {
        let mut t = world();
        funder(&mut t, "bob.test", 5 * REWARD);
        let id = post(&mut t, args());
        let task = t.tasks.get(&id).unwrap().clone();

        // The commit window is half-open: its last nanosecond still takes a top-up...
        assert_eq!(
            try_top_up_at(
                &mut t,
                "bob.test",
                ONE_YOCTO,
                task.commit_deadline - 1,
                id,
                MIN_REWARD
            ),
            Ok(())
        );
        // ...and from the deadline on, in every later phase, the task takes no more money.
        let before = snapshot(&t, id, "bob.test");
        for (what, now) in [
            ("at the commit deadline", task.commit_deadline),
            (
                "at the last nanosecond of the reveal window",
                task.reveal_deadline - 1,
            ),
            ("in the verifier's window", task.reveal_deadline),
            ("in the poster's window", task.pick_deadline),
            ("once expired", task.fallback_deadline),
            ("at the end of time", u64::MAX),
        ] {
            let result = try_top_up_at(&mut t, "bob.test", ONE_YOCTO, now, id, 1);
            let message =
                assert_top_up_rejected(&t, what, "E_PHASE", result, (id, "bob.test", &before));
            assert_eq!(
                message,
                "E_PHASE: task 1 takes top-ups only until its commit deadline"
            );
        }

        // A settled task, too. No task settles before its commit deadline, so that is the rule
        // a top-up of one breaks...
        testing_env!(ctx("keeper.test")
            .block_timestamp(task.reveal_deadline)
            .build());
        t.void_task(U64(id));
        let before = snapshot(&t, id, "bob.test");
        let result = try_top_up_at(&mut t, "bob.test", ONE_YOCTO, task.reveal_deadline, id, 1);
        let what = "a voided task";
        assert_top_up_rejected(&t, what, "E_PHASE", result, (id, "bob.test", &before));
        // ...and a block time before it, which the chain never goes back to, still finds the
        // task settled.
        let result = try_top_up_at(&mut t, "bob.test", ONE_YOCTO, T1, id, 1);
        let what = "a settled task inside its commit window";
        let message =
            assert_top_up_rejected(&t, what, "E_SETTLED", result, (id, "bob.test", &before));
        assert_eq!(message, "E_SETTLED: task 1 is already settled");
    }

    #[test]
    fn top_up_cap_51st_funder() {
        let mut t = world();
        let id = post(&mut t, args());
        // alice is the first funder. 49 more make the most a task can have.
        let names: Vec<String> = (1..MAX_FUNDERS)
            .map(|i| format!("funder{i}.test"))
            .collect();
        for name in &names {
            funder(&mut t, name, 1_000);
            top_up(&mut t, name, id, 1_000);
        }
        let v = view(&t, id);
        assert_eq!(v.funders.len(), MAX_FUNDERS);
        assert_eq!(v.reward, U128(REWARD + 49 * 1_000));

        // The 51st is refused, and nothing moves.
        funder(&mut t, "late.test", 1_000);
        let before = snapshot(&t, id, "late.test");
        let result = try_top_up_at(&mut t, "late.test", ONE_YOCTO, T1, id, 1_000);
        let what = "a 51st funder";
        let message =
            assert_top_up_rejected(&t, what, "E_LIMIT", result, (id, "late.test", &before));
        assert_eq!(
            message,
            "E_LIMIT: task 1 has 50 funders, the most it can have"
        );

        // Those already in can still add to what they put in, the poster too.
        fund(&mut t, "funder7.test", 500);
        top_up(&mut t, "funder7.test", id, 500);
        top_up(&mut t, "alice.test", id, 1);
        let v = view(&t, id);
        assert_eq!(v.funders.len(), MAX_FUNDERS);
        assert_eq!(v.funders[0], funders(&[("alice.test", REWARD + 1)])[0]);
        assert_eq!(v.funders[7], funders(&[("funder7.test", 1_500)])[0]);
        assert_eq!(v.reward, U128(REWARD + 49 * 1_000 + 501));
        // The records are in the order of each funder's first top-up, and add up to the reward.
        let order: Vec<String> = v.funders[1..]
            .iter()
            .map(|f| f.account.to_string())
            .collect();
        assert_eq!(order, names);
        assert_eq!(
            v.funders.iter().map(|f| f.amount.0).sum::<u128>(),
            v.reward.0
        );
    }

    /// The funder slots cannot be squatted with dust: an account's first top-up of a task must be
    /// at least the token's `min_reward`, so the 49 slots after the poster's cost at least 49 times
    /// that, all of it at stake in the task. Once in, a funder may add any amount.
    #[test]
    fn forty_nine_dust_funders_then_a_real_funder() {
        let mut t = world();
        let id = post(&mut t, args());
        // 49 accounts try to take the 49 free slots with one unit each, then with one unit short
        // of the minimum. Each is refused, and nothing moves.
        for i in 1..MAX_FUNDERS {
            let name = format!("dust{i}.test");
            funder(&mut t, &name, MIN_REWARD);
            let before = snapshot(&t, id, &name);
            for dust in [1, MIN_REWARD - 1] {
                let result = try_top_up_at(&mut t, &name, ONE_YOCTO, T1, id, dust);
                let what = format!("{name}'s first top-up of {dust}");
                let message =
                    assert_top_up_rejected(&t, &what, "E_REWARD", result, (id, &name, &before));
                assert_eq!(
                    message,
                    format!(
                        "E_REWARD: a first top-up must be at least the token's min_reward of \
                         {MIN_REWARD}, got {dust}"
                    )
                );
            }
        }
        let v = view(&t, id);
        assert_eq!(v.funders, funders(&[("alice.test", REWARD)]));
        assert_eq!(v.reward, U128(REWARD));

        // A real funder still gets in, with exactly the minimum...
        funder(&mut t, "real.test", MIN_REWARD + 1);
        top_up(&mut t, "real.test", id, MIN_REWARD);
        // ...and, once a funder, may add dust, as may the poster.
        top_up(&mut t, "real.test", id, 1);
        top_up(&mut t, "alice.test", id, 1);
        assert_eq!(
            view(&t, id).funders,
            funders(&[("alice.test", REWARD + 1), ("real.test", MIN_REWARD + 1)])
        );

        // The dust accounts can still fill the other 48 slots, but only by putting the minimum
        // each into the task, where a pick pays it to the winners.
        for i in 1..MAX_FUNDERS - 1 {
            top_up(&mut t, &format!("dust{i}.test"), id, MIN_REWARD);
        }
        let v = view(&t, id);
        assert_eq!(v.funders.len(), MAX_FUNDERS);
        assert_eq!(v.reward, U128(REWARD + 1 + 49 * MIN_REWARD + 1));
        assert_eq!(
            v.funders.iter().map(|f| f.amount.0).sum::<u128>(),
            v.reward.0
        );
    }

    #[test]
    fn top_up_rejects_each_rule() {
        let mut t = world();
        funder(&mut t, "bob.test", 5 * REWARD);
        // carol has a storage balance and no vault slot.
        register(&mut t, "carol.test", NearToken::from_millinear(100));
        let id = post(&mut t, args());
        let before = snapshot(&t, id, "bob.test");
        let check = |t: &mut Tender, what: &str, code: &str, deposit, id, amount| {
            let result = try_top_up_at(t, "bob.test", deposit, T1, id, amount);
            assert_top_up_rejected(t, what, code, result, (1, "bob.test", &before))
        };

        t.paused = true;
        let message = check(&mut t, "while paused", "E_PAUSED", ONE_YOCTO, id, 1);
        assert_eq!(message, "E_PAUSED: topping up tasks is paused");
        t.paused = false;

        let message = check(
            &mut t,
            "a task that does not exist",
            "E_NOT_FOUND",
            ONE_YOCTO,
            99,
            1,
        );
        assert_eq!(message, "E_NOT_FOUND: no task 99");

        t.put_token(acct(USDC), usdc(false));
        let message = check(&mut t, "a disabled token", "E_TOKEN", ONE_YOCTO, id, 1);
        assert_eq!(message, "E_TOKEN: usdc.test is not an enabled token");
        t.put_token(acct(USDC), usdc(true));

        let message = check(&mut t, "nothing", "E_REWARD", ONE_YOCTO, id, 0);
        assert_eq!(message, "E_REWARD: a top-up must be more than 0");
        // bob funds nothing yet, so his first top-up must be at least the minimum.
        let message = check(&mut t, "dust", "E_REWARD", ONE_YOCTO, id, MIN_REWARD - 1);
        assert_eq!(
            message,
            format!(
                "E_REWARD: a first top-up must be at least the token's min_reward of {MIN_REWARD}, \
                 got {}",
                MIN_REWARD - 1
            )
        );
        let past_max = MAX_REWARD - REWARD + 1;
        let message = check(
            &mut t,
            "past max_reward",
            "E_REWARD",
            ONE_YOCTO,
            id,
            past_max,
        );
        assert_eq!(
            message,
            format!("E_REWARD: a top-up of {past_max} would take the reward of task 1 past {MAX_REWARD}")
        );
        // A sum past u128::MAX is the same rejection, not an overflow.
        check(&mut t, "u128::MAX", "E_REWARD", ONE_YOCTO, id, u128::MAX);

        for (what, deposit) in [
            ("no deposit", NO_DEPOSIT),
            ("2 yoctoNEAR", NearToken::from_yoctonear(2)),
            ("1 NEAR", NearToken::from_near(1)),
        ] {
            let message = check(&mut t, what, "E_AUTH", deposit, id, MIN_REWARD);
            assert_eq!(message, AUTH_MESSAGE, "{what}");
        }

        let message = check(
            &mut t,
            "more than bob holds",
            "E_FUNDS",
            ONE_YOCTO,
            id,
            5 * REWARD + 1,
        );
        assert_eq!(message, "E_FUNDS: insufficient vault balance");
        let carol = snapshot(&t, id, "carol.test");
        let result = try_top_up_at(&mut t, "carol.test", ONE_YOCTO, T1, id, MIN_REWARD);
        let what = "no vault slot";
        assert_top_up_rejected(&t, what, "E_FUNDS", result, (id, "carol.test", &carol));

        // Exactly up to max_reward is fine.
        top_up(&mut t, "bob.test", id, 5 * REWARD);
        fund(&mut t, "bob.test", MAX_REWARD);
        top_up(&mut t, "bob.test", id, MAX_REWARD - 6 * REWARD);
        assert_eq!(view(&t, id).reward, U128(MAX_REWARD));
    }

    #[test]
    fn top_up_respects_limits_as_they_are_now() {
        let mut t = world();
        funder(&mut t, "bob.test", 5 * REWARD);
        let id = post(&mut t, args());
        // The owner narrows the limits below the reward. The task keeps its reward, and takes no
        // more.
        t.put_token(
            acct(USDC),
            TokenConfig {
                min_reward: MIN_REWARD,
                max_reward: REWARD / 2,
                enabled: true,
            },
        );
        let before = snapshot(&t, id, "bob.test");
        let result = try_top_up_at(&mut t, "bob.test", ONE_YOCTO, T1, id, MIN_REWARD);
        let what = "limits narrowed below the reward";
        assert_top_up_rejected(&t, what, "E_REWARD", result, (id, "bob.test", &before));
        assert_eq!(view(&t, id).reward, U128(REWARD));

        // A max_reward above MAX_REWARD_LIMIT, which `set_token` refuses to set, still does not
        // let a top-up take a reward past it: a reward past it could not be picked.
        t.put_token(
            acct(USDC),
            TokenConfig {
                min_reward: MIN_REWARD,
                max_reward: u128::MAX,
                enabled: true,
            },
        );
        fund(&mut t, "bob.test", MAX_REWARD_LIMIT);
        let to_the_limit = MAX_REWARD_LIMIT - REWARD;
        let before = snapshot(&t, id, "bob.test");
        let result = try_top_up_at(&mut t, "bob.test", ONE_YOCTO, T1, id, to_the_limit + 1);
        let what = "past MAX_REWARD_LIMIT";
        assert_top_up_rejected(&t, what, "E_REWARD", result, (id, "bob.test", &before));
        top_up(&mut t, "bob.test", id, to_the_limit);
        assert_eq!(view(&t, id).reward, U128(MAX_REWARD_LIMIT));
    }

    #[test]
    fn top_up_rules_are_checked_in_the_listed_order() {
        // bob tops up in a way that breaks every rule it can at once. Each step mends the rule
        // that was reported, so the next one in the list has to be the next one reported.
        struct Call {
            id: u64,
            now: u64,
            amount: u128,
            deposit: NearToken,
        }
        type Mend = fn(&mut Tender, &mut Call);
        let mut t = world();
        let id = post(&mut t, args());
        assert_eq!(id, 1);
        // The task is full: alice and 49 others.
        for i in 1..MAX_FUNDERS {
            let name = format!("funder{i}.test");
            funder(&mut t, &name, MIN_REWARD);
            top_up(&mut t, &name, id, MIN_REWARD);
        }
        // bob holds one unit less than he tops up.
        funder(&mut t, "bob.test", 999);
        let deadline = t.tasks.get(&id).unwrap().commit_deadline;
        t.paused = true;
        t.tasks.get_mut(&id).unwrap().outcome = Some(Outcome::Voided {
            reason: VoidReason::NoReveals,
            scorecard_hash: None,
            scorecard_uri: None,
        });
        t.put_token(acct(USDC), usdc(false));
        let mut call = Call {
            id: 99,
            now: deadline,
            amount: MAX_REWARD,
            deposit: NO_DEPOSIT,
        };
        let steps: [(&str, Mend); 9] = [
            ("E_PAUSED", |t, _| t.paused = false),
            ("E_NOT_FOUND", |_, c| c.id = 1),
            ("E_PHASE", |_, c| c.now = T1),
            ("E_SETTLED", |t, _| {
                t.tasks.get_mut(&1).unwrap().outcome = None
            }),
            ("E_LIMIT", |t, _| {
                // One funder fewer, and its money out of the reward with it.
                let task = t.tasks.get_mut(&1).unwrap();
                let (_, paid) = task.funders.pop().unwrap();
                task.reward -= paid;
            }),
            ("E_TOKEN", |t, _| t.put_token(acct(USDC), usdc(true))),
            ("E_REWARD", |_, c| c.amount = 1_000),
            ("E_AUTH", |_, c| c.deposit = ONE_YOCTO),
            ("E_FUNDS", |t, _| fund(t, "bob.test", 1)),
        ];
        for (code, mend) in steps {
            let result = try_top_up_at(
                &mut t,
                "bob.test",
                call.deposit,
                call.now,
                call.id,
                call.amount,
            );
            let message = result.expect_err(&format!("{code}: expected it, but it went through"));
            assert!(
                message.starts_with(&format!("{code}: ")),
                "expected {code}, got {message:?}"
            );
            assert!(get_logs().is_empty(), "{code}: a rejection logs nothing");
            mend(&mut t, &mut call);
        }
        assert_eq!(
            try_top_up_at(
                &mut t,
                "bob.test",
                call.deposit,
                call.now,
                call.id,
                call.amount
            ),
            Ok(())
        );
        assert_eq!(balance(&t, "bob.test"), 0);
        let v = view(&t, id);
        assert_eq!(v.funders.len(), MAX_FUNDERS);
        assert_eq!(
            v.funders[MAX_FUNDERS - 1],
            funders(&[("bob.test", 1_000)])[0]
        );
    }

    #[test]
    fn top_up_needs_storage_only_for_a_new_funder_record() {
        let mut t = world();
        let id = post(&mut t, args());
        // With exactly the bytes of his record to spare, bob's first top-up goes through and
        // leaves him none.
        funder(&mut t, "bob.test", REWARD);
        leave_spare(&mut t, "bob.test", funder_bytes("bob.test"));
        top_up(&mut t, "bob.test", id, REWARD);
        assert_eq!(t.storage_available(&acct("bob.test")), 0);

        // One byte short, carol's is refused. The mocked VM does not revert a failed call's
        // writes the way the chain does, so the test stops here for her (the sandbox suite and
        // the property harness see the revert).
        funder(&mut t, "carol.test", REWARD);
        leave_spare(&mut t, "carol.test", funder_bytes("carol.test") - 1);
        let result = try_top_up_at(&mut t, "carol.test", ONE_YOCTO, T1, id, REWARD);
        assert_eq!(
            result,
            Err("E_STORAGE: insufficient storage balance; call storage_deposit".to_string())
        );
        assert!(get_logs().is_empty(), "a rejection logs nothing");
    }

    #[test]
    fn top_up_spends_predecessor_not_signer() {
        let mut t = world();
        let id = post(&mut t, args());
        funder(&mut t, "bob.test", REWARD);
        // mallory has a storage balance and nothing in her vault.
        register(&mut t, "mallory.test", NearToken::from_millinear(100));
        let mallory_used = used(&t, "mallory.test");

        // mallory signs a transaction whose call reaches Tender from bob. bob is the funder: he
        // pays the amount and the storage of his record.
        testing_env!(ctx("bob.test")
            .signer_account_id(acct("mallory.test"))
            .attached_deposit(ONE_YOCTO)
            .block_timestamp(T1)
            .build());
        t.top_up_task(U64(id), U128(REWARD));
        assert_eq!(
            view(&t, id).funders,
            funders(&[("alice.test", REWARD), ("bob.test", REWARD)])
        );
        assert_eq!(balance(&t, "bob.test"), 0);
        assert_eq!(
            used(&t, "mallory.test"),
            mallory_used,
            "the signer pays nothing"
        );

        // The other way round: bob signs and the call comes from mallory, whose vault is empty.
        fund(&mut t, "bob.test", REWARD);
        testing_env!(ctx("mallory.test")
            .signer_account_id(acct("bob.test"))
            .attached_deposit(ONE_YOCTO)
            .block_timestamp(T1)
            .build());
        let rejected = panic_message(|| t.top_up_task(U64(id), U128(REWARD)));
        assert!(
            rejected
                .as_ref()
                .is_some_and(|m| m.starts_with("E_FUNDS: ")),
            "{rejected:?}"
        );
        assert_eq!(balance(&t, "bob.test"), REWARD);
        assert_eq!(view(&t, id).reward, U128(2 * REWARD));
    }

    /// What `top_up_task`'s generated wasm wrapper parses `env::input()` into, mirrored as
    /// `Input` mirrors `post_task`'s: `#[deny_unknown_arguments]` makes it `deny_unknown_fields`.
    #[derive(Debug, PartialEq, near_sdk::serde::Deserialize)]
    #[serde(crate = "near_sdk::serde", deny_unknown_fields)]
    struct TopUpInput {
        task_id: U64,
        amount: U128,
    }

    fn parse_top_up(input: &Value) -> Result<TopUpInput, String> {
        serde_json::from_slice(&serde_json::to_vec(input).unwrap()).map_err(|e| e.to_string())
    }

    #[test]
    fn top_up_args_wire_form() {
        // As a client sends them: both are decimal strings.
        assert_eq!(
            parse_top_up(&json!({ "task_id": "7", "amount": "500000" })),
            Ok(TopUpInput {
                task_id: U64(7),
                amount: U128(500_000),
            })
        );
        // A JSON number is refused for either.
        for input in [
            json!({ "task_id": 7, "amount": "500000" }),
            json!({ "task_id": "7", "amount": 500_000 }),
        ] {
            let message = parse_top_up(&input).unwrap_err();
            assert!(message.contains("expected a string"), "{input}: {message}");
        }
        // Both are required.
        let message = parse_top_up(&json!({ "task_id": "7" })).unwrap_err();
        assert!(message.contains("missing field `amount`"), "{message}");
        // And a key it does not take is an error, not a choice nobody made: a top-up has no
        // token of its own, it is always in the task's.
        let input = json!({ "task_id": "7", "amount": "1", "token": "usdc.test" });
        let message = parse_top_up(&input).unwrap_err();
        assert!(message.contains("unknown field `token`"), "{message}");
    }

    // Lineage: a sub-task names the task its poster has entered.

    const NO_PARENT: &str = "E_PARENT: parent not found";
    const SETTLED_PARENT: &str = "E_PARENT: parent is already settled";
    const NO_ENTRY: &str = "E_PARENT: poster has no entry on parent";
    const TOO_LATE: &str = "E_PARENT: child must settle before parent commit deadline";

    /// A parent task: a commit window of 180 s, which a `child` posted at the same block time
    /// ends its pick window at exactly.
    fn parent() -> PostTaskArgs {
        PostTaskArgs {
            commit_secs: 180,
            ..args()
        }
    }

    /// A sub-task of task 1 with the shortest windows the unit-test world allows, 60 s each, so
    /// that its pick window ends 180 s after it is posted.
    fn child() -> PostTaskArgs {
        PostTaskArgs {
            commit_secs: 60,
            reveal_secs: 60,
            pick_secs: 60,
            fallback_secs: 60,
            parent: Some(U64(1)),
            ..args()
        }
    }

    /// `who` enters task `id` at block time `now`, which must go through. The commitment is any
    /// 32 bytes: the contract only checks it against a reveal.
    fn enter_at(t: &mut Tender, who: &str, now: u64, id: u64) {
        testing_env!(ctx(who).block_timestamp(now).build());
        if let Some(message) = panic_message(|| t.commit(U64(id), CRITERIA_HASH.to_string())) {
            panic!("{who} could not enter task {id}: {message}");
        }
    }

    /// Asserts that `who` posting `task` at block time `now`, with 1 yoctoNEAR, is rejected with
    /// exactly `message`, that it logged nothing, and that it left the number of tasks and `who`'s
    /// vault and storage as they were.
    fn assert_child_rejected(
        t: &mut Tender,
        what: &str,
        who: &str,
        now: u64,
        task: PostTaskArgs,
        message: &str,
    ) {
        let state = |t: &Tender| {
            (
                t.task_count(),
                balance(t, who),
                t.storage_balance_of(acct(who)),
            )
        };
        let before = state(t);
        let result = try_post_at(t, who, ONE_YOCTO, now, task);
        assert_eq!(result, Err(message.to_string()), "{what}");
        assert!(get_logs().is_empty(), "{what}: a rejection logs nothing");
        assert_eq!(state(t), before, "{what}: a rejection changes nothing");
    }

    #[test]
    fn child_requires_entry_on_parent() {
        let mut t = world();
        for who in ["bob.test", "carol.test", "judge.test"] {
            funder(&mut t, who, 5 * REWARD);
        }
        let parent_id = post(
            &mut t,
            PostTaskArgs {
                verifier: Some(acct("judge.test")),
                ..parent()
            },
        );
        let other = post(&mut t, args());
        assert_eq!((parent_id, other), (1, 2));

        // Only an account that has entered task 1 can name it. A stranger cannot, and neither
        // can the parent's poster or its verifier, who can never enter it.
        for (what, who) in [
            ("a stranger", "bob.test"),
            ("the parent's poster", "alice.test"),
            ("the parent's verifier", "judge.test"),
        ] {
            assert_child_rejected(&mut t, what, who, T1, child(), NO_ENTRY);
        }
        // An entry on another task is not an entry on the parent.
        enter_at(&mut t, "bob.test", T1, other);
        assert_child_rejected(
            &mut t,
            "an entry elsewhere",
            "bob.test",
            T1,
            child(),
            NO_ENTRY,
        );

        // carol enters it, and then she can name it. bob still cannot.
        enter_at(&mut t, "carol.test", T1, parent_id);
        assert_child_rejected(&mut t, "bob, later", "bob.test", T1, child(), NO_ENTRY);
        let funds = balance(&t, "carol.test");
        let id = try_post_at(&mut t, "carol.test", ONE_YOCTO, T1, child())
            .expect("carol has an entry on task 1");
        assert_eq!(id, 3);
        let task = view(&t, id);
        assert_eq!(task.parent, Some(U64(1)));
        assert_eq!(task.poster, acct("carol.test"));
        assert_eq!(task.verifier, acct("carol.test"));
        assert_eq!(balance(&t, "carol.test"), funds - REWARD);
        let logs = get_logs();
        assert_eq!(logs.len(), 1, "{logs:?}");
        assert!(logs[0].contains(r#""parent":"1""#), "{logs:?}");
        // The parent is as it was: a child adds nothing to it.
        let parent_task = view(&t, parent_id);
        assert_eq!(
            (parent_task.reward, parent_task.commit_count),
            (U128(REWARD), 1)
        );

        // Entering again replaces the commitment; it is still an entry.
        enter_at(&mut t, "carol.test", T1, parent_id);
        assert_eq!(
            try_post_at(&mut t, "carol.test", ONE_YOCTO, T1, child()),
            Ok(4)
        );

        // The poster is the predecessor, never the signer: bob's key signing a call that reaches
        // Tender from carol is carol's entry, and carol's key signing bob's call is bob's.
        testing_env!(ctx("carol.test")
            .signer_account_id(acct("bob.test"))
            .attached_deposit(ONE_YOCTO)
            .block_timestamp(T1)
            .build());
        assert_eq!(t.post_task(child()), U64(5));
        testing_env!(ctx("bob.test")
            .signer_account_id(acct("carol.test"))
            .attached_deposit(ONE_YOCTO)
            .block_timestamp(T1)
            .build());
        let message = panic_message(|| {
            t.post_task(child());
        });
        assert_eq!(message.as_deref(), Some(NO_ENTRY));
        assert_eq!(t.task_count(), U64(5));
    }

    #[test]
    fn child_must_settle_before_parent_commit_deadline() {
        // I12. The parent's commit window is 180 s, so it ends at `deadline`.
        let mut t = world();
        funder(&mut t, "bob.test", 20 * REWARD);
        funder(&mut t, "carol.test", 20 * REWARD);
        post(&mut t, parent());
        let deadline = T1 + 180 * SEC;
        assert_eq!(view(&t, 1).commit_deadline, U64(deadline));
        enter_at(&mut t, "carol.test", T1, 1);

        // A pick window that ends on the deadline is in time: the deadline is the latest.
        assert_eq!(
            try_post_at(&mut t, "carol.test", ONE_YOCTO, T1, child()),
            Ok(2)
        );
        assert_eq!(view(&t, 2).pick_deadline, U64(deadline));
        // One nanosecond later in the block, or one second more in the pick window, is not.
        assert_child_rejected(
            &mut t,
            "a nanosecond late",
            "carol.test",
            T1 + 1,
            child(),
            TOO_LATE,
        );
        let long_pick = PostTaskArgs {
            pick_secs: 61,
            ..child()
        };
        assert_child_rejected(
            &mut t,
            "a longer pick window",
            "carol.test",
            T1,
            long_pick,
            TOO_LATE,
        );
        // Every window counts, and the fallback window does not: it ends the child, not its pick.
        let long_commit = PostTaskArgs {
            commit_secs: 61,
            ..child()
        };
        assert_child_rejected(
            &mut t,
            "a longer commit window",
            "carol.test",
            T1,
            long_commit,
            TOO_LATE,
        );
        let long_reveal = PostTaskArgs {
            reveal_secs: 61,
            ..child()
        };
        assert_child_rejected(
            &mut t,
            "a longer reveal window",
            "carol.test",
            T1,
            long_reveal,
            TOO_LATE,
        );
        let long_fallback = PostTaskArgs {
            fallback_secs: MAX_WINDOW_SECS,
            ..child()
        };
        assert_eq!(
            try_post_at(&mut t, "carol.test", ONE_YOCTO, T1, long_fallback),
            Ok(3)
        );
        // The windows a task gets by default are far too long.
        let defaults = PostTaskArgs {
            parent: Some(U64(1)),
            ..args()
        };
        assert_child_rejected(
            &mut t,
            "the default windows",
            "carol.test",
            T1,
            defaults,
            TOO_LATE,
        );
        let huge = PostTaskArgs {
            commit_secs: MAX_WINDOW_SECS,
            reveal_secs: MAX_WINDOW_SECS,
            pick_secs: MAX_WINDOW_SECS,
            ..child()
        };
        assert_child_rejected(
            &mut t,
            "the longest windows",
            "carol.test",
            T1,
            huge,
            TOO_LATE,
        );

        // The rule holds at every level. Task 4 has a commit window of 3600 s. Its child, task 5,
        // has one of 600 s, and ends its pick window 720 s in, in time. A child of task 5 must
        // end its own pick window before task 5's commit deadline, 600 s in.
        post(
            &mut t,
            PostTaskArgs {
                commit_secs: 3_600,
                ..args()
            },
        );
        enter_at(&mut t, "carol.test", T1, 4);
        let middle = PostTaskArgs {
            commit_secs: 600,
            parent: Some(U64(4)),
            ..child()
        };
        assert_eq!(
            try_post_at(&mut t, "carol.test", ONE_YOCTO, T1, middle),
            Ok(5)
        );
        enter_at(&mut t, "bob.test", T1, 5);
        let grandchild = |commit_secs| PostTaskArgs {
            commit_secs,
            parent: Some(U64(5)),
            ..child()
        };
        // 480 + 60 + 60 = 600 s ends with task 5's commit window; 481 s does not.
        assert_eq!(
            try_post_at(&mut t, "bob.test", ONE_YOCTO, T1, grandchild(480)),
            Ok(6)
        );
        assert_child_rejected(
            &mut t,
            "a grandchild too late",
            "bob.test",
            T1,
            grandchild(481),
            TOO_LATE,
        );
        assert_eq!(view(&t, 6).parent, Some(U64(5)));
    }

    #[test]
    fn parent_must_exist_and_be_open() {
        let mut t = world();
        funder(&mut t, "bob.test", 20 * REWARD);
        funder(&mut t, "carol.test", 20 * REWARD);
        let named = |id| PostTaskArgs {
            parent: Some(U64(id)),
            ..child()
        };

        // There is no task yet, so none can be named: not 1, not 0, not the largest id.
        for id in [1, 0, u64::MAX] {
            assert_child_rejected(&mut t, "no tasks", "carol.test", T1, named(id), NO_PARENT);
        }
        post(&mut t, parent());
        // The next id is not a task either: a task cannot be its own parent.
        assert_child_rejected(&mut t, "the next id", "carol.test", T1, named(2), NO_PARENT);
        assert_child_rejected(&mut t, "id 0", "carol.test", T1, named(0), NO_PARENT);
        enter_at(&mut t, "carol.test", T1, 1);
        assert_eq!(
            try_post_at(&mut t, "carol.test", ONE_YOCTO, T1, named(1)),
            Ok(2)
        );

        // The parent's commit window is over. carol entered it, and it is not settled, but a
        // sub-task can no longer end its pick window before the deadline.
        let deadline = T1 + 180 * SEC;
        assert_child_rejected(
            &mut t,
            "at the commit deadline",
            "carol.test",
            deadline,
            named(1),
            TOO_LATE,
        );
        let reveal_deadline = view(&t, 1).reveal_deadline.0;
        assert_child_rejected(
            &mut t,
            "when judging",
            "carol.test",
            reveal_deadline,
            named(1),
            TOO_LATE,
        );

        // Once the parent is settled it is not open, and says so. Nobody revealed, so the keeper
        // voids it at the reveal deadline.
        testing_env!(ctx("keeper.test").block_timestamp(reveal_deadline).build());
        t.void_task(U64(1));
        assert!(view(&t, 1).outcome.is_some());
        assert_child_rejected(
            &mut t,
            "a voided parent",
            "carol.test",
            reveal_deadline,
            named(1),
            SETTLED_PARENT,
        );
        // A settled task is reported as settled whatever the time: the chain never goes back, but
        // the rule does not depend on the clock.
        assert_child_rejected(
            &mut t,
            "a voided parent, inside its window",
            "carol.test",
            T1,
            named(1),
            SETTLED_PARENT,
        );
        // Task 2, a child of task 1, is a task like any other, and can be named in its turn: its
        // commit window ends 60 s in, so a sub-task of 180 s is too long for it.
        enter_at(&mut t, "bob.test", T1, 2);
        let grandchild = PostTaskArgs {
            parent: Some(U64(2)),
            ..child()
        };
        assert_child_rejected(
            &mut t,
            "a grandchild of the same windows",
            "bob.test",
            T1,
            grandchild,
            TOO_LATE,
        );
    }

    #[test]
    fn parent_rules_are_checked_in_the_listed_order() {
        // Each task below breaks the rule it is named for and every rule after it. It is
        // reported for the first rule it breaks, which is the order of the list: the parent
        // exists, it is not settled, the poster has an entry on it, the windows end in time.
        let mut t = world();
        funder(&mut t, "bob.test", 20 * REWARD);
        funder(&mut t, "carol.test", 20 * REWARD);
        let too_long = |id| PostTaskArgs {
            parent: Some(U64(id)),
            ..args()
        };
        // Task 1 is settled: voided at its reveal deadline with nobody entered. Task 2 is open.
        post(&mut t, parent());
        post(&mut t, parent());
        testing_env!(ctx("keeper.test")
            .block_timestamp(view(&t, 1).reveal_deadline.0)
            .build());
        t.void_task(U64(1));
        enter_at(&mut t, "carol.test", T1, 2);

        assert_child_rejected(&mut t, "no parent", "bob.test", T1, too_long(9), NO_PARENT);
        assert_child_rejected(
            &mut t,
            "settled",
            "bob.test",
            T1,
            too_long(1),
            SETTLED_PARENT,
        );
        assert_child_rejected(&mut t, "no entry", "bob.test", T1, too_long(2), NO_ENTRY);
        assert_child_rejected(&mut t, "too late", "carol.test", T1, too_long(2), TOO_LATE);
        // Mend the last one and it goes through.
        let mended = PostTaskArgs {
            parent: Some(U64(2)),
            ..child()
        };
        assert_eq!(
            try_post_at(&mut t, "carol.test", ONE_YOCTO, T1, mended),
            Ok(3)
        );
    }
}
