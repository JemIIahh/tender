//! The agent registration bond on the built wasm (plan 01 Task 16b, owner decision 2026-11-03).
//!
//! Once the owner sets a bond, registering takes it from the agent's vault, and an open task takes
//! entries only from active registered agents. An agent leaves by unregistering, waits out the
//! cooldown and claims its bond back, exactly as it paid it.

mod common;

use common::*;
use near_workspaces::types::NearToken;
use near_workspaces::Account;
use serde_json::json;

/// The bond the owner sets: 2 test tokens.
const BOND: u128 = 2_000_000;
/// The cooldown the owner sets, in seconds: as short as the sandbox's shortest window allows.
const COOLDOWN_SECS: u64 = 5;
/// The storage balance each newcomer starts with at Tender.
const STORAGE: NearToken = NearToken::from_millinear(100);

/// The owner sets a bond of `BOND` in the test token and a cooldown of `COOLDOWN_SECS`.
async fn set_bond(env: &Env) -> anyhow::Result<()> {
    let bond = json!({ "token": env.token.id(), "amount": BOND.to_string() });
    done_clean(call(env, &env.owner, "set_agent_bond", bond, ONE_YOCTO).await?)?;
    let cooldown = json!({ "secs": COOLDOWN_SECS.to_string() });
    done_clean(
        call(
            env,
            &env.owner,
            "set_agent_bond_cooldown",
            cooldown,
            ONE_YOCTO,
        )
        .await?,
    )?;
    Ok(())
}

/// `count` new accounts with 1 NEAR each, a storage balance at Tender and nothing in the vault.
/// Their calls prepay 30 Tgas (`light_call`), which 1 NEAR covers.
async fn fillers(env: &Env, count: usize) -> anyhow::Result<Vec<Account>> {
    let made = create_entrants(env, count, 1).await?;
    all(made
        .iter()
        .map(|who| {
            let (env, who) = (env.clone(), who.clone());
            async move { done(light_call(&env, &who, "storage_deposit", json!({}), STORAGE).await?) }
        })
        .collect())
    .await?;
    Ok(made)
}

