//! `pick_attested` with the most attestations it takes, 12, on a real node: what it burns, and
//! that all of them are logged in order. The texts are signed with secp256k1 keys the test makes,
//! as NEAR AI Cloud signs them: EIP-191 `personal_sign` over `"{model}:{sha256}:{sha256}"`. The
//! real NEAR AI Cloud signature is tested in `upgrade.rs`.

mod common;

use common::*;
use near_crypto::{KeyType, SecretKey, Signature};
use serde_json::{json, Value};
use sha3::{Digest, Keccak256};

/// The most attestations `pick_attested` takes.
const MAX_ATTESTATIONS: usize = 12;
const MODEL: &str = "Qwen/Qwen3.8-27B";

fn keccak(bytes: &[u8]) -> [u8; 32] {
    Keccak256::digest(bytes).into()
}

/// The Ethereum address of a secp256k1 key: `0x` and the last 20 bytes of the keccak-256 of its
/// 64-byte public key.
fn address_of(key: &SecretKey) -> String {
    format!("0x{}", hex(&keccak(key.public_key().key_data())[12..]))
}

/// EIP-191 `personal_sign` of `text` by `key`: `0x`, r, s and v (27 or 28).
fn personal_sign(key: &SecretKey, text: &str) -> String {
    let digest = keccak(format!("\x19Ethereum Signed Message:\n{}{text}", text.len()).as_bytes());
    let Signature::SECP256K1(signature) = key.sign(&digest) else {
        panic!("a secp256k1 key makes a secp256k1 signature");
    };
    let mut bytes: [u8; 65] = signature.into();
    bytes[64] += 27;
    format!("0x{}", hex(&bytes))
}

#[tokio::test]
async fn twelve_attestations_pay_and_log_in_order() -> anyhow::Result<()> {
    let env = setup(WINDOW_SECS).await?;
    let key = SecretKey::from_seed(KeyType::SECP256K1, "attested-sandbox");
    done_clean(
        call(
            &env,
            &env.owner,
            "set_attested_signer",
            json!({
                "signer_id": "tee-1",
                "algo": "ecdsa",
                "public_key_or_address": address_of(&key),
                "model": MODEL,
                "enabled": true,
            }),
            ONE_YOCTO,
        )
        .await?,
    )?;

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

    let hashes: Vec<(String, String)> = (0..=MAX_ATTESTATIONS)
        .map(|n| {
            let request = hex(&sha256(format!("request {n}").as_bytes()));
            let response = hex(&sha256(format!("response {n}").as_bytes()));
            (request, response)
        })
        .collect();
    let attestations: Vec<Value> = hashes
        .iter()
        .map(|(request, response)| {
            let text = format!("{MODEL}:{request}:{response}");
            json!({ "signer_id": "tee-1", "signature": personal_sign(&key, &text), "text": text })
        })
        .collect();
    let args = |list: &[Value]| {
        json!({
            "task_id": id.to_string(),
            "winners": [winner(&env.alice, 10_000)],
            "scorecard_hash": hex(&sha256(b"scorecard")),
            "scorecard_uri": "ipfs://scorecard",
            "attestations": list,
        })
    };

    // Thirteen are refused.
    let r = call(
        &env,
        &env.judge,
        "pick_attested",
        args(&attestations),
        NO_DEPOSIT,
    )
    .await?;
    assert_fails_with(
        &r,
        "E_ATTESTATION: a pick_attested takes 1 to 12 attestations, got 13",
    );

    // Twelve pay, and each is logged after `picked`, in order.
    let r = call(
        &env,
        &env.judge,
        "pick_attested",
        args(&attestations[..MAX_ATTESTATIONS]),
        NO_DEPOSIT,
    )
    .await?;
    let r = clean(r)?;
    let burnt = r.total_gas_burnt.as_gas() as f64 / 1e12;
    eprintln!("pick_attested with {MAX_ATTESTATIONS} attestations burnt {burnt:.2} Tgas");
    assert!(burnt < 100.0, "{burnt} Tgas");
    let logged = events(&r);
    assert_eq!(logged.len(), 1 + MAX_ATTESTATIONS);
    assert_eq!(logged[0].0, "picked");
    for (n, (name, data)) in logged[1..].iter().enumerate() {
        assert_eq!(name, "attested_pick");
        assert_eq!(
            *data,
            json!({
                "task_id": id.to_string(),
                "signer_id": "tee-1",
                "model": MODEL,
                "request_hash": hashes[n].0,
                "response_hash": hashes[n].1,
            })
        );
    }
    assert_eq!(
        vault_balance(&env, env.alice.id()).await?,
        REWARD - fee_of(REWARD)
    );
    assert_conserved(&env, &[]).await?;
    Ok(())
}
