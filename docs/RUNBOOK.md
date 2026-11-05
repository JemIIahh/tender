# Runbook

For the person who deploys and runs Tender. It covers a deployment to testnet. Section 1, the contract deploy, was run on testnet on 2026-11-04 and wrote `deployments/testnet.json`; the rest is written from the scripts and the code, and the services and the web app are not hosted yet. Where a step is the owner's to take (anything that spends, posts, publishes or uses a secret), it says so.

Mainnet is not covered. The scripts refuse it, and a mainnet deploy needs decisions that are not made ([LIMITS.md](LIMITS.md)).

## What you run

| Part | Where | Notes |
|---|---|---|
| Contract | NEAR testnet | One account. Its wasm is `contract/res/tender.wasm` |
| Test token | NEAR testnet | Open `mint`. Never deploy it where tokens have value |
| Services (`pnpm serve`) | One container or process per database | API, indexer, keeper, Judge, Telegram bot and notifier |
| Database | Postgres (hosted) or PGlite (one machine) | Holds the index and, only here, the uploaded briefs, criteria, held-out checks and entries |
| Web app | Any host for a Next.js app | Static settings are in `NEXT_PUBLIC_*` variables, built in |

## Before you start

- Node 24.21 or a later 24, or Node 26 and newer (25 is not supported by some test dependencies), and pnpm 10.26.x (`corepack enable` picks the one `package.json` names). `pnpm install --frozen-lockfile`.
- A parent NEAR testnet account with some NEAR, and its full-access key. Deploy creates the team's sub-accounts under it. The parent is the contract's owner.
- For a hosted Postgres: a direct connection, or a pooler in session mode. A transaction-mode pooler (PgBouncer or Supavisor in transaction mode, a Neon `-pooler` host) breaks the indexer's lock. The password must not be short or a common word; `.env.example` has the rules.
- A FastNEAR API key is optional but worth having: without one, the NEAR Data API rate-limits the indexer (HTTP 429) and the index can fall behind.
- `.env.example` lists every variable with its rules. Copy it to `.env` and fill in what you need; `.env*` is git-ignored except the example.

## 1. Deploy the contract

Run only with the owner's yes. `pnpm deploy:testnet` spends testnet NEAR and creates accounts.

```
DEPLOY_PARENT_ACCOUNT=<parent>
DEPLOY_PARENT_PRIVATE_KEY=<ed25519:... full access, in .env, never printed>
pnpm deploy:testnet
```

The script is safe to run again: each step prints `OK <step>` when it did the work and `SKIP <step> (exists)` when the chain already had it, so a run that stopped half way does what is left.

The steps below are in dependency order. The script runs the owner's calls, Tender's calls and each account's own calls side by side (three at a time on testnet), so only the order within each group holds: the owner's storage before `set_token`, and the bond before any agent registers.

1. Create the team's ten sub-accounts (treasury, Judge, keeper, test token, poster, the four reference agents, and the contract's), each with a new full-access key.
2. Deploy the test token and the Tender contract (each with its `new` in the same transaction).
3. Register Tender with the test token and, where the network has it, with Circle's USDC (a storage registration on each token contract, so that it can hold them).
4. **`storage_deposit`** for the owner and every account that will call a state-growing method. The owner's comes first: `set_token` is charged to the owner's storage.
5. **`set_token`** puts the test token, and USDC, on the allowlist, with each one's minimum and maximum reward.
6. **`set_agent_bond_cooldown`**, then **`set_agent_bond`**. The bond is in the test token (1 tUSDC); the cooldown is 14 days on testnet. A run that finds a bond already set leaves the bond and the cooldown alone, because the owner may have changed them.
7. **Register the reference agents.** The four agents (`analyst`, `coder`, `extractor`, `lead`) each register with the test token, are minted the bond, put it in their vault and call `register_agent` with a profile. This has to come after the bond is set, because registering takes the bond. `deploy.ts` does it; you do not.
8. Write `deployments/testnet.json` (the contract, tokens, accounts, wasm hash and the deploy block) and `.env.deploy.testnet` (mode 0600, git-ignored: each account's `<STEM>_ACCOUNT` and `<STEM>_FULL_ACCESS_KEY`, and the contract's `TENDER_CONTRACT` and `TENDER_CONTRACT_FULL_ACCESS_KEY`).

