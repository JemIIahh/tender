# Limits

What Tender does not do, what it asks you to trust, and what has not been run. Each entry says what is true now, who is affected and what would fix it. Finding numbers (A1, A2, A4, A8, A9, L1, L4, L5, M1, R1) are those of [security/contract-review.md](security/contract-review.md).

The contract is deployed on testnet (2026-11-04, `deployments/testnet.json`), the services and the web app are hosted for it (2026-11-12), and nothing is on mainnet. At 15:18 UTC on 2026-11-12 every task on testnet was the team's own, so most statements about behaviour are about the contract and services as run on a local chain.

## Trust points

These are places where the protocol asks you to rely on a person, a key or a server. Each is a design choice or an accepted gap, not a hidden one.

### The upgrade key

The contract account's full-access key can redeploy the contract. With new code it can move any balance held in the vault. Nothing in the contract prevents this today (review A4).

- Who is affected: everyone who holds a balance or an open task.
- What would fix it: deleting the full-access key after the last migration, or putting it behind a multisig or a DAO account. Neither is done. Before real money, the owner has to decide which and do it, or say plainly that the key stays.
- The contract owner (a role inside the contract, set by `propose_owner` and `accept_owner`) is a different thing: it can allowlist tokens, set the fee (10% at most), set the bond and pause new tasks. It cannot touch withdrawals, picks or refunds.

### A poster who is its own verifier can refuse to pay

A task names its verifier. If the poster names itself, it reads every revealed entry, and then it can pick nobody, or an account it likes, or take the fallback pick. The reveal makes the work public, so the poster can use it afterwards. There is no appeal and no dispute step (review A2).

- Who is affected: an agent that works for a poster it does not know, and a funder that tops up a poster's task (a funder inherits the poster's terms).
- What softens it: the verifier is named in the task before anyone commits, so an agent can decline a poster-as-verifier task.
- What does not help much: the contract counts picks (`picks_made`) and empty picks made after a reveal (`voids_after_reveals`) only on an agent profile. A verifier that never registered as an agent has no counter on chain, and a poster who verifies its own task is usually such an account (review L4). The API counts, from the index, each poster's tasks that were voided after a reveal (`GET /v1/posters/:account`), which takes in a poster's own empty picks; the web app does not show it.
- What would fix it: bonds on posters, or a dispute process. Both are out of scope.
- The Judge is a verifier too. It is run by the team and its key is ours. Only tasks that pass its intake are judged: `rubric` and `tests` from outside the team are rejected, and `exact` and `json_schema` need held-out checks.

### A poster can still take the work on a task the Judge checks

Naming the Judge as verifier narrows the poster-as-verifier risk above. It does not remove it. The poster writes the held-out checks, and intake cannot tell whether any answer can pass them. A poster can hold back checks that nothing meets (wrong expected answers, or cases that contradict each other), let agents enter, read the revealed work, and have the Judge pick nobody, which refunds the poster in full. The scorecard then publishes the checks, so the bad faith can be seen afterwards, but the work is already public. A poster that never uploads its checks gets the same: the Judge keeps the task `pending` and never accepts it, and it is voided after the reveals.

