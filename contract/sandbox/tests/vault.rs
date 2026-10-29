//! The vault on a real node: refused deposits, withdrawals that the token refuses, and what a
//! function-call key can and cannot do.

mod common;

use common::*;
use near_workspaces::types::{Gas, NearToken};
use serde_json::json;

/// A deposit that Tender cannot credit goes back to the sender, and the call as a whole succeeds:
/// the refusal is the return value of `ft_on_transfer`, not a panic. A panic there would leave the
/// sender's tokens with a contract that never answers for them.
#[tokio::test]
async fn bad_msg_and_unregistered_beneficiary_are_refunded() -> anyhow::Result<()> {
    let env = setup(5).await?;
    // Nobody has registered dave anywhere.
    let dave = new_account(&env, "dave").await?;

    // A good deposit first, so that the refusals below are not just a setup that refuses all.
    deposit(&env, &env.alice, 1_000).await?;
    assert_eq!(vault_balance(&env, env.alice.id()).await?, 1_000);

    let alice_tokens = token_balance(&env, env.alice.id()).await?;
    let tender_tokens = token_balance(&env, env.tender.id()).await?;
    let refused = [
        ("a msg that is not JSON", "garbage{".to_string()),
        (
            "a beneficiary with no storage balance",
            json!({ "for": dave.id() }).to_string(),
        ),
        ("the array form of a msg", json!([env.bob.id()]).to_string()),
        (
            "an unknown key beside the beneficiary",
            json!({ "for": env.bob.id(), "memo": "x" }).to_string(),
        ),
    ];
    for (why, msg) in refused {
        let r = transfer_call(&env, &env.alice, 500, &msg).await?;
        // The outer transaction and every receipt succeed. Nothing panicked.
        assert!(r.is_success(), "{why}: {}", failure_text(&r));
        assert!(
            r.receipt_failures().is_empty(),
            "{why}: a receipt failed:\n{}",
            failure_text(&r)
        );
        // The token reports how much Tender took, and it took nothing.
        assert_eq!(r.clone().json::<String>()?, "0", "{why}");
        assert!(
            events(&r).is_empty(),
            "{why}: a refused deposit logs nothing"
        );
        // Every balance is where it was.
        assert_eq!(
            token_balance(&env, env.alice.id()).await?,
            alice_tokens,
            "{why}"
        );
        assert_eq!(
            token_balance(&env, env.tender.id()).await?,
            tender_tokens,
            "{why}"
        );
        assert_eq!(vault_balance(&env, env.alice.id()).await?, 1_000, "{why}");
        assert_eq!(vault_balance(&env, env.bob.id()).await?, 0, "{why}");
        assert_eq!(vault_balance(&env, dave.id()).await?, 0, "{why}");
    }
    assert_conserved(&env, &[dave.id()]).await?;
    Ok(())
}

/// A withdrawal debits first and asks the token to pay. When the token refuses, `on_withdraw`
/// puts the balance back, and the transaction still succeeds.
#[tokio::test]
async fn withdraw_to_unregistered_restores() -> anyhow::Result<()> {
    let env = setup(5).await?;
    // Dave can hold a vault balance at Tender but has no account at the token, so the token cannot
    // pay him.
    let dave = new_account(&env, "dave").await?;
    storage_deposit(&env, &dave, NearToken::from_millinear(100)).await?;
    deposit_for(&env, &env.alice, dave.id(), 1_000).await?;
    assert_eq!(vault_balance(&env, dave.id()).await?, 1_000);
    let tender_tokens = token_balance(&env, env.tender.id()).await?;

    let r = withdraw(&env, &dave, 400, None, Gas::from_tgas(300)).await?;
    assert!(r.is_success(), "{}", failure_text(&r));
    assert!(
        !r.clone().json::<bool>()?,
        "on_withdraw reports that the token did not pay"
    );
    // The token's `ft_transfer` is the one receipt that failed, and it says why.
    let failed = r.receipt_failures();
    assert_eq!(failed.len(), 1, "{}", failure_text(&r));
    assert!(format!("{:?}", failed[0]).contains("not registered"));
    let lost = event(&r, "withdraw_failed");
    assert_eq!(lost["account"], dave.id().as_str());
    assert_eq!(lost["amount"], "400");
    assert!(events(&r).iter().all(|(name, _)| name != "withdraw"));

    assert_eq!(vault_balance(&env, dave.id()).await?, 1_000);
    assert_eq!(token_balance(&env, env.tender.id()).await?, tender_tokens);
    assert_eq!(token_balance(&env, dave.id()).await.unwrap_or(0), 0);
    assert_conserved(&env, &[dave.id()]).await?;
    Ok(())
}

