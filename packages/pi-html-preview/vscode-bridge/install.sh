#!/usr/bin/env bash
# Install the preview-bridge extension into the running vscode-server.
# Run once; then execute "Developer: Reload Window" in VS Code to activate.
set -euo pipefail

SRC="$(cd "$(dirname "$0")/hyx-preview-bridge-0.0.1" && pwd)"
DST="$HOME/.vscode-server/extensions/hyx-preview-bridge-0.0.1"

rm -rf "$DST"
cp -r "$SRC" "$DST"
echo "installed: $DST"
echo "next: run 'Developer: Reload Window' in VS Code, then check ~/.vscode-server/extensions/hyx-preview-bridge-0.0.1/ shows no errors"
