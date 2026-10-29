//! Shared setup and helpers for the sandbox suites.
//!
//! Every test boots its own nearcore node and deploys the wasm in `res/`, so it runs the bytes that
//! ship. Build `res/` first with `contract/build.sh`.
//!
//! Chain time moves in two ways. Transactions take a few blocks each, about a second of chain time
//! in all. `advance_to` jumps ahead in steps of 200 blocks, and one step is about 60 s. The task
//! windows are `WINDOW_SECS` long, twice a step, so a jump to the end of one window lands inside
//! the next and never skips it.
//!
//! Transactions from one key go one after another. near-workspaces numbers a key's transactions when
//! it sends them, and the node applies them in the order they reach it, so several at once from the
//! same key now and then collide (`InvalidNonce`). Different accounts can send in parallel; see `all`.

// Each test binary uses a different part of this module.
#![allow(dead_code)]

use std::collections::HashMap;
use std::future::Future;

use anyhow::{bail, ensure, Context};
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{AccessKey, Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const TENDER_WASM: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../res/tender.wasm");
pub const TOKEN_WASM: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../res/test_token.wasm");

/// The deposit that `assert_one_yocto` and `authorize_spend` ask for.
pub const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
/// The deposit of a method that is not `#[payable]`.
pub const NO_DEPOSIT: NearToken = NearToken::from_yoctonear(0);
/// A reward of 1 token at 6 decimals. The allowlist takes rewards from 1 to 10^12.
pub const REWARD: u128 = 1_000_000;
/// Test units minted to each of the poster, alice, bob and carol.
pub const MINTED: u128 = 1_000_000_000;
/// Length of each of a task's four windows. See the module comment.
pub const WINDOW_SECS: u32 = 120;
/// The protocol fee `setup` configures, in basis points.
pub const FEE_BPS: u16 = 500;

/// A running sandbox with Tender and the test token deployed and configured.
#[derive(Clone)]
pub struct Env {
    pub worker: Worker<Sandbox>,
    pub tender: Contract,
    pub token: Contract,
    pub owner: Account,
    pub treasury: Account,
    pub judge: Account,
    pub poster: Account,
    pub alice: Account,
    pub bob: Account,
    pub carol: Account,
}

/// Runs the futures at the same time and returns their results in order, or the first error.
///
/// Each future must send its transactions from a key of its own; see the module comment.
pub async fn all<T, F>(futs: Vec<F>) -> anyhow::Result<Vec<T>>
where
    T: Send + 'static,
    F: Future<Output = anyhow::Result<T>> + Send + 'static,
{
    let handles: Vec<_> = futs.into_iter().map(tokio::spawn).collect();
    let mut out = Vec::with_capacity(handles.len());
    for handle in handles {
        out.push(handle.await.context("a concurrent task panicked")??);
    }
    Ok(out)
}

/// Why `r` failed: the failed outcomes of the transaction and its receipts, with their errors.
pub fn failure_text(r: &ExecutionFinalResult) -> String {
    r.failures()
        .iter()
        .map(|outcome| format!("{outcome:?}"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// `r` if the transaction succeeded, or an error that shows why it did not. A receipt that fails
/// on the side, such as a refused `ft_transfer`, does not fail the transaction; see `clean`.
pub fn ok(r: ExecutionFinalResult) -> anyhow::Result<ExecutionFinalResult> {
    if r.is_failure() {
        bail!("the call failed:\n{}", failure_text(&r));
    }
    Ok(r)
}

/// Like `ok`, for a call whose result the test does not look at.
pub fn done(r: ExecutionFinalResult) -> anyhow::Result<()> {
    ok(r).map(drop)
}

/// Like `clean`, for a call whose result the test does not look at.
pub fn done_clean(r: ExecutionFinalResult) -> anyhow::Result<()> {
    clean(r).map(drop)
}

/// `r` if the transaction succeeded and none of its receipts failed.
pub fn clean(r: ExecutionFinalResult) -> anyhow::Result<ExecutionFinalResult> {
    let r = ok(r)?;
    ensure!(
        r.receipt_failures().is_empty(),
        "a receipt failed:\n{}",
        failure_text(&r)
    );
    Ok(r)
}

/// Panics unless `r` failed and its failure mentions `needle`.
pub fn assert_fails_with(r: &ExecutionFinalResult, needle: &str) {
    assert!(
        r.is_failure(),
        "expected a failure mentioning {needle:?}, but the call succeeded (logs: {:?})",
        r.logs()
    );
    let text = failure_text(r);
    assert!(
        text.contains(needle),
        "expected a failure mentioning {needle:?}, got:\n{text}"
    );
}

/// The Tender events that the successful receipts of `r` logged, as `(name, data)`.
///
/// A failed receipt keeps its logs, so an event from one would not have happened.
pub fn events(r: &ExecutionFinalResult) -> Vec<(String, Value)> {
    r.outcomes()
        .into_iter()
        .filter(|outcome| outcome.is_success())
        .flat_map(|outcome| outcome.logs.iter())
        .filter_map(|log| log.strip_prefix("EVENT_JSON:"))
        .filter_map(|json| serde_json::from_str::<Value>(json).ok())
        .filter(|event| event["standard"] == "tender")
        .map(|event| {
            (
                event["event"].as_str().unwrap_or_default().to_string(),
                event["data"][0].clone(),
            )
        })
        .collect()
}

/// The data of the one event called `name` in `r`; panics if there is not exactly one.
pub fn event(r: &ExecutionFinalResult, name: &str) -> Value {
    let mut found: Vec<Value> = events(r)
        .into_iter()
        .filter(|(n, _)| n == name)
        .map(|(_, data)| data)
        .collect();
    assert_eq!(
        found.len(),
        1,
        "expected one {name} event, logs: {:?}",
        r.logs()
    );
    found.remove(0)
}

/// The fee a pick takes from `reward` at `FEE_BPS`, rounded down as the contract does.
pub fn fee_of(reward: u128) -> u128 {
    reward * u128::from(FEE_BPS) / 10_000
}

pub fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

/// 64 lowercase hex characters, the form every hash takes in the contract's JSON.
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The commitment that enters `account` in task `task_id` with the work whose SHA-256 is
/// `content_hash`, recomputed the way the contract's `commitment_of` does: the SHA-256 of the
/// Borsh encoding of `(task_id, account, content_hash, salt)`. That is the task id as a
/// little-endian u64, the account id's length as a little-endian u32 and its bytes, then the two
/// 32-byte arrays.
pub fn commitment_of(
    task_id: u64,
    account: &str,
    content_hash: &[u8; 32],
    salt: &[u8; 32],
) -> [u8; 32] {
    let preimage = borsh::to_vec(&(task_id, account, content_hash, salt))
        .expect("a tuple of integers, a string and byte arrays always encodes");
    sha256(&preimage)
}

fn read_wasm(path: &str) -> anyhow::Result<Vec<u8>> {
    std::fs::read(path).with_context(|| format!("cannot read {path}; run contract/build.sh first"))
}

pub async fn create(root: Account, name: &'static str, near: u128) -> anyhow::Result<Account> {
    Ok(root
        .create_subaccount(name)
        .initial_balance(NearToken::from_near(near))
        .transact()
        .await?
        .into_result()?)
}

async fn deploy(account: Account, wasm: Vec<u8>) -> anyhow::Result<Contract> {
    Ok(account.deploy(&wasm).await?.into_result()?)
}

/// Creates a funded account under the sandbox root, with the sandbox's default key.
pub async fn new_account(env: &Env, name: &'static str) -> anyhow::Result<Account> {
    create(env.worker.root_account()?, name, 10).await
}

/// Deploys and initialises Tender and the test token, and prepares the accounts.
///
/// - `owner`, `treasury`, `judge`, `poster`, `alice`, `bob` and `carol` are sub-accounts of the
///   sandbox root, as are the contracts `tender` and `token`.
/// - Tender's `new` is called by the contract account, since it is `#[private]`. Its fee is 500 bps
///   and its shortest window `min_window_secs`.
/// - The seven accounts and `tender` have a storage balance at the token (the owner's comes from
///   the token's `new`). The seven also have 0.1 NEAR of storage balance at Tender, which the
///   owner needs before `set_token`: it charges the owner for the treasury's vault slot.
/// - The token is allowlisted at Tender for rewards of 1 to 10^12, and the poster, alice, bob and
///   carol hold 1_000_000_000 units of it.
pub async fn setup(min_window_secs: u32) -> anyhow::Result<Env> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let tender_wasm = read_wasm(TENDER_WASM)?;
    let token_wasm = read_wasm(TOKEN_WASM)?;

    let names = [
        "tender", "token", "owner", "treasury", "judge", "poster", "alice", "bob", "carol",
    ];
    // The root creates them all, so one after another.
    let mut created = Vec::with_capacity(names.len());
    for name in names {
        let near = if name == "tender" { 30 } else { 10 };
        created.push(create(root.clone(), name, near).await?);
    }
    let [tender, token, owner, treasury, judge, poster, alice, bob, carol]: [Account; 9] = created
        .try_into()
        .map_err(|_| anyhow::anyhow!("created the wrong number of accounts"))?;

    let (tender, token) = tokio::try_join!(deploy(tender, tender_wasm), deploy(token, token_wasm))?;
    let env = Env {
        worker,
        tender,
        token,
        owner,
        treasury,
        judge,
        poster,
        alice,
        bob,
        carol,
    };

    // The owner is registered at the token by `new`, and holds none of it.
    let init_tender = env.tender.call("new").args_json(json!({
        "owner": env.owner.id(),
        "treasury": env.treasury.id(),
        "fee_bps": FEE_BPS,
        "min_window_secs": min_window_secs,
    }));
    let init_token = env
        .token
        .call("new")
        .args_json(json!({ "owner_id": env.owner.id(), "total_supply": "0" }));
    let (init_tender, init_token) =
        tokio::try_join!(init_tender.transact(), init_token.transact())?;
    done(init_tender)?;
    done(init_token)?;

    // Token storage for everyone who can hold the token, and for the contract that will.
    let at_token = vec![
        env.tender.as_account().clone(),
        env.treasury.clone(),
        env.judge.clone(),
        env.poster.clone(),
        env.alice.clone(),
        env.bob.clone(),
        env.carol.clone(),
    ];
    all(at_token
        .into_iter()
        .map(|account| register_at_token(env.token.id().clone(), account))
        .collect())
    .await?;

    // Mint, and give every account its storage balance at Tender. The token account signs the mints,
    // so they go one after another, while the accounts' own deposits go in parallel.
    let mints = async {
        for who in [&env.poster, &env.alice, &env.bob, &env.carol] {
            mint(&env, who.id(), MINTED).await?;
        }
        anyhow::Ok(())
    };
    let at_tender = [
        &env.owner,
        &env.treasury,
        &env.judge,
        &env.poster,
        &env.alice,
        &env.bob,
        &env.carol,
    ]
    .into_iter()
    .map(|who| storage_deposit(&env, who, NearToken::from_millinear(100)))
    .collect();
    tokio::try_join!(mints, all::<(), _>(at_tender))?;

    // The owner's storage balance exists by now, and `set_token` charges it.
    let r = env
        .owner
        .call(env.tender.id(), "set_token")
        .args_json(json!({
            "token": env.token.id(),
            "min_reward": "1",
            "max_reward": "1000000000000",
            "enabled": true,
        }))
        .deposit(ONE_YOCTO)
        .max_gas()
        .transact()
        .await?;
    done(r)?;
    Ok(env)
}

async fn register_at_token(token: AccountId, who: Account) -> anyhow::Result<()> {
    let r = who
        .call(&token, "storage_deposit")
        .args_json(json!({}))
        .deposit(NearToken::from_millinear(10))
        .max_gas()
        .transact()
        .await?;
    done(r)?;
    Ok(())
}

/// Mints `amount` of the test token to `who`, who must be registered at the token.
pub fn mint(env: &Env, who: &AccountId, amount: u128) -> impl Future<Output = anyhow::Result<()>> {
    let call = env
        .token
        .call("mint")
        .args_json(json!({ "account_id": who, "amount": amount.to_string() }))
        .max_gas();
    async move {
        done(call.transact().await?)?;
        Ok(())
    }
}

/// Gives `who` a storage balance at Tender of `amount`.
pub fn storage_deposit(
    env: &Env,
    who: &Account,
    amount: NearToken,
) -> impl Future<Output = anyhow::Result<()>> {
    let call = who
        .call(env.tender.id(), "storage_deposit")
        .args_json(json!({}))
        .deposit(amount)
        .max_gas();
    async move {
        done(call.transact().await?)?;
        Ok(())
    }
}

/// Chain time now, in nanoseconds.
pub async fn now_ns(env: &Env) -> anyhow::Result<u64> {
    Ok(env.worker.view_block().await?.timestamp())
}

/// Moves chain time to `ns` or just past it, in steps of 200 blocks.
pub async fn advance_to(env: &Env, ns: u64) -> anyhow::Result<()> {
    for _ in 0..1_000 {
        if now_ns(env).await? >= ns {
            return Ok(());
        }
        env.worker.fast_forward(200).await?;
    }
    bail!("chain time never reached {ns}")
}

/// Calls `method` on Tender as `who` with `deposit` and all the gas there is.
pub async fn call(
    env: &Env,
    who: &Account,
    method: &str,
    args: Value,
    deposit: NearToken,
) -> anyhow::Result<ExecutionFinalResult> {
    Ok(who
        .call(env.tender.id(), method)
        .args_json(args)
        .deposit(deposit)
        .max_gas()
        .transact()
        .await?)
}

/// Calls the view `method` on `contract`.
pub async fn view(contract: &Contract, method: &str, args: Value) -> anyhow::Result<Value> {
    Ok(contract.view(method).args_json(args).await?.json()?)
}

/// Parses a decimal string, the form every u64 and u128 takes in the contract's JSON.
pub fn num(v: &Value) -> u128 {
    v.as_str()
        .unwrap_or_else(|| panic!("expected a decimal string, got {v}"))
        .parse()
        .unwrap_or_else(|_| panic!("expected a decimal string, got {v}"))
}

/// What `who` holds of the token in Tender's vault.
pub async fn vault_balance(env: &Env, who: &AccountId) -> anyhow::Result<u128> {
    let v = view(
        &env.tender,
        "balance_of",
        json!({ "account_id": who, "token": env.token.id() }),
    )
    .await?;
    Ok(num(&v))
}

/// What `who` holds of the token itself.
pub async fn token_balance(env: &Env, who: &AccountId) -> anyhow::Result<u128> {
    let v = view(&env.token, "ft_balance_of", json!({ "account_id": who })).await?;
    Ok(num(&v))
}

/// The bytes of Tender's state that `who` is charged for.
pub async fn storage_used(env: &Env, who: &AccountId) -> anyhow::Result<u64> {
    let v = view(
        &env.tender,
        "storage_balance_of",
        json!({ "account_id": who }),
    )
    .await?;
    ensure!(!v.is_null(), "{who} has no storage balance at Tender");
    Ok(num(&v["used_bytes"]) as u64)
}

/// The task `task_id` as `get_task` shows it.
pub async fn get_task(env: &Env, task_id: u64) -> anyhow::Result<Value> {
    let v = view(
        &env.tender,
        "get_task",
        json!({ "task_id": task_id.to_string() }),
    )
    .await?;
    ensure!(!v.is_null(), "no task {task_id}");
    Ok(v)
}

/// A deadline of a task as `get_task` shows it, in nanoseconds.
pub fn deadline(task: &Value, field: &str) -> u64 {
    num(&task[field]) as u64
}

/// The entry of `who` in task `task_id`, or `null`.
pub async fn get_entry(env: &Env, task_id: u64, who: &AccountId) -> anyhow::Result<Value> {
    view(
        &env.tender,
        "get_entry",
        json!({ "task_id": task_id.to_string(), "account_id": who }),
    )
    .await
}

/// Checks that the token Tender holds is accounted for: the vault balances of `env`'s accounts and
/// of `extra`, plus the escrow of the tasks not settled yet.
pub async fn assert_conserved(env: &Env, extra: &[&AccountId]) -> anyhow::Result<()> {
    let mut holders: Vec<&AccountId> = [
        &env.owner,
        &env.treasury,
        &env.judge,
        &env.poster,
        &env.alice,
        &env.bob,
        &env.carol,
    ]
    .into_iter()
    .map(|account| account.id())
    .collect();
    holders.extend_from_slice(extra);
    let mut vaults = 0;
    for holder in holders {
        vaults += vault_balance(env, holder).await?;
    }
    let tasks = view(
        &env.tender,
        "get_tasks",
        json!({ "from_id": "1", "limit": 50 }),
    )
    .await?;
    let escrow: u128 = tasks
        .as_array()
        .context("get_tasks returns a list")?
        .iter()
        .filter(|task| task["outcome"].is_null())
        .map(|task| num(&task["reward"]))
        .sum();
    let held = token_balance(env, env.tender.id()).await?;
    ensure!(
        held == vaults + escrow,
        "Tender holds {held} of the token, but its vaults hold {vaults} and its open tasks {escrow}"
    );
    Ok(())
}

/// `ft_transfer_call` of `amount` from `who` to Tender with `msg`: the raw result, for a test that
/// expects the deposit to be refused.
pub async fn transfer_call(
    env: &Env,
    who: &Account,
    amount: u128,
    msg: &str,
) -> anyhow::Result<ExecutionFinalResult> {
    Ok(who
        .call(env.token.id(), "ft_transfer_call")
        .args_json(json!({
            "receiver_id": env.tender.id(),
            "amount": amount.to_string(),
            "msg": msg,
        }))
        .deposit(ONE_YOCTO)
        .max_gas()
        .transact()
        .await?)
}

/// Deposits `amount` of the token into `who`'s own vault, and checks that all of it was credited.
pub async fn deposit(env: &Env, who: &Account, amount: u128) -> anyhow::Result<()> {
    deposit_msg(env, who, amount, "").await.map(|_| ())
}

/// Deposits `amount` from `who` into the vault of `beneficiary`.
pub async fn deposit_for(
    env: &Env,
    who: &Account,
    beneficiary: &AccountId,
    amount: u128,
) -> anyhow::Result<()> {
    let msg = json!({ "for": beneficiary }).to_string();
    deposit_msg(env, who, amount, &msg).await.map(|_| ())
}

/// The deposit itself, returning its result. `ft_transfer_call` returns the amount that Tender
/// took, which is all of it when the deposit was credited and nothing when it was refused.
pub async fn deposit_msg(
    env: &Env,
    who: &Account,
    amount: u128,
    msg: &str,
) -> anyhow::Result<ExecutionFinalResult> {
    let r = clean(transfer_call(env, who, amount, msg).await?)?;
    let took: String = r.clone().json()?;
    ensure!(
        took == amount.to_string(),
        "Tender took {took} of a deposit of {amount}"
    );
    Ok(r)
}

/// A `post_task` argument for the test token: four windows of `WINDOW_SECS`, no limit on entries,
/// open to anyone, and `verifier` as the account that picks.
pub fn task_json(env: &Env, reward: u128, verifier: &AccountId, max_winners: u8) -> Value {
    json!({
        "token": env.token.id(),
        "reward": reward.to_string(),
        "brief_uri": "ipfs://brief",
        "brief_hash": hex(&sha256(b"brief")),
        "criteria_hash": hex(&sha256(b"criteria")),
        "heldout_commitment": null,
        "verifier": verifier,
        "commit_secs": WINDOW_SECS,
        "reveal_secs": WINDOW_SECS,
        "pick_secs": WINDOW_SECS,
        "fallback_secs": WINDOW_SECS,
        "max_entries": 0,
        "max_winners": max_winners,
        "invited": [],
        "parent": null,
    })
}

/// Posts the task `task` as `who` (1 yocto attached), and returns its id.
pub async fn post(env: &Env, who: &Account, task: Value) -> anyhow::Result<u64> {
    let r = call(env, who, "post_task", json!({ "task": task }), ONE_YOCTO).await?;
    let id: String = clean(r)?.json()?;
    Ok(id.parse()?)
}

/// What an entrant keeps between its commit and its reveal.
pub struct Sealed {
    pub content_hash: [u8; 32],
    pub salt: [u8; 32],
}

/// The content hash and salt `who` uses for `content` in task `task_id`. The salt is derived from
/// the task and the account so that a failing test is reproducible; the contract only needs it to
/// be known to the entrant.
pub fn seal(task_id: u64, who: &AccountId, content: &[u8]) -> Sealed {
    Sealed {
        content_hash: sha256(content),
        salt: sha256(format!("salt of {who} in task {task_id}").as_bytes()),
    }
}

/// Sends `who`'s `commit` for `sealed` to task `task_id`: the raw result.
pub async fn commit_call(
    env: &Env,
    who: &Account,
    task_id: u64,
    sealed: &Sealed,
) -> anyhow::Result<ExecutionFinalResult> {
    let commitment = commitment_of(
        task_id,
        who.id().as_str(),
        &sealed.content_hash,
        &sealed.salt,
    );
    call(
        env,
        who,
        "commit",
        json!({ "task_id": task_id.to_string(), "commitment": hex(&commitment) }),
        NO_DEPOSIT,
    )
    .await
}

/// Commits `who` to task `task_id` with `content`, which must succeed. Returns `(content_hash,
/// salt)`, which the entrant reveals after the commit deadline with `reveal`.
pub async fn commit_work(
    env: &Env,
    who: &Account,
    task_id: u64,
    content: &[u8],
) -> anyhow::Result<([u8; 32], [u8; 32])> {
    let sealed = seal(task_id, who.id(), content);
    done_clean(commit_call(env, who, task_id, &sealed).await?)?;
    Ok((sealed.content_hash, sealed.salt))
}

/// Sends `who`'s `reveal` of `content_hash` and `salt` to task `task_id`: the raw result.
pub async fn reveal(
    env: &Env,
    who: &Account,
    task_id: u64,
    content_hash: &[u8; 32],
    salt: &[u8; 32],
    uri: &str,
) -> anyhow::Result<ExecutionFinalResult> {
    call(
        env,
        who,
        "reveal",
        json!({
            "task_id": task_id.to_string(),
            "content_hash": hex(content_hash),
            "salt": hex(salt),
            "uri": uri,
        }),
        NO_DEPOSIT,
    )
    .await
}

/// A winner in the form `pick` takes.
pub fn winner(account: &Account, bps: u16) -> Value {
    json!({ "account": account.id(), "bps": bps })
}

/// Sends `who`'s `pick` of `winners` for task `task_id`: the raw result.
pub async fn pick(
    env: &Env,
    who: &Account,
    task_id: u64,
    winners: Vec<Value>,
) -> anyhow::Result<ExecutionFinalResult> {
    call(
        env,
        who,
        "pick",
        json!({
            "task_id": task_id.to_string(),
            "winners": winners,
            "scorecard_hash": hex(&sha256(b"scorecard")),
            "scorecard_uri": "ipfs://scorecard",
        }),
        NO_DEPOSIT,
    )
    .await
}

/// Sends `who`'s `void_task` for task `task_id`: the raw result.
pub async fn void_task(
    env: &Env,
    who: &Account,
    task_id: u64,
) -> anyhow::Result<ExecutionFinalResult> {
    call(
        env,
        who,
        "void_task",
        json!({ "task_id": task_id.to_string() }),
        NO_DEPOSIT,
    )
    .await
}

/// Sends `who`'s `cleanup` of up to `limit` entries of task `task_id`: the raw result.
pub async fn cleanup(
    env: &Env,
    who: &Account,
    task_id: u64,
    limit: u32,
) -> anyhow::Result<ExecutionFinalResult> {
    call(
        env,
        who,
        "cleanup",
        json!({ "task_id": task_id.to_string(), "limit": limit }),
        NO_DEPOSIT,
    )
    .await
}

/// Sends `who`'s `withdraw` of `amount` of the token, to `to` (default: `who`), with 1 yocto and
/// `gas` attached: the raw result.
pub async fn withdraw(
    env: &Env,
    who: &Account,
    amount: u128,
    to: Option<&AccountId>,
    gas: Gas,
) -> anyhow::Result<ExecutionFinalResult> {
    Ok(who
        .call(env.tender.id(), "withdraw")
        .args_json(json!({ "token": env.token.id(), "amount": amount.to_string(), "to": to }))
        .deposit(ONE_YOCTO)
        .gas(gas)
        .transact()
        .await?)
}

/// Adds to `who` a function-call key that may call only `methods` on Tender, with no allowance
/// cap, and returns an account that signs with that key.
pub async fn function_call_key(
    env: &Env,
    who: &Account,
    methods: &[&str],
) -> anyhow::Result<Account> {
    let secret = SecretKey::from_random(KeyType::ED25519);
    let key = AccessKey::function_call_access(env.tender.id(), methods, None);
    done(
        who.batch(who.id())
            .add_key(secret.public_key(), key)
            .transact()
            .await?,
    )?;
    Ok(Account::from_secret_key(
        who.id().clone(),
        secret,
        &env.worker,
    ))
}

/// Everything Tender stores, key by key. Two equal snapshots mean that what happened in between
/// changed nothing, whatever the contract's views show.
pub type Stored = HashMap<Vec<u8>, Vec<u8>>;

/// A snapshot of Tender's storage.
pub async fn stored(env: &Env) -> anyhow::Result<Stored> {
    Ok(env.worker.view_state(env.tender.id()).await?)
}

/// Creates `count` accounts called `e0`, `e1`, and so on, each with `near` NEAR. They are sub-accounts
/// of the seven accounts of `env`, which create theirs at the same time, so that no key signs two
/// creations at once (see the module comment). Each of the seven pays for its share out of the 10
/// NEAR it starts with, so `count / 7 * near` has to stay well under 10. The new accounts have no
/// storage balance at Tender or at the token.
pub async fn create_entrants(env: &Env, count: usize, near: u128) -> anyhow::Result<Vec<Account>> {
    let parents = [
        &env.owner,
        &env.treasury,
        &env.judge,
        &env.poster,
        &env.alice,
        &env.bob,
        &env.carol,
    ];
    let stride = parents.len();
    let batches = parents
        .into_iter()
        .enumerate()
        .map(|(first, parent)| {
            let parent = parent.clone();
            async move {
                let mut made = Vec::new();
                for i in (first..count).step_by(stride) {
                    let account = parent
                        .create_subaccount(&format!("e{i}"))
                        .initial_balance(NearToken::from_near(near))
                        .transact()
                        .await?
                        .into_result()?;
                    made.push((i, account));
                }
                anyhow::Ok(made)
            }
        })
        .collect();
    let mut made: Vec<(usize, Account)> = all(batches).await?.into_iter().flatten().collect();
    made.sort_by_key(|(i, _)| *i);
    Ok(made.into_iter().map(|(_, account)| account).collect())
}
