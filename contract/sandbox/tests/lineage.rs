//! Lineage on the built wasm: a lead agent enters a task, hires two specialists with sub-tasks of
//! its own, and is paid for the whole, with the sub-tasks' pick windows closing before the
//! parent's commit window does (spec 6.7, invariant I12).
//!
//! No delegate keys exist yet (Task 15), so the lead posts its sub-tasks as any poster does: from
//! its own vault, with 1 yoctoNEAR attached. Each is sent with the gas the TypeScript client
//! attaches to `post_task` (`GAS.postTask` in packages/shared/src/calls.ts), so that a passing
//! run also says the client's figure covers a post that names a parent.

mod common;

use common::*;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::Account;
use serde_json::{json, Value};

/// The parent's commit window: half an hour, in which the lead hires and then assembles.
const PARENT_COMMIT_SECS: u32 = 1_800;
/// Each window of a sub-task. The hiring stage, two posts and two commits, took 1.1 s of chain
/// time on an idle machine, and chain time follows the wall clock when a machine is loaded, so
/// the shortest window the sandbox allows (5 s) would be a race. 30 s is not, and chain time
/// jumps between windows, so a long window costs nothing.
const CHILD_SECS: u32 = 30;
/// The parent's commit window in the test of the rules, which has to wait out the parent's
/// windows to settle it: shorter than the swarm's, and still longer than a sub-task's three.
const RULES_COMMIT_SECS: u32 = 300;

/// The parent's reward and the two sub-tasks' rewards, in units of the test token. The parent
/// pays 10_000_000 less the fee of 5%, 9_500_000, to its one winner, the lead. The lead puts in
/// 3_000_000 and 2_000_000, and keeps what is left.
const PARENT_REWARD: u128 = 10_000_000;
const REWARD_A: u128 = 3_000_000;
const REWARD_B: u128 = 2_000_000;

/// What a call burnt in all, in Tgas: the transaction and every receipt that followed from it.
fn tgas(r: &ExecutionFinalResult) -> f64 {
    r.total_gas_burnt.as_gas() as f64 / 1e12
}

/// The task `reward` for the test token that `who` posts under `parent`, with sub-task windows of
/// `CHILD_SECS` and the judge as verifier: `task_json` with its windows and parent changed.
fn child_json(env: &Env, reward: u128, parent: u64) -> Value {
    let mut task = task_json(env, reward, env.judge.id(), 1);
    for window in ["commit_secs", "reveal_secs", "pick_secs", "fallback_secs"] {
        task[window] = json!(CHILD_SECS);
    }
    task["parent"] = json!(parent.to_string());
    task
}

/// `who`'s `post_task` of `task`, sent with `POST_TASK_GAS` and 1 yocto: the raw result.
async fn post_with_gas(
    env: &Env,
    who: &Account,
    task: Value,
) -> anyhow::Result<ExecutionFinalResult> {
    Ok(who
        .call(env.tender.id(), "post_task")
        .args_json(json!({ "task": task }))
        .deposit(ONE_YOCTO)
        .gas(POST_TASK_GAS)
        .transact()
        .await?)
}

/// Posts `task` as `who` with `POST_TASK_GAS`, which must succeed. Returns its id and what it
/// burnt.
async fn post_child(env: &Env, who: &Account, task: Value) -> anyhow::Result<(u64, f64)> {
    let r = clean(post_with_gas(env, who, task).await?)?;
    let burnt = tgas(&r);
    let id: String = r.json()?;
    Ok((id.parse()?, burnt))
}

/// The test sits in a module named after the suite, so that the plan's `cargo test -p
/// tender_sandbox lineage` selects it: a test's name does not include its binary's.
mod lineage {
    use super::*;

