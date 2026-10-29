# S2: toolchain, wasm size and gas

Measured on 2026-10-29 on the built wasm in `contract/res`, running on a local nearcore sandbox node.

## Toolchain

| | |
|---|---|
| Rust | 1.96.0, pinned by `rust-toolchain.toml`, target `wasm32-unknown-unknown` |
| cargo-near | 0.22.0, `cargo near build non-reproducible-wasm --env 'RUSTFLAGS=-C link-arg=-s --remap-path-prefix=$HOME=/build'` (it runs wasm-opt itself, and appends `--cfg near`). `build.sh` fails on any other cargo-near version. |
| near-sdk, near-contract-standards | 5.29.1 |
| near-workspaces, near-sandbox | 0.23.0, 0.3.16 |
| Sandbox node | nearcore 2.13.4, protocol 86 |
| Build host | macOS on Apple silicon. CI builds on Linux x86_64 and gets different bytes. |

## Wasm size

| file | after cargo build, before wasm-opt | after wasm-opt, in `contract/res` |
|---|---|---|
| `tender.wasm` | 375,346 B | 307,240 B (300 KiB) |
| `test_token.wasm` | 170,151 B | 140,734 B |

`contract/build.sh` fails if `tender.wasm` is over 450 KiB (460,800 B) after wasm-opt, so there are 153,560 B to spare. The checksums are in `contract/res/SHA256SUMS`, and the hash of the sources the build came from is in `contract/res/SOURCES.sha256` (see `contract/check-res.sh`).

The wasm keeps the source path of every crate it can panic in. `build.sh` remaps `$HOME` to `/build` in them and fails if a built wasm still contains `$HOME` or `/Users/`. Before the remap, `tender.wasm` held 32 such paths under the builder's home directory and `test_token.wasm` 25. These are the sizes before and after the final-review fixes of 2026-10-29:

| file | before (no remap) | the same sources, remapped | with the fixes (above) |
|---|---|---|---|
| `tender.wasm` | 372,811 B, 305,135 B | 372,683 B, 305,007 B | 375,346 B, 307,240 B |
| `test_token.wasm` | 170,247 B, 140,830 B | 170,151 B, 140,734 B | 170,151 B, 140,734 B |

Each cell gives the size before wasm-opt, then after it. The fixes add the `storage_balance_bounds` view and `registration_only` in `storage_deposit`, refuse a withdrawal to the contract itself, cap `max_reward`, name the field in each `E_HASH` message, and let an account charge 0 bytes whatever its balance. The test token's sources did not change.

## Gas

`cargo test -p tender_sandbox --test gas -- --nocapture` prints this. It measures the worst cases: 50 entrants who are all registered agents, so a commit also creates an `earned` slot; a pick with 5 winners; a cleanup of 50 entries. Every figure is the gas burnt by the transaction and all its receipts, and the test fails if one that has a limit reaches it.

```
gas report (Tgas burnt by a call and all its receipts)
call                                                             burnt   limit
storage_deposit, first deposit (worst of 47, mean 2.14)           2.15       -
register_agent, first registration (worst of 50, mean 2.24)       2.26       -
ft_transfer_call (deposit)                                        6.62      30
post_task                                                         2.76       -
commit (worst of 50, mean 2.94)                                   2.99      15
reveal (worst of 50, mean 2.68)                                   2.73      15
pick (5 winners)                                                  5.20      50
cleanup (50 entries)                                             30.21     150
void_task                                                         2.45      50
withdraw (the token pays)                                         6.41       -
withdraw (the token refuses, balance restored)                    6.53       -
storage_deposit (top-up)                                          2.03       -
storage_withdraw                                                  2.64       -
set_token                                                         2.21       -
set_fee                                                           2.08       -
set_min_window                                                    1.75       -
set_paused                                                        1.75       -
propose_owner                                                     1.76       -
accept_owner                                                      1.74       -
```

- Every limit is met with a wide margin. The closest are the deposit, `cleanup` and `commit`, which use about a fifth of theirs.
- `withdraw` also works with exactly 35 Tgas attached, on both paths: when the token pays, and when it refuses and the balance comes back (`vault.rs`).
- `cleanup` is the call that scales with its argument: 30.2 Tgas for 50 entries, about 0.6 Tgas each.
- The sandbox charges 1 NEAR for 1000 Tgas up front and refunds what a call does not use. The gas test attaches 300 Tgas to the entrants' calls so that their 1 NEAR is enough. That is not the most a transaction may carry: nearcore's protocol 83 raised `max_total_prepaid_gas` to 1 PGas.
