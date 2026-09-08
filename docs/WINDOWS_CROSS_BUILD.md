# Mac-hosted Windows cross-build record

This records the build tools used for the 0.1.4 educational preview. It is not Windows runtime validation. All downloads and compilations were local to the dedicated workspace. The native Windows build in WINDOWS_BUILD.md is the simpler route for most contributors.

## Verified build tools

| Tool | Version / source | Archive SHA-256 |
|---|---|---|
| LLVM | [20.1.8 macOS ARM64](https://github.com/llvm/llvm-project/releases/tag/llvmorg-20.1.8) | `a9a22f450d35f1f73cd61ab6a17c6f27d8f6051d56197395c1eb397f0c9bbec4` |
| cargo-xwin | [0.23.1 universal macOS wheel](https://pypi.org/project/cargo-xwin/0.23.1/) | `8ef713ecad812fb1df708ee91a9b0067432b99a176fb082a75fe7015e968ae9a` |
| NSIS source | [3.11 source archive](https://sourceforge.net/projects/nsis/files/NSIS%203/3.11/nsis-3.11-src.tar.bz2/download) | `19e72062676ebdc67c11dc032ba80b979cdbffd3886c60b04bb442cdd401ff4b` |
| NSIS Windows stubs/plugins | [3.11 ZIP](https://sourceforge.net/projects/nsis/files/NSIS%203/3.11/nsis-3.11.zip/download) | `c7d27f780ddb6cffb4730138cd1591e841f4b7edb155856901cdf5f214394fa1` |
| qpdf Windows x64 | [12.4.1 MSVC64 ZIP](https://github.com/qpdf/qpdf/releases/tag/v12.4.1) | `3cd016cd433ef7232e42f4c13348a49cc14907a3c7278ef4f99120593126f7a6` |
| Archive inspection | [7-Zip 26.03 macOS](https://github.com/ip7z/7zip/releases/tag/26.03) | `5ca87677072c59f5602e5c49baa27d4694bacd2259b4e507f0094249d4281480` |

Rust 1.98.1 with `x86_64-pc-windows-msvc` and SCons 4.10.1 were used. The cached SDK record identifies Windows SDK 10.0.26100 and MSVC CRT 14.44 / Visual Studio 17.14. Microsoft SDK/CRT license terms apply to these build dependencies; see [cargo-xwin's prerequisites and license notice](https://github.com/rust-cross/cargo-xwin/tree/v0.23.1).

Tauri downloaded its pinned `nsis_tauri_utils` 0.5.3 plugin and validated its hash. Tauri build-tool caches were kept under the project target directory using `bundle.useLocalToolsDir`.

## Local provisioning layout

```text
PDFWorkbench/
  tools/windows-cross/
    bin/cargo-xwin
    llvm/bin/             # clang-cl, lld-link, llvm-rc, llvm-ar, llvm-lib, llvm-readobj
    llvm/lib/             # tool runtime libraries and Clang resource headers
    nsis-3.11/bin/makensis # native Mac compiler
    nsis-3.11/Include/
    nsis-3.11/Stubs/
    nsis-3.11/Plugins/
  caches/xwin/xwin/        # crt/, sdk/, DONE cache record
  caches/target-windows-cross/
```

1. Download the archives above from their linked publishers and verify their hashes. Extract LLVM's required binaries, libraries and resource headers under `tools/windows-cross/llvm`; retain/copy binary aliases when the filesystem cannot create symlinks. Extract the cargo-xwin executable from its wheel under `tools/windows-cross/bin`.
2. Extract the NSIS Windows ZIP. Build the matching native `makensis` using the official [compiler-only POSIX instructions](https://nsis.sourceforge.io/Docs/AppendixG.html), SCons 4.10.1, `VERSION=3.11`, `SKIPSTUBS=all SKIPPLUGINS=all SKIPUTILS=all SKIPMISC=all`, and `NSIS_CONFIG_CONST_DATA_PATH=no`. Place the resulting compiler in `nsis-3.11/bin` so it locates its sibling Include/Stubs/Plugins directories. No global installation is needed.
3. Add the Rust Windows target using the project's Rustup. Set `XWIN_CACHE_DIR` to the project's `caches/xwin`, `XWIN_ARCH=x86_64`, and run `cargo-xwin cache xwin`. For a fresh rebuild, explicitly select the documented SDK/CRT versions with cargo-xwin options instead of assuming its future defaults remain the same. The retained cache record identifies the actual packages used for this build.
4. Stage the verified qpdf executable as `src-tauri/binaries/qpdf-x86_64-pc-windows-msvc.exe`; copy all sibling DLLs to `src-tauri/binaries/windows`. Map each DLL to the installed executable directory in `src-tauri/tauri.windows.generated.json`. The PowerShell build script contains the equivalent staging algorithm. Include `binaries/THIRD-PARTY-NOTICES.zip` in its resource map.
5. Run `./scripts/env.sh python3 scripts/collect-rust-notices.py` and `./scripts/env.sh python3 scripts/archive-notices.py`, then `./scripts/env.sh ./scripts/cross-build-windows.sh`.

The upstream cargo-xwin 0.23.1 runner serializes target Rust flags with spaces and rejects SDK paths that contain spaces. This workspace exposed that failure. `scripts/windows-cargo.py` uses the already verified/cached SDK with `CARGO_ENCODED_RUSTFLAGS` and shell-aware C compiler flags instead. It does not alter the Windows SDK, Rust sources, or LLVM binaries.

The linker reported missing optional Microsoft PDB debug files; release linking and installer generation completed. This says nothing about installed runtime behavior. Archive inspection verifies payload presence and DLL dependencies, while actual installation and UI verification still require Windows.
