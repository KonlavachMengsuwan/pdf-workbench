#!/bin/zsh
set -e
# This tracked launcher resolves the project from app/scripts; the root launcher
# delegates here. It never creates an internal replacement for a missing SSD.
PDFWORKBENCH_HOME="${0:A:h:h:h}"
export PDFWORKBENCH_HOME
if [[ ! -f "$PDFWORKBENCH_HOME/.pdfworkbench-workspace" || ! -d "$PDFWORKBENCH_HOME/tmp" ]]; then
  print -u2 'PDF Workbench workspace is unavailable. Reconnect the project SSD.'
  exit 1
fi
PDFW_APP="$PDFWORKBENCH_HOME/releases/0.1.5/PDF Workbench.app"
if [[ ! -d "$PDFW_APP" ]]; then
  print -u2 'The packaged app is missing. See app/README.md for rebuild instructions.'
  exit 1
fi
/usr/bin/open --env "PDFWORKBENCH_HOME=$PDFWORKBENCH_HOME" "$PDFW_APP"
