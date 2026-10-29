//! A task's life on a real node, from the deposit that funds it to the cleanup after it settles.

mod common;

use common::*;
use near_workspaces::types::Gas;
use serde_json::json;

/// The two vectors that the contract's unit tests pin `commitment_of` to. Matching them ties this
/// crate's off-chain encoding to the on-chain one; the lifecycle tests then show that a reveal
/// built from the helper opens a commitment built from it.
#[test]
fn commitment_helper_matches_contract_vectors() {
    let salt: [u8; 32] = core::array::from_fn(|i| i as u8);
    assert_eq!(
        hex(&commitment_of(
            7,
            "alice.testnet",
            &sha256(b"hello world"),
            &salt
        )),
        "7e92e9a2323f2ca960418263d394956e0c4cacd348f83b46a915ab4ac8537977"
    );
    // The edge case: the largest task id, a 64-character account, empty content, a salt of 0xff.
    assert_eq!(
        hex(&commitment_of(
            u64::MAX,
            &"0123456789abcdef".repeat(4),
            &sha256(b""),
            &[0xff; 32]
        )),
        "76d8bcd34b9d099fb7fd104a1831cde0061451ecbcb9fb36ebebb479da4bb9d6"
    );
}

#[tokio::test]
async fn full_lifecycle_pays_and_withdraws() -> anyhow::Result<()> {
    let env = setup(5).await?;
    deposit(&env, &env.poster, REWARD).await?;
    assert_eq!(vault_balance(&env, env.poster.id()).await?, REWARD);

    let id = post(
        &env,
        &env.poster,
        task_json(&env, REWARD, env.judge.id(), 2),
    )
    .await?;
    assert_eq!(id, 1);
    // The reward left the poster's vault for the task's escrow.
    assert_eq!(vault_balance(&env, env.poster.id()).await?, 0);
    assert_conserved(&env, &[]).await?;

    let (alice_hash, alice_salt) = commit_work(&env, &env.alice, id, b"alice's work").await?;
    let (bob_hash, bob_salt) = commit_work(&env, &env.bob, id, b"bob's work").await?;
    let task = get_task(&env, id).await?;
    assert_eq!(task["phase"], "open");
    assert_eq!(task["commit_count"], 2);

    // A reveal built from the helper opens the commitment, so the encodings agree on the chain.
    advance_to(&env, deadline(&task, "commit_deadline")).await?;
    assert_eq!(get_task(&env, id).await?["phase"], "revealing");
    let r = clean(
        reveal(
            &env,
            &env.alice,
            id,
            &alice_hash,
            &alice_salt,
            "ipfs://alice",
        )
        .await?,
    )?;
    assert_eq!(event(&r, "revealed")["content_hash"], hex(&alice_hash));
    done_clean(reveal(&env, &env.bob, id, &bob_hash, &bob_salt, "ipfs://bob").await?)?;
    assert_eq!(get_task(&env, id).await?["reveal_count"], 2);

    advance_to(&env, deadline(&task, "reveal_deadline")).await?;
    assert_eq!(get_task(&env, id).await?["phase"], "judging");
    let r = clean(pick(&env, &env.judge, id, vec![winner(&env.alice, 10_000)]).await?)?;

    let fee = fee_of(REWARD);
    assert_eq!(fee, 50_000);
    let prize = REWARD - fee;
    assert_eq!(prize, 950_000);
    assert_eq!(vault_balance(&env, env.alice.id()).await?, prize);
    assert_eq!(vault_balance(&env, env.treasury.id()).await?, fee);
    assert_eq!(vault_balance(&env, env.bob.id()).await?, 0);
    let picked = event(&r, "picked");
    assert_eq!(picked["by"], env.judge.id().as_str());
    assert_eq!(picked["fee"], fee.to_string());
    assert_eq!(picked["winners"][0]["account"], env.alice.id().as_str());
    assert_eq!(picked["winners"][0]["amount"], prize.to_string());
    let task = get_task(&env, id).await?;
    assert_eq!(task["phase"], "settled");
    assert_eq!(task["outcome"]["kind"], "picked");
    assert_conserved(&env, &[]).await?;

    // Alice takes her prize out. The token pays it, and `on_withdraw` reports that it did.
    let before = token_balance(&env, env.alice.id()).await?;
    let r = clean(withdraw(&env, &env.alice, prize, None, Gas::from_tgas(300)).await?)?;
    assert!(r.clone().json::<bool>()?, "on_withdraw reports a payment");
    assert_eq!(event(&r, "withdraw")["amount"], prize.to_string());
    assert_eq!(token_balance(&env, env.alice.id()).await? - before, prize);
    assert_eq!(vault_balance(&env, env.alice.id()).await?, 0);
    assert_conserved(&env, &[]).await?;
    Ok(())
}

