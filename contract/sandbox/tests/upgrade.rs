//! The upgrade from the build that testnet runs to the build in `res/`, on a real node: the old
//! code makes state, the new code is deployed over it with `migrate` in the same transaction, the
//! old state still reads, and `set_attested_signer` and `pick_attested` work with the real NEAR AI
//! Cloud signature in `docs/research/S1-fixture.json`.
//!
//! The old build is the one testnet ran before the attested picks (`UPGRADE_FROM_SHA256`), found in
//! the git history of `contract/res/tender.wasm`. A checkout without that history (a shallow
//! clone, as CI's contract job makes) has no old build to start from, and the test then says so
//! and passes without running.

mod common;

use std::process::Command;

use common::*;
use near_workspaces::operations::Function;
use near_workspaces::types::Gas;
use near_workspaces::ContractState;
use serde_json::{json, Value};

const FIXTURE: &str = include_str!("../../../docs/research/S1-fixture.json");
/// The SHA-256 of the build testnet ran before the attested picks: `wasmSha256` of
/// `deployments/testnet.json` on 2026-11-14, before the upgrade.
const UPGRADE_FROM_SHA256: &str =
    "5ec43a10812fb9b92f47ac09c3e3a7ab619104491aa00dcec05c9e6f51b62b36";
const SIGNER: &str = "nearai-qwen";

fn fixture(field: &str) -> String {
    let v: Value = serde_json::from_str(FIXTURE).expect("the fixture is JSON");
    v[field].as_str().expect("a string field").to_string()
}

fn git(args: &[&str]) -> Option<Vec<u8>> {
    let repo = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .ok()?;
    out.status.success().then_some(out.stdout)
}

/// The build of `contract/res/tender.wasm` whose SHA-256 is `sha256_hex`, from the git history, or
/// `None` if no commit there has it.
fn wasm_from_history(sha256_hex: &str) -> Option<Vec<u8>> {
    let commits = String::from_utf8(git(&[
        "log",
        "--format=%H",
        "--",
        "contract/res/tender.wasm",
    ])?)
    .ok()?;
    commits.lines().find_map(|commit| {
        let bytes = git(&["show", &format!("{commit}:contract/res/tender.wasm")])?;
        (hex(&sha256(&bytes)) == sha256_hex).then_some(bytes)
    })
}

/// The SHA-256 of the code Tender's account runs.
async fn code_hash(env: &Env) -> anyhow::Result<[u8; 32]> {
    match env
        .worker
        .view_account(env.tender.id())
        .await?
        .contract_state
    {
        ContractState::LocalHash(hash) => Ok(hash.0),
        other => anyhow::bail!("Tender's account runs no local code: {other:?}"),
    }
}

