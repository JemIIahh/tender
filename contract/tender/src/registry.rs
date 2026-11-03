//! The agent registry: profiles, the agent service provider (ASP) that an account's name implies,
//! the reputation counters that later tasks keep, and the refundable registration bond.
//!
//! An agent registers a URI to its profile document, the SHA-256 of that document and a few tags.
//! The contract keeps counters beside them: entries, reveals, wins, earnings, and the picks the
//! agent made as a verifier. Only the contract writes the counters. Registering again replaces the
//! three profile fields and leaves everything else as it was.
//!
//! Registering is deliberately not free (owner decision, 2026-11-03). Once the owner has set a
//! bond (`set_agent_bond`), a new agent pays it out of its vault, and the contract holds it while
//! the agent is active: only an active agent may enter an open task (see `commit`). An agent that
//! leaves calls `unregister_agent`, waits out the cooldown, and `claim_agent_bond` pays exactly the
//! bond it paid back into its vault and retires it. The record and its reputation stay. Each step
//! needs exactly 1 yoctoNEAR, so no function-call or delegate key can take one, and none of them
//! looks at the pause switch.
//!
//! What an agent's bond is never changes while the contract holds it: it is recorded on the agent
//! when it is debited. So the money adds up at all times: the vault balances, the escrow of the
//! unsettled tasks and the bonds on the agent records are together what came in less what went
//! out.

use near_sdk::json_types::{U128, U64};
use near_sdk::{assert_one_yocto, env, near, AccountId};

use crate::events::{emit, AgentRegistered};
use crate::types::{
    check_uri, err, hex32, parse_hash, AgentProfile, AgentStatus, AgentView, TokenBalance,
    MAX_TAGS, MAX_TAG_LEN,
};
use crate::{Tender, TenderExt};

/// Nanoseconds in a second.
const NS_PER_SEC: u64 = 1_000_000_000;

