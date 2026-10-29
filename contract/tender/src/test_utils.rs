//! Helpers shared by the unit tests of every module.
use std::panic::{catch_unwind, AssertUnwindSafe};

use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

use crate::Tender;

/// A context in which `predecessor` signs and calls the contract deployed at `tender.test`.
pub(crate) fn ctx(predecessor: &str) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.predecessor_account_id(predecessor.parse().unwrap())
        .signer_account_id(predecessor.parse().unwrap())
        .current_account_id("tender.test".parse().unwrap());
    b
}

/// A freshly initialised contract (owner `owner.test`, treasury `treasury.test`, fee 500 bps,
/// min window 60 s). It also installs the context of the owner calling `tender.test`, so a test
/// that needs another caller or a clock value installs its own context after calling this.
pub(crate) fn fresh() -> Tender {
    testing_env!(ctx("owner.test").build());
    Tender::new(
        "owner.test".parse().unwrap(),
        "treasury.test".parse().unwrap(),
        500,
        60,
    )
}

/// The message `f` panicked with, or `None` if it returned.
///
/// A contract panic (`env::panic_str`, `require!`) reaches the test wrapped by the mocked VM:
/// ``called `Result::unwrap()` on an `Err` value: ``, then
/// `HostError(GuestPanic { panic_msg: "<message>" })`. This returns just `<message>`, as the
/// contract wrote it (in `Debug` form, so a quote in it would come back escaped), so a test can
/// check the code it starts with. Any other panic comes back whole.
pub(crate) fn panic_message(f: impl FnOnce()) -> Option<String> {
    let payload = catch_unwind(AssertUnwindSafe(f)).err()?;
    let text = match payload.downcast::<String>() {
        Ok(text) => *text,
        Err(payload) => (*payload.downcast::<&str>().expect("a text panic")).to_string(),
    };
    let inner = text
        .split_once("GuestPanic { panic_msg: \"")
        .and_then(|(_, rest)| rest.strip_suffix("\" })"));
    Some(match inner {
        Some(message) => message.to_string(),
        None => text,
    })
}
