#!/usr/bin/env python3
"""Create a verified, locally ad-hoc-signed .app/ZIP inside this workspace.

No Apple account, notarization, remote publishing, security setting changes, or
private signing credentials are involved. Run after the documented Tauri build.
"""
import argparse
import hashlib
import json
import os
import plistlib
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import zipfile


def run(*args):
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(f'{args[0]} failed: {result.stdout}{result.stderr}')
    return result


def ignore_missing(function, path, error):
    if not isinstance(error[1], FileNotFoundError):
        raise error[1]

def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def main():
    workspace = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=workspace / 'caches/target/release/bundle/macos/PDF Workbench.app')
    parser.add_argument('--release', default=json.loads((workspace / 'app/package.json').read_text())['version'])
    args = parser.parse_args()
    if sys.platform != 'darwin':
        parser.error('This packaging helper runs on macOS only.')
    if not (workspace / '.pdfworkbench-workspace').is_file():
        parser.error('The dedicated workspace is unavailable; no fallback was created.')
    source = args.source.resolve(strict=True)
    if workspace not in source.parents or source.suffix != '.app':
        parser.error('Source must be a generated .app inside this project workspace.')
    if not args.release or '/' in args.release or '\\' in args.release or args.release in ('.', '..'):
        parser.error('Choose a simple release directory name.')
    destination = workspace / 'releases' / args.release
    if destination.exists():
        parser.error(f'{destination} already exists. Choose a new release name; earlier builds are retained.')
    destination.parent.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='package-', dir=workspace / 'tmp') as temp:
        clean = Path(temp) / source.name
        shutil.copytree(source, clean, copy_function=shutil.copy, ignore=shutil.ignore_patterns('._*', '.DS_Store'))
        # Measured exFAT clusters turned 233 crates' small license/source files
        # into >1 GiB allocated. Keep all notices and corresponding sources in
        # one ordinary ZIP inside the final bundle, without changing content.
        notices = clean / 'Contents/Resources/notices'
        if notices.is_dir():
            notices_zip = clean / 'Contents/Resources/THIRD-PARTY-NOTICES.zip'
            with zipfile.ZipFile(notices_zip, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zipped:
                for notice in sorted(notices.rglob('*')):
                    if notice.is_file() and not notice.name.startswith('._'):
                        zipped.write(notice, notice.relative_to(notices))
            shutil.rmtree(notices, onerror=ignore_missing)
        # Remove only metadata from this newly generated copy. Copying source
        # xattrs from exFAT into a bundle breaks resource seals on macOS.
        real_paths = [str(p) for p in clean.rglob('*') if not p.name.startswith('._')] + [str(clean)]
        # Recursive xattr tries to mutate AppleDouble files themselves on exFAT
        # and receives EPERM. Operate on actual generated files/directories only.
        for at in range(0, len(real_paths), 40):
            run('/usr/bin/xattr', '-c', *real_paths[at:at + 40])
        for p in sorted(clean.rglob('._*'), reverse=True):
            if p.is_file(): p.unlink()
        # Inner executable first, outer app last. This is local ad-hoc signing.
        qpdf = clean / 'Contents/MacOS/qpdf'
        run('/usr/bin/codesign', '--force', '--sign', '-', '--timestamp=none', str(qpdf))
        for p in sorted(clean.rglob('._*'), reverse=True):
            if p.is_file(): p.unlink()
        run('/usr/bin/codesign', '--force', '--sign', '-', '--timestamp=none', str(clean))
        verification = run('/usr/bin/codesign', '--verify', '--deep', '--strict', '--verbose=2', str(clean))
        engine = run(str(qpdf), '--version').stdout.strip()
        # Move on the same project filesystem, preserving the sealed bytes.
        destination.mkdir()
        final_app = destination / source.name
        clean.rename(final_app)
        run('/usr/bin/codesign', '--verify', '--deep', '--strict', '--verbose=2', str(final_app))
        archive = destination / f'PDF-Workbench-{args.release}-macOS-arm64.zip'
        with zipfile.ZipFile(archive, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zipped:
            for p in sorted(final_app.rglob('*')):
                if p.is_file() and not p.name.startswith('._'):
                    zipped.write(p, p.relative_to(destination))
        manifest = {
            'appVersion': plistlib.loads((final_app / 'Contents/Info.plist').read_bytes())['CFBundleShortVersionString'], 'platform': 'macOS arm64',
            'signing': 'local ad-hoc; not Developer ID signed; not notarized',
            'verification': (verification.stdout + verification.stderr).strip(),
            'qpdf': engine, 'archive': archive.name, 'archiveSha256': digest(archive),
            'files': {str(p.relative_to(final_app)): digest(p) for p in sorted(final_app.rglob('*')) if p.is_file() and not p.name.startswith('._')},
        }
        (destination / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        (destination / 'SHA256SUMS').write_text(f'{manifest["archiveSha256"]}  {archive.name}\n')
        print(json.dumps({'app': str(final_app), 'archive': str(archive), 'sha256': manifest['archiveSha256'], 'qpdf': engine, 'signature': 'ad-hoc verified'}, indent=2))


if __name__ == '__main__':
    main()
