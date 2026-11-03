//! The adversarial suite (plan 01 Task 16): what an outsider, a forged token, an entrant or a
//! careless caller can try against the built wasm, and what the contract does about it. Each test
//! shows that the attack is refused, that a refusal changes nothing in Tender's storage, and, where
//! money is involved, that the token Tender holds is still accounted for.
//!
//! `forty_nine_unbonded_fillers_refused` was added with the agent bond (Task 16b).
//!
//! `ft_on_transfer_never_panics_on_random_msg` is the unit-level part of the suite: a property test
//! in contract/tender/src/vault.rs, since the sandbox crate has no proptest. The delegate keys'
//! part, `verifier_delegate_key_cannot_pick`, is in delegate.rs with the other delegate tests.

mod common;

use common::*;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId};
use serde_json::{json, Value};

/// The NEAR every storage balance at Tender in this suite starts with, when a test makes one.
const STORAGE: NearToken = NearToken::from_millinear(100);

/// Posts a task of `reward` by the poster, judged by the judge, and returns its id and view.
async fn post_judged(env: &Env, reward: u128, max_winners: u8) -> anyhow::Result<(u64, Value)> {
    deposit(env, &env.poster, reward).await?;
    let id = post(
        env,
        &env.poster,
        task_json(env, reward, env.judge.id(), max_winners),
    )
    .await?;
    Ok((id, get_task(env, id).await?))
}

/// Commits each of `who` to task `id` with work of its own, waits out the commit window and
/// reveals them all. Leaves chain time in the reveal window of `task`.
async fn enter_and_reveal(
    env: &Env,
    id: u64,
    task: &Value,
    who: &[&Account],
) -> anyhow::Result<()> {
    let mut sealed = Vec::new();
    for w in who {
        sealed.push(commit_work(env, w, id, w.id().as_str().as_bytes()).await?);
    }
    advance_to(env, deadline(task, "commit_deadline")).await?;
    for (w, (hash, salt)) in who.iter().zip(&sealed) {
        done_clean(reveal(env, w, id, hash, salt, "ipfs://work").await?)?;
    }
    Ok(())
}

/// Asserts that `r` failed with `needle`, logged no event, and left Tender's storage as `before`.
async fn assert_refused(
    env: &Env,
    r: &ExecutionFinalResult,
    needle: &str,
    before: &Stored,
) -> anyhow::Result<()> {
    assert_fails_with(r, needle);
    assert!(events(r).is_empty(), "a refusal logged {:?}", events(r));
    assert!(
        stored(env).await? == *before,
        "a call refused with {needle:?} changed Tender's storage"
    );
    Ok(())
}

/// `who` calls `commit` on task `id` with the commitment `commitment` (64 hex characters).
async fn commit_raw(
    env: &Env,
    who: &Account,
    id: u64,
    commitment: &str,
) -> anyhow::Result<ExecutionFinalResult> {
    call(
        env,
        who,
        "commit",
        json!({ "task_id": id.to_string(), "commitment": commitment }),
        NO_DEPOSIT,
    )
    .await
}

/// The callback of `withdraw` is the contract's own: a call from anyone else is refused before
/// it can credit anything, so nobody can restore a "failed" withdrawal that never failed.
#[tokio::test]
async fn on_withdraw_is_private() -> anyhow::Result<()> {
    let env = setup(5).await?;
    deposit(&env, &env.alice, 1_000).await?;
    let before = stored(&env).await?;
    let args = json!({
        "account": env.alice.id(),
        "token": env.token.id(),
        "amount": "1000000",
        "to": env.alice.id(),
    });
    // alice, whose vault the call would credit, and an account with no part in it.
    for who in [&env.alice, &env.carol] {
        let r = call(&env, who, "on_withdraw", args.clone(), NO_DEPOSIT).await?;
        assert_refused(&env, &r, "Method on_withdraw is private", &before).await?;
    }
    assert_eq!(vault_balance(&env, env.alice.id()).await?, 1_000);
    assert_conserved(&env, &[]).await?;
    Ok(())
}

