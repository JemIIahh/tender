#!/usr/bin/env bash
# Builds both contracts into res/ and writes res/SHA256SUMS and res/SOURCES.sha256.
#
# Needs cargo-near 0.22.0 exactly (`cargo near --version`); any other version fails. The toolchain
# comes from rust-toolchain.toml. The wasm is built on this machine, not in cargo-near's
# reproducible docker build, so another machine gets different bytes. res/ holds the build that
# was committed, and res/SOURCES.sha256 the hash of the sources it was built from bound to
# res/SHA256SUMS, which check-res.sh (run here at the end, and in CI) recomputes from the sources
# and the checksums as they are.
#
# Exits non-zero, and leaves res/ alone, if a built wasm contains $HOME or /Users/, or if
# tender.wasm, after cargo-near's wasm-opt step, is over 450 KiB.
set -euo pipefail

# 450 KiB. Deploying code costs about 1 NEAR per 100 KB, so the size is a budget.
MAX_TENDER_BYTES=$((450 * 1024))
CARGO_NEAR_VERSION="cargo-near-near 0.22.0"

fail() {
  echo "build.sh: FAILED: $1" >&2
  exit 1
}

# Where cargo puts what it builds: CARGO_TARGET_DIR if it is set, made absolute from the directory
# build.sh was started in so that both crates use the same one, or else contract/target.
if [ -n "${CARGO_TARGET_DIR:-}" ]; then
  case $CARGO_TARGET_DIR in
    /*) ;;
    *) CARGO_TARGET_DIR="$PWD/$CARGO_TARGET_DIR" ;;
  esac
  export CARGO_TARGET_DIR
fi

cd "$(dirname "$0")"
target_dir=${CARGO_TARGET_DIR:-$PWD/target}

# Another cargo-near could build different bytes from the same sources.
cargo_near=$(cargo near --version 2>/dev/null || true)
if [ "$cargo_near" != "$CARGO_NEAR_VERSION" ]; then
  fail "needs $CARGO_NEAR_VERSION, but \`cargo near --version\` says: ${cargo_near:-nothing (is cargo-near installed?)}"
fi

# The wasm keeps the source path of every crate it can panic in, and the crates and the standard
# library's sources are under $HOME, so the paths would name whoever built it. The remap turns
# $HOME into /build. RUSTFLAGS is a space-separated list, so a $HOME with a space in it cannot be
# remapped.
case ${HOME:-} in
  "" | / | *[[:space:]]*) fail "cannot remap HOME='${HOME:-}': it must be set, not /, and have no spaces" ;;
esac
# cargo-near ignores RUSTFLAGS from the environment, and replaces its own default (`-C
# link-arg=-s`) with what `--env` passes, so that default is passed again here. It appends
# `--cfg near` itself. Cargo would prefer CARGO_ENCODED_RUSTFLAGS to RUSTFLAGS, so it goes.
unset CARGO_ENCODED_RUSTFLAGS RUSTFLAGS
wasm_rustflags="RUSTFLAGS=-C link-arg=-s --remap-path-prefix=$HOME=/build"

# cargo-near puts each crate's files in <target>/near/<crate>/, named after the crate. A wasm left
# there by an earlier build must never be copied into res/ in place of this one.
built_tender=$target_dir/near/tender/tender.wasm
built_token=$target_dir/near/test_token/test_token.wasm
rm -f "$built_tender" "$built_token"

# The hash of the sources is taken before the build. If a source changes while it runs, the
# check at the end fails.
sources=$(./check-res.sh --print)

# cargo-near builds the crate in the current directory.
(cd tender && cargo near build non-reproducible-wasm --env "$wasm_rustflags")
(cd test-token && cargo near build non-reproducible-wasm --env "$wasm_rustflags")

for wasm in "$built_tender" "$built_token"; do
  [ -f "$wasm" ] || fail "cargo-near did not write $wasm"
  # A path from the build machine in the wasm means the remap did not take.
  for path in "$HOME" /Users/; do
    found=$({ LC_ALL=C grep -a -o -F -- "$path" "$wasm" || true; } | wc -l | tr -d ' ')
    if [ "$found" -gt 0 ]; then
      fail "$wasm contains $path $found times (see \`strings $wasm | grep $path\`); res/ is unchanged"
    fi
  done
done

tender_bytes=$(($(wc -c <"$built_tender")))
echo "build.sh: tender.wasm is $tender_bytes bytes (limit $MAX_TENDER_BYTES)"
if [ "$tender_bytes" -gt "$MAX_TENDER_BYTES" ]; then
  fail "tender.wasm is $tender_bytes bytes, over the $MAX_TENDER_BYTES byte ($((MAX_TENDER_BYTES / 1024)) KiB) limit"
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
# The record binds the sources' hash, taken before the build, to the checksums just written.
./check-res.sh --record "$sources" >res/SOURCES.sha256

echo "build.sh: wrote res/tender.wasm, res/test_token.wasm, res/SHA256SUMS and res/SOURCES.sha256"
cat res/SHA256SUMS
./check-res.sh
