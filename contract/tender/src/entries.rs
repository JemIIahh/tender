//! Entering a task: commit, then reveal.
//!
//! An agent enters a task by committing a hash of its finished work during the commit window, and
//! may replace that commitment until the deadline. In the reveal window it reveals the work's
//! SHA-256, the salt and a URI, and the contract checks them against the commitment. Until the
//! commit deadline the work stays sealed, so nobody can copy it: the commitment shows nothing of
//! the work, and it binds the task and the account, so a copied commitment cannot be revealed.
//!
//! A first commit also creates the entrant's payout slots, so settlement never needs new storage.

use near_sdk::json_types::U64;
use near_sdk::{borsh, env, near, AccountId};

use crate::events::{emit, EntryCommitted, EntryRevealed};
use crate::tasks::{no_task, phase};
use crate::types::{
    check_uri, err, hex32, parse_hash, Entry, EntryView, Phase, Revealed, MAX_PAGE,
};
use crate::{Tender, TenderExt};

/// The commitment that enters `account` in task `task_id` with the work whose SHA-256 is
/// `content_hash`: the SHA-256 of the Borsh encoding of `(task_id, account, content_hash, salt)`.
///
/// Byte for byte, the hashed preimage is the task id as a little-endian `u64`, the account id's
/// length as a little-endian `u32` followed by its UTF-8 bytes, the 32 bytes of `content_hash`,
/// and the 32 bytes of `salt`. A client must hash exactly these bytes, and reproduce the two
/// vectors in the test `commitment_matches_cross_language_vector`.
pub(crate) fn commitment_of(
    task_id: u64,
    account: &AccountId,
    content_hash: &[u8; 32],
    salt: &[u8; 32],
) -> [u8; 32] {
    // Borsh fails only on a string longer than u32::MAX bytes, and an account id has at most 64.
    let preimage =
        borsh::to_vec(&(task_id, account.as_str(), content_hash, salt)).unwrap_or_else(|_| {
            env::panic_str(&format!(
                "{}: the commitment preimage did not encode",
                err::E_COMMITMENT
            ))
        });
    env::sha256_array(&preimage)
}

fn no_entry(task_id: u64, account: &AccountId) -> ! {
    env::panic_str(&format!(
        "{}: {account} has no entry in task {task_id}",
        err::E_NOT_FOUND
    ))
}

impl Entry {
    /// This entry, made by `account` in task `task_id`, as the views show it.
    fn view(&self, task_id: u64, account: AccountId) -> EntryView {
        // No `..`: a field added to `Entry` is a compile error here until the view shows it.
        let Entry {
            commitment,
            index,
            committed_at_block,
            revealed,
        } = self;
        EntryView {
            task_id: U64(task_id),
            account,
            index: *index,
            commitment: hex32(commitment),
            committed_at_block: U64(*committed_at_block),
            content_hash: revealed.as_ref().map(|r| hex32(&r.content_hash)),
            uri: revealed.as_ref().map(|r| r.uri.clone()),
        }
    }
}

#[near]
impl Tender {
    /// Enters the caller in task `task_id` with `commitment`, or replaces the commitment it
    /// entered with. `commitment` is `commitment_of(task_id, caller, content_hash, salt)` as 64
    /// lowercase hex characters, where `content_hash` is the SHA-256 of the finished work and
    /// `salt` is 32 random bytes that the caller keeps until it reveals.
    ///
    /// The rules, checked in this order, each with its error code:
    /// - the task exists (`E_NOT_FOUND`);
    /// - it is open: the block time is before its `commit_deadline` (`E_PHASE`);
    /// - the caller is neither its poster nor its verifier (`E_AUTH`);
    /// - if the task has an `invited` list, the caller is on it (`E_INVITE`);
    /// - if it has none, so is open to anyone, the caller is an active registered agent: one that
    ///   has registered and has not called `unregister_agent` since, and that holds a bond if the
    ///   owner has set one (`E_NOT_REGISTERED`). This holds for a replacement too;
    /// - `commitment` is 64 lowercase hex characters (`E_HASH`);
    /// - a caller without an entry needs a free place: `max_entries` is 0, or more than
    ///   `commit_count` (`E_FULL`);
    /// - the caller's storage balance covers what the call adds (`E_STORAGE`).
    ///
    /// The caller is the predecessor, never the signer. If it has an entry, the entry's commitment
    /// and `committed_at_block` are replaced and nothing else changes: the index, the counts and
    /// the storage stay as they were, and a full task does not stop it. Otherwise the caller takes
    /// the next index and gets its payout slots for the task's token (see `ensure_payout_slots`),
    /// and the task's `commit_count` goes up by one, as does the caller's `entries` if it is a
    /// registered agent. A new entry in an open task also raises the agent's `locked_until` to the
    /// task's `commit_deadline`, before which its bond cannot be claimed. The caller pays for the new records out of its storage balance. Emits
    /// `committed`, whose `replaced` says which of the two happened.
    ///
    /// Commits work while the contract is paused, and attach no deposit, so a function-call key
    /// can send them: a delegate key among them, but for an open task only that of an active
    /// agent.
    #[deny_unknown_arguments]
    pub fn commit(&mut self, task_id: U64, commitment: String) {
        let before = self.storage_mark();
        let caller = env::predecessor_account_id();
        let id = task_id.0;
        let task = self.tasks.get(&id).unwrap_or_else(|| no_task(id));
        if phase(task, env::block_timestamp()) != Phase::Open {
            env::panic_str(&format!(
                "{}: task {id} is not open for commits",
                err::E_PHASE
            ));
        }
        if caller == task.poster || caller == task.verifier {
            env::panic_str(&format!(
                "{}: the poster and the verifier cannot enter task {id}",
                err::E_AUTH
            ));
        }
        if !task.invited.is_empty() && !task.invited.contains(&caller) {
            env::panic_str(&format!(
                "{}: {caller} is not invited to task {id}",
                err::E_INVITE
            ));
        }
        // An open task: anyone could fill it with accounts that cost nothing, so it takes only
        // agents whose bond the contract holds (owner decision, 2026-11-03). A pinned task's
        // poster chose its entrants, so they need no registration.
        if task.invited.is_empty() && !self.may_enter_open_tasks(&caller) {
            let hint = if self.is_active_agent(&caller) {
                format!(
                    "; {caller} registered before the bond was set and holds none: call \
                     register_agent to pay it"
                )
            } else {
                String::new()
            };
            env::panic_str(&format!(
                "{}: open tasks take entries only from registered agents{hint}",
                err::E_NOT_REGISTERED
            ));
        }
        let commitment = parse_hash("commitment", &commitment);
        let key = (id, caller.clone());
        let replaced = self.entries.get(&key).is_some();
        if !replaced && task.max_entries > 0 && task.commit_count >= task.max_entries {
            env::panic_str(&format!(
                "{}: task {id} is full at {} entrants",
                err::E_FULL,
                task.max_entries
            ));
        }
        let token = task.token.clone();
        let (open, commit_deadline) = (task.invited.is_empty(), task.commit_deadline);
        let block_height = env::block_height();

        // Every rule has been checked. Only the storage charge can still fail.
        match self.entries.get_mut(&key) {
            Some(entry) => {
                entry.commitment = commitment;
                entry.committed_at_block = block_height;
            }
            None => {
                self.ensure_payout_slots(&caller, &token);
                let task = self.tasks.get_mut(&id).unwrap_or_else(|| no_task(id));
                let index = task.commit_count;
                task.commit_count += 1;
                self.entries.insert(
                    key,
                    Entry {
                        commitment,
                        index,
                        committed_at_block: block_height,
                        revealed: None,
                    },
                );
                self.entrant_at.insert((id, index), caller.clone());
                self.with_profile(&caller, |p| {
                    p.entries = p.entries.saturating_add(1);
                    // The bond that let it into an open task stays until this window closes.
                    if open {
                        p.locked_until = p.locked_until.max(commit_deadline);
                    }
                });
            }
        }
        self.settle_storage(&caller, before);
        emit(
            "committed",
            &EntryCommitted {
                task_id,
                account: caller,
                commitment: hex32(&commitment),
                replaced,
                block_height: U64(block_height),
            },
        );
    }

