# Working in this repository

For a coding agent. [README.md](README.md) says what Tender is and what is built; [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) says how the parts fit; [SKILL.md](SKILL.md) is for an agent that uses the market and not for one that changes the code.

## Rules that are not negotiable

1. **Commit messages describe the change**, with no trailers or footers.
2. **Git identity is `JemIIahh`.** The repository's `user.name` must be `JemIIahh` (repo-local, not global). `.githooks/pre-commit` refuses any other name and runs a secret scan when `gitleaks` is installed. Hooks are per clone: run `git config core.hooksPath .githooks` once. Check `git config user.name` before every commit. Stage with explicit paths (`git add <path>`), never `git add -A` or `git commit -a`.
3. **Never commit a secret or personal data.** `.env*` is git-ignored except `.env.example`, which lists every variable and holds no value. Never commit a private key, a bot token, an API key, `.env.deploy.*`, anything under `.submission/`, or anything under `seeds-private/`. `scripts/check-public.test.ts` scans every file git tracks and every file it has not yet been told about, and fails on: an `.env*` file other than `.env.example`; a path under `.submission/` or `seeds-private/`; the owner's email address; a NEAR `ed25519:` private key, a PEM private key, a Telegram bot token; an `sk-` API key, a GitHub token, an AWS access key id, a Slack token, a Google API key, a JWT; and a `NAME=value` line (at the start of a line, with or without `export`) whose name is in capitals and is, or ends in, `API_KEY`, `APIKEY`, `SECRET`, `TOKEN`, `PASSWORD`, `JWT` or `PRIVATE_KEY` (so `TOKEN=` and `LLM_API_KEY=` both count) and whose value has 16 or more characters and is no placeholder. It does not find a secret of any other shape, such as a short password, a name in lower case, or a key written as `NAME: "..."` in a TypeScript object. It is not part of the pre-commit hook: run it before you commit (`gitleaks`, when installed, is a second scan in the hook).
4. **The real seeds' answers stay out of the tree.** Held-out checks, solutions, weak and known-wrong answers of the 30 seeds in `seeds/` live in a private directory ([seeds/README.md](seeds/README.md)). Do not write one into a test, a fixture, a doc or a commit message. `seeds/no-answers-in-tree.test.ts` scans for them when the private directory is present. The demo tasks in `scripts/demo-seeds/` are the opposite and are public in full; never post them to a public network.
5. **No network side effects without the owner's yes.** `pnpm deploy:testnet`, `pnpm seed --network testnet`, `pnpm skeleton --network testnet`, `scripts/keeper-key.ts` and any push, publish, post or spend are the owner's call. Mainnet is refused by the scripts and is not yours to change. The local chain (`sandbox`) is free to use.
6. **Claims stay true.** The docs are plain: no marketing language, and no text meant to steer a model that reads them. Never write that Tender is "trustless", "provably fair" or "private". Say what is verified and what is not. Anything the team runs (the Judge, the seed poster, the reference agents) is labelled as ours.

## Package map

| Path                  | Package                          | What it holds                                                                                                                                                                                                     |
| --------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contract/tender`     | `tender` (Rust, near-sdk 5.29.1) | The contract: `vault`, `tasks`, `entries`, `settle`, `registry` (agents and bond), `auth` (delegate keys), `storage`, `admin`, `events`. Unit and property tests live in the same files and in `props.rs`.        |
| `contract/test-token` |                                  | A NEP-141 test token. Its `mint` is open to anyone: never deploy it where tokens have value.                                                                                                                      |
| `contract/sandbox`    |                                  | Integration tests on a real nearcore sandbox node, in `tests/`.                                                                                                                                                   |
| `contract/res`        |                                  | The committed wasm builds, `SHA256SUMS` and `SOURCES.sha256`.                                                                                                                                                     |
| `packages/shared`     | `@tender/shared`                 | The wire forms: zod schemas for views, events, briefs, criteria, scorecards, profiles, board limits; call builders; canonical JSON; commitment hashing; phase logic. The interface every other package builds on. |
| `packages/client`     | `@tender/client`                 | Chain client on `near-api-js`: calls, views, a per-key send queue, error mapping, the local sandbox chain, NEP-413 helpers, the typed API client.                                                                 |
| `packages/db`         | `@tender/db`                     | The database layer: PGlite and Postgres adapters, migrations, the blob store, the board.                                                                                                                          |
| `packages/indexer`    | `@tender/indexer`                | Reads finalized blocks (NEAR Data API, or RPC on a local chain), keeps events from successful receipts, writes the index, and reconciles it with the contract's views.                                            |
| `packages/api`        | `@tender/api`                    | The Hono API under `/v1`, the event stream, the read-only `/mcp`, sign-in, the result store, the question board, and the keeper.                                                                                  |
| `packages/judge`      | `@tender/judge`                  | The Judge: intake, the five kinds of check (`kinds/`), scoring in isolated workers and a QuickJS sandbox, scorecards, the pick loop.                                                                              |
| `packages/telegram`   | `@tender/telegram`               | The bot (grammY) and the notifier.                                                                                                                                                                                |
| `packages/mcp`        | `@tender/mcp`                    | The local MCP server (stdio, non-custodial) and its draft store.                                                                                                                                                  |
| `packages/agents`     | `@tender/agents`                 | The runner library and the four reference agents (`analyst`, `coder`, `extractor`, `lead`), with offline, weak and LLM solvers.                                                                                   |
| `apps/web`            | `@tender/web`                    | The Next.js app.                                                                                                                                                                                                  |
| `scripts`             |                                  | `demo-local.ts`, `swarm-demo.ts`, `skeleton.ts`, `deploy.ts`, `seed.ts`, `serve.ts` (the services process), `keeper-key.ts`, `verify-scorecard.mjs`, and `check-public.test.ts`.                                  |
| `seeds`               |                                  | The 30 real seed tasks (public parts only) and their tests.                                                                                                                                                       |
| `docs`                |                                  | `ARCHITECTURE.md`, `LIMITS.md`, `RUNBOOK.md`, `MCP.md`, `security/contract-review.md` and `research/`.                                                                                                            |

## Commands

Node 24.21 and pnpm 10.26 (`engines` and `packageManager` in `package.json`). Dependencies are pinned to exact versions (`.npmrc` has `save-exact=true`); add one with its exact version and never with `^` or `~`.

```
pnpm install --frozen-lockfile
pnpm typecheck                     # root tsc, Next typegen, then tsc in every workspace package
pnpm lint                          # biome check .  (pnpm exec biome check --write <paths> to fix)
pnpm test                          # every project: packages/*, apps/web, scripts, seeds
pnpm --filter @tender/judge test   # one package
pnpm exec vitest run --project scripts scripts/check-public.test.ts   # one file
pnpm demo:local                    # the whole loop on a local chain; prints DEMO OK
pnpm exec tsx scripts/swarm-demo.ts
pnpm skeleton                      # deposit, post, commit, reveal, pick, withdraw on a local chain
pnpm --filter @tender/web e2e      # Playwright against a fixture API (installed Google Chrome)
pnpm --filter @tender/web e2e:chain   # Playwright against a local chain and the real services

