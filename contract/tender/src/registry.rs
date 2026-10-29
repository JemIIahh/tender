//! The agent registry: profiles, the agent service provider (ASP) that an account's name implies,
//! and the reputation counters that later tasks keep.
//!
//! An agent registers a URI to its profile document, the SHA-256 of that document and a few tags.
//! The contract keeps counters beside them: entries, reveals, wins, earnings, and the picks the
//! agent made as a verifier. Only the contract writes the counters. Registering again replaces the
//! three profile fields and leaves everything else as it was.

use near_sdk::json_types::{U128, U64};
use near_sdk::{env, near, AccountId};

use crate::events::{emit, AgentRegistered};
use crate::types::{
    check_uri, err, hex32, parse_hash, AgentProfile, AgentView, TokenBalance, MAX_TAGS, MAX_TAG_LEN,
};
use crate::{Tender, TenderExt};

/// The ASP of `account` (spec 6.5): its parent, if the parent has at least two labels.
///
/// `bot1.acme.near` has `acme.near`. `alice.near` and `alice.tg` have none, because `near` and
/// `tg` are top-level accounts, not providers. An implicit account (64 hex characters, or `0x`
/// and 40) has no dot, so it has none either. Only a parent can create a sub-account, so a name
/// cannot claim a provider that did not make it.
pub(crate) fn asp_of(account: &AccountId) -> Option<AccountId> {
    let (_, parent) = account.as_str().split_once('.')?;
    if !parent.contains('.') {
        return None;
    }
    parent.parse().ok()
}

/// Panics `E_TAGS` unless there are at most `MAX_TAGS` tags and each is 1 to `MAX_TAG_LEN`
/// characters from `a-z`, `0-9` and `-`.
fn check_tags(tags: &[String]) {
    if tags.len() > MAX_TAGS {
        env::panic_str(&format!(
            "{}: at most {MAX_TAGS} tags, got {}",
            err::E_TAGS,
            tags.len()
        ));
    }
    for (i, tag) in tags.iter().enumerate() {
        // A tag with a non-ASCII character fails the alphabet test, so the byte length checked
        // here is the character length of every tag that passes.
        let well_formed = (1..=MAX_TAG_LEN).contains(&tag.len())
            && tag
                .bytes()
                .all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'-'));
        if !well_formed {
            env::panic_str(&format!(
                "{}: tag {i} must be 1 to {MAX_TAG_LEN} characters from a-z, 0-9 and -",
                err::E_TAGS
            ));
        }
    }
}

impl AgentProfile {
    fn view(&self, account: &AccountId) -> AgentView {
        AgentView {
            account: account.clone(),
            asp: self.asp.clone(),
            profile_uri: self.profile_uri.clone(),
            profile_hash: hex32(&self.profile_hash),
            tags: self.tags.clone(),
            registered_at: U64(self.registered_at),
            entries: self.entries,
            reveals: self.reveals,
            wins: self.wins,
            earned: self
                .earned
                .iter()
                .map(|(token, amount)| TokenBalance {
                    token: token.clone(),
                    amount: U128(*amount),
                })
                .collect(),
            picks_made: self.picks_made,
            voids_after_reveals: self.voids_after_reveals,
        }
    }
}

