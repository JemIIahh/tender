//! The contract refuses what it does not understand.
//!
//! Every setter and every task method carries `#[deny_unknown_arguments]`. A key that is misspelled
//! or sits in the wrong place fails the whole call, where serde would drop it and the call would
//! run with a default that nobody chose. A method that is not `#[payable]` refuses attached NEAR.
//! Both come from the wrappers that near-sdk generates, so they are tested on the built wasm.
//!
//! Each refusal is followed by the same call made properly, which goes through and changes what the
//! refused one would have changed. So a refusal cannot be a world that refuses everything, and
//! "nothing changed" cannot be a call that would have changed nothing anyway.
//!
//! The NEP-145 storage methods are the other way round: they take the standard's arguments, and
//! keep its rules.

mod common;

use common::*;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId};
use serde_json::{json, Value};

/// The key that `assert_refuses_unknown_key` adds. No method has an argument of this name.
const UNKNOWN: &str = "unexpected";

/// `args` with one more key at the top level.
fn with_unknown_key(args: &Value) -> Value {
    let mut args = args.clone();
    args.as_object_mut()
        .expect("the arguments are an object")
        .insert(UNKNOWN.to_string(), json!(true));
    args
}

/// Calls `method` with `args` as given, which must fail in the generated wrapper, naming
/// `key` as an unknown field, and must leave Tender's storage as it was.
async fn assert_refuses_args(
    env: &Env,
    who: &Account,
    method: &str,
    args: &Value,
    deposit: NearToken,
    key: &str,
) -> anyhow::Result<()> {
    let before = stored(env).await?;
    let r = call(env, who, method, args.clone(), deposit).await?;
    assert_fails_with(&r, "Failed to deserialize input from JSON");
    assert_fails_with(&r, &format!("unknown field `{key}`"));
    assert!(
        stored(env).await? == before,
        "{method}: a refused call changed Tender's storage"
    );
    Ok(())
}

/// `assert_refuses_args` for `args` plus one top-level key that no method has.
async fn assert_refuses_unknown_key(
    env: &Env,
    who: &Account,
    method: &str,
    args: &Value,
    deposit: NearToken,
) -> anyhow::Result<()> {
    assert_refuses_args(env, who, method, &with_unknown_key(args), deposit, UNKNOWN).await
}

/// Calls the method that is not `#[payable]` with 1 yoctoNEAR, which must fail before the
/// arguments are read, and must leave Tender's storage as it was.
async fn assert_refuses_deposit(
    env: &Env,
    who: &Account,
    method: &str,
    args: &Value,
) -> anyhow::Result<()> {
    let before = stored(env).await?;
    let r = call(env, who, method, args.clone(), ONE_YOCTO).await?;
    assert_fails_with(&r, &format!("Method {method} doesn't accept deposit"));
    assert!(
        stored(env).await? == before,
        "{method}: a refused deposit changed Tender's storage"
    );
    Ok(())
}

async fn config(env: &Env) -> anyhow::Result<Value> {
    view(&env.tender, "get_config", json!({})).await
}

async fn task_count(env: &Env) -> anyhow::Result<u128> {
    Ok(num(&view(&env.tender, "task_count", json!({})).await?))
}