fn not_registered(account: &AccountId, why: &str) -> ! {
    env::panic_str(&format!("{}: {account} {why}", err::E_NOT_REGISTERED))
}

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
    /// Registers the caller as an agent, or replaces its `profile_uri`, `profile_hash` and `tags`.
    /// Requires exactly 1 yoctoNEAR, so a function-call key, a delegate key among them, cannot
    /// register.
    ///
    /// The rules, checked in this order, each with its error code:
    /// - exactly 1 yoctoNEAR is attached (near-sdk's own panic);
    /// - `profile_uri` is 1 to 256 bytes (`E_URI`), `profile_hash` is 64 lowercase hex characters
    ///   (`E_HASH`), and `tags` has at most 8 entries of 1 to 24 characters from `a-z`, `0-9` and
    ///   `-` (`E_TAGS`);
    /// - the caller is not unregistering (`E_PHASE`): it claims its bond first, and then registers
    ///   again;
    /// - a caller that pays a bond holds it in its vault (`E_FUNDS`);
    /// - its storage balance covers what the call adds (`E_STORAGE`).
    ///
    /// The first registration, and the one that brings a retired agent back, take the bond in
    /// force (`set_agent_bond`) from the caller's vault, if the owner has set one, and record it
    /// on the agent: that is what `claim_agent_bond` pays back, whatever the bond is by then. The
    /// agent is active from then on. An active agent's update takes no second bond.
    ///
    /// The caller pays for the profile out of its storage balance, so it must have called
    /// `storage_deposit`. An update is charged only for growth, and gives back what it shrank by.
    ///
    /// The first registration records the time and the ASP, the account's provider (`acme.near`
    /// for `bot1.acme.near`, see `asp_of`). An update, and a return from retirement, keep both,
    /// along with every counter and `earned`. Works while the contract is paused. Emits
    /// `agent_registered`.
    #[payable]
    #[deny_unknown_arguments]
    pub fn register_agent(&mut self, profile_uri: String, profile_hash: String, tags: Vec<String>) {
        assert_one_yocto();
        check_uri("profile_uri", &profile_uri);
        let hash = parse_hash("profile_hash", &profile_hash);
        check_tags(&tags);

        let caller = env::predecessor_account_id();
        let status = self.agents.get(&caller).map(|profile| profile.status);
        if status == Some(AgentStatus::Unregistering) {
            env::panic_str(&format!(
                "{}: {caller} is unregistering; claim its bond with claim_agent_bond, then \
                 register again",
                err::E_PHASE
            ));
        }
        // A new agent, or a retired one coming back, pays the bond in force. An active one has
        // paid already.
        let bond = match status {
            None | Some(AgentStatus::Retired) => self.agent_bond.clone(),
            Some(AgentStatus::Active | AgentStatus::Unregistering) => None,
        };

        let before = self.storage_mark();
        if let Some(bond) = &bond {
            // With the 1 yoctoNEAR asserted above this always lets the spend through. It is called
            // so that every debit of a vault goes through the one gate.
            self.authorize_spend(&caller, &bond.token, bond.amount);
            self.debit(&caller, &bond.token, bond.amount);
        }
        let (asp, updated) = match self.agents.get_mut(&caller) {
            Some(profile) => {
                profile.profile_uri = profile_uri.clone();
                profile.profile_hash = hash;
                profile.tags = tags.clone();
                if profile.status == AgentStatus::Retired {
                    profile.status = AgentStatus::Active;
                    profile.bond = bond;
                }
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
                        status: AgentStatus::Active,
                        bond,
                        unregistering_since: 0,
                        claimable_at: 0,
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

    /// Starts the caller's way out: from now on it can make no new entry in an open task, nor
    /// replace one, and from `claimable_at`, the block time plus the cooldown in force
    /// (`set_agent_bond_cooldown`), `claim_agent_bond` pays its bond back. Requires exactly 1
    /// yoctoNEAR.
    ///
    /// Nothing else changes for it. The entries it has made stand: it can reveal them, be picked
    /// and be paid, so no valid entry is stranded. It still enters a task that invites it, since
    /// the poster chose it. A later change of the cooldown leaves its `claimable_at` as it is.
    ///
    /// The caller must be an active agent: one that has not registered, or has retired, is refused
    /// `E_NOT_REGISTERED`, and one already unregistering `E_PHASE`. The record keeps its size, so
    /// the call needs no spare storage. Works while the contract is paused.
    #[payable]
    #[deny_unknown_arguments]
    pub fn unregister_agent(&mut self) {
        assert_one_yocto();
        let caller = env::predecessor_account_id();
        let now = env::block_timestamp();
        // At most 56 days of nanoseconds, so this cannot overflow.
        let claimable_at =
            now.saturating_add(self.agent_bond_cooldown_secs.saturating_mul(NS_PER_SEC));
        let before = self.storage_mark();
        let Some(profile) = self.agents.get_mut(&caller) else {
            not_registered(&caller, "is not a registered agent")
        };
        match profile.status {
            AgentStatus::Active => {}
            AgentStatus::Unregistering => env::panic_str(&format!(
                "{}: {caller} is unregistering already; its bond is claimable from {}",
                err::E_PHASE,
                profile.claimable_at
            )),
            AgentStatus::Retired => not_registered(&caller, "has retired; register it first"),
        }
        profile.status = AgentStatus::Unregistering;
        profile.unregistering_since = now;
        profile.claimable_at = claimable_at;
        self.settle_storage(&caller, before);
    }

    /// Pays the caller's bond back into its vault, exactly as it was taken at registration, and
    /// retires the agent. Requires exactly 1 yoctoNEAR.
    ///
    /// Allowed from the agent's `claimable_at` on (`E_PHASE` before it, or while the agent is
    /// still active: it unregisters first). One that has not registered, or has retired, which
    /// includes having claimed already, is refused `E_NOT_REGISTERED`. An agent that registered
    /// before the owner set a bond has none to claim, and only retires.
    ///
    /// The record stays, with its profile, counters and `earned`, so the directory keeps its
    /// history; `register_agent` makes it active again with a fresh bond. The record shrinks by
    /// the bond, and the caller gets that storage back. The vault slot the bond came from still
    /// exists, so the call needs no spare storage. Works while the contract is paused.
    #[payable]
    #[deny_unknown_arguments]
    pub fn claim_agent_bond(&mut self) {
        assert_one_yocto();
        let caller = env::predecessor_account_id();
        let now = env::block_timestamp();
        let Some(profile) = self.agents.get(&caller) else {
            not_registered(&caller, "is not a registered agent")
        };
        match profile.status {
            AgentStatus::Unregistering if now >= profile.claimable_at => {}
            AgentStatus::Unregistering => env::panic_str(&format!(
                "{}: {caller}'s bond is claimable from {}, not before",
                err::E_PHASE,
                profile.claimable_at
            )),
            AgentStatus::Active => env::panic_str(&format!(
                "{}: {caller} is active; call unregister_agent first",
                err::E_PHASE
            )),
            AgentStatus::Retired => {
                not_registered(&caller, "has retired; there is no bond to claim")
            }
        }
        let bond = profile.bond.clone();

        let before = self.storage_mark();
        if let Some(bond) = &bond {
            self.credit(&caller, &bond.token, bond.amount);
        }
        if let Some(profile) = self.agents.get_mut(&caller) {
            profile.status = AgentStatus::Retired;
            profile.bond = None;
            profile.unregistering_since = 0;
            profile.claimable_at = 0;
        }
        self.settle_storage(&caller, before);
    }

    /// The profile and reputation of `account_id`, or `None` if it has not registered.
    pub fn get_agent(&self, account_id: AccountId) -> Option<AgentView> {
        self.agents
            .get(&account_id)
            .map(|profile| profile.view(&account_id))
    }
}

impl Tender {
    /// Whether `account` is a registered agent that is active: registered, not unregistering and
    /// not retired. Only such an agent may enter an open task.
    pub(crate) fn is_active_agent(&self, account: &AccountId) -> bool {
        self.agents
            .get(account)
            .is_some_and(|profile| profile.status == AgentStatus::Active)
    }

    /// Runs `f` on the profile of `account`. It does nothing, and `f` does not run, if `account`
    /// has not registered.
    ///
    /// This does not settle storage. An edit that grows the profile belongs inside a caller's
    /// `storage_mark` and `settle_storage` window, and the caller chooses who pays.
    pub(crate) fn with_profile(&mut self, account: &AccountId, f: impl FnOnce(&mut AgentProfile)) {
        // `get` first: `get_mut` marks even a miss as changed, and the flush then removes a key
        // that is not there, which costs gas on every commit, reveal and pick of an account that
        // never registered, and does nothing else.
        if self.agents.get(account).is_none() {
            return;
        }
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
    use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
    use near_sdk::json_types::{U128, U64};
    use near_sdk::serde_json;
    use near_sdk::test_utils::get_logs;
    use near_sdk::{
        borsh, env, testing_env, AccountId, CurveType, NearToken, PromiseOrValue, PublicKey,
    };

    use super::asp_of;
    use crate::test_utils::{ctx, fresh, panic_message};
    use crate::types::{AgentProfile, AgentStatus, AgentView, Bond, TokenBalance};
    use crate::Tender;

    const URI: &str = "https://acme.example/agents/bot1.json";
    const HASH: &str = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";
    const OTHER_HASH: &str = "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae";
    const USDC: &str = "usdc.test";
    /// A nanosecond timestamp above 2^53, which a JSON number could not carry.
    const T1: u64 = 1_793_028_278_935_742_660;
    const DAY_NS: u64 = 86_400_000_000_000;
    const SEC: u64 = 1_000_000_000;
    const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
    const NO_DEPOSIT: NearToken = NearToken::from_yoctonear(0);
    /// What near-sdk's `assert_one_yocto` panics with.
    const ONE_YOCTO_MESSAGE: &str = "Requires attached deposit of exactly 1 yoctoNEAR";
    const OWNER: &str = "owner.test";
    const DAI: &str = "dai.test";
    /// The bond `bonded` sets: 5 USDC.
    const BOND: u128 = 5_000_000;
    /// The cooldown `bonded` sets: an hour.
    const COOLDOWN_SECS: u64 = 3_600;

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
            t.storage_deposit(None, None);
        }
        t
    }

    /// Makes `who` the caller at `now` nanoseconds, with the 1 yoctoNEAR that `register_agent`,
    /// `unregister_agent` and `claim_agent_bond` ask for.
    fn call_as(who: &str, now: u64) {
        testing_env!(ctx(who)
            .block_timestamp(now)
            .attached_deposit(ONE_YOCTO)
            .build());
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
            assert_eq!(
                result,
                Err("E_HASH: profile_hash: expected 64 lowercase hex chars".to_string()),
                "hash {hash:?}"
            );
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

    // The bond: registering takes it, `unregister_agent` and `claim_agent_bond` give it back.

    /// A contract with USDC and DAI allowlisted, a bond of `BOND` USDC and a cooldown of
    /// `COOLDOWN_SECS`; and each of `who` with 0.05 NEAR of storage and `funds` USDC in its vault.
    fn bonded(who: &[&str], funds: u128) -> Tender {
        let mut t = world(&[OWNER]);
        for token in [USDC, DAI] {
            as_owner(&mut t, |t| set_token(t, token));
        }
        as_owner(&mut t, |t| t.set_agent_bond(acct(USDC), U128(BOND)));
        as_owner(&mut t, |t| t.set_agent_bond_cooldown(U64(COOLDOWN_SECS)));
        for &w in who {
            testing_env!(ctx(w)
                .attached_deposit(NearToken::from_millinear(50))
                .build());
            t.storage_deposit(None, None);
            if funds > 0 {
                fund(&mut t, USDC, w, funds);
            }
        }
        t
    }

    fn set_token(t: &mut Tender, token: &str) {
        t.set_token(acct(token), U128(1), U128(50_000_000), true);
    }

    /// The owner calls `f` with 1 yoctoNEAR.
    fn as_owner(t: &mut Tender, f: impl FnOnce(&mut Tender)) {
        testing_env!(ctx(OWNER).attached_deposit(ONE_YOCTO).build());
        f(t);
    }

    /// The token reports a deposit of `amount` for `who`.
    fn fund(t: &mut Tender, token: &str, who: &str, amount: u128) {
        testing_env!(ctx(token).build());
        let unused = t.ft_on_transfer(acct(who), U128(amount), String::new());
        assert!(
            matches!(unused, PromiseOrValue::Value(U128(0))),
            "the deposit is credited"
        );
    }

    fn vault(t: &Tender, who: &str) -> u128 {
        t.balance_of(acct(who), acct(USDC)).0
    }

    fn profile(t: &Tender, who: &str) -> AgentProfile {
        t.agents
            .get(&acct(who))
            .cloned()
            .expect("a registered agent")
    }

    fn usdc_bond(amount: u128) -> Option<Bond> {
        Some(Bond {
            token: acct(USDC),
            amount,
        })
    }

    /// `who` calls `f` at `now` with `deposit`. `Err` holds the panic message.
    fn try_at(
        t: &mut Tender,
        who: &str,
        now: u64,
        deposit: NearToken,
        f: impl FnOnce(&mut Tender),
    ) -> Result<(), String> {
        testing_env!(ctx(who)
            .block_timestamp(now)
            .attached_deposit(deposit)
            .build());
        match panic_message(|| f(t)) {
            Some(message) => Err(message),
            None => Ok(()),
        }
    }

    fn try_register_at(t: &mut Tender, who: &str, now: u64) -> Result<(), String> {
        try_at(t, who, now, ONE_YOCTO, |t| {
            t.register_agent(URI.to_string(), HASH.to_string(), vec![])
        })
    }

    fn try_unregister(t: &mut Tender, who: &str, now: u64) -> Result<(), String> {
        try_at(t, who, now, ONE_YOCTO, Tender::unregister_agent)
    }

    fn try_claim(t: &mut Tender, who: &str, now: u64) -> Result<(), String> {
        try_at(t, who, now, ONE_YOCTO, Tender::claim_agent_bond)
    }

    fn ok(result: Result<(), String>, what: &str) {
        if let Err(message) = result {
            panic!("{what} was refused: {message}");
        }
    }

    /// Asserts that `result` is a rejection with `code` that logged nothing.
    fn assert_rejected(result: Result<(), String>, code: &str, what: &str) {
        let message = result.expect_err(&format!("{what}: expected {code}, but it went through"));
        assert!(
            message.starts_with(&format!("{code}: ")),
            "{what}: expected {code}, got {message:?}"
        );
        assert!(get_logs().is_empty(), "{what}: a rejection logs nothing");
    }

    /// When `who`'s bond becomes claimable if it unregisters at `now`.
    fn claimable(now: u64) -> u64 {
        now + COOLDOWN_SECS * SEC
    }

    #[test]
    fn register_debits_bond_once() {
        let mut t = bonded(&["alice.near"], 12_000_000);
        ok(
            try_register_at(&mut t, "alice.near", T1),
            "the first registration",
        );
        assert_eq!(vault(&t, "alice.near"), 12_000_000 - BOND);
        let p = profile(&t, "alice.near");
        assert_eq!(p.bond, usdc_bond(BOND), "the bond is recorded on the agent");
        assert_eq!(p.status, AgentStatus::Active);
        assert_eq!((p.unregistering_since, p.claimable_at), (0, 0));

        // Registering again, as often as it likes, takes nothing more.
        for i in 1..=3 {
            ok(
                try_register_at(&mut t, "alice.near", T1 + i * DAY_NS),
                "an update",
            );
            assert_eq!(vault(&t, "alice.near"), 12_000_000 - BOND, "update {i}");
            assert_eq!(profile(&t, "alice.near").bond, usdc_bond(BOND));
        }
    }

    #[test]
    fn register_needs_the_bond_in_the_vault() {
        // bob holds one unit less than the bond, carol has no vault slot at all.
        let mut t = bonded(&["bob.near"], BOND - 1);
        testing_env!(ctx("carol.near")
            .attached_deposit(NearToken::from_millinear(50))
            .build());
        t.storage_deposit(None, None);
        for who in ["bob.near", "carol.near"] {
            assert_rejected(try_register_at(&mut t, who, T1), "E_FUNDS", who);
            assert_eq!(t.get_agent(acct(who)), None, "{who}: no profile was made");
        }
        assert_eq!(vault(&t, "bob.near"), BOND - 1);
        // One more unit and bob registers, with his vault emptied.
        fund(&mut t, USDC, "bob.near", 1);
        ok(try_register_at(&mut t, "bob.near", T1), "bob with the bond");
        assert_eq!(vault(&t, "bob.near"), 0);
    }

    #[test]
    fn profile_update_charges_no_second_bond() {
        // alice holds exactly the bond, so after registering her vault is empty.
        let mut t = bonded(&["alice.near"], BOND);
        ok(try_register_at(&mut t, "alice.near", T1), "registration");
        assert_eq!(vault(&t, "alice.near"), 0);

        // The owner raises the bond and moves it to another token. alice's update still takes
        // nothing, and her recorded bond stays what she paid.
        as_owner(&mut t, |t| t.set_agent_bond(acct(DAI), U128(9_000_000)));
        call_as("alice.near", T1 + DAY_NS);
        t.register_agent(
            "ipfs://bafy-new-profile".to_string(),
            OTHER_HASH.to_string(),
            strings(&["coding"]),
        );
        let p = profile(&t, "alice.near");
        assert_eq!(
            (p.profile_uri.as_str(), p.tags.clone(), p.bond.clone()),
            (
                "ipfs://bafy-new-profile",
                strings(&["coding"]),
                usdc_bond(BOND)
            )
        );
        assert_eq!(p.status, AgentStatus::Active);
        assert_eq!(vault(&t, "alice.near"), 0);
        assert_eq!(t.balance_of(acct("alice.near"), acct(DAI)).0, 0);
    }

    #[test]
    fn fc_key_cannot_register() {
        let mut t = bonded(&["alice.near"], 12_000_000);
        let start = used(&t, "alice.near");
        // A function-call key attaches nothing, and two yoctoNEAR are not one either.
        for deposit in [NO_DEPOSIT, NearToken::from_yoctonear(2)] {
            let result = try_at(&mut t, "alice.near", T1, deposit, |t| {
                t.register_agent(URI.to_string(), HASH.to_string(), vec![])
            });
            assert_eq!(result, Err(ONE_YOCTO_MESSAGE.to_string()), "{deposit:?}");
        }
        // Nor can a delegate key, which spends within caps with no deposit attached.
        let key = PublicKey::from_parts(CurveType::ED25519, vec![7; 32]).unwrap();
        call_as("alice.near", T1);
        t.add_delegate(key.clone(), acct(USDC), U128(BOND), U128(BOND));
        testing_env!(ctx("alice.near")
            .signer_account_pk(key)
            .block_timestamp(T1)
            .build());
        let result = panic_message(|| t.register_agent(URI.to_string(), HASH.to_string(), vec![]));
        assert_eq!(result.as_deref(), Some(ONE_YOCTO_MESSAGE), "a delegate key");
        assert_eq!(t.get_agent(acct("alice.near")), None);
        assert_eq!(vault(&t, "alice.near"), 12_000_000);
        assert!(
            used(&t, "alice.near") > start,
            "the premise: the delegate record"
        );
    }

    #[test]
    fn fc_key_cannot_unregister_or_claim() {
        let mut t = bonded(&["alice.near"], BOND);
        ok(try_register_at(&mut t, "alice.near", T1), "registration");
        for deposit in [NO_DEPOSIT, NearToken::from_yoctonear(2)] {
            let result = try_at(&mut t, "alice.near", T1, deposit, Tender::unregister_agent);
            assert_eq!(result, Err(ONE_YOCTO_MESSAGE.to_string()), "{deposit:?}");
        }
        assert_eq!(profile(&t, "alice.near").status, AgentStatus::Active);
        ok(try_unregister(&mut t, "alice.near", T1), "unregistering");
        let due = claimable(T1);
        for deposit in [NO_DEPOSIT, NearToken::from_yoctonear(2)] {
            let result = try_at(&mut t, "alice.near", due, deposit, Tender::claim_agent_bond);
            assert_eq!(result, Err(ONE_YOCTO_MESSAGE.to_string()), "{deposit:?}");
        }
        assert_eq!(vault(&t, "alice.near"), 0);
        assert_eq!(profile(&t, "alice.near").status, AgentStatus::Unregistering);
    }

    #[test]
    fn claim_before_cooldown_rejected() {
        let mut t = bonded(&["alice.near", "bob.near"], BOND);
        ok(try_register_at(&mut t, "alice.near", T1), "alice registers");
        ok(try_register_at(&mut t, "bob.near", T1), "bob registers");
        // An active agent has nothing to claim yet, and an account that never registered has
        // nothing at all.
        assert_rejected(
            try_claim(&mut t, "bob.near", T1),
            "E_PHASE",
            "an active agent",
        );
        assert_rejected(
            try_claim(&mut t, "carol.near", T1),
            "E_NOT_REGISTERED",
            "a stranger",
        );

        let left = T1 + 10 * SEC;
        ok(try_unregister(&mut t, "alice.near", left), "unregistering");
        let p = profile(&t, "alice.near");
        assert_eq!(p.status, AgentStatus::Unregistering);
        assert_eq!(
            (p.unregistering_since, p.claimable_at),
            (left, claimable(left))
        );
        // Right after, and one nanosecond before the cooldown ends, the bond stays put.
        for now in [left, left + SEC, claimable(left) - 1] {
            assert_rejected(try_claim(&mut t, "alice.near", now), "E_PHASE", "too early");
            assert_eq!(vault(&t, "alice.near"), 0);
            assert_eq!(profile(&t, "alice.near").status, AgentStatus::Unregistering);
        }
        // At `claimable_at` itself it comes back.
        ok(try_claim(&mut t, "alice.near", claimable(left)), "on time");
        assert_eq!(vault(&t, "alice.near"), BOND);
    }

    #[test]
    fn claim_after_cooldown_refunds_exact_recorded_bond() {
        let mut t = bonded(&["alice.near"], 12_345_678);
        let alice = acct("alice.near");
        let start = used(&t, "alice.near");
        ok(try_register_at(&mut t, "alice.near", T1), "registration");
        let registered = used(&t, "alice.near");
        // Counters a working agent would have by now.
        t.ensure_earned_slot(&alice, &acct(USDC));
        t.with_profile(&alice, |p| {
            p.entries = 3;
            p.wins = 1;
            p.earned[0].1 = 950_000;
        });
        let kept = profile(&t, "alice.near");

        ok(try_unregister(&mut t, "alice.near", T1), "unregistering");
        assert_eq!(
            used(&t, "alice.near"),
            registered,
            "unregistering adds no storage"
        );
        ok(
            try_claim(&mut t, "alice.near", claimable(T1) + DAY_NS),
            "claiming",
        );
        assert_eq!(vault(&t, "alice.near"), 12_345_678, "every unit is back");
        let p = profile(&t, "alice.near");
        assert_eq!(p.status, AgentStatus::Retired);
        assert_eq!(p.bond, None, "the contract holds no bond for it any more");
        assert_eq!((p.unregistering_since, p.claimable_at), (0, 0));
        // The record and its reputation stay.
        assert_eq!(
            p,
            AgentProfile {
                status: AgentStatus::Retired,
                bond: None,
                ..kept
            }
        );
        // The bond's bytes come back to alice: a `Some` tag, the token id with its length, and
        // the 16-byte amount.
        let bond_bytes = 4 + USDC.len() as u64 + 16;
        assert_eq!(used(&t, "alice.near"), registered - bond_bytes);
        assert!(used(&t, "alice.near") > start, "the record itself stays");
    }

    #[test]
    fn bond_config_change_does_not_change_refund() {
        let mut t = bonded(&["alice.near"], 20_000_000);
        fund(&mut t, DAI, "alice.near", 1_000);
        ok(try_register_at(&mut t, "alice.near", T1), "registration");
        // After alice registered, the owner moves the bond to DAI, at a higher amount, and makes
        // the wait longer.
        as_owner(&mut t, |t| t.set_agent_bond(acct(DAI), U128(900)));
        as_owner(&mut t, |t| {
            t.set_agent_bond_cooldown(U64(2 * COOLDOWN_SECS))
        });
        // The cooldown in force when she unregisters is the one she waits.
        ok(try_unregister(&mut t, "alice.near", T1), "unregistering");
        let due = T1 + 2 * COOLDOWN_SECS * SEC;
        assert_eq!(profile(&t, "alice.near").claimable_at, due);
        // A change after that does not move her claim, either way.
        as_owner(&mut t, |t| t.set_agent_bond_cooldown(U64(60)));
        assert_rejected(try_claim(&mut t, "alice.near", due - 1), "E_PHASE", "early");
        as_owner(&mut t, |t| {
            t.set_agent_bond_cooldown(U64(30 * COOLDOWN_SECS))
        });
        ok(try_claim(&mut t, "alice.near", due), "claiming");
        // She gets back the USDC she paid, not the DAI bond in force now.
        assert_eq!(vault(&t, "alice.near"), 20_000_000);
        assert_eq!(t.balance_of(acct("alice.near"), acct(DAI)).0, 1_000);
    }

    #[test]
    fn claim_twice_rejected() {
        let mut t = bonded(&["alice.near"], BOND);
        ok(try_register_at(&mut t, "alice.near", T1), "registration");
        ok(try_unregister(&mut t, "alice.near", T1), "unregistering");
        ok(try_claim(&mut t, "alice.near", claimable(T1)), "the claim");
        assert_eq!(vault(&t, "alice.near"), BOND);
        let after = profile(&t, "alice.near");
        let storage = used(&t, "alice.near");

        // The second claim, then and much later, finds nothing to pay.
        for now in [claimable(T1), claimable(T1) + 30 * DAY_NS] {
            assert_rejected(
                try_claim(&mut t, "alice.near", now),
                "E_NOT_REGISTERED",
                "again",
            );
        }
        // A retired agent cannot unregister either.
        assert_rejected(
            try_unregister(&mut t, "alice.near", claimable(T1)),
            "E_NOT_REGISTERED",
            "unregistering a retired agent",
        );
        assert_eq!(vault(&t, "alice.near"), BOND);
        assert_eq!(profile(&t, "alice.near"), after);
        assert_eq!(used(&t, "alice.near"), storage);
    }

    #[test]
    fn a_retired_agent_registers_again_with_a_fresh_bond() {
        let mut t = bonded(&["alice.near"], 2 * BOND);
        ok(try_register_at(&mut t, "alice.near", T1), "registration");
        ok(try_unregister(&mut t, "alice.near", T1), "unregistering");
        ok(try_claim(&mut t, "alice.near", claimable(T1)), "the claim");
        as_owner(&mut t, |t| t.set_agent_bond(acct(USDC), U128(BOND + 1)));
        let later = claimable(T1) + DAY_NS;
        ok(try_register_at(&mut t, "alice.near", later), "coming back");
        // The bond in force now, recorded afresh; `registered_at` is still the first time.
        assert_eq!(vault(&t, "alice.near"), 2 * BOND - (BOND + 1));
        let p = profile(&t, "alice.near");
        assert_eq!(p.status, AgentStatus::Active);
        assert_eq!(p.bond, usdc_bond(BOND + 1));
        assert_eq!(p.registered_at, T1);
        // And the cycle runs again, paying back the new amount.
        ok(
            try_unregister(&mut t, "alice.near", later),
            "unregistering again",
        );
        ok(
            try_claim(&mut t, "alice.near", claimable(later)),
            "claiming again",
        );
        assert_eq!(vault(&t, "alice.near"), 2 * BOND);
    }

    #[test]
    fn unregistering_agent_cannot_update_its_profile() {
        let mut t = bonded(&["alice.near"], BOND);
        ok(try_register_at(&mut t, "alice.near", T1), "registration");
        ok(try_unregister(&mut t, "alice.near", T1), "unregistering");
        let before = profile(&t, "alice.near");
        call_as("alice.near", T1 + SEC);
        let refused = panic_message(|| {
            t.register_agent("ipfs://other".to_string(), OTHER_HASH.to_string(), vec![])
        });
        assert!(
            refused
                .as_deref()
                .is_some_and(|m| m.starts_with("E_PHASE: ")),
            "{refused:?}"
        );
        assert!(get_logs().is_empty());
        assert_eq!(profile(&t, "alice.near"), before);
        // Unregistering twice is refused too.
        assert_rejected(
            try_unregister(&mut t, "alice.near", T1 + SEC),
            "E_PHASE",
            "unregistering twice",
        );
        assert_eq!(profile(&t, "alice.near"), before);
        assert_rejected(
            try_unregister(&mut t, "bob.near", T1),
            "E_NOT_REGISTERED",
            "a stranger",
        );
    }

    #[test]
    fn unregister_and_claim_need_no_spare_storage() {
        let mut t = bonded(&["alice.near"], BOND);
        let alice = acct("alice.near");
        ok(try_register_at(&mut t, "alice.near", T1), "registration");
        let spare = u64::try_from(t.storage_available(&alice) / byte_cost()).unwrap();
        t.reserve_bytes(&alice, spare);
        assert_eq!(t.storage_available(&alice), 0);
        ok(try_unregister(&mut t, "alice.near", T1), "unregistering");
        ok(try_claim(&mut t, "alice.near", claimable(T1)), "claiming");
        assert_eq!(vault(&t, "alice.near"), BOND);
    }

    #[test]
    fn register_unregister_claim_work_while_paused() {
        let mut t = bonded(&["alice.near"], 2 * BOND);
        as_owner(&mut t, |t| t.set_paused(true));
        ok(try_register_at(&mut t, "alice.near", T1), "registering");
        ok(
            try_register_at(&mut t, "alice.near", T1 + SEC),
            "updating the profile",
        );
        ok(
            try_unregister(&mut t, "alice.near", T1 + SEC),
            "unregistering",
        );
        ok(
            try_claim(&mut t, "alice.near", claimable(T1 + SEC)),
            "claiming",
        );
        assert_eq!(vault(&t, "alice.near"), 2 * BOND);
        ok(
            try_register_at(&mut t, "alice.near", claimable(T1 + SEC)),
            "coming back",
        );
        assert_eq!(vault(&t, "alice.near"), BOND);
        assert!(t.get_config().paused, "the premise: still paused");
    }

    #[test]
    fn an_agent_registered_before_any_bond_has_none_to_claim() {
        // No bond is set: registering takes nothing, and the agent stays bond-free after the
        // owner sets one.
        let mut t = world(&[OWNER, "alice.near"]);
        as_owner(&mut t, |t| set_token(t, USDC));
        ok(try_register_at(&mut t, "alice.near", T1), "registration");
        assert_eq!(profile(&t, "alice.near").bond, None);
        as_owner(&mut t, |t| t.set_agent_bond(acct(USDC), U128(BOND)));
        ok(try_register_at(&mut t, "alice.near", T1), "an update");
        assert_eq!(profile(&t, "alice.near").bond, None);
        // It leaves the usual way, with the cooldown in force, and the claim only retires it.
        ok(try_unregister(&mut t, "alice.near", T1), "unregistering");
        let due = T1 + 1_209_600 * SEC;
        assert_rejected(try_claim(&mut t, "alice.near", due - 1), "E_PHASE", "early");
        ok(try_claim(&mut t, "alice.near", due), "claiming");
        assert_eq!(profile(&t, "alice.near").status, AgentStatus::Retired);
        assert_eq!(vault(&t, "alice.near"), 0);
        // Coming back costs the bond that is set now, which alice does not hold.
        assert_rejected(
            try_register_at(&mut t, "alice.near", due),
            "E_FUNDS",
            "coming back without the bond",
        );
    }

    #[test]
    fn register_checks_run_in_the_listed_order() {
        let mut t = bonded(&["alice.near"], BOND);
        // The deposit, before an argument that breaks a rule.
        let bad_uri = |t: &mut Tender| t.register_agent(String::new(), HASH.to_string(), vec![]);
        assert_eq!(
            try_at(&mut t, "alice.near", T1, NO_DEPOSIT, bad_uri),
            Err(ONE_YOCTO_MESSAGE.to_string())
        );
        // The arguments, before the funds.
        let mut poor = bonded(&["bob.near"], 0);
        assert_rejected(
            try_at(&mut poor, "bob.near", T1, ONE_YOCTO, bad_uri),
            "E_URI",
            "a bad uri",
        );
        assert_rejected(
            try_register_at(&mut poor, "bob.near", T1),
            "E_FUNDS",
            "no bond",
        );
        // The status, before the funds: alice, unregistering with an empty vault.
        ok(try_register_at(&mut t, "alice.near", T1), "registration");
        ok(try_unregister(&mut t, "alice.near", T1), "unregistering");
        assert_rejected(
            try_register_at(&mut t, "alice.near", T1),
            "E_PHASE",
            "unregistering",
        );
        // The funds, before the storage: carol has the bond and no storage to spare.
        let mut t = bonded(&["carol.near"], BOND);
        let carol = acct("carol.near");
        let spare = u64::try_from(t.storage_available(&carol) / byte_cost()).unwrap();
        t.reserve_bytes(&carol, spare);
        assert_rejected(
            try_register_at(&mut t, "carol.near", T1),
            "E_STORAGE",
            "no storage",
        );
    }
}