/// A function-call key cannot attach a deposit, and `withdraw` wants one, so a leaked key of this
/// kind cannot move money out of the vault.
#[tokio::test]
async fn function_call_key_cannot_withdraw() -> anyhow::Result<()> {
    let env = setup(5).await?;
    deposit(&env, &env.alice, 1_000).await?;
    // The key may call `withdraw`, so whatever stops it is not the method list.
    let key = function_call_key(&env, &env.alice, &["withdraw"]).await?;

    // With the yocto that `withdraw` asks for, the node itself refuses the transaction.
    let attempt = key
        .call(env.tender.id(), "withdraw")
        .args_json(json!({ "token": env.token.id(), "amount": "1" }))
        .deposit(ONE_YOCTO)
        .max_gas()
        .transact()
        .await;
    let error = match attempt {
        Ok(r) => panic!("the node accepted a deposit from a function-call key: {r:?}"),
        Err(e) => format!("{e:?}"),
    };
    assert!(
        error.contains("DepositWithFunctionCall"),
        "unexpected error: {error}"
    );

    // Without one, the node lets the call through and the contract turns it down.
    let r = key
        .call(env.tender.id(), "withdraw")
        .args_json(json!({ "token": env.token.id(), "amount": "1" }))
        .max_gas()
        .transact()
        .await?;
    assert_fails_with(&r, "Requires attached deposit of exactly 1 yoctoNEAR");

    assert_eq!(vault_balance(&env, env.alice.id()).await?, 1_000);
    Ok(())
}

/// The key an agent can safely leave on a server: it enters tasks, but spends nothing.
#[tokio::test]
async fn function_call_key_can_commit_and_reveal() -> anyhow::Result<()> {
    let env = setup(5).await?;
    deposit(&env, &env.poster, REWARD).await?;
    let id = post(
        &env,
        &env.poster,
        task_json(&env, REWARD, env.judge.id(), 1),
    )
    .await?;
    let key = function_call_key(&env, &env.alice, &["commit", "reveal"]).await?;

    let sealed = seal(id, env.alice.id(), b"alice's work");
    let r = clean(commit_call(&env, &key, id, &sealed).await?)?;
    // The contract sees the account, not the key: the predecessor is alice.
    assert_eq!(event(&r, "committed")["account"], env.alice.id().as_str());
    let entry = get_entry(&env, id, env.alice.id()).await?;
    assert_eq!(entry["index"], 0);

    let task = get_task(&env, id).await?;
    advance_to(&env, deadline(&task, "commit_deadline")).await?;
    let r = clean(
        reveal(
            &env,
            &key,
            id,
            &sealed.content_hash,
            &sealed.salt,
            "ipfs://alice",
        )
        .await?,
    )?;
    assert_eq!(event(&r, "revealed")["uri"], "ipfs://alice");
    let entry = get_entry(&env, id, env.alice.id()).await?;
    assert_eq!(entry["content_hash"], hex(&sealed.content_hash));

    // The key is limited to those two methods. Anything else, the node refuses.
    let attempt = key
        .call(env.tender.id(), "register_agent")
        .args_json(json!({}))
        .max_gas()
        .transact()
        .await;
    let error = format!(
        "{:?}",
        attempt.expect_err("the key is not allowed this method")
    );
    assert!(
        error.contains("MethodNameMismatch"),
        "unexpected error: {error}"
    );
    Ok(())
}

