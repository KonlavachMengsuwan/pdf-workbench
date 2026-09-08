#!/bin/sh
# Advanced, locally provisioned cross-build. Windows execution is still required.
set -eu
PDFW_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
export PATH="$PDFW_ROOT/tools/windows-cross/bin:$PDFW_ROOT/tools/windows-cross/llvm/bin:$PDFW_ROOT/tools/windows-cross/nsis-3.11/bin:$PATH"
export CARGO_TARGET_DIR="$PDFW_ROOT/caches/target-windows-cross"
export XWIN_CACHE_DIR="$PDFW_ROOT/caches/xwin"
export XWIN_ARCH=x86_64
export XDG_CACHE_HOME="$PDFW_ROOT/caches/windows-cross"
export CARGO_BUILD_JOBS=2
cd "$PDFW_ROOT/app"
if [ "${1:-}" = "--bundle-only" ]; then
  exec npm run tauri bundle -- --target x86_64-pc-windows-msvc --config src-tauri/tauri.windows.conf.json --config src-tauri/tauri.windows.generated.json --no-sign
fi
exec npm run tauri build -- --runner "$PDFW_ROOT/app/scripts/windows-cargo.py" --target x86_64-pc-windows-msvc --config src-tauri/tauri.windows.conf.json --config src-tauri/tauri.windows.generated.json --no-sign
