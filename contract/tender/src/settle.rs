//! Settling a task: the pick that pays its winners, the empty pick and the void that refund its
//! funders, the payout math, and the cleanup that deletes a settled task's entries.
//!
//! A task settles once, by one of these, and its reward leaves the escrow in that call:
//! - `pick` with winners pays the protocol fee to the treasury, then splits the rest between up
//!   to `max_winners` revealed entrants by basis points;
//! - `pick` with no winners ("no award") refunds every funder exactly what it paid in;
//! - `void_task` does the same refund for a task that nobody revealed in, or that nobody picked
//!   by its fallback deadline. Anyone may call it, so a reward can never stay locked.
//!
//! Settlement never needs new storage, so it cannot fail for lack of it. Every credit lands in a
//! vault slot that already exists: a funder's, which it paid from; a winner's, made when it
//! committed; the treasury's, made when its token was allowlisted. The only record that grows is
//! the task's, by its outcome, and the poster reserved the bytes for that when it posted.
//!
//! Once a task is settled, `cleanup` deletes its entries in bounded batches and gives each
//! entrant back the storage its entry used. Anyone may call it, so the storage never stays
//! charged for good. The task's record and every payout slot are kept.

use near_sdk::json_types::{U128, U64};
use near_sdk::{env, near, AccountId};

use crate::events::{emit, Refund, TaskPicked, TaskVoided};
use crate::tasks::{no_task, phase};
use crate::types::{
    check_uri, err, hex32, parse_hash, Outcome, Payout, PayoutView, Phase, Task, VoidReason,
    WinnerArg, MAX_PAGE, OUTCOME_RESERVE_BYTES,
};
use crate::{Tender, TenderExt};

/// Basis points in a whole. The winners' shares of one pick add up to exactly this.
const BPS_WHOLE: u32 = 10_000;

fn already_settled(task_id: u64) -> ! {
    env::panic_str(&format!(
        "{}: task {task_id} is already settled",
        err::E_SETTLED
    ))
}

fn bad_winners(detail: String) -> ! {
    env::panic_str(&format!("{}: {detail}", err::E_WINNERS))
}

#[near]
impl Tender {
    /// Settles task `task_id` by paying `winners` their shares of the reward or, if `winners` is
    /// empty, by awarding nothing and refunding the funders. Each winner is
    /// `{"account": ..., "bps": ...}`. `scorecard_hash` is the SHA-256 of the scorecard behind the
    /// decision, as 64 lowercase hex characters, and `scorecard_uri` is where it can be read.
    ///
    /// The rules, checked in this order, each with its error code:
    /// - the task exists (`E_NOT_FOUND`);
    /// - it is not settled yet (`E_SETTLED`);
    /// - the caller is its verifier or its poster (`E_AUTH`);
    /// - the caller's window is open: the verifier's from `reveal_deadline` up to, but not
    ///   including, `pick_deadline`, and the poster's from there up to, but not including,
    ///   `fallback_deadline`. A poster who is also the verifier has both (`E_PHASE`);
    /// - `scorecard_uri` is 1 to 256 bytes (`E_URI`);
    /// - `scorecard_hash` is 64 lowercase hex characters (`E_HASH`);
    /// - a non-empty `winners` has at most `max_winners` entries, each naming a different account
    ///   that revealed an entry in the task, with a positive `bps`, and the `bps` add up to
    ///   exactly 10_000 (`E_WINNERS`).
    ///
    /// The caller is the predecessor, never the signer.
    ///
    /// A pick takes the fee first, at the `fee_bps` the task was posted with:
    /// `fee = reward * fee_bps / 10_000` goes to the treasury. Each winner gets
    /// `net * bps / 10_000` of the `net = reward - fee` that is left, rounded down, and the first
    /// winner also gets the rounding dust, so the whole reward is paid out (`E_REWARD` if a
    /// product overflows a u128, which no reward up to 3 * 10^34 can make). Each winner that is a
    /// registered agent gets one more `wins` and its amount added to its `earned` in the task's
    /// token, and the caller one more `picks_made`. Emits `picked`.
    ///
    /// An empty `winners` voids the task with the reason `no_award` and the scorecard stored, and
    /// each funder gets back exactly what it paid in. If any entry was revealed, the caller gets
    /// one more `voids_after_reveals`, and no `picks_made`. Emits `voided`, with the caller as
    /// `by`.
    ///
    /// Settling needs nobody's spare storage, so it goes through even when the winners, the
    /// funders and the poster have none: everyone paid already has a vault slot for the token,
    /// and the outcome is charged to the poster out of what it reserved when it posted (see
    /// `write_outcome`). For the same reason `earned` is kept only in the slot an agent got when
    /// it committed, so an agent that registered after committing is counted a win but not the
    /// amount.
    ///
    /// Picks work while the contract is paused, and attach no deposit, so a function-call key can
    /// send them.
    #[deny_unknown_arguments]
    pub fn pick(
        &mut self,
        task_id: U64,
        winners: Vec<WinnerArg>,
        scorecard_hash: String,
        scorecard_uri: String,
    ) {
        let caller = env::predecessor_account_id();
        let id = task_id.0;
        let mut task = self.tasks.get(&id).cloned().unwrap_or_else(|| no_task(id));
        let current = phase(&task, env::block_timestamp());
        if current == Phase::Settled {
            already_settled(id);
        }
        if caller != task.verifier && caller != task.poster {
            env::panic_str(&format!(
                "{}: only the verifier or the poster can pick task {id}",
                err::E_AUTH
            ));
        }
        // A poster who is also the verifier passes in both windows.
        let in_window = match current {
            Phase::Judging => caller == task.verifier,
            Phase::Fallback => caller == task.poster,
            _ => false,
        };
        if !in_window {
            env::panic_str(&format!(
                "{}: task {id} is not in {caller}'s pick window",
                err::E_PHASE
            ));
        }
        check_uri("scorecard_uri", &scorecard_uri);
        let scorecard_hash = parse_hash("scorecard_hash", &scorecard_hash);

        if winners.is_empty() {
            // Every rule has been checked.
            if task.reveal_count > 0 {
                self.with_profile(&caller, |p| {
                    p.voids_after_reveals = p.voids_after_reveals.saturating_add(1)
                });
            }
            self.void(
                task,
                VoidReason::NoAward,
                Some(caller),
                Some((scorecard_hash, scorecard_uri)),
            );
            return;
        }

        self.check_winners(&task, &winners);
        let bps: Vec<u16> = winners.iter().map(|w| w.bps).collect();
        let (fee, amounts) = split_reward(task.reward, task.fee_bps, &bps);
        let payouts: Vec<Payout> = winners
            .into_iter()
            .zip(amounts)
            .map(|(w, amount)| Payout {
                account: w.account,
                bps: w.bps,
                amount,
            })
            .collect();

        // Every rule has been checked and every amount is known. What follows credits slots that
        // exist and records what was paid.
        let token = task.token.clone();
        // The treasury has a slot for every allowlisted token: `set_token` makes it when the token
        // is allowlisted, and `set_fee` makes the new treasury's before it switches.
        let treasury = self.treasury.clone();
        self.credit(&treasury, &token, fee);
        for p in &payouts {
            // A winner's slot was made when it committed.
            self.credit(&p.account, &token, p.amount);
            self.with_profile(&p.account, |profile| {
                profile.wins = profile.wins.saturating_add(1);
                // Only an existing `earned` slot is updated. Adding one would add storage.
                if let Some((_, earned)) = profile.earned.iter_mut().find(|(t, _)| *t == token) {
                    *earned = earned.saturating_add(p.amount);
                }
            });
        }
        self.with_profile(&caller, |p| p.picks_made = p.picks_made.saturating_add(1));
        let event = TaskPicked {
            task_id,
            by: caller,
            winners: payouts.iter().map(PayoutView::from).collect(),
            fee: U128(fee),
            scorecard_hash: hex32(&scorecard_hash),
            scorecard_uri: scorecard_uri.clone(),
        };
        self.write_outcome(
            &mut task,
            Outcome::Picked {
                winners: payouts,
                fee,
                scorecard_hash,
                scorecard_uri,
            },
        );
        emit("picked", &event);
    }

    /// Voids task `task_id` and refunds each of its funders exactly what it paid in. Anyone may
    /// call it, so a reward never stays locked.
    ///
    /// The rules, checked in this order, each with its error code:
    /// - the task exists (`E_NOT_FOUND`);
    /// - it is not settled yet (`E_SETTLED`);
    /// - its reveal window is over with nothing revealed, which voids it as `no_reveals`, or its
    ///   fallback window is over, which voids it as `expired` (`E_PHASE` until one of them holds).
    ///   A task with nothing revealed is voided as `no_reveals` after its fallback deadline too.
    ///
    /// Like a pick, a void needs nobody's spare storage. Emits `voided`, with `by` and the
    /// scorecard `null`. Voids work while the contract is paused, and attach no deposit, so a
    /// function-call key can send them.
    #[deny_unknown_arguments]
    pub fn void_task(&mut self, task_id: U64) {
        let id = task_id.0;
        let task = self.tasks.get(&id).cloned().unwrap_or_else(|| no_task(id));
        let reason = match (phase(&task, env::block_timestamp()), task.reveal_count) {
            (Phase::Settled, _) => already_settled(id),
            (Phase::Judging | Phase::Fallback | Phase::Expired, 0) => VoidReason::NoReveals,
            (Phase::Expired, _) => VoidReason::Expired,
            _ => env::panic_str(&format!("{}: task {id} cannot be voided yet", err::E_PHASE)),
        };
        self.void(task, reason, None, None);
    }

    /// Deletes the next `limit` entries of settled task `task_id`, and gives each entrant back
    /// the storage its entry used. Anyone may call it, so the storage never stays charged for
    /// good, and the keeper runs it. Returns how many entries the call went through, which is 0
    /// once the task has none left.
    ///
    /// The rules, checked in this order, each with its error code:
    /// - the task exists (`E_NOT_FOUND`);
    /// - it is settled, by a pick or a void (`E_PHASE`);
    /// - `limit` is 1 to 50 (`E_LIMIT`).
    ///
    /// The task counts the entries gone through in `cleaned`. A call takes the indices of the
    /// entrant order from there, `limit` of them or the rest if fewer are left, and adds their
    /// number to `cleaned`. For each index it removes the entry, revealed or not, and its place
    /// in the entrant order, and credits that entrant's storage balance with exactly the bytes
    /// the two records freed and no one else's. An index whose place is gone already is skipped,
    /// and counts all the same.
    ///
    /// The task's record is kept, with its outcome, and so is every vault slot and every `earned`
    /// slot: the slots an entrant got when it committed stay charged to it, and a winner's payout
    /// stays where `pick` put it. Emits nothing.
    ///
    /// Cleanups work while the contract is paused, and attach no deposit, so a function-call key
    /// can send them.
    #[deny_unknown_arguments]
    pub fn cleanup(&mut self, task_id: U64, limit: u32) -> u32 {
        let id = task_id.0;
        let task = self.tasks.get(&id).unwrap_or_else(|| no_task(id));
        if task.outcome.is_none() {
            env::panic_str(&format!("{}: not settled", err::E_PHASE));
        }
        if !(1..=MAX_PAGE).contains(&limit) {
            env::panic_str(&format!(
                "{}: limit must be 1 to {MAX_PAGE}, got {limit}",
                err::E_LIMIT
            ));
        }

        // Every rule has been checked. With no entry left, the call ends here and writes nothing.
        let first = task.cleaned;
        let end = first.saturating_add(limit).min(task.commit_count);
        if end <= first {
            return 0;
        }
        for index in first..end {
            // One storage window per entrant, so that each is refunded the bytes its own records
            // free and no more. The collections defer their removes, and `storage_mark` and
            // `settle_storage` flush them, which is what lets the window see them.
            let before = self.storage_mark();
            // A place that is gone leaves nothing to remove and nobody to refund.
            let Some(account) = self.entrant_at.get(&(id, index)).cloned() else {
                continue;
            };
            self.entrant_at.remove(&(id, index));
            self.entries.remove(&(id, account.clone()));
            // Removing frees bytes, so this only refunds and cannot fail: the entrant had a
            // storage balance when it committed, and a balance is never deleted.
            self.settle_storage(&account, before);
        }
        let n = end - first;
        let task = self.tasks.get_mut(&id).unwrap_or_else(|| no_task(id));
        task.cleaned += n;
        n
    }
}

