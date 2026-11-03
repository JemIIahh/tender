//! Delegate keys on the built wasm: an agent's function-call key posts and tops up tasks with no
//! deposit, within the caps its account registered for it, and nothing it signs can raise those
//! caps or get past them.
//!
//! The lead is `poster`. Its agent key is a function-call key for Tender that may call
//! `post_task`, `top_up_task`, `commit` and `reveal`, with no allowance cap, as plan 01 Task 15
//! has it. Every call is sent with the gas the TypeScript client attaches to it (`GAS` in
//! packages/shared/src/calls.ts), so a passing run also says those figures are enough.

mod common;

use common::*;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::Gas;
use near_workspaces::{Account, AccountId};
use serde_json::{json, Value};

/// The caps of the plan's test: 5_000 per task and 10_000 in all.
const PER_TASK: u128 = 5_000;
const TOTAL: u128 = 10_000;
/// What each of the agent's posts spends.
const SPEND: u128 = 4_000;
/// The methods the agent's function-call key may call.
const AGENT_METHODS: [&str; 4] = ["post_task", "top_up_task", "commit", "reveal"];
/// The gas the client attaches to each call.
const POST_GAS: Gas = Gas::from_tgas(30);
const TOP_UP_GAS: Gas = Gas::from_tgas(20);
const DELEGATE_GAS: Gas = Gas::from_tgas(15);
const AUTH_MESSAGE: &str = "E_AUTH: attach exactly 1 yoctoNEAR or use a delegate key within caps";
const ONE_YOCTO_MESSAGE: &str = "Requires attached deposit of exactly 1 yoctoNEAR";

/// The public key `key` signs with, in NEAR's text form.
fn public_key(key: &Account) -> Value {
    json!(key.secret_key().public_key())
}

fn add_args(env: &Env, key: &Account, per_task: u128, total: u128) -> Value {
    json!({
        "public_key": public_key(key),
        "token": env.token.id(),
        "per_task_cap": per_task.to_string(),
        "total_cap": total.to_string(),
    })
}

/// `signer`'s `add_delegate` of `key` with the caps given and `deposit`: the raw result.
async fn add_delegate(
    env: &Env,
    signer: &Account,
    key: &Account,
    per_task: u128,
    total: u128,
    deposit: near_workspaces::types::NearToken,
) -> anyhow::Result<ExecutionFinalResult> {
    Ok(signer
        .call(env.tender.id(), "add_delegate")
        .args_json(add_args(env, key, per_task, total))
        .deposit(deposit)
        .gas(DELEGATE_GAS)
        .transact()
        .await?)
}

/// `signer`'s `remove_delegate` of `key` with `deposit`: the raw result.
async fn remove_delegate(
    env: &Env,
    signer: &Account,
    key: &Account,
    deposit: near_workspaces::types::NearToken,
) -> anyhow::Result<ExecutionFinalResult> {
    Ok(signer
        .call(env.tender.id(), "remove_delegate")
        .args_json(json!({ "public_key": public_key(key) }))
        .deposit(deposit)
        .gas(DELEGATE_GAS)
        .transact()
        .await?)
}

/// `get_delegate` for `account`'s key `key`: `null` or the caps.
async fn get_delegate(env: &Env, account: &AccountId, key: &Account) -> anyhow::Result<Value> {
    view(
        &env.tender,
        "get_delegate",
        json!({ "account_id": account, "public_key": public_key(key) }),
    )
    .await
}

/// What `account`'s key `key` has spent, as `get_delegate` says.
async fn spent(env: &Env, account: &AccountId, key: &Account) -> anyhow::Result<u128> {
    Ok(num(&get_delegate(env, account, key).await?["spent"]))
}

/// `key` posts a task of `reward` with no deposit and the client's gas: the raw result.
async fn post_as(env: &Env, key: &Account, reward: u128) -> anyhow::Result<ExecutionFinalResult> {
    let task = task_json(env, reward, env.judge.id(), 1);
    Ok(key
        .call(env.tender.id(), "post_task")
        .args_json(json!({ "task": task }))
        .gas(POST_GAS)
        .transact()
        .await?)
}

