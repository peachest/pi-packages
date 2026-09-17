#!/usr/bin/env bash
# Install the preview-bridge extension into the running vscode-server.
# Run once; then execute "Developer: Reload Window" in VS Code to activate.
set -euo pipefail

SRC="$(cd "$(dirname "$0")/hyx-preview-bridge-0.0.1" && pwd)"
EXT_DIR="${VSCODE_EXTENSIONS_DIR:-$HOME/.vscode-server/extensions}"
DST="$EXT_DIR/hyx-preview-bridge-0.0.1"
TMP="$EXT_DIR/.hyx-preview-bridge-0.0.1.tmp.$$"

# atomic-ish install: stage to a temp dir then mv, so a failed cp never
# leaves a half-installed extension folder that breaks extension loading
rm -rf "$TMP"
cp -r "$SRC" "$TMP"
rm -rf "$DST"
mv "$TMP" "$DST"
echo "installed: $DST"
echo "next: run 'Developer: Reload Window' in VS Code, then check ~/.vscode-server/extensions/hyx-preview-bridge-0.0.1/ shows no errors"
