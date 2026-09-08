#!/usr/bin/env python3
"""Retain license texts and MPL corresponding source for both desktop targets."""
from pathlib import Path
import json
import shutil
import subprocess

APP = Path(__file__).resolve().parents[1]
NOTICES = APP / 'notices'
TARGETS = ('aarch64-apple-darwin', 'x86_64-pc-windows-msvc')


def main():
    packages = {}
    for target in TARGETS:
        result = subprocess.run(['cargo', 'metadata', '--locked', '--format-version', '1',
            '--manifest-path', str(APP / 'src-tauri/Cargo.toml'), '--filter-platform', target],
            check=True, capture_output=True, text=True)
        data = json.loads(result.stdout)
        selected = {node['id'] for node in data['resolve']['nodes']}
        for package in data['packages']:
            if package['id'] in selected and package['name'] != 'pdf-workbench':
                packages[package['id']] = package
    rows = []
    for package in sorted(packages.values(), key=lambda p: (p['name'], p['version'])):
        origin = Path(package['manifest_path']).parent
        dest = NOTICES / 'rust' / f'{package["name"]}-{package["version"]}'
        dest.mkdir(parents=True, exist_ok=True)
        found = []
        candidates = list(origin.iterdir())
        if (origin / 'licenses').is_dir(): candidates += list((origin / 'licenses').iterdir())
        for source in candidates:
            if source.is_file() and not source.name.startswith('._') and source.name.upper().startswith(('LICENSE', 'LICENCE', 'NOTICE', 'COPYING', 'COPYRIGHT', 'UNICODE-LICENSE')):
                shutil.copyfile(source, dest / source.name); found.append(source.name)
        if package.get('license_file'):
            source = origin / package['license_file']
            if source.is_file(): shutil.copyfile(source, dest / source.name); found.append(source.name)
        if not found:
            found = [p.name for p in dest.iterdir() if p.is_file() and p.name.upper().startswith(('LICENSE', 'LICENCE', 'NOTICE', 'COPYING', 'COPYRIGHT'))]
        if not found:
            raise RuntimeError(f'License text not found for {package["name"]} {package["version"]}; inspect upstream before packaging.')
        if 'MPL' in (package.get('license') or ''):
            shutil.copytree(origin, dest / 'source', dirs_exist_ok=True, copy_function=shutil.copy,
                ignore=shutil.ignore_patterns('._*', '.DS_Store', 'target', '.git'))
        rows.append(f'| {package["name"]} | {package["version"]} | {package.get("license", "See license file")} |')
    (NOTICES / 'RUST-DEPENDENCIES.md').write_text(
        '# Rust dependency notices — macOS arm64 and Windows x64\n\n'
        'Generated from the union of locked target dependency graphs, including build dependencies. '
        'Cargo.lock defines resolution. License texts are retained in rust/<crate-version>/. '
        'Full corresponding source is included for MPL-2.0 components; no MPL source was modified. '
        'The local tauri-utils patch is included in src-tauri/vendor/tauri-utils in the application source.\n\n'
        '| Crate | Version | Declared license |\n|---|---|---|\n' + '\n'.join(rows) + '\n')
    print(f'Collected notices for {len(packages)} locked Rust packages across both targets.')

if __name__ == '__main__': main()