/// The owner's setters, each with one key too many. `accept_owner` is left out: it takes no
/// arguments, so the generated wrapper never reads any and has nothing to refuse.
#[tokio::test]
async fn owner_setters_refuse_an_unknown_argument() -> anyhow::Result<()> {
    let env = setup(5).await?;
    let owner = &env.owner;
    let start = config(&env).await?;
    assert_eq!(start["fee_bps"], 500);
    assert_eq!(start["min_window_secs"], 5);
    assert_eq!(start["paused"], false);
    assert!(start["pending_owner"].is_null());
    assert_eq!(start["tokens"][0]["min_reward"], "1");

    // Each setter gets a value that differs from the current one.
    let fee = json!({ "fee_bps": 300, "treasury": env.treasury.id() });
    let window = json!({ "min_window_secs": 7 });
    let token = json!({
        "token": env.token.id(),
        "min_reward": "2",
        "max_reward": "5000000000000",
        "enabled": true,
    });
    let pause = json!({ "paused": true });
    let propose = json!({ "new_owner": env.carol.id() });

    for (method, args) in [
        ("set_fee", &fee),
        ("set_min_window", &window),
        ("set_token", &token),
        ("set_paused", &pause),
        ("propose_owner", &propose),
    ] {
        assert_refuses_unknown_key(&env, owner, method, args, ONE_YOCTO).await?;
        assert_eq!(
            config(&env).await?,
            start,
            "{method}: a refused call changed the configuration"
        );
    }

    // Without the extra key the same five calls go through, and each changes what it names.
    for (method, args) in [
        ("set_fee", &fee),
        ("set_min_window", &window),
        ("set_token", &token),
        ("set_paused", &pause),
        ("propose_owner", &propose),
    ] {
        done_clean(call(&env, owner, method, args.clone(), ONE_YOCTO).await?)?;
    }
    let end = config(&env).await?;
    assert_eq!(end["fee_bps"], 300);
    assert_eq!(end["min_window_secs"], 7);
    assert_eq!(end["tokens"][0]["min_reward"], "2");
    assert_eq!(end["tokens"][0]["max_reward"], "5000000000000");
    assert_eq!(end["paused"], true);
    assert_eq!(end["pending_owner"], env.carol.id().as_str());
    Ok(())
}

