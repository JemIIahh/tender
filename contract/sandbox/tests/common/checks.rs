//! What the tests assert about a call's result: success or failure and why, the events it logged,
//! the token Tender holds, and Tender's storage key by key.

use std::collections::HashMap;

use anyhow::{bail, ensure, Context};
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::AccountId;
use serde_json::{json, Value};

use super::*;

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

/// Checks that the token Tender holds is accounted for: the vault balances of `env`'s accounts and
/// of `extra`, plus the escrow of the tasks not settled yet, plus the agent bonds it holds for
/// any of those accounts.
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
    let (mut vaults, mut bonds) = (0, 0);
    for holder in holders {
        vaults += vault_balance(env, holder).await?;
        let agent = view(&env.tender, "get_agent", json!({ "account_id": holder })).await?;
        if agent["bond_token"] == env.token.id().as_str() {
            bonds += num(&agent["bond_amount"]);
        }
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
        held == vaults + escrow + bonds,
        "Tender holds {held} of the token, but its vaults hold {vaults}, its open tasks {escrow} \
         and its agents' bonds {bonds}"
    );
    Ok(())
}

/// Everything Tender stores, key by key. Two equal snapshots mean that what happened in between
/// changed nothing, whatever the contract's views show.
pub type Stored = HashMap<Vec<u8>, Vec<u8>>;

/// A snapshot of Tender's storage.
pub async fn stored(env: &Env) -> anyhow::Result<Stored> {
    Ok(env.worker.view_state(env.tender.id()).await?)
}
