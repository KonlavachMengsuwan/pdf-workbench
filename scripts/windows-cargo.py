#!/usr/bin/env python3
"""Mac-hosted Cargo runner for the locally cached Windows SDK and LLVM.

cargo-xwin 0.23.1 downloads the SDK, but its space-delimited Rust flags reject
workspace paths with spaces. This runner uses Cargo's encoded argument format.
It is specific to the app's x64 target; it does not claim Windows runtime testing.
"""
from pathlib import Path
import os
import sys

root = Path(__file__).resolve().parents[2]
sdk = root / 'caches/xwin/xwin'
llvm = root / 'tools/windows-cross/llvm/bin'
if not (sdk / 'DONE').is_file():
    raise SystemExit('Prepare the pinned xwin SDK cache before cross-compiling.')
env = dict(os.environ)
target = 'x86_64_pc_windows_msvc'
env['CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER'] = str(llvm / 'lld-link')
flags = ['-Clinker-flavor=lld-link'] + [f'-Lnative={sdk / p}' for p in
         ('crt/lib/x86_64', 'sdk/lib/um/x86_64', 'sdk/lib/ucrt/x86_64')]
env.pop('RUSTFLAGS', None)
env['CARGO_ENCODED_RUSTFLAGS'] = '\x1f'.join(flags)
for key in ('TARGET_CC', 'TARGET_CXX', f'CC_{target}', f'CXX_{target}'):
    env[key] = 'clang-cl'
for key in ('TARGET_AR', f'AR_{target}'):
    env[key] = 'llvm-lib'
includes = [sdk / p for p in ('crt/include', 'sdk/include/ucrt', 'sdk/include/um', 'sdk/include/shared', 'sdk/include/winrt')]
env[f'CFLAGS_{target}'] = '--target=x86_64-pc-windows-msvc ' + ' '.join(f'/imsvc "{p}"' for p in includes)
env[f'CXXFLAGS_{target}'] = env[f'CFLAGS_{target}'] + ' /EHsc'
env['CC_SHELL_ESCAPED_FLAGS'] = '1'
env['RC'] = str(llvm / 'llvm-rc')
env['RCFLAGS'] = ' '.join(f'-I"{p}"' for p in includes)
env['LIB'] = ';'.join(str(sdk / p) for p in ('crt/lib/x86_64', 'sdk/lib/um/x86_64', 'sdk/lib/ucrt/x86_64'))
os.execvpe('cargo', ['cargo', *sys.argv[1:]], env)
