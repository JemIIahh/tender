//! "Connect your agent" on the built wasm, by both routes (contract/agent-setup, res/agent_setup.wasm).
//!
//! The sub-account: the owner's one transaction to `<name>.<owner>` creates it, sends it NEAR,
//! deploys the setup code and calls `setup` with the agent's public key, with no AddKey action. The
//! owner pays its Tender storage and its bond into its vault (`{"for": …}`), and the agent then
//! signs with its own key alone. `setup` runs once, for the parent only.
//!
//! The implicit account: the owner sends NEAR to the 64-hex account of the agent's key, which
//! the chain creates with that key, and pays the same storage and bond. No code, and no provider.

mod common;

use common::*;
use near_workspaces::operations::Function;
use near_workspaces::types::{AccessKeyPermission, Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId};
use serde_json::json;

const SETUP_WASM: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../res/agent_setup.wasm");

/// What the owner's wallet sends the agent's account: `AGENT_ACCOUNT_DEPOSIT` in
/// packages/shared/src/connect.ts.
const ACCOUNT_DEPOSIT: NearToken = NearToken::from_millinear(500);
/// The agent's storage balance at Tender: `AGENT_STORAGE_DEPOSIT`.
const STORAGE_DEPOSIT: NearToken = NearToken::from_millinear(20);
/// The gas the page attaches to `setup`: `AGENT_SETUP_GAS`.
const SETUP_GAS: Gas = Gas::from_tgas(30);
/// The bond the contract's owner sets: 2 test tokens.
const BOND: u128 = 2_000_000;

fn setup_wasm() -> anyhow::Result<Vec<u8>> {
    std::fs::read(SETUP_WASM)
        .map_err(|e| anyhow::anyhow!("cannot read {SETUP_WASM}: {e}; run contract/build.sh"))
}

fn setup_call(public_key: &str) -> Function {
    Function::new("setup")
        .args_json(json!({ "public_key": public_key }))
        .gas(SETUP_GAS)
}

/// The full-access keys of `who`, as `ed25519:<base58>`, and how many keys it has in all.
async fn full_access_keys(env: &Env, who: &AccountId) -> anyhow::Result<(Vec<String>, usize)> {
    let keys = env.worker.view_access_keys(who).await?;
    let full = keys
        .iter()
        .filter(|info| matches!(info.access_key.permission, AccessKeyPermission::FullAccess))
        .map(|info| info.public_key.to_string())
        .collect();
    Ok((full, keys.len()))
}

/// The contract's owner sets a bond of `BOND` in the test token.
async fn set_bond(env: &Env) -> anyhow::Result<()> {
    let bond = json!({ "token": env.token.id(), "amount": BOND.to_string() });
    done_clean(call(env, &env.owner, "set_agent_bond", bond, ONE_YOCTO).await?)
}

/// What the owner's batch pays after the account: the agent's storage at Tender, and the bond from
/// the owner's own tokens into the agent's vault.
async fn fund(env: &Env, owner: &Account, agent: &AccountId) -> anyhow::Result<()> {
    done_clean(
        owner
            .call(env.tender.id(), "storage_deposit")
            .args_json(json!({ "account_id": agent }))
            .deposit(STORAGE_DEPOSIT)
            .max_gas()
            .transact()
            .await?,
    )?;
    deposit_for(env, owner, agent, BOND).await
}

/// The agent registers with its own key, and its record names `asp` as its provider.
async fn registers_itself(
    env: &Env,
    agent: &Account,
    asp: Option<&AccountId>,
) -> anyhow::Result<()> {
    // With the gas the client attaches, which the NEAR the owner sent pays for.
    done_clean(
        agent
            .call(env.tender.id(), "register_agent")
            .args_json(json!({
                "profile_uri": format!("https://agents.example/{}.json", agent.id()),
                "profile_hash": hex(&sha256(agent.id().as_bytes())),
                "tags": ["test"],
            }))
            .deposit(ONE_YOCTO)
            .gas(REGISTER_AGENT_GAS)
            .transact()
            .await?,
    )?;
    let record = view(
        &env.tender,
        "get_agent",
        json!({ "account_id": agent.id() }),
    )
    .await?;
    assert_eq!(record["status"], "active");
    assert_eq!(record["bond_amount"], BOND.to_string());
    assert_eq!(record["asp"], json!(asp));
    assert_eq!(
        vault_balance(env, agent.id()).await?,
        0,
        "the bond left the vault"
    );
    Ok(())
}