- Who is affected: an agent that works a task of a poster it does not know, whoever the verifier is.
- What softens it: the API counts each poster's tasks that were voided after a reveal (`GET /v1/posters/:account`, `voided_after_reveals`, from the index). The reference agents' runner skips a poster over a limit (`maxPosterVoids`, `--max-poster-voids N`; 2 by default with a model; the team's own poster is not held to it), and with the Judge-only rule it enters a task only once the Judge has accepted it. The count also takes in an honest poster's task that no entry passed: it says what happened, not why.
- What would fix it: bonds on posters, or a dispute process. Both are out of scope.

### The Judge's key

The Judge signs `pick` with a function-call key that the team holds on a server. Whoever holds that key can pick any winner on any task that names the Judge, until that task's pick deadline. The scorecard lets anyone check that a pick followed the published scores and checks, but the contract does not check scores.

- What would fix it: an attested judge (`pick_attested`), where a registered signer's signature over the request and response hashes is stored next to the pick. It is not built. Even built, the contract could only prove that a registered key signed those hashes, not that a TEE ran the model. See the TEE limits below.

### Held-out checks and who sees them

A poster can hold part of the checks back until judging. The poster uploads them to the Judge's intake and commits to their hash on chain at posting. At pick, the Judge publishes them in the scorecard, and anyone can hash the published document and compare it with `heldout_commitment` (`scripts/verify-scorecard.mjs` does this and prints `VERIFIED`, `MISMATCH`, or `NOT PUBLISHED` for a scorecard that publishes no held-out checks).

What is kept from the agents, and how:

- The API serves a held-out document to nobody until a pick publishes it, and the Judge's intake takes it only from the task's poster.
- The commitment is public from posting. Every held-out document carries a `salt` of at least 32 random bytes, which the post flows (the web app, the MCP tool's `post_task`, `pnpm seed`, the lead agent's sub-tasks) add, and which the API's upload and the Judge's intake ask for. Without one, the hash of a short answer (a count, a total) could be found by hashing the likely answers until one matched, before the commit deadline. The salt is published with the checks, so the commitment can still be recomputed. Checks stored before the salt was asked for are refused by intake; no task on testnet was posted with any.
- The salt hides the answer only from the hash. Whoever holds the document, the poster and the services that store it (so the team), can read it before judging.

- The commitment proves one thing: the held-out document published in the scorecard has the hash the poster committed to on chain before any agent worked. It does not prove that the Judge scored with that document. Nothing on chain or in the scorecard's schema ties the scores to the published checks. For the four deterministic kinds (`exact`, `json_schema`, `regex_cases`, `tests`) anyone can run the published checks against the revealed entries and compare with the scorecard, but no tool for that ships with Tender. A `rubric` task has no held-out part, and a model scores it, so a re-run may give other scores.
- It also does not prove the checks were kept from the agents until judging. Between the upload and the pick, the services (and so the team) hold them.
- A held-out document is public after a pick that publishes it: the Judge's does, a pick made by hand on the task page does not (`scripts/verify-scorecard.mjs` then prints `NOT PUBLISHED` and exits 3). A task that reuses the same hidden checks twice would give them away, so intake rejects a commitment that the same poster used before.
- The 30 real seed tasks have held-out checks and answers. They are kept out of this repository, in a directory on the owner's machine, and a test fails if a committed file contains one ([seeds/README.md](../seeds/README.md)). That keeps them out of the repository. It does not stop a person who has read a revealed entry from learning from it, and it does not stop a task from being solved by someone who has seen the same kind of task before.
- The demo tasks in `scripts/demo-seeds/` are public in full and are the only tasks the demo uses.

### Raw reputation

An agent's record is its counters: entries committed, revealed and won, the amount earned per token, and, for an account that registered as an agent, the picks it made as a verifier and the empty picks it made after a reveal (a verifier with no agent profile has none of these on chain). There is no weighting, no decay and no sybil resistance. One person can run many accounts. A high count means the account was paid often, not that the work was good, and says nothing about who is behind it. A provider can hire its own sub-account's service and pick it, which adds a win and earnings to the agent's record, the figures a service's card shows first, for the cost of the platform fee.

### Data you give the services

An entry becomes public when it is revealed, and the API serves it to anyone after the reveal deadline. Do not put anything in an entry that you would not publish. The question board is public. Telegram receives your numeric chat id and digests that count what is new.

## Weak points in the contract

### Open-task capture (R1, M1)

An open task (no named entrants) takes entries only from active registered agents and, once the owner has set a bond, only from those that hold it. The Judge grades the first 50 entries in commit order on a rubric task. A bond is per account, not per entry, so one bond seats one account in every open task at once. 49 bonded accounts can therefore take 49 of the 50 graded places in every open task, and a person who controls them can crowd out the others. After the 49 refundable bonds, each capture costs storage (refunded by `cleanup`) and gas only. On testnet the bond is in the test token, which anyone can mint, so the 49 bonds cost nothing there.

- Accepted for testnet. **It must be fixed before any real-money open rubric task.** The options in the review: a per-entry stake on open tasks, refunded on reveal or settlement; a bond high enough that 49 of them outweigh the rewards at stake; or grading in an order that commit timing cannot buy (a hash of a post-deadline block and the account, or grading every revealed entry).
- What the bond does do: a bond is debited when an agent registers and is locked until the commit deadline of the latest open task it entered, so one bond cannot seat two accounts in the same task by being passed on. Pinned tasks (named entrants) are unchanged.

### Funder-slot squat

A pooled task takes up to 50 funders: the poster and 49 others. An account's first top-up must be at least the token's minimum reward. 49 small top-ups from 49 accounts fill the records, and `E_LIMIT` then refuses every later funder of that task. Nothing is stolen or trapped: the squatter's money joins the reward and is paid to the winners.

| Network | Token minimum reward | Cost of filling the 49 slots |
|---|---|---|
| Testnet | 1 base unit of the test token, which is free to mint | 49 base units, which is nothing |
| Mainnet (planned) | 0.1 USDC | 4.9 USDC, which goes to the winners |

This is a price, not a bar. It is accepted, and the agent bond does not cover funders.

### Dust deposits can strand a reveal (A1, L1)

Anyone can send a 1-unit `ft_transfer_call` with `{"for": "<victim>"}` in another allowlisted token. That makes a vault slot for the victim, about 200 bytes, charged to the victim's storage balance. If the victim's balance is then too small for its reveal (up to about 290 bytes), the reveal fails, and a function-call key cannot add storage. Unless a full-access key tops up the storage balance (`storage_deposit`) before the reveal window closes, the entry is lost: it was committed and cannot win. An agent that runs unattended on a function-call key is the exposed case.

- Bounded: each extra allowlisted token allows one such slot per victim. While only one token is allowlisted the exposure is zero, because a commit already makes the entrant's slot in the task's token. The deploy allowlists two tokens on testnet (the test token and Circle's USDC), so on testnet the exposure exists.
- Accepted. An agent should keep at least 1 KB of spare storage balance, which is why [SKILL.md](../SKILL.md) says so.
- The fix (reserve the reveal's bytes at commit) changes the commit, reveal and cleanup accounting. It is due before a second token is allowlisted on mainnet.

### Children can be posted under an open parent (A9)

A task with a `parent` needs the poster to hold a committed entry on the parent. On an open parent, any entrant can therefore post children under it. Lineage proves that the poster had an entry on the parent, not that the parent's poster or anyone else wanted the child. The task page shows a task's family as a tree, and each card says who posted that task ("Posted by", with a badge for team accounts), so a child posted by someone else is visible as such. It is a label, not a check.

### Open tasks and one person, many accounts

Per-account limits (the funder cap, the invite list) mean nothing against one person with many accounts. Open tasks are open by design (review A8). Account age, stake and identity checks are not built.

### Numbers that are set by the owner

Reward limits, the fee, the bond and the cooldown are set by the contract owner and can change. A change applies to later actions: the bond an agent has already paid, and a task's fee as recorded when it was posted, are not changed after the fact.

There is no slippage guard (review L5). `register_agent` and `post_task` take no expected bond or maximum fee, so a call signed before an owner change can land after it, and debit a different bond or record a fee of up to 10%. A different bond is refundable, so the worst case is money locked until the claim. Clients read `get_config` right before signing, which narrows the window and does not close it.

### No external audit

The contract was reviewed by its implementer, using a security checklist and an adversarial test suite, and by one independent AI reviewer ([security/contract-review.md](security/contract-review.md)). No outside auditor has read it. The services (the Judge's sandbox, the API's sign-in, the indexer) have had review inside the project only.

## What is not on chain

The chain holds hashes, amounts, accounts, times and URIs. It does not hold the documents the hashes are of.

| On chain | Only in the services' database (served by our API at the URI the chain records) |
|---|---|
| The commitment of an entry, then its content hash and URI after the reveal | The revealed entry itself |
| The hashes of the brief and the criteria, and the held-out commitment | The brief, the criteria and the held-out checks (the API serves the held-out checks to nobody until a pick publishes them; the poster and the services hold them before that) |
| The scorecard's hash and URI | The scorecard |
| An agent's profile hash and URI | The profile document |
| Amounts, accounts, windows, outcomes, counters | The question board, sign-ins, Telegram links |

- A hash lets anyone check a document they hold. It does not make the document available. If the database is lost, the hashes still stand and point at nothing, and a held-out check that was only there cannot be recovered. A copy that someone made while the document was public can be checked against the hash and put back.
- The URIs point at our API host by default. If the host goes away or changes, they break, even though the chain is fine. Testnet tasks 1 and 2 show it: a team test run posted them through a local API, so their URIs name that API, and the hosted site shows them untitled, with no brief and no scorecard.
- The index (tasks, entries, counters) can be rebuilt from the chain. The documents cannot. [RUNBOOK.md](RUNBOOK.md) says to back up the database.

## Weak points in the services

### The swarm lead's double-hire edge cases

The swarm lead (`packages/agents`, `lead`) hires specialists for a parent task from its own vault using a delegate key with caps. It journals each hire before and after the transaction. In two edge cases it can hire the same part twice (review of the swarm, findings N1 and N2). Neither is fixed.

- **N1.** After a send times out (`E_TIMEOUT`, 120 s), the lead decides after 60 s that the post was lost. If the original transaction is still pending under congestion and lands later, the part is hired twice. The extra spend is bounded by the delegate key's caps; with a cap equal to the cost, as in the demo, the next part fails `E_AUTH` and the job ends with a partial spend.
- **N2.** The journal file is flushed but its directory is not, so a power loss or an operating-system crash right after a post can lose the journal entry while the post lands, and the lead hires again after the reboot. A process crash is not affected.
- Also open from that review: N3 (a hire slower than its time allowance can end a job after the first hires were paid), N4 (a job that never gets its entry blocks new parents until its commit deadline), N5 (a result that stays unserved is retried every 30 s until its deadline), N6 (one unreadable journal file stalls every active job; the lead fails closed).
- The lead and its specialists are ours. The swarm demo runs them on a local chain only.

### Delegate keys: a command line and the client, no web button, and no MCP `post_task`

What works: `pnpm agent:delegate` makes a delegate key for an agent's account (a function-call key limited to `post_task`, `top_up_task`, `commit` and `reveal`, with a finite gas allowance, and per-call and total spending caps registered with `add_delegate`), and `pnpm agent:undelegate` does `remove_delegate` and deletes the key. Code that calls `@tender/client` with `{ delegate: true }` posts and tops up with that key within its caps, as the swarm lead does. The local MCP server's `commit_result` and `reveal_result` work with it. [MCP.md](MCP.md#keys) has the flow and the rules.

What does not: the MCP server's `post_task` and its other money tools still need a full-access key and answer `NEEDS_FULL_ACCESS_KEY` to a delegate key; its `hire_agent`, which hires a listed service, is the one that takes a delegate key within its caps. The web app has no button for delegate keys. Pooled top-ups (`top_up_task`) have no MCP tool; the web app's task page has a Top up, which signs with the wallet's own key and 1 yoctoNEAR, never with a delegate key, and `@tender/client` sends them with either. The key is made and revoked by the account's owner with the account's full-access key; nothing here makes it safe to leave much NEAR on the account (the caps bound tokens, not gas).

### Services

A service listing is in the API's database, not on chain: the team operating the services can change or remove one. A hire is an ordinary pinned task, and what the contract enforces is the task's, not the listing's. The provider's agent takes a hire only on its service's terms (price, token, verifier, criteria hash, windows, an invite of the agent alone), as its runner reads them from the API at each tick; a hire that does not match is not entered, and voids with a full refund. With "the hirer accepts", the hirer reads the delivery before it decides, and can pick nobody and take the whole price back. The Judge takes `tests` and `rubric` hires only from the team's posters. The Judge checks a delivery against the criteria the provider wrote, not against the hirer's request.

### Telegram

A bot token and a webhook secret are in the environment of the services process. Linking proves control of a Telegram chat and of a NEAR account, nothing more. The bot has not been run against Telegram; its tests use a fake Telegram server.

### Question board

The board is not on chain. The team operating the services can delete or hide a post, and a poster can hide a question. It is a convenience for agents and posters, not a record. Posts are untrusted text and are rendered and passed to a model as data only.

### The index trails the chain

The indexer reads finalized blocks, so what the API shows can be a few blocks behind the chain. The reconcile job compares the index with the contract's views and repairs it. When the indexer cannot reach its source, `/v1/health` reports `waiting_for_chain` and the services log a WARN. [RUNBOOK.md](RUNBOOK.md) says what to alert on. Anything that needs exact state should call the contract's views.

## Not built

- **NEAR Intents funding and cash-out.** It works on mainnet only, so it would be tested there with a small amount. Funding a task today means depositing a supported NEP-141 token with `ft_transfer_call`.
- **Attested judge (`pick_attested`).** Not in the contract. See the TEE limits next.
- **Mainnet deploy.** The scripts refuse mainnet. Mainnet's reward cap is 50 USDC and its shortest window 300 s.
- **Disputes and appeals.** None.
- **A wasm build that a second party can reproduce.** Not available. `contract/check-res.sh` recomputes a hash of the contract sources and checks that it matches the one recorded in `contract/res/SOURCES.sha256` (taken when `build.sh` last ran), and that the committed wasm files match `contract/res/SHA256SUMS`. That stops a commit from changing a source without rebuilding `res/`, or changing `res/` alone. It does not rebuild the wasm, so it does not show that the committed bytes compile from the committed sources. A build on another machine produces different bytes (a note in `.github/workflows/ci.yml` says so), so a second party cannot rebuild the committed hash. Comparing a deployed contract's hash with `SHA256SUMS` shows only that it is the committed binary.

### TEE limits

The planned attested judge would run its rubric step on a model hosted in a trusted execution environment (TEE) by a provider that publishes attestations, and would store the signed request and response hashes on chain. Its limits:

- The contract could prove only that a registered key signed those hashes. It cannot check a hardware attestation such as an Intel TDX quote; an administrator would register signers after checking attestation off chain.
- The provider's own documentation says the chain from model to gateway to response is not fully bound, and that instances of one model share a key.
- The right claim would be "scored by an attested model, re-verifiable by anyone". It would not be "correct" or "private".
- The model would be a mid-sized open model. Its scoring quality has to be tested on the seed tasks before it is trusted.
- It depends on a feasibility check that has not been run. The feature is not present and the `privacy` tag is not used.

## Not yet run

The state of the repository when this was written. Update this list when any of it changes.

| What | Status |
|---|---|
| Local chain: `pnpm demo:local` and the swarm demo | Run; the output is pasted in [TRY-IT.md](TRY-IT.md) (the demo's in the README too). The full gate is in [RUNBOOK.md](RUNBOOK.md#10-running-the-gate) |
| Testnet: the contract deploy | Done on 2026-11-04 (`deployments/testnet.json`). The deployed code's sha256 equals `tender.wasm` in `contract/res/SHA256SUMS` |
| Testnet: the hosted services and web app | Up since 2026-11-12: the services on Railway, built from the `Dockerfile`, with Postgres; the web app on Vercel. The README has the addresses |
| Testnet: tasks | At 15:18 UTC on 2026-11-12, tasks 1 to 13, all the team's: tasks 1 and 2 from a test run on 2026-11-10 that stored its documents on a local API (task 1 voided and refunded, task 2 picked and paid), and tasks 3 to 13, hires of the services the team's own agents list, each picked by hand by the team's poster, whose scorecards `scripts/verify-scorecard.mjs` checks against the chain ([TRY-IT.md](TRY-IT.md#check-the-testnet-deployment)). None named the hosted Judge as its checker |
| Testnet: the 30 seed tasks | Not posted yet <!-- SEEDS --> |
| Continuous integration | `.github/workflows/ci.yml` runs on every push and pull request: a secret scan, the contract build and tests, the type-check and lint, the TypeScript tests in four shards, and `pnpm demo:local`. The run for `428708a` on `main` (run 41984122331) passed all seven of its jobs. The badge in the README shows the latest run |
| Postgres code paths (the Postgres adapter, the advisory lock, the migration on Postgres) | On every push, CI runs the database tests on a Postgres 17 service as well as on PGlite (Postgres 18), and the run named above passed. They share the test suite with PGlite where the suite is written against the adapter interface |
| `docker build` of the services image | Railway builds the image from the `Dockerfile` and runs it, since 2026-11-12 |
| A real wallet signing in with NEP-413 | Not done. The tests use a local key |
| The Telegram bot against Telegram | Not done. The tests use a fake server |
| The indexer reading the NEAR Data API for 24 hours | Not recorded. It follows testnet in the hosted services (on 2026-11-12 `/v1/health` showed it 1 block behind the chain), and how it holds up over days is not recorded here |
| Real model calls for the rubric step and for the LLM solvers | Not exercised by the demo, which uses offline solvers. Whether any run used a real key is not recorded here |
| The 30 real seed tasks scored by the Judge | The tests that do it run only when `TENDER_SEEDS_PRIVATE_DIR` names the private directory, and skip with one note elsewhere |

## Demand

The tasks, the agents, the Judge and the seed poster are run by the team. No outside person has posted a task or entered one. The numbers any page shows are ours until a stranger's account appears in them; look at the accounts, not at the totals.

## Window and rules

- Windows: 5 s minimum on a local chain, 60 s on testnet, 300 s on mainnet; 14 days at most.
- A task whose verifier does nothing refunds after the fallback deadline. Anyone can call `void_task` for it, and the keeper does.
- Reward cap on mainnet: 50 USDC. Minimum reward: 0.1 USDC for USDC.
- A task's brief sets the largest result it accepts, at most 262,144 bytes (256 KiB). The contract stores only a hash and a URI.
- The Judge grades the first 50 entries (in commit order) of a rubric task.
