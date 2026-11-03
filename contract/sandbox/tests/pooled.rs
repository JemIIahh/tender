//! Pooled bounties on the built wasm: many accounts top one task up, and a void gives each of them
//! back exactly what it paid in, all in one call whose gas the cap on funders bounds.
//!
//! The cap counts the poster, so fifty funders are the poster and 49 accounts that top up, and a
//! fiftieth account that tries is the task's 51st funder. Every call is sent with the gas the
//! TypeScript client attaches to it (`GAS` in packages/shared/src/calls.ts), so that a passing run
//! also says the client's figures cover the worst case.

mod common;

use common::*;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::Account;
use serde_json::json;

/// What each funder puts in, in units of the test token.
const SHARE: u128 = 1_000;
/// The most funders a task may have, the poster among them.
const MAX_FUNDERS: usize = 50;
/// The gas the client attaches to a top-up and to a void.
const TOP_UP_GAS: Gas = Gas::from_tgas(20);
const VOID_GAS: Gas = Gas::from_tgas(60);
/// What a void of fifty funders may burn, in Tgas (plan 01, Task 13).
const VOID_BUDGET_TGAS: f64 = 100.0;

/// What a call burnt in all, in Tgas: the transaction and every receipt that followed from it.
fn tgas(r: &ExecutionFinalResult) -> f64 {
    r.total_gas_burnt.as_gas() as f64 / 1e12
}

/// `who`'s `top_up_task` of `amount` into task `task_id`, with 1 yocto and `TOP_UP_GAS` attached:
/// the raw result.
async fn top_up(
    env: &Env,
    who: &Account,
    task_id: u64,
    amount: u128,
) -> anyhow::Result<ExecutionFinalResult> {
    Ok(who
        .call(env.tender.id(), "top_up_task")
        .args_json(json!({ "task_id": task_id.to_string(), "amount": amount.to_string() }))
        .deposit(ONE_YOCTO)
        .gas(TOP_UP_GAS)
        .transact()
        .await?)
}

/// The test sits in a module named after the suite, so that the plan's `cargo test -p
/// tender_sandbox pooled` selects it: a test's name does not include its binary's.
mod pooled {
    use super::*;

