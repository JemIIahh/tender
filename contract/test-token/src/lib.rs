//! NEP-141 + NEP-145 test token for the sandbox and testnet.
//!
//! **Not for mainnet.** `mint` has no access control, so anyone can create tokens. This is the
//! same standard-library fungible token shape that Tender's deposits and withdrawals were
//! validated against on 2026-10-26, plus that one extra method.

use near_contract_standards::fungible_token::{
    FungibleToken, FungibleTokenCore, FungibleTokenResolver,
};
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::json_types::U128;
use near_sdk::{near, AccountId, NearToken, PanicOnDefault, PromiseOrValue};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Token {
    token: FungibleToken,
}

#[near]
impl Token {
    /// Creates the token and registers `owner_id`, who gets all of `total_supply`.
    #[init]
    pub fn new(owner_id: AccountId, total_supply: U128) -> Self {
        let mut this = Self {
            token: FungibleToken::new(b"t".to_vec()),
        };
        this.token.internal_register_account(&owner_id);
        this.token.internal_deposit(&owner_id, total_supply.0);
        this
    }

    /// Creates `amount` new tokens in `account_id`'s balance and adds them to the total supply.
    ///
    /// Anyone can call it, for any account. That is the point of a test token, and the reason it
    /// must never be deployed where its tokens have value. `account_id` must be registered
    /// already (`storage_deposit`), as for any transfer, or the call panics.
    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        self.token.internal_deposit(&account_id, amount.0);
    }
}

#[near]
impl FungibleTokenCore for Token {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for Token {
    #[private]
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        let (used, _burned) =
            self.token
                .internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        used.into()
    }
}

#[near]
impl StorageManagement for Token {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        self.token.internal_storage_unregister(force).is_some()
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[cfg(test)]
mod tests {
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    use super::*;

    /// A token whose owner is `accounts(0)`, called by `accounts(1)`.
    fn token_called_by_stranger() -> Token {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(accounts(0))
            .build());
        let token = Token::new(accounts(0), U128(0));
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(accounts(1))
            .build());
        token
    }

    #[test]
    fn mint_credits_a_registered_account() {
        let mut t = token_called_by_stranger();
        t.token.internal_register_account(&accounts(2));
        t.mint(accounts(2), U128(5));
        assert_eq!(t.ft_balance_of(accounts(2)), U128(5));
        assert_eq!(t.ft_total_supply(), U128(5));
    }

    #[test]
    fn mint_has_no_access_control() {
        // `accounts(1)` is neither the token's owner nor the account that holds the tokens.
        let mut t = token_called_by_stranger();
        t.mint(accounts(0), U128(7));
        assert_eq!(t.ft_balance_of(accounts(0)), U128(7));
    }

    #[test]
    #[should_panic(expected = "is not registered")]
    fn mint_to_an_unregistered_account_panics() {
        let mut t = token_called_by_stranger();
        t.mint(accounts(3), U128(1));
    }
}