    /// Reveals the caller's entry in task `task_id`: `content_hash` is the SHA-256 of its work
    /// and `salt` the salt it committed with, both as 64 lowercase hex characters, and `uri` is
    /// where the work can be read.
    ///
    /// The rules, checked in this order, each with its error code:
    /// - the task exists (`E_NOT_FOUND`);
    /// - it is in its reveal window: from its `commit_deadline` up to, but not including, its
    ///   `reveal_deadline` (`E_PHASE`);
    /// - the caller has an entry in it (`E_NOT_FOUND`) and has not revealed it (`E_REVEALED`);
    /// - `uri` is 1 to 256 bytes (`E_URI`);
    /// - `content_hash` and `salt` are 64 lowercase hex characters (`E_HASH`);
    /// - `commitment_of(task_id, caller, content_hash, salt)` is the entry's commitment
    ///   (`E_COMMITMENT`);
    /// - the caller's storage balance covers what the call adds (`E_STORAGE`).
    ///
    /// The caller is the predecessor, never the signer. The entry keeps `content_hash` and `uri`,
    /// and the task's `reveal_count` goes up by one, as does the caller's `reveals` if it is a
    /// registered agent. The caller pays for the revealed bytes out of its storage balance.
    /// Emits `revealed`.
    ///
    /// Reveals work while the contract is paused, and attach no deposit, so a function-call key
    /// can send them.
    #[deny_unknown_arguments]
    pub fn reveal(&mut self, task_id: U64, content_hash: String, salt: String, uri: String) {
        let before = self.storage_mark();
        let caller = env::predecessor_account_id();
        let id = task_id.0;
        let task = self.tasks.get_mut(&id).unwrap_or_else(|| no_task(id));
        if phase(task, env::block_timestamp()) != Phase::Revealing {
            env::panic_str(&format!(
                "{}: task {id} is not in its reveal window",
                err::E_PHASE
            ));
        }
        let entry = self
            .entries
            .get_mut(&(id, caller.clone()))
            .unwrap_or_else(|| no_entry(id, &caller));
        if entry.revealed.is_some() {
            env::panic_str(&format!(
                "{}: {caller} has already revealed in task {id}",
                err::E_REVEALED
            ));
        }
        check_uri("uri", &uri);
        let content_hash = parse_hash("content_hash", &content_hash);
        let salt = parse_hash("salt", &salt);
        if commitment_of(id, &caller, &content_hash, &salt) != entry.commitment {
            env::panic_str(&format!(
                "{}: content_hash and salt do not match the commitment",
                err::E_COMMITMENT
            ));
        }

        // Every rule has been checked. Only the storage charge can still fail.
        entry.revealed = Some(Revealed {
            content_hash,
            uri: uri.clone(),
        });
        task.reveal_count += 1;
        self.with_profile(&caller, |p| p.reveals = p.reveals.saturating_add(1));
        self.settle_storage(&caller, before);
        emit(
            "revealed",
            &EntryRevealed {
                task_id,
                account: caller,
                content_hash: hex32(&content_hash),
                uri,
            },
        );
    }

    /// Up to `limit` entries of task `task_id` in entrant order, starting at index `from_index`.
    /// `limit` is clamped to 1..=50, and the page stops at the task's last index. An index whose
    /// entry `cleanup` has removed is left out, so a page can be shorter than `limit` before the
    /// end. A task that does not exist has no entries.
    pub fn get_entries(&self, task_id: U64, from_index: u32, limit: u32) -> Vec<EntryView> {
        let id = task_id.0;
        let Some(task) = self.tasks.get(&id) else {
            return Vec::new();
        };
        let end = from_index
            .saturating_add(limit.clamp(1, MAX_PAGE))
            .min(task.commit_count);
        (from_index..end)
            .filter_map(|index| {
                let account = self.entrant_at.get(&(id, index))?;
                let entry = self.entries.get(&(id, account.clone()))?;
                Some(entry.view(id, account.clone()))
            })
            .collect()
    }

    /// The entry of `account_id` in task `task_id`, or `None` if it has none.
    pub fn get_entry(&self, task_id: U64, account_id: AccountId) -> Option<EntryView> {
        self.entries
            .get(&(task_id.0, account_id.clone()))
            .map(|entry| entry.view(task_id.0, account_id))
    }
}

impl Tender {
    /// Creates what paying `account` in `token` needs, where it is missing: a vault slot, and an
    /// `earned` slot if `account` is a registered agent. A slot that exists keeps its balance.
    ///
    /// The slots take storage, and this does not settle it: the caller's `storage_mark` and
    /// `settle_storage` window pays. Created at commit time, they let settlement credit an
    /// account without adding storage.
    pub(crate) fn ensure_payout_slots(&mut self, account: &AccountId, token: &AccountId) {
        self.ensure_vault_slot(account, token);
        self.ensure_earned_slot(account, token);
    }
}

#[cfg(test)]
mod tests {
    use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
    use near_sdk::json_types::{U128, U64};
    use near_sdk::serde_json;
    use near_sdk::test_utils::get_logs;
    use near_sdk::{env, testing_env, AccountId, NearToken};

    use super::commitment_of;
    use crate::test_utils::{ctx, fresh, panic_message};
    use crate::types::{
        hex32, EntryView, PostTaskArgs, TokenBalance, TokenConfig, WinnerArg, MAX_URI_BYTES,
    };
    use crate::Tender;

    const USDC: &str = "usdc.test";
    const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
    /// The block time the tests post at: above 2^53 nanoseconds, which a JSON number could not
    /// carry.
    const T1: u64 = 1_793_028_278_935_742_660;
    const SEC: u64 = 1_000_000_000;
    /// The deadlines of the default task posted at `T1`: windows of 60 s to commit, then 120 s to
    /// reveal.
    const COMMIT_DEADLINE: u64 = T1 + 60 * SEC;
    const REVEAL_DEADLINE: u64 = T1 + 180 * SEC;
    /// The block height the tests call at, unless they say otherwise.
    const HEIGHT: u64 = 140_000_000;
    const BRIEF_URI: &str = "https://api.tender.example/v1/blobs/b94d27b9";
    /// sha256("hello world").
    const BRIEF_HASH: &str = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";
    /// sha256("foo").
    const CRITERIA_HASH: &str = "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae";
    /// Where the tests' entrants publish their work.
    const URI: &str = "https://api.tender.example/v1/results/2c26b46b";
    /// An account with a storage balance that has not registered as an agent.
    const STRANGER: &str = "gina.test";
    /// The agents in every test world, each with a storage balance and an empty vault.
    const AGENTS: [&str; 5] = [
        "bob.test",
        "carol.test",
        "dave.test",
        "erin.test",
        "frank.test",
    ];

    fn acct(id: &str) -> AccountId {
        id.parse().unwrap()
    }

    fn byte_cost() -> u128 {
        env::storage_byte_cost().as_yoctonear()
    }

    /// A task that meets every rule: 1 USDC, windows of 60, 120, 180 and 240 seconds, open to
    /// anyone, one winner, and the poster as verifier.
    fn args() -> PostTaskArgs {
        PostTaskArgs {
            token: acct(USDC),
            reward: U128(1_000_000),
            brief_uri: BRIEF_URI.to_string(),
            brief_hash: BRIEF_HASH.to_string(),
            criteria_hash: CRITERIA_HASH.to_string(),
            heldout_commitment: None,
            verifier: None,
            commit_secs: 60,
            reveal_secs: 120,
            pick_secs: 180,
            fallback_secs: 240,
            max_entries: 0,
            max_winners: 1,
            invited: vec![],
            parent: None,
        }
    }

    /// Adds `deposit` to `who`'s storage balance, registering it if need be.
    fn register(t: &mut Tender, who: &str, deposit: NearToken) {
        testing_env!(ctx(who).attached_deposit(deposit).build());
        t.storage_deposit(None, None);
    }

    /// `who` deposits `amount` of USDC, as the token reports it to `ft_on_transfer`.
    fn fund(t: &mut Tender, who: &str, amount: u128) {
        testing_env!(ctx(USDC).build());
        let _ = t.ft_on_transfer(acct(who), U128(amount), String::new());
    }

    /// A contract with USDC enabled and no agent bond set; alice, the poster, with 1 NEAR of
    /// storage and 100 USDC in her vault; each of `AGENTS` registered as an agent, so that it may
    /// enter open tasks, with 0.1 NEAR of storage and no vault slot; and `STRANGER`, with the same
    /// storage, unregistered.
    fn world() -> Tender {
        let mut t = fresh();
        t.put_token(
            acct(USDC),
            TokenConfig {
                min_reward: 10,
                max_reward: 50_000_000,
                enabled: true,
            },
        );
        register(&mut t, "alice.test", NearToken::from_near(1));
        fund(&mut t, "alice.test", 100_000_000);
        for agent in AGENTS {
            register(&mut t, agent, NearToken::from_millinear(100));
            register_agent(&mut t, agent);
        }
        register(&mut t, STRANGER, NearToken::from_millinear(100));
        t
    }

    /// alice posts `task` at `T1`. Returns its id.
    fn post(t: &mut Tender, task: PostTaskArgs) -> u64 {
        testing_env!(ctx("alice.test")
            .attached_deposit(ONE_YOCTO)
            .block_timestamp(T1)
            .build());
        t.post_task(task).0
    }

    /// `who` registers as an agent, with the 1 yoctoNEAR that registering takes.
    fn register_agent(t: &mut Tender, who: &str) {
        testing_env!(ctx(who)
            .block_timestamp(T1)
            .attached_deposit(ONE_YOCTO)
            .build());
        t.register_agent(
            "https://acme.example/agent.json".to_string(),
            BRIEF_HASH.to_string(),
            vec![],
        );
    }

    /// The work that `seed` stands for: its content hash (the SHA-256 of the one byte `seed`) and
    /// the salt it is committed with (`seed` 32 times).
    fn work(seed: u8) -> ([u8; 32], [u8; 32]) {
        (env::sha256_array([seed]), [seed; 32])
    }

    /// The commitment with which `who` enters task `id` with the work `seed`.
    fn commitment(id: u64, who: &str, seed: u8) -> String {
        let (content_hash, salt) = work(seed);
        hex32(&commitment_of(id, &acct(who), &content_hash, &salt))
    }