/// Before the commit deadline the work is sealed: an entrant cannot reveal early, which would
/// let others copy it while they can still commit. From the deadline on, it can.
#[tokio::test]
async fn reveal_before_commit_deadline_rejected() -> anyhow::Result<()> {
    let env = setup(5).await?;
    let (id, task) = post_judged(&env, REWARD, 1).await?;
    let (hash, salt) = commit_work(&env, &env.alice, id, b"alice's work").await?;
    assert_eq!(get_task(&env, id).await?["phase"], "open");

    let before = stored(&env).await?;
    let r = reveal(&env, &env.alice, id, &hash, &salt, "ipfs://alice").await?;
    assert_refused(
        &env,
        &r,
        &format!("E_PHASE: task {id} is not in its reveal window"),
        &before,
    )
    .await?;
    assert!(get_entry(&env, id, env.alice.id()).await?["uri"].is_null());

    advance_to(&env, deadline(&task, "commit_deadline")).await?;
    done_clean(reveal(&env, &env.alice, id, &hash, &salt, "ipfs://alice").await?)?;
    assert_eq!(
        get_entry(&env, id, env.alice.id()).await?["uri"],
        "ipfs://alice"
    );
    Ok(())
}

/// Only the verifier picks in its window, and only the poster in the fallback window after it.
/// An outsider, an entrant picking itself, and the poster too early are all refused.
#[tokio::test]
async fn pick_by_stranger_rejected() -> anyhow::Result<()> {
    let env = setup(5).await?;
    let (id, task) = post_judged(&env, REWARD, 1).await?;
    enter_and_reveal(&env, id, &task, &[&env.alice, &env.bob]).await?;
    advance_to(&env, deadline(&task, "reveal_deadline")).await?;
    assert_eq!(get_task(&env, id).await?["phase"], "judging");

    let before = stored(&env).await?;
    let only = format!("E_AUTH: only the verifier or the poster can pick task {id}");
    for (who, winners) in [
        (&env.carol, vec![winner(&env.carol, 10_000)]),
        (&env.carol, vec![winner(&env.alice, 10_000)]),
        (&env.carol, vec![]),
        (&env.alice, vec![winner(&env.alice, 10_000)]),
        (&env.treasury, vec![winner(&env.bob, 10_000)]),
    ] {
        let r = pick(&env, who, id, winners).await?;
        assert_refused(&env, &r, &only, &before).await?;
    }
    // The poster is no verifier here, and its window opens only at the pick deadline.
    let r = pick(&env, &env.poster, id, vec![winner(&env.alice, 10_000)]).await?;
    assert_refused(
        &env,
        &r,
        &format!(
            "E_PHASE: task {id} is not in {}'s pick window",
            env.poster.id()
        ),
        &before,
    )
    .await?;

    done_clean(pick(&env, &env.judge, id, vec![winner(&env.bob, 10_000)]).await?)?;
    assert_eq!(
        vault_balance(&env, env.bob.id()).await?,
        REWARD - fee_of(REWARD)
    );
    assert_eq!(vault_balance(&env, env.alice.id()).await?, 0);
    assert_eq!(vault_balance(&env, env.carol.id()).await?, 0);
    assert_conserved(&env, &[]).await?;
    Ok(())
}

/// The smallest reward there is, 1 unit at a fee of 500 bps: the fee rounds down to 0, the net
/// is 1, and with shares of 5000 and 5000 the first winner gets 1 (half of 1 rounded down, plus
/// the dust) and the second 0. Nothing is created or lost (I7).
#[tokio::test]
async fn dust_reward_min_1() -> anyhow::Result<()> {
    let env = setup(5).await?;
    let (id, task) = post_judged(&env, 1, 2).await?;
    enter_and_reveal(&env, id, &task, &[&env.alice, &env.bob]).await?;
    advance_to(&env, deadline(&task, "reveal_deadline")).await?;

    let r = clean(
        pick(
            &env,
            &env.judge,
            id,
            vec![winner(&env.alice, 5_000), winner(&env.bob, 5_000)],
        )
        .await?,
    )?;
    let picked = event(&r, "picked");
    assert_eq!(picked["fee"], "0");
    let paid: Vec<(Value, Value, Value)> = picked["winners"]
        .as_array()
        .expect("winners is a list")
        .iter()
        .map(|w| (w["account"].clone(), w["bps"].clone(), w["amount"].clone()))
        .collect();
    assert_eq!(
        paid,
        vec![
            (json!(env.alice.id()), json!(5_000), json!("1")),
            (json!(env.bob.id()), json!(5_000), json!("0")),
        ]
    );
    assert_eq!(vault_balance(&env, env.alice.id()).await?, 1);
    assert_eq!(vault_balance(&env, env.bob.id()).await?, 0);
    assert_eq!(vault_balance(&env, env.treasury.id()).await?, 0);
    assert_eq!(
        get_task(&env, id).await?["outcome"]["winners"][1]["amount"],
        "0"
    );
    assert_conserved(&env, &[]).await?;
    Ok(())
}

