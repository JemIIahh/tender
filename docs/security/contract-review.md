# Tender contract: freeze review

Plan 01 Task 16, run 2026-11-03 on branch `wt/p01-p1`, before the contract is deployed anywhere
public. It covers `contract/tender/src` at commit `6b79b40`: the P0 contract plus pooled top-ups
(Task 13), lineage (Task 14) and delegate keys (Task 15).

**Freeze tag deferred to after 16b (owner decision).** The owner approved one more contract change,
a refundable agent registration bond with open tasks limited to registered agents (Task 16b, on
this lane), so `contract-freeze-1` is not set here. It goes on the commit after 16b, which this
review must then be extended to cover.

## How it was reviewed

- **Adversarial suite.** `contract/sandbox/tests/adversarial.rs` (12 tests on the built wasm and a
  real nearcore 2.13.4 node), `verifier_delegate_key_cannot_pick` in `delegate.rs`, and the
  property test `ft_on_transfer_never_panics_on_random_msg` in `contract/tender/src/vault.rs`. Each
  is listed with its result at the end.
- **Source audit.** The `security-audit` skill, in its guidance mode (a focused review, done by the
  implementer alone; the full mode needs sub-agents, which this task does not use). Every
  non-test line of `lib.rs`, `types.rs`, `events.rs`, `auth.rs`, `storage.rs`, `vault.rs`,
  `tasks.rs`, `entries.rs`, `settle.rs`, `admin.rs` and `registry.rs` was read against spec §6 and
  the §6.10 invariants. A finding needs a lower-trust caller, a crossed boundary and a concrete
  result; a missing best practice alone is not one.
- **The docs.near.org security checklist** (fetched 2026-11-03), walked item by item below.
- **The Task 13, 14 and 15 reviews** and the ledger's carries into this task.
- **Still to come.** The controller dispatches one independent reviewer, given the code and spec §6
  only, after this record. Its findings are added here in a fix round.

Severity follows the skill's scale: high fully defeats an explicit control with real
consequences; medium is a real boundary violation with limited reach or uncommon preconditions;
low is minor gain for sustained effort; info is a confirmed observation of minimal impact.

## Findings

