//! Property tests: random sequences of real calls with the invariants of spec 6.10 checked after
//! every one, and the payout math on its own.
//!
//! `invariants_hold_after_every_call` drives runs of 30 to 60 random operations, the first of them
//! a post, through the public methods, by four accounts (`p.test`, `a.test`, `b.test` and `c.test`), in one token, with every
//! window 60 s long. An operation is one call, or two for a withdrawal and its callback, and an
//! operation the contract rejects is skipped. Most operations are steered to a task and an
//! account they can act on (see `Target`), since random ones would mostly name a task that does
//! not exist or is in the wrong phase. After every operation it checks:
//! - I1: the vault balances of all accounts, the treasury included, plus the rewards of the
//!   unsettled tasks, plus the agent bonds the contract holds, equal the deposits taken in less the
//!   withdrawals paid out;
//! - I2: a task's outcome is set once, by the call that settles it, and never changes after it; a
//!   second pick or void is rejected `E_SETTLED`;
//! - I5: a withdrawal whose transfer fails is restored exactly once, to the balance it started
//!   from, never doubled;
//! - I7: a picked task's payouts and fee add up to its reward;
//! - I10: a task's `commit_count` is the number of distinct accounts that committed to it.
//!
//! The owner sets an agent bond of `BOND` and a cooldown of one window, and `a.test` and `b.test`
//! register with it in the setup; `c.test` and `p.test` may register in the run. A commit, which
//! always goes to an open task here, must go through exactly when the task is in its commit window,
//! the account is not its poster and is an active agent; a registration, an unregistration and a
//! claim must go through exactly when the agent's status, the clock and its balance allow, and
//! each agent's status and recorded bond must be what the calls so far make them.
//!
//! Beside these, it checks that every account holds what the calls so far add up to for it, so
//! that money paid to the wrong account shows, and money in an account the harness does not know
//! of; that `ft_on_transfer` never panics (I8); that a pick, an empty pick or a void that the
//! rules allow always goes through, `void_task` from the fallback deadline on among them (I4), and
//! so do a withdrawal that the balance covers and a top-up that the rules allow, and that no other
//! settlement or top-up does; that every rejection panics with an `E_` code, so that a crash
//! cannot pass for a rule; that a task's
//! `reveal_count` is its number of reveals; that its funders are the poster and then each account
//! that topped it up, in that order, each with what it paid in, adding up to its reward, so that
//! an empty pick or a void refunds each of them exactly that; and that every rejected call leaves
//! the state exactly as it found it.
//!
//! `payout_math_conserves` checks the split of a pick on its own, for rewards up to 10^30.
//!
//! # How a call runs
//!
//! On chain, the runtime reverts a call that panics. A test that keeps one `Tender` and catches
//! the panic gets no such revert: `near_sdk::store` collections cache their writes, so a failed
//! call can leave writes in the caches, and the next flush or drop stores them. So the harness runs
//! every call the way the runtime runs a receipt. The mocked trie holds the whole state between
//! calls. A call reads the contract from it, as the generated method wrapper does, and when the
//! method returns, writes every cached change and then the state back to it. A call that panics is
//! written back too, but only to see what it changed: the harness asserts that the trie and
//! `env::storage_usage()` are exactly as they were before the call, and then puts back the copy of
//! the trie it took before the call, which also drops the failed call's logs and receipts. So
//! "a rejection changes nothing" is checked on every rejected call, not assumed.

use std::any::Any;
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap};

use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::json_types::{U128, U64};
use near_sdk::mock::with_mocked_blockchain;
use near_sdk::test_utils::get_logs;
use near_sdk::{
    borsh, env, test_vm_config, AccountId, IntoStorageKey, MockedBlockchain, NearToken,
    PromiseError, PromiseOrValue, PromiseResult, RuntimeFeesConfig, VMContext,
};
use proptest::prelude::*;

use crate::entries::commitment_of;
use crate::settle::split_reward;
use crate::test_utils::{ctx, fresh, panic_message};
use crate::types::{
    hex32, AgentProfile, AgentStatus, OutcomeView, Phase, PostTaskArgs, VoidReason, WinnerArg,
    MAX_FEE_BPS, MAX_FUNDERS, MAX_WINNERS,
};
use crate::{StorageKey, Tender};

/// Every key and value of the contract's storage, as the mocked blockchain keeps them.
type Trie = HashMap<Vec<u8>, Vec<u8>>;

/// What one operation came to: `Ok(Err(message))` if the contract rejected it, `Err` if an
/// invariant failed.
type Step = Result<Result<(), String>, TestCaseError>;

/// The token of every deposit, task and withdrawal.
const TOKEN: &str = "token.test";
/// The owner and the treasury that `fresh` configures, and the contract's own account.
const OWNER: &str = "owner.test";
const TREASURY: &str = "treasury.test";
const CONTRACT: &str = "tender.test";
/// An account with no part in any task, which voids and cleans up as the keeper does.
const KEEPER: &str = "keeper.test";
/// The block time of the first operation: above 2^53 nanoseconds, as in the other tests.
const T0: u64 = 1_793_028_278_935_742_660;
const SEC: u64 = 1_000_000_000;
/// The length of every window of every task: the `min_window_secs` that `fresh` configures.
const WINDOW_SECS: u32 = 60;
/// The largest amount one operation deposits or withdraws.
const MAX_AMOUNT: u128 = 1_000_000_000;
/// The token's reward limits: `set_token(TOKEN, 10, 10^30, true)`. A minimum above 1 makes the
/// small amounts the runs draw meet the rule that an account's first top-up of a task is at least
/// `min_reward`.
const MIN_REWARD: u128 = 10;
const MAX_REWARD: u128 = 10u128.pow(30);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const NO_DEPOSIT: NearToken = NearToken::from_yoctonear(0);
const BRIEF_URI: &str = "https://api.tender.example/v1/blobs/b94d27b9";
/// sha256("hello world").
const BRIEF_HASH: &str = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";
/// sha256("foo").
const CRITERIA_HASH: &str = "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae";
/// Where the entrants publish their work.
const ENTRY_URI: &str = "https://api.tender.example/v1/results/2c26b46b";
/// sha256("bar"), standing in for the hash of a scorecard.
const SCORECARD_HASH: &str = "fcde2b2edba56bf408601fb721fe9b5c338d10ee429ea04fae5511b68fbf8fb9";
const SCORECARD_URI: &str = "https://api.tender.example/v1/blobs/fcde2b2e";
const PROFILE_URI: &str = "https://acme.example/agent.json";
/// The agent bond the owner sets in the setup, in `TOKEN`.
const BOND: u128 = 7;
/// The bond cooldown the owner sets: one window.
const COOLDOWN_SECS: u64 = WINDOW_SECS as u64;

/// One of the four accounts that deposit, post, enter and withdraw.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Who {
    P,
    A,
    B,
    C,
}

impl Who {
    const ALL: [Who; 4] = [Who::P, Who::A, Who::B, Who::C];

    fn id(self) -> &'static str {
        match self {
            Who::P => "p.test",
            Who::A => "a.test",
            Who::B => "b.test",
            Who::C => "c.test",
        }
    }

    fn account(self) -> AccountId {
        acct(self.id())
    }
}

