//! NEP-366 meta-transactions on the built wasm: a relayer submits a DelegateAction that another
//! account's key signed. The runtime then reports the relayer as the signer, with the relayer's
//! key, and the account that signed the DelegateAction as the predecessor. The transactions are
//! built by hand, since near-workspaces has no DelegateAction; the helpers come from the
//! independent review's probe (fix round 1, H1).

mod common;

use common::*;
use near_crypto::{InMemorySigner, SecretKey as CryptoSecret};
use near_jsonrpc_client::{methods, JsonRpcClient};
use near_primitives::action::delegate::{DelegateAction, NonDelegateAction, SignedDelegateAction};
use near_primitives::hash::CryptoHash;
use near_primitives::transaction::{
    Action, FunctionCallAction, SignedTransaction, Transaction, TransactionV0,
};
use near_primitives::views::FinalExecutionOutcomeView;
use near_workspaces::types::Gas;
use near_workspaces::Account;
use serde_json::{json, Value};

/// `who` registers `key` as a delegate key that may spend 5_000 per call and 10_000 in all.
async fn add_delegate(env: &Env, who: &Account, key: &Account) -> anyhow::Result<()> {
    done_clean(
        who.call(env.tender.id(), "add_delegate")
            .args_json(json!({
                "public_key": key.secret_key().public_key(),
                "token": env.token.id(),
                "per_task_cap": "5000",
                "total_cap": "10000",
            }))
            .deposit(ONE_YOCTO)
            .gas(Gas::from_tgas(15))
            .transact()
            .await?,
    )
}

/// `relayer` submits, as a meta-transaction, a DelegateAction that `key` signs for its account
/// (`key.id()`), calling `method` on Tender with `args` and `yocto` attached.
async fn relay(
    env: &Env,
    relayer: &Account,
    key: &Account,
    method: &str,
    args: Value,
    yocto: u128,
) -> anyhow::Result<FinalExecutionOutcomeView> {
    let rpc = JsonRpcClient::connect(env.worker.rpc_addr());
    let block = env.worker.view_block().await?;
    let head = CryptoHash(block.hash().0);

    let key_secret: CryptoSecret = key.secret_key().to_string().parse()?;
    let key_signer = InMemorySigner::from_secret_key(key.id().clone(), key_secret.clone());
    let key_nonce = env
        .worker
        .view_access_key(key.id(), &key.secret_key().public_key())
        .await?
        .nonce;
    let call = Action::FunctionCall(Box::new(FunctionCallAction {
        method_name: method.to_string(),
        args: serde_json::to_vec(&args)?,
        gas: near_primitives::gas::Gas::from_teragas(100),
        deposit: near_primitives::types::Balance::from_yoctonear(yocto),
    }));
    let delegate = DelegateAction {
        sender_id: key.id().clone(),
        receiver_id: env.tender.id().clone(),
        actions: vec![NonDelegateAction::try_from(call).map_err(|e| anyhow::anyhow!("{e}"))?],
        nonce: key_nonce + 1,
        max_block_height: block.height() + 1_000,
        public_key: key_secret.public_key(),
    };
    let signed_delegate = SignedDelegateAction::sign(&key_signer, delegate);

    let relayer_secret: CryptoSecret = relayer.secret_key().to_string().parse()?;
    let relayer_signer =
        InMemorySigner::from_secret_key(relayer.id().clone(), relayer_secret.clone());
    let relayer_nonce = env
        .worker
        .view_access_key(relayer.id(), &relayer.secret_key().public_key())
        .await?
        .nonce;
    let tx = Transaction::V0(TransactionV0 {
        signer_id: relayer.id().clone(),
        public_key: relayer_secret.public_key(),
        nonce: relayer_nonce + 1,
        receiver_id: key.id().clone(),
        block_hash: head,
        actions: vec![Action::Delegate(Box::new(signed_delegate))],
    });
    let (hash, _) = tx.get_hash_and_size();
    let signature = relayer_signer.sign(hash.as_ref());
    Ok(rpc
        .call(methods::broadcast_tx_commit::RpcBroadcastTxCommitRequest {
            signed_transaction: SignedTransaction::new(signature, tx),
        })
        .await?)
}