/// `key` tops task `task_id` up by `amount` with no deposit and the client's gas: the raw result.
async fn top_up_as(
    env: &Env,
    key: &Account,
    task_id: u64,
    amount: u128,
) -> anyhow::Result<ExecutionFinalResult> {
    Ok(key
        .call(env.tender.id(), "top_up_task")
        .args_json(json!({ "task_id": task_id.to_string(), "amount": amount.to_string() }))
        .gas(TOP_UP_GAS)
        .transact()
        .await?)
}

async fn task_count(env: &Env) -> anyhow::Result<u128> {
    Ok(num(&view(&env.tender, "task_count", json!({})).await?))
}

/// The tests sit in a module named after the suite, so that `cargo test -p tender_sandbox
/// delegate` selects them: a test's name does not include its binary's.
mod delegate {
    use super::*;

    #[tokio::test]
    async fn fc_delegate_key_posts_without_deposit() -> anyhow::Result<()> {
        let env = setup(5).await?;
        let lead = &env.poster;
        // Enough for three posts, so that the third fails on the cap and not on the funds.
        deposit(&env, lead, 3 * SPEND).await?;
        let agent = function_call_key(&env, lead, &AGENT_METHODS).await?;

        let r = clean(add_delegate(&env, lead, &agent, PER_TASK, TOTAL, ONE_YOCTO).await?)?;
        assert_eq!(
            event(&r, "delegate_added"),
            json!({
                "account": lead.id(),
                "public_key": public_key(&agent),
                "token": env.token.id(),
                "per_task_cap": "5000",
                "total_cap": "10000",
            })
        );
        assert_eq!(
            get_delegate(&env, lead.id(), &agent).await?,
            json!({
                "token": env.token.id(),
                "per_task_cap": "5000",
                "total_cap": "10000",
                "spent": "0",
            })
        );

        // Two posts of 4_000, signed by the agent's key with no deposit, spend the lead's vault.
        for n in 1..=2u128 {
            let r = clean(post_as(&env, &agent, SPEND).await?)?;
            let id: String = r.clone().json()?;
            let created = event(&r, "task_created");
            assert_eq!(created["id"], json!(id));
            assert_eq!(created["poster"], json!(lead.id()));
            assert_eq!(num(&created["reward"]), SPEND);
            assert_eq!(spent(&env, lead.id(), &agent).await?, n * SPEND);
        }

        // A third would take it to 12_000, past the total cap of 10_000.
        let r = post_as(&env, &agent, SPEND).await?;
        assert_fails_with(
            &r,
            "E_AUTH: 4000 more would take this delegate key past its total cap of 10000 (spent 8000)",
        );
        assert!(events(&r).is_empty());
        assert_eq!(spent(&env, lead.id(), &agent).await?, 2 * SPEND);
        assert_eq!(task_count(&env).await?, 2);
        assert_eq!(vault_balance(&env, lead.id()).await?, SPEND);
        assert_conserved(&env, &[]).await?;
        Ok(())
    }

    /// `spent` is written before the debit, and a debit that fails takes it back with the rest of
    /// the receipt. A top-up counts against the same caps as a post.
    #[tokio::test]
    async fn delegate_spend_counts_only_when_it_happens() -> anyhow::Result<()> {
        let env = setup(5).await?;
        let lead = &env.poster;
        deposit(&env, lead, 3_000).await?;
        let agent = function_call_key(&env, lead, &AGENT_METHODS).await?;
        done_clean(add_delegate(&env, lead, &agent, PER_TASK, TOTAL, ONE_YOCTO).await?)?;

        // Within the caps but not the vault: the post fails on the funds, after the caps were
        // checked and the spend counted, and the count goes back with the failed receipt.
        let r = post_as(&env, &agent, SPEND).await?;
        assert_fails_with(&r, "E_FUNDS: insufficient vault balance");
        assert_eq!(spent(&env, lead.id(), &agent).await?, 0);
        assert_eq!(task_count(&env).await?, 0);

        deposit(&env, lead, 5_000).await?;
        let r = clean(post_as(&env, &agent, SPEND).await?)?;
        let id: u64 = r.json::<String>()?.parse()?;
        assert_eq!(spent(&env, lead.id(), &agent).await?, SPEND);

        // The same key tops its task up: within both caps, then over the per-task cap.
        let r = clean(top_up_as(&env, &agent, id, 1_000).await?)?;
        assert_eq!(num(&event(&r, "task_topped_up")["reward"]), SPEND + 1_000);
        assert_eq!(spent(&env, lead.id(), &agent).await?, SPEND + 1_000);
        let r = top_up_as(&env, &agent, id, PER_TASK + 1).await?;
        assert_fails_with(
            &r,
            "E_AUTH: 5001 is over this delegate key's per-task cap of 5000",
        );
        assert_eq!(spent(&env, lead.id(), &agent).await?, SPEND + 1_000);
        assert_eq!(num(&get_task(&env, id).await?["reward"]), SPEND + 1_000);
        assert_eq!(vault_balance(&env, lead.id()).await?, 8_000 - SPEND - 1_000);
        assert_conserved(&env, &[]).await?;
        Ok(())
    }