    /// One lead, two specialists, one judge. The whole story of the swarm in the spec.
    #[tokio::test]
    async fn swarm_shape() -> anyhow::Result<()> {
        let env = setup(5).await?;
        let (poster, lead, alice, bob, judge) =
            (&env.poster, &env.carol, &env.alice, &env.bob, &env.judge);

        // The poster funds the parent. The lead fronts the sub-tasks' rewards, and no more.
        deposit(&env, poster, PARENT_REWARD).await?;
        deposit(&env, lead, REWARD_A + REWARD_B).await?;
        let lead_before = vault_balance(&env, lead.id()).await?;
        assert_eq!(lead_before, REWARD_A + REWARD_B);

        let mut parent_task = task_json(&env, PARENT_REWARD, judge.id(), 1);
        parent_task["commit_secs"] = json!(PARENT_COMMIT_SECS);
        let parent = post(&env, poster, parent_task).await?;
        let parent_view = get_task(&env, parent).await?;
        let parent_commit_deadline = deadline(&parent_view, "commit_deadline");
        assert_eq!(parent_view["parent"], Value::Null);

        // (1) The lead enters the parent with a placeholder, which unlocks lineage.
        let placeholder = seal(parent, lead.id(), b"placeholder");
        let r = clean(commit_call(&env, lead, parent, &placeholder).await?)?;
        assert_eq!(event(&r, "committed")["replaced"], false);

        // (2) It posts two sub-tasks under the parent, from its own vault.
        let stage = now_ns(&env).await?;
        let (a, a_gas) = post_child(&env, lead, child_json(&env, REWARD_A, parent)).await?;
        let (b, b_gas) = post_child(&env, lead, child_json(&env, REWARD_B, parent)).await?;
        assert_eq!((a, b), (parent + 1, parent + 2));
        assert_eq!(
            vault_balance(&env, lead.id()).await?,
            lead_before - REWARD_A - REWARD_B
        );
        let (child_a, child_b) = (get_task(&env, a).await?, get_task(&env, b).await?);
        for (child, reward) in [(&child_a, REWARD_A), (&child_b, REWARD_B)] {
            // The chain says who hired whom, and I12 holds on the node: each child's pick window
            // ends before the parent's commit window does.
            assert_eq!(child["parent"], parent.to_string());
            assert_eq!(child["poster"], lead.id().as_str());
            assert_eq!(child["verifier"], judge.id().as_str());
            assert_eq!(num(&child["reward"]), reward);
            assert!(deadline(child, "pick_deadline") <= parent_commit_deadline);
        }

        // (3) Alice and bob each win a sub-task. They are two accounts, so they go together.
        let ((alice_hash, alice_salt), (bob_hash, bob_salt)) = tokio::try_join!(
            commit_work(&env, alice, a, b"alice's piece"),
            commit_work(&env, bob, b, b"bob's piece"),
        )?;
        let in_commit_window = now_ns(&env).await?;
        assert!(in_commit_window < deadline(&child_a, "commit_deadline"));
        assert!(in_commit_window < deadline(&child_b, "commit_deadline"));
        eprintln!(
            "hiring stage: {:.1} s of chain time, post_task with a parent burnt {a_gas:.2} and {b_gas:.2} Tgas",
            (in_commit_window - stage) as f64 / 1e9
        );

        advance_to(&env, deadline(&child_b, "commit_deadline")).await?;
        tokio::try_join!(
            async {
                done_clean(reveal(&env, alice, a, &alice_hash, &alice_salt, "ipfs://alice").await?)
            },
            async { done_clean(reveal(&env, bob, b, &bob_hash, &bob_salt, "ipfs://bob").await?) },
        )?;
        advance_to(&env, deadline(&child_b, "reveal_deadline")).await?;
        let picked_a = clean(pick(&env, judge, a, vec![winner(alice, 10_000)]).await?)?;
        let picked_b = clean(pick(&env, judge, b, vec![winner(bob, 10_000)]).await?)?;
        assert_eq!(
            event(&picked_a, "picked")["fee"],
            fee_of(REWARD_A).to_string()
        );
        assert_eq!(
            event(&picked_b, "picked")["fee"],
            fee_of(REWARD_B).to_string()
        );
        assert_eq!(
            vault_balance(&env, alice.id()).await?,
            REWARD_A - fee_of(REWARD_A)
        );
        assert_eq!(
            vault_balance(&env, bob.id()).await?,
            REWARD_B - fee_of(REWARD_B)
        );
        for id in [a, b] {
            assert_eq!(get_task(&env, id).await?["phase"], "settled");
        }

        // (4) The lead assembles the pieces and re-commits the real hash. The sub-tasks are
        // settled and the parent's commit window is still open.
        assert!(now_ns(&env).await? < parent_commit_deadline);
        let assembled = seal(parent, lead.id(), b"alice's piece + bob's piece");
        let r = clean(commit_call(&env, lead, parent, &assembled).await?)?;
        assert_eq!(event(&r, "committed")["replaced"], true);
        let parent_view = get_task(&env, parent).await?;
        assert_eq!(parent_view["commit_count"], 1, "a re-commit replaces");
        assert_eq!(parent_view["phase"], "open");

        // (5) It reveals once the commit window is over, and the judge picks it.
        advance_to(&env, parent_commit_deadline).await?;
        done_clean(
            reveal(
                &env,
                lead,
                parent,
                &assembled.content_hash,
                &assembled.salt,
                "ipfs://assembled",
            )
            .await?,
        )?;
        advance_to(&env, deadline(&parent_view, "reveal_deadline")).await?;
        let r = clean(pick(&env, judge, parent, vec![winner(lead, 10_000)]).await?)?;
        let picked = event(&r, "picked");
        assert_eq!(picked["fee"], fee_of(PARENT_REWARD).to_string());
        assert_eq!(picked["winners"][0]["account"], lead.id().as_str());

        // The margin, from balances that were really read: the lead's vault after the swarm less
        // its vault before the sub-tasks, against the parent's payout after the fee less what
        // the sub-tasks' rewards add up to.
        let lead_after = vault_balance(&env, lead.id()).await?;
        let parent_payout = num(&picked["winners"][0]["amount"]);
        let children_rewards = num(&child_a["reward"]) + num(&child_b["reward"]);
        assert_eq!(parent_payout, PARENT_REWARD - fee_of(PARENT_REWARD));
        assert_eq!(parent_payout, 9_500_000);
        assert_eq!(children_rewards, 5_000_000);
        assert_eq!(lead_after, parent_payout);
        let margin = lead_after as i128 - lead_before as i128;
        assert_eq!(margin, parent_payout as i128 - children_rewards as i128);
        assert_eq!(margin, 4_500_000);

        // The fees of all three tasks reached the treasury, and nothing else moved.
        assert_eq!(
            vault_balance(&env, env.treasury.id()).await?,
            fee_of(PARENT_REWARD) + fee_of(REWARD_A) + fee_of(REWARD_B)
        );
        assert_eq!(get_task(&env, parent).await?["phase"], "settled");
        assert_conserved(&env, &[]).await?;
        Ok(())
    }

