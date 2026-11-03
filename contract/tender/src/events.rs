//! NEP-297 event logging.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde::Serialize;
use near_sdk::{env, serde_json, AccountId, PublicKey};

use crate::types::{PayoutView, TaskView, VoidReason};

const STANDARD: &str = "tender";
const VERSION: &str = "1.0.0";

/// Logs `EVENT_JSON:{"standard":"tender","version":"1.0.0","event":"<event>","data":[<data>]}`.
///
/// The envelope is built with `format!` and only `data` goes through serde, so the fields of an
/// event struct keep their declared order in the log (`serde_json::json!` would sort the keys).
/// `event` is a fixed name chosen by the caller and is not escaped.
pub(crate) fn emit<T: Serialize>(event: &str, data: &T) {
    let data = serde_json::to_string(data)
        .unwrap_or_else(|e| env::panic_str(&format!("event {event} did not serialize: {e}")));
    env::log_str(&format!(
        r#"EVENT_JSON:{{"standard":"{STANDARD}","version":"{VERSION}","event":"{event}","data":[{data}]}}"#
    ));
}

/// Data of `storage_deposit`: `account` was credited `amount` and now holds `total` in all
/// (yoctoNEAR, as strings).
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub(crate) struct StorageDeposit {
    pub account: AccountId,
    pub amount: U128,
    pub total: U128,
}

/// Data of `deposit`: `account` was credited `amount` of `token`, sent by `sender` (who differs
/// from `account` when the deposit named a beneficiary).
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub(crate) struct Deposit {
    pub account: AccountId,
    pub token: AccountId,
    pub amount: U128,
    pub sender: AccountId,
}

/// Data of `withdraw` and `withdraw_failed`: `amount` of `token` was debited from `account` to be
/// paid to `to`. `withdraw` says the token paid it; `withdraw_failed` says it did not and the
/// amount is back in `account`'s vault.
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub(crate) struct Withdraw {
    pub account: AccountId,
    pub token: AccountId,
    pub amount: U128,
    pub to: AccountId,
}

/// Data of `agent_registered`: `account` created its profile (`updated: false`) or replaced it
/// (`updated: true`). `asp` is `null` when the account has none, and `profile_hash` is 64
/// lowercase hex characters.
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub(crate) struct AgentRegistered {
    pub account: AccountId,
    pub asp: Option<AccountId>,
    pub profile_uri: String,
    pub profile_hash: String,
    pub tags: Vec<String>,
    pub updated: bool,
}

/// Data of `agent_bonded`: `account`, registering, paid `amount` of `token` (a decimal string) out
/// of its vault as its bond, which the contract holds until `claim_agent_bond`. Logged right after
/// that registration's `agent_registered`, and only when a bond was taken.
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub(crate) struct AgentBonded {
    pub account: AccountId,
    pub token: AccountId,
    pub amount: U128,
}

/// Data of `agent_unregistering`: `account` called `unregister_agent`, so it makes no new entries
/// in open tasks, and its bond is claimable from `claimable_at` (nanoseconds, a decimal string).
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub(crate) struct AgentUnregistering {
    pub account: AccountId,
    pub claimable_at: U64,
}

/// Data of `agent_bond_claimed`: `account`'s bond, `amount` of `token` (a decimal string), is back
/// in its vault, and the agent has retired. An agent that registered before the owner set any
/// bond had none: `token` is then `null` and `amount` is `"0"`.
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub(crate) struct AgentBondClaimed {
    pub account: AccountId,
    pub token: Option<AccountId>,
    pub amount: U128,
}

/// Data of `task_created`: the new task as `get_task` shows it, in the same field order, minus
/// `commit_count`, `reveal_count`, `cleaned`, `funders`, `outcome` and `phase`. At posting those
/// hold nothing an indexer needs (the only funder is the poster, for the whole `reward`), and all
/// but `funders` change later without this event.
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub(crate) struct TaskCreated {
    pub id: U64,
    pub poster: AccountId,
    pub token: AccountId,
    pub reward: U128,
    pub fee_bps: u16,
    pub brief_uri: String,
    pub brief_hash: String,
    pub criteria_hash: String,
    pub heldout_commitment: Option<String>,
    pub verifier: AccountId,
    pub created_at: U64,
    pub commit_deadline: U64,
    pub reveal_deadline: U64,
    pub pick_deadline: U64,
    pub fallback_deadline: U64,
    pub max_entries: u32,
    pub max_winners: u8,
    pub invited: Vec<AccountId>,
    pub parent: Option<U64>,
}

