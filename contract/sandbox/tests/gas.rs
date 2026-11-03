//! Gas on the built wasm: what each method burns, in all its receipts, against the budget the plan
//! sets for it. Run with `--nocapture` to see the report; it is pasted into
//! docs/research/S2-toolchain.md.
//!
//! The worst cases are what is measured. There are fifty entrants and every one is a registered
//! agent, so a commit also creates a slot in `earned` and a pick updates the winners' counters.
//! Five of them win. The cleanup goes through fifty entries.

mod common;

use common::*;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::Account;
use serde_json::{json, Value};

const ENTRANTS: usize = 50;
const WINNERS: usize = 5;
/// The gas each of the entrants' calls attaches: 300 Tgas, many times what any of them burns. A
/// transaction may carry up to 1 PGas since nearcore's protocol 83 raised `max_total_prepaid_gas`,
/// and `max_gas()` attaches all of it. The sandbox charges 1 NEAR for 1000 Tgas up front, and
/// refunds what the call does not use, so 1 PGas would take all of an entrant's 1 NEAR.
const TX_GAS: Gas = Gas::from_tgas(300);

/// What a call burnt in all, in Tgas: the transaction and every receipt that followed from it.
fn tgas(r: &ExecutionFinalResult) -> f64 {
    r.total_gas_burnt.as_gas() as f64 / 1e12
}

/// One line of the report.
struct Line {
    call: String,
    tgas: f64,
    /// The budget, in Tgas, which `tgas` has to stay under.
    limit: Option<f64>,
}

#[derive(Default)]
struct Report(Vec<Line>);

impl Report {
    fn add(&mut self, call: &str, r: &ExecutionFinalResult, limit: Option<f64>) {
        self.0.push(Line {
            call: call.to_string(),
            tgas: tgas(r),
            limit,
        });
    }

    /// The most expensive of the calls `results`, which were all of the same method.
    fn add_worst(&mut self, call: &str, results: &[ExecutionFinalResult], limit: Option<f64>) {
        let worst = results.iter().map(tgas).fold(0.0, f64::max);
        let mean = results.iter().map(tgas).sum::<f64>() / results.len() as f64;
        self.0.push(Line {
            call: format!("{call} (worst of {}, mean {mean:.2})", results.len()),
            tgas: worst,
            limit,
        });
    }

    fn print(&self) {
        println!();
        println!("gas report (Tgas burnt by a call and all its receipts)");
        println!("{:<62} {:>7} {:>7}", "call", "burnt", "limit");
        for line in &self.0 {
            let limit = line.limit.map_or("-".to_string(), |l| format!("{l:.0}"));
            println!("{:<62} {:>7.2} {:>7}", line.call, line.tgas, limit);
        }
        println!();
    }

    /// The lines that went over their budget.
    fn over_budget(&self) -> Vec<String> {
        self.0
            .iter()
            .filter_map(|line| match line.limit {
                Some(limit) if line.tgas >= limit => Some(format!(
                    "{} burnt {:.2} Tgas, the budget is under {limit:.0}",
                    line.call, line.tgas
                )),
                _ => None,
            })
            .collect()
    }
}

/// Sends `method` to Tender from each of the accounts `who` at the same time, with `args(i, account)`
/// as the arguments of the `i`th, and returns the results in order. Each account signs with its own
/// key, so these do not collide on a nonce; see the module comment of `common`.
async fn call_each(
    env: &Env,
    who: &[Account],
    method: &str,
    args: impl Fn(usize, &Account) -> Value,
    deposit: NearToken,
) -> anyhow::Result<Vec<ExecutionFinalResult>> {
    let sent = who
        .iter()
        .enumerate()
        .map(|(i, account)| {
            let tx = account
                .call(env.tender.id(), method)
                .args_json(args(i, account))
                .deposit(deposit)
                .gas(TX_GAS);
            async move { anyhow::Ok(tx.transact().await?) }
        })
        .collect();
    let results = all(sent).await?;
    results.into_iter().map(clean).collect()
}