#[tokio::test]
async fn two_winners_split() -> anyhow::Result<()> {
    // A reward whose shares do not divide evenly, so the rounding dust has to go somewhere.
    // fee = 1_000_003 * 500 / 10_000 = 50_000; the rest is 950_003. At 7000 and 3000 bps the
    // shares round down to 665_002 and 285_000, and the 1 left over goes to the first winner.
    let reward = 1_000_003;
    let env = setup(5).await?;
    deposit(&env, &env.poster, reward).await?;
    let id = post(
        &env,
        &env.poster,
        task_json(&env, reward, env.judge.id(), 2),
    )
    .await?;
    let (alice_hash, alice_salt) = commit_work(&env, &env.alice, id, b"alice's work").await?;
    let (bob_hash, bob_salt) = commit_work(&env, &env.bob, id, b"bob's work").await?;

    let task = get_task(&env, id).await?;
    advance_to(&env, deadline(&task, "commit_deadline")).await?;
    done_clean(
        reveal(
            &env,
            &env.alice,
            id,
            &alice_hash,
            &alice_salt,
            "ipfs://alice",
        )
        .await?,
    )?;
    done_clean(reveal(&env, &env.bob, id, &bob_hash, &bob_salt, "ipfs://bob").await?)?;
    advance_to(&env, deadline(&task, "reveal_deadline")).await?;

    let r = clean(
        pick(
            &env,
            &env.judge,
            id,
            vec![winner(&env.alice, 7_000), winner(&env.bob, 3_000)],
        )
        .await?,
    )?;
    assert_eq!(vault_balance(&env, env.treasury.id()).await?, 50_000);
    assert_eq!(vault_balance(&env, env.alice.id()).await?, 665_003);
    assert_eq!(vault_balance(&env, env.bob.id()).await?, 285_000);
    let picked = event(&r, "picked");
    assert_eq!(picked["winners"][0]["amount"], "665003");
    assert_eq!(picked["winners"][1]["amount"], "285000");
    assert_eq!(picked["winners"][1]["bps"], 3_000);
    assert_conserved(&env, &[]).await?;
    Ok(())
}

#[tokio::test]
async fn empty_pick_refunds_poster() -> anyhow::Result<()> {
    let env = setup(5).await?;
    deposit(&env, &env.poster, REWARD).await?;
    let id = post(
        &env,
        &env.poster,
        task_json(&env, REWARD, env.judge.id(), 1),
    )
    .await?;
    let (hash, salt) = commit_work(&env, &env.alice, id, b"alice's work").await?;
    let task = get_task(&env, id).await?;
    advance_to(&env, deadline(&task, "commit_deadline")).await?;
    done_clean(reveal(&env, &env.alice, id, &hash, &salt, "ipfs://alice").await?)?;
    advance_to(&env, deadline(&task, "reveal_deadline")).await?;

    // The verifier finds nothing worth paying and picks nobody.
    let r = clean(pick(&env, &env.judge, id, vec![]).await?)?;
    assert_eq!(vault_balance(&env, env.poster.id()).await?, REWARD);
    assert_eq!(vault_balance(&env, env.treasury.id()).await?, 0);
    assert_eq!(vault_balance(&env, env.alice.id()).await?, 0);
    let voided = event(&r, "voided");
    assert_eq!(voided["reason"], "no_award");
    assert_eq!(voided["by"], env.judge.id().as_str());
    assert_eq!(voided["refunds"][0]["account"], env.poster.id().as_str());
    assert_eq!(voided["refunds"][0]["amount"], REWARD.to_string());
    let task = get_task(&env, id).await?;
    assert_eq!(task["phase"], "settled");
    assert_eq!(task["outcome"]["kind"], "voided");
    assert_conserved(&env, &[]).await?;
    Ok(())
}

