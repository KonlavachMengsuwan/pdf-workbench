#!/bin/sh
set -eu
PDFW_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
# Use a dedicated PDFWorkbench/app layout on an existing local or external disk.
# Resolve the path first; never fabricate a directory for a disconnected volume.
[ "$(basename "$PDFW_ROOT")" = PDFWorkbench ] || { echo 'Place this repository in a dedicated PDFWorkbench/app directory.' >&2; exit 1; }
case "$PDFW_ROOT" in
 /Volumes/*)
  PDFW_VOLUME="$(df -P "$PDFW_ROOT" | tail -1 | sed 's/.*% *//')"
  case "$PDFW_VOLUME" in /Volumes/*) ;; *) echo 'The external workspace volume is not mounted.' >&2; exit 1;; esac ;;
esac
[ "$(uname -m)" = arm64 ] || { echo 'This setup script targets Apple Silicon only.'; exit 1; }
xcrun --find clang >/dev/null || { echo 'Apple command-line tools are required; no administrator install was attempted.'; exit 1; }
mkdir -p "$PDFW_ROOT/tools" "$PDFW_ROOT/caches/npm" "$PDFW_ROOT/tmp" "$PDFW_ROOT/projects" "$PDFW_ROOT/exports" "$PDFW_ROOT/test-data"
touch "$PDFW_ROOT/.pdfworkbench-workspace"
export TMPDIR="$PDFW_ROOT/tmp" CARGO_HOME="$PDFW_ROOT/tools/cargo" RUSTUP_HOME="$PDFW_ROOT/tools/rustup"
if [ ! -x "$PDFW_ROOT/tools/node-v24.13.1-darwin-arm64/bin/node" ]; then
 curl --fail --location https://nodejs.org/dist/v24.13.1/node-v24.13.1-darwin-arm64.tar.gz -o "$TMPDIR/node.tar.gz"
 printf '%s  %s\n' '8c039d59f2fec6195e4281ad5b0d02b9a940897b4df7b849c6fb48be6787bba6' "$TMPDIR/node.tar.gz" | shasum -a 256 -c -
 COPYFILE_DISABLE=1 tar -xzf "$TMPDIR/node.tar.gz" -C "$PDFW_ROOT/tools"
fi
export PATH="$PDFW_ROOT/tools/node-v24.13.1-darwin-arm64/bin:$CARGO_HOME/bin:$PATH"
if [ ! -x "$CARGO_HOME/bin/rustup" ]; then
 curl --fail --location https://static.rust-lang.org/rustup/archive/1.29.1/aarch64-apple-darwin/rustup-init -o "$TMPDIR/rustup-init"
 curl --fail --location https://static.rust-lang.org/rustup/archive/1.29.1/aarch64-apple-darwin/rustup-init.sha256 -o "$TMPDIR/rustup-init.sha256"
 PDFW_EXPECTED="$(cut -d ' ' -f1 "$TMPDIR/rustup-init.sha256")"
 printf '%s  %s\n' "$PDFW_EXPECTED" "$TMPDIR/rustup-init" | shasum -a 256 -c -
 chmod +x "$TMPDIR/rustup-init"
 "$TMPDIR/rustup-init" -y --no-modify-path --profile minimal --default-toolchain 1.98.1
fi
rustup toolchain install 1.98.1 --profile minimal
export npm_config_cache="$PDFW_ROOT/caches/npm" CARGO_TARGET_DIR="$PDFW_ROOT/caches/target" CARGO_BUILD_JOBS=2
cd "$PDFW_ROOT/app"
npm ci --no-audit --no-fund
python3 scripts/build-native-engine.py
python3 scripts/archive-notices.py
printf '\nSetup complete. Run ./scripts/env.sh npm run tauri build -- --bundles app\n'