impl From<TaskView> for TaskCreated {
    fn from(view: TaskView) -> Self {
        // No `..`: a field added to `TaskView` is a compile error here until the event takes it
        // or drops it on purpose.
        let TaskView {
            id,
            poster,
            token,
            reward,
            fee_bps,
            brief_uri,
            brief_hash,
            criteria_hash,
            heldout_commitment,
            verifier,
            created_at,
            commit_deadline,
            reveal_deadline,
            pick_deadline,
            fallback_deadline,
            max_entries,
            max_winners,
            invited,
            parent,
            commit_count: _,
            reveal_count: _,
            cleaned: _,
            funders: _,
            outcome: _,
            phase: _,
        } = view;
        Self {
            id,
            poster,
            token,
            reward,
            fee_bps,
            brief_uri,
            brief_hash,
            criteria_hash,
            heldout_commitment,
            verifier,
            created_at,
            commit_deadline,
            reveal_deadline,
            pick_deadline,
            fallback_deadline,
            max_entries,
            max_winners,
            invited,
            parent,
        }
    }
}

/// Data of `task_topped_up`: `funder` added `amount` to the escrow of task `task_id`, which now
/// holds `reward` in all, in the task's token. The amounts and the id are decimal strings.
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub(crate) struct TaskToppedUp {
    pub task_id: U64,
    pub funder: AccountId,
    pub amount: U128,
    pub reward: U128,
}

/// Data of `delegate_added`: `account` registered `public_key` (NEAR's text form, such as
/// `ed25519:<base58>`) as a delegate key that may spend its vault in `token`, at most
/// `per_task_cap` per `post_task` or `top_up_task` call (a per-call cap, whatever the name says)
/// and `total_cap` in all (decimal strings). It replaces any caps the key had.
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub(crate) struct DelegateAdded {
    pub account: AccountId,
    pub public_key: PublicKey,
    pub token: AccountId,
    pub per_task_cap: U128,
    pub total_cap: U128,
}

/// Data of `delegate_removed`: `account` took back the caps of its delegate key `public_key`.
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub(crate) struct DelegateRemoved {
    pub account: AccountId,
    pub public_key: PublicKey,
}

/// Data of `committed`: `account` entered task `task_id` with `commitment` (`replaced: false`), or
/// replaced the commitment it entered with (`replaced: true`), at block `block_height`. The
/// commitment is 64 lowercase hex characters; the id and the height are decimal strings.
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub(crate) struct EntryCommitted {
    pub task_id: U64,
    pub account: AccountId,
    pub commitment: String,
    pub replaced: bool,
    pub block_height: U64,
}

/// Data of `revealed`: `account` revealed its entry in task `task_id`. The work is at `uri`, and
/// `content_hash` is its SHA-256 as 64 lowercase hex characters.
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub(crate) struct EntryRevealed {
    pub task_id: U64,
    pub account: AccountId,
    pub content_hash: String,
    pub uri: String,
}

/// Data of `picked`: `by` settled task `task_id` by paying each of `winners` its `amount` and the
/// treasury `fee`, all in the task's token. `scorecard_hash` (64 lowercase hex characters) and
/// `scorecard_uri` identify the scorecard behind the pick. The fields after `by` are those of the
/// task's `outcome` as `get_task` shows it, minus `kind`.
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub(crate) struct TaskPicked {
    pub task_id: U64,
    pub by: AccountId,
    pub winners: Vec<PayoutView>,
    pub fee: U128,
    pub scorecard_hash: String,
    pub scorecard_uri: String,
}

/// Data of `voided`: task `task_id` was voided for `reason`, and each funder in `refunds` got back
/// what it paid in. `by` is the account whose empty pick voided the task (`reason` `no_award`), or
/// `null` when `void_task` did. An empty pick's scorecard is in `scorecard_hash` (64 lowercase hex
/// characters) and `scorecard_uri`; both are `null` after `void_task`. The fields other than
/// `task_id`, `by` and `refunds` are those of the task's `outcome` as `get_task` shows it.
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub(crate) struct TaskVoided {
    pub task_id: U64,
    pub reason: VoidReason,
    pub by: Option<AccountId>,
    pub refunds: Vec<Refund>,
    pub scorecard_hash: Option<String>,
    pub scorecard_uri: Option<String>,
}

/// One refund in `voided`: `amount` of the task's token went back into `account`'s vault.
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub(crate) struct Refund {
    pub account: AccountId,
    pub amount: U128,
}

#[cfg(test)]
mod tests {
    use near_sdk::serde;
    use near_sdk::test_utils::get_logs;
    use near_sdk::testing_env;

    use super::*;
    use crate::test_utils::ctx;

    #[test]
    fn emit_is_nep297() {
        testing_env!(ctx("x.test").build());
        #[derive(serde::Serialize)]
        #[serde(crate = "near_sdk::serde")]
        struct P {
            x: &'static str,
        }
        emit("ping", &P { x: "1" });
        assert_eq!(
            get_logs()[0],
            r#"EVENT_JSON:{"standard":"tender","version":"1.0.0","event":"ping","data":[{"x":"1"}]}"#
        );
    }
}