/// A cap on entries could be filled with junk commits on an open task, so a non-zero
/// `max_entries` needs an `invited` list (spec C24), however large the cap. With one, only the
/// invited may enter.
#[tokio::test]
async fn huge_max_entries_without_invited_rejected() -> anyhow::Result<()> {
    let env = setup(5).await?;
    deposit(&env, &env.poster, REWARD).await?;
    let before = stored(&env).await?;
    for max_entries in [u32::MAX, 1] {
        let mut task = task_json(&env, REWARD, env.judge.id(), 1);
        task["max_entries"] = json!(max_entries);
        let r = call(
            &env,
            &env.poster,
            "post_task",
            json!({ "task": task }),
            ONE_YOCTO,
        )
        .await?;
        assert_refused(
            &env,
            &r,
            &format!("E_LIMIT: max_entries {max_entries} needs a non-empty invited list"),
            &before,
        )
        .await?;
    }
    assert_eq!(num(&view(&env.tender, "task_count", json!({})).await?), 0);
    assert_eq!(vault_balance(&env, env.poster.id()).await?, REWARD);

    // With an invited list, the same cap is a direct hire: alice may enter, bob may not.
    let mut task = task_json(&env, REWARD, env.judge.id(), 1);
    task["max_entries"] = json!(u32::MAX);
    task["invited"] = json!([env.alice.id()]);
    let id = post(&env, &env.poster, task).await?;
    let sealed = seal(id, env.bob.id(), b"bob's work");
    let before = stored(&env).await?;
    let r = commit_call(&env, &env.bob, id, &sealed).await?;
    assert_refused(
        &env,
        &r,
        &format!("E_INVITE: {} is not invited to task {id}", env.bob.id()),
        &before,
    )
    .await?;
    commit_work(&env, &env.alice, id, b"alice's work").await?;
    assert_eq!(get_task(&env, id).await?["commit_count"], 1);
    Ok(())
}

/// An implicit account (64 hex characters, made by sending NEAR to the hex of its key) has the
/// longest account id there is and no provider. It registers, commits, reveals, wins, and takes
/// its prize out like any other account.
#[tokio::test]
async fn implicit_64_hex_account_commits_and_wins() -> anyhow::Result<()> {
    let env = setup(5).await?;
    let secret = SecretKey::from_random(KeyType::ED25519);
    let id_hex = hex(secret.public_key().key_data());
    assert_eq!(id_hex.len(), 64);
    let implicit_id: AccountId = id_hex.parse()?;
    done(
        env.worker
            .root_account()?
            .transfer_near(&implicit_id, NearToken::from_near(5))
            .await?,
    )?;
    let implicit = Account::from_secret_key(implicit_id.clone(), secret, &env.worker);

    // Storage at Tender and at the token, and an agent profile, which has no provider.
    storage_deposit(&env, &implicit, STORAGE).await?;
    done_clean(
        implicit
            .call(env.token.id(), "storage_deposit")
            .args_json(json!({}))
            .deposit(NearToken::from_millinear(10))
            .max_gas()
            .transact()
            .await?,
    )?;
    let r = call(
        &env,
        &implicit,
        "register_agent",
        json!({
            "profile_uri": "https://agent.example/profile.json",
            "profile_hash": hex(&sha256(b"profile")),
            "tags": ["implicit"],
        }),
        ONE_YOCTO,
    )
    .await?;
    assert!(event(&clean(r)?, "agent_registered")["asp"].is_null());

    let (id, task) = post_judged(&env, REWARD, 1).await?;
    // The commitment's preimage holds the 64-character id; the helper encodes it as the
    // contract does, so the reveal opens it.
    enter_and_reveal(&env, id, &task, &[&implicit, &env.alice]).await?;
    assert_eq!(
        get_entry(&env, id, &implicit_id).await?["uri"],
        "ipfs://work"
    );
    advance_to(&env, deadline(&task, "reveal_deadline")).await?;
    done_clean(pick(&env, &env.judge, id, vec![winner(&implicit, 10_000)]).await?)?;

    let prize = REWARD - fee_of(REWARD);
    assert_eq!(vault_balance(&env, &implicit_id).await?, prize);
    let agent = view(
        &env.tender,
        "get_agent",
        json!({ "account_id": implicit_id }),
    )
    .await?;
    assert_eq!(agent["wins"], 1);
    assert!(agent["asp"].is_null());
    let r = clean(withdraw(&env, &implicit, prize, None, Gas::from_tgas(100)).await?)?;
    assert!(r.json::<bool>()?, "the token paid the implicit account");
    assert_eq!(token_balance(&env, &implicit_id).await?, prize);
    assert_conserved(&env, &[&implicit_id]).await?;
    Ok(())
}

