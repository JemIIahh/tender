//! Owner configuration and the `get_config` view.

use near_sdk::json_types::U128;
use near_sdk::{near, AccountId};

use crate::types::{ConfigView, TokenConfig, TokenConfigView, MAX_WINDOW_SECS};
use crate::{Tender, TenderExt};

#[near]
impl Tender {
    /// The contract's configuration, including the token allowlist.
    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            owner: self.owner.clone(),
            pending_owner: self.pending_owner.clone(),
            treasury: self.treasury.clone(),
            fee_bps: self.fee_bps,
            min_window_secs: self.min_window_secs,
            max_window_secs: MAX_WINDOW_SECS,
            paused: self.paused,
            version: self.version,
            tokens: self
                .tokens
                .iter()
                .map(|(token, c)| TokenConfigView {
                    token: token.clone(),
                    min_reward: U128(c.min_reward),
                    max_reward: U128(c.max_reward),
                    enabled: c.enabled,
                })
                .collect(),
        }
    }
}

impl Tender {
    /// Inserts `token` into the allowlist, or overwrites its limits and `enabled` flag.
    ///
    /// Only the unit tests call it for now. Task 10's owner-only `set_token` will wrap it.
    // No caller outside the tests yet; the allow comes off with `set_token`.
    #[allow(dead_code)]
    pub(crate) fn put_token(&mut self, token: AccountId, cfg: TokenConfig) {
        self.tokens.insert(token, cfg);
    }
}

#[cfg(test)]
mod tests {
    use crate::test_utils::fresh;
    use crate::types::TokenConfig;

    #[test]
    fn put_token_inserts_and_overwrites() {
        let mut t = fresh();
        let cfg = |min_reward, max_reward, enabled| TokenConfig {
            min_reward,
            max_reward,
            enabled,
        };
        t.put_token("usdc.test".parse().unwrap(), cfg(1, 10, true));
        t.put_token("dai.test".parse().unwrap(), cfg(2, 20, false));
        t.put_token("usdc.test".parse().unwrap(), cfg(3, 30, false));
        let tokens = t.get_config().tokens;
        // usdc was overwritten in place, not added twice.
        assert_eq!(tokens.len(), 2);
        assert_eq!(tokens[0].token.as_str(), "usdc.test");
        assert_eq!(
            (
                tokens[0].min_reward.0,
                tokens[0].max_reward.0,
                tokens[0].enabled
            ),
            (3, 30, false)
        );
        assert_eq!(tokens[1].token.as_str(), "dai.test");
        assert_eq!(
            (
                tokens[1].min_reward.0,
                tokens[1].max_reward.0,
                tokens[1].enabled
            ),
            (2, 20, false)
        );
    }

    #[test]
    fn new_sets_config() {
        let c = fresh().get_config();
        assert_eq!(
            (c.fee_bps, c.min_window_secs, c.paused, c.version),
            (500, 60, false, 1)
        );
        assert_eq!(c.max_window_secs, 1_209_600);
    }
}