/// One operation of a random run.
#[derive(Clone, Debug)]
enum Op {
    /// The token reports a transfer of `amount` from `who` to `ft_on_transfer`, with no `msg`.
    Deposit { who: Who, amount: u128 },
    /// `who` posts a task with `reward`, and is its verifier. With no `who`, the account that
    /// should hold the most does (the first in account order on a tie).
    Post { who: Option<Who>, reward: u128 },
    /// `who` commits new work to the task, which replaces any commitment it made to it before.
    /// With no `who`, the first account, in account order, that is not the poster and has not
    /// committed to the task yet does. Steered to an open task.
    Commit { who: Option<Who>, task: Target },
    /// `who` reveals the work it committed last to the task. With no `who`, the first of the
    /// task's entrants, in account order, that has not revealed yet does. Steered to a task in
    /// its reveal window with an entrant that has not revealed.
    Reveal { who: Option<Who>, task: Target },
    /// The block time moves on by `secs` seconds.
    Advance { secs: u64 },
    /// The task's poster picks its revealed entrants, in account order, one per weight in `split`
    /// while they last, with shares in the proportions of the weights. The weights are 1 to 100
    /// and at most 5, so that every share is positive. If nobody revealed, it picks entrants that
    /// did not, which the contract rejects. Steered to a task in a pick window that has a
    /// revealed entry.
    Pick { task: Target, split: Vec<u16> },
    /// The task's poster picks no winner. Steered to a task in a pick window.
    EmptyPick { task: Target },
    /// The keeper voids the task. Steered to a task that is past its fallback deadline, or past
    /// its reveal deadline with nothing revealed.
    Void { task: Target },
    /// `who` withdraws `amount`, or its whole balance if `None`. Then the token's transfer
    /// succeeds if `ok` and fails otherwise, and `on_withdraw` runs with that result.
    Withdraw {
        who: Who,
        amount: Option<u128>,
        ok: bool,
    },
    /// The keeper cleans up at most `limit` entries of the task. Steered to a settled task that
    /// had entrants.
    Cleanup { task: Target, limit: u32 },
    /// `who` registers as an agent, or registers again, with 1 yoctoNEAR.
    Register { who: Who },
    /// `who` starts unregistering, with 1 yoctoNEAR.
    Unregister { who: Who },
    /// `who` claims its bond back, with 1 yoctoNEAR.
    Claim { who: Who },
    /// `who` tops the task up by `amount`, with 1 yoctoNEAR. Steered to an open task.
    TopUp {
        who: Who,
        task: Target,
        amount: u128,
    },
}

/// The task an operation acts on.
#[derive(Clone, Copy, Debug)]
enum Target {
    /// One of the tasks that the operation can act on, as the harness's clock and model tell it
    /// (each operation says which): the `n % len`th of them in id order. The newest task if
    /// there is none, which the contract then rejects.
    Live(u8),
    /// The task with this id, in whatever phase it is, or none if there is no such task.
    Id(u64),
}

/// How a pick or a void settles a task.
enum Settlement {
    Pick(Vec<WinnerArg>),
    Empty,
    Void,
}

/// What the harness knows of a task from the calls that went through.
struct TaskModel {
    poster: Who,
    reward: u128,
    /// Who paid the reward in and how much: the poster first, then each account that topped the
    /// task up, in the order of its first top-up.
    funders: Vec<(Who, u128)>,
    /// The block time it was posted at. Its deadlines are 1, 2, 3 and 4 windows later.
    posted_at: u64,
    /// The seed of the work each entrant committed last. Its keys are the distinct committers.
    works: BTreeMap<Who, u32>,
    revealed: BTreeSet<Who>,
    /// The outcome as read right after the call that settled the task.
    outcome: Option<OutcomeView>,
}

/// What the harness knows of a registered agent from the calls that went through. `bond` is what
/// the contract holds for it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AgentModel {
    Active { bond: u128 },
    Unregistering { bond: u128, claimable_at: u64 },
    Retired,
}

impl AgentModel {
    fn bond(self) -> u128 {
        match self {
            AgentModel::Active { bond } | AgentModel::Unregistering { bond, .. } => bond,
            AgentModel::Retired => 0,
        }
    }
}

/// The contract in the mocked blockchain, and the harness's account of everything that went
/// through: the money in and out, the balance each account should hold, the tasks and the agents.
struct World {
    /// The block time and height of the next call.
    now: u64,
    height: u64,
    /// The deposits that `ft_on_transfer` kept, and the withdrawals whose transfer succeeded.
    deposited: u128,
    withdrawn: u128,
    /// The vault balance that each of the four accounts and the treasury should hold.
    balances: BTreeMap<AccountId, u128>,
    /// The tasks by id, from 1.
    tasks: Vec<TaskModel>,
    /// The registered agents.
    agents: BTreeMap<Who, AgentModel>,
    /// For each agent, the latest commit deadline among the open tasks it entered: before it,
    /// its bond cannot be claimed.
    locked: BTreeMap<Who, u64>,
    /// The seed of the next work committed.
    next_seed: u32,
}

impl World {
    /// The contract set up through its real methods: the owner registers storage and allowlists
    /// the token, which also gives the treasury its vault slot, and the four accounts register 10
    /// NEAR of storage each, so that storage never limits what they can do. The fee (500 bps)
    /// and the shortest window (60 s) are the ones `fresh` initialises with.
    ///
    /// The owner sets a bond of `BOND` and a cooldown of `COOLDOWN_SECS`. Then `p.test` deposits
    /// `MAX_AMOUNT`, so that a run can post from its first operation on instead of waiting for a
    /// deposit, and `a.test` and `b.test` each deposit `BOND` and register with it, which leaves
    /// their vaults empty. `c.test` starts with no vault slot.
    fn new() -> Self {
        // Every run starts from an empty trie. All the cases of a property run on one thread, and
        // `testing_env!`, which `fresh` calls, keeps the trie of the blockchain it replaces.
        install(ctx(OWNER).build(), Vec::new(), Trie::new());
        // What the generated wrapper of `#[init]` does with the new contract.
        persist(fresh());
        let mut world = World {
            now: T0,
            height: 1,
            deposited: 0,
            withdrawn: 0,
            balances: BTreeMap::new(),
            tasks: Vec::new(),
            agents: BTreeMap::new(),
            locked: BTreeMap::new(),
            next_seed: 0,
        };
        world.setup(OWNER, NearToken::from_near(1), |t| {
            t.storage_deposit(None, None);
        });
        world.setup(OWNER, ONE_YOCTO, |t| {
            t.set_token(acct(TOKEN), U128(MIN_REWARD), U128(MAX_REWARD), true)
        });
        for who in Who::ALL {
            world.setup(who.id(), NearToken::from_near(10), |t| {
                t.storage_deposit(None, None);
            });
            world.balances.insert(who.account(), 0);
        }
        world.setup(OWNER, ONE_YOCTO, |t| {
            t.set_agent_bond(acct(TOKEN), U128(BOND))
        });
        world.setup(OWNER, ONE_YOCTO, |t| {
            t.set_agent_bond_cooldown(U64(COOLDOWN_SECS))
        });
        world.balances.insert(acct(TREASURY), 0);
        match world.deposit(Who::P, MAX_AMOUNT) {
            Ok(Ok(())) => {}
            other => panic!("the setup deposit failed: {other:?}"),
        }
        // a.test and b.test deposit the bond and register with it, so that open tasks have
        // entrants from the first operation on. c.test and p.test have not registered.
        for who in [Who::A, Who::B] {
            for step in [World::deposit_bond, World::register] {
                match step(&mut world, who) {
                    Ok(Ok(())) => {}
                    other => panic!("the setup registration of {who:?} failed: {other:?}"),
                }
            }
        }
        world
    }

    /// Runs a call of the setup, which must go through.
    fn setup(&mut self, who: &str, deposit: NearToken, f: impl FnOnce(&mut Tender)) {
        match self.call(who, deposit, Vec::new(), f) {
            Ok(Ok(())) => {}
            other => panic!("the setup call by {who} failed: {other:?}"),
        }
    }

    /// The context of a call by `who` with `deposit` attached, at the harness's clock.
    fn context(&self, who: &str, deposit: NearToken) -> VMContext {
        ctx(who)
            .attached_deposit(deposit)
            .block_timestamp(self.now)
            .block_height(self.height)
            .build()
    }