    /// The rules of lineage, refused on the node: a parent that does not exist, a poster with no
    /// entry on it, a pick window that outlasts the parent's commit window, and a parent that is
    /// settled. Each refusal leaves Tender's storage byte for byte as it was.
    #[tokio::test]
    async fn lineage_rules_hold_on_the_node() -> anyhow::Result<()> {
        let env = setup(5).await?;
        let (poster, lead) = (&env.poster, &env.carol);
        deposit(&env, poster, PARENT_REWARD).await?;
        deposit(&env, lead, 3 * REWARD_A).await?;
        let mut parent_task = task_json(&env, PARENT_REWARD, env.judge.id(), 1);
        parent_task["commit_secs"] = json!(RULES_COMMIT_SECS);
        let parent = post(&env, poster, parent_task).await?;

        let before = stored(&env).await?;

        // No such parent: not the next id, which would be the child itself, and not 0.
        for id in [parent + 1, 0, 9_999] {
            let r = post_with_gas(&env, lead, child_json(&env, REWARD_A, id)).await?;
            assert_fails_with(&r, "E_PARENT: parent not found");
        }
        // The poster of the parent and its verifier cannot enter it, so cannot name it. Nor can
        // the lead, who has not entered it yet. None of them is asked for its funds first: the
        // verifier has none.
        for who in [poster, &env.judge, lead] {
            let r = post_with_gas(&env, who, child_json(&env, REWARD_A, parent)).await?;
            assert_fails_with(&r, "E_PARENT: poster has no entry on parent");
        }
        assert_eq!(stored(&env).await?, before, "a refusal changes nothing");

        // With an entry, windows that run past the parent's commit deadline are still refused: a
        // commit window as long as the parent's own cannot end its pick window in time.
        commit_work(&env, lead, parent, b"placeholder").await?;
        let before = stored(&env).await?;
        let mut too_slow = child_json(&env, REWARD_A, parent);
        too_slow["commit_secs"] = json!(RULES_COMMIT_SECS);
        let r = post_with_gas(&env, lead, too_slow).await?;
        assert_fails_with(
            &r,
            "E_PARENT: child must settle before parent commit deadline",
        );
        assert_eq!(stored(&env).await?, before, "a refusal changes nothing");

        // The fallback window comes after the pick window, so it is free to be long.
        let mut long_fallback = child_json(&env, REWARD_A, parent);
        long_fallback["fallback_secs"] = json!(RULES_COMMIT_SECS);
        let (id, _) = post_child(&env, lead, long_fallback).await?;
        assert_eq!(get_task(&env, id).await?["parent"], parent.to_string());

        // Once the parent is settled it cannot be named. Nobody entered but the lead, who never
        // revealed, so the parent is voided at its reveal deadline.
        let parent_view = get_task(&env, parent).await?;
        advance_to(&env, deadline(&parent_view, "reveal_deadline")).await?;
        done_clean(void_task(&env, &env.alice, parent).await?)?;
        let before = stored(&env).await?;
        let r = post_with_gas(&env, lead, child_json(&env, REWARD_A, parent)).await?;
        assert_fails_with(&r, "E_PARENT: parent is already settled");
        assert_eq!(stored(&env).await?, before, "a refusal changes nothing");
        assert_conserved(&env, &[]).await?;
        Ok(())
    }
}
