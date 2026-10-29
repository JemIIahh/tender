#!/usr/bin/env bash
# Builds both contracts into res/ and writes res/SHA256SUMS.
#
# Needs cargo-near 0.22.0 (`cargo near --version`). The toolchain comes from rust-toolchain.toml.
# The wasm is built on this machine, not in cargo-near's reproducible docker build, so another
# machine gets different bytes. res/ holds the build that was committed.
#
# Exits non-zero if tender.wasm, after cargo-near's wasm-opt step, is over 450 KiB.
set -euo pipefail

# 450 KiB. Deploying code costs about 1 NEAR per 100 KB, so the size is a budget.
MAX_TENDER_BYTES=$((450 * 1024))

cd "$(dirname "$0")"

# cargo-near builds the crate in the current directory.
(cd tender && cargo near build non-reproducible-wasm)
(cd test-token && cargo near build non-reproducible-wasm)

# cargo-near puts each crate's files in target/near/<crate>/, named after the crate.
built_tender=target/near/tender/tender.wasm
built_token=target/near/test_token/test_token.wasm

tender_bytes=$(($(wc -c <"$built_tender")))
echo "build.sh: tender.wasm is $tender_bytes bytes (limit $MAX_TENDER_BYTES)"
if [ "$tender_bytes" -gt "$MAX_TENDER_BYTES" ]; then
  echo "build.sh: FAILED: tender.wasm is $tender_bytes bytes, over the $MAX_TENDER_BYTES byte ($((MAX_TENDER_BYTES / 1024)) KiB) limit" >&2
  exit 1
fi

mkdir -p res
cp "$built_tender" res/tender.wasm
cp "$built_token" res/test_token.wasm
# cargo-near writes its output readable by the owner only.
chmod 644 res/tender.wasm res/test_token.wasm

# shasum ships with macOS and with Perl on Linux; sha256sum is the coreutils fallback.
if command -v shasum >/dev/null 2>&1; then
  (cd res && shasum -a 256 tender.wasm test_token.wasm >SHA256SUMS)
else
  (cd res && sha256sum tender.wasm test_token.wasm >SHA256SUMS)
fi

echo "build.sh: wrote res/tender.wasm, res/test_token.wasm and res/SHA256SUMS"
cat res/SHA256SUMS
