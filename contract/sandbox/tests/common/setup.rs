//! Booting a sandbox with Tender and the test token, the accounts the tests use, and chain time.

use std::future::Future;

use anyhow::{bail, Context};
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{AccessKey, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::json;

use super::*;

/// A running sandbox with Tender and the test token deployed and configured.
#[derive(Clone)]
pub struct Env {
    pub worker: Worker<Sandbox>,
    pub tender: Contract,
    pub token: Contract,
    pub owner: Account,
    pub treasury: Account,
    pub judge: Account,
    pub poster: Account,
    pub alice: Account,
    pub bob: Account,
    pub carol: Account,
}

/// Runs the futures at the same time and returns their results in order, or the first error.
///
/// Each future must send its transactions from a key of its own; see the module comment.
pub async fn all<T, F>(futs: Vec<F>) -> anyhow::Result<Vec<T>>
where
    T: Send + 'static,
    F: Future<Output = anyhow::Result<T>> + Send + 'static,
{
    let handles: Vec<_> = futs.into_iter().map(tokio::spawn).collect();
    let mut out = Vec::with_capacity(handles.len());
    for handle in handles {
        out.push(handle.await.context("a concurrent task panicked")??);
    }
    Ok(out)
}

fn read_wasm(path: &str) -> anyhow::Result<Vec<u8>> {
    std::fs::read(path).with_context(|| format!("cannot read {path}; run contract/build.sh first"))
}

pub async fn create(root: Account, name: &'static str, near: u128) -> anyhow::Result<Account> {
    Ok(root
        .create_subaccount(name)
        .initial_balance(NearToken::from_near(near))
        .transact()
        .await?
        .into_result()?)
}

async fn deploy(account: Account, wasm: Vec<u8>) -> anyhow::Result<Contract> {
    Ok(account.deploy(&wasm).await?.into_result()?)
}

/// Creates a funded account under the sandbox root, with the sandbox's default key.
pub async fn new_account(env: &Env, name: &'static str) -> anyhow::Result<Account> {
    create(env.worker.root_account()?, name, 10).await
}

/// Deploys and initialises Tender and the test token, and prepares the accounts.
///
/// - `owner`, `treasury`, `judge`, `poster`, `alice`, `bob` and `carol` are sub-accounts of the
///   sandbox root, as are the contracts `tender` and `token`.
/// - Tender's `new` is called by the contract account, since it is `#[private]`. Its fee is 500 bps
///   and its shortest window `min_window_secs`.
/// - The seven accounts and `tender` have a storage balance at the token (the owner's comes from
///   the token's `new`). The seven also have 0.1 NEAR of storage balance at Tender, which the
///   owner needs before `set_token`: it charges the owner for the treasury's vault slot.
/// - The token is allowlisted at Tender for rewards of 1 to 10^12, and the poster, alice, bob and
///   carol hold 1_000_000_000 units of it.
/// - alice, bob and carol are registered agents, so they may enter open tasks. No agent bond is
///   set, so they paid none; the cooldown is the contract's default.
pub async fn setup(min_window_secs: u32) -> anyhow::Result<Env> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let tender_wasm = read_wasm(TENDER_WASM)?;
    let token_wasm = read_wasm(TOKEN_WASM)?;

    let names = [
        "tender", "token", "owner", "treasury", "judge", "poster", "alice", "bob", "carol",
    ];
    // The root creates them all, so one after another.
    let mut created = Vec::with_capacity(names.len());
    for name in names {
        let near = if name == "tender" { 30 } else { 10 };
        created.push(create(root.clone(), name, near).await?);
    }
    let [tender, token, owner, treasury, judge, poster, alice, bob, carol]: [Account; 9] = created
        .try_into()
        .map_err(|_| anyhow::anyhow!("created the wrong number of accounts"))?;

    let (tender, token) = tokio::try_join!(deploy(tender, tender_wasm), deploy(token, token_wasm))?;
    let env = Env {
        worker,
        tender,
        token,
        owner,
        treasury,
        judge,
        poster,
        alice,
        bob,
        carol,
    };

    // The owner is registered at the token by `new`, and holds none of it.
    let init_tender = env.tender.call("new").args_json(json!({
        "owner": env.owner.id(),
        "treasury": env.treasury.id(),
        "fee_bps": FEE_BPS,
        "min_window_secs": min_window_secs,
    }));
    let init_token = env
        .token
        .call("new")
        .args_json(json!({ "owner_id": env.owner.id(), "total_supply": "0" }));
    let (init_tender, init_token) =
        tokio::try_join!(init_tender.transact(), init_token.transact())?;
    done(init_tender)?;
    done(init_token)?;

    // Token storage for everyone who can hold the token, and for the contract that will.
    let at_token = vec![
        env.tender.as_account().clone(),
        env.treasury.clone(),
        env.judge.clone(),
        env.poster.clone(),
        env.alice.clone(),
        env.bob.clone(),
        env.carol.clone(),
    ];
    all(at_token
        .into_iter()
        .map(|account| register_at_token(env.token.id().clone(), account))
        .collect())
    .await?;

    // Mint, and give every account its storage balance at Tender. The token account signs the mints,
    // so they go one after another, while the accounts' own deposits go in parallel.
    let mints = async {
        for who in [&env.poster, &env.alice, &env.bob, &env.carol] {
            mint(&env, who.id(), MINTED).await?;
        }
        anyhow::Ok(())
    };
    let at_tender = [
        &env.owner,
        &env.treasury,
        &env.judge,
        &env.poster,
        &env.alice,
        &env.bob,
        &env.carol,
    ]
    .into_iter()
    .map(|who| storage_deposit(&env, who, NearToken::from_millinear(100)))
    .collect();
    tokio::try_join!(mints, all::<(), _>(at_tender))?;

    // alice, bob and carol enter open tasks, which take only registered agents. No bond is set,
    // so registering takes only the 1 yoctoNEAR and the storage.
    all([&env.alice, &env.bob, &env.carol]
        .into_iter()
        .map(|who| register_agent(&env, who))
        .collect())
    .await?;

    // The owner's storage balance exists by now, and `set_token` charges it.
    let r = env
        .owner
        .call(env.tender.id(), "set_token")
        .args_json(json!({
            "token": env.token.id(),
            "min_reward": "1",
            "max_reward": "1000000000000",
            "enabled": true,
        }))
        .deposit(ONE_YOCTO)
        .max_gas()
        .transact()
        .await?;
    done(r)?;
    Ok(env)
}