    #[tokio::test]
    async fn fifty_funders_void_refunds_each_exactly() -> anyhow::Result<()> {
        let env = setup(5).await?;
        // The poster posts a task of `SHARE`, which makes it the first funder. Nobody enters it.
        deposit(&env, &env.poster, SHARE).await?;
        let poster_prior = vault_balance(&env, env.poster.id()).await?;
        let id = post(&env, &env.poster, task_json(&env, SHARE, env.judge.id(), 1)).await?;

        // Fifty more accounts, each with a storage balance at Tender. An account of 1 NEAR cannot
        // prepay the 1 PGas that `max_gas()` attaches, so these calls attach 30 Tgas.
        let accounts = create_entrants(&env, MAX_FUNDERS, 1).await?;
        let registrations = accounts
            .iter()
            .map(|account| {
                let tx = account
                    .call(env.tender.id(), "storage_deposit")
                    .args_json(json!({}))
                    .deposit(NearToken::from_millinear(50))
                    .gas(Gas::from_tgas(30));
                async move { done_clean(tx.transact().await?) }
            })
            .collect();
        all(registrations).await?;
        // And `SHARE` in each one's vault: the four holders of the token deposit for them, a
        // quarter each, at the same time.
        let holders = [&env.poster, &env.alice, &env.bob, &env.carol];
        let (env_ref, accounts_ref) = (&env, &accounts);
        let deposits = |h: usize| async move {
            for account in accounts_ref.iter().skip(h).step_by(holders.len()) {
                deposit_for(env_ref, holders[h], account.id(), SHARE).await?;
            }
            anyhow::Ok(())
        };
        tokio::try_join!(deposits(0), deposits(1), deposits(2), deposits(3))?;
        // What each funder holds before it pays in: the poster first, then the fifty.
        let mut prior = vec![poster_prior];
        for account in &accounts {
            prior.push(vault_balance(&env, account.id()).await?);
        }
        assert_eq!(prior, vec![SHARE; MAX_FUNDERS + 1]);

        // 49 of them top up at once, which makes fifty funders with the poster.
        let (funders, late) = accounts.split_at(MAX_FUNDERS - 1);
        let sent = funders
            .iter()
            .map(|account| {
                let tx = account
                    .call(env.tender.id(), "top_up_task")
                    .args_json(json!({ "task_id": id.to_string(), "amount": SHARE.to_string() }))
                    .deposit(ONE_YOCTO)
                    .gas(TOP_UP_GAS);
                async move { anyhow::Ok(tx.transact().await?) }
            })
            .collect();
        let top_ups: Vec<ExecutionFinalResult> = all(sent)
            .await?
            .into_iter()
            .map(clean)
            .collect::<anyhow::Result<_>>()?;
        let mut rewards: Vec<u128> = top_ups
            .iter()
            .map(|r| num(&event(r, "task_topped_up")["reward"]))
            .collect();
        rewards.sort_unstable();
        // Each top-up's event says the reward it made: 2, 3, ... 50 shares, one each.
        let expected: Vec<u128> = (2..=MAX_FUNDERS as u128).map(|n| n * SHARE).collect();
        assert_eq!(rewards, expected);
        let worst_top_up = top_ups.iter().map(tgas).fold(0.0, f64::max);

        let task = get_task(&env, id).await?;
        assert_eq!(num(&task["reward"]), MAX_FUNDERS as u128 * SHARE);
        let recorded: Vec<(String, u128)> = task["funders"]
            .as_array()
            .expect("funders is a list")
            .iter()
            .map(|f| {
                (
                    f["account"].as_str().unwrap().to_string(),
                    num(&f["amount"]),
                )
            })
            .collect();
        assert_eq!(recorded.len(), MAX_FUNDERS);
        assert_eq!(
            recorded[0],
            (env.poster.id().to_string(), SHARE),
            "the poster comes first"
        );
        let mut topped: Vec<&str> = recorded[1..].iter().map(|(a, _)| a.as_str()).collect();
        let mut expected: Vec<&str> = funders.iter().map(|a| a.id().as_str()).collect();
        topped.sort_unstable();
        expected.sort_unstable();
        assert_eq!(topped, expected);
        assert!(recorded.iter().all(|(_, amount)| *amount == SHARE));
        for account in funders {
            assert_eq!(vault_balance(&env, account.id()).await?, 0);
        }

        // The fiftieth account would be the 51st funder. It is refused with the gas a top-up gets,
        // so the cap is what refuses it, and nothing changes.
        let last = &late[0];
        let before = stored(&env).await?;
        let r = top_up(&env, last, id, SHARE).await?;
        assert_fails_with(&r, "E_LIMIT: task 1 has 50 funders, the most it can have");
        assert!(
            stored(&env).await? == before,
            "a refused top-up changed storage"
        );
        assert_eq!(vault_balance(&env, last.id()).await?, SHARE);

        // Nobody revealed, so anyone may void the task once its reveal window is over. It refunds
        // all fifty in the one call, with the gas the client gives a void.
        advance_to(&env, deadline(&task, "reveal_deadline")).await?;
        let r = env
            .carol
            .call(env.tender.id(), "void_task")
            .args_json(json!({ "task_id": id.to_string() }))
            .gas(VOID_GAS)
            .transact()
            .await?;
        let r = clean(r)?;
        let void_tgas = tgas(&r);
        let voided = event(&r, "voided");
        assert_eq!(voided["reason"], "no_reveals");
        let refunds: Vec<(String, u128)> = voided["refunds"]
            .as_array()
            .expect("refunds is a list")
            .iter()
            .map(|f| {
                (
                    f["account"].as_str().unwrap().to_string(),
                    num(&f["amount"]),
                )
            })
            .collect();
        assert_eq!(
            refunds, recorded,
            "one refund per funder, in the funders' order"
        );

        // Each funder's vault is back where it was before it paid in, and so is the late one's.
        let mut after = vec![vault_balance(&env, env.poster.id()).await?];
        for account in &accounts {
            after.push(vault_balance(&env, account.id()).await?);
        }
        assert_eq!(after, prior);
        assert_eq!(
            vault_balance(&env, env.treasury.id()).await?,
            0,
            "no fee on a refund"
        );
        let settled = get_task(&env, id).await?;
        assert_eq!(settled["phase"], "settled");
        assert_eq!(settled["outcome"]["kind"], "voided");
        let extra: Vec<_> = accounts.iter().map(|a| a.id()).collect();
        assert_conserved(&env, &extra).await?;

        println!();
        println!("pooled gas (Tgas burnt by a call and all its receipts)");
        println!(
            "top_up_task, worst of {} (attached 20): {worst_top_up:.2}",
            top_ups.len()
        );
        println!("void_task, {MAX_FUNDERS} funders (attached 60): {void_tgas:.2}");
        println!();
        assert!(
        void_tgas < VOID_BUDGET_TGAS,
        "void_task with {MAX_FUNDERS} funders burnt {void_tgas:.2} Tgas, the budget is under {VOID_BUDGET_TGAS}"
    );
        Ok(())
    }
}