/// The keeper's key: it voids tasks that nobody picked, and cleans up settled ones.
#[tokio::test]
async fn function_call_key_can_void_and_cleanup() -> anyhow::Result<()> {
    let env = setup(5).await?;
    deposit(&env, &env.poster, REWARD).await?;
    let id = post(
        &env,
        &env.poster,
        task_json(&env, REWARD, env.judge.id(), 1),
    )
    .await?;
    // Alice enters and never reveals, so there is an entry to clean up after the void.
    commit_work(&env, &env.alice, id, b"alice's work").await?;
    let key = function_call_key(&env, &env.carol, &["void_task", "cleanup"]).await?;

    let task = get_task(&env, id).await?;
    advance_to(&env, deadline(&task, "reveal_deadline")).await?;
    let r = clean(void_task(&env, &key, id).await?)?;
    assert_eq!(event(&r, "voided")["reason"], "no_reveals");
    assert_eq!(vault_balance(&env, env.poster.id()).await?, REWARD);

    let r = clean(cleanup(&env, &key, id, 50).await?)?;
    assert_eq!(r.json::<u32>()?, 1);
    assert!(get_entry(&env, id, env.alice.id()).await?.is_null());

    // And it can do nothing else.
    let attempt = key
        .call(env.tender.id(), "commit")
        .args_json(json!({}))
        .max_gas()
        .transact()
        .await;
    let error = format!(
        "{:?}",
        attempt.expect_err("the key is not allowed this method")
    );
    assert!(
        error.contains("MethodNameMismatch"),
        "unexpected error: {error}"
    );
    Ok(())
}

/// `MIN_WITHDRAW_GAS` is 35 Tgas. The least gas that is accepted has to be enough for the whole
/// withdrawal: the transfer, its callback and the scheduling of both.
#[tokio::test]
async fn withdraw_with_exactly_35_tgas_succeeds() -> anyhow::Result<()> {
    let env = setup(5).await?;
    deposit(&env, &env.alice, 1_000).await?;
    let before = token_balance(&env, env.alice.id()).await?;

    // One Tgas short is refused up front, with nothing debited.
    let r = withdraw(&env, &env.alice, 400, None, Gas::from_tgas(34)).await?;
    assert_fails_with(&r, "E_GAS");
    assert_eq!(vault_balance(&env, env.alice.id()).await?, 1_000);

    let r = withdraw(&env, &env.alice, 400, None, Gas::from_tgas(35)).await?;
    let r = clean(r)?;
    assert!(r.clone().json::<bool>()?, "the token paid");
    assert_eq!(event(&r, "withdraw")["amount"], "400");
    println!("withdraw at 35 Tgas burnt {} in all", r.total_gas_burnt);
    assert_eq!(vault_balance(&env, env.alice.id()).await?, 600);
    assert_eq!(token_balance(&env, env.alice.id()).await? - before, 400);
    assert_conserved(&env, &[]).await?;
    Ok(())
}

/// The refund path needs gas too: the failed transfer, then `on_withdraw` crediting the balance
/// back. With only the least gas that `withdraw` accepts, it must still complete.
#[tokio::test]
async fn failed_withdraw_restores_with_35_tgas() -> anyhow::Result<()> {
    let env = setup(5).await?;
    // Dave exists but has no account at the token, so it will not accept a transfer.
    let dave = new_account(&env, "dave").await?;
    deposit(&env, &env.alice, 1_000).await?;
    let tender_tokens = token_balance(&env, env.tender.id()).await?;

    let r = withdraw(&env, &env.alice, 400, Some(dave.id()), Gas::from_tgas(35)).await?;
    assert!(r.is_success(), "{}", failure_text(&r));
    assert!(!r.clone().json::<bool>()?, "the token did not pay");
    assert_eq!(r.receipt_failures().len(), 1, "{}", failure_text(&r));
    let lost = event(&r, "withdraw_failed");
    assert_eq!(lost["account"], env.alice.id().as_str());
    assert_eq!(lost["to"], dave.id().as_str());
    println!(
        "failed withdraw at 35 Tgas burnt {} in all",
        r.total_gas_burnt
    );

    assert_eq!(vault_balance(&env, env.alice.id()).await?, 1_000);
    assert_eq!(token_balance(&env, env.tender.id()).await?, tender_tokens);
    assert_conserved(&env, &[dave.id()]).await?;
    Ok(())
}