/// Only an allowlisted token credits a vault. A token contract that is not on the list gets the
/// whole amount back from `ft_on_transfer`, so its token refunds the sender, and an account that
/// calls `ft_on_transfer` itself, posing as a token, is answered with the whole amount and
/// credited nothing.
#[tokio::test]
async fn forged_token_cannot_credit() -> anyhow::Result<()> {
    let env = setup(5).await?;
    // A second token contract, built from the same code as the real one, that nobody allowlisted.
    let forged = new_account(&env, "forged")
        .await?
        .deploy(&std::fs::read(TOKEN_WASM)?)
        .await?
        .into_result()?;
    done(
        forged
            .call("new")
            .args_json(json!({ "owner_id": forged.id(), "total_supply": "0" }))
            .transact()
            .await?,
    )?;
    for who in [env.alice.clone(), env.tender.as_account().clone()] {
        done_clean(
            who.call(forged.id(), "storage_deposit")
                .args_json(json!({}))
                .deposit(NearToken::from_millinear(10))
                .max_gas()
                .transact()
                .await?,
        )?;
    }
    done(
        forged
            .call("mint")
            .args_json(json!({ "account_id": env.alice.id(), "amount": "1000000" }))
            .max_gas()
            .transact()
            .await?,
    )?;
    let before = stored(&env).await?;

    // alice sends forged tokens to Tender, for herself and for bob.
    for msg in [String::new(), json!({ "for": env.bob.id() }).to_string()] {
        let r = env
            .alice
            .call(forged.id(), "ft_transfer_call")
            .args_json(json!({
                "receiver_id": env.tender.id(),
                "amount": "1000000",
                "msg": msg,
            }))
            .deposit(ONE_YOCTO)
            .max_gas()
            .transact()
            .await?;
        let r = clean(r)?;
        // The forged token reports that Tender used none of it, and refunded alice.
        assert_eq!(r.clone().json::<String>()?, "0", "msg {msg:?}");
        assert!(events(&r).is_empty(), "Tender logged {:?}", events(&r));
        let held = |who: &AccountId| json!({ "account_id": who });
        let alice_held = view(&forged, "ft_balance_of", held(env.alice.id())).await?;
        let tender_held = view(&forged, "ft_balance_of", held(env.tender.id())).await?;
        assert_eq!((num(&alice_held), num(&tender_held)), (1_000_000, 0));
    }

    // carol calls `ft_on_transfer` herself, as if she were a token, for alice and for herself.
    for sender in [&env.alice, &env.carol] {
        let r = call(
            &env,
            &env.carol,
            "ft_on_transfer",
            json!({ "sender_id": sender.id(), "amount": "1000000", "msg": "" }),
            NO_DEPOSIT,
        )
        .await?;
        let r = clean(r)?;
        assert_eq!(
            r.clone().json::<String>()?,
            "1000000",
            "the whole amount is unused"
        );
        assert!(events(&r).is_empty());
    }

    // Nothing reached a vault, in either token, and Tender's storage did not change.
    assert!(
        stored(&env).await? == before,
        "a forged deposit changed storage"
    );
    for who in [&env.alice, &env.bob, &env.carol] {
        assert_eq!(vault_balance(&env, who.id()).await?, 0);
        let v = view(
            &env.tender,
            "balance_of",
            json!({ "account_id": who.id(), "token": forged.id() }),
        )
        .await?;
        assert_eq!(num(&v), 0);
    }
    assert_conserved(&env, &[]).await?;
    Ok(())
}

