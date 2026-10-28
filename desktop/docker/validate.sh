#!/bin/bash
set -euo pipefail

mkdir -p "$HOME/source" "$CARGO_HOME" "$XDG_CACHE_HOME"
cp -a /source/. "$HOME/source/"
cd "$HOME/source"
ln -s /cache/target desktop/src-tauri/target
ln -s /cache/runtime desktop/.cache
node --version
npm --version
rustc --version
cargo --version
git --version

# Compilation is cached; installers must always belong to this invocation.
rm -rf desktop/src-tauri/target/release/bundle
step() {
  local started=$SECONDS
  printf '\nRUNLIST_STEP %s\n' "$1"
  local label=$1
  shift
  "$@"
  printf 'RUNLIST_SECONDS %s %s\n' "$label" "$((SECONDS-started))"
}
step dependencies npm ci --prefix desktop --no-audit --no-fund
step desktop-tests npm --prefix desktop test
step prepare npm --prefix desktop run prepare:bundle
step native-tests cargo test --locked --manifest-path desktop/src-tauri/Cargo.toml --lib
step package npm --prefix desktop run build -- --ci
step bundle-tests npm --prefix desktop run test:bundle
export RUNLIST_PACKAGE_REPORT=/output/linux-packages.json
step installer-tests npm --prefix desktop run test:linux-packages
mkdir /output/installers
find desktop/src-tauri/target/release/bundle -type f \( -name '*.deb' -o -name '*.AppImage' \) -exec cp '{}' /output/installers/ \;