/// The owner's one transaction makes the account with the agent's key alone, and no AddKey action:
/// the agent then signs for itself (registers, and sends NEAR), and `setup` never runs again.
#[tokio::test]
async fn the_owners_transaction_gives_the_sub_account_the_agents_key_alone() -> anyhow::Result<()> {
    let env = setup(5).await?;
    set_bond(&env).await?;
    let owner = env.poster.clone();
    let agent_id: AccountId = format!("writer.{}", owner.id()).parse()?;
    let key = SecretKey::from_random(KeyType::ED25519);
    let public_key = key.public_key().to_string();

    let r = owner
        .batch(&agent_id)
        .create_account()
        .transfer(ACCOUNT_DEPOSIT)
        .deploy(&setup_wasm()?)
        .call(setup_call(&public_key))
        .transact()
        .await?;
    let r = clean(r)?;
    let details = env.worker.view_account(&agent_id).await?;
    // For the record: what the batch burnt, receipt by receipt, and what the account's storage
    // locks (10^19 yoctoNEAR a byte).
    let burnt: Vec<f64> = r
        .outcomes()
        .iter()
        .map(|outcome| outcome.gas_burnt.as_gas() as f64 / 1e12)
        .collect();
    println!(
        "gas: the setup batch burnt {:.2} Tgas ({burnt:.2?}); the account stores {} bytes, locking {} yoctoNEAR",
        r.total_gas_burnt.as_gas() as f64 / 1e12,
        details.storage_usage,
        u128::from(details.storage_usage) * 10u128.pow(19),
    );
    assert_eq!(
        full_access_keys(&env, &agent_id).await?,
        (vec![public_key.clone()], 1),
        "the agent's key, and no other"
    );

    fund(&env, &owner, &agent_id).await?;
    let agent = Account::from_secret_key(agent_id.clone(), key, &env.worker);
    registers_itself(&env, &agent, Some(owner.id())).await?;
    done(
        agent
            .transfer_near(owner.id(), NearToken::from_millinear(100))
            .await?,
    )?;

    // The parent, a second time, with a key of its own: refused, and the keys are as they were.
    let other = SecretKey::from_random(KeyType::ED25519)
        .public_key()
        .to_string();
    let again = owner
        .call(&agent_id, "setup")
        .args_json(json!({ "public_key": other }))
        .gas(SETUP_GAS)
        .transact()
        .await?;
    assert_fails_with(&again, "E_DONE");
    // The agent itself is not its own parent.
    let own = agent
        .call(&agent_id, "setup")
        .args_json(json!({ "public_key": other }))
        .gas(SETUP_GAS)
        .transact()
        .await?;
    assert_fails_with(&own, "E_AUTH");
    assert_eq!(
        full_access_keys(&env, &agent_id).await?,
        (vec![public_key], 1)
    );
    Ok(())
}