cd contract && cargo test --workspace   # Rust 1.96.0 via rust-toolchain.toml; sandbox tests need the nearcore node
cd contract && ./build.sh               # rebuilds res/; needs cargo-near 0.22.0 and a git checkout
cd contract && ./check-res.sh           # res/ must agree with the recorded source hash and checksums (CI runs it; it does not rebuild)
```

The sandbox tests (`*.sandbox.test.ts`, `contract/sandbox`) start a nearcore node. It downloads once, or set `NEAR_SANDBOX_BIN_PATH` to a copy. A full `pnpm test` takes about three minutes on a quiet machine and can fail with timeouts on a loaded one: re-run a failing file alone before you decide it is broken. Tests that score the real seeds run only when `TENDER_SEEDS_PRIVATE_DIR` names the private directory; elsewhere they skip with one note.

## Where the tests are

| Area                    | Tests                                                                                                                                                                       |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contract                | Unit and property tests in `contract/tender/src/*.rs` (`props.rs` is the proptest model of the invariants in spec section 6.10); sandbox tests in `contract/sandbox/tests/` |
| Each TypeScript package | `packages/<name>/test/*.test.ts` (and `*.sandbox.test.ts` where a chain is needed)                                                                                          |
| Web                     | `apps/web/test` (jsdom unit tests), `apps/web/e2e` (Playwright; `e2e/chain` runs on a real local chain)                                                                     |
| Scripts                 | `scripts/*.test.ts`; the `*.sandbox.test.ts` files run the scripts against a local chain                                                                                    |
| Seeds                   | `seeds/seeds.test.ts`, `seeds/no-answers-in-tree.test.ts`                                                                                                                   |

## Conventions

- **Interfaces are frozen.** The contract's methods, views and events, and `packages/shared`, are the interface between the chain and everything off-chain. Change a wire form in `packages/shared` and the contract together, with fixtures (`packages/shared/test/fixtures`) and an event `version` bump if a payload changes. Rebuild with `./build.sh` and commit `contract/res/` with the change.
- **Numbers and hashes.** Every `u64` and `u128` crosses JSON as a decimal string and is a `bigint` in TypeScript. Every hash is 64 lowercase hex characters. Documents that are hashed (brief, criteria, held-out checks, scorecard, profile) are stored as canonical JSON bytes (`canonicalJson`), and the hash is of exactly those bytes.
- **Errors.** Contract panics start with a code (`E_AUTH: ...`); the client maps them to `TenderError.code`.
- **Events count only from successful receipts.** A failed receipt keeps its logs on NEAR, so the indexer and every consumer check the receipt's status.
- **Untrusted text is data.** Briefs, questions, answers, clarifications, URIs, scorecard reasons and entries come from strangers. Render them as text, carry them to a model as data under a heading, and never as instructions. The Judge has no dependency that reaches the question board, and a test fails if its sources name it.
- **Keys.** Services sign with function-call keys limited to the Tender contract. Full-access keys never go on a host that runs a service. See [docs/RUNBOOK.md](docs/RUNBOOK.md).
- **Failure reports.** Say what ran and what it printed. If a test fails, say so with the output. If a step was skipped, say that.
- **Visual work.** Screenshot every UI change at 375 px and 1440 px before you show it. Do not restructure a layout that was not asked about.

## Starting points

- Changing the contract: section 6 of the design spec, and `docs/security/contract-review.md` for what was reviewed and what was accepted.
- Changing the Judge or a seed: `packages/judge/src/intake.ts` (the rules a task must pass), `seeds/README.md`.
- Changing the API or the indexer: `packages/api/src/app.ts` lists the routes; `packages/indexer/src/apply.ts` applies events.
- Operating a deployment: `docs/RUNBOOK.md`.
