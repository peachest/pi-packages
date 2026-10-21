#!/usr/bin/env bash
# pi-wt-lite upstream sync.
#
# Usage:
#   ./sync.sh <path-to-extracted-pi-worktrunk-package-dir>
#     e.g. npm pack pi-worktrunk@x.y.z && tar xzf pi-worktrunk-x.y.z.tgz
#          ./sync.sh package
#
# What it does:
#   1. Verifies upstream/ matches HEAD (staged drift included — abort otherwise; patch fully applied).
#   2. Validates the extracted package (all three payload files readable) and stages it in a
#      temp dir BEFORE touching upstream/, then replaces worktrunk.ts + package.json + LICENSE
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

# 1. upstream must match HEAD (diff against HEAD so staged changes count as drift too)
git -C "$HERE" diff --quiet HEAD -- upstream/ || {
  echo "ERROR: upstream/ has uncommitted local changes (staged or not); commit or stash first." >&2
  exit 1
}

# 2. stage + validate the replacement payload before touching upstream/
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
for name in worktrunk.ts package.json LICENSE; do
  [ -r "$SRC/$name" ] || { echo "ERROR: $SRC/$name missing/unreadable; incomplete extracted package." >&2; exit 1; }
  cp -a "$SRC/$name" "$STAGE/$name"
done
rm -f "$UP/worktrunk.ts" "$UP/package.json" "$UP/LICENSE"
cp -a "$STAGE/worktrunk.ts" "$STAGE/package.json" "$STAGE/LICENSE" "$UP/"

# 3. replay the patch; fail loudly on conflict
TOP="$(git -C "$HERE" rev-parse --show-toplevel)"
PREFIX="$(git -C "$HERE" rev-parse --show-prefix)"
if git -C "$TOP" apply --directory="${PREFIX%/}" "$PATCH"; then
  echo "OK: upstream refreshed, lite.patch applied cleanly."
  echo "Next: bump version in package.json, update README source-version note, commit."
else
  echo "CONFLICT: lite.patch failed to apply. Upstream moved into patched regions." >&2
  echo "Resolve by hand in upstream/, then regenerate lite.patch against the pristine npm copy ($SRC)" >&2
  echo "— never against the repo index (it holds the already-patched tree; that baseline accumulates patches):" >&2
  echo "  diff -u --label a/upstream/worktrunk.ts --label b/upstream/worktrunk.ts \"$SRC/worktrunk.ts\" \"$UP/worktrunk.ts\"" >&2
  echo "  diff -u --label a/upstream/package.json --label b/upstream/package.json \"$SRC/package.json\" \"$UP/package.json\"" >&2
  exit 1
fi
