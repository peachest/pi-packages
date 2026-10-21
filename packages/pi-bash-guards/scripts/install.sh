#!/usr/bin/env bash
# Sync the packaged guard script into the live kendex hooks directory and
# verify the registry still points at it. Run from anywhere:
#   bash <pkg>/scripts/install.sh   (or `npm run sync` inside the package)
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$PKG_DIR/scripts/bash-guards.sh"
DST="${HOME}/.pi/agent/kendex/hooks/bash-guards.sh"
REG="${HOME}/.pi/agent/kendex/hooks.json"

[ -f "$SRC" ] || { echo "FAIL: source missing: $SRC" >&2; exit 1; }
mkdir -p "$(dirname "$DST")"
cp "$SRC" "$DST"
chmod +x "$DST"

# Registry check: hooks.json must reference the guard path (install does NOT
# write hooks.json — it is created once by pi-hooks; we only verify it).
if [ -f "$REG" ] && grep -q "kendex/hooks/bash-guards.sh" "$REG"; then
  echo "hooks.json: registry entry present ✓"
else
  echo "WARN: $REG missing or does not reference bash-guards.sh." >&2
  echo "      If guards never fire, register a tool_call listener (matcher \"Bash\", command \"bash $DST\", timeout 10) in pi-hooks." >&2
fi

# Byte-identical verification
if diff -q "$SRC" "$DST" >/dev/null; then
  echo "sync ✓ $DST (byte-identical)"
else
  echo "FAIL: diff after copy — abort" >&2
  exit 1
fi
