# Escrow assistance between agents

The Tender team's optional Import Planner workflow hires two Data Check services, checks their
answers and combines them into an import-readiness report. The decision is programmed: an
`import-readiness` request needs `csv-audit` and `duplicate-records`. It does not use a model,
infer arbitrary capabilities from prose, or discover an unapproved provider.

## Run locally

```sh
pnpm demo:escrow-assistance
```

The demo starts its own local NEAR chain, API and indexer. It registers two team agents, publishes
two services, posts an invoice-import task and equips the planner with three separate
function-call keys. It hires the specialists through escrow, restarts the coordinator, validates
their revealed results, accepts both hires, combines their answers and commits/reveals the parent
answer. The team's parent verifier checks the known fixture facts before accepting it.

The demo checks the delegate's recorded spend and that the contract refuses a further purchase,
then checks actual vault balances and withdraws the parent's payout with the local setup account.
The worker keys cannot withdraw. It uses no public RPC, testnet transaction, model call or credit.
The invoice fixture is synthetic and is never posted to a public network.

For a 1.00-token parent reward and two 0.10-token hires, the planner receives 0.95 after the
parent's 0.05 fee, and has spent 0.20 from its own vault. Its net is 0.75. The specialist receives
0.19 after the hires' combined 0.01 fee. Total Tender fees are 0.06. NEAR gas is separate.
Subcontracting costs are at risk even when the planner does not win its parent task.

## Discovery, hiring and acceptance

`createEscrowAssistedSolver` takes an owner-configured capability-to-service allowlist. For each
missing capability it reads the approved listings, filters availability, identities, token,
verification, price and format, and selects the least expensive compatible offer. Equal prices
use the lowest service ID. Listing descriptions remain data, not planning instructions.

Before any upload or hire, it checks finalized parent fields against the supplied context and
document hashes, allows only configured posters and verifiers, and requires enough parent time,
vault funds and delegate capacity for the entire plan. The parent's expected payout after its
fee must cover all hires plus the configured minimum margin. This is a margin **if it wins**.
Its original task reward remains escrowed; it must fund hires from its own existing vault.

The regular runner first commits a placeholder. The coordinator posts one pinned child task for
each selected service, linked to that parent. It returns between polls instead of waiting inside
`solve`, so the runner can continue revealing other entries. Run coordinator and runner ticks
serially when they share drafts, as the optional worker host does.

Only after a child has revealed does the coordinator read its on-chain entry, verify the result's
hash and size, parse JSON and run an owner-supplied validator. It uploads a scorecard and uses a
separate acceptance key to pick that specialist. It composes only results whose payment outcome
is confirmed on chain, then replaces the parent's draft and commitment. The regular runner
reveals the final answer. The parent still has its own verifier and acceptance decision.

The included validator recomputes the narrow deterministic audit and duplicate check. It tests
payment orchestration and composition; it does not demonstrate unique expertise or an LLM
recognizing its own limitations. New capabilities need their own request builders, meaningful
validators and composition logic. Correct JSON shape alone is not adequate acceptance.

## Keys and persistent recovery

All three keys belong to the planner account, have finite gas allowances and name only the Tender
contract:

| Key | Methods | Permission in Tender |
| --- | --- | --- |
| Work | `commit`, `reveal` | Enter tasks and deliver answers |
| Spending | `post_task` | Registered delegate: approved token, per-task and lifetime spend caps |
| Acceptance | `pick` | Not a delegate; can accept tasks this account verifies |

No full-access key is accepted or placed on the worker host. An owner performs account funding,
storage deposits, key installation and delegate registration separately. A spending key cannot
raise its caps, withdraw funds or accept a delivery. A compromised acceptance key could pick
other tasks this account verifies; its method scope is not a per-child restriction enforced by
the contract. Keep that account dedicated to the approved workload.

The journal is private, synced before a signed purchase is broadcast, checksummed and bound to
the network, contract, account, keys and policy. One coordinator works on one parent at a time.
An unknown/pending signed transaction is never resubmitted as a new hire. Restart recovery reads
the finalized transaction outcome. A failed signed hire stops the job rather than retrying a
spend. Picking is also reconciled against the child's on-chain outcome before another attempt.
The lock is for one host and persistent directory, not coordination across multiple hosts.

A revoked key, unavailable API or unresolved transaction can pause progress until the parent's
deadline. Failed validation, changed terms or an expired deadline abandons the parent. Already
posted hires and their escrow remain on chain: inspect them and use the ordinary permitted
settlement/void process. The coordinator does not refund a hire automatically or erase its
journal. A damaged journal or changed policy is refused; retain it for reconciliation before
starting with another directory. Deleting state is not a safe way to reset purchasing.

## Optional hosted mode

Assistance is disabled by default. The isolated utility worker was explicitly deployed and
configured for the team's [public testnet verification](UTILITY-LIVE-TEST.md). Its one-plan cap
was consumed and service 3 paused after success. No automatic migration or funding occurs.

Set these on the isolated utility-worker service only after the owner's approved setup:

| Variable | Meaning |
| --- | --- |
| `UTILITY_ASSISTANCE_MODE` | `escrow`; empty disables assistance |
| `UTILITY_ASSISTANCE_POSTERS` | Explicit comma-separated parent poster accounts |
| `UTILITY_ASSISTANCE_VERIFIERS` | Explicit comma-separated parent verifier accounts |
| `UTILITY_ASSISTANCE_MIN_PROFIT` | Positive minimum margin in atomic test-token units |
| `IMPORT_PLANNER_SPENDING_PRIVATE_KEY` | Scoped `post_task` key registered as a capped delegate |
| `IMPORT_PLANNER_ACCEPTANCE_PRIVATE_KEY` | Separate scoped `pick` key, not a delegate |

Existing work-key settings are unchanged. The host approves only Data Check services 1 and 2,
offered by the existing team provider, at no more than 100000 atomic tUSDC each. Other Import
Planner operations retain their direct solver. Health reports the configured assistance mode
and becomes degraded when coordinator polling fails. No x402 facilitator credential is needed:
these are escrow hires. Public per-call x402 remains a separate path.

The original Import Readiness terms (0.20 tUSDC, 120-second commit) were insufficient for the two
0.10 tUSDC hires and their 120/60/600-second windows. The coordinator refuses those tasks.
The bounded public pilot used a 0.30 tUSDC parent reward, a 1200-second parent commit window,
a 0.01 tUSDC minimum margin, and a delegate capped at 0.10 per hire and 0.20 lifetime total.
At the current 5% fee this leaves 0.085 tUSDC if the planner wins, before NEAR gas. The total cap
allows one complete two-service plan and does not reset on restart. Parent tasks and service
listings must reflect the longer window and price before enabling purchases.

Public results, recovery interventions, gas-allowance checks and the paused listing are documented in [Public testnet verification](UTILITY-LIVE-TEST.md).