/// The methods that move money or settle a task, taken through one task's life. At each stage the
/// call is first sent with a key too many, and where the method is not `#[payable]` with 1 yocto,
/// and then as it should be.
#[tokio::test]
async fn task_methods_refuse_an_unknown_argument_and_a_deposit() -> anyhow::Result<()> {
    let env = setup(5).await?;
    let (poster, judge, alice, carol) = (&env.poster, &env.judge, &env.alice, &env.carol);

    // register_agent
    let profile = json!({
        "profile_uri": "ipfs://alice",
        "profile_hash": hex(&sha256(b"alice")),
        "tags": ["rust"],
    });
    let agent = || {
        view(
            &env.tender,
            "get_agent",
            json!({ "account_id": alice.id() }),
        )
    };
    // alice registered in `setup`; this call would replace her profile.
    let before = agent().await?;
    assert_refuses_unknown_key(&env, alice, "register_agent", &profile, ONE_YOCTO).await?;
    assert_eq!(agent().await?, before);
    done_clean(call(&env, alice, "register_agent", profile, ONE_YOCTO).await?)?;
    assert_eq!(agent().await?["profile_uri"], "ipfs://alice");

    // post_task: two tasks, so that one can be picked and the other voided.
    deposit(&env, poster, 2 * REWARD).await?;
    let task = task_json(&env, REWARD, judge.id(), 1);
    let post_args = json!({ "task": task });
    assert_refuses_unknown_key(&env, poster, "post_task", &post_args, ONE_YOCTO).await?;
    assert_eq!(task_count(&env).await?, 0);
    assert_eq!(vault_balance(&env, poster.id()).await?, 2 * REWARD);
    let first = post(&env, poster, task.clone()).await?;
    let second = post(&env, poster, task).await?;
    assert_eq!(task_count(&env).await?, 2);

    // withdraw
    deposit(&env, alice, 1_000).await?;
    let withdrawal = json!({ "token": env.token.id(), "amount": "400" });
    assert_refuses_unknown_key(&env, alice, "withdraw", &withdrawal, ONE_YOCTO).await?;
    assert_eq!(vault_balance(&env, alice.id()).await?, 1_000);
    done_clean(call(&env, alice, "withdraw", withdrawal, ONE_YOCTO).await?)?;
    assert_eq!(vault_balance(&env, alice.id()).await?, 600);

    // top_up_task, by alice into the first task while it is open. Like post_task it spends from
    // the vault, so it takes 1 yocto.
    let top_up = json!({ "task_id": first.to_string(), "amount": "100" });
    assert_refuses_unknown_key(&env, alice, "top_up_task", &top_up, ONE_YOCTO).await?;
    assert_eq!(num(&get_task(&env, first).await?["reward"]), REWARD);
    assert_eq!(vault_balance(&env, alice.id()).await?, 600);
    done_clean(call(&env, alice, "top_up_task", top_up, ONE_YOCTO).await?)?;
    assert_eq!(num(&get_task(&env, first).await?["reward"]), REWARD + 100);
    assert_eq!(vault_balance(&env, alice.id()).await?, 500);

    // commit
    let sealed = seal(first, alice.id(), b"alice's work");
    let commitment = commitment_of(
        first,
        alice.id().as_str(),
        &sealed.content_hash,
        &sealed.salt,
    );
    let commit = json!({ "task_id": first.to_string(), "commitment": hex(&commitment) });
    assert_refuses_unknown_key(&env, alice, "commit", &commit, NO_DEPOSIT).await?;
    assert_refuses_deposit(&env, alice, "commit", &commit).await?;
    assert!(get_entry(&env, first, alice.id()).await?.is_null());
    done_clean(call(&env, alice, "commit", commit, NO_DEPOSIT).await?)?;
    assert!(!get_entry(&env, first, alice.id()).await?.is_null());

    // reveal
    let task_one = get_task(&env, first).await?;
    advance_to(&env, deadline(&task_one, "commit_deadline")).await?;
    let reveal_args = json!({
        "task_id": first.to_string(),
        "content_hash": hex(&sealed.content_hash),
        "salt": hex(&sealed.salt),
        "uri": "ipfs://alice-work",
    });
    assert_refuses_unknown_key(&env, alice, "reveal", &reveal_args, NO_DEPOSIT).await?;
    assert_refuses_deposit(&env, alice, "reveal", &reveal_args).await?;
    assert!(get_entry(&env, first, alice.id()).await?["content_hash"].is_null());
    done_clean(call(&env, alice, "reveal", reveal_args, NO_DEPOSIT).await?)?;
    assert_eq!(
        get_entry(&env, first, alice.id()).await?["content_hash"],
        hex(&sealed.content_hash)
    );

    // pick, by the verifier. A winner is a struct of its own that refuses an unknown key too.
    advance_to(&env, deadline(&task_one, "reveal_deadline")).await?;
    let pick_args = |winners: Vec<Value>| {
        json!({
            "task_id": first.to_string(),
            "winners": winners,
            "scorecard_hash": hex(&sha256(b"scorecard")),
            "scorecard_uri": "ipfs://scorecard",
        })
    };
    let good = pick_args(vec![winner(alice, 10_000)]);
    assert_refuses_unknown_key(&env, judge, "pick", &good, NO_DEPOSIT).await?;
    assert_refuses_deposit(&env, judge, "pick", &good).await?;
    let amount_beside_bps = pick_args(vec![json!({
        "account": alice.id(),
        "bps": 10_000,
        "amount": "1",
    })]);
    assert_refuses_args(
        &env,
        judge,
        "pick",
        &amount_beside_bps,
        NO_DEPOSIT,
        "amount",
    )
    .await?;
    assert_eq!(get_task(&env, first).await?["phase"], "judging");
    done_clean(call(&env, judge, "pick", good, NO_DEPOSIT).await?)?;
    assert_eq!(get_task(&env, first).await?["phase"], "settled");

    // void_task, on the task that nobody entered
    let task_two = get_task(&env, second).await?;
    advance_to(&env, deadline(&task_two, "reveal_deadline")).await?;
    let void_args = json!({ "task_id": second.to_string() });
    assert_refuses_unknown_key(&env, carol, "void_task", &void_args, NO_DEPOSIT).await?;
    assert_refuses_deposit(&env, carol, "void_task", &void_args).await?;
    assert_ne!(get_task(&env, second).await?["phase"], "settled");
    done_clean(call(&env, carol, "void_task", void_args, NO_DEPOSIT).await?)?;
    assert_eq!(get_task(&env, second).await?["phase"], "settled");

    // cleanup, of the entry that the first task left behind
    let cleanup_args = json!({ "task_id": first.to_string(), "limit": 50 });
    assert_refuses_unknown_key(&env, carol, "cleanup", &cleanup_args, NO_DEPOSIT).await?;
    assert_refuses_deposit(&env, carol, "cleanup", &cleanup_args).await?;
    assert!(!get_entry(&env, first, alice.id()).await?.is_null());
    let r = clean(call(&env, carol, "cleanup", cleanup_args, NO_DEPOSIT).await?)?;
    assert_eq!(r.json::<u32>()?, 1);
    assert!(get_entry(&env, first, alice.id()).await?.is_null());

    assert_conserved(&env, &[]).await?;
    Ok(())
}

