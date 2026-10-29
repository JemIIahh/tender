#!/usr/bin/env bash
# Checks that contract/res/ was built from the contract sources as they are now.
#
# build.sh records in res/SOURCES.sha256 one SHA-256 over every tracked file that goes into the
# wasm: contract/tender, contract/test-token, contract/Cargo.toml, contract/Cargo.lock,
# contract/build.sh (its flags shape the bytes) and rust-toolchain.toml. It takes the hash before
# it builds. This script recomputes it from the files in the working tree and fails if it differs,
# so a source change that is committed without a rebuild of res/ fails CI. It also checks
# res/tender.wasm and res/test_token.wasm against res/SHA256SUMS.
#
# The files are the ones `git ls-files` lists, so an untracked file is not an input until it is
# added. The hash is over `<sha256 of the file>  <path>` lines in byte order of the path, so it is
# the same on any host.
#
#   ./check-res.sh          check res/ (exit 1 if it is stale)
#   ./check-res.sh --print  print the sources' hash (build.sh records it with this)
set -euo pipefail

cd "$(dirname "$0")"
contract_dir=$PWD
repo_root=$(git rev-parse --show-toplevel)

# Prints the SHA-256 of standard input, in hex. shasum ships with macOS and with Perl on Linux;
# sha256sum is the coreutils fallback.
sha256() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | cut -d ' ' -f 1
  else
    sha256sum | cut -d ' ' -f 1
  fi
}

# The SHA-256 of the tracked files that go into the wasm, as they are in the working tree.
sources_sha256() {
  (
    cd "$repo_root"
    git ls-files -z -- contract/tender contract/test-token contract/Cargo.toml contract/Cargo.lock \
      contract/build.sh rust-toolchain.toml |
      LC_ALL=C sort -z |
      while IFS= read -r -d '' path; do
        # Deleted from the working tree but not yet from the index: no longer an input.
        [ -f "$path" ] || continue
        printf '%s  %s\n' "$(sha256 <"$path")" "$path"
      done |
      sha256
  )
}

if [ "${1:-}" = "--print" ]; then
  sources_sha256
  exit 0
fi

stale() {
  echo "check-res.sh: FAILED: $1: run ./build.sh and commit res/" >&2
  echo "check-res.sh: $2" >&2
  exit 1
}

recorded=$(cat "$contract_dir/res/SOURCES.sha256" 2>/dev/null || true)
current=$(sources_sha256)
if [ "$current" != "$recorded" ]; then
  stale "contract sources changed since res/ was built" \
    "res/SOURCES.sha256 says ${recorded:-nothing}, but the sources hash to $current"
fi

# The wasm in res/ is the build that SHA256SUMS describes, in the format build.sh writes.
for wasm in tender.wasm test_token.wasm; do
  [ -f "$contract_dir/res/$wasm" ] || stale "res/ is incomplete" "res/$wasm is missing"
done
sums=$(cd "$contract_dir/res" && for wasm in tender.wasm test_token.wasm; do
  printf '%s  %s\n' "$(sha256 <"$wasm")" "$wasm"
done)
if [ "$sums" != "$(cat "$contract_dir/res/SHA256SUMS" 2>/dev/null || true)" ]; then
  stale "res/ is not the build that res/SHA256SUMS describes" \
    "res/tender.wasm or res/test_token.wasm does not match res/SHA256SUMS"
fi

echo "check-res.sh: res/ was built from these sources ($current)"
