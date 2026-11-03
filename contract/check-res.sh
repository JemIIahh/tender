#!/usr/bin/env bash
# Checks that contract/res/ was built from the contract sources as they are now.
#
# The sources' hash is one SHA-256 over every tracked file that goes into the wasm:
# contract/tender, contract/test-token, contract/Cargo.toml, contract/Cargo.lock,
# contract/build.sh (its flags shape the bytes) and rust-toolchain.toml. build.sh takes it before
# it builds, and records in res/SOURCES.sha256 that hash bound to res/SHA256SUMS, the checksums of
# the wasm it built: the SHA-256 of the sources' hash, a newline, and SHA256SUMS. This script
# recomputes the record from the files in the working tree and fails if it differs, and then
# checks res/tender.wasm and res/test_token.wasm against res/SHA256SUMS. So a commit fails CI if
# it changes a source without a rebuild of res/, and also if it carries the new sources and their
# record but not the wasm and the checksums built from them, or the wasm without the sources.
#
# The files are the ones `git ls-files` lists, so an untracked file is not an input until it is
# added. The hash is over `<sha256 of the file>  <path>` lines in byte order of the path, so it is
# the same on any host.
#
#   ./check-res.sh                   check res/ (exit 1 if it is stale)
#   ./check-res.sh --print           print the sources' hash
#   ./check-res.sh --record <hash>   print the record of sources with that hash and the current
#                                    res/SHA256SUMS (build.sh writes res/SOURCES.sha256 with it)
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

# The record of sources whose hash is $1 and of the wasm that res/SHA256SUMS describes.
record_of() {
  {
    printf '%s\n' "$1"
    cat "$contract_dir/res/SHA256SUMS" 2>/dev/null || true
  } | sha256
}

case "${1:-}" in
  --print)
    sources_sha256
    exit 0
    ;;
  --record)
    record_of "${2:?--record needs the sources hash}"
    exit 0
    ;;
esac

stale() {
  echo "check-res.sh: FAILED: $1: run ./build.sh and commit all of res/" >&2
  echo "check-res.sh: $2" >&2
  exit 1
}

recorded=$(cat "$contract_dir/res/SOURCES.sha256" 2>/dev/null || true)
current=$(sources_sha256)
expected=$(record_of "$current")
if [ "$expected" != "$recorded" ]; then
  stale "res/ is not the build of the contract sources as they are" \
    "res/SOURCES.sha256 says ${recorded:-nothing}, but the sources ($current) and res/SHA256SUMS make $expected"
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
