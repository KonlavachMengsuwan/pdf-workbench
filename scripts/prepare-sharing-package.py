#!/usr/bin/env python3
"""Create an allowlisted GitHub snapshot and local delivery folder without Git history."""
from pathlib import Path
import hashlib
import json
import re
import shutil
import zipfile

APP = Path(__file__).resolve().parents[1]
ROOT = APP.parent
VERSION = json.loads((APP / 'package.json').read_text())['version']
OUT = ROOT / 'delivery' / VERSION
SOURCE = OUT / 'github-source'
EXCLUDED = {'node_modules', 'dist', 'target', '.git', '__pycache__', '.DS_Store', 'pdfjs'}
ROOT_FILES = ['README.md', 'CONTRIBUTING.md', 'LICENSE-CHOICE.md', 'WINDOWS_BUILD.md', '.gitignore',
              '.gitattributes', '.node-version', '.prettierrc.json', 'package.json', 'package-lock.json', 'rust-toolchain.toml', 'requirements-validation.txt',
              'index.html', 'tsconfig.json', 'vite.config.ts']
DOCS = ['ARCHITECTURE.md', 'PROJECT_FORMAT.md', 'USER_GUIDE.md', 'ROADMAP.md', 'VALIDATION.md',
        'WINDOWS_CROSS_BUILD.md', 'PUBLIC_HANDOFF.md']


def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()


def keep(path): return not any(part in EXCLUDED or part.startswith('._') for part in path.parts)


def copy(path):
    relative = path.relative_to(APP)
    if not keep(relative): return
    dest = SOURCE / relative
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(path, dest)
    dest.chmod(0o755 if path.suffix in ('.sh', '.command') or path.name == 'windows-cargo.py' else 0o644)


def archive_tree(folder, archive, prefix):
    with zipfile.ZipFile(archive, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as out:
        for path in sorted(folder.rglob('*')):
            if path.is_file() and keep(path.relative_to(folder)):
                out.write(path, Path(prefix) / path.relative_to(folder))
    with zipfile.ZipFile(archive) as check:
        if check.testzip(): raise RuntimeError('ZIP integrity failure')


def main():
    if not (ROOT / '.pdfworkbench-workspace').is_file(): raise SystemExit('The configured project workspace is missing.')
    if OUT.exists(): raise SystemExit('Delivery folder already exists. Earlier delivery copies are never overwritten.')
    SOURCE.mkdir(parents=True)
    for name in ROOT_FILES: copy(APP / name)
    for folder in ('src', 'assets', 'notices', 'examples', '.github', 'src-tauri/src', 'src-tauri/icons', 'src-tauri/capabilities', 'src-tauri/vendor', 'tests'):
        for path in (APP / folder).rglob('*'):
            if path.is_file(): copy(path)
    for path in (APP / 'scripts').iterdir():
        if path.is_file() and path.name not in ('clean-git-metadata.py', 'benchmark-startup.py'): copy(path)
    for name in ('Cargo.toml', 'Cargo.lock', 'build.rs', 'tauri.conf.json', 'tauri.windows.conf.json', 'Info.plist'):
        copy(APP / 'src-tauri' / name)
    copy(APP / 'src-tauri/binaries/.gitkeep')
    for name in DOCS: copy(APP / 'docs' / name)
    for name in ('validation.json', f'educational-workflow-{VERSION}.json', f'macos-package-{VERSION}.json', f'windows-package-{VERSION}.json', f'source-snapshot-{VERSION}.json', f'optimization-{VERSION}.json'):
        copy(APP / 'docs/results' / name)
    for path in (APP / f'docs/screenshots/public-{VERSION}').glob('*.jpg'): copy(path)

    # Exact input allowlist for all PDF files: no paper, project, or local receipt
    # can enter this source snapshot by accidentally matching a broad directory.
    pdfs = {p.relative_to(SOURCE).as_posix() for p in SOURCE.rglob('*.pdf') if keep(p.relative_to(SOURCE))}
    expected = {'examples/field-notes.pdf', 'examples/field-notes-rotated.pdf', 'examples/optimization-lab.pdf'}
    if pdfs != expected: raise RuntimeError(f'Unexpected PDF in source snapshot: {pdfs - expected}')
    check_files = [p for p in SOURCE.rglob('*') if p.is_file() and keep(p.relative_to(SOURCE))]
    # Detect local-machine paths without storing a person's name or paper ID in
    # this public script. Known source inputs are constrained by the PDF allowlist.
    personal = re.compile(rb'/(?:Users|Volumes)/[A-Za-z0-9][A-Za-z0-9 _.-]*/')
    for path in check_files:
        data = path.read_bytes()
        if path.suffix.lower() not in ('.jpg','.jpeg','.png','.icns','.ico','.pdf') and personal.search(data):
            raise RuntimeError('Local machine path in public source: '+str(path.relative_to(SOURCE)))
        if path.name.endswith(('.recipe.json','.pdfworkbench.json')): raise RuntimeError('Private processing record found')
    source_manifest = {'appVersion':VERSION, 'gitHistoryIncluded':False, 'examplePdfs':sorted(pdfs),
                       'files':{p.relative_to(SOURCE).as_posix():digest(p) for p in sorted(check_files)}}
    (OUT / 'source-manifest.json').write_text(json.dumps(source_manifest,indent=2)+'\n')
    archive_tree(SOURCE, OUT / f'PDF-Workbench-{VERSION}-GitHub-source.zip', 'PDFWorkbench-GitHub-source')

    installers = OUT / 'installers';installers.mkdir()
    for suffix in ('dmg','pkg','zip'):
        path=ROOT / 'releases' / VERSION / f'PDF-Workbench-{VERSION}-macOS-arm64.{suffix}'
        shutil.copyfile(path, installers / path.name)
    windows=ROOT / f'caches/target-windows-cross/x86_64-pc-windows-msvc/release/bundle/nsis/PDF Workbench_{VERSION}_x64-setup.exe'
    shutil.copyfile(windows, installers / f'PDF-Workbench-{VERSION}-Windows-x64-setup.exe')
    screenshots = OUT / 'screenshots';screenshots.mkdir()
    for path in (APP / f'docs/screenshots/public-{VERSION}').glob('*.jpg'):
        if not path.name.startswith('._'): shutil.copyfile(path,screenshots/path.name)
    assets=[p for p in installers.iterdir() if p.is_file() and not p.name.startswith('._')]
    (installers/'SHA256SUMS').write_text(''.join(f'{digest(p)}  {p.name}\n' for p in sorted(assets)))
    print(json.dumps({'delivery':str(OUT),'sourceFiles':len(check_files),'sourceZip':str(OUT/f'PDF-Workbench-{VERSION}-GitHub-source.zip'),'installers':[p.name for p in sorted(assets)],'pdfAllowlist':sorted(pdfs)},indent=2))

if __name__ == '__main__': main()
