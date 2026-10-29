//! Helpers shared by the unit tests of every module.
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