    /// Makes `who` the caller at block time `now` and block height `height`.
    fn call_as(who: &str, now: u64, height: u64) {
        testing_env!(ctx(who).block_timestamp(now).block_height(height).build());
    }

    /// `who` commits `commitment` to task `id` at `now` and `height`. `Err` holds the message the
    /// contract panicked with.
    fn try_commit(
        t: &mut Tender,
        who: &str,
        id: u64,
        now: u64,
        height: u64,
        commitment: &str,
    ) -> Result<(), String> {
        call_as(who, now, height);
        match panic_message(|| t.commit(U64(id), commitment.to_string())) {
            Some(message) => Err(message),
            None => Ok(()),
        }
    }

    /// `who` enters task `id` with the work `seed`, at `T1`.
    fn enter(t: &mut Tender, who: &str, id: u64, seed: u8) {
        try_commit(t, who, id, T1, HEIGHT, &commitment(id, who, seed))
            .unwrap_or_else(|m| panic!("{who} could not commit: {m}"));
    }

    /// `who` reveals in task `id` at `now`. `Err` holds the message the contract panicked with.
    fn try_reveal(
        t: &mut Tender,
        who: &str,
        id: u64,
        now: u64,
        content_hash: &str,
        salt: &str,
        uri: &str,
    ) -> Result<(), String> {
        call_as(who, now, HEIGHT);
        let (content_hash, salt, uri) =
            (content_hash.to_string(), salt.to_string(), uri.to_string());
        match panic_message(|| t.reveal(U64(id), content_hash, salt, uri)) {
            Some(message) => Err(message),
            None => Ok(()),
        }
    }

    /// `who` reveals the work `seed` in task `id` at `now`, published at `uri`.
    fn try_reveal_work(
        t: &mut Tender,
        who: &str,
        id: u64,
        now: u64,
        seed: u8,
        uri: &str,
    ) -> Result<(), String> {
        let (content_hash, salt) = work(seed);
        try_reveal(t, who, id, now, &hex32(&content_hash), &hex32(&salt), uri)
    }

    /// Asserts that `result` is a rejection with `code` and that the call logged nothing. Returns
    /// the message.
    fn assert_rejected(result: Result<(), String>, code: &str, what: &str) -> String {
        let message = result.expect_err(&format!("{what}: expected {code}, but it went through"));
        assert!(
            message.starts_with(&format!("{code}: ")),
            "{what}: expected {code}, got {message:?}"
        );
        // A failed receipt keeps its logs (spec 6.9), so the event must come after the last check.
        assert!(get_logs().is_empty(), "{what}: a rejection logs nothing");
        message
    }

    fn used(t: &Tender, who: &str) -> u64 {
        t.storage_balance_of(acct(who))
            .expect("has a storage balance")
            .used_bytes
            .0
    }

    /// Spends `who`'s storage balance down to exactly `bytes` to spare.
    fn leave_spare(t: &mut Tender, who: &str, bytes: u64) {
        let who = acct(who);
        let spare = u64::try_from(t.storage_available(&who) / byte_cost()).unwrap();
        t.reserve_bytes(&who, spare - bytes);
        assert_eq!(t.storage_available(&who), u128::from(bytes) * byte_cost());
    }

    /// The bytes that a first commit to a task in USDC adds for `who`, which is unregistered
    /// unless `agent`. Each record costs 40 bytes of overhead plus its key and value; a key starts
    /// with a 1-byte prefix, and an account id is a 4-byte length and its bytes.
    fn commit_bytes(who: &str, agent: bool) -> u64 {
        let account = 4 + who.len() as u64;
        // Keyed by the task id and the account. The value: the commitment, the index, the block
        // and the 1-byte `None` of `revealed`.
        let entry = 40 + (1 + 8 + account) + (32 + 4 + 8 + 1);
        // Keyed by the task id and the index; the value is the account.
        let entrant_at = 40 + (1 + 8 + 4) + account;
        // Keyed by the account and the token; the value is a u128.
        let vault_slot = 40 + (1 + account + 4 + USDC.len() as u64) + 16;
        // A `(token, u128)` pushed onto the profile's `earned`.
        let earned_slot = if agent { 4 + USDC.len() as u64 + 16 } else { 0 };
        entry + entrant_at + vault_slot + earned_slot
    }

    /// The bytes that revealing at `uri` adds: `revealed` goes from a 1-byte `None` to `Some`,
    /// which keeps the tag and adds the content hash and the uri with its 4-byte length.
    fn reveal_bytes(uri: &str) -> u64 {
        32 + 4 + uri.len() as u64
    }

    /// The task's `(commit_count, reveal_count)`.
    fn counts(t: &Tender, id: u64) -> (u32, u32) {
        let v = t.get_task(U64(id)).expect("the task exists");
        (v.commit_count, v.reveal_count)
    }

    fn entry(t: &Tender, id: u64, who: &str) -> EntryView {
        t.get_entry(U64(id), acct(who)).expect("has an entry")
    }

    /// The `(index, account)` of each entry on a page of `get_entries`.
    fn page(t: &Tender, id: u64, from_index: u32, limit: u32) -> Vec<(u32, String)> {
        t.get_entries(U64(id), from_index, limit)
            .into_iter()
            .map(|e| (e.index, e.account.to_string()))
            .collect()
    }

    fn indexed(accounts: &[(u32, &str)]) -> Vec<(u32, String)> {
        accounts.iter().map(|&(i, a)| (i, a.to_string())).collect()
    }

    fn event(name: &str, data: &str) -> String {
        format!(
            r#"EVENT_JSON:{{"standard":"tender","version":"1.0.0","event":"{name}","data":[{data}]}}"#
        )
    }

    // The commitment.

    #[test]
    fn commitment_matches_cross_language_vector() {
        let ch = env::sha256_array(b"hello world");
        let salt: [u8; 32] = core::array::from_fn(|i| i as u8);
        assert_eq!(
            hex32(&commitment_of(
                7,
                &"alice.testnet".parse().unwrap(),
                &ch,
                &salt
            )),
            "7e92e9a2323f2ca960418263d394956e0c4cacd348f83b46a915ab4ac8537977"
        );
        // edge case: u64::MAX task id, 64-hex implicit account, empty content, salt of 0xff
        assert_eq!(
            hex32(&commitment_of(
                u64::MAX,
                &"0123456789abcdef".repeat(4).parse().unwrap(),
                &env::sha256_array(b""),
                &[0xff; 32]
            )),
            "76d8bcd34b9d099fb7fd104a1831cde0061451ecbcb9fb36ebebb479da4bb9d6"
        );
    }

    #[test]
    fn a_copied_commitment_cannot_be_revealed() {
        // A commitment binds its task and its account. carol copies bob's commitment, which is
        // public, and waits for him to reveal; bob reuses his on another task. Neither copy opens
        // with the pair bob reveals.
        let mut t = world();
        let id = post(&mut t, args());
        let other = post(&mut t, args());
        let bobs = commitment(id, "bob.test", 1);
        enter(&mut t, "bob.test", id, 1);
        try_commit(&mut t, "carol.test", id, T1, HEIGHT, &bobs).unwrap();
        try_commit(&mut t, "bob.test", other, T1, HEIGHT, &bobs).unwrap();

        try_reveal_work(&mut t, "bob.test", id, COMMIT_DEADLINE, 1, URI).unwrap();
        assert_rejected(
            try_reveal_work(&mut t, "carol.test", id, COMMIT_DEADLINE, 1, URI),
            "E_COMMITMENT",
            "carol revealing bob's work",
        );
        assert_rejected(
            try_reveal_work(&mut t, "bob.test", other, COMMIT_DEADLINE, 1, URI),
            "E_COMMITMENT",
            "a commitment made for another task",
        );
        assert_eq!(counts(&t, id), (2, 1));
        assert_eq!(counts(&t, other), (1, 0));
    }

    // Who may commit.

    #[test]
    fn commit_rejected_for_poster_and_verifier() {
        let mut t = world();
        let judged = post(
            &mut t,
            PostTaskArgs {
                verifier: Some(acct("judge.test")),
                ..args()
            },
        );
        // alice posts this one and, by default, verifies it too.
        let own = post(&mut t, args());
        for (what, who, id) in [
            ("the poster", "alice.test", judged),
            ("the verifier", "judge.test", judged),
            ("the poster who is also the verifier", "alice.test", own),
        ] {
            let result = try_commit(&mut t, who, id, T1, HEIGHT, &commitment(id, who, 1));
            let message = assert_rejected(result, "E_AUTH", what);
            assert_eq!(
                message,
                format!("E_AUTH: the poster and the verifier cannot enter task {id}")
            );
            assert_eq!(t.get_entry(U64(id), acct(who)), None, "{what}");
        }
        assert_eq!(counts(&t, judged), (0, 0));
        assert_eq!(counts(&t, own), (0, 0));
        // Anyone else may enter either task.
        enter(&mut t, "bob.test", judged, 1);
        enter(&mut t, "bob.test", own, 1);
        assert_eq!(counts(&t, judged), (1, 0));
        assert_eq!(counts(&t, own), (1, 0));
    }