    /// Runs `f` as one receipt, in which `who` calls the contract with `deposit` attached and
    /// `results` as the results of the promises a callback waits on. Returns what `f` returned,
    /// or the message of the panic that rejected the call (see the module docs).
    fn call<R>(
        &mut self,
        who: &str,
        deposit: NearToken,
        results: Vec<PromiseResult>,
        f: impl FnOnce(&mut Tender) -> R,
    ) -> Result<Result<R, String>, TestCaseError> {
        let context = self.context(who, deposit);
        self.height += 1;
        let before = take_trie();
        install(context, results, before.clone());
        let usage = env::storage_usage();
        let mut contract: Tender = env::state_read().expect("the contract state");
        let mut value = None;
        let rejection = panic_message(|| value = Some(f(&mut contract)));
        persist(contract);
        let Some(message) = rejection else {
            return Ok(Ok(value.expect("the call returned")));
        };
        let usage_after = env::storage_usage();
        let after = take_trie();
        let changed = changed_keys(&before, &after);
        // The revert: the trie as the call found it, in a blockchain without its logs or receipts.
        install(self.context(KEEPER, NO_DEPOSIT), Vec::new(), before);
        prop_assert!(
            changed.is_empty() && usage_after == usage,
            "a rejected call changed the state: {who} was rejected with {message:?}, but changed \
             the keys {changed:?}, and the storage usage from {usage} to {usage_after}"
        );
        // Every rule the contract checks panics with a code. Anything else, such as an overflow,
        // an `unwrap` or an index out of bounds, is a crash that only looks like a rejection.
        prop_assert!(
            message.starts_with("E_"),
            "{who}'s call panicked without an error code, which is a crash, not a rule: {message:?}"
        );
        Ok(Err(message))
    }

    /// Runs `f` on the contract in a view call at the harness's clock.
    fn view<R>(&self, f: impl FnOnce(&Tender) -> R) -> R {
        install(self.context(KEEPER, NO_DEPOSIT), Vec::new(), take_trie());
        let contract: Tender = env::state_read().expect("the contract state");
        f(&contract)
    }

    fn balance(&self, account: &AccountId) -> u128 {
        self.view(|t| t.balance_of(account.clone(), acct(TOKEN)).0)
    }

    fn task(&self, id: u64) -> Option<&TaskModel> {
        let index = usize::try_from(id).ok()?.checked_sub(1)?;
        self.tasks.get(index)
    }

    /// The phase that `m` is in now, worked out from the model with the half-open windows of the
    /// spec rather than read from the contract: it steers operations, and it is what `settle`
    /// holds the contract to when it says which settlements must go through.
    fn phase(&self, m: &TaskModel) -> Phase {
        let windows = (self.now - m.posted_at) / (u64::from(WINDOW_SECS) * SEC);
        match (&m.outcome, windows) {
            (Some(_), _) => Phase::Settled,
            (None, 0) => Phase::Open,
            (None, 1) => Phase::Revealing,
            (None, 2) => Phase::Judging,
            (None, 3) => Phase::Fallback,
            (None, _) => Phase::Expired,
        }
    }

    /// The id of the task that `target` names, for an operation that can act on the tasks for
    /// which `can_act` holds, given the phase they should be in.
    fn resolve(&self, target: Target, can_act: impl Fn(Phase, &TaskModel) -> bool) -> u64 {
        match target {
            Target::Id(id) => id,
            Target::Live(n) => {
                let live: Vec<u64> = (1u64..)
                    .zip(&self.tasks)
                    .filter(|(_, m)| can_act(self.phase(m), m))
                    .map(|(id, _)| id)
                    .collect();
                match live.len() {
                    // The newest task, or 0, which no task has, if there is none.
                    0 => self.tasks.len() as u64,
                    len => live[usize::from(n) % len],
                }
            }
        }
    }

    /// The model of task `id`, which a call that went through has just shown to exist.
    fn task_mut(&mut self, id: u64) -> Result<&mut TaskModel, TestCaseError> {
        let index = usize::try_from(id)
            .ok()
            .and_then(|id| id.checked_sub(1))
            .filter(|&index| index < self.tasks.len());
        match index {
            Some(index) => Ok(&mut self.tasks[index]),
            None => Err(TestCaseError::fail(format!(
                "a call on task {id} went through, but no post made it"
            ))),
        }
    }

    /// Adds `amount` to the balance `account` should hold.
    fn credit(&mut self, account: &AccountId, amount: u128) -> Result<(), TestCaseError> {
        let Some(balance) = self.balances.get_mut(account) else {
            return Err(TestCaseError::fail(format!(
                "{account}, an account the harness does not know, was paid {amount}"
            )));
        };
        *balance += amount;
        Ok(())
    }

    /// Takes `amount` from the balance `account` should hold.
    fn debit(&mut self, account: &AccountId, amount: u128) -> Result<(), TestCaseError> {
        match self.balances.get_mut(account) {
            Some(balance) if *balance >= amount => {
                *balance -= amount;
                Ok(())
            }
            _ => Err(TestCaseError::fail(format!(
                "{account} spent {amount}, more than it should hold"
            ))),
        }
    }

    /// Runs one operation, and brings the model up to date with what went through.
    fn apply(&mut self, op: &Op) -> Step {
        let pickable = |phase| matches!(phase, Phase::Judging | Phase::Fallback);
        match *op {
            Op::Deposit { who, amount } => self.deposit(who, amount),
            Op::Post { who, reward } => self.post(who, reward),
            Op::Commit { who, task } => {
                self.commit(who, self.resolve(task, |phase, _| phase == Phase::Open))
            }
            Op::Reveal { who, task } => {
                let task = self.resolve(task, |phase, m| {
                    phase == Phase::Revealing && m.works.len() > m.revealed.len()
                });
                self.reveal(who, task)
            }
            Op::Advance { secs } => {
                self.now += secs * SEC;
                Ok(Ok(()))
            }
            Op::Pick { task, ref split } => {
                let task = self.resolve(task, |phase, m| pickable(phase) && !m.revealed.is_empty());
                self.pick(task, split)
            }
            Op::EmptyPick { task } => {
                let task = self.resolve(task, |phase, _| pickable(phase));
                let poster = self.task(task).map_or(Who::P, |m| m.poster);
                self.settle(task, poster.id(), Settlement::Empty)
            }
            Op::Void { task } => {
                let task = self.resolve(task, |phase, m| {
                    phase == Phase::Expired || (pickable(phase) && m.revealed.is_empty())
                });
                self.settle(task, KEEPER, Settlement::Void)
            }
            Op::Withdraw { who, amount, ok } => self.withdraw(who, amount, ok),
            Op::Cleanup { task, limit } => {
                let task = self.resolve(task, |phase, m| {
                    phase == Phase::Settled && !m.works.is_empty()
                });
                Ok(self
                    .call(KEEPER, NO_DEPOSIT, Vec::new(), |t| {
                        t.cleanup(U64(task), limit)
                    })?
                    .map(|_| ()))
            }
            Op::Register { who } => self.register(who),
            Op::Unregister { who } => self.unregister(who),
            Op::Claim { who } => self.claim(who),
            Op::TopUp { who, task, amount } => {
                let task = self.resolve(task, |phase, _| phase == Phase::Open);
                self.top_up(who, task, amount)
            }
        }
    }

    /// `who` deposits `BOND`.
    fn deposit_bond(&mut self, who: Who) -> Step {
        self.deposit(who, BOND)
    }

    /// `who` registers, or updates its profile. The rules: an agent that is unregistering is
    /// refused; a new or retired one pays `BOND` and must hold it; an active one pays nothing.
    /// Storage never limits the four accounts. What the rules allow must go through, and nothing
    /// else.
    fn register(&mut self, who: Who) -> Step {
        let held = self.balances.get(&who.account()).copied().unwrap_or(0);
        let state = self.agents.get(&who).copied();
        let pays = matches!(state, None | Some(AgentModel::Retired));
        let allowed =
            !matches!(state, Some(AgentModel::Unregistering { .. })) && (!pays || held >= BOND);
        let result = self.call(who.id(), ONE_YOCTO, Vec::new(), |t| {
            t.register_agent(
                PROFILE_URI.to_string(),
                BRIEF_HASH.to_string(),
                vec!["coder".to_string()],
            )
        })?;
        prop_assert_eq!(
            result.is_ok(),
            allowed,
            "{:?} registering as {:?} with {} held came to {:?}",
            who,
            state,
            held,
            result
        );
        if result.is_ok() && pays {
            self.debit(&who.account(), BOND)?;
            self.agents.insert(who, AgentModel::Active { bond: BOND });
        }
        Ok(result)
    }