/// A settled task takes no entries: nobody can commit to it, whether it entered before or not.
#[tokio::test]
async fn commit_after_settlement_rejected() -> anyhow::Result<()> {
    let env = setup(5).await?;
    let (id, task) = post_judged(&env, REWARD, 1).await?;
    enter_and_reveal(&env, id, &task, &[&env.alice]).await?;
    advance_to(&env, deadline(&task, "reveal_deadline")).await?;
    done_clean(pick(&env, &env.judge, id, vec![winner(&env.alice, 10_000)]).await?)?;
    assert_eq!(get_task(&env, id).await?["phase"], "settled");

    let before = stored(&env).await?;
    let refused = format!("E_PHASE: task {id} is not open for commits");
    for who in [&env.bob, &env.alice] {
        let sealed = seal(id, who.id(), b"late work");
        let r = commit_call(&env, who, id, &sealed).await?;
        assert_refused(&env, &r, &refused, &before).await?;
    }
    assert_eq!(get_task(&env, id).await?["commit_count"], 1);
    assert!(get_entry(&env, id, env.bob.id()).await?.is_null());
    Ok(())
}

/// `cleanup` is anyone's to call and safe to repeat: once a task's entries are gone, another call
/// does nothing at all, not even a write, and refunds nobody twice. Nor can it run early.
#[tokio::test]
async fn cleanup_twice_is_harmless() -> anyhow::Result<()> {
    let env = setup(5).await?;
    let (id, task) = post_judged(&env, REWARD, 1).await?;
    enter_and_reveal(&env, id, &task, &[&env.alice, &env.bob]).await?;

    // Before the task settles, cleanup is refused.
    let before = stored(&env).await?;
    let r = cleanup(&env, &env.carol, id, 50).await?;
    assert_fails_with(&r, "E_PHASE: not settled");
    assert!(stored(&env).await? == before);

    advance_to(&env, deadline(&task, "reveal_deadline")).await?;
    done_clean(pick(&env, &env.judge, id, vec![winner(&env.alice, 10_000)]).await?)?;
    let r = clean(cleanup(&env, &env.carol, id, 50).await?)?;
    assert_eq!(r.json::<u32>()?, 2);
    let after_first = stored(&env).await?;
    let alice_used = storage_used(&env, env.alice.id()).await?;
    let bob_used = storage_used(&env, env.bob.id()).await?;

    // Again, by anyone, with any limit: nothing to do, and nothing changes.
    for (who, limit) in [(&env.carol, 50), (&env.alice, 1), (&env.judge, 50)] {
        let r = clean(cleanup(&env, who, id, limit).await?)?;
        assert_eq!(r.json::<u32>()?, 0);
        assert!(
            stored(&env).await? == after_first,
            "a repeated cleanup changed storage"
        );
    }
    assert_eq!(storage_used(&env, env.alice.id()).await?, alice_used);
    assert_eq!(storage_used(&env, env.bob.id()).await?, bob_used);
    assert_eq!(get_task(&env, id).await?["cleaned"], 2);
    assert_conserved(&env, &[]).await?;
    Ok(())
}

/// A withdrawal of more than the vault holds fails in the first receipt, before any transfer is
/// scheduled: no token moves and no balance changes. Nor can an account without a slot, or one
/// asking for a token it never deposited, take anything out.
#[tokio::test]
async fn withdraw_more_than_balance_rejected() -> anyhow::Result<()> {
    let env = setup(5).await?;
    deposit(&env, &env.alice, 1_000).await?;
    let alice_tokens = token_balance(&env, env.alice.id()).await?;
    let tender_tokens = token_balance(&env, env.tender.id()).await?;
    let before = stored(&env).await?;
    let refused = "E_FUNDS: insufficient vault balance";
    for amount in [1_001, u128::MAX] {
        let r = withdraw(&env, &env.alice, amount, None, Gas::from_tgas(100)).await?;
        assert_refused(&env, &r, refused, &before).await?;
    }
    // bob has no slot for the token at all.
    let r = withdraw(&env, &env.bob, 1, None, Gas::from_tgas(100)).await?;
    assert_refused(&env, &r, refused, &before).await?;
    // alice names a token she holds none of.
    let r = env
        .alice
        .call(env.tender.id(), "withdraw")
        .args_json(json!({ "token": env.judge.id(), "amount": "1" }))
        .deposit(ONE_YOCTO)
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    assert_refused(&env, &r, refused, &before).await?;

    assert_eq!(token_balance(&env, env.alice.id()).await?, alice_tokens);
    assert_eq!(token_balance(&env, env.tender.id()).await?, tender_tokens);
    // All of it still comes out.
    done_clean(withdraw(&env, &env.alice, 1_000, None, Gas::from_tgas(100)).await?)?;
    assert_eq!(vault_balance(&env, env.alice.id()).await?, 0);
    assert_eq!(
        token_balance(&env, env.alice.id()).await?,
        alice_tokens + 1_000
    );
    assert_conserved(&env, &[]).await?;
    Ok(())
}