After it finishes, compare the wasm hash in `deployments/testnet.json` with the `tender.wasm` line in `contract/res/SHA256SUMS`. A match shows that the deployed binary is the committed one. It does not show that the committed binary was built from these sources: a rebuild on another machine gives different bytes ([LIMITS.md](LIMITS.md#not-built)).

Then bring the README up to date with the deployment: the contract badge and link, the key links, the "Deployed on NEAR testnet" table (every account, the wasm sha256, the deploy date and height, from `deployments/testnet.json`), and the "On testnet today" steps under Try it, each with real output from the deployed network and nothing else. What waits on hosting (the site, the API address, the seed tasks) says "Not live yet: it arrives once the services are hosted" there until it is up, and the address goes in its place when it is.

Back up `.env.deploy.testnet`. It holds the only copy of every full-access key the script made, including the one that can redeploy the contract ([LIMITS.md](LIMITS.md#the-upgrade-key)). Do not copy it to a host that runs a service.

## 2. Keys

Principle: a service holds a function-call key limited to the Tender contract and to the methods it needs. It never holds a full-access key. A function-call key cannot call `withdraw`, `register_agent` or any method that needs 1 yoctoNEAR, so a leaked service key cannot move tokens out of any vault.

| Role | Account env | Key env | Methods | Who adds it |
|---|---|---|---|---|
| Keeper | `KEEPER_ACCOUNT` | `KEEPER_PRIVATE_KEY` | `void_task`, `cleanup` | `scripts/keeper-key.ts` |
| Judge | `JUDGE_ACCOUNT` | `JUDGE_PRIVATE_KEY` | `pick`, `pick_attested` (the contract has no `pick_attested` yet; see [LIMITS.md](LIMITS.md#tee-limits)) | `scripts/keeper-key.ts --role judge` |
| Reference agent | `AGENT_<NAME>_ACCOUNT` | `AGENT_<NAME>_PRIVATE_KEY` | `commit`, `reveal` | `scripts/keeper-key.ts --role agent --agent <name>` |
| Swarm lead (spends from its vault) | the lead's account | the lead's delegate key | `post_task`, `top_up_task`, `commit`, `reveal` | By hand; see below |

Add the service keys (the owner's call; each is a transaction on testnet):

```
pnpm exec tsx scripts/keeper-key.ts --network testnet --role keeper
pnpm exec tsx scripts/keeper-key.ts --network testnet --role judge
pnpm exec tsx scripts/keeper-key.ts --network testnet --role agent --agent analyst
```

It signs with the account's full-access key from `.env.deploy.testnet`, adds the new function-call key, and appends the private half to the same file as `<ROLE>_PRIVATE_KEY`. It prints `OK add ...` or `SKIP add ... (exists)` and never prints a key. Move only the `*_PRIVATE_KEY` lines of the roles a host runs into that host's environment.

### Rules for a key that can spend

The swarm lead hires specialists from its own vault. It signs with a delegate key, and that key is the one that can spend, so it gets the strict form:

- **A finite allowance.** The access key carries an allowance for gas, 1 NEAR in the demo (`scripts/swarm-demo.ts`). A key with no allowance can spend all the account's NEAR on fees.
- **Exactly `post_task`, `top_up_task`, `commit` and `reveal`.** Never an empty method list (a function-call key with no list may call any method) and never `pick`, `withdraw`, `add_delegate` or `remove_delegate`.
- **Contract caps as well.** Register the key with `add_delegate(public_key, token, per_task_cap, total_cap)`. The key cannot spend more than the per-task cap in one call or more than the total in all, whatever the allowance. The demo uses 2 tUSDC and 6 tUSDC.
- **Little liquid NEAR on the account.** Whatever the allowance, a leaked key can burn gas up to the account's balance. Keep only what the account needs to pay for storage and gas, and top it up when needed.
- **Revoke both halves.** To revoke a delegate key, call `remove_delegate(public_key)` and delete the access key from the account (`DeleteKey`). Doing only one leaves the other. Removing the delegate registration stops the key from spending the vault; deleting the access key stops it from signing at all.

`pnpm agent:delegate --name <n> --per-task <amount> --total <amount>` does the first three together (it makes the key, adds it with exactly those four methods and a finite allowance, 0.25 NEAR unless `--allowance` says another, and calls `add_delegate`), and `pnpm agent:undelegate --name <n>` does the revoking, both halves ([MCP.md](MCP.md#keys)). `scripts/swarm-demo.ts` does the same in code, for the demo.

### The swarm lead's journal

The lead keeps a journal directory so that it never pays for a part twice. One lead works from a journal at a time: while it runs it holds `lead.lock` there (its pid and start time), and a second lead on the same journal refuses to start and names that pid. A lock whose process no longer runs is taken over, and the log says so. The journal directory's file system must support hard links, because the lock is linked into place: on one that does not (FAT, some network and FUSE mounts), the lead fails at its start with "the journal directory's file system must support hard links". Pids are judged on the host the lead runs on, so give each host its own journal directory.

### The service keys have no allowance cap

`scripts/keeper-key.ts` adds keeper, Judge and agent keys without an allowance cap. That is deliberate: a key whose allowance runs out stops its service in the middle of its work. It differs from the rule above, and the difference matters less because those keys cannot move tokens. What a leaked one can do is send its permitted calls and burn the NEAR the account holds. The Judge's can pick winners on tasks that name the Judge ([LIMITS.md](LIMITS.md#the-judges-key)). So: keep little liquid NEAR on those accounts, and watch their balances.

### Revoking a service key

1. Delete the function-call access key from the account, with the account's full-access key.
2. Remove `<ROLE>_PRIVATE_KEY` from the host's environment and from `.env.deploy.<network>`.
3. Run `keeper-key.ts` again to make a new one. Never delete the account's full-access key: an account without one is locked for good.

## 3. Run the services

```
pnpm serve
```

or build and run the image (`docker build .`; the `Dockerfile` runs `pnpm serve` as a non-root user and exposes 8787). The image has not been built yet. Both read the same environment.

Minimum for a testnet deployment:

| Variable | Value |
|---|---|
| `TENDER_NETWORK` | `testnet` |
| `TENDER_CONTRACT` | the contract account (an account id, not a key) |
| `NEAR_RPC_URL` | a testnet RPC URL |
| `FASTNEAR_API_KEY` | optional, secret |
| `DATABASE_URL` | the Postgres URL (or `pglite:<dir>` on one machine) |
| `PUBLIC_API_URL` | the exact `https` URL clients call. Sign-in and the blob URIs that go on chain are bound to it, so changing it later breaks both |
| `PUBLIC_WEB_URL` | the web app's URL: used for links in Telegram messages and as the CORS origin |
| `KEEPER_ACCOUNT`, `KEEPER_PRIVATE_KEY` | the keeper starts only when its key is set |
| `JUDGE_ACCOUNT`, `JUDGE_PRIVATE_KEY` | the Judge starts only when its key is set |
| `TEAM_ACCOUNTS` | the accounts that are ours, labelled so in the API and UI |
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | the Judge's model; see section 4 |

Rules:

- **One services process per database.** On Postgres, a second process serves the API, and indexes, runs the keeper and the Judge only once the first stops. Two Judges would send duplicate picks: the contract refuses the second, but each costs a transaction and a scorecard upload.
- **One database per contract deploy.** The services refuse to start on a database whose cursor belongs to another network or contract, and exit with code 1. Make a new database for a new deploy and keep the old one.
- The index trails the chain by a few blocks. It reads finalized blocks from the NEAR Data API.
- **Back up the database.** The chain stores only hashes and URIs. The uploaded briefs, criteria, held-out checks, revealed entries, sign-ins and Telegram links are in the database and nowhere else. The index can be rebuilt from the chain; the uploads cannot.
- Do not set the `DEBUG` variable where the services run: the `debug` package writes to stderr past the redaction that keeps secrets out of the logs.
- `pnpm serve` reads `.env` and `.env.deploy.<network>` from the repository root, and the indexer reads `deployments/<network>.json` from there. Set `TENDER_ENV_DIR` in the process's environment to read all three from another directory instead (`<dir>/.env`, `<dir>/.env.deploy.<network>`, `<dir>/deployments/`). A variable set in `.env` does not do this. Unset, nothing changes. `pnpm seed`, `pnpm deploy:testnet`, `pnpm skeleton`, `scripts/keeper-key.ts` and the run-agent command read the same variable. Rules for the directory: give an absolute path (a leading `~` is not expanded, and a relative path is taken from the working directory); it must already exist, or the command stops and names the variable; and `pnpm deploy:testnet` and `scripts/keeper-key.ts` also **write** to it (the full-access keys into `<dir>/.env.deploy.<network>`, the record into `<dir>/deployments/`), so name a directory that only you can write to, never `/tmp` or any other shared directory. The agent key store `.tender/agents` (`pnpm agent:init`) stays under the repository, wherever the variable points: the agent commands take only their target (`.env` and the record) from it.

### Behind a proxy: TRUSTED_PROXY_HOPS

`TRUSTED_PROXY_HOPS` (0 to 10, default 0) is the number of proxies in front of the API that each add the address they saw to `X-Forwarded-For`.

- Behind a proxy with the default of 0, every viewer counts as one client (the proxy). The whole site then shares the four event streams, the sign-in limits and the `/mcp` limit.
- Set it to the true number of proxies **only when the API's port can be reached through those proxies alone.** If clients can reach the API directly, a client can send its own `X-Forwarded-For` and choose the address it is counted under, which defeats every per-client limit. Too high a value does the same.

## 4. The Judge needs its model before any rubric task

Start the Judge with `LLM_BASE_URL`, `LLM_API_KEY` and `LLM_MODEL` all set **before** you post any `rubric` seed. They are used only all three together; if some are set and not all, `pnpm serve` logs a `WARN serve:` line and the Judge runs without a model. A rubric task the Judge cannot score is refused at intake, which tells the poster early, but a task that was posted before the model was set up has reward in escrow until a verifier acts or the fallback and void windows run out. Check the Judge's log for the WARN, and post a rubric task only after it is gone.

The default `.env.example` points at NEAR AI Cloud (an OpenAI-compatible API). `LLM_API_KEY` is a secret. The Judge sends the model each entry as data under a heading and parses a fixed reply shape; an entry that tries to talk to the judge is disqualified alone. Its scoring quality on the 30 seeds has not been validated with a real model.

## 5. Seed the market

Run only with the owner's yes: it posts real tasks and spends the poster's tokens.

The 30 real seeds' held-out checks, solutions and weak answers are not in the repository. They are in a private directory, one folder per seed. The owner keeps it outside every repository. Point the scripts at it:

```
export TENDER_SEEDS_PRIVATE_DIR=<private dir>
pnpm seed --network testnet
```

- `pnpm seed` reads each seed's `heldout.json` from the private directory. A seed whose file is missing, or has no `salt`, stops the run before anything is posted. Back the directory up, then run `pnpm exec tsx scripts/salt-heldout.ts <private dir>`: it gives a new salt to each file that has none, and to each whose checks changed since its salt was drawn (a salt it draws ends in a fingerprint of its checks, so it can tell; a salt it did not draw is replaced too). It leaves a file alone whose salt was drawn for the checks it holds.
- Held-out checks and their salt are single-use. Both are published in the scorecard when the task is judged. The script skips a seed whose checks are already public or already used by a task of the same poster, so running it again posts nothing twice. A seed rewritten after it was judged needs new checks and a new salt: run `salt-heldout.ts` after changing the checks. `pnpm seed` stops, before anything is paid, on a seed whose salt a scorecard of the poster has published, and says so.
- Back the private directory up somewhere that is not the repository and not the services host. The Docker build leaves out `seeds-private/`, but a directory elsewhere is never copied in.
- If the variable is not set, the script looks for `seeds-private/` in the repository, which git ignores. Never put the directory inside `seeds/`, which is tracked. `scripts/check-public.test.ts` and `seeds/no-answers-in-tree.test.ts` fail if an answer-like value or a secret turns up in a tracked file.
- The thirty seeds, their rewards and the poster are the team's. They are labelled as ours.

`pnpm demo:local`, the CI demo job and the end-to-end tests do not need the private directory: they post the demo-only tasks in `scripts/demo-seeds/`, which are public in full. Never post those to a public network.

## 6. Telegram

The bot and the notifier start only when `TELEGRAM_BOT_TOKEN` is set, and they need `PUBLIC_WEB_URL` for the links in their messages. Also set `TELEGRAM_BOT_USERNAME` (the name in `t.me/<username>`).

- **Polling** (`TELEGRAM_MODE=polling`, the default) is for development. It allows one services process per bot.
- **Webhook** is the mode for a hosted deployment. Set:
  - `TELEGRAM_MODE=webhook`
  - `TELEGRAM_WEBHOOK_SECRET`: 16 to 256 letters, digits, underscores and hyphens. Required in this mode.
  - The services listen at `POST /telegram/webhook` (not under `/v1`) and accept only requests that carry the secret in the `X-Telegram-Bot-Api-Secret-Token` header.
  - Telling Telegram where to send updates is the owner's step: call the Bot API `setWebhook` with the public URL `<PUBLIC_API_URL>/telegram/webhook` and the same `secret_token`. The services do not do it.
- The bot token is a secret. Revoke it with BotFather if it leaks, and set the new one.
- The bot has not been run against Telegram yet. The first live check is to link a chat from the web app and watch for a `new task` alert.

## 7. Web app

`apps/web` is built with the `NEXT_PUBLIC_*` variables below. Every one is sent to the browser, so none may hold a secret.

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_NETWORK` | `testnet` |
| `NEXT_PUBLIC_API_URL` | the same URL as `PUBLIC_API_URL` |
| `NEXT_PUBLIC_CONTRACT` | the contract account |
| `NEXT_PUBLIC_RPC_URL` | optional; a key in it is public, so use one issued for browsers |
| `NEXT_PUBLIC_JUDGE_ACCOUNT` | the Judge's account, so the post wizard can offer it |

Leave `NEXT_PUBLIC_DEV_WALLET*` unset. It works on the sandbox only.

### Deploy order: the API first, then the client

`GET /v1/health` gained a required field, `waiting_for_chain`. A web build that expects it, against an API that does not send it yet, fails to read the health response. So when this change, or a similar one to a response shape, goes out: deploy the services, wait for `/v1/health` to answer with the new field, then deploy the web app. A rollback goes the other way round, web first.

## 8. Watching it

`GET /v1/health` is the one endpoint to monitor.

| Response | Meaning |
|---|---|
| 200, `ok: true`, `waiting_for_chain: false`, small `lag_blocks` | Healthy |
| 200, `ok: true`, `waiting_for_chain: true` | The services are waiting for the chain before they index: the RPC node does not answer, or is behind the database. The API still serves, and `lag_blocks` can read 0 for a node that is behind, so `lag_blocks` alone would miss this |
| 503, `ok: false`, `error: "chain_unavailable"` | The API cannot read the chain's final height |
| No response | The process is down |
| 429, `error: "rate_limited"` | The monitor asks more than 300 times a minute from one address (`rateLimits.health`). The chain's height in a 200 is at most 2 seconds old: one read of the node serves every request in that time |

Alert on:

1. **`waiting_for_chain: true` for more than a few minutes.** The indexer, the keeper and the Judge do nothing meanwhile: tasks are not voided, picks are not made, the index goes stale. The log line, once per wait, reads `WARN indexer: cannot check the database against the chain yet (<reason>); trying again in <n> s`. A reason that names a node behind the database is about once a minute. Check `NEAR_RPC_URL`, and whether the node is syncing or rate-limiting.
2. **`lag_blocks` growing.** With no FastNEAR key, the NEAR Data API answers 429 and the index falls behind. The services print a WARN at start when the key is empty.
3. **A non-200 from `/v1/health`, or no answer.**
4. **Exit code 1.** The services end with 1 when the database is another deploy's. Do not just restart: it needs a new database.
5. **Other `WARN` lines.** `WARN indexer: cannot take the indexer lock` or `lost the indexer lock` mean another process holds the lock or the connection dropped (a transaction-mode pooler does this).
6. **The balances** of the keeper, Judge and agent accounts. When one runs out of NEAR, the service stops signing.

A task whose verifier does nothing is refunded after the fallback deadline. Anyone can call `void_task`, and the keeper does so every 30 seconds. If tasks sit past their deadline and are not voided, look at the keeper: its key, its balance and `waiting_for_chain`.

## 9. Incidents

- **A service key leaked.** Delete that function-call key from its account (section 2). The Judge's: also review the picks it made since the leak, and consider calling `set_paused(true)` as the owner to stop new tasks while you do.
- **The full-access key of the contract account leaked.** Treat the contract as compromised: the key can redeploy it. Pause new tasks as the owner. There is no automatic recovery. This is the trust point in [LIMITS.md](LIMITS.md#the-upgrade-key).
- **The owner key leaked.** An owner can allowlist tokens, set the fee (10% at most) and the bond, and pause new tasks. It cannot touch withdrawals, picks or refunds. Move ownership with `propose_owner` and `accept_owner`.
- **A held-out check leaked before a task was judged.** That task cannot be fairly judged. Let it void, and do not repost the seed with the same checks; write a new one.
- **The database was lost.** Rebuild the index from the chain by starting the services on an empty database. The uploaded content (briefs, criteria, held-out checks, entries) is gone with it, and tasks whose briefs were stored there cannot be read.

## 10. Running the gate

Before anything is merged or deployed, run the same four checks CI runs, in this order, from the repository root with Node 24.21 on the path:

```
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
```

and for the contract:

```
cd contract && ./check-res.sh && cargo test --workspace
```

Notes:

- Set `NEAR_SANDBOX_BIN_PATH` to a verified nearcore 2.13.4 sandbox binary to avoid a download.
- Set `TENDER_SEEDS_PRIVATE_DIR` to the private seed directory so that every seed test runs. Without it those tests skip (about 300), with one note.
- The tests do not read the `.env`, `.env.deploy.<network>` and `deployments/<network>.json` of the checkout, so a deployed testnet on the machine changes no result. A test that starts `pnpm serve` or the run-agent command as a process sets `TENDER_ENV_DIR` to an empty directory of its own; the others pass the directory they want to the function they call. A new test that starts one of these as a process must do the same.
- `pnpm test` runs about 4,200 tests in about 7 minutes and can fail with timeouts on a busy machine. Re-run a failing file by itself before deciding it is broken: `pnpm exec vitest run --project <name> <file>`.
- The `@tender/db` tests always run on PGlite, and also on a Postgres server when `TEST_DATABASE_URL` is set. CI sets it on every push, to a Postgres 17 service, so the Postgres paths run there. To run them on your machine, set it to a Postgres 17 database.
- `pnpm demo:local` runs the whole loop on a local chain in about 80 seconds once the local node is downloaded, and prints `DEMO OK`. The first run of an install also downloads the node (about 30 MB; it prints a line before it starts), which takes a few minutes on a slow link; `NEAR_SANDBOX_BIN_PATH` skips that. `pnpm demo:local --keep` then keeps the chain and the services up until Ctrl-C, for the MCP server. The swarm demo is `pnpm exec tsx scripts/swarm-demo.ts`, four to five minutes.
- The same checks guard what is public: `pnpm exec vitest run --project scripts scripts/check-public.test.ts` fails if a tracked or not-yet-tracked file is an `.env*` file other than the example, is under `.submission/` or `seeds-private/`, or holds the owner's email address, a NEAR `ed25519:` private key, a PEM private key, a Telegram bot token, an `sk-`, GitHub, AWS, Slack or Google key, a JWT, or a `NAME=value` line (at the start of a line, with or without `export`) for a capitalised name that is, or ends in, `API_KEY`, `APIKEY`, `SECRET`, `TOKEN`, `PASSWORD`, `JWT` or `PRIVATE_KEY`, with a value of 16 or more characters that is no placeholder. It finds nothing of any other shape (a short password, a lower-case name, a key in a TypeScript object), and it is not in the pre-commit hook, so run it before you commit.
