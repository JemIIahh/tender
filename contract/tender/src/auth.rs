//! Spending authorisation: the gate in front of every method that spends from an account's vault.
//!
//! A spending method (`post_task` now, `top_up_task` with pooled bounties) calls `authorize_spend`
//! before it debits. In P0 the only way through is a call with exactly 1 yoctoNEAR attached. A
//! function-call access key cannot attach a deposit, so only a full-access key gets through, and a
//! leaked function-call key cannot spend at all. Delegate keys with spending caps (spec 6.8) add
//! a second way through here.

use near_sdk::{env, AccountId, NearToken};

use crate::types::err;
use crate::Tender;

impl Tender {
    /// Panics `E_AUTH` unless this call may spend `amount` of `token` from `account`'s vault.
    ///
    /// In P0 that means exactly 1 yoctoNEAR attached, whoever `account` is. The caller passes the
    /// account it is about to debit, which is always the predecessor, never the signer. The
    /// delegate-key path will check `token` and `amount` against the caps registered for
    /// `account` and record what it spends, which is why this takes `&mut self`.
    // `account`, `token` and `amount` are unused until delegate keys; the allow comes off then.
    #[allow(unused_variables)]
    pub(crate) fn authorize_spend(&mut self, account: &AccountId, token: &AccountId, amount: u128) {
        if env::attached_deposit() != NearToken::from_yoctonear(1) {
            env::panic_str(&format!(
                "{}: attach exactly 1 yoctoNEAR or use a delegate key within caps",
                err::E_AUTH
            ));
        }
    }
}
