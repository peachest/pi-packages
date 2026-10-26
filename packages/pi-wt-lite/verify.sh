#!/usr/bin/env bash
# pi-wt-lite verify: prove the vendored artifact is reproducible from the npm release.
# Chain: npm pristine -> apply lite.patch -> byte-compare vs upstream/ -> behavior test.
# Run after every sync.sh / upstream upgrade. Any failure exits 1 naming the step.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
UP="$HERE/upstream"
PATCH="$HERE/lite.patch"

# 1. pristine baseline: pack the exact vendored version into a clean temp dir
VER="$(node -p "require('$UP/package.json').version")"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "[1/4] npm pack pi-worktrunk@$VER -> pristine"
npm pack "pi-worktrunk@$VER" --pack-destination "$TMP" >/dev/null
tar xzf "$TMP/pi-worktrunk-$VER.tgz" -C "$TMP"
mv "$TMP/package" "$TMP/upstream"  # dir name matters: -p1 resolves patch targets to upstream/*

# 2. replay lite.patch against the pristine copy
echo "[2/4] apply lite.patch"
patch --directory "$TMP" -p1 --forward < "$PATCH" >/dev/null \
  || { echo "ERROR: step 2: lite.patch does not apply to pristine pi-worktrunk@$VER; regenerate it" >&2; exit 1; }

# 3. patched pristine must equal upstream/ byte-for-byte
echo "[3/4] cmp patched pristine vs upstream/"
for name in worktrunk.ts package.json LICENSE; do
  cmp -s "$TMP/upstream/$name" "$UP/$name" \
    || { echo "ERROR: step 3: $name differs — upstream/ drifted from pristine+patch (hand edit or stale patch)" >&2; exit 1; }
done

# 4. behavior assertion on the vendored (patched) source
echo "[4/4] node tests/remove-self-guard.test.mjs"
node "$HERE/tests/remove-self-guard.test.mjs" \
  || { echo "ERROR: step 4: behavior test failed" >&2; exit 1; }

echo "verified: pristine+patch==upstream, behavior green"