#[tokio::test]
async fn void_no_reveals() -> anyhow::Result<()> {
    let env = setup(5).await?;
    deposit(&env, &env.poster, REWARD).await?;
    let id = post(
        &env,
        &env.poster,
        task_json(&env, REWARD, env.judge.id(), 1),
    )
    .await?;
    // Alice enters and never reveals.
    commit_work(&env, &env.alice, id, b"alice's work").await?;
    let task = get_task(&env, id).await?;

    // While reveals can still come in, the task cannot be voided.
    advance_to(&env, deadline(&task, "commit_deadline")).await?;
    assert_fails_with(&void_task(&env, &env.carol, id).await?, "E_PHASE");

    // Once the reveal window is over with nothing revealed, anyone can void it.
    advance_to(&env, deadline(&task, "reveal_deadline")).await?;
    let r = clean(void_task(&env, &env.carol, id).await?)?;
    let voided = event(&r, "voided");
    assert_eq!(voided["reason"], "no_reveals");
    assert!(voided["by"].is_null() && voided["scorecard_hash"].is_null());
    assert_eq!(voided["refunds"][0]["account"], env.poster.id().as_str());
    assert_eq!(vault_balance(&env, env.poster.id()).await?, REWARD);
    assert_eq!(get_task(&env, id).await?["phase"], "settled");
    assert_conserved(&env, &[]).await?;
    Ok(())
}

#[tokio::test]
async fn void_expired() -> anyhow::Result<()> {
    let env = setup(5).await?;
    deposit(&env, &env.poster, REWARD).await?;
    let id = post(
        &env,
        &env.poster,
        task_json(&env, REWARD, env.judge.id(), 1),
    )
    .await?;
    let (hash, salt) = commit_work(&env, &env.alice, id, b"alice's work").await?;
    let task = get_task(&env, id).await?;
    advance_to(&env, deadline(&task, "commit_deadline")).await?;
    done_clean(reveal(&env, &env.alice, id, &hash, &salt, "ipfs://alice").await?)?;

    // The judge never picks. With a reveal in, the task cannot be voided while the verifier and
    // then the poster can still pick.
    advance_to(&env, deadline(&task, "reveal_deadline")).await?;
    assert_eq!(get_task(&env, id).await?["phase"], "judging");
    assert_fails_with(&void_task(&env, &env.carol, id).await?, "E_PHASE");
    advance_to(&env, deadline(&task, "pick_deadline")).await?;
    assert_eq!(get_task(&env, id).await?["phase"], "fallback");
    assert_fails_with(&void_task(&env, &env.carol, id).await?, "E_PHASE");

    advance_to(&env, deadline(&task, "fallback_deadline")).await?;
    assert_eq!(get_task(&env, id).await?["phase"], "expired");
    let r = clean(void_task(&env, &env.carol, id).await?)?;
    assert_eq!(event(&r, "voided")["reason"], "expired");
    assert_eq!(vault_balance(&env, env.poster.id()).await?, REWARD);
    assert_eq!(get_task(&env, id).await?["phase"], "settled");
    assert_conserved(&env, &[]).await?;
    Ok(())
}