    /// A delegate key cannot raise its own caps or lift a revocation: both methods want 1 yocto,
    /// which the node will not let a function-call key attach, even one allowed to call them. And
    /// both refuse an argument they do not take (ruling R21).
    #[tokio::test]
    async fn delegates_are_managed_only_by_a_full_access_key() -> anyhow::Result<()> {
        let env = setup(5).await?;
        let lead = &env.poster;
        let agent = function_call_key(
            &env,
            lead,
            &["post_task", "add_delegate", "remove_delegate"],
        )
        .await?;

        // An unknown argument fails the call before anything is stored.
        let before = stored(&env).await?;
        let mut args = add_args(&env, &agent, PER_TASK, TOTAL);
        args["unexpected"] = json!(true);
        let r = call(&env, lead, "add_delegate", args, ONE_YOCTO).await?;
        assert_fails_with(&r, "Failed to deserialize input from JSON");
        assert_fails_with(&r, "unknown field `unexpected`");
        assert!(stored(&env).await? == before);
        assert!(get_delegate(&env, lead.id(), &agent).await?.is_null());
        done_clean(add_delegate(&env, lead, &agent, PER_TASK, TOTAL, ONE_YOCTO).await?)?;

        let before = stored(&env).await?;
        let args = json!({ "public_key": public_key(&agent), "unexpected": true });
        let r = call(&env, lead, "remove_delegate", args, ONE_YOCTO).await?;
        assert_fails_with(&r, "unknown field `unexpected`");

        // The agent's key: with no deposit the contract refuses; with 1 yocto the node does.
        let r = add_delegate(&env, &agent, &agent, u128::MAX, u128::MAX, NO_DEPOSIT).await?;
        assert_fails_with(&r, ONE_YOCTO_MESSAGE);
        let r = remove_delegate(&env, &agent, &agent, NO_DEPOSIT).await?;
        assert_fails_with(&r, ONE_YOCTO_MESSAGE);
        let attempt = add_delegate(&env, &agent, &agent, u128::MAX, u128::MAX, ONE_YOCTO).await;
        let error = match attempt {
            Ok(r) => panic!("the node accepted a deposit from a function-call key: {r:?}"),
            Err(e) => format!("{e:?}"),
        };
        assert!(
            error.contains("DepositWithFunctionCall"),
            "unexpected error: {error}"
        );
        assert!(stored(&env).await? == before);
        assert_eq!(
            get_delegate(&env, lead.id(), &agent).await?,
            json!({
                "token": env.token.id(),
                "per_task_cap": "5000",
                "total_cap": "10000",
                "spent": "0",
            })
        );
        Ok(())
    }