/// The two ways of getting `verifier` wrong. Both would otherwise post the task with the poster as
/// its verifier, because the argument is optional, and a posted task cannot be changed.
#[tokio::test]
async fn post_task_refuses_a_misplaced_or_misspelled_verifier() -> anyhow::Result<()> {
    let env = setup(5).await?;
    deposit(&env, &env.poster, REWARD).await?;
    let task_without_verifier = || {
        let mut task = task_json(&env, REWARD, env.judge.id(), 1);
        task.as_object_mut()
            .expect("a task is an object")
            .remove("verifier");
        task
    };

    // `verifier` beside `task`, where it is not an argument of `post_task`.
    let beside = json!({ "task": task_without_verifier(), "verifier": env.judge.id() });
    assert_refuses_args(
        &env,
        &env.poster,
        "post_task",
        &beside,
        ONE_YOCTO,
        "verifier",
    )
    .await?;

    // `verifer` inside `task`.
    let mut misspelled = task_without_verifier();
    misspelled["verifer"] = json!(env.judge.id());
    let misspelled = json!({ "task": misspelled });
    assert_refuses_args(
        &env,
        &env.poster,
        "post_task",
        &misspelled,
        ONE_YOCTO,
        "verifer",
    )
    .await?;

    assert_eq!(task_count(&env).await?, 0);
    assert_eq!(vault_balance(&env, env.poster.id()).await?, REWARD);

    // Spelled right and in the right place, the verifier is the judge.
    let mut right = task_without_verifier();
    right["verifier"] = json!(env.judge.id());
    let id = post(&env, &env.poster, right).await?;
    assert_eq!(task_count(&env).await?, 1);
    assert_eq!(
        get_task(&env, id).await?["verifier"],
        env.judge.id().as_str()
    );
    Ok(())
}

/// What `who` holds in NEAR.
async fn near_balance(env: &Env, who: &AccountId) -> anyhow::Result<u128> {
    Ok(env.worker.view_account(who).await?.balance.as_yoctonear())
}

/// `who`'s `storage_deposit` with `args` and `deposit` attached, which must succeed, and how much
/// NEAR it took from `who`: the deposit that was kept, and gas. It attaches 30 Tgas, so the gas is
/// small beside a deposit of 1 NEAR.
async fn storage_deposit_paid(
    env: &Env,
    who: &Account,
    args: Value,
    deposit: NearToken,
) -> anyhow::Result<(ExecutionFinalResult, u128)> {
    let before = near_balance(env, who.id()).await?;
    let r = who
        .call(env.tender.id(), "storage_deposit")
        .args_json(args)
        .deposit(deposit)
        .gas(Gas::from_tgas(30))
        .transact()
        .await?;
    let r = clean(r)?;
    Ok((r, before - near_balance(env, who.id()).await?))
}