#[near]
impl Tender {
    /// Creates the caller's agent profile, or replaces its `profile_uri`, `profile_hash` and
    /// `tags`. `profile_uri` is 1 to 256 bytes (`E_URI`), `profile_hash` is 64 lowercase hex
    /// characters (`E_HASH`), and `tags` has at most 8 entries of 1 to 24 characters from `a-z`,
    /// `0-9` and `-` (`E_TAGS`).
    ///
    /// The caller pays for the profile out of its storage balance, so it must have called
    /// `storage_deposit` (`E_STORAGE`). An update is charged only for growth, and gives back what
    /// it shrank by.
    ///
    /// The first registration records the time and the ASP, the account's provider (`acme.near`
    /// for `bot1.acme.near`, see `asp_of`). An update keeps both, along with every counter and
    /// `earned`. Emits `agent_registered`.
    pub fn register_agent(&mut self, profile_uri: String, profile_hash: String, tags: Vec<String>) {
        check_uri("profile_uri", &profile_uri);
        let hash = parse_hash(&profile_hash);
        check_tags(&tags);

        let caller = env::predecessor_account_id();
        let before = self.storage_mark();
        let (asp, updated) = match self.agents.get_mut(&caller) {
            Some(profile) => {
                profile.profile_uri = profile_uri.clone();
                profile.profile_hash = hash;
                profile.tags = tags.clone();
                (profile.asp.clone(), true)
            }
            None => {
                let asp = asp_of(&caller);
                self.agents.insert(
                    caller.clone(),
                    AgentProfile {
                        profile_uri: profile_uri.clone(),
                        profile_hash: hash,
                        tags: tags.clone(),
                        asp: asp.clone(),
                        registered_at: env::block_timestamp(),
                        entries: 0,
                        reveals: 0,
                        wins: 0,
                        earned: vec![],
                        picks_made: 0,
                        voids_after_reveals: 0,
                    },
                );
                (asp, false)
            }
        };
        self.settle_storage(&caller, before);
        emit(
            "agent_registered",
            &AgentRegistered {
                account: caller,
                asp,
                profile_uri,
                profile_hash: hex32(&hash),
                tags,
                updated,
            },
        );
    }

    /// The profile and reputation of `account_id`, or `None` if it has not registered.
    pub fn get_agent(&self, account_id: AccountId) -> Option<AgentView> {
        self.agents
            .get(&account_id)
            .map(|profile| profile.view(&account_id))
    }
}

impl Tender {
    /// Runs `f` on the profile of `account`. It does nothing, and `f` does not run, if `account`
    /// has not registered.
    ///
    /// This does not settle storage. An edit that grows the profile belongs inside a caller's
    /// `storage_mark` and `settle_storage` window, and the caller chooses who pays.
    pub(crate) fn with_profile(&mut self, account: &AccountId, f: impl FnOnce(&mut AgentProfile)) {
        if let Some(profile) = self.agents.get_mut(account) {
            f(profile);
        }
    }

    /// Gives `account` a zero `earned` entry for `token` if it has none. It does nothing if
    /// `account` has not registered.
    ///
    /// The entry takes storage, and this does not settle it: the caller's `storage_mark` and
    /// `settle_storage` window pays, as with `ensure_vault_slot`.
    pub(crate) fn ensure_earned_slot(&mut self, account: &AccountId, token: &AccountId) {
        let missing = self
            .agents
            .get(account)
            .is_some_and(|profile| profile.earned.iter().all(|(t, _)| t != token));
        if missing {
            self.with_profile(account, |profile| profile.earned.push((token.clone(), 0)));
        }
    }
}

#[cfg(test)]
mod tests {
    use near_sdk::json_types::{U128, U64};
    use near_sdk::serde_json;
    use near_sdk::test_utils::get_logs;
    use near_sdk::{borsh, env, testing_env, AccountId, NearToken};

    use super::asp_of;
    use crate::test_utils::{ctx, fresh, panic_message};
    use crate::types::{AgentView, TokenBalance};
    use crate::Tender;

    const URI: &str = "https://acme.example/agents/bot1.json";
    const HASH: &str = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";
    const OTHER_HASH: &str = "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae";
    const USDC: &str = "usdc.test";
    /// A nanosecond timestamp above 2^53, which a JSON number could not carry.
    const T1: u64 = 1_793_028_278_935_742_660;
    const DAY_NS: u64 = 86_400_000_000_000;