    /// A key that may spend is never a key that judges. The judge's delegate key cannot pick, even
    /// when its access key may call `pick`, so a leaked one cannot award the tasks the judge
    /// verifies. The judge's full-access key can, and so can a function-call key of the judge
    /// that is no delegate, which is how the Judge service signs its picks.
    #[tokio::test]
    async fn verifier_delegate_key_cannot_pick() -> anyhow::Result<()> {
        let env = setup(5).await?;
        let judge = &env.judge;
        deposit(&env, &env.poster, 2 * REWARD).await?;
        let mut ids = Vec::new();
        let mut sealed = Vec::new();
        for content in [b"first", b"other"] {
            let id = post(&env, &env.poster, task_json(&env, REWARD, judge.id(), 1)).await?;
            sealed.push(commit_work(&env, &env.alice, id, content).await?);
            ids.push(id);
        }
        let delegate_key = function_call_key(&env, judge, &["post_task", "pick"]).await?;
        done_clean(add_delegate(&env, judge, &delegate_key, PER_TASK, TOTAL, ONE_YOCTO).await?)?;
        let picking_key = function_call_key(&env, judge, &["pick"]).await?;

        let task = get_task(&env, ids[0]).await?;
        advance_to(&env, deadline(&task, "commit_deadline")).await?;
        for (id, (hash, salt)) in ids.iter().zip(&sealed) {
            done_clean(reveal(&env, &env.alice, *id, hash, salt, "ipfs://alice").await?)?;
        }
        advance_to(&env, deadline(&task, "reveal_deadline")).await?;
        assert_eq!(get_task(&env, ids[0]).await?["phase"], "judging");

        // The delegate key is refused, for a pick and for an empty pick, and nothing changes.
        let before = stored(&env).await?;
        for winners in [vec![winner(&env.alice, 10_000)], vec![]] {
            let r = pick(&env, &delegate_key, ids[0], winners).await?;
            assert_fails_with(
                &r,
                &format!(
                    "E_AUTH: task {} cannot be picked with a delegate key; sign with another key \
                     of {}",
                    ids[0],
                    judge.id()
                ),
            );
            assert!(events(&r).is_empty());
        }
        assert!(
            stored(&env).await? == before,
            "a refused pick changed storage"
        );

        // The judge's other keys pick: a function-call key that is no delegate, and its
        // full-access key.
        done_clean(pick(&env, &picking_key, ids[0], vec![winner(&env.alice, 10_000)]).await?)?;
        done_clean(pick(&env, judge, ids[1], vec![winner(&env.alice, 10_000)]).await?)?;
        assert_eq!(
            vault_balance(&env, env.alice.id()).await?,
            2 * (REWARD - fee_of(REWARD))
        );
        assert_conserved(&env, &[]).await?;
        Ok(())
    }

    #[tokio::test]
    async fn remove_delegate_revokes_the_key_and_refunds_storage() -> anyhow::Result<()> {
        let env = setup(5).await?;
        let lead = &env.poster;
        deposit(&env, lead, 2 * SPEND).await?;
        let agent = function_call_key(&env, lead, &AGENT_METHODS).await?;
        // The task the agent posts reserves storage of its own, so the record's cost is measured
        // around the add and the remove alone.
        let start = storage_used(&env, lead.id()).await?;
        done_clean(add_delegate(&env, lead, &agent, PER_TASK, TOTAL, ONE_YOCTO).await?)?;
        let record = storage_used(&env, lead.id()).await? - start;
        assert!(record > 0, "add_delegate charged no storage");
        done_clean(post_as(&env, &agent, SPEND).await?)?;
        let with_task = storage_used(&env, lead.id()).await?;

        let r = clean(remove_delegate(&env, lead, &agent, ONE_YOCTO).await?)?;
        assert_eq!(
            event(&r, "delegate_removed"),
            json!({ "account": lead.id(), "public_key": public_key(&agent) })
        );
        assert!(get_delegate(&env, lead.id(), &agent).await?.is_null());
        assert_eq!(storage_used(&env, lead.id()).await?, with_task - record);

        // The access key is still on the account, and still reaches Tender, but spends nothing.
        let r = post_as(&env, &agent, SPEND).await?;
        assert_fails_with(&r, AUTH_MESSAGE);
        assert_eq!(task_count(&env).await?, 1);
        assert_eq!(vault_balance(&env, lead.id()).await?, SPEND);
        // Removing it again finds nothing.
        let r = remove_delegate(&env, lead, &agent, ONE_YOCTO).await?;
        assert_fails_with(&r, "E_NOT_FOUND: ");
        Ok(())
    }
}