/// Independent review H1. The judge's delegate key, whose access key may call `post_task` and
/// `pick` (as in delegate.rs's `verifier_delegate_key_cannot_pick`), is refused a direct pick, and
/// now also the same pick relayed by anyone as a meta-transaction: Tender sees carol as the
/// signer and the judge as the caller, and refuses a pick the caller did not sign itself.
#[tokio::test]
async fn verifier_delegate_key_cannot_pick_via_meta_transaction() -> anyhow::Result<()> {
    let env = setup(5).await?;
    let judge = &env.judge;
    deposit(&env, &env.poster, REWARD).await?;
    let id = post(&env, &env.poster, task_json(&env, REWARD, judge.id(), 1)).await?;
    // alice does the real work; bob, the attacker's agent, enters junk.
    let (ah, asalt) = commit_work(&env, &env.alice, id, b"real work").await?;
    let (bh, bsalt) = commit_work(&env, &env.bob, id, b"junk").await?;
    let delegate_key = function_call_key(&env, judge, &["post_task", "pick"]).await?;
    add_delegate(&env, judge, &delegate_key).await?;

    let task = get_task(&env, id).await?;
    advance_to(&env, deadline(&task, "commit_deadline")).await?;
    done_clean(reveal(&env, &env.alice, id, &ah, &asalt, "ipfs://alice").await?)?;
    done_clean(reveal(&env, &env.bob, id, &bh, &bsalt, "ipfs://bob").await?)?;
    advance_to(&env, deadline(&task, "reveal_deadline")).await?;
    assert_eq!(get_task(&env, id).await?["phase"], "judging");

    // The direct call is refused, as delegate.rs already shows.
    let r = pick(&env, &delegate_key, id, vec![winner(&env.bob, 10_000)]).await?;
    assert_fails_with(&r, "cannot be picked with a delegate key");

    // carol relays the same key's DelegateAction, empty or not.
    let before = stored(&env).await?;
    for winners in [
        json!([{ "account": env.bob.id(), "bps": 10_000 }]),
        json!([]),
    ] {
        let args = json!({
            "task_id": id.to_string(),
            "winners": winners,
            "scorecard_hash": hex(&sha256(b"scorecard")),
            "scorecard_uri": "ipfs://scorecard",
        });
        let outcome = relay(&env, &env.carol, &delegate_key, "pick", args, 0).await?;
        let receipts = format!("{:?}", outcome.receipts_outcome);
        assert!(
            receipts.contains("E_AUTH")
                && receipts.contains("signs itself, not through a relayer or another contract"),
            "the relayed pick must be refused: {receipts}"
        );
        assert!(
            !receipts.contains("EVENT_JSON"),
            "a refused pick logs nothing: {receipts}"
        );
    }
    assert!(
        stored(&env).await? == before,
        "the refusals changed nothing"
    );
    assert!(get_task(&env, id).await?["outcome"].is_null());
    assert_eq!(vault_balance(&env, env.bob.id()).await?, 0);

    // The judge's own full-access key still picks, directly.
    done_clean(pick(&env, judge, id, vec![winner(&env.alice, 10_000)]).await?)?;
    assert_eq!(
        vault_balance(&env, env.alice.id()).await?,
        REWARD - fee_of(REWARD)
    );
    assert_conserved(&env, &[]).await?;
    Ok(())
}

/// The spending side refuses a meta-transaction too: a delegate key spends only when signer,
/// predecessor and the debited account are one, and a relayer is the signer.
#[tokio::test]
async fn delegate_spend_via_meta_transaction_is_refused() -> anyhow::Result<()> {
    let env = setup(5).await?;
    let lead = &env.poster;
    deposit(&env, lead, REWARD).await?;
    let key = function_call_key(&env, lead, &["post_task"]).await?;
    add_delegate(&env, lead, &key).await?;
    let task = task_json(&env, 4_000, lead.id(), 1);
    let outcome = relay(
        &env,
        &env.carol,
        &key,
        "post_task",
        json!({ "task": task }),
        0,
    )
    .await?;
    let receipts = format!("{:?}", outcome.receipts_outcome);
    assert!(receipts.contains("E_AUTH"), "{receipts}");
    assert_eq!(vault_balance(&env, lead.id()).await?, REWARD);
    Ok(())
}

/// The 1-yocto gate holds through a relayer: a function-call key's DelegateAction that attaches
/// 1 yoctoNEAR to `withdraw` is refused by the node, and the vault is untouched.
#[tokio::test]
async fn function_call_key_cannot_attach_yocto_via_meta_transaction() -> anyhow::Result<()> {
    let env = setup(5).await?;
    deposit(&env, &env.alice, REWARD).await?;
    // A key that may call any method on Tender.
    let key = function_call_key(&env, &env.alice, &[]).await?;
    let args = json!({
        "token": env.token.id(),
        "amount": REWARD.to_string(),
        "to": env.carol.id(),
    });
    let result = relay(&env, &env.carol, &key, "withdraw", args, 1).await;
    let text = format!("{result:?}");
    assert!(text.contains("DepositWithFunctionCall"), "{text}");
    assert_eq!(vault_balance(&env, env.alice.id()).await?, REWARD);
    Ok(())
}