/// Spec 6.10's reveal attacks. A commitment binds the task and the account, so copying another
/// entrant's commitment gains nothing; a wrong salt does not open a commitment; an entry is
/// revealed once; and a reveal after the reveal window is refused.
#[tokio::test]
async fn reveal_attacks_rejected() -> anyhow::Result<()> {
    let env = setup(5).await?;
    let (id, task) = post_judged(&env, REWARD, 1).await?;
    let (hash, salt) = commit_work(&env, &env.alice, id, b"alice's work").await?;
    // bob copies alice's commitment from her `committed` event.
    let copied = get_entry(&env, id, env.alice.id()).await?["commitment"]
        .as_str()
        .expect("a commitment")
        .to_string();
    done_clean(commit_raw(&env, &env.bob, id, &copied).await?)?;
    advance_to(&env, deadline(&task, "commit_deadline")).await?;

    let mismatch = "E_COMMITMENT: content_hash and salt do not match the commitment";
    let before = stored(&env).await?;
    // bob reveals alice's work with alice's salt: the commitment was hers, with her name in it.
    let r = reveal(&env, &env.bob, id, &hash, &salt, "ipfs://alice").await?;
    assert_refused(&env, &r, mismatch, &before).await?;
    // alice with a wrong salt, and with the right salt but other content.
    let r = reveal(
        &env,
        &env.alice,
        id,
        &hash,
        &sha256(b"wrong"),
        "ipfs://alice",
    )
    .await?;
    assert_refused(&env, &r, mismatch, &before).await?;
    let r = reveal(
        &env,
        &env.alice,
        id,
        &sha256(b"other"),
        &salt,
        "ipfs://alice",
    )
    .await?;
    assert_refused(&env, &r, mismatch, &before).await?;

    done_clean(reveal(&env, &env.alice, id, &hash, &salt, "ipfs://alice").await?)?;
    let before = stored(&env).await?;
    let r = reveal(&env, &env.alice, id, &hash, &salt, "ipfs://elsewhere").await?;
    assert_refused(
        &env,
        &r,
        &format!(
            "E_REVEALED: {} has already revealed in task {id}",
            env.alice.id()
        ),
        &before,
    )
    .await?;

    advance_to(&env, deadline(&task, "reveal_deadline")).await?;
    let r = reveal(&env, &env.bob, id, &hash, &salt, "ipfs://bob").await?;
    assert_refused(
        &env,
        &r,
        &format!("E_PHASE: task {id} is not in its reveal window"),
        &before,
    )
    .await?;
    let task = get_task(&env, id).await?;
    assert_eq!(
        (task["commit_count"].clone(), task["reveal_count"].clone()),
        (json!(2), json!(1))
    );
    // bob's copied entry never revealed, so it cannot win.
    let r = pick(&env, &env.judge, id, vec![winner(&env.bob, 10_000)]).await?;
    assert_fails_with(&r, "E_WINNERS: ");
    done_clean(pick(&env, &env.judge, id, vec![winner(&env.alice, 10_000)]).await?)?;
    assert_conserved(&env, &[]).await?;
    Ok(())
}

