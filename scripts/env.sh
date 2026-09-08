#!/bin/sh
PDFWORKBENCH_HOME="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
export PDFWORKBENCH_HOME
if [ ! -f "$PDFWORKBENCH_HOME/.pdfworkbench-workspace" ] || [ ! -d "$PDFWORKBENCH_HOME/tmp" ]; then
  echo 'PDF Workbench workspace is unavailable. Run setup-macos.sh in an existing workspace, or reconnect its volume.' >&2
  exit 1
fi
export CARGO_HOME="$PDFWORKBENCH_HOME/tools/cargo"
export RUSTUP_HOME="$PDFWORKBENCH_HOME/tools/rustup"
export CARGO_TARGET_DIR="$PDFWORKBENCH_HOME/caches/target"
export CARGO_BUILD_JOBS=2
export npm_config_cache="$PDFWORKBENCH_HOME/caches/npm"
export TMPDIR="$PDFWORKBENCH_HOME/tmp"
export PATH="$PDFWORKBENCH_HOME/tools/node-v24.13.1-darwin-arm64/bin:$CARGO_HOME/bin:$PATH"
cd "$PDFWORKBENCH_HOME/app" || exit 1
exec "$@"
