#!/usr/bin/env python3
"""Create local, unsigned Mac installers from an already verified release app.

No installation or administrator command is performed. Developer ID signing and
notarization require a separately authorized release process and Apple account.
"""
from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
VERSION = json.loads((ROOT / 'app/package.json').read_text())['version']
RELEASE = ROOT / 'releases' / VERSION
APP = RELEASE / 'PDF Workbench.app'


def run(*args):
    return subprocess.run(args, check=True, text=True, capture_output=True, env=dict(os.environ, COPYFILE_DISABLE='1'))


def main():
    if not (ROOT / '.pdfworkbench-workspace').is_file():
        raise SystemExit('The existing project workspace is required.')
    run('/usr/bin/codesign', '--verify', '--deep', '--strict', str(APP))
    dmg = RELEASE / f'PDF-Workbench-{VERSION}-macOS-arm64.dmg'
    pkg = RELEASE / f'PDF-Workbench-{VERSION}-macOS-arm64.pkg'
    if dmg.exists() or pkg.exists():
        raise SystemExit('Installer destination already exists; previous releases are retained.')
    results = {'version': VERSION, 'signing': 'App: local ad-hoc. PKG/DMG: unsigned. Not notarized.',
               'installationTest': 'Not installed to /Applications; workspace-only verification.'}
    with tempfile.TemporaryDirectory(prefix='dmg-stage-', dir=ROOT / 'tmp') as temporary:
        stage = Path(temporary)
        shutil.copytree(APP, stage / APP.name, copy_function=shutil.copy,
                        ignore=shutil.ignore_patterns('._*', '.DS_Store'))
        # Clear only metadata on this generated copy. Installer archives must
        # not carry nested AppleDouble files from an external build filesystem.
        clean_app = stage / APP.name
        for path in [*clean_app.rglob('*'), clean_app]:
            if not path.name.startswith('._'):
                run('/usr/bin/xattr', '-c', str(path))
        for path in clean_app.rglob('._*'):
            if path.is_file(): path.unlink()
        run('/usr/bin/codesign', '--verify', '--deep', '--strict', str(clean_app))
        run('/usr/bin/pkgbuild', '--component', str(clean_app), '--install-location', '/Applications',
            '--identifier', 'local.pdfworkbench.desktop.pkg', '--version', VERSION, str(pkg))
        try:
            (stage / 'Applications').symlink_to('/Applications', target_is_directory=True)
        except OSError:
            # Some external filesystems do not implement symlinks. The README
            # still gives a complete Finder installation procedure.
            pass
        (stage / 'INSTALL.txt').write_text(
            f'PDF Workbench {VERSION} — educational preview\n\n'
            'Requires an Apple Silicon Mac with macOS 15.4 or later.\n'
            'Drag PDF Workbench.app into Applications using Finder, then open it.\n'
            'You may instead keep the app in a folder you control.\n\n'
            'This build is ad-hoc signed, not Developer ID signed or notarized.\n'
            'macOS may block a downloaded copy. Do not disable system security.\n'
            'A developer can build from the supplied source; public signing and\n'
            'notarization are planned before general distribution.\n\n'
            'Core PDF processing stays local and originals are preserved.\n'
            'Use Open PDF inside the app to select a document.\n', encoding='utf-8')
        env = dict(os.environ, COPYFILE_DISABLE='1')
        made = subprocess.run(['/usr/bin/hdiutil', 'create', '-srcfolder', str(stage),
                               '-volname', 'PDF Workbench', '-fs', 'HFS+', '-format', 'UDZO', str(dmg)],
                              env=env, capture_output=True, text=True)
        if made.returncode == 0:
            run('/usr/bin/hdiutil', 'verify', str(dmg))
            results['dmgVerification'] = 'hdiutil verify passed'
        else:
            results['dmgError'] = made.stderr.strip()
            print('DMG creation unavailable; the component PKG was created.', made.stderr.strip())
    outputs = [p for p in (pkg, dmg) if p.is_file()]
    results['files'] = {p.name: {'bytes': p.stat().st_size, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in outputs}
    (RELEASE / 'installer-manifest.json').write_text(json.dumps(results, indent=2) + '\n')
    with (RELEASE / 'SHA256SUMS').open('a') as sums:
        for name, data in results['files'].items(): sums.write(f'{data["sha256"]}  {name}\n')
    print(json.dumps(results, indent=2))

if __name__ == '__main__':
    main()