/// Only the parent sets the account up, with the exact argument, and once. A refused `setup` in
/// the creating transaction undoes the whole transaction: no account, and the NEAR stays the
/// owner's.
#[tokio::test]
async fn only_the_parent_sets_up_and_only_once() -> anyhow::Result<()> {
    let env = setup(5).await?;
    let owner = env.poster.clone();
    let wasm = setup_wasm()?;
    let key = SecretKey::from_random(KeyType::ED25519)
        .public_key()
        .to_string();

    // An account with the code and no key yet.
    let bare: AccountId = format!("bare.{}", owner.id()).parse()?;
    done_clean(
        owner
            .batch(&bare)
            .create_account()
            .transfer(ACCOUNT_DEPOSIT)
            .deploy(&wasm)
            .transact()
            .await?,
    )?;
    assert_eq!(full_access_keys(&env, &bare).await?, (vec![], 0));

    // A stranger, and the parent's own parent, are not its parent.
    let root = env.worker.root_account()?;
    for caller in [&env.bob, &root] {
        let r = caller
            .call(&bare, "setup")
            .args_json(json!({ "public_key": key }))
            .gas(SETUP_GAS)
            .transact()
            .await?;
        assert_fails_with(&r, "E_AUTH");
    }
    // The parent, with anything but the exact argument.
    for args in [
        json!({}),
        json!({ "public_key": key, "more": 1 }),
        json!({ "public_key": key.replace("ed25519:", "secp256k1:") }),
        json!({ "public_key": format!("{key}1") }),
    ] {
        let r = owner
            .call(&bare, "setup")
            .args_json(args)
            .gas(SETUP_GAS)
            .transact()
            .await?;
        assert_fails_with(&r, "E_ARGS");
    }
    assert_eq!(full_access_keys(&env, &bare).await?, (vec![], 0));

    // The parent, once.
    done_clean(
        owner
            .call(&bare, "setup")
            .args_json(json!({ "public_key": key }))
            .gas(SETUP_GAS)
            .transact()
            .await?,
    )?;
    assert_eq!(full_access_keys(&env, &bare).await?, (vec![key.clone()], 1));
    let other = SecretKey::from_random(KeyType::ED25519)
        .public_key()
        .to_string();
    let again = owner
        .call(&bare, "setup")
        .args_json(json!({ "public_key": other }))
        .gas(SETUP_GAS)
        .transact()
        .await?;
    assert_fails_with(&again, "E_DONE");
    assert_eq!(full_access_keys(&env, &bare).await?, (vec![key], 1));

    // A creating transaction whose setup is refused leaves nothing behind.
    let undone: AccountId = format!("undone.{}", owner.id()).parse()?;
    let before = owner.view_account().await?.balance;
    let r = owner
        .batch(&undone)
        .create_account()
        .transfer(ACCOUNT_DEPOSIT)
        .deploy(&wasm)
        .call(
            Function::new("setup")
                .args_json(json!({ "public_key": "ed25519:x" }))
                .gas(SETUP_GAS),
        )
        .transact()
        .await?;
    assert_fails_with(&r, "E_ARGS");
    assert!(
        env.worker.view_account(&undone).await.is_err(),
        "no account"
    );
    // Signed: a refund of an earlier transaction's gas may land in between.
    let after = owner.view_account().await?.balance;
    let spent = before.as_yoctonear() as i128 - after.as_yoctonear() as i128;
    assert!(
        spent < NearToken::from_millinear(10).as_yoctonear() as i128,
        "only gas was spent, not the deposit: {spent}"
    );
    Ok(())
}

/// The fallback, for a wallet that refuses the setup batch too: a transfer to the agent's implicit
/// account creates it with the agent's key alone. It has no provider, so the record names none.
#[tokio::test]
async fn an_implicit_account_needs_only_a_transfer_and_has_no_provider() -> anyhow::Result<()> {
    let env = setup(5).await?;
    set_bond(&env).await?;
    let owner = env.poster.clone();
    let key = SecretKey::from_random(KeyType::ED25519);
    let public_key = key.public_key().to_string();
    let implicit: AccountId = hex(key.public_key().key_data()).parse()?;

    done(owner.transfer_near(&implicit, ACCOUNT_DEPOSIT).await?)?;
    let details = env.worker.view_account(&implicit).await?;
    println!(
        "storage: the implicit account stores {} bytes, locking {} yoctoNEAR",
        details.storage_usage,
        u128::from(details.storage_usage) * 10u128.pow(19),
    );
    assert_eq!(
        full_access_keys(&env, &implicit).await?,
        (vec![public_key], 1),
        "the chain created it with the agent's key, and no other"
    );
    fund(&env, &owner, &implicit).await?;
    let agent = Account::from_secret_key(implicit, key, &env.worker);
    registers_itself(&env, &agent, None).await?;
    Ok(())
}