async fn register_at_token(token: AccountId, who: Account) -> anyhow::Result<()> {
    let r = who
        .call(&token, "storage_deposit")
        .args_json(json!({}))
        .deposit(NearToken::from_millinear(10))
        .max_gas()
        .transact()
        .await?;
    done(r)?;
    Ok(())
}

/// Mints `amount` of the test token to `who`, who must be registered at the token.
pub fn mint(env: &Env, who: &AccountId, amount: u128) -> impl Future<Output = anyhow::Result<()>> {
    let call = env
        .token
        .call("mint")
        .args_json(json!({ "account_id": who, "amount": amount.to_string() }))
        .max_gas();
    async move {
        done(call.transact().await?)?;
        Ok(())
    }
}

/// Registers `who` as an agent with a profile named after it, attaching the 1 yoctoNEAR that
/// `register_agent` takes. `who` needs a storage balance at Tender, and the bond in its vault if
/// one is set.
pub fn register_agent(env: &Env, who: &Account) -> impl Future<Output = anyhow::Result<()>> {
    let call = register_agent_call(env, who);
    async move {
        done(call.await?)?;
        Ok(())
    }
}

/// `register_agent` as `register_agent` sends it: the raw result.
pub fn register_agent_call(
    env: &Env,
    who: &Account,
) -> impl Future<Output = anyhow::Result<ExecutionFinalResult>> {
    let call = who
        .call(env.tender.id(), "register_agent")
        .args_json(json!({
            "profile_uri": format!("https://agents.example/{}.json", who.id()),
            "profile_hash": hex(&sha256(who.id().as_bytes())),
            "tags": ["test"],
        }))
        .deposit(ONE_YOCTO)
        .max_gas();
    async move { Ok(call.transact().await?) }
}