| # | Issue | Severity | Fix commit | Test |
|---|---|---|---|---|
| 1 | **Funder records could be squatted with dust.** 49 one-unit top-ups took the 49 funder records after the poster's, and `E_LIMIT` then refused every later funder of that pooled task. No money at risk (Task 13 review; automated MEDIUM griefing flag). Now an account's first top-up of a task must be at least the token's current `min_reward`; a funder already in, the poster included, adds any amount. Filling the records now puts at least 49 × `min_reward` into the escrow, where a pick pays it to the winners. **This is a price, not a bar, and the gap is accepted (controller ruling, fix round 1):** on testnet, tUSDC's `min_reward` is 1 (scripts/deploy.ts:115), so the rule is no more than the old `amount > 0` and 49 base units of a free token still fill the records; on mainnet (`min_reward` 0.1 USDC) the same squat costs 4.9 USDC, which becomes part of the reward and goes to the winner. That is griefing, not theft: nothing is taken or trapped. The agent bond of Task 16b does not cover funders. | Low | `07721ce` (mitigated on mainnet only) | `forty_nine_dust_funders_then_a_real_funder` (failed before the fix: the first dust top-up went through); props model and scripted run |
| 2 | **A delegate key could pick.** `pick` checked only the predecessor. A delegate key whose access key allows `pick` (or every method) could award the escrow of every task its account verifies, or posted and reached the fallback window, even tasks funded through the uncapped 1-yocto path. That defeats auth.rs's bound "a leaked key costs at most `total_cap`" (Task 15 review, minor 2). `pick` now refuses `E_AUTH` when the call is signed by one of the caller's delegate keys, found with the lookup `authorize_spend` uses (one shared helper, `direct_signing_key`). | Medium | `5309565` | `delegate_key_cannot_pick` (unit), `verifier_delegate_key_cannot_pick` (sandbox: on the old wasm the delegate key's pick paid out) |
| 3 | **`per_task_cap` was documented per task but is enforced per call.** A post plus top-ups by one key can put up to `total_cap` into one task. The semantics stay; the docs (types.rs, events.rs, auth.rs), the `E_AUTH` text ("per-call cap (per_task_cap)") and plan 07's swarm step now say per call (Task 15 review, minor 1). | Info | `d00d38e` | `delegate_over_per_task_cap_rejected` pins the new text |
| 4 | **`res/` could be committed stale.** `check-res.sh` compared `SOURCES.sha256` with the sources and the wasm with `SHA256SUMS`, but nothing tied the two: a commit carrying the new sources and `SOURCES.sha256` without the rebuilt wasm and `SHA256SUMS` passed CI, so the committed, deployable wasm could be an older build (final-fix parking list). `SOURCES.sha256` now records the sources' hash bound to `SHA256SUMS`, and `check-res.sh` recomputes both. | Low | `7ce4b31` | scratch-clone check: that commit, the reverse (wasm without sources), and a wasm that does not match its sums all fail; a consistent `res/` passes |
| 5 | `with_profile` used `get_mut`, which marks a miss as changed, so each commit, reveal and pick of an unregistered account removed a missing key on flush. Gas only (Task 5/7 minors, R33). | Info | `9045725` | behaviour unchanged; the existing suites |
| 6 | `storage_deposit` with `registration_only` on a registered account wrote the unchanged record back. Gas only (final-fix parking list). | Info | `9045725` | `storage_deposit_follows_nep145_registration_only` (sandbox) unchanged |
| 7 | **The property oracle had two blind spots** (Task 11 review, R33): any panic counted as a rejection, so an overflow or `unwrap` crash could pass for a rule; and a settlement that went through was never checked against the rules. Every rejection must now carry an `E_` code, and a pick, empty pick or void that succeeds must be one the model allows. The token's `min_reward` in the harness is now 10, so random top-ups meet finding 1's rule. | Info (tests) | `6b79b40` | `invariants_hold_after_every_call` at 512 cases, `scripted_run_reaches_every_outcome` |
| 8 | **The storage layout was not pinned** (Task 2 minor, R33). The collections' prefixes 0 to 7, the `VoidReason` and `Outcome` tags, a fresh contract's root state and a task record are now pinned byte for byte, so a change that moves the layout fails until it comes with a `migrate`. | Info (tests) | `6b79b40` | `storage_layout_is_pinned` |
| 9 | **Open-task capture (P05-R21) is now bounded by bonds (Task 16b, owner decision 2026-11-03).** Before, any NEAR account could commit to any open task, so 49 cheap filler accounts could take the 50 places the Judge grades on an open rubric task. Now `commit` to an open task needs an active registered agent (`E_NOT_REGISTERED`), and once the owner sets a bond, registering debits it from the agent's vault until the agent unregisters, waits out the cooldown and claims it back. 49 fillers therefore need 49 bonds locked at once, as long as the cooldown is at least the task's commit window (the default is 14 days, the longest window); a shorter cooldown lets one bond be passed on and seat several fillers in one window. Agents registered before the bond was set keep their places without one, so the bond must be set at deploy, before anyone registers. Funders are not covered (finding 1). Pinned tasks are unchanged. | Medium (mitigated) | `e516b75` | `forty_nine_unbonded_fillers_refused` (sandbox), `fillers_without_bonds_cannot_enter_open_task` (sandbox), `open_task_commit_requires_registered_agent` (unit) |

### Checked, and accepted or left to operations

| # | Observation | Severity | Disposition |
|---|---|---|---|
| A1 | Anyone can make a vault slot for a registered account with a dust `{"for": victim}` deposit, charged to the victim's storage (≤ 200 B per allowlisted token, only when the victim can afford it). | Low | Accepted (R22): bounded by the allowlist, zero on a USDC-only mainnet once the victim holds USDC; agents keep ≥ 1 KB spare (plans 04/05). |
| A2 | A poster who names itself verifier can read the revealed work and refuse to pay (empty pick, or let the windows lapse). | Design | Known weakness, spec §6.4; UI flags poster-as-verifier tasks and shows `voids_after_reveals`. |
| A3 | Funders of a pooled task inherit the poster's terms, its verifier included, so a poster-verifier can award pooled money to an accomplice who revealed. | Design | Spec §6.4 ("its terms are the poster's"). The UI must show the verifier before anyone tops up. |
| A4 | Whoever holds the contract account's full-access key can deploy new code (`migrate` is `#[private]`) and so move every balance. | Operational | Not a code defect. The README and the plan 07 runbook must say who holds the key and when it is removed (honesty carry-forward). |
| A5 | A leaked function-call key with allowance `None` can burn the account's liquid NEAR on gas; caps bound tokens, not NEAR. | Operational | Plan 07 runbook (Task 15 review): finite allowance, exactly the four methods, low liquid NEAR, revoke with `remove_delegate` plus DeleteKey. |
| A6 | A delegate record outlives a deleted access key, so re-adding a leaked public key revives its caps. | Operational | The contract cannot see access keys. Runbook: rotate to a new key pair after a leak. |
| A7 | Root-state growth from `set_fee` (a longer treasury id) and `propose_owner` is charged to nobody (≤ ~200 B). | Info | Accepted (Task 10): the contract's own balance covers it; runbook funds a margin. |
| A8 | An open task takes unlimited commits (a cap needs an `invited` list). | Design | D5. Each entry pays its own storage and gets it back at cleanup; cleanup is bounded at 50 per call; views paginate. |
| A9 | Any entrant of an open parent can post children under it. | Design | Spec §6.7. UI labels each child's poster (Task 14 review). |
| A10 | An allowlisted token whose `ft_transfer` returned a non-empty, non-JSON value would make `on_withdraw`'s success path fail: the tokens are paid, but no `withdraw` event is logged. The failure path is unaffected and still restores. | Info | Accepted: only the owner allowlists, and NEP-141 `ft_transfer` returns nothing. |
| A11 | `migrate` decodes the stored state in the current layout before it checks `version`, so after a layout change it fails with near-sdk's uncoded panic, not `E_VERSION`. | Info | Accepted (Task 10): relevant only to the next layout change, whose migration reads the old struct. |
| A12 | `pick` now reads the signer's public key on a direct call. near-sdk 5.29.1 uses near-sdk-core 4.2.3 (Cargo.lock), which decodes ED25519, SECP256K1 and ML-DSA-65, every key type nearcore 2.13 accepts, so no signer key makes `pick` abort. A future key type would abort only that signer's own pick: the poster's fallback and `void_task` after it read no key, so no reward is trapped (I4). | Info | Checked, no change. |

## The docs.near.org checklist

| Item | Where it stands |
|---|---|
| Each public method is meant to be public | Yes. The change methods are the user calls of spec §6; views only read. |
| Callbacks and internal methods private | `on_withdraw`, `new` and `migrate` are `#[private]` (`on_withdraw_is_private`, `init_is_private`, `migrate_is_private_and_keeps_the_state`). Helpers are `pub(crate)` outside `#[near]`. |
| Access policy for init, ownership, admin | `new` private, deployed and initialised in one transaction by the contract account (R10); owner setters need 1 yocto and the owner; two-step ownership (`propose_owner`, `accept_owner`). |
| Predecessor or signer chosen deliberately | Every authorisation uses the predecessor. The signer appears only in the delegate lookup, which requires signer = predecessor = the account (R16 tests in every spending module). |
| 1 yocto on full-access-only methods | `withdraw`, `storage_withdraw`, the owner setters, `accept_owner`, `add_delegate`, `remove_delegate`; `post_task`/`top_up_task` take 1 yocto or a delegate key within caps. The node refuses a deposit from a function-call key (`delegates_are_managed_only_by_a_full_access_key`). |
| Bounds on inputs, ids, amounts, sizes, lengths | URIs ≤ 256 B, tags ≤ 8 × 24, invited ≤ 20, winners ≤ 5, funders ≤ 50, windows `min..=14 days`, rewards within the token's limits and `MAX_REWARD_LIMIT`, page ≤ 50, hashes 64 lowercase hex; unknown arguments refused (R20, R21). |
| Duplicates rejected before payment | Duplicate invited accounts and duplicate winners are refused (`E_INVITE`, `E_WINNERS`). |
| Users cover their storage growth | Every state-growing call measures its growth and charges the account that caused it; settlement uses bytes reserved at posting (R12, R24; `storage_is_charged_in_wasm`, `winner_with_zero_available_storage_is_still_paid`). A new funder pays its record (`new_funder_without_storage_is_refused_and_nothing_changes`). |
| A unique prefix per collection | Eight `StorageKey` prefixes, now pinned (finding 8). |
| Storage freed on deletion | `cleanup` refunds each entrant exactly the bytes freed (`cleanup_twice_is_harmless`); `remove_delegate` refunds its record. Task records and payout slots are kept on purpose (R6). |
| Overflow checks | `overflow-checks = true` in the release profile; checked arithmetic on rewards, credits, top-ups and caps; counters saturate (R18). |
| Invariants true at the end of every receipt | The property harness checks I1, I2, I5, I7, I10 after every operation, and that a rejection changes nothing. |
| Debit before a transfer is scheduled | `withdraw` debits, then schedules `ft_transfer` (`withdraw_more_than_balance_rejected` shows a refusal moves nothing). |
| Liquid balance for storage and refunds | Users prepay storage at the protocol price. The contract's own margin is a runbook item (plan 07). |
| Deposits, fees, rounding, refunds, failed transfers defined | Spec §6.1, §6.4; I7 by property test; `dust_reward_min_1`; failed withdraw restores once (I5). |
| No method spends funds of a pending operation | A withdrawal's amount leaves the vault before the promise, so nothing else can spend it; the callback only credits back. |
| Callback where a result must be checked | `on_withdraw` settles every withdrawal. |
| Callback private, both outcomes handled, gas sized | Private; success emits `withdraw`, failure restores and emits `withdraw_failed`; 35 Tgas minimum proven on the node for both paths (Task 12). |
| Safe if the callback fails; bounded inputs | The callback does one credit and one log. See A10 for a non-standard token. |
| Pending operation settles exactly once | The callback carries account, token, amount and recipient; it runs once (I5). |
| Settle expected failures without panicking | The failure path credits a slot that cannot have been removed (no code deletes a vault slot). |
| Refund attached NEAR on failure | Not applicable: no call attaches user NEAR to another contract. `storage_deposit`'s registration-only excess goes back in a transfer. |
| Restore a withdrawal only on failure | Yes. |
| Credit deposits only after confirmation | Deposits arrive through `ft_on_transfer`, which the token calls after it moved the tokens. |
| Safe if another method runs before the callback | The debited amount is out of the vault; nothing reads it until the callback. |
| Return the promise when callers need the result | `withdraw` returns the promise; its value is `on_withdraw`'s `bool`. |
| `ft_on_transfer` accepts expected tokens only, returns the unused amount | Allowlisted and enabled tokens only, by predecessor; never panics; all or nothing (`forged_token_cannot_credit`, `ft_on_transfer_never_panics_on_random_msg`). |
| `ft_resolve_transfer` | Not applicable: Tender is not a token. |
| No first-come secrets that can be front-run | Commit-reveal binds task and account; a copied commitment cannot be revealed (`reveal_attacks_rejected`). |
| One account is not one person | Per-account limits are the funder cap and `invited`. The cap's squat costs 49 × `min_reward` (finding 1): nothing on testnet, 4.9 USDC on mainnet. Open tasks take only active registered agents, each with a bond once the owner sets one (finding 9). |
| Randomness | None on chain. Entrants choose their own salts. |
| No profit from repeating, aborting, splitting or reordering | One pick per task (I2); the fee is on the pooled total; a re-commit replaces (I10); delegate refunds do not restore budget. |
| Unit tests for auth, bounds, arithmetic, invariants | 253 unit and property tests. |
| Sandbox tests for failed promises, gas, callbacks, refunds, repeats | 46 sandbox tests, including restore with 35 Tgas, 50-funder void, repeated cleanup, refusals. |
| Upgrade and migration access-controlled | `migrate` is private and version-checked; layout pinned (finding 8). |
| Reproducible artefacts, verified code hash | `build.sh` pins cargo-near 0.22.0 and remaps paths; reviewers rebuilt Tasks 13-15 byte for byte; finding 4 binds `res/` to its sources. The deployed hash must be compared with `res/SHA256SUMS` at deploy (runbook). |
| Monitoring, alerts, incident plan | Operations: the indexer accepts events only from successful receipts; alerts and the pause/upgrade contacts belong in the plan 07 runbook. |

## The adversarial suite

All pass on the build at `6b79b40` (`tender.wasm` sha256 `9de8a3d5…`). Fix round 1 changed only doc
comments, but cargo-near embeds the public methods' docs in the wasm's ABI (`__contract_abi`), so
its build differs (`1ab89d07…`, 338,912 B; sums in `contract/res/SHA256SUMS`). The vault, pooled,
delegate, args and admin suites and `pnpm skeleton` were re-run on it and pass.

| Test | What it tries | Result |
|---|---|---|
| `ft_on_transfer_never_panics_on_random_msg` (unit, proptest) | Random and near-valid messages, amounts up to `u128::MAX`, registered and unregistered senders, enabled, disabled and unknown tokens. No panic; all or nothing; credit only from the enabled token to the sender or the one `{"for"}` account, by exactly the amount; a refusal logs nothing. Two mutations of `vault.rs` (array messages accepted; half the amount credited) were each caught. | pass |
| `on_withdraw_is_private` | alice and a stranger call the callback to credit 10^6. | refused, storage unchanged |
| `reveal_before_commit_deadline_rejected` | Reveal while the commit window is open. | `E_PHASE`, then the reveal works at the deadline |
| `pick_by_stranger_rejected` | A stranger, an entrant picking itself, the treasury, and the poster before its window. | `E_AUTH` / `E_PHASE`, storage unchanged; the verifier then picks |
| `dust_reward_min_1` | Reward 1 at 500 bps, two winners at 5000 bps. | fee 0, payouts `[1, 0]`, conserved |
| `huge_max_entries_without_invited_rejected` | `max_entries` `u32::MAX` and 1 with no invited list; then with one, an uninvited entrant. | `E_LIMIT`; `E_INVITE` |
| `implicit_64_hex_account_commits_and_wins` | A 64-hex implicit account registers, commits, reveals, wins and withdraws. | works; `asp` is null |
| `forged_token_cannot_credit` | An unlisted token contract transfers to Tender for alice and for bob; an account calls `ft_on_transfer` itself. | full amount returned, nothing credited, storage unchanged |
| `commit_after_settlement_rejected` | A new entrant and the winner commit to a settled task. | `E_PHASE`, storage unchanged |
| `cleanup_twice_is_harmless` | Cleanup before settling, then three repeats by different callers and limits. | `E_PHASE`; repeats return 0 and write nothing |
| `withdraw_more_than_balance_rejected` | Withdraw balance + 1, `u128::MAX`, from no slot, of an unheld token. | `E_FUNDS`, no token moves |
| `reveal_attacks_rejected` | A copied commitment, a wrong salt, other content, a second reveal, a late reveal, picking the copier. | `E_COMMITMENT`, `E_REVEALED`, `E_PHASE`, `E_WINNERS` |
| `new_funder_without_storage_is_refused_and_nothing_changes` | A new funder with no spare storage tops up. | `E_STORAGE`, storage unchanged on a reverting runtime |
| `verifier_delegate_key_cannot_pick` (delegate.rs) | The judge's delegate key, allowed to call `pick`, picks and empty-picks. | `E_AUTH`, storage unchanged; the judge's plain function-call key and full-access key pick |

## Not covered here

- The TypeScript suites against the new wasm (the controller re-runs them at merge).
- Testnet USDC behaviour (plan 02 Task 10 Step 5b, spike S3) and CI's first run on Linux (both
  owner-gated).
- The independent reviewer's pass (pending; see "How it was reviewed").