    /// `who` unregisters, which only an active agent may, and must be able to.
    fn unregister(&mut self, who: Who) -> Step {
        let state = self.agents.get(&who).copied();
        let result = self.call(who.id(), ONE_YOCTO, Vec::new(), Tender::unregister_agent)?;
        let Some(AgentModel::Active { bond }) = state else {
            prop_assert!(result.is_err(), "{:?}, as {:?}, unregistered", who, state);
            return Ok(result);
        };
        prop_assert!(
            result.is_ok(),
            "{:?}, active, could not unregister: {:?}",
            who,
            result
        );
        let lock = self.locked.get(&who).copied().unwrap_or(0);
        let claimable_at = (self.now + COOLDOWN_SECS * SEC).max(lock);
        self.agents
            .insert(who, AgentModel::Unregistering { bond, claimable_at });
        Ok(result)
    }

    /// `who` claims its bond, which an unregistering agent may from its `claimable_at` on, and
    /// must be able to. The bond comes back into its vault, and it retires.
    fn claim(&mut self, who: Who) -> Step {
        let state = self.agents.get(&who).copied();
        let result = self.call(who.id(), ONE_YOCTO, Vec::new(), Tender::claim_agent_bond)?;
        let due = match state {
            Some(AgentModel::Unregistering { bond, claimable_at }) if self.now >= claimable_at => {
                Some(bond)
            }
            _ => None,
        };
        let Some(bond) = due else {
            prop_assert!(result.is_err(), "{:?}, as {:?}, claimed", who, state);
            return Ok(result);
        };
        prop_assert!(
            result.is_ok(),
            "{:?} could not claim a bond that is due: {:?}",
            who,
            result
        );
        self.credit(&who.account(), bond)?;
        self.agents.insert(who, AgentModel::Retired);
        Ok(result)
    }

    /// `who` tops `task` up by `amount`. A top-up that the rules allow must go through: an open
    /// task, a positive amount that `who`'s balance covers and that keeps the reward within the
    /// token's limit, and, if `who` is not a funder yet, room for it among the funders and an
    /// amount of at least `MIN_REWARD`. Storage never limits the four accounts, and the pause is
    /// never on.
    fn top_up(&mut self, who: Who, task: u64, amount: u128) -> Step {
        let held = self.balances.get(&who.account()).copied().unwrap_or(0);
        let allowed = self.task(task).is_some_and(|m| {
            let known = m.funders.iter().any(|(w, _)| *w == who);
            self.phase(m) == Phase::Open
                && amount > 0
                && amount <= held
                && m.reward
                    .checked_add(amount)
                    .is_some_and(|reward| reward <= MAX_REWARD)
                && (known || (m.funders.len() < MAX_FUNDERS && amount >= MIN_REWARD))
        });
        let result = self.call(who.id(), ONE_YOCTO, Vec::new(), |t| {
            t.top_up_task(U64(task), U128(amount))
        })?;
        if let Err(message) = &result {
            prop_assert!(
                !allowed,
                "{:?} topping task {} up by {} was rejected: {:?}",
                who,
                task,
                amount,
                message
            );
            return Ok(result);
        }
        prop_assert!(
            allowed,
            "{:?} topped task {} up by {}, which the rules forbid",
            who,
            task,
            amount
        );
        self.debit(&who.account(), amount)?;
        let m = self.task_mut(task)?;
        m.reward += amount;
        match m.funders.iter_mut().find(|(w, _)| *w == who) {
            Some((_, paid)) => *paid += amount,
            None => m.funders.push((who, amount)),
        }
        Ok(Ok(()))
    }

    /// The token reports a deposit. `ft_on_transfer` must answer and never panic (I8), and what
    /// it does not hand back is in the vault.
    fn deposit(&mut self, who: Who, amount: u128) -> Step {
        let result = self.call(TOKEN, NO_DEPOSIT, Vec::new(), |t| {
            match t.ft_on_transfer(who.account(), U128(amount), String::new()) {
                PromiseOrValue::Value(unused) => Some(unused.0),
                PromiseOrValue::Promise(_) => None,
            }
        })?;
        let unused = match result {
            Ok(Some(unused)) if unused <= amount => unused,
            other => {
                return Err(TestCaseError::fail(format!(
                    "I8: ft_on_transfer of {amount} must answer with at most that, and never \
                     panic; it came to {other:?}"
                )))
            }
        };
        let kept = amount - unused;
        self.deposited += kept;
        self.credit(&who.account(), kept)?;
        Ok(Ok(()))
    }

    /// `who` posts a task, whose reward then leaves its vault for the escrow.
    fn post(&mut self, who: Option<Who>, reward: u128) -> Step {
        let who = who.unwrap_or_else(|| {
            let held = |w: &Who| self.balances.get(&w.account()).copied().unwrap_or(0);
            // `max_by_key` keeps the last of equal keys, so go through the accounts backwards.
            Who::ALL
                .into_iter()
                .rev()
                .max_by_key(held)
                .unwrap_or(Who::P)
        });
        let task = task_args(reward);
        let id = match self.call(who.id(), ONE_YOCTO, Vec::new(), |t| t.post_task(task).0)? {
            Ok(id) => id,
            Err(message) => return Ok(Err(message)),
        };
        prop_assert_eq!(
            id,
            self.tasks.len() as u64 + 1,
            "task ids run from 1 with no gaps"
        );
        self.debit(&who.account(), reward)?;
        self.tasks.push(TaskModel {
            poster: who,
            reward,
            funders: vec![(who, reward)],
            posted_at: self.now,
            works: BTreeMap::new(),
            revealed: BTreeSet::new(),
            outcome: None,
        });
        Ok(Ok(()))
    }

    /// `who` commits new work to `task`. The model counts the distinct committers (I10).
    fn commit(&mut self, who: Option<Who>, task: u64) -> Step {
        let who = who.unwrap_or_else(|| {
            self.task(task)
                .and_then(|m| {
                    Who::ALL
                        .into_iter()
                        .find(|w| *w != m.poster && !m.works.contains_key(w))
                })
                .unwrap_or(Who::A)
        });
        let seed = self.next_seed;
        self.next_seed += 1;
        let (content_hash, salt) = work(seed);
        let commitment = hex32(&commitment_of(task, &who.account(), &content_hash, &salt));
        // Every task here is open to anyone, so it takes an active agent that is not its poster
        // (who verifies it), in its commit window.
        let active = matches!(self.agents.get(&who), Some(AgentModel::Active { .. }));
        let allowed = self
            .task(task)
            .is_some_and(|m| self.phase(m) == Phase::Open && m.poster != who && active);
        let result = self.call(who.id(), NO_DEPOSIT, Vec::new(), |t| {
            t.commit(U64(task), commitment)
        })?;
        prop_assert_eq!(
            result.is_ok(),
            allowed,
            "{:?} committing to task {} (active: {}) came to {:?}",
            who,
            task,
            active,
            result
        );
        if result.is_ok() {
            let m = self.task_mut(task)?;
            let new_entry = m.works.insert(who, seed).is_none();
            let deadline = m.posted_at + u64::from(WINDOW_SECS) * SEC;
            if new_entry {
                let lock = self.locked.entry(who).or_insert(0);
                *lock = (*lock).max(deadline);
            }
        }
        Ok(result)
    }

    /// `who` reveals in `task` the work it committed last.
    fn reveal(&mut self, who: Option<Who>, task: u64) -> Step {
        let model = self.task(task);
        let who = who.unwrap_or_else(|| {
            model
                .and_then(|m| m.works.keys().find(|w| !m.revealed.contains(w)).copied())
                .unwrap_or(Who::A)
        });
        // The work `who` committed last, or work nobody committed if it has no entry.
        let seed = model
            .and_then(|m| m.works.get(&who).copied())
            .unwrap_or(u32::MAX);
        let (content_hash, salt) = work(seed);
        let result = self.call(who.id(), NO_DEPOSIT, Vec::new(), |t| {
            t.reveal(
                U64(task),
                hex32(&content_hash),
                hex32(&salt),
                ENTRY_URI.to_string(),
            )
        })?;
        if result.is_ok() {
            let first = self.task_mut(task)?.revealed.insert(who);
            prop_assert!(first, "{:?} revealed twice in task {}", who, task);
        }
        Ok(result)
    }