    #[test]
    fn invited_only() {
        let mut t = world();
        let id = post(
            &mut t,
            PostTaskArgs {
                invited: vec![acct("bob.test"), acct("carol.test")],
                ..args()
            },
        );
        let result = try_commit(
            &mut t,
            "dave.test",
            id,
            T1,
            HEIGHT,
            &commitment(id, "dave.test", 1),
        );
        let message = assert_rejected(result, "E_INVITE", "an account that was not invited");
        assert_eq!(message, "E_INVITE: dave.test is not invited to task 1");
        assert_eq!(t.get_entry(U64(id), acct("dave.test")), None);
        assert!(
            t.balances_of(acct("dave.test")).is_empty(),
            "no slot was made"
        );

        enter(&mut t, "bob.test", id, 1);
        enter(&mut t, "carol.test", id, 2);
        assert_eq!(counts(&t, id), (2, 0));
        // A task with no invited list is open to anyone.
        let open = post(&mut t, args());
        enter(&mut t, "dave.test", open, 3);
    }

    #[test]
    fn new_commit_rejected_when_full() {
        let mut t = world();
        let id = post(
            &mut t,
            PostTaskArgs {
                invited: vec![acct("bob.test"), acct("carol.test"), acct("dave.test")],
                max_entries: 2,
                ..args()
            },
        );
        enter(&mut t, "bob.test", id, 1);
        // The last place is taken...
        enter(&mut t, "carol.test", id, 2);
        let dave_used = used(&t, "dave.test");
        // ...so nobody new gets in.
        let result = try_commit(
            &mut t,
            "dave.test",
            id,
            T1,
            HEIGHT,
            &commitment(id, "dave.test", 3),
        );
        let message = assert_rejected(result, "E_FULL", "a third entrant");
        assert_eq!(message, "E_FULL: task 1 is full at 2 entrants");
        // Nothing was written for dave.
        assert_eq!(t.get_entry(U64(id), acct("dave.test")), None);
        assert_eq!(counts(&t, id), (2, 0));
        assert_eq!(used(&t, "dave.test"), dave_used);
        assert!(t.balances_of(acct("dave.test")).is_empty());
    }