/// Unregistered accounts are refused an open task, and cannot register without the bond. A bonded
/// agent enters, wins and is paid; then it unregisters, waits out the cooldown and claims, and its
/// vault is back where it was before it registered, plus what it won.
#[tokio::test]
async fn fillers_without_bonds_cannot_enter_open_task() -> anyhow::Result<()> {
    let env = setup(5).await?;
    set_bond(&env).await?;
    let config = view(&env.tender, "get_config", json!({})).await?;
    assert_eq!(config["agent_bond_token"], env.token.id().as_str());
    assert_eq!(config["agent_bond_amount"], BOND.to_string());
    assert_eq!(
        config["agent_bond_cooldown_secs"],
        COOLDOWN_SECS.to_string()
    );

    deposit(&env, &env.poster, REWARD).await?;
    let id = post(
        &env,
        &env.poster,
        task_json(&env, REWARD, env.judge.id(), 1),
    )
    .await?;
    let task = get_task(&env, id).await?;
    assert!(
        task["invited"].as_array().is_some_and(Vec::is_empty),
        "an open task"
    );

    // Five accounts with storage and no bond. None of them gets in, and none can register.
    let crowd = fillers(&env, 5).await?;
    let before = stored(&env).await?;
    for filler in &crowd {
        let args = commit_args(id, filler.id(), &seal(id, filler.id(), b"filler"));
        let r = light_call(&env, filler, "commit", args, NO_DEPOSIT).await?;
        assert_fails_with(
            &r,
            "E_NOT_REGISTERED: open tasks take entries only from registered agents",
        );
        assert!(events(&r).is_empty());
        let r = light_call(
            &env,
            filler,
            "register_agent",
            json!({
                "profile_uri": "ipfs://filler",
                "profile_hash": hex(&sha256(filler.id().as_bytes())),
                "tags": [],
            }),
            ONE_YOCTO,
        )
        .await?;
        assert_fails_with(&r, "E_FUNDS: insufficient vault balance");
    }
    assert!(
        stored(&env).await? == before,
        "the refusals changed nothing"
    );
    assert_eq!(get_task(&env, id).await?["commit_count"], 0);

    // dave holds the bond and a little more, and registers with it.
    let dave = new_account(&env, "dave").await?;
    storage_deposit(&env, &dave, STORAGE).await?;
    deposit_for(&env, &env.poster, dave.id(), BOND + 300).await?;
    let start = vault_balance(&env, dave.id()).await?;
    assert_eq!(start, BOND + 300);
    // With the gas the TypeScript client attaches to a registration, which now also moves the
    // bond.
    let r = clean(
        dave.call(env.tender.id(), "register_agent")
            .args_json(json!({
                "profile_uri": "https://agents.example/dave.json",
                "profile_hash": hex(&sha256(b"dave")),
                "tags": ["rust"],
            }))
            .deposit(ONE_YOCTO)
            .gas(REGISTER_AGENT_GAS)
            .transact()
            .await?,
    )?;
    println!(
        "gas: register_agent with a bond burnt {:.2} Tgas",
        r.total_gas_burnt.as_gas() as f64 / 1e12
    );
    let names: Vec<String> = events(&r).into_iter().map(|(name, _)| name).collect();
    assert_eq!(names, ["agent_registered", "agent_bonded"]);
    assert_eq!(
        event(&r, "agent_bonded"),
        json!({ "account": dave.id(), "token": env.token.id(), "amount": BOND.to_string() })
    );
    assert_eq!(vault_balance(&env, dave.id()).await?, 300);
    let agent = view(&env.tender, "get_agent", json!({ "account_id": dave.id() })).await?;
    assert_eq!(agent["status"], "active");
    assert_eq!(agent["bond_amount"], BOND.to_string());
    assert_conserved(&env, &[dave.id()]).await?;

    // dave enters, reveals and wins.
    let (hash, salt) = commit_work(&env, &dave, id, b"dave's work").await?;
    advance_to(&env, deadline(&task, "commit_deadline")).await?;
    done_clean(reveal(&env, &dave, id, &hash, &salt, "ipfs://dave").await?)?;
    advance_to(&env, deadline(&task, "reveal_deadline")).await?;
    done_clean(pick(&env, &env.judge, id, vec![winner(&dave, 10_000)]).await?)?;
    let won = REWARD - fee_of(REWARD);
    assert_eq!(vault_balance(&env, dave.id()).await?, 300 + won);

    // dave leaves. Its bond stays until the cooldown is over, and then comes back in full.
    let r = clean(call(&env, &dave, "unregister_agent", json!({}), ONE_YOCTO).await?)?;
    println!(
        "gas: unregister_agent burnt {:.2} Tgas",
        r.total_gas_burnt.as_gas() as f64 / 1e12
    );
    let claimable_at = num(&event(&r, "agent_unregistering")["claimable_at"]);
    let r = call(&env, &dave, "claim_agent_bond", json!({}), ONE_YOCTO).await?;
    assert_fails_with(&r, "E_PHASE: ");
    assert_eq!(vault_balance(&env, dave.id()).await?, 300 + won);
    advance_to(&env, u64::try_from(claimable_at)?).await?;
    let r = clean(call(&env, &dave, "claim_agent_bond", json!({}), ONE_YOCTO).await?)?;
    println!(
        "gas: claim_agent_bond burnt {:.2} Tgas",
        r.total_gas_burnt.as_gas() as f64 / 1e12
    );
    assert_eq!(
        event(&r, "agent_bond_claimed"),
        json!({ "account": dave.id(), "token": env.token.id(), "amount": BOND.to_string() })
    );
    assert_eq!(vault_balance(&env, dave.id()).await?, start + won);
    let agent = view(&env.tender, "get_agent", json!({ "account_id": dave.id() })).await?;
    assert_eq!(agent["status"], "retired");
    assert!(agent["bond_amount"].is_null());
    assert_eq!(agent["wins"], 1, "the reputation stays");
    // A second claim finds nothing.
    let r = call(&env, &dave, "claim_agent_bond", json!({}), ONE_YOCTO).await?;
    assert_fails_with(&r, "E_NOT_REGISTERED: ");
    assert_conserved(&env, &[dave.id()]).await?;
    Ok(())
}

