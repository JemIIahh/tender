//! The owner's setters on the built wasm, `migrate`, and a second `new`.
//!
//! Each setter first wants exactly 1 yoctoNEAR, which a function-call key cannot attach, then the
//! owner as the caller. `accept_owner` wants the pending owner instead. The checks run in that
//! order, so a rejection names the first rule broken.

mod common;

use common::*;
use near_workspaces::types::NearToken;
use serde_json::{json, Value};

/// The six setters, with arguments that the owner may send. Run in this order, `propose_owner`
/// makes carol the pending owner, which `accept_owner` needs.
fn setters(env: &Env) -> Vec<(&'static str, Value)> {
    vec![
        (
            "set_token",
            json!({
                "token": env.token.id(),
                "min_reward": "1",
                "max_reward": "1000000000000",
                "enabled": true,
            }),
        ),
        (
            "set_fee",
            json!({ "fee_bps": 500, "treasury": env.treasury.id() }),
        ),
        ("set_min_window", json!({ "min_window_secs": 5 })),
        ("set_paused", json!({ "paused": false })),
        ("propose_owner", json!({ "new_owner": env.carol.id() })),
        ("accept_owner", json!({})),
    ]
}

/// No yocto and two yocto are both refused, and 1 yocto goes through.
#[tokio::test]
async fn setters_need_exactly_one_yocto() -> anyhow::Result<()> {
    let env = setup(5).await?;
    for (method, args) in setters(&env) {
        // The pending owner, once `propose_owner` has run, is the caller `accept_owner` needs.
        let caller = if method == "accept_owner" {
            &env.carol
        } else {
            &env.owner
        };
        for attached in [NO_DEPOSIT, NearToken::from_yoctonear(2)] {
            let before = stored(&env).await?;
            let r = call(&env, caller, method, args.clone(), attached).await?;
            assert_fails_with(&r, "Requires attached deposit of exactly 1 yoctoNEAR");
            assert!(
                stored(&env).await? == before,
                "{method} with {attached}: a refused call changed storage"
            );
        }
        // With the one yocto that it asks for, the same call succeeds. If it did not, the refusals
        // above could be an owner who is not the owner.
        done_clean(call(&env, caller, method, args, ONE_YOCTO).await?)?;
    }
    // The last of them, `accept_owner`, made carol the owner.
    assert_eq!(
        view(&env.tender, "get_config", json!({})).await?["owner"],
        env.carol.id().as_str()
    );
    Ok(())
}

/// Everyone but the owner is refused with `E_OWNER`, and so is an owner-to-be before it accepts.
#[tokio::test]
async fn setters_refuse_everyone_but_the_owner() -> anyhow::Result<()> {
    let env = setup(5).await?;
    let config = || view(&env.tender, "get_config", json!({}));

    // Bob is nobody. `accept_owner` refuses him too, because there is nothing to accept.
    for (method, args) in setters(&env) {
        let before = stored(&env).await?;
        let r = call(&env, &env.bob, method, args, ONE_YOCTO).await?;
        assert_fails_with(&r, "E_OWNER");
        assert!(
            stored(&env).await? == before,
            "{method}: a refused call changed storage"
        );
    }
    assert_eq!(config().await?["owner"], env.owner.id().as_str());

    // The owner offers the contract to carol. The offer gives her no power yet.
    let propose = json!({ "new_owner": env.carol.id() });
    done_clean(call(&env, &env.owner, "propose_owner", propose, ONE_YOCTO).await?)?;
    assert_eq!(config().await?["pending_owner"], env.carol.id().as_str());
    let pause = json!({ "paused": true });
    let r = call(&env, &env.carol, "set_paused", pause.clone(), ONE_YOCTO).await?;
    assert_fails_with(&r, "E_OWNER");
    // Only the account named in the offer can accept it.
    let r = call(&env, &env.bob, "accept_owner", json!({}), ONE_YOCTO).await?;
    assert_fails_with(&r, "E_OWNER");
    assert_eq!(config().await?["owner"], env.owner.id().as_str());

    // Carol accepts. From then on she is the owner and the previous owner has no power.
    done_clean(call(&env, &env.carol, "accept_owner", json!({}), ONE_YOCTO).await?)?;
    let accepted = config().await?;
    assert_eq!(accepted["owner"], env.carol.id().as_str());
    assert!(accepted["pending_owner"].is_null());
    for (method, args) in setters(&env) {
        let r = call(&env, &env.owner, method, args, ONE_YOCTO).await?;
        assert_fails_with(&r, "E_OWNER");
    }
    assert_eq!(config().await?["paused"], false);
    done_clean(call(&env, &env.carol, "set_paused", pause, ONE_YOCTO).await?)?;
    assert_eq!(config().await?["paused"], true);
    Ok(())
}

/// `migrate` is `#[private]`: only the contract account can run it, which is what an upgrade
/// transaction does right after it deploys the new code. Run on a contract that is initialised,
/// at the version it already is, it changes nothing.
#[tokio::test]
async fn migrate_is_private_and_keeps_the_state() -> anyhow::Result<()> {
    let env = setup(5).await?;
    // Some state beyond the configuration: a funded vault and a posted task.
    deposit(&env, &env.poster, REWARD).await?;
    let id = post(
        &env,
        &env.poster,
        task_json(&env, REWARD, env.judge.id(), 1),
    )
    .await?;
    let before = stored(&env).await?;
    let config_before = view(&env.tender, "get_config", json!({})).await?;
    let task_before = get_task(&env, id).await?;

    // Not alice, and not the owner either.
    for outsider in [&env.alice, &env.owner] {
        let r = outsider
            .call(env.tender.id(), "migrate")
            .max_gas()
            .transact()
            .await?;
        assert_fails_with(&r, "Method migrate is private");
        assert!(
            stored(&env).await? == before,
            "a refused migrate changed storage"
        );
    }

    // The contract account can, and the state that it reads back is the state it had.
    done_clean(env.tender.call("migrate").max_gas().transact().await?)?;
    assert_eq!(
        view(&env.tender, "get_config", json!({})).await?,
        config_before
    );
    assert_eq!(get_task(&env, id).await?, task_before);
    assert_eq!(vault_balance(&env, env.poster.id()).await?, 0);
    assert!(
        stored(&env).await? == before,
        "migrate changed the stored bytes"
    );
    assert_conserved(&env, &[]).await?;
    Ok(())
}

/// A second `new` on a contract that is running, even from the contract account, which
/// `#[private]` lets through, is refused by near-sdk's init wrapper and changes nothing. The
/// TypeScript client maps this error by its text, so the text is pinned here word for word.
#[tokio::test]
async fn new_on_an_initialised_contract_is_refused() -> anyhow::Result<()> {
    let env = setup(5).await?;
    let before = stored(&env).await?;
    let r = env
        .tender
        .call("new")
        .args_json(json!({
            "owner": env.alice.id(),
            "treasury": env.alice.id(),
            "fee_bps": 0,
            "min_window_secs": 1,
        }))
        .max_gas()
        .transact()
        .await?;
    assert_fails_with(&r, "The contract has already been initialized");
    assert!(
        stored(&env).await? == before,
        "a refused new changed storage"
    );
    assert_eq!(
        view(&env.tender, "get_config", json!({})).await?["owner"],
        env.owner.id().as_str()
    );
    Ok(())
}
