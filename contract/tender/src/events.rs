//! NEP-297 event logging.

use near_sdk::serde::Serialize;
use near_sdk::{env, serde_json};

const STANDARD: &str = "tender";
const VERSION: &str = "1.0.0";

/// Logs `EVENT_JSON:{"standard":"tender","version":"1.0.0","event":"<event>","data":[<data>]}`.
///
/// The envelope is built with `format!` and only `data` goes through serde, so the fields of an
/// event struct keep their declared order in the log (`serde_json::json!` would sort the keys).
/// `event` is a fixed name chosen by the caller and is not escaped.
// No caller outside the tests yet; the allow comes off with the first one.
#[allow(dead_code)]
pub(crate) fn emit<T: Serialize>(event: &str, data: &T) {
    let data = serde_json::to_string(data)
        .unwrap_or_else(|e| env::panic_str(&format!("event {event} did not serialize: {e}")));
    env::log_str(&format!(
        r#"EVENT_JSON:{{"standard":"{STANDARD}","version":"{VERSION}","event":"{event}","data":[{data}]}}"#
    ));
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
