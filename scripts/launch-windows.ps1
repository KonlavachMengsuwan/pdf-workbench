# Prepared launch helper. WINDOWS REMAINS UNTESTED.
param([Parameter(Mandatory=$true)][string]$AppPath, [Parameter(Mandatory=$true)][string]$Workspace)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Run this helper only in a dedicated Windows environment.' }
$Workspace = (Resolve-Path -LiteralPath $Workspace).Path
if (!(Test-Path -LiteralPath (Join-Path $Workspace '.pdfworkbench-workspace')) -or !(Test-Path -LiteralPath (Join-Path $Workspace 'tmp'))) { throw 'The explicit PDF Workbench workspace is unavailable; no fallback was created.' }
$AppPath = (Resolve-Path -LiteralPath $AppPath).Path
$env:PDFWORKBENCH_HOME = $Workspace
Start-Process -FilePath $AppPath
