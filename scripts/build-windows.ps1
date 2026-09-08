# Native Windows x64 build route. Windows execution remains untested until verified.
# Run in an isolated Windows VM or build runner.
param([string]$Workspace = (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent))
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This preparation script must run in Windows x64.' }
$Workspace = (Resolve-Path -LiteralPath $Workspace).Path
$Repo = Join-Path $Workspace 'app'
if (!(Test-Path -LiteralPath (Join-Path $Repo 'package-lock.json'))) { throw 'Use a dedicated PDFWorkbench workspace with this repository in app.' }
# All writes and downloads below are under this explicit workspace. Prerequisite
# MSVC/WebView2 installation is external and must be arranged separately.
foreach ($name in @('tools','caches','tmp','projects','exports','test-data')) { New-Item -ItemType Directory -Force -Path (Join-Path $Workspace $name) | Out-Null }
Set-Content -LiteralPath (Join-Path $Workspace '.pdfworkbench-workspace') -Value 'PDF Workbench dedicated workspace' -NoNewline
$env:PDFWORKBENCH_HOME = $Workspace
$env:CARGO_HOME = Join-Path $Workspace 'tools\cargo-windows'
$env:RUSTUP_HOME = Join-Path $Workspace 'tools\rustup-windows'
$env:CARGO_TARGET_DIR = Join-Path $Workspace 'caches\target-windows'
$env:CARGO_BUILD_JOBS = '2'
$env:npm_config_cache = Join-Path $Workspace 'caches\npm-windows'
$env:TEMP = Join-Path $Workspace 'tmp'
$env:TMP = $env:TEMP
foreach ($command in @('node','npm','rustup','cargo','cl.exe','python')) {
  if (!(Get-Command $command -ErrorAction SilentlyContinue)) { throw "Missing $command. Start an x64 MSVC developer shell with Node 24 and project-local Rust installed. This script does not install system prerequisites." }
}
& rustup toolchain install 1.98.1 --profile minimal
if ($LASTEXITCODE) { throw 'Rust toolchain setup failed' }
$RustVersion = Get-Content -LiteralPath (Join-Path $Repo 'rust-toolchain.toml') -ErrorAction SilentlyContinue
if (!$RustVersion) { Write-Host 'Install the Rust version documented in README into the project-local CARGO_HOME/RUSTUP_HOME before building.' }
$Version = '12.4.1'
$ArchiveName = "qpdf-$Version-msvc64.zip"
$Url = "https://github.com/qpdf/qpdf/releases/download/v$Version/$ArchiveName"
$Expected = '3cd016cd433ef7232e42f4c13348a49cc14907a3c7278ef4f99120593126f7a6'
$Archive = Join-Path $Workspace "caches\$ArchiveName"
if (!(Test-Path -LiteralPath $Archive)) { Invoke-WebRequest -Uri $Url -OutFile $Archive }
if ((Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Expected) { throw 'qpdf archive SHA-256 mismatch. Nothing was extracted.' }
$Unpack = Join-Path $Workspace "tools\qpdf-$Version-windows"
if (!(Test-Path -LiteralPath $Unpack)) { Expand-Archive -LiteralPath $Archive -DestinationPath $Unpack }
$Qpdf = @(Get-ChildItem -LiteralPath $Unpack -Recurse -Filter 'qpdf.exe')
if ($Qpdf.Count -ne 1) { throw 'Unexpected qpdf archive layout; inspect before proceeding.' }
$BinaryDir = Join-Path $Repo 'src-tauri\binaries'
$DllDir = Join-Path $BinaryDir 'windows'
New-Item -ItemType Directory -Force -Path $DllDir | Out-Null
Copy-Item -LiteralPath $Qpdf[0].FullName -Destination (Join-Path $BinaryDir 'qpdf-x86_64-pc-windows-msvc.exe')
$Resources = @{}
foreach ($Dll in Get-ChildItem -LiteralPath $Qpdf[0].DirectoryName -Filter '*.dll') {
  Copy-Item -LiteralPath $Dll.FullName -Destination (Join-Path $DllDir $Dll.Name)
  Copy-Item -LiteralPath $Dll.FullName -Destination (Join-Path $BinaryDir $Dll.Name)
  # Explicit source-to-destination mappings place runtime DLLs beside qpdf.exe.
  $Resources["binaries/windows/$($Dll.Name)"] = $Dll.Name
}
if ($Resources.Count -eq 0) { Write-Warning 'No sibling DLLs found: inspect qpdf dependencies with dumpbin before packaging.' }
$Resources['binaries/THIRD-PARTY-NOTICES.zip'] = 'THIRD-PARTY-NOTICES.zip'
$GeneratedConfig = Join-Path $Repo 'src-tauri\tauri.windows.generated.json'
$ConfigJson = @{bundle=@{resources=$Resources}} | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText($GeneratedConfig, $ConfigJson, [System.Text.UTF8Encoding]::new($false))
$WindowsNotices = Join-Path $Repo 'notices\windows-qpdf'
New-Item -ItemType Directory -Force -Path $WindowsNotices | Out-Null
foreach ($Notice in Get-ChildItem -LiteralPath $Unpack -Recurse -File | Where-Object { $_.Name -match '^(LICENSE|LICENCE|NOTICE|COPYING|COPYRIGHT)' }) {
  $Relative = $Notice.FullName.Substring($Unpack.Length).TrimStart('\')
  $Target = Join-Path $WindowsNotices $Relative
  New-Item -ItemType Directory -Force -Path (Split-Path $Target -Parent) | Out-Null
  Copy-Item -LiteralPath $Notice.FullName -Destination $Target
}
@{version=$Version;url=$Url;archiveSha256=$Expected;binarySha256=(Get-FileHash -LiteralPath $Qpdf[0].FullName -Algorithm SHA256).Hash.ToLowerInvariant();status='prepared; runtime smoke test still required'} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Workspace 'caches\qpdf-windows-provenance.json')
if (!(Test-Path -LiteralPath (Join-Path $Workspace 'test-data\studio-sample.pdf'))) {
  throw 'Generate the owned fixtures before tests: use project-local Python with requirements-validation.txt, then run scripts/generate-fixtures.py. See WINDOWS_BUILD.md. No user PDFs are used as substitutes.'
}
Push-Location $Repo
try {
  & npm ci
  if ($LASTEXITCODE) { throw 'npm ci failed' }
  & python scripts/collect-rust-notices.py
  if ($LASTEXITCODE) { throw 'Dependency notice collection failed' }
  & python scripts/archive-notices.py
  if ($LASTEXITCODE) { throw 'Notice archive creation failed' }
  & npm run test
  if ($LASTEXITCODE) { throw 'Frontend tests failed' }
  & cargo test --locked --manifest-path src-tauri/Cargo.toml --lib -- --test-threads=1
  if ($LASTEXITCODE) { throw 'Native tests failed' }
  & npm exec tauri build -- --target x86_64-pc-windows-msvc --config src-tauri/tauri.windows.conf.json --config src-tauri/tauri.windows.generated.json
  if ($LASTEXITCODE) { throw 'Windows package build failed' }
} finally { Pop-Location }
Write-Warning 'Build completion is NOT Windows validation. Install in this isolated environment and test offline open-transform-export-reopen, DLL loading, fonts, themes, cancellation and WebView2 provisioning. Retain the bundled third-party notices.'
