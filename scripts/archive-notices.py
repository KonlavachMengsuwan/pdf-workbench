#!/usr/bin/env python3
"""Bundle complete third-party notices without filesystem metadata artifacts."""
from pathlib import Path
import hashlib
import zipfile

APP = Path(__file__).resolve().parents[1]
source = APP / 'notices'
destination = APP / 'src-tauri/binaries/THIRD-PARTY-NOTICES.zip'
destination.parent.mkdir(parents=True, exist_ok=True)
files = [p for p in sorted(source.rglob('*')) if p.is_file() and not any(part.startswith('._') or part == '.DS_Store' for part in p.relative_to(source).parts)]
if not files: raise SystemExit('Dependency notices are missing; restore the notices directory before building.')
with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for path in files:
        info = zipfile.ZipInfo(path.relative_to(source).as_posix(), date_time=(2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        archive.writestr(info, path.read_bytes())
print(f'Archived {len(files)} notice/source files; SHA-256 {hashlib.sha256(destination.read_bytes()).hexdigest()}')