/// A function-call key, the kind an agent leaves on a server, can neither register, nor
/// unregister, nor claim: each needs exactly 1 yoctoNEAR, and the node refuses a deposit from such
/// a key. The same key still commits for its account, which is an active agent.
#[tokio::test]
async fn function_call_key_cannot_register_unregister_or_claim() -> anyhow::Result<()> {
    let env = setup(5).await?;
    let methods = [
        "register_agent",
        "unregister_agent",
        "claim_agent_bond",
        "commit",
    ];
    let key = function_call_key(&env, &env.alice, &methods).await?;
    let profile = json!({
        "profile_uri": "ipfs://alice-again",
        "profile_hash": hex(&sha256(b"alice again")),
        "tags": [],
    });
    let before = stored(&env).await?;
    for (method, args) in [
        ("register_agent", profile),
        ("unregister_agent", json!({})),
        ("claim_agent_bond", json!({})),
    ] {
        let r = call(&env, &key, method, args, NO_DEPOSIT).await?;
        assert_fails_with(&r, "Requires attached deposit of exactly 1 yoctoNEAR");
    }
    assert!(
        stored(&env).await? == before,
        "the refusals changed nothing"
    );

    deposit(&env, &env.poster, REWARD).await?;
    let id = post(
        &env,
        &env.poster,
        task_json(&env, REWARD, env.judge.id(), 1),
    )
    .await?;
    let r = clean(commit_call(&env, &key, id, &seal(id, env.alice.id(), b"work")).await?)?;
    assert_eq!(event(&r, "committed")["account"], env.alice.id().as_str());
    Ok(())
}

/// One bond cannot seat a second account in a task whose commit window is still open, however
/// short the cooldown: an open entry locks its agent's bond until that window closes (16b review
/// M1, independent review L3). The cooldown here is 5 s and the commit window 600 s.
#[tokio::test]
async fn bond_is_locked_until_the_commit_window_closes() -> anyhow::Result<()> {
    let env = setup(5).await?;
    set_bond(&env).await?;
    deposit(&env, &env.poster, REWARD).await?;
    let mut long = task_json(&env, REWARD, env.judge.id(), 1);
    long["commit_secs"] = json!(600);
    let id = post(&env, &env.poster, long).await?;
    let commit_deadline = num(&get_task(&env, id).await?["commit_deadline"]);

    let dave = new_account(&env, "dave").await?;
    storage_deposit(&env, &dave, STORAGE).await?;
    deposit_for(&env, &env.poster, dave.id(), BOND).await?;
    done_clean(register_agent_call(&env, &dave).await?)?;
    commit_work(&env, &dave, id, b"dave's work").await?;
    let agent = view(&env.tender, "get_agent", json!({ "account_id": dave.id() })).await?;
    assert_eq!(num(&agent["locked_until"]), commit_deadline);

    // dave leaves at once. The 5 s cooldown would let him claim at once; the lock does not.
    let r = clean(call(&env, &dave, "unregister_agent", json!({}), ONE_YOCTO).await?)?;
    assert_eq!(
        num(&event(&r, "agent_unregistering")["claimable_at"]),
        commit_deadline
    );
    let after_cooldown = now_ns(&env).await? + 10 * 1_000_000_000;
    advance_to(&env, after_cooldown).await?;
    let r = call(&env, &dave, "claim_agent_bond", json!({}), ONE_YOCTO).await?;
    assert_fails_with(&r, "E_PHASE: ");
    assert_eq!(vault_balance(&env, dave.id()).await?, 0);

    // From the commit deadline he claims it, and the task takes no new entrant by then.
    advance_to(&env, u64::try_from(commit_deadline)?).await?;
    done_clean(call(&env, &dave, "claim_agent_bond", json!({}), ONE_YOCTO).await?)?;
    assert_eq!(vault_balance(&env, dave.id()).await?, BOND);
    let r = commit_call(&env, &env.bob, id, &seal(id, env.bob.id(), b"late")).await?;
    assert_fails_with(&r, "E_PHASE: ");
    assert_eq!(get_task(&env, id).await?["commit_count"], 1);
    assert_conserved(&env, &[dave.id()]).await?;
    Ok(())
}