/// `storage_balance_bounds` is NEP-145's view of the least a first deposit must be, and on the real
/// node that is the floor: one yocto less does not register a new account, and `min` does.
#[tokio::test]
async fn storage_balance_bounds_is_the_registration_floor() -> anyhow::Result<()> {
    let env = setup(5).await?;
    let bounds = view(&env.tender, "storage_balance_bounds", json!({})).await?;
    assert_eq!(
        bounds,
        json!({ "min": "10000000000000000000000", "max": null })
    );
    let min = num(&bounds["min"]);
    let dave = new_account(&env, "dave").await?;
    let balance_of = || {
        view(
            &env.tender,
            "storage_balance_of",
            json!({ "account_id": dave.id() }),
        )
    };

    let short = NearToken::from_yoctonear(min - 1);
    let r = call(&env, &dave, "storage_deposit", json!({}), short).await?;
    assert_fails_with(&r, "E_STORAGE: a first deposit must be at least");
    assert!(balance_of().await?.is_null());

    let exact = NearToken::from_yoctonear(min);
    let r = clean(call(&env, &dave, "storage_deposit", json!({}), exact).await?)?;
    assert_eq!(num(&r.json::<Value>()?["total"]), min);
    assert_eq!(num(&balance_of().await?["total"]), min);
    Ok(())
}

/// `storage_deposit` is NEP-145 and does not deny unknown arguments, because a client written for
/// any NEP-145 contract may send the standard's. It takes `registration_only` as the standard has
/// it: a new account is registered with exactly `storage_balance_bounds().min` and the rest of the
/// deposit goes back to the caller, and a registered account is credited nothing and gets the
/// whole deposit back. Without the flag, all of it is credited. The refunds show in the callers'
/// NEAR balances, which otherwise pay only for gas, far less than the 1 NEAR sent each time.
#[tokio::test]
async fn storage_deposit_follows_nep145_registration_only() -> anyhow::Result<()> {
    let env = setup(5).await?;
    let dave = new_account(&env, "dave").await?;
    let erin = new_account(&env, "erin").await?;
    let frank = new_account(&env, "frank").await?;
    let min = num(&view(&env.tender, "storage_balance_bounds", json!({})).await?["min"]);
    let amount = NearToken::from_near(1);
    // More than the gas of any of these calls, and a tenth of the deposit.
    let gas = amount.as_yoctonear() / 10;

    // dave registers himself with the flag: he is credited the minimum and pays only that.
    let flag = json!({ "registration_only": true });
    let (r, paid) = storage_deposit_paid(&env, &dave, flag.clone(), amount).await?;
    assert_eq!(num(&r.clone().json::<Value>()?["total"]), min);
    assert_eq!(event(&r, "storage_deposit")["amount"], min.to_string());
    assert!(paid > min && paid < min + gas, "dave paid {paid}");

    // erin sends as much without the flag, and all of it is credited.
    let (r, paid) = storage_deposit_paid(&env, &erin, json!({}), amount).await?;
    assert_eq!(num(&r.json::<Value>()?["total"]), amount.as_yoctonear());
    assert!(
        paid > amount.as_yoctonear() && paid < amount.as_yoctonear() + gas,
        "erin paid {paid}"
    );

    // dave asks again, registered now: nothing is credited, all of it comes back, and no event.
    let (r, paid) = storage_deposit_paid(&env, &dave, flag, amount).await?;
    assert_eq!(num(&r.clone().json::<Value>()?["total"]), min);
    assert!(events(&r).is_empty(), "{:?}", r.logs());
    assert!(paid < gas, "dave paid {paid}");

    // For another account, with the flag beside `account_id`: frank is registered with the
    // minimum, and the rest goes back to alice, who sent it.
    let args = json!({ "account_id": frank.id(), "registration_only": true });
    let (r, paid) = storage_deposit_paid(&env, &env.alice, args, amount).await?;
    assert_eq!(num(&r.json::<Value>()?["total"]), min);
    assert!(paid > min && paid < min + gas, "alice paid {paid}");
    let registered = view(
        &env.tender,
        "storage_balance_of",
        json!({ "account_id": frank.id() }),
    )
    .await?;
    assert_eq!(num(&registered["total"]), min);
    Ok(())
}