    /// The poster of `task` picks winners in the proportions of `split` (see `Op::Pick`).
    fn pick(&mut self, task: u64, split: &[u16]) -> Step {
        let (poster, candidates): (Who, Vec<Who>) = match self.task(task) {
            Some(m) if !m.revealed.is_empty() => (m.poster, m.revealed.iter().copied().collect()),
            Some(m) => (
                m.poster,
                Who::ALL.into_iter().filter(|&w| w != m.poster).collect(),
            ),
            None => (Who::P, Who::ALL[1..].to_vec()),
        };
        let winners = shares(&candidates, split);
        self.settle(task, poster.id(), Settlement::Pick(winners))
    }

    /// `caller` settles task `task`, and the model follows: a pick pays the winners and the fee,
    /// and an empty pick or a void refunds each funder what it paid in.
    fn settle(&mut self, task: u64, caller: &str, how: Settlement) -> Step {
        let model = self.task(task);
        let settled = model.map(|m| m.outcome.is_some());
        let phase = model.map(|m| self.phase(m));
        // Whether the rules let the call through, so that a rejection is a bug: a pick of
        // revealed entrants, or an empty pick, by the poster (who verifies) in a pick window; a
        // void from the fallback deadline on (I4), or past the reveal deadline with nothing
        // revealed. The caller is the poster for a pick, as `apply` sees to.
        let allowed = model.zip(phase).is_some_and(|(m, phase)| {
            let pickable = matches!(phase, Phase::Judging | Phase::Fallback);
            match &how {
                Settlement::Pick(winners) => {
                    pickable
                        && winners
                            .iter()
                            .all(|w| m.revealed.iter().any(|r| r.account() == w.account))
                }
                Settlement::Empty => pickable,
                Settlement::Void => phase == Phase::Expired || (pickable && m.revealed.is_empty()),
            }
        });
        let requested: Option<Vec<(AccountId, u16)>> = match &how {
            Settlement::Pick(winners) => {
                Some(winners.iter().map(|w| (w.account.clone(), w.bps)).collect())
            }
            Settlement::Empty | Settlement::Void => None,
        };
        let voiding = matches!(how, Settlement::Void);
        let result = self.call(caller, NO_DEPOSIT, Vec::new(), |t| match how {
            Settlement::Pick(winners) => t.pick(
                U64(task),
                winners,
                SCORECARD_HASH.to_string(),
                SCORECARD_URI.to_string(),
            ),
            Settlement::Empty => t.pick(
                U64(task),
                Vec::new(),
                SCORECARD_HASH.to_string(),
                SCORECARD_URI.to_string(),
            ),
            Settlement::Void => t.void_task(U64(task)),
        })?;
        if let Err(message) = &result {
            if settled == Some(true) {
                prop_assert!(
                    message.starts_with("E_SETTLED: "),
                    "I2: settling task {} again must be rejected E_SETTLED, not {:?}",
                    task,
                    message
                );
            }
            prop_assert!(
                !(allowed && voiding && phase == Some(Phase::Expired)),
                "I4: voiding task {} after its fallback deadline was rejected: {:?}",
                task,
                message
            );
            prop_assert!(
                !allowed,
                "the rules let task {} ({:?}) be settled so, but the call was rejected: {:?}",
                task,
                phase,
                message
            );
            return Ok(result);
        }
        prop_assert_eq!(settled, Some(false), "I2: task {} was settled again", task);
        // Both ways: what went through is what the rules allow (I3, I6 and the windows).
        prop_assert!(
            allowed,
            "task {} ({:?}) was settled by {}, which the rules forbid",
            task,
            phase,
            caller
        );
        let Some(outcome) = self.view(|t| t.get_task(U64(task)).and_then(|v| v.outcome)) else {
            return Err(TestCaseError::fail(format!(
                "task {task} was settled but has no outcome"
            )));
        };
        match (&outcome, requested) {
            (OutcomeView::Picked { winners, fee, .. }, Some(requested)) => {
                let paid: Vec<(AccountId, u16)> =
                    winners.iter().map(|w| (w.account.clone(), w.bps)).collect();
                prop_assert_eq!(paid, requested, "task {} paid other winners", task);
                for w in winners {
                    self.credit(&w.account, w.amount.0)?;
                }
                self.credit(&acct(TREASURY), fee.0)?;
            }
            (OutcomeView::Voided { reason, .. }, None) => {
                let expected = if voiding {
                    matches!(reason, VoidReason::NoReveals | VoidReason::Expired)
                } else {
                    *reason == VoidReason::NoAward
                };
                prop_assert!(expected, "task {} was voided as {:?}", task, reason);
                let funders = self.task_mut(task)?.funders.clone();
                for (who, paid) in funders {
                    self.credit(&who.account(), paid)?;
                }
            }
            (outcome, _) => {
                return Err(TestCaseError::fail(format!(
                    "task {task} settled as {outcome:?}, which is not what the call asked for"
                )))
            }
        }
        self.task_mut(task)?.outcome = Some(outcome);
        Ok(Ok(()))
    }

