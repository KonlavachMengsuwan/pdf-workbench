#!/usr/bin/env python3
"""Inspect an NSIS payload on the build Mac. This is not a Windows runtime test."""
from pathlib import Path
import argparse
import hashlib
import json
import re
import subprocess
import tempfile
import zipfile

APP = Path(__file__).resolve().parents[1]
ROOT = APP.parent
VERSION = json.loads((APP / 'package.json').read_text())['version']


def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout


def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--installer', type=Path, default=ROOT / f'caches/target-windows-cross/x86_64-pc-windows-msvc/release/bundle/nsis/PDF Workbench_{VERSION}_x64-setup.exe')
    parser.add_argument('--archive-tool', type=Path, default=ROOT / 'tools/archive-check/7zz')
    parser.add_argument('--llvm-readobj', type=Path, default=ROOT / 'tools/windows-cross/llvm/bin/llvm-readobj')
    args = parser.parse_args()
    report = {'schemaVersion': 1, 'appVersion': VERSION, 'buildHost': 'macOS arm64', 'runtimeTestedOnWindows': False,
              'installerBytes': args.installer.stat().st_size, 'installerSha256': digest(args.installer), 'checks': [], 'imports': {}}
    def check(ok, label):
        report['checks'].append({'name': label, 'passed': bool(ok)})
        if not ok: raise AssertionError(label)
    run(str(args.archive_tool), 't', str(args.installer))
    check(True, 'NSIS archive integrity test passed')
    with tempfile.TemporaryDirectory(prefix='windows-package-check-', dir=ROOT / 'tmp') as temp:
        payload = Path(temp)
        run(str(args.archive_tool), 'x', str(args.installer), f'-o{payload}', '-y')
        files = [p for p in payload.rglob('*') if p.is_file() and not p.name.startswith('._')]
        # Temporary exFAT metadata is excluded from inspection; inspect the archive
        # listing separately to ensure the installer itself contains none.
        listing = run(str(args.archive_tool), 'l', '-slt', str(args.installer))
        check(not re.search(r'^Path = .*[/\\]\.\_', listing, re.MULTILINE), 'Installer does not contain AppleDouble metadata files')
        check((payload / 'THIRD-PARTY-NOTICES.zip').is_file(), 'Third-party license/source archive is included')
        with zipfile.ZipFile(payload / 'THIRD-PARTY-NOTICES.zip') as archive:
            check(archive.testzip() is None, 'Third-party notice archive integrity')
            check('windows-webview2/LICENSE.txt' in archive.namelist(), 'Microsoft WebView2 SDK license is included')
            check('installers/NSIS-3.11-COPYING.txt' in archive.namelist(), 'NSIS license texts are included')
        available = {p.name.lower() for p in payload.iterdir() if p.is_file()}
        system = {'kernel32.dll','user32.dll','gdi32.dll','advapi32.dll','shell32.dll','ole32.dll','oleaut32.dll','comdlg32.dll','comctl32.dll',
                  'shlwapi.dll','shcore.dll','dwmapi.dll','uxtheme.dll','version.dll','ntdll.dll','bcrypt.dll','bcryptprimitives.dll','crypt32.dll','ws2_32.dll',
                  'userenv.dll','propsys.dll','secur32.dll','msvcrt.dll','ucrtbase.dll','winmm.dll','winspool.drv','imm32.dll','dxgi.dll',
                  'd3d11.dll','d2d1.dll','dwrite.dll','opengl32.dll','powrprof.dll','iphlpapi.dll','winhttp.dll','wininet.dll','rpcrt4.dll'}
        binaries = [payload / 'pdf-workbench.exe', payload / 'qpdf.exe'] + sorted(p for p in payload.glob('*.dll') if not p.name.startswith('._'))
        for binary in binaries:
            check(binary.is_file(), f'{binary.name}: present')
            header = run(str(args.llvm_readobj), '--file-headers', str(binary))
            check('IMAGE_FILE_MACHINE_AMD64' in header, f'{binary.name}: x64 PE architecture')
            imports = sorted(set(re.findall(r'Name: (\S+)', run(str(args.llvm_readobj), '--coff-imports', str(binary)))))
            report['imports'][binary.name] = imports
            missing = [name for name in imports if name.lower() not in available | system and not name.lower().startswith(('api-ms-win-', 'ext-ms-win-'))]
            check(not missing, f'{binary.name}: imported libraries are bundled or Windows system libraries ({", ".join(missing)})')
            if binary.name != 'pdf-workbench.exe':
                original = next((ROOT / 'tools/qpdf-12.4.1-windows').rglob(binary.name))
                check(digest(binary) == digest(original), f'{binary.name}: matches verified official qpdf distribution')
    destination = APP / f'docs/results/windows-package-{VERSION}.json'
    destination.write_text(json.dumps(report, indent=2) + '\n')
    print(f'{len(report["checks"])} static package checks passed. Windows execution remains untested.')

if __name__ == '__main__': main()