#[tokio::test]
async fn cleanup_refunds_entrant_storage() -> anyhow::Result<()> {
    let env = setup(5).await?;
    deposit(&env, &env.poster, REWARD).await?;
    let id = post(
        &env,
        &env.poster,
        task_json(&env, REWARD, env.judge.id(), 2),
    )
    .await?;
    let entrants = [&env.alice, &env.bob];
    let mut start = vec![];
    let mut sealed = vec![];
    for who in entrants {
        start.push(storage_used(&env, who.id()).await?);
        sealed.push(commit_work(&env, who, id, who.id().as_str().as_bytes()).await?);
    }
    let task = get_task(&env, id).await?;
    advance_to(&env, deadline(&task, "commit_deadline")).await?;
    let mut revealed = vec![];
    for (who, (hash, salt)) in entrants.into_iter().zip(&sealed) {
        done_clean(reveal(&env, who, id, hash, salt, "ipfs://work").await?)?;
        revealed.push(storage_used(&env, who.id()).await?);
    }
    advance_to(&env, deadline(&task, "reveal_deadline")).await?;
    done_clean(pick(&env, &env.judge, id, vec![winner(&env.alice, 10_000)]).await?)?;

    // Nothing is cleaned until someone asks.
    for (who, used) in entrants.into_iter().zip(&revealed) {
        assert_eq!(storage_used(&env, who.id()).await?, *used);
    }
    let r = clean(cleanup(&env, &env.carol, id, 50).await?)?;
    assert_eq!(
        r.json::<u32>()?,
        2,
        "cleanup reports the entries it went through"
    );

    // Each entrant got back its entry. The payout slots it made when it committed stay charged to
    // it, so it ends above where it started and below where its reveal left it.
    for ((who, first), last) in entrants.into_iter().zip(&start).zip(&revealed) {
        let now = storage_used(&env, who.id()).await?;
        assert!(now < *last, "{}: {now} should be below {last}", who.id());
        assert!(now > *first, "{}: {now} should be above {first}", who.id());
        assert!(get_entry(&env, id, who.id()).await?.is_null());
    }
    assert_eq!(get_task(&env, id).await?["cleaned"], 2);

    // With nothing left, a second cleanup does nothing.
    let r = clean(cleanup(&env, &env.carol, id, 50).await?)?;
    assert_eq!(r.json::<u32>()?, 0);
    assert_conserved(&env, &[]).await?;
    Ok(())
}

/// Collections defer their writes until they are flushed, and a measurement taken before the
/// flush reads nothing. The contract flushes before it measures; this checks, on the real
/// runtime, that a state-growing call is charged for the bytes it adds.
#[tokio::test]
async fn storage_is_charged_in_wasm() -> anyhow::Result<()> {
    let env = setup(5).await?;
    deposit(&env, &env.poster, REWARD).await?;

    let before = storage_used(&env, env.poster.id()).await?;
    let id = post(
        &env,
        &env.poster,
        task_json(&env, REWARD, env.judge.id(), 1),
    )
    .await?;
    let after = storage_used(&env, env.poster.id()).await?;
    // The task record, and 800 bytes reserved for its outcome.
    assert!(
        after >= before + 800,
        "posting charged {} bytes",
        after - before
    );

    let before = storage_used(&env, env.alice.id()).await?;
    commit_work(&env, &env.alice, id, b"alice's work").await?;
    let after = storage_used(&env, env.alice.id()).await?;
    assert!(after > before, "a commit charged {before} -> {after} bytes");
    Ok(())
}

/// `new` is `#[private]`, so nobody can initialise a contract that was deployed in a separate
/// transaction before its owner does, and nothing can initialise it twice.
#[tokio::test]
async fn init_is_private() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    // The root signs all three, so they go one after another.
    let tender = create(root.clone(), "tender", 30).await?;
    let owner = create(root.clone(), "owner", 10).await?;
    let outsider = create(root.clone(), "outsider", 10).await?;
    let tender = tender
        .deploy(&std::fs::read(TENDER_WASM)?)
        .await?
        .into_result()?;
    let args = |who: &near_workspaces::Account| {
        json!({
            "owner": who.id(),
            "treasury": who.id(),
            "fee_bps": 500,
            "min_window_secs": 5,
        })
    };

    // Deployed and not initialised: a view has no state to read.
    let config = tender.view("get_config").await;
    assert!(config.is_err(), "an uninitialised contract has no config");

    // Another account cannot initialise it, even naming itself the owner.
    let r = outsider
        .call(tender.id(), "new")
        .args_json(args(&outsider))
        .max_gas()
        .transact()
        .await?;
    assert_fails_with(&r, "Method new is private");
    assert!(tender.view("get_config").await.is_err());

    // The contract account itself can.
    done(
        tender
            .call("new")
            .args_json(args(&owner))
            .max_gas()
            .transact()
            .await?,
    )?;
    let config = view(&tender, "get_config", json!({})).await?;
    assert_eq!(config["owner"], owner.id().as_str());
    assert_eq!(config["version"], 1);

    // And only once.
    let r = tender
        .call("new")
        .args_json(args(&outsider))
        .max_gas()
        .transact()
        .await?;
    assert_fails_with(&r, "The contract has already been initialized");
    let config = view(&tender, "get_config", json!({})).await?;
    assert_eq!(config["owner"], owner.id().as_str());
    Ok(())
}