    fn acct(id: &str) -> AccountId {
        id.parse().unwrap()
    }

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|&s| s.to_string()).collect()
    }

    fn byte_cost() -> u128 {
        env::storage_byte_cost().as_yoctonear()
    }

    /// A contract in which each of `who` has a storage balance of 0.05 NEAR and nothing else is
    /// stored.
    fn world(who: &[&str]) -> Tender {
        let mut t = fresh();
        for &w in who {
            testing_env!(ctx(w)
                .attached_deposit(NearToken::from_millinear(50))
                .build());
            t.storage_deposit(None);
        }
        t
    }

    /// Makes `who` the caller at `now` nanoseconds.
    fn call_as(who: &str, now: u64) {
        testing_env!(ctx(who).block_timestamp(now).build());
    }

    /// `who` registers, or updates, with the default hash.
    fn register(t: &mut Tender, who: &str, uri: &str, tags: &[&str]) {
        call_as(who, T1);
        t.register_agent(uri.to_string(), HASH.to_string(), strings(tags));
    }

    fn used(t: &Tender, who: &str) -> u64 {
        t.storage_balance_of(acct(who))
            .expect("has a storage balance")
            .used_bytes
            .0
    }

    fn event(data: &str) -> String {
        format!(
            r#"EVENT_JSON:{{"standard":"tender","version":"1.0.0","event":"agent_registered","data":[{data}]}}"#
        )
    }

    /// `alice.near` registers. `Err` holds the panic message if the call is rejected.
    fn try_register(
        t: &mut Tender,
        uri: &str,
        hash: &str,
        tags: Vec<String>,
    ) -> Result<(), String> {
        call_as("alice.near", T1);
        match panic_message(|| t.register_agent(uri.to_string(), hash.to_string(), tags)) {
            Some(message) => Err(message),
            None => Ok(()),
        }
    }

    // ASP derivation.

    #[test]
    fn asp_vectors() {
        let a = |s: &str| asp_of(&s.parse().unwrap()).map(|x| x.to_string());
        assert_eq!(a("bot1.acme.near").as_deref(), Some("acme.near"));
        assert_eq!(a("alice.near"), None);
        assert_eq!(a("alice.tg"), None);
        assert_eq!(a("bot.alice.tg").as_deref(), Some("alice.tg"));
        assert_eq!(a("a.b.c.testnet").as_deref(), Some("b.c.testnet"));
        assert_eq!(a(&"f".repeat(64)), None);
        assert_eq!(a("0x52908400098527886e0f7030069857d2e4169ee7"), None);
    }

    #[test]
    fn asp_edge_cases() {
        let a = |s: &str| asp_of(&s.parse().unwrap()).map(|x| x.to_string());
        // The shortest names with and without a provider.
        assert_eq!(a("a.b"), None);
        assert_eq!(a("x.y.z").as_deref(), Some("y.z"));
        // Only the first label is dropped, however deep the name goes.
        assert_eq!(a("w.x.y.z").as_deref(), Some("x.y.z"));
        // The longest parent that a 64-character account can have: 62 characters.
        let longest = format!("a.{}.near", "b".repeat(57));
        assert_eq!(longest.len(), 64);
        assert_eq!(a(&longest), Some(format!("{}.near", "b".repeat(57))));
        // A long top-level parent is still top-level.
        assert_eq!(a(&format!("{}.{}", "a".repeat(30), "b".repeat(33))), None);
    }

    // Registering.

    #[test]
    fn register_charges_storage_and_emits() {
        let mut t = world(&["bot1.acme.near"]);
        let bot = acct("bot1.acme.near");
        let start = used(&t, "bot1.acme.near");

        call_as("bot1.acme.near", T1);
        let usage = t.storage_mark();
        t.register_agent(
            URI.to_string(),
            HASH.to_string(),
            strings(&["research", "web3"]),
        );
        let grown = env::storage_usage() - usage;

        // The record: 40 bytes of overhead, the key (a 1-byte prefix, a 4-byte length and the
        // account id) and the Borsh value.
        let value = borsh::to_vec(t.agents.get(&bot).unwrap()).unwrap().len() as u64;
        assert_eq!(grown, 40 + 1 + 4 + bot.as_str().len() as u64 + value);
        // The caller pays for all of it.
        assert_eq!(used(&t, "bot1.acme.near"), start + grown);

        assert_eq!(
            get_logs(),
            [event(&format!(
                r#"{{"account":"bot1.acme.near","asp":"acme.near","profile_uri":"{URI}","profile_hash":"{HASH}","tags":["research","web3"],"updated":false}}"#
            ))]
        );
        assert_eq!(
            t.get_agent(bot),
            Some(AgentView {
                account: acct("bot1.acme.near"),
                asp: Some(acct("acme.near")),
                profile_uri: URI.to_string(),
                profile_hash: HASH.to_string(),
                tags: strings(&["research", "web3"]),
                registered_at: U64(T1),
                entries: 0,
                reveals: 0,
                wins: 0,
                earned: vec![],
                picks_made: 0,
                voids_after_reveals: 0,
            })
        );
    }

    #[test]
    fn an_account_without_a_provider_registers_with_a_null_asp() {
        let mut t = world(&["alice.near"]);
        register(&mut t, "alice.near", URI, &[]);
        assert_eq!(
            get_logs(),
            [event(&format!(
                r#"{{"account":"alice.near","asp":null,"profile_uri":"{URI}","profile_hash":"{HASH}","tags":[],"updated":false}}"#
            ))]
        );
        assert_eq!(t.get_agent(acct("alice.near")).unwrap().asp, None);
    }

    #[test]
    fn get_agent_is_none_before_registration() {
        // alice has a storage balance but no profile.
        let t = world(&["alice.near"]);
        assert_eq!(t.get_agent(acct("alice.near")), None);
        assert_eq!(t.get_agent(acct("nobody.near")), None);
    }

    #[test]
    fn agent_view_json_uses_strings_and_hex() {
        let mut t = world(&["bot1.acme.near"]);
        let (bot, usdc) = (acct("bot1.acme.near"), acct(USDC));
        register(&mut t, "bot1.acme.near", URI, &["research"]);
        t.ensure_earned_slot(&bot, &usdc);
        t.with_profile(&bot, |p| {
            p.entries = 3;
            p.reveals = 2;
            p.wins = 1;
            p.earned[0].1 = u128::MAX;
            p.picks_made = 4;
            p.voids_after_reveals = 1;
        });
        assert_eq!(
            serde_json::to_string(&t.get_agent(bot).unwrap()).unwrap(),
            format!(
                r#"{{"account":"bot1.acme.near","asp":"acme.near","profile_uri":"{URI}","profile_hash":"{HASH}","tags":["research"],"registered_at":"1793028278935742660","entries":3,"reveals":2,"wins":1,"earned":[{{"token":"usdc.test","amount":"340282366920938463463374607431768211455"}}],"picks_made":4,"voids_after_reveals":1}}"#
            )
        );
    }

    // A failed receipt still keeps its logs (spec 6.9), so these also check that a rejection
    // emitted no event: the contract logs only after its last check.

    #[test]
    fn register_requires_a_storage_balance() {
        let mut t = fresh();
        call_as("alice.near", T1);
        let rejected =
            panic_message(|| t.register_agent(URI.to_string(), HASH.to_string(), vec![]));
        assert!(rejected.is_some_and(|m| m.contains("E_STORAGE: not registered")));
        assert!(get_logs().is_empty(), "a rejection emits no event");
    }

    #[test]
    fn register_fails_when_the_storage_balance_is_spent() {
        let mut t = world(&["alice.near"]);
        let alice = acct("alice.near");
        let spare = u64::try_from(t.storage_available(&alice) / byte_cost()).unwrap();
        t.reserve_bytes(&alice, spare);
        call_as("alice.near", T1);
        let rejected =
            panic_message(|| t.register_agent(URI.to_string(), HASH.to_string(), vec![]));
        assert!(rejected.is_some_and(|m| m.contains("E_STORAGE: insufficient storage balance")));
        assert!(get_logs().is_empty(), "a rejection emits no event");
    }

    // Updating.

    #[test]
    fn update_keeps_counters() {
        let mut t = world(&["bot1.acme.near"]);
        let (bot, usdc, dai) = (acct("bot1.acme.near"), acct(USDC), acct("dai.test"));
        register(&mut t, "bot1.acme.near", URI, &["research"]);

        // The counters that later tasks bump as the agent works.
        t.ensure_earned_slot(&bot, &usdc);
        t.ensure_earned_slot(&bot, &dai);
        t.with_profile(&bot, |p| {
            p.entries = 5;
            p.reveals = 4;
            p.wins = 2;
            p.earned[0].1 = 1_500_000;
            p.earned[1].1 = u128::MAX;
            p.picks_made = 7;
            p.voids_after_reveals = 1;
        });
        let before = t.get_agent(bot.clone()).unwrap();
        assert_eq!(
            (before.entries, before.reveals, before.wins),
            (5, 4, 2),
            "the premise: the counters are not zero"
        );
        assert_eq!(before.earned.len(), 2);
        assert_eq!(before.registered_at, U64(T1));

        // A day later the agent registers again with a new profile.
        call_as("bot1.acme.near", T1 + DAY_NS);
        t.register_agent(
            "ipfs://bafy-new-profile".to_string(),
            OTHER_HASH.to_string(),
            strings(&["coding", "web3"]),
        );
        assert_eq!(
            get_logs(),
            [event(&format!(
                r#"{{"account":"bot1.acme.near","asp":"acme.near","profile_uri":"ipfs://bafy-new-profile","profile_hash":"{OTHER_HASH}","tags":["coding","web3"],"updated":true}}"#
            ))]
        );

        // The three profile fields are replaced. Everything else is as it was, including
        // `registered_at`.
        assert_eq!(
            t.get_agent(bot).unwrap(),
            AgentView {
                profile_uri: "ipfs://bafy-new-profile".to_string(),
                profile_hash: OTHER_HASH.to_string(),
                tags: strings(&["coding", "web3"]),
                ..before
            }
        );
    }

    #[test]
    fn update_keeps_the_stored_asp() {
        let mut t = world(&["bot1.acme.near"]);
        let bot = acct("bot1.acme.near");
        register(&mut t, "bot1.acme.near", URI, &[]);
        // The name implies `acme.near`. Make the stored value differ, so that an update which
        // worked it out afresh would show.
        t.with_profile(&bot, |p| p.asp = Some(acct("legacy.near")));

        call_as("bot1.acme.near", T1 + DAY_NS);
        t.register_agent(URI.to_string(), OTHER_HASH.to_string(), vec![]);
        assert_eq!(t.get_agent(bot).unwrap().asp, Some(acct("legacy.near")));
        // The event shows the profile, so the directory agrees with the view.
        assert_eq!(
            get_logs(),
            [event(&format!(
                r#"{{"account":"bot1.acme.near","asp":"legacy.near","profile_uri":"{URI}","profile_hash":"{OTHER_HASH}","tags":[],"updated":true}}"#
            ))]
        );
    }

    #[test]
    fn update_charges_growth_and_refunds_shrinkage() {
        let mut t = world(&["alice.near"]);
        register(&mut t, "alice.near", &"u".repeat(100), &["web3"]);
        let base = used(&t, "alice.near");

        // 50 more bytes of URI cost 50 bytes, and the runtime agrees.
        call_as("alice.near", T1);
        let usage = t.storage_mark();
        t.register_agent("u".repeat(150), HASH.to_string(), strings(&["web3"]));
        assert_eq!(env::storage_usage() - usage, 50);
        assert_eq!(used(&t, "alice.near"), base + 50);

        // 130 bytes fewer give 130 back.
        call_as("alice.near", T1);
        let usage = t.storage_mark();
        t.register_agent("u".repeat(20), HASH.to_string(), strings(&["web3"]));
        assert_eq!(usage - env::storage_usage(), 130);
        assert_eq!(used(&t, "alice.near"), base - 80);
    }

    #[test]
    fn an_update_that_does_not_grow_needs_no_spare_storage() {
        let mut t = world(&["alice.near"]);
        let alice = acct("alice.near");
        register(&mut t, "alice.near", &"u".repeat(100), &[]);
        // Spend every byte the balance covers.
        let spare = u64::try_from(t.storage_available(&alice) / byte_cost()).unwrap();
        t.reserve_bytes(&alice, spare);
        assert_eq!(t.storage_available(&alice), 0);

        // The same size charges nothing.
        register(&mut t, "alice.near", &"v".repeat(100), &[]);
        // A smaller one gives the difference back, and no more.
        register(&mut t, "alice.near", &"v".repeat(60), &[]);
        assert_eq!(t.storage_available(&alice), 40 * byte_cost());
        // Growing back into what was freed works. One byte past it does not.
        register(&mut t, "alice.near", &"v".repeat(100), &[]);
        assert_eq!(t.storage_available(&alice), 0);
        call_as("alice.near", T1);
        let rejected =
            panic_message(|| t.register_agent("v".repeat(101), HASH.to_string(), vec![]));
        assert!(
            rejected.is_some_and(|m| m.contains("E_STORAGE: insufficient storage balance")),
            "growing by one byte with nothing spare must be rejected"
        );
        assert!(get_logs().is_empty(), "a rejection emits no event");
    }

    // Validation.

    #[test]
    #[should_panic(expected = "E_URI")]
    fn uri_rejected_when_too_long() {
        let mut t = world(&["alice.near"]);
        register(&mut t, "alice.near", &"u".repeat(257), &[]);
    }

    #[test]
    fn uri_length_is_counted_in_bytes() {
        let mut t = world(&["alice.near"]);
        let alice = acct("alice.near");
        for (what, uri, accepted) in [
            ("an empty uri", String::new(), false),
            ("256 bytes", "u".repeat(256), true),
            ("257 bytes", "u".repeat(257), false),
            ("128 two-byte characters", "é".repeat(128), true),
            ("129 two-byte characters", "é".repeat(129), false),
        ] {
            let result = try_register(&mut t, &uri, HASH, vec![]);
            if accepted {
                assert_eq!(result, Ok(()), "{what}");
                assert_eq!(
                    t.get_agent(alice.clone()).unwrap().profile_uri,
                    uri,
                    "{what}"
                );
            } else {
                assert!(result.is_err_and(|m| m.contains("E_URI")), "{what}");
            }
        }
    }

    #[test]
    fn tags_rejected_when_invalid() {
        let mut t = world(&["alice.near"]);
        let start = used(&t, "alice.near");
        let cases = [
            (
                "nine tags",
                strings(&["a", "b", "c", "d", "e", "f", "g", "h", "i"]),
            ),
            ("a 25-character tag", vec!["x".repeat(25)]),
            ("an uppercase tag", strings(&["Research"])),
            ("an empty tag", strings(&[""])),
            ("a space", strings(&["web 3"])),
            ("an underscore", strings(&["web_3"])),
            ("punctuation", strings(&["web3.0"])),
            ("a non-ASCII letter", strings(&["café"])),
            ("a bad tag after a good one", strings(&["research", "Web3"])),
        ];
        for (what, tags) in cases {
            let result = try_register(&mut t, URI, HASH, tags);
            assert!(result.is_err_and(|m| m.contains("E_TAGS")), "{what}");
            assert!(get_logs().is_empty(), "{what}: a rejection emits nothing");
        }
        // Nothing was written along the way.
        assert_eq!(t.get_agent(acct("alice.near")), None);
        assert_eq!(used(&t, "alice.near"), start);
    }

    #[test]
    fn tags_at_the_limits_are_accepted() {
        let mut t = world(&["alice.near"]);
        let longest = "a1-".repeat(8);
        assert_eq!(longest.len(), 24);
        for tags in [
            vec![],
            vec![longest],
            strings(&["0", "-", "web3", "ai-agent", "a", "b", "c", "d"]),
        ] {
            assert_eq!(try_register(&mut t, URI, HASH, tags.clone()), Ok(()));
            assert_eq!(t.get_agent(acct("alice.near")).unwrap().tags, tags);
        }
    }

    #[test]
    fn hash_rejected_unless_lowercase_hex() {
        let mut t = world(&["alice.near"]);
        let bad = [
            HASH.to_uppercase(),
            HASH[..63].to_string(),
            format!("{HASH}0"),
            format!("g{}", &HASH[1..]),
            format!("0x{}", &HASH[2..]),
            String::new(),
        ];
        for hash in bad {
            let result = try_register(&mut t, URI, &hash, vec![]);
            assert!(result.is_err_and(|m| m.contains("E_HASH")), "hash {hash:?}");
        }
        assert_eq!(t.get_agent(acct("alice.near")), None);
    }

    // The helpers that later tasks call.

    #[test]
    fn with_profile_is_a_no_op_when_unregistered() {
        // alice has a storage balance but no profile.
        let mut t = world(&["alice.near"]);
        let alice = acct("alice.near");
        let usage = t.storage_mark();
        let mut ran = false;
        t.with_profile(&alice, |_| ran = true);
        assert!(!ran, "there is no profile to hand to the closure");
        assert_eq!(t.get_agent(alice), None, "no profile was made");
        assert_eq!(t.storage_mark(), usage, "nothing was written");
    }

    #[test]
    fn with_profile_edits_a_registered_profile() {
        let mut t = world(&["alice.near", "bob.near"]);
        let (alice, bob) = (acct("alice.near"), acct("bob.near"));
        register(&mut t, "alice.near", URI, &[]);
        register(&mut t, "bob.near", URI, &[]);
        t.with_profile(&alice, |p| {
            p.entries += 1;
            p.entries += 1;
            p.wins += 1;
        });
        let alice_view = t.get_agent(alice).unwrap();
        assert_eq!((alice_view.entries, alice_view.wins), (2, 1));
        // Only the named account changes.
        assert_eq!(t.get_agent(bob).unwrap().entries, 0);
    }

    #[test]
    fn ensure_earned_slot_adds_a_zero_slot_once() {
        let mut t = world(&["alice.near"]);
        let (alice, usdc, dai) = (acct("alice.near"), acct(USDC), acct("dai.test"));
        register(&mut t, "alice.near", URI, &[]);
        let earned = |t: &Tender| t.get_agent(alice.clone()).unwrap().earned;
        let slot = |token: &AccountId, amount: u128| TokenBalance {
            token: token.clone(),
            amount: U128(amount),
        };
        assert_eq!(earned(&t), vec![]);

        t.ensure_earned_slot(&alice, &usdc);
        assert_eq!(earned(&t), vec![slot(&usdc, 0)]);

        // A slot that exists is left alone, and keeps what it holds.
        t.with_profile(&alice, |p| p.earned[0].1 = 42);
        t.ensure_earned_slot(&alice, &usdc);
        assert_eq!(earned(&t), vec![slot(&usdc, 42)]);

        // Another token gets its own slot, after the first.
        t.ensure_earned_slot(&alice, &dai);
        assert_eq!(earned(&t), vec![slot(&usdc, 42), slot(&dai, 0)]);
    }

    #[test]
    fn ensure_earned_slot_is_a_no_op_when_unregistered() {
        // alice has a storage balance but no profile.
        let mut t = world(&["alice.near"]);
        let alice = acct("alice.near");
        let usage = t.storage_mark();
        t.ensure_earned_slot(&alice, &acct(USDC));
        assert_eq!(t.get_agent(alice), None, "no profile was made");
        assert_eq!(t.storage_mark(), usage, "nothing was written");
    }

    #[test]
    fn the_window_that_adds_an_earned_slot_pays_for_it() {
        let mut t = world(&["alice.near"]);
        let alice = acct("alice.near");
        register(&mut t, "alice.near", URI, &[]);
        let start = used(&t, "alice.near");

        // A caller's window: mark, add the slot, then settle against whoever pays.
        let before = t.storage_mark();
        t.ensure_earned_slot(&alice, &acct(USDC));
        assert_eq!(
            used(&t, "alice.near"),
            start,
            "ensure_earned_slot does not settle storage itself"
        );
        t.settle_storage(&alice, before);
        // A 4-byte length, the token id and a 16-byte amount.
        assert_eq!(used(&t, "alice.near"), start + 4 + USDC.len() as u64 + 16);
    }
}