impl Tender {
    /// Credits each funder of `t` exactly what it paid into the escrow, in the task's token, and
    /// returns the refunds for the `voided` event. Each funder paid from its own vault slot, so
    /// the slot exists.
    pub(crate) fn refund_funders(&mut self, t: &Task) -> Vec<Refund> {
        t.funders
            .iter()
            .map(|(account, amount)| {
                self.credit(account, &t.token, *amount);
                Refund {
                    account: account.clone(),
                    amount: U128(*amount),
                }
            })
            .collect()
    }

    /// Stores `o` as the outcome of `t`, and charges the poster for its bytes in place of the
    /// `OUTCOME_RESERVE_BYTES` it reserved when it posted.
    ///
    /// Only the outcome's write is measured, between two `storage_mark`s: the rest of settling
    /// changes no record's size. The reserve is released and the measured bytes are charged with
    /// no availability check, since the reserve paid for them: an outcome takes at most 743 bytes
    /// (the test `max_outcome_fits_reserve`). So a poster with no storage to spare can still be
    /// settled, and gets back what its outcome did not use.
    pub(crate) fn write_outcome(&mut self, t: &mut Task, o: Outcome) {
        let before = self.storage_mark();
        t.outcome = Some(o);
        self.tasks.insert(t.id, t.clone());
        let grown = self.storage_mark().saturating_sub(before);
        self.release_bytes(&t.poster, OUTCOME_RESERVE_BYTES);
        self.add_used_bytes_unchecked(&t.poster, grown);
    }

    /// Voids `task` for `reason`: refunds its funders, stores the outcome and emits `voided`.
    /// `by` and `scorecard` are those of the empty pick that voids it, or `None` for `void_task`.
    fn void(
        &mut self,
        mut task: Task,
        reason: VoidReason,
        by: Option<AccountId>,
        scorecard: Option<([u8; 32], String)>,
    ) {
        let refunds = self.refund_funders(&task);
        let (scorecard_hash, scorecard_uri) = scorecard.unzip();
        let event = TaskVoided {
            task_id: U64(task.id),
            reason,
            by,
            refunds,
            scorecard_hash: scorecard_hash.as_ref().map(hex32),
            scorecard_uri: scorecard_uri.clone(),
        };
        self.write_outcome(
            &mut task,
            Outcome::Voided {
                reason,
                scorecard_hash,
                scorecard_uri,
            },
        );
        emit("voided", &event);
    }

    /// Panics `E_WINNERS` unless the non-empty `winners` can be paid in `t`: at most
    /// `max_winners` of them, each a different account that revealed an entry in `t`, with a
    /// positive `bps`, and the `bps` adding up to exactly 10_000.
    fn check_winners(&self, t: &Task, winners: &[WinnerArg]) {
        if winners.len() > usize::from(t.max_winners) {
            bad_winners(format!(
                "task {} pays at most {} winners, got {}",
                t.id,
                t.max_winners,
                winners.len()
            ));
        }
        // At most 5 winners, so the duplicate check is at most 10 comparisons and the sum, taken
        // in a u32, cannot wrap.
        let mut total = 0u32;
        for (i, w) in winners.iter().enumerate() {
            let account = &w.account;
            if w.bps == 0 {
                bad_winners(format!("{account} has a bps of 0"));
            }
            if winners[..i]
                .iter()
                .any(|earlier| earlier.account == *account)
            {
                bad_winners(format!("{account} is named twice"));
            }
            let revealed = self
                .entries
                .get(&(t.id, account.clone()))
                .is_some_and(|entry| entry.revealed.is_some());
            if !revealed {
                bad_winners(format!("{account} has no revealed entry in task {}", t.id));
            }
            total += u32::from(w.bps);
        }
        if total != BPS_WHOLE {
            bad_winners(format!("the bps add up to {total}, not {BPS_WHOLE}"));
        }
    }
}

/// Splits a pick's `reward` into the fee and the winners' amounts, in the order of `bps`.
///
/// The fee is `reward * fee_bps / 10_000`, and each amount `net * bps / 10_000` of the
/// `net = reward - fee` that the fee leaves, all rounded down. The amounts then fall short of
/// `net` by less than one unit per winner, and that dust goes to the first winner, so the fee and
/// the amounts add up to `reward` exactly. `bps` must be non-empty and add up to 10_000, as `pick`
/// has checked. Panics `E_REWARD` if a product overflows a u128.
pub(crate) fn split_reward(reward: u128, fee_bps: u16, bps: &[u16]) -> (u128, Vec<u128>) {
    let fee = bps_of(reward, fee_bps);
    // `fee_bps` is at most `MAX_FEE_BPS`, so the fee is at most a tenth of the reward.
    let net = reward - fee;
    let mut amounts: Vec<u128> = bps.iter().map(|&b| bps_of(net, b)).collect();
    // Each amount is rounded down from its exact share and the shares add up to `net`, so the
    // amounts add up to at most `net`.
    let dust = net - amounts.iter().sum::<u128>();
    if let Some(first) = amounts.first_mut() {
        *first += dust;
    }
    (fee, amounts)
}

/// `amount * bps / 10_000`, rounded down. Panics `E_REWARD` if `amount * bps` overflows a u128.
fn bps_of(amount: u128, bps: u16) -> u128 {
    let product = amount.checked_mul(u128::from(bps)).unwrap_or_else(|| {
        env::panic_str(&format!(
            "{}: {amount} at {bps} bps overflows a u128",
            err::E_REWARD
        ))
    });
    product / u128::from(BPS_WHOLE)
}

#[cfg(test)]
mod tests {
    use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
    use near_sdk::json_types::{U128, U64};
    use near_sdk::serde_json::{self, json, Value};
    use near_sdk::test_utils::get_logs;
    use near_sdk::{borsh, env, testing_env, AccountId, NearToken};

    use super::split_reward;
    use crate::entries::commitment_of;
    use crate::test_utils::{ctx, fresh, panic_message};
    use crate::types::{
        hex32, AgentView, Outcome, OutcomeView, PayoutView, Phase, PostTaskArgs, Task,
        TokenBalance, VoidReason, WinnerArg, MAX_URI_BYTES, OUTCOME_RESERVE_BYTES,
    };
    use crate::Tender;

    const USDC: &str = "usdc.test";
    const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
    /// The block time the tests post at: above 2^53 nanoseconds, which a JSON number could not
    /// carry.
    const T1: u64 = 1_793_028_278_935_742_660;
    const SEC: u64 = 1_000_000_000;
    /// The deadlines of the default task posted at `T1`: windows of 60 s to commit, 120 s to
    /// reveal, 180 s for the verifier to pick and 240 s for the poster's fallback.
    const COMMIT_DEADLINE: u64 = T1 + 60 * SEC;
    const REVEAL_DEADLINE: u64 = T1 + 180 * SEC;
    const PICK_DEADLINE: u64 = T1 + 360 * SEC;
    const FALLBACK_DEADLINE: u64 = T1 + 600 * SEC;
    /// What alice, the poster, holds in her vault at the start: 100 USDC.
    const FUNDS: u128 = 100_000_000;
    /// The reward of the default task: 1 USDC. The fee of 500 bps leaves 950_000 to the winners.
    const REWARD: u128 = 1_000_000;
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
    /// The verifier of the default task.
    const JUDGE: &str = "judge.test";
    /// The treasury that `fresh` configures.
    const TREASURY: &str = "treasury.test";
    /// An account with no part in any task, as the keeper that voids tasks is.
    const KEEPER: &str = "keeper.test";
    /// The agents in every test world, each with a storage balance and an empty vault.
    const AGENTS: [&str; 5] = [
        "bob.test",
        "carol.test",
        "dave.test",
        "erin.test",
        "frank.test",
    ];