#[tokio::test]
async fn upgrade_keeps_the_state_and_adds_attested_picks() -> anyhow::Result<()> {
    let Some(old_wasm) = wasm_from_history(UPGRADE_FROM_SHA256) else {
        eprintln!(
            "SKIPPED upgrade test: no commit in this checkout's history has the build testnet ran \
             (sha256 {UPGRADE_FROM_SHA256}); a shallow clone lacks it"
        );
        return Ok(());
    };
    let new_wasm = std::fs::read(TENDER_WASM)?;
    assert_ne!(
        sha256(&old_wasm),
        sha256(&new_wasm),
        "res/ holds the old build"
    );

    // The old code makes state: a task with a revealed entry, waiting for its pick.
    let env = setup_with(WINDOW_SECS, old_wasm.clone()).await?;
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

    // The old code has no attested picks.
    let (address, model) = (fixture("signing_address"), fixture("model"));
    let set_signer = json!({
        "signer_id": SIGNER,
        "algo": "ecdsa",
        "public_key_or_address": address,
        "model": model,
        "enabled": true,
    });
    let r = call(
        &env,
        &env.owner,
        "set_attested_signer",
        set_signer.clone(),
        ONE_YOCTO,
    )
    .await?;
    assert_fails_with(&r, "MethodNotFound");

    let before_task = get_task(&env, id).await?;
    let before_config = view(&env.tender, "get_config", json!({})).await?;
    let before_poster = storage_used(&env, env.poster.id()).await?;
    assert_eq!(code_hash(&env).await?, sha256(&old_wasm));

    // The upgrade: the contract account deploys the new code over its state and calls `migrate`
    // in the same transaction, as scripts/upgrade-contract.ts does.
    let r = env
        .tender
        .as_account()
        .batch(env.tender.id())
        .deploy(&new_wasm)
        .call(
            Function::new("migrate")
                .args_json(json!({}))
                .gas(Gas::from_tgas(100)),
        )
        .transact()
        .await?;
    let r = clean(r)?;
    eprintln!(
        "upgrade: deploy {} bytes and migrate burnt {:.2} Tgas",
        new_wasm.len(),
        r.total_gas_burnt.as_gas() as f64 / 1e12
    );
    assert_eq!(code_hash(&env).await?, sha256(&new_wasm));

    // The old state reads as it was.
    assert_eq!(get_task(&env, id).await?, before_task);
    let config = view(&env.tender, "get_config", json!({})).await?;
    assert_eq!(config, before_config);
    assert_eq!(config["version"], 1);
    assert_eq!(storage_used(&env, env.poster.id()).await?, before_poster);
    // `migrate` a second time is harmless: the state is version 1 still.
    done(
        env.tender
            .as_account()
            .call(env.tender.id(), "migrate")
            .args_json(json!({}))
            .max_gas()
            .transact()
            .await?,
    )?;

    // The owner registers the signer, and reads it back.
    let owner_used = storage_used(&env, env.owner.id()).await?;
    done_clean(
        call(
            &env,
            &env.owner,
            "set_attested_signer",
            set_signer,
            ONE_YOCTO,
        )
        .await?,
    )?;
    assert!(storage_used(&env, env.owner.id()).await? > owner_used);
    let view_signer = view(
        &env.tender,
        "get_attested_signer",
        json!({ "signer_id": SIGNER }),
    )
    .await?;
    assert_eq!(
        view_signer,
        json!({
            "signer_id": SIGNER,
            "algo": "ecdsa",
            "address": fixture("signing_address"),
            "model": fixture("model"),
            "enabled": true,
        })
    );

    advance_to(&env, deadline(&before_task, "reveal_deadline")).await?;
    let pick_args = |attestations: Value| {
        json!({
            "task_id": id.to_string(),
            "winners": [winner(&env.alice, 10_000)],
            "scorecard_hash": hex(&sha256(b"scorecard")),
            "scorecard_uri": "ipfs://scorecard",
            "attestations": attestations,
        })
    };
    let real = json!({
        "signer_id": SIGNER,
        "text": fixture("text"),
        "signature": fixture("signature"),
    });

    // A tampered text is refused, and nothing is paid.
    let mut tampered = real.clone();
    let mut text = fixture("text");
    let last = text.pop().unwrap_or('0');
    text.push(if last == '0' { '1' } else { '0' });
    tampered["text"] = json!(text);
    let r = call(
        &env,
        &env.judge,
        "pick_attested",
        pick_args(json!([tampered])),
        NO_DEPOSIT,
    )
    .await?;
    assert_fails_with(&r, "E_ATTESTATION");
    assert_eq!(vault_balance(&env, env.alice.id()).await?, 0);
    // An unknown argument is refused, as in `pick`.
    let mut extra = pick_args(json!([real.clone()]));
    extra["attestation"] = json!({});
    let r = call(&env, &env.judge, "pick_attested", extra, NO_DEPOSIT).await?;
    assert!(r.is_failure(), "an unknown argument must be refused");

    // The real attestation pays, with `picked` and then `attested_pick`.
    let r = call(
        &env,
        &env.judge,
        "pick_attested",
        pick_args(json!([real])),
        NO_DEPOSIT,
    )
    .await?;
    let r = clean(r)?;
    eprintln!(
        "pick_attested with one attestation burnt {:.2} Tgas",
        r.total_gas_burnt.as_gas() as f64 / 1e12
    );
    let logged = events(&r);
    let names: Vec<&str> = logged.iter().map(|(name, _)| name.as_str()).collect();
    assert_eq!(names, ["picked", "attested_pick"]);
    assert_eq!(
        logged[1].1,
        json!({
            "task_id": id.to_string(),
            "signer_id": SIGNER,
            "model": fixture("model"),
            "request_hash": fixture("request_sha256"),
            "response_hash": fixture("response_sha256"),
        })
    );
    assert_eq!(
        vault_balance(&env, env.alice.id()).await?,
        REWARD - fee_of(REWARD)
    );
    assert_eq!(get_task(&env, id).await?["phase"], "settled");
    assert_conserved(&env, &[]).await?;
    Ok(())
}