#[tokio::test]
async fn gas_report() -> anyhow::Result<()> {
    let env = setup(5).await?;
    let mut report = Report::default();

    // Fifty entrants: alice, bob and carol, who exist already, and the rest, who need a storage
    // balance at Tender and then a profile.
    let mut entrants = vec![env.alice.clone(), env.bob.clone(), env.carol.clone()];
    entrants.extend(create_entrants(&env, ENTRANTS - 3, 1).await?);
    let newcomers = entrants[3..].to_vec();
    let deposits = call_each(
        &env,
        &newcomers,
        "storage_deposit",
        |_, _| json!({}),
        NearToken::from_millinear(50),
    )
    .await?;
    report.add_worst("storage_deposit, first deposit", &deposits, None);
    let profiles = call_each(
        &env,
        &entrants,
        "register_agent",
        |i, who| {
            json!({
                "profile_uri": format!("ipfs://agent-{i}"),
                "profile_hash": hex(&sha256(who.id().as_bytes())),
                "tags": ["rust"],
            })
        },
        NO_DEPOSIT,
    )
    .await?;
    report.add_worst("register_agent, first registration", &profiles, None);

    // The poster funds two tasks with one deposit: task A, which the entrants enter and five of
    // them win, and task B, which nobody enters and is voided.
    let reward_a = 10_000_000;
    let r = deposit_msg(&env, &env.poster, reward_a + REWARD, "").await?;
    report.add("ft_transfer_call (deposit)", &r, Some(30.0));
    let a_args = json!({ "task": task_json(&env, reward_a, env.judge.id(), WINNERS as u8) });
    let r = clean(call(&env, &env.poster, "post_task", a_args, ONE_YOCTO).await?)?;
    report.add("post_task", &r, None);
    let a: u64 = r.json::<String>()?.parse()?;
    let b = post(
        &env,
        &env.poster,
        task_json(&env, REWARD, env.judge.id(), 1),
    )
    .await?;

    // Fifty commits at once.
    let sealed: Vec<Sealed> = entrants
        .iter()
        .map(|who| seal(a, who.id(), format!("work of {}", who.id()).as_bytes()))
        .collect();
    let commits = call_each(
        &env,
        &entrants,
        "commit",
        |i, who| {
            let commitment = commitment_of(
                a,
                who.id().as_str(),
                &sealed[i].content_hash,
                &sealed[i].salt,
            );
            json!({ "task_id": a.to_string(), "commitment": hex(&commitment) })
        },
        NO_DEPOSIT,
    )
    .await?;
    report.add_worst("commit", &commits, Some(15.0));

    // Fifty reveals at once.
    let task_a = get_task(&env, a).await?;
    advance_to(&env, deadline(&task_a, "commit_deadline")).await?;
    let reveals = call_each(
        &env,
        &entrants,
        "reveal",
        |i, _| {
            json!({
                "task_id": a.to_string(),
                "content_hash": hex(&sealed[i].content_hash),
                "salt": hex(&sealed[i].salt),
                "uri": format!("ipfs://work-{i}"),
            })
        },
        NO_DEPOSIT,
    )
    .await?;
    report.add_worst("reveal", &reveals, Some(15.0));

    // The verifier picks five winners of equal shares.
    advance_to(&env, deadline(&task_a, "reveal_deadline")).await?;
    let winners: Vec<Value> = entrants[..WINNERS]
        .iter()
        .map(|who| winner(who, 10_000 / WINNERS as u16))
        .collect();
    let r = clean(pick(&env, &env.judge, a, winners).await?)?;
    assert_eq!(
        event(&r, "picked")["winners"]
            .as_array()
            .expect("winners is a list")
            .len(),
        WINNERS
    );
    report.add("pick (5 winners)", &r, Some(50.0));

    // And anyone cleans up the fifty entries.
    let r = clean(cleanup(&env, &env.carol, a, 50).await?)?;
    assert_eq!(r.clone().json::<u32>()?, ENTRANTS as u32);
    report.add("cleanup (50 entries)", &r, Some(150.0));

    // Task B has no entries, so it is voided once its reveal window is over.
    let task_b = get_task(&env, b).await?;
    advance_to(&env, deadline(&task_b, "reveal_deadline")).await?;
    let r = clean(void_task(&env, &env.carol, b).await?)?;
    assert_eq!(event(&r, "voided")["reason"], "no_reveals");
    report.add("void_task", &r, Some(50.0));

    // Alice has been paid in the vault. A withdrawal that the token honours...
    let r = clean(withdraw(&env, &env.alice, 1_000, None, Gas::from_tgas(300)).await?)?;
    assert!(r.clone().json::<bool>()?);
    report.add("withdraw (the token pays)", &r, None);
    // ...and one that it refuses, because dave has no account there, so the balance comes back.
    let dave = new_account(&env, "dave").await?;
    let r = withdraw(&env, &env.bob, 1_000, Some(dave.id()), Gas::from_tgas(300)).await?;
    assert!(r.is_success(), "{}", failure_text(&r));
    assert!(!r.clone().json::<bool>()?);
    report.add("withdraw (the token refuses, balance restored)", &r, None);

    // The rest of the methods.
    let r = clean(
        call(
            &env,
            &env.alice,
            "storage_deposit",
            json!({}),
            NearToken::from_millinear(10),
        )
        .await?,
    )?;
    report.add("storage_deposit (top-up)", &r, None);
    let r = clean(
        call(
            &env,
            &env.alice,
            "storage_withdraw",
            json!({ "amount": "1000" }),
            ONE_YOCTO,
        )
        .await?,
    )?;
    report.add("storage_withdraw", &r, None);
    let owner = &env.owner;
    for (method, args) in [
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
        (
            "set_agent_bond",
            json!({ "token": env.token.id(), "amount": "1000" }),
        ),
        ("set_agent_bond_cooldown", json!({ "secs": "60" })),
        ("set_paused", json!({ "paused": false })),
        ("propose_owner", json!({ "new_owner": env.carol.id() })),
    ] {
        let r = clean(call(&env, owner, method, args, ONE_YOCTO).await?)?;
        report.add(method, &r, None);
    }
    let r = clean(call(&env, &env.carol, "accept_owner", json!({}), ONE_YOCTO).await?)?;
    report.add("accept_owner", &r, None);

    report.print();
    let over = report.over_budget();
    assert!(over.is_empty(), "over budget:\n{}", over.join("\n"));
    Ok(())
}
