//! Owner configuration and the `get_config` view.

use near_sdk::json_types::U128;
use near_sdk::near;

use crate::types::{ConfigView, TokenConfigView, MAX_WINDOW_SECS};
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

#[cfg(test)]
mod tests {
    use crate::test_utils::fresh;

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
