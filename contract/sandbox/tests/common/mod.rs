//! Shared setup and helpers for the sandbox suites, in three parts: `setup` boots the sandbox and
//! makes accounts and moves chain time, `calls` wraps Tender's methods and views, and `checks`
//! holds what the tests assert about results, events and storage. Everything is re-exported here,
//! so a suite needs only `use common::*;`.
//!
//! Every test boots its own nearcore node and deploys the wasm in `res/`, so it runs the bytes that
//! ship. Build `res/` first with `contract/build.sh`.
//!
//! Chain time moves in two ways. Transactions take a few blocks each, about a second of chain time
//! in all. `advance_to` jumps ahead by up to 200 blocks at a time, about 60 s, and sizes its last
//! jump to the blocks still needed, so it stops within about a block of its target. The task
//! windows are `WINDOW_SECS` long, so a jump to the end of one window lands inside the next and
//! never skips it.
//!
//! Transactions from one key go one after another. near-workspaces numbers a key's transactions when
//! it sends them, and the node applies them in the order they reach it, so several at once from the
//! same key now and then collide (`InvalidNonce`). Different accounts can send in parallel; see `all`.

// Each test binary uses a different part of this module.
#![allow(dead_code)]

mod calls;
mod checks;
mod setup;

pub use calls::*;
pub use checks::*;
pub use setup::*;

use near_workspaces::types::NearToken;
use sha2::{Digest, Sha256};

pub const TENDER_WASM: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../res/tender.wasm");
pub const TOKEN_WASM: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../res/test_token.wasm");

/// The deposit that `assert_one_yocto` and `authorize_spend` ask for.
pub const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
/// The deposit of a method that is not `#[payable]`.
pub const NO_DEPOSIT: NearToken = NearToken::from_yoctonear(0);
/// A reward of 1 token at 6 decimals. The allowlist takes rewards from 1 to 10^12.
pub const REWARD: u128 = 1_000_000;
/// Test units minted to each of the poster, alice, bob and carol.
pub const MINTED: u128 = 1_000_000_000;
/// Length of each of a task's four windows. See the module comment.
pub const WINDOW_SECS: u32 = 120;
/// The protocol fee `setup` configures, in basis points.
pub const FEE_BPS: u16 = 500;

/// The fee a pick takes from `reward` at `FEE_BPS`, rounded down as the contract does.
pub fn fee_of(reward: u128) -> u128 {
    reward * u128::from(FEE_BPS) / 10_000
}

pub fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

/// 64 lowercase hex characters, the form every hash takes in the contract's JSON.
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The commitment that enters `account` in task `task_id` with the work whose SHA-256 is
/// `content_hash`, recomputed the way the contract's `commitment_of` does: the SHA-256 of the
/// Borsh encoding of `(task_id, account, content_hash, salt)`. That is the task id as a
/// little-endian u64, the account id's length as a little-endian u32 and its bytes, then the two
/// 32-byte arrays.
pub fn commitment_of(
    task_id: u64,
    account: &str,
    content_hash: &[u8; 32],
    salt: &[u8; 32],
) -> [u8; 32] {
    let preimage = borsh::to_vec(&(task_id, account, content_hash, salt))
        .expect("a tuple of integers, a string and byte arrays always encodes");
    sha256(&preimage)
}