/// A new funder pays for its funder record out of its storage balance. With nothing to spare, its
/// first top-up is refused `E_STORAGE` and, on a runtime that reverts a failed receipt, nothing
/// changes: not the task, not its vault (Task 13 review, minor 3). With storage, it goes through.
#[tokio::test]
async fn new_funder_without_storage_is_refused_and_nothing_changes() -> anyhow::Result<()> {
    let env = setup(5).await?;
    let (id, _) = post_judged(&env, REWARD, 1).await?;
    let dave = new_account(&env, "dave").await?;
    storage_deposit(&env, &dave, STORAGE).await?;
    deposit_for(&env, &env.poster, dave.id(), REWARD).await?;
    // dave takes back every yoctoNEAR of storage balance it is not using.
    let r = clean(call(&env, &dave, "storage_withdraw", json!({}), ONE_YOCTO).await?)?;
    assert_eq!(r.json::<Value>()?["available"], "0");

    let before = stored(&env).await?;
    let r = call(
        &env,
        &dave,
        "top_up_task",
        json!({ "task_id": id.to_string(), "amount": REWARD.to_string() }),
        ONE_YOCTO,
    )
    .await?;
    assert_refused(
        &env,
        &r,
        "E_STORAGE: insufficient storage balance; call storage_deposit",
        &before,
    )
    .await?;
    assert_eq!(vault_balance(&env, dave.id()).await?, REWARD);
    assert_eq!(
        get_task(&env, id).await?["funders"]
            .as_array()
            .map(Vec::len),
        Some(1)
    );

    storage_deposit(&env, &dave, NearToken::from_millinear(10)).await?;
    done_clean(
        call(
            &env,
            &dave,
            "top_up_task",
            json!({ "task_id": id.to_string(), "amount": REWARD.to_string() }),
            ONE_YOCTO,
        )
        .await?,
    )?;
    assert_eq!(num(&get_task(&env, id).await?["reward"]), 2 * REWARD);
    assert_conserved(&env, &[dave.id()]).await?;
    Ok(())
}

/// The P05-R21 capture case (Task 16b): 49 cheap accounts take the places that the Judge grades
/// on an open rubric task, so a real entrant is crowded out. An open task now takes entries only
/// from active registered agents, and with a bond set, registering costs the bond, so 49 fillers
/// need 49 bonds. These have none: every filler is refused, both its entry and its registration,
/// nothing changes, and an agent still enters.
#[tokio::test]
async fn forty_nine_unbonded_fillers_refused() -> anyhow::Result<()> {
    let env = setup(5).await?;
    let bond = json!({ "token": env.token.id(), "amount": REWARD.to_string() });
    done_clean(call(&env, &env.owner, "set_agent_bond", bond, ONE_YOCTO).await?)?;
    let (id, _) = post_judged(&env, REWARD, 1).await?;
    // Each filler has 1 NEAR, so its calls prepay 30 Tgas (`light_call`), not 300.
    let fillers = create_entrants(&env, 49, 1).await?;
    all(fillers
        .iter()
        .map(|who| {
            let (env, who) = (env.clone(), who.clone());
            async move { done(light_call(&env, &who, "storage_deposit", json!({}), STORAGE).await?) }
        })
        .collect())
    .await?;

    let before = stored(&env).await?;
    let commits = all(fillers
        .iter()
        .map(|who| {
            let (env, who) = (env.clone(), who.clone());
            async move {
                let args = commit_args(id, who.id(), &seal(id, who.id(), b"filler"));
                light_call(&env, &who, "commit", args, NO_DEPOSIT).await
            }
        })
        .collect())
    .await?;
    let registrations = all(fillers
        .iter()
        .map(|who| {
            let (env, who) = (env.clone(), who.clone());
            async move {
                let profile = json!({
                    "profile_uri": "ipfs://filler",
                    "profile_hash": hex(&sha256(who.id().as_bytes())),
                    "tags": [],
                });
                light_call(&env, &who, "register_agent", profile, ONE_YOCTO).await
            }
        })
        .collect())
    .await?;
    for r in &commits {
        assert_fails_with(
            r,
            "E_NOT_REGISTERED: open tasks take entries only from registered agents",
        );
        assert!(events(r).is_empty(), "a refusal logged {:?}", events(r));
    }
    for r in &registrations {
        assert_fails_with(r, "E_FUNDS: insufficient vault balance");
    }
    assert!(
        stored(&env).await? == before,
        "49 refused fillers changed Tender's storage"
    );
    assert_eq!(get_task(&env, id).await?["commit_count"], 0);

    // alice, registered before the bond was set, is an active agent, and enters.
    commit_work(&env, &env.alice, id, b"alice's work").await?;
    assert_eq!(get_task(&env, id).await?["commit_count"], 1);
    assert_conserved(&env, &[]).await?;
    Ok(())
}