    /// Winners as the tests write them: `(account, bps)` pairs.
    type Shares<'a> = &'a [(&'a str, u16)];

    fn acct(id: &str) -> AccountId {
        id.parse().unwrap()
    }

    fn byte_cost() -> u128 {
        env::storage_byte_cost().as_yoctonear()
    }

    /// A task that meets every rule: 1 USDC, windows of 60, 120, 180 and 240 seconds, open to
    /// anyone, up to five winners, and `JUDGE` as the verifier.
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
            max_winners: 5,
            invited: vec![],
            parent: None,
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

    /// A contract with USDC enabled and a USDC vault slot for the treasury, both made by the
    /// owner's `set_token`, which the owner's 1 NEAR of storage pays for; alice, the poster, with
    /// 1 NEAR of storage and `FUNDS` in her vault; and the judge and each of `AGENTS` with 0.1 NEAR
    /// of storage and no vault slot.
    fn world() -> Tender {
        let mut t = fresh();
        register(&mut t, "owner.test", NearToken::from_near(1));
        testing_env!(ctx("owner.test").attached_deposit(ONE_YOCTO).build());
        t.set_token(acct(USDC), U128(10), U128(50_000_000), true);
        register(&mut t, "alice.test", NearToken::from_near(1));
        fund(&mut t, "alice.test", FUNDS);
        for who in AGENTS.into_iter().chain([JUDGE]) {
            register(&mut t, who, NearToken::from_millinear(100));
        }
        t
    }

    /// alice posts `task` at `T1`. Returns its id.
    fn post(t: &mut Tender, task: PostTaskArgs) -> u64 {
        testing_env!(ctx("alice.test")
            .attached_deposit(ONE_YOCTO)
            .block_timestamp(T1)
            .build());
        t.post_task(task).0
    }

    /// `who` registers as an agent.
    fn register_agent(t: &mut Tender, who: &str) {
        testing_env!(ctx(who).block_timestamp(T1).build());
        t.register_agent(
            "https://acme.example/agent.json".to_string(),
            BRIEF_HASH.to_string(),
            vec![],
        );
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

    /// Each of `who` enters task `id` and then reveals, with its position in `who` as its seed.
    fn revealed(t: &mut Tender, id: u64, who: &[&str]) {
        for (seed, w) in who.iter().enumerate() {
            enter(t, w, id, seed as u8);
        }
        for (seed, w) in who.iter().enumerate() {
            reveal(t, w, id, seed as u8);
        }
    }

    fn winners(list: &[(&str, u16)]) -> Vec<WinnerArg> {
        list.iter()
            .map(|&(account, bps)| WinnerArg {
                account: acct(account),
                bps,
            })
            .collect()
    }

    /// `who` picks `list` as the winners of task `id` at `now`, with the scorecard `hash` and
    /// `uri`. `Err` holds the message the contract panicked with.
    fn try_pick_with(
        t: &mut Tender,
        who: &str,
        id: u64,
        now: u64,
        list: &[(&str, u16)],
        hash: &str,
        uri: &str,
    ) -> Result<(), String> {
        testing_env!(ctx(who).block_timestamp(now).build());
        let (list, hash, uri) = (winners(list), hash.to_string(), uri.to_string());
        match panic_message(|| t.pick(U64(id), list, hash, uri)) {
            Some(message) => Err(message),
            None => Ok(()),
        }
    }

    /// The same, with the default scorecard.
    fn try_pick(
        t: &mut Tender,
        who: &str,
        id: u64,
        now: u64,
        list: &[(&str, u16)],
    ) -> Result<(), String> {
        try_pick_with(t, who, id, now, list, SCORECARD_HASH, SCORECARD_URI)
    }

    /// `who` voids task `id` at `now`. `Err` holds the message the contract panicked with.
    fn try_void(t: &mut Tender, who: &str, id: u64, now: u64) -> Result<(), String> {
        testing_env!(ctx(who).block_timestamp(now).build());
        match panic_message(|| t.void_task(U64(id))) {
            Some(message) => Err(message),
            None => Ok(()),
        }
    }

    /// Asserts that `result` is a rejection with `code` and that the call logged nothing. Returns
    /// the message.
    fn assert_rejected(result: Result<(), String>, code: &str, what: &str) -> String {
        let message = result.expect_err(&format!("{what}: expected {code}, but it went through"));
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

    /// The USDC in the vaults of alice, the treasury and each of `AGENTS`, in that order.
    fn money(t: &Tender) -> Vec<u128> {
        ["alice.test", TREASURY]
            .into_iter()
            .chain(AGENTS)
            .map(|who| balance(t, who))
            .collect()
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

    fn outcome(t: &Tender, id: u64) -> Option<OutcomeView> {
        t.get_task(U64(id)).expect("the task exists").outcome
    }

    /// The Borsh size of task `id`'s outcome, which is what storing it added to the task record:
    /// the record's `None` became `Some`, with the outcome behind the same 1-byte tag.
    fn outcome_bytes(t: &Tender, id: u64) -> u64 {
        let task = t.tasks.get(&id).expect("the task exists");
        let outcome = task.outcome.as_ref().expect("the task is settled");
        borsh::to_vec(outcome).unwrap().len() as u64
    }

    fn agent(t: &Tender, who: &str) -> AgentView {
        t.get_agent(acct(who)).expect("a registered agent")
    }

    fn usdc(amount: u128) -> Vec<TokenBalance> {
        vec![TokenBalance {
            token: acct(USDC),
            amount: U128(amount),
        }]
    }

    fn payout(account: &str, bps: u16, amount: u128) -> PayoutView {
        PayoutView {
            account: acct(account),
            bps,
            amount: U128(amount),
        }
    }

    fn voided(reason: VoidReason, scorecard: bool) -> Option<OutcomeView> {
        Some(OutcomeView::Voided {
            reason,
            scorecard_hash: scorecard.then(|| SCORECARD_HASH.to_string()),
            scorecard_uri: scorecard.then(|| SCORECARD_URI.to_string()),
        })
    }

    fn event(name: &str, data: &str) -> String {
        format!(
            r#"EVENT_JSON:{{"standard":"tender","version":"1.0.0","event":"{name}","data":[{data}]}}"#
        )
    }

    // Payouts.

    #[test]
    fn pick_pays_bps_with_fee_first() {
        let mut t = world();
        let id = post(&mut t, args());
        revealed(&mut t, id, &["bob.test", "carol.test"]);
        // The task keeps the fee it was posted with, whatever the fee is by the time of the pick.
        testing_env!(ctx("owner.test").attached_deposit(ONE_YOCTO).build());
        t.set_fee(1_000, acct(TREASURY));
        try_pick(
            &mut t,
            JUDGE,
            id,
            REVEAL_DEADLINE,
            &[("bob.test", 7_000), ("carol.test", 3_000)],
        )
        .unwrap();
        // 500 bps of the 1_000_000 go to the treasury first, then 7_000 and 3_000 bps of the
        // 950_000 left to the winners.
        assert_eq!(balance(&t, TREASURY), 50_000);
        assert_eq!(balance(&t, "bob.test"), 665_000);
        assert_eq!(balance(&t, "carol.test"), 285_000);
        assert_eq!(balance(&t, "alice.test"), FUNDS - REWARD);
        // The whole reward left the escrow, and nothing else moved.
        assert_eq!(money(&t).iter().sum::<u128>(), FUNDS);
        let v = t.get_task(U64(id)).unwrap();
        assert_eq!(v.phase, Phase::Settled);
        assert_eq!(
            v.outcome,
            Some(OutcomeView::Picked {
                winners: vec![
                    payout("bob.test", 7_000, 665_000),
                    payout("carol.test", 3_000, 285_000),
                ],
                fee: U128(50_000),
                scorecard_hash: SCORECARD_HASH.to_string(),
                scorecard_uri: SCORECARD_URI.to_string(),
            })
        );
    }

    #[test]
    fn dust_goes_to_first_winner() {
        let mut t = world();
        let task = PostTaskArgs {
            reward: U128(1_000_003),
            ..args()
        };
        let id = post(&mut t, task);
        revealed(&mut t, id, &["bob.test", "carol.test", "dave.test"]);
        try_pick(
            &mut t,
            JUDGE,
            id,
            REVEAL_DEADLINE,
            &[
                ("bob.test", 3_333),
                ("carol.test", 3_333),
                ("dave.test", 3_334),
            ],
        )
        .unwrap();
        // The fee is 50_000.15 rounded down, which leaves 950_003. Rounded down, the shares of
        // that are 316_635, 316_635 and 316_731, 2 short of it: bob, the first winner, gets the 2.
        assert_eq!(balance(&t, TREASURY), 50_000);
        let paid = ["bob.test", "carol.test", "dave.test"].map(|who| balance(&t, who));
        assert_eq!(paid, [316_637, 316_635, 316_731]);
        assert_eq!(paid.iter().sum::<u128>(), 950_003);
        let Some(OutcomeView::Picked {
            winners: paid_out,
            fee,
            ..
        }) = outcome(&t, id)
        else {
            panic!("the task is picked");
        };
        assert_eq!(fee, U128(50_000));
        assert_eq!(
            paid_out,
            [
                payout("bob.test", 3_333, 316_637),
                payout("carol.test", 3_333, 316_635),
                payout("dave.test", 3_334, 316_731),
            ]
        );
    }

    #[test]
    fn pick_after_zero_fee_pays_full_reward() {
        let mut t = world();
        // The owner takes the fee down to nothing before the task is posted, so the task's
        // snapshot of it is 0.
        testing_env!(ctx("owner.test").attached_deposit(ONE_YOCTO).build());
        t.set_fee(0, acct(TREASURY));
        let id = post(&mut t, args());
        assert_eq!(t.get_task(U64(id)).unwrap().fee_bps, 0, "the premise");
        revealed(&mut t, id, &["bob.test", "carol.test"]);
        try_pick(
            &mut t,
            JUDGE,
            id,
            REVEAL_DEADLINE,
            &[("bob.test", 7_000), ("carol.test", 3_000)],
        )
        .unwrap();
        // The treasury's slot is credited 0, which is no reason to panic, and the winners share
        // the whole reward.
        let logs = get_logs();
        assert_eq!(balance(&t, TREASURY), 0);
        assert_eq!(balance(&t, "bob.test"), 700_000);
        assert_eq!(balance(&t, "carol.test"), 300_000);
        assert_eq!(balance(&t, "alice.test"), FUNDS - REWARD);
        assert_eq!(money(&t).iter().sum::<u128>(), FUNDS);
        let Some(OutcomeView::Picked {
            winners: paid_out,
            fee,
            ..
        }) = outcome(&t, id)
        else {
            panic!("the task is picked");
        };
        assert_eq!(fee, U128(0));
        assert_eq!(
            paid_out,
            [
                payout("bob.test", 7_000, 700_000),
                payout("carol.test", 3_000, 300_000),
            ]
        );
        assert_data_is_outcome(&logs[0], &t, id, &["task_id", "by"]);
    }

    #[test]
    fn dust_pick_reward_one_two_winners() {
        let mut t = world();
        // The smallest reward there is. The owner lowers the token's minimum to it.
        testing_env!(ctx("owner.test").attached_deposit(ONE_YOCTO).build());
        t.set_token(acct(USDC), U128(1), U128(50_000_000), true);
        let task = PostTaskArgs {
            reward: U128(1),
            ..args()
        };
        let id = post(&mut t, task);
        revealed(&mut t, id, &["bob.test", "carol.test"]);
        try_pick(
            &mut t,
            JUDGE,
            id,
            REVEAL_DEADLINE,
            &[("bob.test", 5_000), ("carol.test", 5_000)],
        )
        .unwrap();
        // The fee, 1 * 500 / 10_000, rounds down to 0. Each half of the 1 left rounds down to 0
        // too, so the 1 is dust, and it goes to the first winner.
        assert_eq!(balance(&t, TREASURY), 0);
        assert_eq!(balance(&t, "bob.test"), 1);
        assert_eq!(balance(&t, "carol.test"), 0);
        assert_eq!(money(&t).iter().sum::<u128>(), FUNDS);
        let Some(OutcomeView::Picked {
            winners: paid_out,
            fee,
            ..
        }) = outcome(&t, id)
        else {
            panic!("the task is picked");
        };
        assert_eq!(fee, U128(0));
        assert_eq!(
            paid_out,
            [payout("bob.test", 5_000, 1), payout("carol.test", 5_000, 0)]
        );
    }

    #[test]
    fn payout_overflow_is_e_reward() {
        // The products are checked, so a reward too large to split is refused, not paid wrongly.
        let split = |reward: u128, fee_bps: u16| {
            panic_message(|| {
                split_reward(reward, fee_bps, &[10_000]);
            })
        };
        // `reward * fee_bps` overflows.
        let message = split(u128::MAX / 500 + 1, 500).expect("a panic");
        assert!(message.starts_with("E_REWARD: "), "{message}");
        // `net * bps` overflows. With no fee, the net is the whole reward.
        let message = split(u128::MAX / 10_000 + 1, 0).expect("a panic");
        assert!(message.starts_with("E_REWARD: "), "{message}");
        // One less fits, and the winner gets all of it.
        assert_eq!(
            split_reward(u128::MAX / 10_000, 0, &[10_000]),
            (0, vec![u128::MAX / 10_000])
        );
    }

    // Who may pick, and with which winners.

    #[test]
    fn pick_requires_revealed_winner() {
        let mut t = world();
        let id = post(&mut t, args());
        enter(&mut t, "bob.test", id, 1);
        enter(&mut t, "carol.test", id, 2);
        reveal(&mut t, "bob.test", id, 1);
        let before = money(&t);
        let cases: [(&str, Shares, &str); 4] = [
            (
                "an entrant that did not reveal",
                &[("carol.test", 10_000)],
                "carol.test",
            ),
            (
                "an account that never entered",
                &[("dave.test", 10_000)],
                "dave.test",
            ),
            ("the verifier, who cannot enter", &[(JUDGE, 10_000)], JUDGE),
            (
                "a revealed winner beside one that did not reveal",
                &[("bob.test", 5_000), ("carol.test", 5_000)],
                "carol.test",
            ),
        ];
        for (what, list, missing) in cases {
            let result = try_pick(&mut t, JUDGE, id, REVEAL_DEADLINE, list);
            let message = assert_rejected(result, "E_WINNERS", what);
            assert_eq!(
                message,
                format!("E_WINNERS: {missing} has no revealed entry in task 1")
            );
        }
        assert_eq!(money(&t), before, "nothing moved");
        assert_eq!(outcome(&t, id), None);
        try_pick(&mut t, JUDGE, id, REVEAL_DEADLINE, &[("bob.test", 10_000)]).unwrap();
        assert_eq!(balance(&t, "bob.test"), 950_000);
    }

    #[test]
    fn pick_rejects_duplicates_bad_sum_zero_bps_too_many() {
        let mut t = world();
        let task = PostTaskArgs {
            max_winners: 2,
            ..args()
        };
        let id = post(&mut t, task);
        revealed(&mut t, id, &["bob.test", "carol.test", "dave.test"]);
        let before = money(&t);
        let cases: [(&str, Shares, &str); 6] = [
            (
                "a duplicate",
                &[("bob.test", 5_000), ("bob.test", 5_000)],
                "bob.test is named twice",
            ),
            (
                "a zero bps",
                &[("bob.test", 10_000), ("carol.test", 0)],
                "carol.test has a bps of 0",
            ),
            (
                "a sum below 10_000",
                &[("bob.test", 5_000), ("carol.test", 4_999)],
                "the bps add up to 9999, not 10000",
            ),
            (
                "a sum above 10_000",
                &[("bob.test", 5_000), ("carol.test", 5_001)],
                "the bps add up to 10001, not 10000",
            ),
            // Added up in a u16, these would wrap to exactly 10_000 and pay bob six times over.
            (
                "a sum that wraps a u16",
                &[("bob.test", 60_000), ("carol.test", 15_536)],
                "the bps add up to 75536, not 10000",
            ),
            (
                "more winners than max_winners",
                &[
                    ("bob.test", 4_000),
                    ("carol.test", 3_000),
                    ("dave.test", 3_000),
                ],
                "task 1 pays at most 2 winners, got 3",
            ),
        ];
        for (what, list, detail) in cases {
            let result = try_pick(&mut t, JUDGE, id, REVEAL_DEADLINE, list);
            let message = assert_rejected(result, "E_WINNERS", what);
            assert_eq!(message, format!("E_WINNERS: {detail}"));
        }
        assert_eq!(money(&t), before, "nothing moved");
        assert_eq!(outcome(&t, id), None);
        // `max_winners` itself is allowed.
        try_pick(
            &mut t,
            JUDGE,
            id,
            REVEAL_DEADLINE,
            &[("bob.test", 5_000), ("carol.test", 5_000)],
        )
        .unwrap();
        assert_eq!(balance(&t, "bob.test"), 475_000);
        assert_eq!(balance(&t, "carol.test"), 475_000);
    }

    #[test]
    fn pick_window_boundaries() {
        let mut t = world();
        // Four tasks, each with bob's entry revealed, since a task can be picked only once.
        let ids = [(); 4].map(|_| post(&mut t, args()));
        for id in ids {
            revealed(&mut t, id, &["bob.test"]);
        }
        let bob = &[("bob.test", 10_000)];
        let closed =
            |who: &str, id: u64| format!("E_PHASE: task {id} is not in {who}'s pick window");

        // The verifier's window opens at the reveal deadline...
        let result = try_pick(&mut t, JUDGE, ids[0], REVEAL_DEADLINE - 1, bob);
        let message = assert_rejected(result, "E_PHASE", "the verifier before its window");
        assert_eq!(message, closed(JUDGE, ids[0]));
        try_pick(&mut t, JUDGE, ids[0], REVEAL_DEADLINE, bob).unwrap();
        // ...and closes at the pick deadline.
        let result = try_pick(&mut t, JUDGE, ids[1], PICK_DEADLINE, bob);
        let message = assert_rejected(result, "E_PHASE", "the verifier after its window");
        assert_eq!(message, closed(JUDGE, ids[1]));
        try_pick(&mut t, JUDGE, ids[1], PICK_DEADLINE - 1, bob).unwrap();

        // The poster's window opens at the pick deadline...
        let result = try_pick(&mut t, "alice.test", ids[2], PICK_DEADLINE - 1, bob);
        let message = assert_rejected(result, "E_PHASE", "the poster before its window");
        assert_eq!(message, closed("alice.test", ids[2]));
        try_pick(&mut t, "alice.test", ids[2], PICK_DEADLINE, bob).unwrap();
        // ...and closes at the fallback deadline.
        let result = try_pick(&mut t, "alice.test", ids[3], FALLBACK_DEADLINE, bob);
        let message = assert_rejected(result, "E_PHASE", "the poster after its window");
        assert_eq!(message, closed("alice.test", ids[3]));
        try_pick(&mut t, "alice.test", ids[3], FALLBACK_DEADLINE - 1, bob).unwrap();

        // Each task paid bob once.
        assert_eq!(balance(&t, "bob.test"), 4 * 950_000);
    }

    #[test]
    fn verifier_equal_poster_spans_both_windows() {
        let mut t = world();
        // alice posts these and, by default, verifies them too.
        let own = PostTaskArgs {
            verifier: None,
            ..args()
        };
        let ids = [(); 5].map(|_| post(&mut t, own.clone()));
        for id in ids {
            revealed(&mut t, id, &["bob.test"]);
        }
        let bob = &[("bob.test", 10_000)];
        // She cannot pick before the reveal deadline...
        let result = try_pick(&mut t, "alice.test", ids[0], REVEAL_DEADLINE - 1, bob);
        assert_rejected(result, "E_PHASE", "before the verifier's window");
        // ...and from it up to the fallback deadline she can: as the verifier and then as the
        // poster, with no gap at the pick deadline...
        for (id, now) in ids.into_iter().zip([
            REVEAL_DEADLINE,
            PICK_DEADLINE - 1,
            PICK_DEADLINE,
            FALLBACK_DEADLINE - 1,
        ]) {
            try_pick(&mut t, "alice.test", id, now, bob)
                .unwrap_or_else(|m| panic!("a pick at {now} was rejected: {m}"));
        }
        // ...but not from the fallback deadline on.
        let result = try_pick(&mut t, "alice.test", ids[4], FALLBACK_DEADLINE, bob);
        assert_rejected(result, "E_PHASE", "after the poster's window");
        assert_eq!(balance(&t, "bob.test"), 4 * 950_000);
    }

    #[test]
    fn pick_acts_for_the_predecessor_not_the_signer() {
        let mut t = world();
        let id = post(&mut t, args());
        revealed(&mut t, id, &["bob.test"]);
        let pick_bob = |t: &mut Tender| {
            let (hash, uri) = (SCORECARD_HASH.to_string(), SCORECARD_URI.to_string());
            panic_message(|| t.pick(U64(id), winners(&[("bob.test", 10_000)]), hash, uri))
        };
        // The judge signs a transaction whose call reaches Tender from another account. That
        // account is the caller, and it may not pick.
        testing_env!(ctx("relay.test")
            .signer_account_id(acct(JUDGE))
            .block_timestamp(REVEAL_DEADLINE)
            .build());
        let message = pick_bob(&mut t).expect("the relayed call is rejected");
        assert!(message.starts_with("E_AUTH: "), "{message}");
        assert_eq!(outcome(&t, id), None);
        // The judge's own call goes through, whoever signed it.
        testing_env!(ctx(JUDGE)
            .signer_account_id(acct("relay.test"))
            .block_timestamp(REVEAL_DEADLINE)
            .build());
        assert_eq!(pick_bob(&mut t), None);
        assert_eq!(balance(&t, "bob.test"), 950_000);
    }

    #[test]
    fn pick_rules_are_checked_in_the_listed_order() {
        // erin, a stranger, picks a settled task while it is still open, with an empty scorecard
        // uri, a scorecard hash that is not hex, and a winner that did not reveal. Each step mends
        // the rule that was reported, so the next one in the list has to be the next one reported.
        struct Attempt {
            who: &'static str,
            now: u64,
            hash: &'static str,
            uri: &'static str,
            winner: &'static str,
        }
        type Mend = fn(&mut Tender, &mut Attempt);
        let mut t = world();
        let id = post(&mut t, args());
        assert_eq!(id, 1, "the steps below name the task by its id");
        enter(&mut t, "bob.test", id, 1);
        enter(&mut t, "carol.test", id, 2);
        reveal(&mut t, "bob.test", id, 1);
        t.tasks.get_mut(&1u64).unwrap().outcome = Some(Outcome::Voided {
            reason: VoidReason::Expired,
            scorecard_hash: None,
            scorecard_uri: None,
        });
        let mut attempt = Attempt {
            who: "erin.test",
            now: T1,
            hash: "x",
            uri: "",
            winner: "carol.test",
        };
        let steps: [(&str, Mend); 6] = [
            ("E_SETTLED", |t, _| {
                t.tasks.get_mut(&1u64).unwrap().outcome = None
            }),
            ("E_AUTH", |_, a| a.who = JUDGE),
            ("E_PHASE", |_, a| a.now = REVEAL_DEADLINE),
            ("E_URI", |_, a| a.uri = SCORECARD_URI),
            ("E_HASH", |_, a| a.hash = SCORECARD_HASH),
            ("E_WINNERS", |_, a| a.winner = "bob.test"),
        ];
        let send = |t: &mut Tender, a: &Attempt| {
            try_pick_with(t, a.who, 1, a.now, &[(a.winner, 10_000)], a.hash, a.uri)
        };
        for (code, mend) in steps {
            assert_rejected(send(&mut t, &attempt), code, code);
            mend(&mut t, &mut attempt);
        }
        send(&mut t, &attempt).unwrap();
        assert_eq!(balance(&t, "bob.test"), 950_000);
    }

    #[test]
    fn missing_task_is_not_found() {
        let mut t = world();
        let result = try_pick(&mut t, JUDGE, 99, REVEAL_DEADLINE, &[]);
        let message = assert_rejected(result, "E_NOT_FOUND", "a pick in a missing task");
        assert_eq!(message, "E_NOT_FOUND: no task 99");
        let result = try_void(&mut t, KEEPER, 99, FALLBACK_DEADLINE);
        let message = assert_rejected(result, "E_NOT_FOUND", "a void of a missing task");
        assert_eq!(message, "E_NOT_FOUND: no task 99");
    }

    // No award.

    #[test]
    fn empty_pick_refunds_funders_exactly() {
        let mut t = world();
        fund(&mut t, "frank.test", 300);
        let before = money(&t);
        let id = post(&mut t, args());
        // A second funder, the way Task 13's top-ups will add one: frank pays 300 into the escrow.
        t.debit(&acct("frank.test"), &acct(USDC), 300);
        let task = t.tasks.get_mut(&id).unwrap();
        task.reward += 300;
        task.funders.push((acct("frank.test"), 300));
        revealed(&mut t, id, &["bob.test", "carol.test"]);

        // Awarding nothing still takes a scorecard.
        let result = try_pick_with(&mut t, JUDGE, id, REVEAL_DEADLINE, &[], "x", SCORECARD_URI);
        assert_eq!(
            assert_rejected(
                result,
                "E_HASH",
                "a no-award without a valid scorecard hash",
            ),
            "E_HASH: scorecard_hash: expected 64 lowercase hex chars"
        );
        try_pick(&mut t, JUDGE, id, REVEAL_DEADLINE, &[]).unwrap();
        // Each funder holds exactly what it held before it paid in, and nobody else got anything:
        // the treasury takes no fee from a refund.
        assert_eq!(money(&t), before);
        let v = t.get_task(U64(id)).unwrap();
        assert_eq!(v.phase, Phase::Settled);
        assert_eq!(v.outcome, voided(VoidReason::NoAward, true));
    }

    #[test]
    fn empty_pick_counts_void_after_reveals() {
        let mut t = world();
        register_agent(&mut t, JUDGE);
        register_agent(&mut t, "alice.test");
        let seen = post(&mut t, args());
        let unseen = post(&mut t, args());
        let fallback = post(&mut t, args());
        revealed(&mut t, seen, &["bob.test"]);
        // bob enters this one but never reveals.
        enter(&mut t, "bob.test", unseen, 1);
        revealed(&mut t, fallback, &["carol.test"]);

        // An empty pick after a reveal counts against the verifier, and is not a pick made...
        try_pick(&mut t, JUDGE, seen, REVEAL_DEADLINE, &[]).unwrap();
        let judge = agent(&t, JUDGE);
        assert_eq!((judge.voids_after_reveals, judge.picks_made), (1, 0));
        // ...one with nothing revealed does not count...
        try_pick(&mut t, JUDGE, unseen, REVEAL_DEADLINE, &[]).unwrap();
        assert_eq!(agent(&t, JUDGE).voids_after_reveals, 1);
        // ...and in the fallback window it counts against the poster, who made it.
        try_pick(&mut t, "alice.test", fallback, PICK_DEADLINE, &[]).unwrap();
        let alice = agent(&t, "alice.test");
        assert_eq!((alice.voids_after_reveals, alice.picks_made), (1, 0));
        assert_eq!(agent(&t, JUDGE).voids_after_reveals, 1);
        for id in [seen, unseen, fallback] {
            assert_eq!(
                outcome(&t, id),
                voided(VoidReason::NoAward, true),
                "task {id}"
            );
        }
        assert_eq!(balance(&t, "alice.test"), FUNDS);
    }

    // Voids.

    #[test]
    fn void_no_reveals_after_reveal_deadline() {
        let mut t = world();
        let id = post(&mut t, args());
        // An entry that is never revealed.
        enter(&mut t, "bob.test", id, 1);
        let result = try_void(&mut t, KEEPER, id, REVEAL_DEADLINE - 1);
        let message = assert_rejected(result, "E_PHASE", "while the entry can still be revealed");
        assert_eq!(message, "E_PHASE: task 1 cannot be voided yet");
        // From the reveal deadline anyone may void it.
        try_void(&mut t, KEEPER, id, REVEAL_DEADLINE).unwrap();
        assert_eq!(balance(&t, "alice.test"), FUNDS);
        let v = t.get_task(U64(id)).unwrap();
        assert_eq!(v.phase, Phase::Settled);
        assert_eq!(v.outcome, voided(VoidReason::NoReveals, false));
    }

    #[test]
    fn void_expired_after_fallback() {
        let mut t = world();
        let id = post(&mut t, args());
        // With an entry revealed, only the end of the fallback window lets anyone void the task.
        revealed(&mut t, id, &["bob.test"]);
        let result = try_void(&mut t, KEEPER, id, FALLBACK_DEADLINE - 1);
        assert_rejected(
            result,
            "E_PHASE",
            "the last nanosecond of the fallback window",
        );
        try_void(&mut t, KEEPER, id, FALLBACK_DEADLINE).unwrap();
        assert_eq!(balance(&t, "alice.test"), FUNDS);
        assert_eq!(balance(&t, "bob.test"), 0);
        assert_eq!(balance(&t, TREASURY), 0);
        assert_eq!(outcome(&t, id), voided(VoidReason::Expired, false));

        // With nothing revealed, the reason stays `no_reveals`, however late the void comes.
        let quiet = post(&mut t, args());
        try_void(&mut t, KEEPER, quiet, u64::MAX).unwrap();
        assert_eq!(outcome(&t, quiet), voided(VoidReason::NoReveals, false));
        assert_eq!(balance(&t, "alice.test"), FUNDS);
    }

    #[test]
    fn void_too_early_rejected() {
        let mut t = world();
        let id = post(&mut t, args());
        revealed(&mut t, id, &["bob.test"]);
        for (what, now) in [
            ("open", T1),
            ("in the reveal window", COMMIT_DEADLINE),
            ("in the verifier's window", REVEAL_DEADLINE),
            ("at its last nanosecond", PICK_DEADLINE - 1),
            ("in the poster's window", PICK_DEADLINE),
            ("at its last nanosecond", FALLBACK_DEADLINE - 1),
        ] {
            let message = assert_rejected(try_void(&mut t, KEEPER, id, now), "E_PHASE", what);
            assert_eq!(message, "E_PHASE: task 1 cannot be voided yet");
        }
        // Neither may the poster or the verifier.
        for who in ["alice.test", JUDGE] {
            assert_rejected(try_void(&mut t, who, id, REVEAL_DEADLINE), "E_PHASE", who);
        }
        assert_eq!(balance(&t, "alice.test"), FUNDS - REWARD);
        assert_eq!(outcome(&t, id), None);
    }

    // A task settles once (I2).

    #[test]
    fn pick_after_void_rejected() {
        let mut t = world();
        let id = post(&mut t, args());
        enter(&mut t, "bob.test", id, 1);
        try_void(&mut t, KEEPER, id, REVEAL_DEADLINE).unwrap();
        let settled = money(&t);
        let cases: [(&str, &str, u64, Shares); 3] = [
            ("the verifier's empty pick", JUDGE, REVEAL_DEADLINE, &[]),
            (
                "the verifier's pick",
                JUDGE,
                REVEAL_DEADLINE,
                &[("bob.test", 10_000)],
            ),
            ("the poster's empty pick", "alice.test", PICK_DEADLINE, &[]),
        ];
        for (what, who, now, list) in cases {
            let message = assert_rejected(try_pick(&mut t, who, id, now, list), "E_SETTLED", what);
            assert_eq!(message, "E_SETTLED: task 1 is already settled");
        }
        // A second void is refused too.
        let result = try_void(&mut t, KEEPER, id, FALLBACK_DEADLINE);
        assert_rejected(result, "E_SETTLED", "a second void");
        assert_eq!(money(&t), settled, "nothing moved");
        assert_eq!(outcome(&t, id), voided(VoidReason::NoReveals, false));
    }

    #[test]
    fn void_after_pick_rejected() {
        let mut t = world();
        let id = post(&mut t, args());
        revealed(&mut t, id, &["bob.test"]);
        try_pick(&mut t, JUDGE, id, REVEAL_DEADLINE, &[("bob.test", 10_000)]).unwrap();
        let paid = money(&t);
        let result = try_void(&mut t, KEEPER, id, FALLBACK_DEADLINE);
        let message = assert_rejected(result, "E_SETTLED", "a void after the pick");
        assert_eq!(message, "E_SETTLED: task 1 is already settled");
        // A second pick is refused too, a winning one or an empty one.
        let result = try_pick(&mut t, JUDGE, id, REVEAL_DEADLINE, &[("bob.test", 10_000)]);
        assert_rejected(result, "E_SETTLED", "a second pick");
        let result = try_pick(&mut t, "alice.test", id, PICK_DEADLINE, &[]);
        assert_rejected(result, "E_SETTLED", "the poster's empty pick");
        assert_eq!(money(&t), paid, "nothing moved");
        assert!(matches!(outcome(&t, id), Some(OutcomeView::Picked { .. })));
    }

    // Storage.

    #[test]
    fn winner_with_zero_available_storage_is_still_paid() {
        let mut t = world();
        register_agent(&mut t, "bob.test");
        let id = post(&mut t, args());
        revealed(&mut t, id, &["bob.test"]);
        leave_spare(&mut t, "bob.test", 0);
        let bob_used = used(&t, "bob.test");
        try_pick(&mut t, JUDGE, id, REVEAL_DEADLINE, &[("bob.test", 10_000)]).unwrap();
        assert_eq!(balance(&t, "bob.test"), 950_000);
        assert_eq!(agent(&t, "bob.test").earned, usdc(950_000));
        // bob paid for nothing: his slots were made, and paid for, when he committed.
        assert_eq!(used(&t, "bob.test"), bob_used);
        assert_eq!(t.storage_available(&acct("bob.test")), 0);
    }

    #[test]
    fn void_succeeds_when_poster_storage_is_empty() {
        let mut t = world();
        let first = post(&mut t, args());
        let second = post(&mut t, args());
        leave_spare(&mut t, "alice.test", 0);
        let alice_used = used(&t, "alice.test");
        try_void(&mut t, KEEPER, first, REVEAL_DEADLINE).unwrap();
        assert_eq!(balance(&t, "alice.test"), FUNDS - REWARD);
        // The outcome takes 4 of the 800 bytes alice reserved when she posted: the variant, the
        // reason and the two `None`s. She gets the other 796 back.
        let grown = outcome_bytes(&t, first);
        assert_eq!(grown, 4);
        assert_eq!(
            used(&t, "alice.test"),
            alice_used - OUTCOME_RESERVE_BYTES + grown
        );
        assert_eq!(
            t.storage_available(&acct("alice.test")),
            u128::from(OUTCOME_RESERVE_BYTES - grown) * byte_cost()
        );

        // Even with no deposit left at all, as when a rise in the storage price leaves a deposit
        // short of the bytes it paid for, the void goes through: the reserve paid for the
        // outcome, so its bytes are charged without a balance check.
        t.storage.get_mut(&acct("alice.test")).unwrap().deposited = 0;
        let alice_used = used(&t, "alice.test");
        try_void(&mut t, KEEPER, second, REVEAL_DEADLINE).unwrap();
        assert_eq!(balance(&t, "alice.test"), FUNDS);
        assert_eq!(
            used(&t, "alice.test"),
            alice_used - OUTCOME_RESERVE_BYTES + grown
        );
    }

    #[test]
    fn outcome_reserve_released() {
        let mut t = world();
        let start = used(&t, "alice.test");
        let id = post(&mut t, args());
        // The task record: 40 bytes of overhead, the key (a 1-byte prefix and the 8-byte id) and
        // the Borsh value.
        let task_bytes =
            40 + 1 + 8 + borsh::to_vec(t.tasks.get(&id).unwrap()).unwrap().len() as u64;
        assert_eq!(
            used(&t, "alice.test"),
            start + task_bytes + OUTCOME_RESERVE_BYTES,
            "the premise: posting reserved the outcome's bytes"
        );
        revealed(&mut t, id, &["bob.test", "carol.test"]);

        // The mocked VM restarts `storage_usage` with every context, so the mark is taken in the
        // context of the pick itself.
        testing_env!(ctx(JUDGE).block_timestamp(REVEAL_DEADLINE).build());
        let usage = t.storage_mark();
        t.pick(
            U64(id),
            winners(&[("bob.test", 7_000), ("carol.test", 3_000)]),
            SCORECARD_HASH.to_string(),
            SCORECARD_URI.to_string(),
        );
        let grown = t.storage_mark() - usage;
        // The outcome is all that settling writes anew...
        assert_eq!(grown, outcome_bytes(&t, id));
        assert!(grown < OUTCOME_RESERVE_BYTES);
        // ...and alice pays for just that: the reserve is gone, and the record is charged at the
        // size it has now.
        assert_eq!(used(&t, "alice.test"), start + task_bytes + grown);
    }

    #[test]
    fn max_outcome_fits_reserve() {
        // The largest outcome there can be: five winners whose ids have the most characters an
        // account id can have, 64, and a scorecard uri of 256 bytes.
        let mut t = world();
        let ids = [1u8, 2, 3, 4, 5].map(|i| hex::encode([i; 32]));
        let names = ids.each_ref().map(String::as_str);
        for who in names {
            assert_eq!(who.len(), 64);
            register(&mut t, who, NearToken::from_millinear(100));
        }
        let id = post(&mut t, args());
        revealed(&mut t, id, &names);
        let shares = names.map(|who| (who, 2_000));

        testing_env!(ctx(JUDGE).block_timestamp(REVEAL_DEADLINE).build());
        let posted = used(&t, "alice.test");
        let usage = t.storage_mark();
        t.pick(
            U64(id),
            winners(&shares),
            SCORECARD_HASH.to_string(),
            "u".repeat(MAX_URI_BYTES),
        );
        let grown = t.storage_mark() - usage;
        // The variant (1), the five payouts behind a 4-byte length (each a 4-byte length and 64
        // bytes of account, a u16 and a u128), the fee (16), the hash (32) and the uri behind its
        // length (4 + 256).
        assert_eq!(grown, 1 + (4 + 5 * (4 + 64 + 2 + 16)) + 16 + 32 + (4 + 256));
        assert_eq!(grown, outcome_bytes(&t, id));
        assert!(
            grown <= OUTCOME_RESERVE_BYTES,
            "{grown} bytes do not fit in the reserve of {OUTCOME_RESERVE_BYTES}"
        );
        // The poster pays for the outcome out of its reserve, and gets the rest back.
        assert_eq!(
            used(&t, "alice.test"),
            posted - OUTCOME_RESERVE_BYTES + grown
        );
        for who in names {
            assert_eq!(balance(&t, who), 190_000);
        }
    }

    // Reputation.

    #[test]
    fn reputation_counters_updated() {
        let mut t = world();
        for who in ["bob.test", "carol.test", JUDGE, "alice.test"] {
            register_agent(&mut t, who);
        }
        let first = post(&mut t, args());
        let second = post(&mut t, args());
        let fallback = post(&mut t, args());
        for id in [first, second, fallback] {
            revealed(&mut t, id, &["bob.test", "carol.test", "dave.test"]);
        }
        try_pick(
            &mut t,
            JUDGE,
            first,
            REVEAL_DEADLINE,
            &[
                ("bob.test", 6_000),
                ("carol.test", 3_000),
                ("dave.test", 1_000),
            ],
        )
        .unwrap();
        // Of the 950_000 after the fee: 570_000, 285_000 and 95_000.
        let bob = agent(&t, "bob.test");
        assert_eq!(bob.wins, 1);
        assert_eq!(bob.earned, usdc(570_000));
        let carol = agent(&t, "carol.test");
        assert_eq!(carol.wins, 1);
        assert_eq!(carol.earned, usdc(285_000));
        // dave is paid, but has no profile to update and is not given one.
        assert_eq!(balance(&t, "dave.test"), 95_000);
        assert_eq!(t.get_agent(acct("dave.test")), None);
        let judge = agent(&t, JUDGE);
        assert_eq!(
            (judge.picks_made, judge.voids_after_reveals, judge.wins),
            (1, 0, 0)
        );

        // A second pick adds to the first.
        try_pick(
            &mut t,
            JUDGE,
            second,
            REVEAL_DEADLINE,
            &[("carol.test", 10_000)],
        )
        .unwrap();
        let bob = agent(&t, "bob.test");
        assert_eq!(bob.wins, 1);
        assert_eq!(bob.earned, usdc(570_000));
        let carol = agent(&t, "carol.test");
        assert_eq!(carol.wins, 2);
        assert_eq!(carol.earned, usdc(285_000 + 950_000));
        assert_eq!(agent(&t, JUDGE).picks_made, 2);

        // A pick in the fallback window is the poster's, and counts for the poster.
        try_pick(
            &mut t,
            "alice.test",
            fallback,
            PICK_DEADLINE,
            &[("bob.test", 10_000)],
        )
        .unwrap();
        assert_eq!(agent(&t, "alice.test").picks_made, 1);
        assert_eq!(agent(&t, JUDGE).picks_made, 2);
        let bob = agent(&t, "bob.test");
        assert_eq!(bob.wins, 2);
        assert_eq!(bob.earned, usdc(570_000 + 950_000));
        // Entering and revealing were counted as before, and a pick changes neither.
        assert_eq!((bob.entries, bob.reveals), (3, 3));
    }

    #[test]
    fn reputation_counters_saturate() {
        let mut t = world();
        register_agent(&mut t, "bob.test");
        register_agent(&mut t, JUDGE);
        let picked = post(&mut t, args());
        let no_award = post(&mut t, args());
        for id in [picked, no_award] {
            revealed(&mut t, id, &["bob.test"]);
        }
        t.with_profile(&acct("bob.test"), |p| {
            p.wins = u32::MAX;
            p.earned[0].1 = u128::MAX - 1;
        });
        t.with_profile(&acct(JUDGE), |p| {
            p.picks_made = u32::MAX;
            p.voids_after_reveals = u32::MAX;
        });
        // Counting past the top would abort the payout. The counters stop there instead.
        try_pick(
            &mut t,
            JUDGE,
            picked,
            REVEAL_DEADLINE,
            &[("bob.test", 10_000)],
        )
        .unwrap();
        try_pick(&mut t, JUDGE, no_award, REVEAL_DEADLINE, &[]).unwrap();
        let bob = agent(&t, "bob.test");
        assert_eq!(bob.wins, u32::MAX);
        assert_eq!(bob.earned, usdc(u128::MAX));
        let judge = agent(&t, JUDGE);
        assert_eq!(
            (judge.picks_made, judge.voids_after_reveals),
            (u32::MAX, u32::MAX)
        );
        // The money moved all the same.
        assert_eq!(balance(&t, "bob.test"), 950_000);
        assert_eq!(balance(&t, "alice.test"), FUNDS - REWARD);
    }

    #[test]
    fn winner_registered_after_commit_is_paid_without_storage_growth() {
        let mut t = world();
        let id = post(&mut t, args());
        // bob commits before he registers, so his commit made him a vault slot but no `earned`
        // slot.
        enter(&mut t, "bob.test", id, 1);
        register_agent(&mut t, "bob.test");
        reveal(&mut t, "bob.test", id, 1);
        assert_eq!(agent(&t, "bob.test").earned, vec![], "the premise");
        let bob_used = used(&t, "bob.test");

        testing_env!(ctx(JUDGE).block_timestamp(REVEAL_DEADLINE).build());
        let usage = t.storage_mark();
        t.pick(
            U64(id),
            winners(&[("bob.test", 10_000)]),
            SCORECARD_HASH.to_string(),
            SCORECARD_URI.to_string(),
        );
        // Settling adds no `earned` slot: the outcome is all that grows.
        assert_eq!(t.storage_mark() - usage, outcome_bytes(&t, id));
        // So bob is paid and counted as a winner, but what he earned is not recorded.
        assert_eq!(balance(&t, "bob.test"), 950_000);
        let bob = agent(&t, "bob.test");
        assert_eq!(bob.wins, 1);
        assert_eq!(bob.earned, vec![]);
        assert_eq!(used(&t, "bob.test"), bob_used);
    }

    // Events and arguments.

    /// Asserts that the data of the event in `log`, without `skip`, is task `id`'s outcome as
    /// `get_task` shows it, without `kind`.
    fn assert_data_is_outcome(log: &str, t: &Tender, id: u64, skip: &[&str]) {
        let envelope: Value =
            serde_json::from_str(log.strip_prefix("EVENT_JSON:").unwrap()).unwrap();
        let mut data = envelope["data"][0].clone();
        for key in skip {
            data.as_object_mut().unwrap().remove(*key);
        }
        let mut view = serde_json::to_value(outcome(t, id)).unwrap();
        view.as_object_mut().unwrap().remove("kind");
        assert_eq!(data, view);
    }

    #[test]
    fn pick_and_void_emit_events() {
        let mut t = world();
        let picked = post(&mut t, args());
        let no_award = post(&mut t, args());
        let no_reveals = post(&mut t, args());
        revealed(&mut t, picked, &["bob.test", "carol.test"]);
        revealed(&mut t, no_award, &["bob.test"]);

        try_pick(
            &mut t,
            JUDGE,
            picked,
            REVEAL_DEADLINE,
            &[("bob.test", 7_000), ("carol.test", 3_000)],
        )
        .unwrap();
        let logs = get_logs();
        assert_eq!(
            logs,
            [event(
                "picked",
                &format!(
                    r#"{{"task_id":"1","by":"judge.test","winners":[{{"account":"bob.test","bps":7000,"amount":"665000"}},{{"account":"carol.test","bps":3000,"amount":"285000"}}],"fee":"50000","scorecard_hash":"{SCORECARD_HASH}","scorecard_uri":"{SCORECARD_URI}"}}"#
                )
            )]
        );
        assert_data_is_outcome(&logs[0], &t, picked, &["task_id", "by"]);

        try_pick(&mut t, JUDGE, no_award, REVEAL_DEADLINE, &[]).unwrap();
        let logs = get_logs();
        assert_eq!(
            logs,
            [event(
                "voided",
                &format!(
                    r#"{{"task_id":"2","reason":"no_award","by":"judge.test","refunds":[{{"account":"alice.test","amount":"1000000"}}],"scorecard_hash":"{SCORECARD_HASH}","scorecard_uri":"{SCORECARD_URI}"}}"#
                )
            )]
        );
        assert_data_is_outcome(&logs[0], &t, no_award, &["task_id", "by", "refunds"]);

        try_void(&mut t, KEEPER, no_reveals, REVEAL_DEADLINE).unwrap();
        let logs = get_logs();
        assert_eq!(
            logs,
            [event(
                "voided",
                r#"{"task_id":"3","reason":"no_reveals","by":null,"refunds":[{"account":"alice.test","amount":"1000000"}],"scorecard_hash":null,"scorecard_uri":null}"#
            )]
        );
        assert_data_is_outcome(&logs[0], &t, no_reveals, &["task_id", "by", "refunds"]);
    }

    /// What `pick`'s generated wasm wrapper parses `env::input()` into, mirrored as the tasks tests
    /// mirror `post_task`'s: a struct of the method's arguments, which `#[deny_unknown_arguments]`
    /// makes `deny_unknown_fields`. Each winner goes through `WinnerArg`'s own derive.
    #[derive(Debug, near_sdk::serde::Deserialize)]
    #[serde(crate = "near_sdk::serde", deny_unknown_fields)]
    struct PickInput {
        task_id: U64,
        winners: Vec<WinnerArg>,
        scorecard_hash: String,
        scorecard_uri: String,
    }

    /// Parses `input` as `pick` receives it. `Err` holds serde's message.
    fn parse_pick(input: &Value) -> Result<PickInput, String> {
        serde_json::from_slice(&serde_json::to_vec(input).unwrap()).map_err(|e| e.to_string())
    }

    #[test]
    fn pick_args_wire_form() {
        // As a client sends them: the task id is a decimal string and each bps a JSON number.
        let full = json!({
            "task_id": "7",
            "winners": [
                {"account": "bob.test", "bps": 7000},
                {"account": "carol.test", "bps": 3000},
            ],
            "scorecard_hash": SCORECARD_HASH,
            "scorecard_uri": SCORECARD_URI,
        });
        let input = parse_pick(&full).unwrap();
        assert_eq!(input.task_id, U64(7));
        assert_eq!(
            input.winners,
            winners(&[("bob.test", 7_000), ("carol.test", 3_000)])
        );
        assert_eq!(input.scorecard_hash, SCORECARD_HASH);
        assert_eq!(input.scorecard_uri, SCORECARD_URI);
        // No award is an empty list.
        let mut empty = full.clone();
        empty["winners"] = json!([]);
        assert_eq!(parse_pick(&empty).unwrap().winners, vec![]);

        // Each of these changes to `full` makes the arguments fail to parse.
        type Alter = fn(&mut Value);
        let cases: [(&str, Alter, &str); 6] = [
            (
                "a numeric task id",
                |v| v["task_id"] = json!(7),
                "invalid type: integer `7`, expected a string",
            ),
            (
                "a string bps",
                |v| v["winners"][0]["bps"] = json!("7000"),
                r#"invalid type: string "7000", expected u16"#,
            ),
            (
                "a bps that does not fit a u16",
                |v| v["winners"][0]["bps"] = json!(70_000),
                "invalid value: integer `70000`, expected u16",
            ),
            // Only `bps` decides a payout, so a winner with a key it does not take is an error,
            // not a key quietly ignored.
            (
                "an extra key in a winner",
                |v| v["winners"][0]["amount"] = json!("665000"),
                "unknown field `amount`",
            ),
            (
                "a misspelled key in a winner",
                |v| v["winners"][1] = json!({"account": "carol.test", "bsp": 3000}),
                "unknown field `bsp`",
            ),
            (
                "a key beside the four arguments",
                |v| v["fee"] = json!("0"),
                "unknown field `fee`",
            ),
        ];
        for (what, alter, expected) in cases {
            let mut input = full.clone();
            alter(&mut input);
            let message = parse_pick(&input).unwrap_err();
            assert!(message.contains(expected), "{what}: {message}");
        }
    }

    // Cleanup.

    /// `who` cleans up task `id` with `limit` at `now`. `Err` holds the message the contract
    /// panicked with, and `Ok` the number of entries the call went through.
    fn try_cleanup(
        t: &mut Tender,
        who: &str,
        id: u64,
        now: u64,
        limit: u32,
    ) -> Result<u32, String> {
        testing_env!(ctx(who).block_timestamp(now).build());
        let mut n = 0;
        match panic_message(|| n = t.cleanup(U64(id), limit)) {
            Some(message) => Err(message),
            None => Ok(n),
        }
    }

    /// The keeper cleans up task `id` with `limit`, after the task's last deadline. Returns how
    /// many entries the call went through.
    fn clean(t: &mut Tender, id: u64, limit: u32) -> u32 {
        try_cleanup(t, KEEPER, id, FALLBACK_DEADLINE, limit)
            .unwrap_or_else(|m| panic!("a cleanup of task {id} was rejected: {m}"))
    }

    /// How many entries of task `id` `cleanup` has gone through.
    fn cleaned(t: &Tender, id: u64) -> u32 {
        t.get_task(U64(id)).expect("the task exists").cleaned
    }

    /// The `(index, account)` of each entry of task `id` that `get_entries` shows from
    /// `from_index` on, up to one page.
    fn remaining(t: &Tender, id: u64, from_index: u32) -> Vec<(u32, String)> {
        t.get_entries(U64(id), from_index, 50)
            .into_iter()
            .map(|e| (e.index, e.account.to_string()))
            .collect()
    }

    /// The storage charged to alice and to each of `AGENTS`, in that order.
    fn charged(t: &Tender) -> Vec<u64> {
        ["alice.test"]
            .into_iter()
            .chain(AGENTS)
            .map(|who| used(t, who))
            .collect()
    }

    /// The bytes of the payout slots that a first commit in USDC makes for `who`, a registered
    /// agent if `agent`. They stay after `cleanup`, and stay charged. Each record costs 40 bytes
    /// of overhead plus its key and value; a key starts with a 1-byte prefix, and an account id
    /// is a 4-byte length and its bytes.
    fn slot_bytes(who: &str, agent: bool) -> u64 {
        let account = 4 + who.len() as u64;
        // The vault slot is keyed by the account and the token, and holds a u128.
        let vault_slot = 40 + (1 + account + 4 + USDC.len() as u64) + 16;
        // The `earned` slot is a `(token, u128)` pushed onto the agent's profile.
        let earned_slot = if agent { 4 + USDC.len() as u64 + 16 } else { 0 };
        vault_slot + earned_slot
    }

    /// The bytes that `cleanup` frees for `who`: its entry in a task, revealed at `uri` if it
    /// was revealed, and the entry's place in the task's entrant order.
    fn entry_bytes(who: &str, revealed: Option<&str>) -> u64 {
        let account = 4 + who.len() as u64;
        // The entry is keyed by the task id and the account. It holds the commitment, the index,
        // the block and `revealed`: a 1-byte tag, then for a revealed entry the content hash and
        // the uri behind its 4-byte length.
        let work = revealed.map_or(0, |uri| 32 + 4 + uri.len() as u64);
        let entry = 40 + (1 + 8 + account) + (32 + 4 + 8 + 1 + work);
        // The place is keyed by the task id and the index, and holds the account.
        let place = 40 + (1 + 8 + 4) + account;
        entry + place
    }

    #[test]
    fn cleanup_requires_settled() {
        let mut t = world();
        let id = post(&mut t, args());
        revealed(&mut t, id, &["bob.test"]);
        // Whatever the block time, a task without an outcome is not cleaned: not while it is open,
        // not in any of its windows, and not once the last of them is over, when anyone may void
        // the task but nobody has.
        for (what, now) in [
            ("open", T1),
            ("in the reveal window", COMMIT_DEADLINE),
            ("in the verifier's window", REVEAL_DEADLINE),
            ("in the poster's window", PICK_DEADLINE),
            ("expired", FALLBACK_DEADLINE),
            ("expired for good", u64::MAX),
        ] {
            let result = try_cleanup(&mut t, KEEPER, id, now, 50).map(|_| ());
            let message = assert_rejected(result, "E_PHASE", what);
            assert_eq!(message, "E_PHASE: not settled");
        }
        // Nothing moved.
        assert!(t.get_entry(U64(id), acct("bob.test")).is_some());
        assert_eq!(cleaned(&t, id), 0);
        // Once the task settles, the same call goes through.
        try_pick(&mut t, JUDGE, id, REVEAL_DEADLINE, &[("bob.test", 10_000)]).unwrap();
        assert_eq!(try_cleanup(&mut t, KEEPER, id, REVEAL_DEADLINE, 50), Ok(1));
        assert_eq!(t.get_entry(U64(id), acct("bob.test")), None);
    }

    #[test]
    fn cleanup_in_batches_refunds_each_entrant() {
        let mut t = world();
        // carol is a registered agent, so her first commit gave her an `earned` slot beside her
        // vault slot. bob and dave are not, and got a vault slot only.
        register_agent(&mut t, "carol.test");
        let crowd = [
            ("bob.test", false),
            ("carol.test", true),
            ("dave.test", false),
        ];
        let names = crowd.map(|(who, _)| who);
        // What each is charged before it enters anything.
        let start = names.map(|who| used(&t, who));
        let id = post(&mut t, args());
        revealed(&mut t, id, &names);
        try_pick(
            &mut t,
            JUDGE,
            id,
            REVEAL_DEADLINE,
            &[("bob.test", 6_000), ("carol.test", 4_000)],
        )
        .unwrap();
        // The premise: each is charged for its entry, the entry's place in the entrant order and
        // the payout slots that its first commit made.
        for (i, (who, agent)) in crowd.into_iter().enumerate() {
            assert_eq!(
                used(&t, who),
                start[i] + slot_bytes(who, agent) + entry_bytes(who, Some(URI)),
                "{who}"
            );
        }
        let settled = names.map(|who| used(&t, who));
        let (alice_used, paid) = (used(&t, "alice.test"), money(&t));

        // A batch of 2 goes through bob and carol, the first two entrants, and frees exactly
        // their entries and places. It says nothing.
        testing_env!(ctx(KEEPER).block_timestamp(FALLBACK_DEADLINE).build());
        let usage = t.storage_mark();
        assert_eq!(t.cleanup(U64(id), 2), 2);
        assert_eq!(
            usage - t.storage_mark(),
            entry_bytes("bob.test", Some(URI)) + entry_bytes("carol.test", Some(URI))
        );
        assert!(get_logs().is_empty(), "cleanup emits no event");
        // The two are back where they were before they committed, plus the payout slots, which
        // stay. dave is charged for his entry still, and it is still there.
        assert_eq!(
            used(&t, "bob.test"),
            start[0] + slot_bytes("bob.test", false)
        );
        assert_eq!(
            used(&t, "carol.test"),
            start[1] + slot_bytes("carol.test", true)
        );
        assert_eq!(used(&t, "dave.test"), settled[2]);
        for who in ["bob.test", "carol.test"] {
            assert_eq!(t.get_entry(U64(id), acct(who)), None, "{who}");
        }
        assert!(t.get_entry(U64(id), acct("dave.test")).is_some());
        assert_eq!(remaining(&t, id, 0), [(2, "dave.test".to_string())]);
        assert_eq!(cleaned(&t, id), 2);

        // The next batch of 2 finds only dave.
        assert_eq!(clean(&mut t, id, 2), 1);
        assert_eq!(
            used(&t, "dave.test"),
            start[2] + slot_bytes("dave.test", false)
        );
        assert_eq!(t.get_entry(U64(id), acct("dave.test")), None);
        assert!(remaining(&t, id, 0).is_empty());
        assert_eq!(cleaned(&t, id), 3);
        // And nothing is left after that.
        assert_eq!(clean(&mut t, id, 2), 0);
        assert_eq!(cleaned(&t, id), 3);

        // Only the entrants' storage changed: the poster's did not, the keeper never had any, and
        // no money moved, since the payouts sit in the vault slots that cleanup leaves alone.
        assert_eq!(used(&t, "alice.test"), alice_used);
        assert_eq!(t.storage_balance_of(acct(KEEPER)), None);
        assert_eq!(money(&t), paid);
        assert_eq!(agent(&t, "carol.test").earned, usdc(380_000));
        let v = t.get_task(U64(id)).expect("the task is kept");
        assert_eq!(
            (v.phase, v.commit_count, v.reveal_count, v.cleaned),
            (Phase::Settled, 3, 3, 3)
        );
        assert!(matches!(v.outcome, Some(OutcomeView::Picked { .. })));
    }

    #[test]
    fn cleanup_limit_bounds() {
        let mut t = world();
        let id = post(&mut t, args());
        revealed(&mut t, id, &["bob.test", "carol.test", "dave.test"]);
        try_pick(&mut t, JUDGE, id, REVEAL_DEADLINE, &[("bob.test", 10_000)]).unwrap();
        // A batch is 1 to 50 entries.
        for limit in [0, 51, 52, 100, u32::MAX] {
            let result = try_cleanup(&mut t, KEEPER, id, FALLBACK_DEADLINE, limit).map(|_| ());
            let message = assert_rejected(result, "E_LIMIT", &format!("a limit of {limit}"));
            assert_eq!(
                message,
                format!("E_LIMIT: limit must be 1 to 50, got {limit}")
            );
        }
        assert_eq!(cleaned(&t, id), 0, "nothing moved");
        assert_eq!(remaining(&t, id, 0).len(), 3);
        // Both ends are allowed: 1 goes through one entry, and 50, far more than are left, through
        // the other two and no further.
        assert_eq!(clean(&mut t, id, 1), 1);
        assert_eq!(cleaned(&t, id), 1);
        assert_eq!(clean(&mut t, id, 50), 2);
        assert_eq!(cleaned(&t, id), 3);
        assert!(remaining(&t, id, 0).is_empty());
        // A task with nothing left to clean takes the same limits.
        for limit in [0, 51] {
            let result = try_cleanup(&mut t, KEEPER, id, FALLBACK_DEADLINE, limit).map(|_| ());
            assert_rejected(result, "E_LIMIT", &format!("a limit of {limit}, none left"));
        }
        for limit in [1, 50] {
            assert_eq!(clean(&mut t, id, limit), 0);
        }
    }

    #[test]
    fn cleanup_batch_stops_at_the_limit() {
        let mut t = world();
        let id = post(&mut t, args());
        // 55 entrants who never reveal, so anyone may void the task once the reveal window is over.
        let who: Vec<String> = (0..55).map(|i| format!("agent{i}.test")).collect();
        let mut start = Vec::new();
        for (seed, w) in who.iter().enumerate() {
            register(&mut t, w, NearToken::from_millinear(100));
            start.push(used(&t, w));
            enter(&mut t, w, id, seed as u8);
        }
        try_void(&mut t, KEEPER, id, REVEAL_DEADLINE).unwrap();

        // The first batch is as large as one can be, though 5 more entries are waiting.
        assert_eq!(clean(&mut t, id, 50), 50);
        assert_eq!(cleaned(&t, id), 50);
        for (i, w) in who.iter().enumerate() {
            let gone = i < 50;
            assert_eq!(t.get_entry(U64(id), acct(w)).is_none(), gone, "{w}");
            let entry = if gone { 0 } else { entry_bytes(w, None) };
            assert_eq!(used(&t, w), start[i] + slot_bytes(w, false) + entry, "{w}");
        }
        assert!(remaining(&t, id, 0).is_empty());
        let left: Vec<u32> = remaining(&t, id, 50).into_iter().map(|(i, _)| i).collect();
        assert_eq!(left, [50, 51, 52, 53, 54]);

        // The next batch takes them, and nothing more.
        assert_eq!(clean(&mut t, id, 50), 5);
        assert_eq!(cleaned(&t, id), 55);
        for (i, w) in who.iter().enumerate() {
            assert_eq!(t.get_entry(U64(id), acct(w)), None, "{w}");
            assert_eq!(used(&t, w), start[i] + slot_bytes(w, false), "{w}");
        }
        assert_eq!(clean(&mut t, id, 50), 0);
    }

    #[test]
    fn cleanup_of_a_missing_task_is_not_found() {
        let mut t = world();
        let result = try_cleanup(&mut t, KEEPER, 99, FALLBACK_DEADLINE, 50).map(|_| ());
        let message = assert_rejected(result, "E_NOT_FOUND", "a cleanup of a missing task");
        assert_eq!(message, "E_NOT_FOUND: no task 99");
    }

    #[test]
    fn cleanup_rules_are_checked_in_the_listed_order() {
        let mut t = world();
        let id = post(&mut t, args());
        // Every call below has a limit of 0, which is the last rule in the list, so the rule that
        // it is rejected for is the earlier one that it also breaks.
        let result = try_cleanup(&mut t, KEEPER, 99, T1, 0).map(|_| ());
        assert_rejected(result, "E_NOT_FOUND", "a missing task");
        let result = try_cleanup(&mut t, KEEPER, id, T1, 0).map(|_| ());
        assert_rejected(result, "E_PHASE", "an unsettled task");
        // Once the task is settled, the limit is all that is wrong with the call.
        try_void(&mut t, KEEPER, id, REVEAL_DEADLINE).unwrap();
        let result = try_cleanup(&mut t, KEEPER, id, T1, 0).map(|_| ());
        assert_rejected(result, "E_LIMIT", "a bad limit");
        assert_eq!(try_cleanup(&mut t, KEEPER, id, T1, 1), Ok(0));
    }

    #[test]
    fn cleanup_with_nothing_left_does_nothing() {
        let mut t = world();
        // One task that nobody entered, and one whose entries are all cleaned.
        let quiet = post(&mut t, args());
        let busy = post(&mut t, args());
        revealed(&mut t, busy, &["bob.test", "carol.test"]);
        try_void(&mut t, KEEPER, quiet, REVEAL_DEADLINE).unwrap();
        try_pick(
            &mut t,
            JUDGE,
            busy,
            REVEAL_DEADLINE,
            &[("bob.test", 10_000)],
        )
        .unwrap();
        assert_eq!(clean(&mut t, busy, 50), 2);
        for id in [quiet, busy] {
            let task = t.tasks.get(&id).cloned();
            let (stored, paid) = (charged(&t), money(&t));
            testing_env!(ctx(KEEPER).block_timestamp(FALLBACK_DEADLINE).build());
            // The mocked VM charges gas for each host call, so a write shows up in the gas even
            // when it stores the bytes that are there already, and the bytes cannot tell. A mark
            // alone costs some gas. The call and a mark cost the same only if the call made no
            // host call of its own and left no write for the mark to flush.
            let usage = t.storage_mark();
            let gas = env::used_gas().as_gas();
            let _ = t.storage_mark();
            let mark_gas = env::used_gas().as_gas() - gas;
            let gas = env::used_gas().as_gas();
            // The call goes through and returns 0.
            assert_eq!(t.cleanup(U64(id), 50), 0, "task {id}");
            assert_eq!(t.storage_mark(), usage, "task {id}: no bytes");
            assert_eq!(
                env::used_gas().as_gas() - gas,
                mark_gas,
                "task {id}: no write"
            );
            // It changes nothing and says nothing.
            assert!(get_logs().is_empty(), "task {id}: no event");
            assert_eq!(
                t.tasks.get(&id).cloned(),
                task,
                "task {id}: the same record"
            );
            assert_eq!(charged(&t), stored, "task {id}: nobody is refunded");
            assert_eq!(money(&t), paid, "task {id}: no money moved");
        }
        assert_eq!((cleaned(&t, quiet), cleaned(&t, busy)), (0, 2));
    }

    #[test]
    fn cleanup_cleans_unrevealed_entries_too() {
        let mut t = world();
        let id = post(&mut t, args());
        let names = ["bob.test", "carol.test", "dave.test"];
        let start = names.map(|who| used(&t, who));
        for (seed, who) in names.into_iter().enumerate() {
            enter(&mut t, who, id, seed as u8);
        }
        // Only bob reveals. carol and dave leave their entries sealed.
        reveal(&mut t, "bob.test", id, 0);
        try_pick(&mut t, JUDGE, id, REVEAL_DEADLINE, &[("bob.test", 10_000)]).unwrap();
        // The premise: each is charged for just what it wrote, which is less for a sealed entry.
        for (i, who) in names.into_iter().enumerate() {
            let revealed = (i == 0).then_some(URI);
            assert_eq!(
                used(&t, who),
                start[i] + slot_bytes(who, false) + entry_bytes(who, revealed),
                "{who}"
            );
        }
        // Sealed or revealed, every entry goes, and its entrant is refunded exactly its bytes.
        assert_eq!(clean(&mut t, id, 50), 3);
        for (i, who) in names.into_iter().enumerate() {
            assert_eq!(t.get_entry(U64(id), acct(who)), None, "{who}");
            assert_eq!(used(&t, who), start[i] + slot_bytes(who, false), "{who}");
        }
        assert_eq!(cleaned(&t, id), 3);
    }

    #[test]
    fn cleanup_does_not_need_the_entrants_deposit() {
        let mut t = world();
        let id = post(&mut t, args());
        let start = used(&t, "bob.test");
        revealed(&mut t, id, &["bob.test", "carol.test"]);
        try_pick(&mut t, JUDGE, id, REVEAL_DEADLINE, &[("bob.test", 10_000)]).unwrap();
        // With no deposit left at all, as when a rise in the storage price leaves a deposit short
        // of the bytes it paid for, bob's refund still goes through: it never looks at a balance,
        // so one entrant cannot stop a batch, or the cleanups after it.
        t.storage.get_mut(&acct("bob.test")).unwrap().deposited = 0;
        assert_eq!(clean(&mut t, id, 50), 2);
        assert_eq!(used(&t, "bob.test"), start + slot_bytes("bob.test", false));
        assert_eq!(t.get_entry(U64(id), acct("bob.test")), None);
        assert_eq!(t.get_entry(U64(id), acct("carol.test")), None);
    }

    #[test]
    fn cleanup_skips_an_index_whose_record_is_gone() {
        let mut t = world();
        let id = post(&mut t, args());
        let names = ["bob.test", "carol.test", "dave.test", "erin.test"];
        let start = names.map(|who| used(&t, who));
        revealed(&mut t, id, &names);
        try_pick(&mut t, JUDGE, id, REVEAL_DEADLINE, &[("bob.test", 10_000)]).unwrap();
        // carol's place in the entrant order, index 1, is gone already, as if an earlier cleanup
        // had stopped half way.
        t.entrant_at.remove(&(id, 1u32));
        let _ = t.storage_mark();
        let carol_used = used(&t, "carol.test");

        // The gap counts toward the batch, and does not end it: a batch of 3 goes through bob, the
        // gap and dave, and leaves erin for the next one.
        assert_eq!(clean(&mut t, id, 3), 3);
        assert_eq!(cleaned(&t, id), 3);
        for (i, who) in [(0, "bob.test"), (2, "dave.test")] {
            assert_eq!(t.get_entry(U64(id), acct(who)), None, "{who}");
            assert_eq!(used(&t, who), start[i] + slot_bytes(who, false), "{who}");
        }
        assert!(t.get_entry(U64(id), acct("erin.test")).is_some());
        assert_eq!(clean(&mut t, id, 3), 1);
        assert_eq!(cleaned(&t, id), 4);
        assert_eq!(
            used(&t, "erin.test"),
            start[3] + slot_bytes("erin.test", false)
        );
        // Nobody is refunded for the gap. carol's entry cannot be found without its place, so it
        // stays, and so does what carol is charged for it.
        assert!(t.get_entry(U64(id), acct("carol.test")).is_some());
        assert_eq!(used(&t, "carol.test"), carol_used);
        assert_eq!(clean(&mut t, id, 50), 0);
    }

    #[test]
    fn cleanup_batch_bounds_cannot_wrap() {
        let mut t = world();
        let id = post(&mut t, args());
        try_void(&mut t, KEEPER, id, REVEAL_DEADLINE).unwrap();
        // No task has billions of entries, but the bounds of a batch are sums of u32s and must not
        // wrap. Here 10 indices are left before the largest one, and none of them has a record.
        let task = t.tasks.get_mut(&id).unwrap();
        (task.commit_count, task.cleaned) = (u32::MAX, u32::MAX - 10);
        assert_eq!(clean(&mut t, id, 50), 10);
        assert_eq!(cleaned(&t, id), u32::MAX);
        assert_eq!(clean(&mut t, id, 50), 0);
    }

    #[test]
    fn cleanup_works_for_any_caller_while_paused() {
        let mut t = world();
        let id = post(&mut t, args());
        let start = AGENTS.map(|who| used(&t, who));
        for (seed, who) in AGENTS.into_iter().enumerate() {
            enter(&mut t, who, id, seed as u8);
        }
        // Nobody reveals, so anyone may void the task once the reveal window is over.
        try_void(&mut t, KEEPER, id, REVEAL_DEADLINE).unwrap();
        // A pause stops new tasks only. It never stands between an entrant and its storage.
        t.paused = true;
        let alice_used = used(&t, "alice.test");
        // One entry per call, and a different caller each time: a stranger with no storage
        // balance at all, the poster, the verifier, an entrant whose own entry is already gone,
        // and the owner of the last entry. Each call refunds the owner of the next entry, never
        // the caller.
        let callers = [
            "stranger.test",
            "alice.test",
            JUDGE,
            "bob.test",
            "frank.test",
        ];
        for (i, caller) in callers.into_iter().enumerate() {
            let result = try_cleanup(&mut t, caller, id, FALLBACK_DEADLINE, 1);
            assert_eq!(result, Ok(1), "{caller}");
            assert!(get_logs().is_empty(), "{caller}: no event");
            for (j, who) in AGENTS.into_iter().enumerate() {
                // The entries up to the one just cleaned are gone, and the rest are still charged.
                let entry = if j > i { entry_bytes(who, None) } else { 0 };
                assert_eq!(
                    used(&t, who),
                    start[j] + slot_bytes(who, false) + entry,
                    "{who}, after {caller}'s call"
                );
            }
        }
        assert_eq!(cleaned(&t, id), 5);
        assert_eq!(used(&t, "alice.test"), alice_used);
        assert_eq!(t.storage_balance_of(acct("stranger.test")), None);
    }

    #[test]
    fn cleanup_keeps_the_task_and_every_payout() {
        let mut t = world();
        register_agent(&mut t, "carol.test");
        let (done, other) = (post(&mut t, args()), post(&mut t, args()));
        let names = ["bob.test", "carol.test"];
        let start = names.map(|who| used(&t, who));
        // bob and carol enter and reveal in both tasks. Only the first is settled, and bob wins it.
        revealed(&mut t, done, &names);
        revealed(&mut t, other, &names);
        try_pick(
            &mut t,
            JUDGE,
            done,
            REVEAL_DEADLINE,
            &[("bob.test", 10_000)],
        )
        .unwrap();
        let task = t.tasks.get(&done).cloned().expect("the task exists");
        assert!(task.outcome.is_some());
        let untouched = t.tasks.get(&other).cloned();
        let (paid, carol) = (money(&t), agent(&t, "carol.test"));
        let slots = names.map(|who| t.balances_of(acct(who)));
        assert_eq!(slots[0], usdc(950_000));
        assert_eq!(slots[1], usdc(0), "carol lost, but has the slot");

        assert_eq!(clean(&mut t, done, 50), 2);
        // The task keeps its record and its outcome, and only `cleaned` has moved.
        assert_eq!(
            t.tasks.get(&done),
            Some(&Task { cleaned: 2, ..task }),
            "the task is kept"
        );
        // Every vault slot keeps what is in it, even the empty one, and the `earned` slot, the
        // wins and the counters stay as they were.
        assert_eq!(money(&t), paid);
        assert_eq!(names.map(|who| t.balances_of(acct(who))), slots);
        assert_eq!(agent(&t, "carol.test"), carol);
        // The other task is not touched, nor are the entries in it. Each entrant is charged for
        // that entry still.
        assert_eq!(t.tasks.get(&other).cloned(), untouched);
        assert_eq!(cleaned(&t, other), 0);
        assert_eq!(
            remaining(&t, other, 0),
            [(0, "bob.test".to_string()), (1, "carol.test".to_string())]
        );
        for (i, who) in names.into_iter().enumerate() {
            assert_eq!(t.get_entry(U64(done), acct(who)), None, "{who}");
            assert_eq!(
                used(&t, who),
                start[i] + slot_bytes(who, i == 1) + entry_bytes(who, Some(URI)),
                "{who}"
            );
        }
    }
}
