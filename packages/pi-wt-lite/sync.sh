#!/usr/bin/env bash
# pi-wt-lite upstream sync.
#
# Usage:
#   ./sync.sh <path-to-extracted-pi-worktrunk-package-dir>
#     e.g. npm pack pi-worktrunk@x.y.z && tar xzf pi-worktrunk-x.y.z.tgz
#          ./sync.sh package
#
# What it does:
#   1. Verifies upstream/ is currently clean (patch fully applied) — abort otherwise.
#   2. Replaces worktrunk.ts + package.json + LICENSE from the extracted upstream dir
#      (README.md intentionally not copied — upstream README describes the unpatched tool).
#   3. Replays lite.patch with plain git apply (--3way would fail against the
#      patched blob in the index). NOTE: inside a work tree git apply resolves
#      patch paths against the REPO ROOT and silently skips missing targets, so
#      the package-relative patch paths need --directory=<show-prefix> applied
#      from the repo top. Conflict => exit 1 loudly; resolve by hand, regenerate patch.
#
# The installed npm copy also works as <src>: ~/.pi/agent/npm/node_modules/pi-worktrunk
# (must be the pristine version you want to vendor, not a previously patched one).
set -euo pipefail

SRC="${1:?usage: ./sync.sh <extracted-pi-worktrunk-package-dir>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
UP="$HERE/upstream"
PATCH="$HERE/lite.patch"

# 1. upstream must currently match the patch (no local drift)
git -C "$HERE" diff --quiet -- upstream/ || {
  echo "ERROR: upstream/ has uncommitted local changes; commit or stash first." >&2
  exit 1
}

# 2. refresh upstream payload
rm -f "$UP/worktrunk.ts" "$UP/package.json" "$UP/LICENSE"
cp -a "$SRC/worktrunk.ts" "$SRC/package.json" "$UP/"
[ -f "$SRC/LICENSE" ] && cp -a "$SRC/LICENSE" "$UP/"

# 3. replay the patch; fail loudly on conflict
TOP="$(git -C "$HERE" rev-parse --show-toplevel)"
PREFIX="$(git -C "$HERE" rev-parse --show-prefix)"
if git -C "$TOP" apply --directory="${PREFIX%/}" "$PATCH"; then
  echo "OK: upstream refreshed, lite.patch applied cleanly."
  echo "Next: bump version in package.json, update README source-version note, commit."
else
  echo "CONFLICT: lite.patch failed to apply. Upstream moved into patched regions." >&2
  echo "Resolve by hand in upstream/, then regenerate: git diff -- upstream/ > lite.patch" >&2
  exit 1
fi