    /// `who` withdraws, which debits it and schedules the transfer, and then the callback runs
    /// with the token's answer. A failed transfer must leave the balance exactly where it was
    /// (I5), and a withdrawal that the balance covers must go through.
    fn withdraw(&mut self, who: Who, amount: Option<u128>, ok: bool) -> Step {
        let account = who.account();
        let before = self.balance(&account);
        let amount = amount.unwrap_or(before);
        let result = self.call(who.id(), ONE_YOCTO, Vec::new(), |t| {
            // Dropping the promise is what schedules the transfer and the callback.
            let _ = t.withdraw(acct(TOKEN), U128(amount), None);
        })?;
        if let Err(message) = result {
            prop_assert!(
                amount == 0 || amount > before,
                "withdrawing {} of a balance of {} was rejected: {:?}",
                amount,
                before,
                message
            );
            return Ok(Err(message));
        }
        prop_assert_eq!(
            Some(self.balance(&account)),
            before.checked_sub(amount),
            "withdraw must debit {} from {}",
            amount,
            before
        );
        // The token answers, and the callback runs once, as the contract itself.
        let (promise, transfer) = if ok {
            (PromiseResult::Successful(Vec::new()), Ok(()))
        } else {
            (PromiseResult::Failed, Err(PromiseError::Failed))
        };
        let callback = self.call(CONTRACT, NO_DEPOSIT, vec![promise], |t| {
            t.on_withdraw(
                account.clone(),
                acct(TOKEN),
                U128(amount),
                account.clone(),
                transfer,
            )
        })?;
        let paid = callback
            .map_err(|message| TestCaseError::fail(format!("on_withdraw panicked: {message}")))?;
        prop_assert_eq!(paid, ok, "on_withdraw must say whether the token paid");
        let failures = get_logs()
            .iter()
            .filter(|log| log.contains(r#""event":"withdraw_failed""#))
            .count();
        prop_assert_eq!(failures, usize::from(!ok), "withdraw_failed events");
        let after = self.balance(&account);
        if ok {
            prop_assert_eq!(after, before - amount, "a paid withdrawal stays debited");
            self.withdrawn += amount;
            self.debit(&account, amount)?;
        } else {
            prop_assert_eq!(
                after,
                before,
                "I5: a failed withdrawal of {} must restore the balance once",
                amount
            );
        }
        Ok(Ok(()))
    }

    /// Checks the invariants against the state in the trie.
    fn check(&self) -> Result<(), TestCaseError> {
        let trie = take_trie();
        let vault = vault_balances(&trie);
        let bonds = bonds_held(&trie);
        install(self.context(KEEPER, NO_DEPOSIT), Vec::new(), trie);
        let t: Tender = env::state_read().expect("the contract state");
        prop_assert_eq!(t.task_count().0, self.tasks.len() as u64, "the task count");
        let mut escrowed = 0u128;
        for (id, model) in (1u64..).zip(&self.tasks) {
            let task = t.get_task(U64(id)).expect("every counted task exists");
            prop_assert_eq!(
                &task.outcome,
                &model.outcome,
                "I2: the outcome of task {} changed after it was settled",
                id
            );
            match &task.outcome {
                None => escrowed += task.reward.0,
                Some(OutcomeView::Picked { winners, fee, .. }) => {
                    let paid = winners.iter().map(|w| w.amount.0).sum::<u128>() + fee.0;
                    prop_assert_eq!(
                        paid,
                        task.reward.0,
                        "I7: task {} paid out {} of its reward {}",
                        id,
                        paid,
                        task.reward.0
                    );
                }
                Some(OutcomeView::Voided { .. }) => {}
            }
            prop_assert_eq!(
                task.commit_count as usize,
                model.works.len(),
                "I10: the commit_count of task {} is not its number of committers",
                id
            );
            prop_assert_eq!(
                task.reveal_count as usize,
                model.revealed.len(),
                "the reveal_count of task {} is not its number of reveals",
                id
            );
            prop_assert_eq!(task.reward.0, model.reward, "the reward of task {}", id);
            let funders: Vec<(AccountId, u128)> = task
                .funders
                .iter()
                .map(|f| (f.account.clone(), f.amount.0))
                .collect();
            let expected: Vec<(AccountId, u128)> = model
                .funders
                .iter()
                .map(|(who, paid)| (who.account(), *paid))
                .collect();
            prop_assert_eq!(funders, expected, "the funders of task {}", id);
            prop_assert_eq!(
                task.funders.iter().map(|f| f.amount.0).sum::<u128>(),
                task.reward.0,
                "the funders of task {} do not add up to its reward",
                id
            );
        }
        let bonded: u128 = bonds.values().sum();
        for who in Who::ALL {
            let model = self.agents.get(&who).copied();
            let view = t.get_agent(who.account());
            let shown = view.as_ref().map(|v| {
                (
                    v.status,
                    v.bond_amount.map(|a| a.0),
                    v.claimable_at.map(|c| c.0),
                    v.locked_until.map(|l| l.0),
                )
            });
            let lock = self.locked.get(&who).copied().filter(|&l| l > 0);
            let expected = model.map(|m| match m {
                AgentModel::Active { bond } => (AgentStatus::Active, Some(bond), None, lock),
                AgentModel::Unregistering { bond, claimable_at } => (
                    AgentStatus::Unregistering,
                    Some(bond),
                    Some(claimable_at),
                    lock,
                ),
                AgentModel::Retired => (AgentStatus::Retired, None, None, lock),
            });
            prop_assert_eq!(shown, expected, "the agent record of {:?}", who);
            prop_assert_eq!(
                bonds.get(&who.account()).copied().unwrap_or(0),
                model.map_or(0, AgentModel::bond),
                "the bond stored for {:?}",
                who
            );
        }
        let held: u128 = vault.values().sum();
        prop_assert!(
            self.withdrawn <= self.deposited,
            "I1: withdrawals of {} paid out more than the deposits of {}",
            self.withdrawn,
            self.deposited
        );
        prop_assert_eq!(
            held + escrowed + bonded,
            self.deposited - self.withdrawn,
            "I1: the vaults ({}), the escrow of the unsettled tasks ({}) and the bonds ({}) do not \
             add up to the deposits ({}) less the withdrawals ({})",
            held,
            escrowed,
            bonded,
            self.deposited,
            self.withdrawn
        );
        for (account, &expected) in &self.balances {
            let shown = t.balance_of(account.clone(), acct(TOKEN)).0;
            let stored = vault.get(account).copied().unwrap_or(0);
            prop_assert!(
                shown == expected && stored == expected,
                "{} should hold {}; balance_of shows {} and the vault stores {}",
                account,
                expected,
                shown,
                stored
            );
        }
        prop_assert_eq!(
            held,
            self.balances.values().sum::<u128>(),
            "an account the harness does not know holds money: {:?}",
            vault
        );
        Ok(())
    }
}

/// What each operation of a run came to: `Ok` if it went through, or the message the contract
/// rejected it with.
type Results = Vec<Result<(), String>>;

/// Runs `ops` on a new world, checking the invariants after the setup and after every
/// operation. Returns the world as the run left it, and what each operation came to.
fn run(ops: &[Op]) -> Result<(World, Results), TestCaseError> {
    let mut world = World::new();
    world.check()?;
    let results = ops
        .iter()
        .enumerate()
        .map(|(i, op)| {
            world
                .apply(op)
                .and_then(|result| world.check().map(|()| result))
                .map_err(|e| TestCaseError::fail(format!("operation {i}, {op:?}: {e}")))
        })
        .collect::<Result<_, _>>()?;
    Ok((world, results))
}

fn acct(id: &str) -> AccountId {
    id.parse().unwrap()
}

/// Takes the trie out of the mocked blockchain, which is left with an empty one.
fn take_trie() -> Trie {
    with_mocked_blockchain(|b| b.take_storage())
}

/// Replaces the mocked blockchain with one that runs `context` over `trie`, as a new receipt
/// does: its logs, receipts and storage usage start afresh.
fn install(context: VMContext, results: Vec<PromiseResult>, trie: Trie) {
    env::set_blockchain_interface(MockedBlockchain::new(
        context,
        cached(test_vm_config),
        RuntimeFeesConfig::test(),
        results,
        trie,
        Default::default(),
        None,
    ));
}

/// What `make` returns, made once per thread and cloned after that. `test_vm_config` builds a
/// whole runtime configuration store, about 12 ms of work, and the harness installs a blockchain
/// several times per operation. Its type comes from a crate this one does not depend on, hence
/// the `Any`.
fn cached<T: Clone + 'static>(make: fn() -> T) -> T {
    thread_local! {
        static CACHE: RefCell<Option<Box<dyn Any>>> = const { RefCell::new(None) };
    }
    CACHE.with(|cache| {
        cache
            .borrow_mut()
            .get_or_insert_with(|| Box::new(make()))
            .downcast_ref::<T>()
            .expect("one type is cached")
            .clone()
    })
}

/// Writes `contract` to the trie as the generated wrapper of a method does when the method
/// returns: every cached change, then the state.
fn persist(mut contract: Tender) {
    contract.flush_all();
    env::state_write(&contract);
}

/// The keys that `a` and `b` hold different values for (or only one of them holds), for a
/// failure message.
fn changed_keys(a: &Trie, b: &Trie) -> Vec<String> {
    let mut keys: Vec<String> = a
        .keys()
        .chain(b.keys())
        .filter(|key| a.get(*key) != b.get(*key))
        .map(|key| format!("{:?}", String::from_utf8_lossy(key)))
        .collect();
    keys.sort();
    keys.dedup();
    keys
}

/// Every balance of `TOKEN` in the vault, by account, read straight from the storage keys of the
/// `vault` map: its prefix, then the Borsh encoding of `(account, token)`. Unlike `balance_of`,
/// this needs no list of accounts, so it also sees money in an account the harness does not know.
fn vault_balances(trie: &Trie) -> BTreeMap<AccountId, u128> {
    let prefix = StorageKey::Vault.into_storage_key();
    let token = acct(TOKEN);
    trie.iter()
        .filter_map(|(key, value)| {
            let slot = key.strip_prefix(prefix.as_slice())?;
            let (account, slot_token): (AccountId, AccountId) =
                borsh::from_slice(slot).expect("a vault key");
            let balance: u128 = borsh::from_slice(value).expect("a vault balance");
            (slot_token == token).then_some((account, balance))
        })
        .collect()
}

/// The bond the contract holds for each agent, read straight from the storage keys of the `agents`
/// map: its prefix, then the Borsh encoding of the account, with the agent's record as the value.
/// Like `vault_balances`, it needs no list of accounts. Every bond is in `TOKEN`, the only token the
/// owner sets one in.
fn bonds_held(trie: &Trie) -> BTreeMap<AccountId, u128> {
    let prefix = StorageKey::Agents.into_storage_key();
    trie.iter()
        .filter_map(|(key, value)| {
            let account = key.strip_prefix(prefix.as_slice())?;
            let account: AccountId = borsh::from_slice(account).expect("an agent key");
            let profile: AgentProfile = borsh::from_slice(value).expect("an agent record");
            let bond = profile.bond?;
            assert_eq!(bond.token, acct(TOKEN), "a bond in another token");
            Some((account, bond.amount))
        })
        .collect()
}

/// The work that `seed` stands for: its content hash and its salt. Each commit gets a new seed, so
/// a commit that replaces another commits other work.
fn work(seed: u32) -> ([u8; 32], [u8; 32]) {
    let mut content_hash = [0u8; 32];
    content_hash[..4].copy_from_slice(&seed.to_le_bytes());
    let mut salt = content_hash;
    salt[31] = 0x5a;
    (content_hash, salt)
}

/// A task with `reward` in `TOKEN` that meets every other rule: all four windows 60 s, open to
/// anyone, up to five winners, and the poster as the verifier.
fn task_args(reward: u128) -> PostTaskArgs {
    PostTaskArgs {
        token: acct(TOKEN),
        reward: U128(reward),
        brief_uri: BRIEF_URI.to_string(),
        brief_hash: BRIEF_HASH.to_string(),
        criteria_hash: CRITERIA_HASH.to_string(),
        heldout_commitment: None,
        verifier: None,
        commit_secs: WINDOW_SECS,
        reveal_secs: WINDOW_SECS,
        pick_secs: WINDOW_SECS,
        fallback_secs: WINDOW_SECS,
        max_entries: 0,
        max_winners: MAX_WINNERS,
        invited: vec![],
        parent: None,
    }
}

/// One winner per weight of `split`, from the first of `candidates` on while they last, with
/// shares of the 10_000 bps in the proportions of the weights. Every weight is 1 to 100 and there
/// are at most 5, so each share is at least 20 bps; the first winner takes what the rounding
/// leaves.
fn shares(candidates: &[Who], split: &[u16]) -> Vec<WinnerArg> {
    let weights = &split[..candidates.len().min(split.len())];
    let total: u32 = weights.iter().map(|&w| u32::from(w)).sum();
    let mut bps: Vec<u16> = weights
        .iter()
        .map(|&w| u16::try_from(u32::from(w) * 10_000 / total).expect("at most 10_000"))
        .collect();
    if let Some((first, rest)) = bps.split_first_mut() {
        *first = 10_000 - rest.iter().sum::<u16>();
    }
    candidates
        .iter()
        .zip(bps)
        .map(|(who, bps)| WinnerArg {
            account: who.account(),
            bps,
        })
        .collect()
}

fn who() -> impl Strategy<Value = Who> {
    prop::sample::select(Who::ALL.to_vec())
}

/// Mostly a task the operation can act on, and now and then one of the first six ids, which may
/// be in any phase or not exist at all.
fn target() -> impl Strategy<Value = Target> {
    prop_oneof![
        7 => any::<u8>().prop_map(Target::Live),
        1 => (1..=6u64).prop_map(Target::Id),
    ]
}

/// A run: a post, so that the operations after it have a task to act on from the first one on,
/// then 29 to 59 random operations. A task needs about four windows' worth of operations to go
/// through its whole life, and a shorter run would only test what a prefix of a longer one does,
/// since the invariants are checked after every operation. The price is that proptest shrinks a
/// failing run to no fewer than 30 operations.
fn ops() -> impl Strategy<Value = Vec<Op>> {
    (post(), prop::collection::vec(op(), 29..=59))
        .prop_map(|(first, rest)| std::iter::once(first).chain(rest).collect())
}

/// A post, mostly by the account that holds the most and mostly of a small reward, which most
/// balances cover and which puts the rounding to the test. 0 is among the rewards, and is
/// rejected `E_REWARD`.
fn post() -> impl Strategy<Value = Op> {
    (
        prop::option::weighted(0.4, who()),
        prop_oneof![3 => 0..=1_000u128, 1 => 1..=MAX_AMOUNT],
    )
        .prop_map(|(who, reward)| Op::Post { who, reward })
}

fn op() -> impl Strategy<Value = Op> {
    prop_oneof![
        2 => (who(), 1..=MAX_AMOUNT).prop_map(|(who, amount)| Op::Deposit { who, amount }),
        3 => post(),
        10 => (prop::option::weighted(0.3, who()), target())
            .prop_map(|(who, task)| Op::Commit { who, task }),
        10 => (prop::option::weighted(0.25, who()), target())
            .prop_map(|(who, task)| Op::Reveal { who, task }),
        // A step of exactly one window moves every task on by exactly one phase, and no step of
        // up to one window skips a phase of any task. A longer step can.
        4 => prop_oneof![6 => Just(60u64), 2 => 1..=60u64, 1 => 1..=200u64]
            .prop_map(|secs| Op::Advance { secs }),
        6 => (target(), prop::collection::vec(1..=100u16, 1..=5))
            .prop_map(|(task, split)| Op::Pick { task, split }),
        1 => target().prop_map(|task| Op::EmptyPick { task }),
        2 => target().prop_map(|task| Op::Void { task }),
        3 => (who(), prop::option::weighted(0.8, 1..=MAX_AMOUNT), any::<bool>())
            .prop_map(|(who, amount, ok)| Op::Withdraw { who, amount, ok }),
        // A limit of 0 is rejected `E_LIMIT`.
        1 => (target(), 0..=3u32).prop_map(|(task, limit)| Op::Cleanup { task, limit }),
        2 => who().prop_map(|who| Op::Register { who }),
        1 => who().prop_map(|who| Op::Unregister { who }),
        1 => who().prop_map(|who| Op::Claim { who }),
        // 0 is among the amounts, and is rejected `E_REWARD`.
        3 => (who(), target(), prop_oneof![3 => 0..=1_000u128, 1 => 1..=MAX_AMOUNT])
            .prop_map(|(who, task, amount)| Op::TopUp { who, task, amount }),
    ]
}

/// 64 cases, or as many as `PROPTEST_CASES` asks for. `ProptestConfig::default()` reads that
/// variable too, but a `cases` set here would override it.
fn config() -> ProptestConfig {
    let cases = std::env::var("PROPTEST_CASES")
        .ok()
        .and_then(|cases| cases.parse().ok())
        .unwrap_or(64);
    ProptestConfig {
        cases,
        ..ProptestConfig::default()
    }
}

proptest! {
    #![proptest_config(config())]

    #[test]
    fn invariants_hold_after_every_call(ops in ops()) {
        run(&ops)?;
    }

    #[test]
    fn payout_math_conserves(
        reward in prop_oneof![0..=1_000u128, 0..=MAX_REWARD],
        fee_bps in 0..=MAX_FEE_BPS,
        cuts in prop::collection::btree_set(1..10_000u16, 0..usize::from(MAX_WINNERS)),
    ) {
        // The cuts split 10_000 bps into 1 to 5 positive shares.
        let mut bps = Vec::new();
        let mut last = 0;
        for &cut in cuts.iter().chain([10_000].iter()) {
            bps.push(cut - last);
            last = cut;
        }
        let (fee, amounts) = split_reward(reward, fee_bps, &bps);
        prop_assert_eq!(fee, reward * u128::from(fee_bps) / 10_000);
        prop_assert_eq!(amounts.iter().sum::<u128>() + fee, reward);
        let net = reward - fee;
        for (i, (&share, &amount)) in bps.iter().zip(&amounts).enumerate().skip(1) {
            // `exact` is the exact share times 10_000, so the amount is the exact share rounded
            // down: within 1 of it.
            let exact = net * u128::from(share);
            prop_assert!(
                amount * 10_000 <= exact && exact < (amount + 1) * 10_000,
                "winner {} got {} for {} bps of {}", i, amount, share, net
            );
        }
        // The first winner's amount is its own share, rounded down, plus the dust: less than one
        // unit per winner.
        let floor = net * u128::from(bps[0]) / 10_000;
        prop_assert!(
            amounts[0] >= floor && amounts[0] - floor < bps.len() as u128,
            "the first winner got {} for {} bps of {}", amounts[0], bps[0], net
        );
    }
}

/// The harness itself, on a run written out by hand: every operation goes through where it
/// should, every rejection is the one it should be, and the invariants hold after each. This is
/// what keeps the random runs from passing for want of reaching anything, should the harness or
/// the contract change under them.
#[test]
fn scripted_run_reaches_every_outcome() {
    use Who::{A, B, C, P};
    // One line per operation, with every task named by its id.
    let deposit = |who, amount| Op::Deposit { who, amount };
    let post = |who: Option<Who>, reward| Op::Post { who, reward };
    let commit = |who: Option<Who>, task| Op::Commit {
        who,
        task: Target::Id(task),
    };
    let reveal = |who: Option<Who>, task| Op::Reveal {
        who,
        task: Target::Id(task),
    };
    let advance = |secs| Op::Advance { secs };
    let pick = |task, split: &[u16]| Op::Pick {
        task: Target::Id(task),
        split: split.to_vec(),
    };
    let empty_pick = |task| Op::EmptyPick {
        task: Target::Id(task),
    };
    let void = |task| Op::Void {
        task: Target::Id(task),
    };
    let withdraw = |who, amount, ok| Op::Withdraw { who, amount, ok };
    let cleanup = |task, limit| Op::Cleanup {
        task: Target::Id(task),
        limit,
    };
    let register = |who| Op::Register { who };
    let unregister = |who| Op::Unregister { who };
    let claim = |who| Op::Claim { who };
    let top_up = |who, task, amount| Op::TopUp {
        who,
        task: Target::Id(task),
        amount,
    };
    // Each operation, and what it should come to: "ok", or the code it is rejected with.
    let script = [
        // Task 1, 1_000 from p.test, which the setup funded. Three entrants, one of them twice.
        (post(Some(P), 1_000), "ok"),
        (commit(Some(A), 1), "ok"),
        (commit(Some(B), 1), "ok"),
        (commit(Some(A), 1), "ok"),
        (commit(Some(P), 1), "E_AUTH"),
        // c.test has not registered, so it cannot enter an open task, and it has no bond to
        // register with until it deposits one.
        (commit(Some(C), 1), "E_NOT_REGISTERED"),
        (register(C), "E_FUNDS"),
        (deposit(C, BOND), "ok"),
        (register(C), "ok"),
        (register(C), "ok"),
        (commit(Some(C), 1), "ok"),
        // a.test's vault slot is the one its bond came out of, and nothing is in it.
        (post(Some(A), 15), "E_FUNDS"),
        (post(Some(A), 9), "E_REWARD"),
        (deposit(A, 500), "ok"),
        // Task 2, which nobody enters. Its poster puts in 3 more, which a funder may; p.test,
        // not a funder yet, cannot join with 4, under the minimum of 10, and joins with 10.
        // b.test's vault holds nothing: its bond took what it deposited.
        (post(Some(A), 17), "ok"),
        (top_up(A, 2, 3), "ok"),
        (top_up(P, 2, 4), "E_REWARD"),
        (top_up(P, 2, 10), "ok"),
        (top_up(P, 2, 4), "ok"),
        (top_up(A, 2, 0), "E_REWARD"),
        (top_up(B, 2, 15), "E_FUNDS"),
        (advance(60), "ok"),
        (top_up(P, 2, 1), "E_PHASE"),
        (reveal(Some(A), 1), "ok"),
        (reveal(Some(B), 1), "ok"),
        (reveal(Some(C), 1), "ok"),
        (reveal(Some(A), 1), "E_REVEALED"),
        (advance(60), "ok"),
        (void(2), "ok"),
        // A fee of 50, then 475, 285 and 190 of the 950 left.
        (pick(1, &[50, 30, 20]), "ok"),
        (pick(1, &[1]), "E_SETTLED"),
        (empty_pick(1), "E_SETTLED"),
        (void(1), "E_SETTLED"),
        (cleanup(1, 2), "ok"),
        (cleanup(1, 2), "ok"),
        (cleanup(1, 0), "E_LIMIT"),
        (withdraw(A, None, true), "ok"),
        (withdraw(B, Some(100), false), "ok"),
        (withdraw(B, Some(1_000), true), "E_FUNDS"),
        // Task 3, posted by the account that holds the most, p.test, topped up by c.test out of
        // its winnings, and picked empty, which refunds them both.
        (post(None, 13), "ok"),
        (top_up(C, 3, 10), "ok"),
        (commit(None, 3), "ok"),
        (advance(60), "ok"),
        (reveal(None, 3), "ok"),
        (advance(60), "ok"),
        (empty_pick(3), "ok"),
        // Task 4, revealed in and then left until it expires. b.test unregisters after it enters:
        // it may no longer replace its entry, nor claim before the cooldown, nor register, but it
        // reveals, claims once the cooldown is over, which retires it, and comes back.
        (post(Some(P), 19), "ok"),
        (commit(Some(B), 4), "ok"),
        (claim(B), "E_PHASE"),
        (unregister(B), "ok"),
        (unregister(B), "E_PHASE"),
        (commit(Some(B), 4), "E_NOT_REGISTERED"),
        (claim(B), "E_PHASE"),
        (register(B), "E_PHASE"),
        (advance(60), "ok"),
        (reveal(Some(B), 4), "ok"),
        (claim(B), "ok"),
        (claim(B), "E_NOT_REGISTERED"),
        (unregister(B), "E_NOT_REGISTERED"),
        (register(B), "ok"),
        (unregister(P), "E_NOT_REGISTERED"),
        (advance(200), "ok"),
        (pick(4, &[1]), "E_PHASE"),
        (void(4), "ok"),
        (withdraw(C, None, true), "ok"),
    ];
    let (ops, expected): (Vec<Op>, Vec<&str>) = script.into_iter().unzip();
    let (world, results) = run(&ops).unwrap_or_else(|e| panic!("{e}"));
    let codes: Vec<&str> = results
        .iter()
        .map(|r| match r {
            Ok(()) => "ok",
            Err(message) => message.split(':').next().unwrap_or(message),
        })
        .collect();
    assert_eq!(codes, expected);
    let outcomes: Vec<String> = (1..=4)
        .map(
            |id| match world.view(|t| t.get_task(U64(id)).and_then(|v| v.outcome)) {
                Some(OutcomeView::Picked { winners, fee, .. }) => {
                    let amounts: Vec<u128> = winners.iter().map(|w| w.amount.0).collect();
                    format!("picked {amounts:?} fee {}", fee.0)
                }
                Some(OutcomeView::Voided { reason, .. }) => format!("voided {reason:?}"),
                None => "unsettled".to_string(),
            },
        )
        .collect();
    assert_eq!(
        outcomes,
        [
            "picked [475, 285, 190] fee 50",
            "voided NoReveals",
            "voided NoAward",
            "voided Expired",
        ]
    );
    // The voids and the empty pick refunded every funder what it paid in, so the top-ups cancel
    // out. Withdrawn: 975 by a.test and 190 by c.test. b.test's failed withdrawal came back, and
    // so did its bond, which it paid again. Each of the three holds a bond of `BOND`.
    let held: Vec<u128> = [P, A, B, C]
        .into_iter()
        .map(|w| world.balance(&w.account()))
        .chain([world.balance(&acct(TREASURY))])
        .collect();
    assert_eq!(held, [MAX_AMOUNT - 1_000, 0, 285, 0, 50]);
    assert_eq!(
        (world.deposited, world.withdrawn),
        (MAX_AMOUNT + 3 * BOND + 500, 1_165)
    );
    let bonds = world.view(|t| {
        Who::ALL.map(|w| {
            t.get_agent(w.account())
                .and_then(|a| a.bond_amount)
                .map(|b| b.0)
        })
    });
    assert_eq!(bonds, [None, Some(BOND), Some(BOND), Some(BOND)]);
}