/// Gives `who` a storage balance at Tender of `amount`.
pub fn storage_deposit(
    env: &Env,
    who: &Account,
    amount: NearToken,
) -> impl Future<Output = anyhow::Result<()>> {
    let call = who
        .call(env.tender.id(), "storage_deposit")
        .args_json(json!({}))
        .deposit(amount)
        .max_gas();
    async move {
        done(call.transact().await?)?;
        Ok(())
    }
}

/// Chain time now, in nanoseconds.
pub async fn now_ns(env: &Env) -> anyhow::Result<u64> {
    Ok(env.worker.view_block().await?.timestamp())
}

/// The most blocks `advance_to` jumps at once: about 60 s of chain time.
const MAX_JUMP_BLOCKS: u64 = 200;
/// The chain time a jumped block adds, in nanoseconds, until a jump has measured it: 200 blocks are
/// about 60 s.
const GUESSED_BLOCK_NS: u64 = 300_000_000;

/// Moves chain time to `ns` or just past it.
///
/// Each jump is the blocks still needed at the chain time per block that the jump before it
/// measured, and at most `MAX_JUMP_BLOCKS`. So the last jump lands within about a block of `ns`
/// instead of up to a whole jump past it. The first jump has only a guess to go on, so it goes
/// half the way.
pub async fn advance_to(env: &Env, ns: u64) -> anyhow::Result<()> {
    let mut block_ns = None;
    for _ in 0..1_000 {
        let now = now_ns(env).await?;
        if now >= ns {
            return Ok(());
        }
        let blocks = match block_ns {
            Some(block_ns) => (ns - now).div_ceil(block_ns),
            None => (ns - now) / GUESSED_BLOCK_NS / 2,
        }
        .clamp(1, MAX_JUMP_BLOCKS);
        env.worker.fast_forward(blocks).await?;
        let moved = now_ns(env).await?.saturating_sub(now);
        block_ns = Some((moved / blocks).max(1));
    }
    bail!("chain time never reached {ns}")
}

/// Adds to `who` a function-call key that may call only `methods` on Tender, with no allowance
/// cap, and returns an account that signs with that key.
pub async fn function_call_key(
    env: &Env,
    who: &Account,
    methods: &[&str],
) -> anyhow::Result<Account> {
    let secret = SecretKey::from_random(KeyType::ED25519);
    let key = AccessKey::function_call_access(env.tender.id(), methods, None);
    done(
        who.batch(who.id())
            .add_key(secret.public_key(), key)
            .transact()
            .await?,
    )?;
    Ok(Account::from_secret_key(
        who.id().clone(),
        secret,
        &env.worker,
    ))
}

/// Creates `count` accounts called `e0`, `e1`, and so on, each with `near` NEAR. They are sub-accounts
/// of the seven accounts of `env`, which create theirs at the same time, so that no key signs two
/// creations at once (see the module comment). Each of the seven pays for its share out of the 10
/// NEAR it starts with, so `count / 7 * near` has to stay well under 10. The new accounts have no
/// storage balance at Tender or at the token.
pub async fn create_entrants(env: &Env, count: usize, near: u128) -> anyhow::Result<Vec<Account>> {
    let parents = [
        &env.owner,
        &env.treasury,
        &env.judge,
        &env.poster,
        &env.alice,
        &env.bob,
        &env.carol,
    ];
    let stride = parents.len();
    let batches = parents
        .into_iter()
        .enumerate()
        .map(|(first, parent)| {
            let parent = parent.clone();
            async move {
                let mut made = Vec::new();
                for i in (first..count).step_by(stride) {
                    let account = parent
                        .create_subaccount(&format!("e{i}"))
                        .initial_balance(NearToken::from_near(near))
                        .transact()
                        .await?
                        .into_result()?;
                    made.push((i, account));
                }
                anyhow::Ok(made)
            }
        })
        .collect();
    let mut made: Vec<(usize, Account)> = all(batches).await?.into_iter().flatten().collect();
    made.sort_by_key(|(i, _)| *i);
    Ok(made.into_iter().map(|(_, account)| account).collect())
}
