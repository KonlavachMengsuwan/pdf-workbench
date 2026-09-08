#!/usr/bin/env python3
"""Inspect Mac installer payloads without an administrator installation."""
from pathlib import Path
import subprocess,hashlib,shutil,json,zipfile
root=Path(__file__).resolve().parents[2];version=json.loads((root/'app/package.json').read_text())['version'];release=root/'releases'/version;app=release/'PDF Workbench.app';tool=root/'tools/archive-check/7zz';checks=[]
def run(*args):return subprocess.run(args,check=True,capture_output=True,text=True).stdout
def check(ok,label):
 checks.append({'name':label,'passed':bool(ok)})
 if not ok:raise AssertionError(label)
run('/usr/bin/codesign','--verify','--deep','--strict',str(app));check(True,'Release app ad-hoc signature verifies')
with zipfile.ZipFile(release/f'PDF-Workbench-{version}-macOS-arm64.zip') as z:check(z.testzip() is None,'App ZIP integrity')
for suffix in ('pkg','dmg'):
 path=release/f'PDF-Workbench-{version}-macOS-arm64.{suffix}';dest=root/f'tmp/final-mac-{suffix}-{version}'
 if suffix=='pkg':run('/usr/sbin/pkgutil','--expand-full',str(path),str(dest))
 else:
  run('/usr/bin/hdiutil','verify',str(path));run(str(tool),'t',str(path));run(str(tool),'x',str(path),f'-o{dest}','PDF Workbench/PDF Workbench.app/*','-y')
 check(True,f'{suffix}: archive/payload extraction passed')
 extracted=next(dest.rglob('PDF Workbench.app'))
 # 7-Zip exposes HFS metadata streams as separate colon-suffixed files.
 # They are filesystem metadata, not application resources on native macOS.
 for p in extracted.rglob('*:com.apple.provenance'):
  if p.is_file():p.unlink()
 copy=dest/'verified-app/PDF Workbench.app';copy.parent.mkdir()
 shutil.copytree(extracted,copy,copy_function=shutil.copy,ignore=shutil.ignore_patterns('._*','.DS_Store'))
 for original in app.rglob('*'):
  if original.is_file() and not original.name.startswith('._'):
   counterpart=copy/original.relative_to(app);check(counterpart.is_file() and hashlib.sha256(counterpart.read_bytes()).digest()==hashlib.sha256(original.read_bytes()).digest(),f'{suffix}: {original.relative_to(app)} matches release app')
 run('/usr/bin/codesign','--verify','--deep','--strict',str(copy));check(True,f'{suffix}: extracted application signature verifies')
 run(str(copy/'Contents/MacOS/qpdf'),'--version');check(True,f'{suffix}: bundled qpdf runs on build Mac')
report={'schemaVersion':1,'appVersion':version,'platform':'macOS arm64','administratorInstallationPerformed':False,'nativeDmgMountTest':'Earlier attempt denied by host permissions; final image verified and extracted without mounting.','checks':checks,'files':{p.name:{'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in release.iterdir() if p.is_file() and p.suffix in ('.zip','.dmg','.pkg') and not p.name.startswith('._')}}
(root/f'app/docs/results/macos-package-{version}.json').write_text(json.dumps(report,indent=2)+'\n');print(len(checks),'Mac package checks passed')