    #[test]
    fn recommit_allowed_when_task_full() {
        let mut t = world();
        let id = post(
            &mut t,
            PostTaskArgs {
                invited: vec![acct("bob.test"), acct("carol.test")],
                max_entries: 1,
                ..args()
            },
        );
        enter(&mut t, "bob.test", id, 1);
        // The task is full...
        let result = try_commit(
            &mut t,
            "carol.test",
            id,
            T1,
            HEIGHT,
            &commitment(id, "carol.test", 2),
        );
        assert_rejected(result, "E_FULL", "a second entrant");
        // ...and bob can still replace his commitment.
        let replacement = commitment(id, "bob.test", 3);
        try_commit(&mut t, "bob.test", id, T1 + SEC, HEIGHT + 2, &replacement).unwrap();
        assert!(get_logs()[0].contains(r#""replaced":true"#));
        assert_eq!(entry(&t, id, "bob.test").commitment, replacement);
        assert_eq!(counts(&t, id), (1, 0));
    }

    // Open tasks take entries only from active registered agents (owner decision, 2026-11-03).

    const NOT_REGISTERED: &str =
        "E_NOT_REGISTERED: open tasks take entries only from registered agents";

    /// The owner calls `f` with 1 yoctoNEAR.
    fn as_owner(t: &mut Tender, f: impl FnOnce(&mut Tender)) {
        testing_env!(ctx("owner.test").attached_deposit(ONE_YOCTO).build());
        f(t);
    }

    /// `who` calls `f` at `now` with 1 yoctoNEAR, which must go through.
    fn agent_call(t: &mut Tender, who: &str, now: u64, f: impl FnOnce(&mut Tender)) {
        testing_env!(ctx(who)
            .block_timestamp(now)
            .attached_deposit(ONE_YOCTO)
            .build());
        if let Some(message) = panic_message(|| f(t)) {
            panic!("{who} was refused: {message}");
        }
    }

    /// alice posts `task` at `now`. Returns its id.
    fn post_at(t: &mut Tender, task: PostTaskArgs, now: u64) -> u64 {
        testing_env!(ctx("alice.test")
            .attached_deposit(ONE_YOCTO)
            .block_timestamp(now)
            .build());
        t.post_task(task).0
    }

    #[test]
    fn open_task_commit_requires_registered_agent() {
        let mut t = world();
        let id = post(&mut t, args());
        // gina has a storage balance and has never registered.
        let result = try_commit(
            &mut t,
            STRANGER,
            id,
            T1,
            HEIGHT,
            &commitment(id, STRANGER, 1),
        );
        let message = assert_rejected(result, "E_NOT_REGISTERED", "an unregistered account");
        assert_eq!(message, NOT_REGISTERED);
        assert_eq!(t.get_entry(U64(id), acct(STRANGER)), None);
        assert!(t.balances_of(acct(STRANGER)).is_empty(), "no slot was made");
        assert_eq!(counts(&t, id), (0, 0));
        // The rule comes after the window, the poster and the verifier, and before the hash.
        let result = try_commit(&mut t, STRANGER, id, T1, HEIGHT, "x");
        assert_rejected(result, "E_NOT_REGISTERED", "a bad hash from a stranger");
        let result = try_commit(&mut t, "alice.test", id, T1, HEIGHT, "x");
        assert_rejected(result, "E_AUTH", "the unregistered poster");
        let result = try_commit(&mut t, STRANGER, id, COMMIT_DEADLINE, HEIGHT, "x");
        assert_rejected(result, "E_PHASE", "a stranger after the deadline");

        // Once registered, gina enters.
        register_agent(&mut t, STRANGER);
        enter(&mut t, STRANGER, id, 1);
        assert_eq!(counts(&t, id), (1, 0));

        // An agent that is unregistering may not replace its entry in an open task, nor enter
        // another one.
        enter(&mut t, "bob.test", id, 2);
        agent_call(&mut t, "bob.test", T1, Tender::unregister_agent);
        let kept = entry(&t, id, "bob.test");
        let result = try_commit(
            &mut t,
            "bob.test",
            id,
            T1,
            HEIGHT + 1,
            &commitment(id, "bob.test", 3),
        );
        let message = assert_rejected(result, "E_NOT_REGISTERED", "an unregistering agent");
        assert_eq!(message, NOT_REGISTERED);
        assert_eq!(
            entry(&t, id, "bob.test"),
            kept,
            "the entry stands as it was"
        );
        let other = post(&mut t, args());
        let result = try_commit(
            &mut t,
            "bob.test",
            other,
            T1,
            HEIGHT,
            &commitment(other, "bob.test", 4),
        );
        assert_rejected(
            result,
            "E_NOT_REGISTERED",
            "an unregistering agent, a new task",
        );

        // Nor may a retired one. With a cooldown of 60 s, carol retires as the first window ends,
        // and a task posted then is closed to her.
        as_owner(&mut t, |t| t.set_agent_bond_cooldown(U64(60)));
        agent_call(&mut t, "carol.test", T1, Tender::unregister_agent);
        agent_call(
            &mut t,
            "carol.test",
            COMMIT_DEADLINE,
            Tender::claim_agent_bond,
        );
        let later = post_at(&mut t, args(), COMMIT_DEADLINE);
        let result = try_commit(
            &mut t,
            "carol.test",
            later,
            COMMIT_DEADLINE,
            HEIGHT,
            &commitment(later, "carol.test", 5),
        );
        assert_rejected(result, "E_NOT_REGISTERED", "a retired agent");
        // Registering again lets her back in.
        testing_env!(ctx("carol.test")
            .block_timestamp(COMMIT_DEADLINE)
            .attached_deposit(ONE_YOCTO)
            .build());
        t.register_agent(URI.to_string(), BRIEF_HASH.to_string(), vec![]);
        try_commit(
            &mut t,
            "carol.test",
            later,
            COMMIT_DEADLINE,
            HEIGHT,
            &commitment(later, "carol.test", 5),
        )
        .unwrap();
    }

    #[test]
    fn pinned_task_commit_needs_no_registration() {
        let mut t = world();
        // bob is unregistering by the time he enters; gina never registered.
        agent_call(&mut t, "bob.test", T1, Tender::unregister_agent);
        let id = post(
            &mut t,
            PostTaskArgs {
                invited: vec![acct(STRANGER), acct("bob.test")],
                ..args()
            },
        );
        enter(&mut t, STRANGER, id, 1);
        enter(&mut t, "bob.test", id, 2);
        // Both may replace their entries too.
        try_commit(
            &mut t,
            STRANGER,
            id,
            T1 + SEC,
            HEIGHT + 1,
            &commitment(id, STRANGER, 3),
        )
        .unwrap();
        try_commit(
            &mut t,
            "bob.test",
            id,
            T1 + SEC,
            HEIGHT + 1,
            &commitment(id, "bob.test", 4),
        )
        .unwrap();
        assert_eq!(counts(&t, id), (2, 0));
        // Committing registers nobody, and gina gets a vault slot but no profile.
        assert_eq!(t.get_agent(acct(STRANGER)), None);
        assert_eq!(t.balance_of(acct(STRANGER), acct(USDC)), U128(0));
    }

    #[test]
    fn unregistering_agent_cannot_commit_but_can_reveal_and_be_paid() {
        let mut t = world();
        // A bond of 5 USDC, which gina pays when she registers, and a cooldown of 60 s.
        const BOND: u128 = 5_000_000;
        as_owner(&mut t, |t| t.set_agent_bond(acct(USDC), U128(BOND)));
        as_owner(&mut t, |t| t.set_agent_bond_cooldown(U64(60)));
        fund(&mut t, STRANGER, BOND);
        register_agent(&mut t, STRANGER);
        assert_eq!(t.balance_of(acct(STRANGER), acct(USDC)), U128(0));

        let id = post(&mut t, args());
        // `put_token` made no slot for the treasury's fee, as `set_token` would have.
        t.ensure_vault_slot(&acct("treasury.test"), &acct(USDC));
        enter(&mut t, STRANGER, id, 1);
        agent_call(&mut t, STRANGER, T1 + SEC, Tender::unregister_agent);
        let result = try_commit(
            &mut t,
            STRANGER,
            id,
            T1 + SEC,
            HEIGHT + 1,
            &commitment(id, STRANGER, 2),
        );
        assert_rejected(result, "E_NOT_REGISTERED", "replacing");

        // The entry she made stands: she reveals it, claims her bond back as soon as the cooldown
        // is over, which retires her, and the poster then picks her.
        try_reveal_work(&mut t, STRANGER, id, COMMIT_DEADLINE, 1, URI).unwrap();
        agent_call(&mut t, STRANGER, T1 + 61 * SEC, Tender::claim_agent_bond);
        assert_eq!(t.balance_of(acct(STRANGER), acct(USDC)), U128(BOND));
        testing_env!(ctx("alice.test").block_timestamp(REVEAL_DEADLINE).build());
        t.pick(
            U64(id),
            vec![WinnerArg {
                account: acct(STRANGER),
                bps: 10_000,
            }],
            CRITERIA_HASH.to_string(),
            URI.to_string(),
        );
        // 1 USDC less the 5% fee, beside the bond she got back.
        assert_eq!(
            t.balance_of(acct(STRANGER), acct(USDC)),
            U128(BOND + 950_000)
        );
        let gina = t.get_agent(acct(STRANGER)).expect("the record stays");
        assert_eq!((gina.entries, gina.reveals, gina.wins), (1, 1, 1));
    }

    #[test]
    fn bond_free_agent_must_hold_the_bond_once_one_is_set() {
        // bob registered while no bond was set, so he holds none. That is enough until the owner
        // sets one; from then on an open task needs a held bond.
        let mut t = world();
        let before = post(&mut t, args());
        enter(&mut t, "bob.test", before, 1);
        as_owner(&mut t, |t| t.set_agent_bond(acct(USDC), U128(5_000_000)));
        let id = post(&mut t, args());
        let result = try_commit(
            &mut t,
            "bob.test",
            id,
            T1,
            HEIGHT,
            &commitment(id, "bob.test", 2),
        );
        let message = assert_rejected(result, "E_NOT_REGISTERED", "a bond-free agent");
        assert!(message.starts_with(NOT_REGISTERED), "{message}");
        assert!(
            message.contains("register_agent"),
            "the message says what to do: {message}"
        );
        // Nor may he replace the entry he made before the bond was set.
        let result = try_commit(
            &mut t,
            "bob.test",
            before,
            T1,
            HEIGHT + 1,
            &commitment(before, "bob.test", 3),
        );
        assert_rejected(result, "E_NOT_REGISTERED", "replacing a pre-bond entry");
        // A task that invites him needs no bond.
        let pinned = post(
            &mut t,
            PostTaskArgs {
                invited: vec![acct("bob.test")],
                ..args()
            },
        );
        enter(&mut t, "bob.test", pinned, 4);
        // He registers again, which takes the bond, and then he enters.
        fund(&mut t, "bob.test", 5_000_000);
        register_agent(&mut t, "bob.test");
        assert_eq!(t.balance_of(acct("bob.test"), acct(USDC)), U128(0));
        enter(&mut t, "bob.test", id, 5);
        assert_eq!(counts(&t, id), (1, 0));
    }

    /// Independent review L3 / Task 16b review M1: with a cooldown far shorter than a task's commit
    /// window, a bond used to be claimable, passed on and used again for a second account in the
    /// same task. Each open entry now locks its agent's bond until that task's commit deadline.
    #[test]
    fn one_bond_cannot_seat_a_second_account_in_one_task() {
        let mut t = world();
        const BOND: u128 = 5_000_000;
        as_owner(&mut t, |t| t.set_agent_bond(acct(USDC), U128(BOND)));
        as_owner(&mut t, |t| t.set_agent_bond_cooldown(U64(60)));
        fund(&mut t, STRANGER, BOND);
        register_agent(&mut t, STRANGER);
        // A one-day commit window, against a cooldown of one minute.
        let id = post(
            &mut t,
            PostTaskArgs {
                commit_secs: 86_400,
                ..args()
            },
        );
        let deadline = T1 + 86_400 * SEC;
        try_commit(
            &mut t,
            STRANGER,
            id,
            T1 + SEC,
            HEIGHT,
            &commitment(id, STRANGER, 1),
        )
        .unwrap();
        assert_eq!(
            t.get_agent(acct(STRANGER)).unwrap().locked_until,
            Some(U64(deadline))
        );
        agent_call(&mut t, STRANGER, T1 + 2 * SEC, Tender::unregister_agent);
        let gina = t.get_agent(acct(STRANGER)).unwrap();
        assert_eq!(gina.claimable_at, Some(U64(deadline)), "not T1 + 62 s");
        // The cooldown is over, but the bond stays until the commit window closes.
        for now in [T1 + 62 * SEC, deadline - 1] {
            testing_env!(ctx(STRANGER)
                .block_timestamp(now)
                .attached_deposit(ONE_YOCTO)
                .build());
            let refused = panic_message(|| t.claim_agent_bond()).expect("too early");
            assert!(refused.starts_with("E_PHASE: "), "{refused}");
        }
        assert_eq!(t.balance_of(acct(STRANGER), acct(USDC)), U128(0));
        // From the deadline it comes back, when the task takes no more entries from anyone.
        agent_call(&mut t, STRANGER, deadline, Tender::claim_agent_bond);
        assert_eq!(t.balance_of(acct(STRANGER), acct(USDC)), U128(BOND));
        let result = try_commit(&mut t, "carol.test", id, deadline, HEIGHT, "x");
        assert_rejected(result, "E_PHASE", "the window has closed");
        assert_eq!(counts(&t, id), (1, 0));
    }

    #[test]
    fn locked_until_follows_the_latest_open_entry_only() {
        let mut t = world();
        as_owner(&mut t, |t| t.set_agent_bond_cooldown(U64(60)));
        // bob, an agent with no entry, has no lock, and would leave after the cooldown alone.
        assert_eq!(t.get_agent(acct("bob.test")).unwrap().locked_until, None);
        let long = post(
            &mut t,
            PostTaskArgs {
                commit_secs: 7_200,
                ..args()
            },
        );
        let short = post(&mut t, args());
        let pinned = post(
            &mut t,
            PostTaskArgs {
                commit_secs: 86_400,
                invited: vec![acct("bob.test")],
                ..args()
            },
        );
        let lock = |t: &Tender| t.get_agent(acct("bob.test")).unwrap().locked_until;
        enter(&mut t, "bob.test", long, 1);
        assert_eq!(lock(&t), Some(U64(T1 + 7_200 * SEC)));
        // A task that closes sooner does not lower it, and a pinned task, which needs no bond,
        // does not raise it.
        enter(&mut t, "bob.test", short, 2);
        enter(&mut t, "bob.test", pinned, 3);
        assert_eq!(lock(&t), Some(U64(T1 + 7_200 * SEC)));
        agent_call(&mut t, "bob.test", T1, Tender::unregister_agent);
        assert_eq!(
            t.get_agent(acct("bob.test")).unwrap().claimable_at,
            Some(U64(T1 + 7_200 * SEC))
        );
        // carol, with no open entry, may claim after the cooldown alone.
        agent_call(&mut t, "carol.test", T1, Tender::unregister_agent);
        assert_eq!(
            t.get_agent(acct("carol.test")).unwrap().claimable_at,
            Some(U64(T1 + 60 * SEC))
        );
    }

    // What a commit writes.

    #[test]
    fn commit_creates_payout_slots() {
        let mut t = world();
        let (gina, carol, usdc) = (acct(STRANGER), acct("carol.test"), acct(USDC));
        // gina has not registered, so she enters a task that invites her.
        let id = post(
            &mut t,
            PostTaskArgs {
                invited: vec![gina.clone(), carol.clone(), acct("dave.test")],
                ..args()
            },
        );
        // The premise: neither has a slot yet.
        assert!(t.balances_of(gina.clone()).is_empty());
        assert!(t.balances_of(carol.clone()).is_empty());
        assert_eq!(t.get_agent(carol.clone()).unwrap().earned, vec![]);

        enter(&mut t, STRANGER, id, 1);
        enter(&mut t, "carol.test", id, 2);
        let zero = vec![TokenBalance {
            token: usdc.clone(),
            amount: U128(0),
        }];
        // Each has a vault slot for the task's token, holding nothing yet.
        assert_eq!(t.balances_of(gina.clone()), zero);
        assert_eq!(t.balances_of(carol.clone()), zero);
        // The registered agent also has an `earned` slot for it...
        let carol_profile = t.get_agent(carol).unwrap();
        assert_eq!(carol_profile.earned, zero);
        assert_eq!(carol_profile.entries, 1);
        // ...and committing does not register anyone.
        assert_eq!(t.get_agent(gina), None);

        // A slot that exists keeps its balance.
        fund(&mut t, "dave.test", 5);
        enter(&mut t, "dave.test", id, 3);
        assert_eq!(t.balance_of(acct("dave.test"), usdc), U128(5));
    }

    #[test]
    fn recommit_replaces_without_storage_or_count() {
        let mut t = world();
        register_agent(&mut t, "bob.test");
        let id = post(&mut t, args());
        enter(&mut t, "bob.test", id, 1);
        let first = entry(&t, id, "bob.test");
        let used_before = used(&t, "bob.test");

        // Later in the window, from a later block, bob replaces his commitment.
        let second = commitment(id, "bob.test", 2);
        call_as("bob.test", COMMIT_DEADLINE - 1, HEIGHT + 100);
        let usage = t.storage_mark();
        t.commit(U64(id), second.clone());
        assert_eq!(env::storage_usage(), usage, "the replacement adds no bytes");
        assert_eq!(used(&t, "bob.test"), used_before, "and is charged nothing");
        assert_eq!(
            get_logs(),
            [event(
                "committed",
                &format!(
                    r#"{{"task_id":"1","account":"bob.test","commitment":"{second}","replaced":true,"block_height":"{}"}}"#,
                    HEIGHT + 100
                )
            )]
        );
        // Still one entry, at the same index, with the new commitment and block.
        assert_eq!(
            entry(&t, id, "bob.test"),
            EntryView {
                commitment: second,
                committed_at_block: U64(HEIGHT + 100),
                ..first
            }
        );
        assert_eq!(counts(&t, id), (1, 0));
        assert_eq!(page(&t, id, 0, 50), indexed(&[(0, "bob.test")]));
        assert_eq!(
            t.get_agent(acct("bob.test")).unwrap().entries,
            1,
            "a replacement is not another entry"
        );
    }

    #[test]
    fn an_entrant_under_water_can_replace_its_commitment() {
        // A rise in the storage price can leave a deposit short of the bytes it already pays for.
        // A replacement adds no bytes, so it is not refused for that.
        let mut t = world();
        let id = post(&mut t, args());
        enter(&mut t, "bob.test", id, 1);
        t.storage.get_mut(&acct("bob.test")).unwrap().deposited = 0;
        let used_before = used(&t, "bob.test");

        let second = commitment(id, "bob.test", 2);
        try_commit(&mut t, "bob.test", id, T1, HEIGHT + 1, &second).unwrap();
        assert_eq!(entry(&t, id, "bob.test").commitment, second);
        assert_eq!(used(&t, "bob.test"), used_before);
    }

    #[test]
    fn commit_and_reveal_charge_the_caller() {
        let mut t = world();
        // gina, who has not registered, needs a task that invites her.
        let id = post(
            &mut t,
            PostTaskArgs {
                invited: vec![acct(STRANGER), acct("carol.test")],
                ..args()
            },
        );
        let alice_used = used(&t, "alice.test");
        for (who, agent) in [(STRANGER, false), ("carol.test", true)] {
            let start = used(&t, who);
            // The mocked VM restarts `storage_usage` with every context, so the mark is taken in
            // the context of the call itself.
            call_as(who, T1, HEIGHT);
            let usage = t.storage_mark();
            t.commit(U64(id), commitment(id, who, 1));
            let grown = env::storage_usage() - usage;
            assert_eq!(grown, commit_bytes(who, agent), "{who}");
            assert_eq!(used(&t, who), start + grown, "{who} pays for all of it");
        }
        assert_eq!(commit_bytes("bob.test", false), 106 + 65 + 82);

        // A reveal adds what `reveal_bytes` counts.
        let start = used(&t, STRANGER);
        call_as(STRANGER, COMMIT_DEADLINE, HEIGHT);
        let usage = t.storage_mark();
        let (content_hash, salt) = work(1);
        t.reveal(U64(id), hex32(&content_hash), hex32(&salt), URI.to_string());
        let grown = env::storage_usage() - usage;
        assert_eq!(grown, reveal_bytes(URI));
        assert_eq!(used(&t, STRANGER), start + grown);
        // The poster pays for none of it.
        assert_eq!(used(&t, "alice.test"), alice_used);
    }

    // Each storage test below uses one contract. The mocked VM keeps what a call flushed before
    // it panicked, and `testing_env!` carries the mocked storage over to the next contract, so a
    // second contract in the same test would see the records of the first.

    #[test]
    fn commit_needs_a_storage_balance() {
        let mut t = world();
        // nobody has neither a storage balance nor a profile, so it enters a task that invites it.
        let id = post(
            &mut t,
            PostTaskArgs {
                invited: vec![acct("nobody.test")],
                ..args()
            },
        );
        let result = try_commit(
            &mut t,
            "nobody.test",
            id,
            T1,
            HEIGHT,
            &commitment(id, "nobody.test", 1),
        );
        let message = assert_rejected(result, "E_STORAGE", "no storage balance");
        assert_eq!(message, "E_STORAGE: not registered");
    }

    #[test]
    fn commit_needs_storage_for_every_record_it_adds() {
        // Two tasks, so that what bob's failed call wrote cannot shrink carol's records.
        let mut t = world();
        let (short, exact) = (post(&mut t, args()), post(&mut t, args()));
        // One byte short, the commit fails...
        leave_spare(&mut t, "bob.test", commit_bytes("bob.test", true) - 1);
        let bobs = commitment(short, "bob.test", 1);
        let result = try_commit(&mut t, "bob.test", short, T1, HEIGHT, &bobs);
        let message = assert_rejected(result, "E_STORAGE", "one byte short");
        assert_eq!(
            message,
            "E_STORAGE: insufficient storage balance; call storage_deposit"
        );
        // ...and with exactly enough it goes through and leaves nothing.
        leave_spare(&mut t, "carol.test", commit_bytes("carol.test", true));
        enter(&mut t, "carol.test", exact, 2);
        assert_eq!(t.storage_available(&acct("carol.test")), 0);
    }

    #[test]
    fn reveal_needs_storage_for_the_bytes_it_adds() {
        let mut t = world();
        let id = post(&mut t, args());
        enter(&mut t, "bob.test", id, 1);
        enter(&mut t, "carol.test", id, 2);
        // One byte short, the reveal fails...
        leave_spare(&mut t, "bob.test", reveal_bytes(URI) - 1);
        let result = try_reveal_work(&mut t, "bob.test", id, COMMIT_DEADLINE, 1, URI);
        let message = assert_rejected(result, "E_STORAGE", "one byte short");
        assert_eq!(
            message,
            "E_STORAGE: insufficient storage balance; call storage_deposit"
        );
        // ...and with exactly enough it goes through and leaves nothing.
        leave_spare(&mut t, "carol.test", reveal_bytes(URI));
        try_reveal_work(&mut t, "carol.test", id, COMMIT_DEADLINE, 2, URI).unwrap();
        assert_eq!(t.storage_available(&acct("carol.test")), 0);
    }

    #[test]
    fn reputation_counters_saturate() {
        let mut t = world();
        register_agent(&mut t, "bob.test");
        let id = post(&mut t, args());
        t.with_profile(&acct("bob.test"), |p| {
            p.entries = u32::MAX;
            p.reveals = u32::MAX;
        });
        // Counting past the top would abort the call; the counters stop there instead.
        enter(&mut t, "bob.test", id, 1);
        try_reveal_work(&mut t, "bob.test", id, COMMIT_DEADLINE, 1, URI).unwrap();
        let profile = t.get_agent(acct("bob.test")).unwrap();
        assert_eq!((profile.entries, profile.reveals), (u32::MAX, u32::MAX));
        assert_eq!(counts(&t, id), (1, 1));
    }

    #[test]
    fn commit_and_reveal_work_while_paused() {
        let mut t = world();
        let id = post(&mut t, args());
        t.paused = true;
        enter(&mut t, "bob.test", id, 1);
        try_reveal_work(&mut t, "bob.test", id, COMMIT_DEADLINE, 1, URI).unwrap();
        assert_eq!(counts(&t, id), (1, 1));
    }

    #[test]
    fn commit_and_reveal_act_for_the_predecessor_not_the_signer() {
        // carol signs a transaction whose call reaches Tender from bob (a contract account, say).
        // The entry is bob's, and bob pays for it.
        let mut t = world();
        let id = post(&mut t, args());
        let (bob_used, carol_used) = (used(&t, "bob.test"), used(&t, "carol.test"));
        testing_env!(ctx("bob.test")
            .signer_account_id(acct("carol.test"))
            .block_timestamp(T1)
            .block_height(HEIGHT)
            .build());
        t.commit(U64(id), commitment(id, "bob.test", 1));
        assert_eq!(entry(&t, id, "bob.test").index, 0);
        assert_eq!(t.get_entry(U64(id), acct("carol.test")), None);
        assert!(used(&t, "bob.test") > bob_used);
        assert_eq!(used(&t, "carol.test"), carol_used);

        let (content_hash, salt) = work(1);
        testing_env!(ctx("bob.test")
            .signer_account_id(acct("carol.test"))
            .block_timestamp(COMMIT_DEADLINE)
            .build());
        t.reveal(U64(id), hex32(&content_hash), hex32(&salt), URI.to_string());
        assert_eq!(entry(&t, id, "bob.test").uri.as_deref(), Some(URI));
        assert_eq!(used(&t, "carol.test"), carol_used);
    }

    // Windows.

    #[test]
    fn commit_at_deadline_rejected_reveal_at_deadline_accepted() {
        let mut t = world();
        let id = post(&mut t, args());
        let task = t.get_task(U64(id)).unwrap();
        assert_eq!(
            (task.commit_deadline.0, task.reveal_deadline.0),
            (COMMIT_DEADLINE, REVEAL_DEADLINE)
        );
        enter(&mut t, "bob.test", id, 1);
        enter(&mut t, "carol.test", id, 2);

        // The commit window ends just before `commit_deadline`: the last nanosecond takes a
        // commit, and the deadline takes neither a new one nor a replacement.
        let at = |who: &str, now: u64, seed: u8, t: &mut Tender| {
            try_commit(t, who, id, now, HEIGHT, &commitment(id, who, seed))
        };
        at("dave.test", COMMIT_DEADLINE - 1, 3, &mut t).unwrap();
        let result = at("erin.test", COMMIT_DEADLINE, 4, &mut t);
        assert_rejected(result, "E_PHASE", "a new commit at the commit deadline");
        let result = at("bob.test", COMMIT_DEADLINE, 5, &mut t);
        let message = assert_rejected(result, "E_PHASE", "a replacement at the commit deadline");
        assert_eq!(message, "E_PHASE: task 1 is not open for commits");

        // The reveal window starts at `commit_deadline` and ends just before `reveal_deadline`.
        let result = try_reveal_work(&mut t, "bob.test", id, COMMIT_DEADLINE - 1, 1, URI);
        assert_rejected(result, "E_PHASE", "a reveal before the commit deadline");
        try_reveal_work(&mut t, "bob.test", id, COMMIT_DEADLINE, 1, URI).unwrap();
        try_reveal_work(&mut t, "carol.test", id, REVEAL_DEADLINE - 1, 2, URI).unwrap();
        let result = try_reveal_work(&mut t, "dave.test", id, REVEAL_DEADLINE, 3, URI);
        let message = assert_rejected(result, "E_PHASE", "a reveal at the reveal deadline");
        assert_eq!(message, "E_PHASE: task 1 is not in its reveal window");

        assert_eq!(counts(&t, id), (3, 2));
        assert_eq!(entry(&t, id, "dave.test").uri, None);
    }

    // Reveals.

    #[test]
    fn reveal_wrong_salt_rejected() {
        let mut t = world();
        let id = post(&mut t, args());
        enter(&mut t, "bob.test", id, 1);
        let (content_hash, salt) = work(1);
        let (other_content, other_salt) = work(2);
        for (what, content_hash, salt) in [
            ("the wrong salt", content_hash, other_salt),
            ("the wrong content hash", other_content, salt),
        ] {
            let result = try_reveal(
                &mut t,
                "bob.test",
                id,
                COMMIT_DEADLINE,
                &hex32(&content_hash),
                &hex32(&salt),
                URI,
            );
            let message = assert_rejected(result, "E_COMMITMENT", what);
            assert_eq!(
                message,
                "E_COMMITMENT: content_hash and salt do not match the commitment"
            );
        }
        assert_eq!(entry(&t, id, "bob.test").content_hash, None);
        assert_eq!(counts(&t, id), (1, 0));
        // The right pair opens it.
        try_reveal_work(&mut t, "bob.test", id, COMMIT_DEADLINE, 1, URI).unwrap();
        assert_eq!(
            entry(&t, id, "bob.test").content_hash,
            Some(hex32(&content_hash))
        );
    }

    #[test]
    fn double_reveal_rejected() {
        let mut t = world();
        register_agent(&mut t, "bob.test");
        let id = post(&mut t, args());
        enter(&mut t, "bob.test", id, 1);
        try_reveal_work(&mut t, "bob.test", id, COMMIT_DEADLINE, 1, URI).unwrap();
        // Again, pointing at the same place or somewhere else.
        for uri in [URI, "https://elsewhere.example/v2"] {
            let result = try_reveal_work(&mut t, "bob.test", id, COMMIT_DEADLINE + SEC, 1, uri);
            let message = assert_rejected(result, "E_REVEALED", uri);
            assert_eq!(
                message,
                "E_REVEALED: bob.test has already revealed in task 1"
            );
        }
        // The first reveal stands, counted once.
        assert_eq!(entry(&t, id, "bob.test").uri.as_deref(), Some(URI));
        assert_eq!(counts(&t, id), (1, 1));
        assert_eq!(t.get_agent(acct("bob.test")).unwrap().reveals, 1);
    }

    #[test]
    fn reveal_uri_too_long_rejected() {
        let mut t = world();
        let id = post(&mut t, args());
        enter(&mut t, "bob.test", id, 1);
        for (what, uri, length) in [
            ("257 bytes", "u".repeat(MAX_URI_BYTES + 1), 257),
            ("129 two-byte characters", "é".repeat(129), 258),
            ("an empty uri", String::new(), 0),
        ] {
            let result = try_reveal_work(&mut t, "bob.test", id, COMMIT_DEADLINE, 1, &uri);
            let message = assert_rejected(result, "E_URI", what);
            assert_eq!(
                message,
                format!("E_URI: uri must be 1 to 256 bytes, got {length}")
            );
        }
        assert_eq!(entry(&t, id, "bob.test").uri, None);
        // 256 bytes fit.
        let longest = "u".repeat(MAX_URI_BYTES);
        try_reveal_work(&mut t, "bob.test", id, COMMIT_DEADLINE, 1, &longest).unwrap();
        assert_eq!(entry(&t, id, "bob.test").uri, Some(longest));
    }

    #[test]
    fn hashes_must_be_lowercase_hex() {
        let mut t = world();
        let id = post(&mut t, args());
        let good = commitment(id, "bob.test", 1);
        assert_ne!(good.to_uppercase(), good, "the premise: it has letters");
        for bad in [
            good.to_uppercase(),
            good[..63].to_string(),
            format!("{good}0"),
            format!("0x{}", &good[2..]),
            String::new(),
        ] {
            let result = try_commit(&mut t, "bob.test", id, T1, HEIGHT, &bad);
            assert_eq!(
                assert_rejected(result, "E_HASH", &format!("commitment {bad:?}")),
                "E_HASH: commitment: expected 64 lowercase hex chars"
            );
        }
        assert_eq!(t.get_entry(U64(id), acct("bob.test")), None);
        enter(&mut t, "bob.test", id, 1);

        let (content_hash, salt) = work(1);
        let (content_hash, salt) = (hex32(&content_hash), hex32(&salt));
        for (what, field, content_hash, salt) in [
            (
                "an uppercase content hash",
                "content_hash",
                content_hash.to_uppercase(),
                salt.clone(),
            ),
            (
                "a short salt",
                "salt",
                content_hash.clone(),
                salt[..62].to_string(),
            ),
            (
                "a salt that is not hex",
                "salt",
                content_hash.clone(),
                format!("g{}", &salt[1..]),
            ),
        ] {
            let result = try_reveal(
                &mut t,
                "bob.test",
                id,
                COMMIT_DEADLINE,
                &content_hash,
                &salt,
                URI,
            );
            assert_eq!(
                assert_rejected(result, "E_HASH", what),
                format!("E_HASH: {field}: expected 64 lowercase hex chars")
            );
        }
        try_reveal(
            &mut t,
            "bob.test",
            id,
            COMMIT_DEADLINE,
            &content_hash,
            &salt,
            URI,
        )
        .unwrap();
    }

    #[test]
    fn missing_task_or_entry_is_not_found() {
        let mut t = world();
        let result = try_commit(
            &mut t,
            "bob.test",
            99,
            T1,
            HEIGHT,
            &commitment(99, "bob.test", 1),
        );
        let message = assert_rejected(result, "E_NOT_FOUND", "a commit to a missing task");
        assert_eq!(message, "E_NOT_FOUND: no task 99");
        let result = try_reveal_work(&mut t, "bob.test", 99, COMMIT_DEADLINE, 1, URI);
        assert_rejected(result, "E_NOT_FOUND", "a reveal in a missing task");
        // The views answer with nothing instead.
        assert!(t.get_entries(U64(99), 0, 50).is_empty());
        assert_eq!(t.get_entry(U64(99), acct("bob.test")), None);

        // An account that never committed has nothing to reveal.
        let id = post(&mut t, args());
        enter(&mut t, "bob.test", id, 1);
        let result = try_reveal_work(&mut t, "carol.test", id, COMMIT_DEADLINE, 2, URI);
        let message = assert_rejected(result, "E_NOT_FOUND", "a reveal without a commit");
        assert_eq!(message, "E_NOT_FOUND: carol.test has no entry in task 1");
        assert_eq!(t.get_entry(U64(id), acct("carol.test")), None);
        assert_eq!(counts(&t, id), (1, 0));
    }

    #[test]
    fn commit_rules_are_checked_in_the_listed_order() {
        // alice sends a malformed commitment, at the deadline, to a full task she posted and is
        // not invited to. Each step mends the rule that was reported, so the next one in the list
        // has to be the next one reported.
        struct Attempt {
            who: &'static str,
            now: u64,
            commitment: String,
        }
        type Mend = fn(&mut Tender, &mut Attempt);
        let mut t = world();
        let id = post(
            &mut t,
            PostTaskArgs {
                invited: vec![acct("bob.test"), acct("carol.test")],
                max_entries: 1,
                ..args()
            },
        );
        assert_eq!(id, 1, "the steps below name the task by its id");
        enter(&mut t, "bob.test", id, 1);
        let mut attempt = Attempt {
            who: "alice.test",
            now: COMMIT_DEADLINE,
            commitment: "x".to_string(),
        };
        let steps: [(&str, Mend); 5] = [
            ("E_PHASE", |_, a| a.now = T1),
            ("E_AUTH", |_, a| a.who = "dave.test"),
            ("E_INVITE", |_, a| a.who = "carol.test"),
            ("E_HASH", |_, a| {
                a.commitment = commitment(1, "carol.test", 2)
            }),
            ("E_FULL", |t, _| {
                t.tasks.get_mut(&1u64).unwrap().max_entries = 2
            }),
        ];
        for (code, mend) in steps {
            let result = try_commit(
                &mut t,
                attempt.who,
                id,
                attempt.now,
                HEIGHT,
                &attempt.commitment,
            );
            assert_rejected(result, code, code);
            mend(&mut t, &mut attempt);
        }
        try_commit(
            &mut t,
            attempt.who,
            id,
            attempt.now,
            HEIGHT,
            &attempt.commitment,
        )
        .unwrap();
        assert_eq!(counts(&t, id), (2, 0));
    }

    #[test]
    fn reveal_rules_are_checked_in_the_listed_order() {
        // dave, who never committed, reveals too early, with an empty uri and a salt that is not
        // hex. Each step mends the rule that was reported.
        struct Attempt {
            who: &'static str,
            now: u64,
            salt: String,
            uri: String,
        }
        type Mend = fn(&mut Attempt);
        let mut t = world();
        let id = post(&mut t, args());
        enter(&mut t, "bob.test", id, 1);
        enter(&mut t, "carol.test", id, 2);
        try_reveal_work(&mut t, "bob.test", id, COMMIT_DEADLINE, 1, URI).unwrap();
        // carol's content hash, which every attempt sends.
        let content_hash = hex32(&work(2).0);
        let mut attempt = Attempt {
            who: "dave.test",
            now: COMMIT_DEADLINE - 1,
            salt: "x".to_string(),
            uri: String::new(),
        };
        let steps: [(&str, Mend); 6] = [
            ("E_PHASE", |a| a.now = COMMIT_DEADLINE),
            ("E_NOT_FOUND", |a| a.who = "bob.test"),
            ("E_REVEALED", |a| a.who = "carol.test"),
            ("E_URI", |a| a.uri = URI.to_string()),
            // Well-formed, but not carol's salt.
            ("E_HASH", |a| a.salt = hex32(&[9; 32])),
            ("E_COMMITMENT", |a| a.salt = hex32(&work(2).1)),
        ];
        for (code, mend) in steps {
            let result = try_reveal(
                &mut t,
                attempt.who,
                id,
                attempt.now,
                &content_hash,
                &attempt.salt,
                &attempt.uri,
            );
            assert_rejected(result, code, code);
            mend(&mut attempt);
        }
        try_reveal(
            &mut t,
            attempt.who,
            id,
            attempt.now,
            &content_hash,
            &attempt.salt,
            &attempt.uri,
        )
        .unwrap();
        assert_eq!(counts(&t, id), (2, 2));
    }

    // Views and events.

    #[test]
    fn commit_and_reveal_emit_events() {
        let mut t = world();
        let id = post(&mut t, args());
        let c = commitment(id, "bob.test", 1);
        try_commit(&mut t, "bob.test", id, T1, HEIGHT, &c).unwrap();
        assert_eq!(
            get_logs(),
            [event(
                "committed",
                &format!(
                    r#"{{"task_id":"1","account":"bob.test","commitment":"{c}","replaced":false,"block_height":"{HEIGHT}"}}"#
                )
            )]
        );
        try_reveal_work(&mut t, "bob.test", id, COMMIT_DEADLINE, 1, URI).unwrap();
        assert_eq!(
            get_logs(),
            [event(
                "revealed",
                &format!(
                    r#"{{"task_id":"1","account":"bob.test","content_hash":"{}","uri":"{URI}"}}"#,
                    hex32(&work(1).0)
                )
            )]
        );
    }

    #[test]
    fn entry_view_json_uses_strings_and_hex() {
        let mut t = world();
        let id = post(&mut t, args());
        let c = commitment(id, "bob.test", 1);
        try_commit(&mut t, "bob.test", id, T1, HEIGHT, &c).unwrap();
        assert_eq!(
            serde_json::to_string(&entry(&t, id, "bob.test")).unwrap(),
            format!(
                r#"{{"task_id":"1","account":"bob.test","index":0,"commitment":"{c}","committed_at_block":"{HEIGHT}","content_hash":null,"uri":null}}"#
            )
        );
        try_reveal_work(&mut t, "bob.test", id, COMMIT_DEADLINE, 1, URI).unwrap();
        assert_eq!(
            serde_json::to_string(&entry(&t, id, "bob.test")).unwrap(),
            format!(
                r#"{{"task_id":"1","account":"bob.test","index":0,"commitment":"{c}","committed_at_block":"{HEIGHT}","content_hash":"{}","uri":"{URI}"}}"#,
                hex32(&work(1).0)
            )
        );
    }

    #[test]
    fn entries_paginate_by_index() {
        let mut t = world();
        let id = post(&mut t, args());
        assert!(t.get_entries(U64(id), 0, 50).is_empty(), "no entries yet");
        for (seed, who) in ["bob.test", "carol.test", "dave.test"]
            .into_iter()
            .enumerate()
        {
            enter(&mut t, who, id, seed as u8);
        }
        let all = indexed(&[(0, "bob.test"), (1, "carol.test"), (2, "dave.test")]);
        assert_eq!(page(&t, id, 0, 50), all);
        assert_eq!(page(&t, id, 1, 1), indexed(&[(1, "carol.test")]));
        assert_eq!(page(&t, id, 1, 50), all[1..]);
        // A limit of 0 means 1.
        assert_eq!(page(&t, id, 0, 0), all[..1]);
        // Past the end the page is empty, even from the largest index.
        assert!(page(&t, id, 3, 50).is_empty());
        assert!(page(&t, id, u32::MAX, u32::MAX).is_empty());
        // A page shows each entry as get_entry does.
        let entries = t.get_entries(U64(id), 0, 50);
        assert_eq!(entries[1], entry(&t, id, "carol.test"));
        // Replacing a commitment keeps the entry's place.
        try_commit(
            &mut t,
            "carol.test",
            id,
            T1,
            HEIGHT + 1,
            &commitment(id, "carol.test", 9),
        )
        .unwrap();
        assert_eq!(page(&t, id, 0, 50), all);

        // A page holds at most 50 entries, however large the limit.
        for i in 3..55 {
            let who = format!("agent{i}.test");
            register(&mut t, &who, NearToken::from_millinear(100));
            register_agent(&mut t, &who);
            enter(&mut t, &who, id, i as u8);
        }
        assert_eq!(counts(&t, id).0, 55);
        let first_fifty: Vec<u32> = (0..50).collect();
        let indices = |p: Vec<(u32, String)>| p.into_iter().map(|(i, _)| i).collect::<Vec<_>>();
        assert_eq!(indices(page(&t, id, 0, 500)), first_fifty);
        assert_eq!(indices(page(&t, id, 0, u32::MAX)), first_fifty);
        assert_eq!(indices(page(&t, id, 50, 500)), [50, 51, 52, 53, 54]);
        assert_eq!(page(&t, id, 54, 1), indexed(&[(54, "agent54.test")]));
    }

    #[test]
    fn get_entries_skips_cleaned_entries() {
        let mut t = world();
        let id = post(&mut t, args());
        for (seed, who) in ["bob.test", "carol.test", "dave.test"]
            .into_iter()
            .enumerate()
        {
            enter(&mut t, who, id, seed as u8);
        }
        // Task 9's cleanup removes both records of an entry, lowest index first, and leaves
        // `commit_count` alone.
        for (index, who) in [(0u32, "bob.test"), (1, "carol.test")] {
            t.entrant_at.remove(&(id, index));
            t.entries.remove(&(id, acct(who)));
        }
        assert_eq!(page(&t, id, 0, 50), indexed(&[(2, "dave.test")]));
        // Pages go by index, so a page of cleaned indices is empty rather than shifted.
        assert!(page(&t, id, 0, 2).is_empty());
        assert_eq!(t.get_entry(U64(id), acct("bob.test")), None);
        assert_eq!(counts(&t, id), (3, 0));
    }
}
