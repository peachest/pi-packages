#!/usr/bin/env bash
# pi-context-mode-lite upstream sync.
#
# Usage:
#   ./sync.sh <path-to-extracted-context-mode-package-dir>
#     e.g. npm pack context-mode@x.y.z && tar xzf mksglu-context-mode-x.y.z.tgz
#          ./sync.sh package
#
# What it does:
#   1. Verifies upstream/ is currently clean (patch fully applied) — abort otherwise.
#   2. Replaces build/ + server.bundle.mjs + package.json from the
#      extracted upstream dir (skills/ intentionally never copied — lite drops all 8 skills;
#      node_modules/ not copied either — zod is only needed by build/server.js source path,
#      the pi chain and the fully-bundled server.bundle.mjs run without it, verified 2026-10-20).
#   3. Replays lite.patch. Conflict => exit 1 loudly; resolve by hand, regenerate patch.
#
# The installed npm copy also works as <src>: ~/.pi/agent/npm/node_modules/context-mode
# (must be the pristine version you want to vendor, not a previously patched one).
set -euo pipefail

SRC="${1:?usage: ./sync.sh <extracted-context-mode-package-dir>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
UP="$HERE/upstream"
PATCH="$HERE/lite.patch"

# 1. upstream must currently match the patch (no local drift)
git -C "$HERE" diff --quiet -- upstream/ || {
  echo "ERROR: upstream/ has uncommitted local changes; commit or stash first." >&2
  exit 1
}

# 2. refresh upstream payload
rm -rf "$UP/build" "$UP/server.bundle.mjs" "$UP/package.json"
cp -a "$SRC/build" "$SRC/server.bundle.mjs" "$SRC/package.json" "$UP/"
[ -f "$SRC/LICENSE" ] && cp -a "$SRC/LICENSE" "$UP/"

# 3. replay the patch; fail loudly on conflict
if git -C "$HERE" apply --3way "$PATCH"; then
  echo "OK: upstream refreshed, lite.patch applied cleanly."
  echo "Next: node import-smoke check, bump version in package.json, commit."
else
  echo "CONFLICT: lite.patch failed to apply. Upstream moved into patched regions." >&2
  echo "Resolve by hand in upstream/, then regenerate: git diff -- upstream/ > lite.patch" >&2
  exit 1
fi
