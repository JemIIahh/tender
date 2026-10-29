# S2: toolchain, wasm size and gas

Measured on 2026-10-29 on the built wasm in `contract/res`, running on a local nearcore sandbox node.

## Toolchain

| | |
|---|---|
| Rust | 1.96.0, pinned by `rust-toolchain.toml`, target `wasm32-unknown-unknown` |
| cargo-near | 0.22.0, `cargo near build non-reproducible-wasm` (it runs wasm-opt itself) |
| near-sdk, near-contract-standards | 5.29.1 |
| near-workspaces, near-sandbox | 0.23.0, 0.3.16 |
| Sandbox node | nearcore 2.13.4, protocol 86 |
| Build host | macOS on Apple silicon. CI builds on Linux x86_64 and gets different bytes. |

## Wasm size

| file | after cargo build, before wasm-opt | after wasm-opt, in `contract/res` |
|---|---|---|
| `tender.wasm` | 372,811 B | 305,135 B (298 KiB) |
| `test_token.wasm` | 170,247 B | 140,830 B |

`contract/build.sh` fails if `tender.wasm` is over 450 KiB (460,800 B) after wasm-opt, so there are 155,665 B to spare. The checksums are in `contract/res/SHA256SUMS`.

## Gas

`cargo test -p tender_sandbox --test gas -- --nocapture` prints this. It measures the worst cases: 50 entrants who are all registered agents, so a commit also creates an `earned` slot; a pick with 5 winners; a cleanup of 50 entries. Every figure is the gas burnt by the transaction and all its receipts, and the test fails if one that has a limit reaches it.

```
gas report (Tgas burnt by a call and all its receipts)
call                                                             burnt   limit
storage_deposit, first deposit (worst of 47, mean 2.13)           2.15       -
register_agent, first registration (worst of 50, mean 2.24)       2.26       -
ft_transfer_call (deposit)                                        6.62      30
post_task                                                         2.76       -
commit (worst of 50, mean 2.94)                                   2.97      15
reveal (worst of 50, mean 2.68)                                   2.72      15
pick (5 winners)                                                  5.20      50
cleanup (50 entries)                                             30.21     150
void_task                                                         2.45      50
withdraw (the token pays)                                         6.41       -
withdraw (the token refuses, balance restored)                    6.52       -
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
- The sandbox charges 1 NEAR for 1000 Tgas up front and refunds what a call does not use. The gas test attaches 300 Tgas, the mainnet maximum, for the entrants' calls so that their 1 NEAR is enough.
