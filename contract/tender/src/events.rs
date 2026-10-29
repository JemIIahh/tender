//! NEP-297 event logging.

use near_sdk::json_types::U128;
use near_sdk::serde::Serialize;
use near_sdk::{env, serde_json, AccountId};

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
