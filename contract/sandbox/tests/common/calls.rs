//! Wrappers around Tender's change methods and views, and the token deposits that fund a vault.
//!
//! A wrapper named after a method returns the raw result, so that a test can look at a failure.
//! The ones that must succeed say so and check it.

use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId, Contract};
use serde_json::{json, Value};

use anyhow::ensure;

use super::*;

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
