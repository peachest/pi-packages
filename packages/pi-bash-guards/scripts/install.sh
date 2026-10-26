#!/usr/bin/env bash
# Sync the packaged guard engine into the live kendex hooks directory and
# verify the registry still points at it. Run from anywhere:
#   bash <pkg>/scripts/install.sh   (or `npm run sync` inside the package)
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$PKG_DIR/scripts/bash-guards.py"
DST="${HOME}/.pi/agent/kendex/hooks/bash-guards.py"
WH_SRC="$PKG_DIR/scripts/write-home-guard.py"
WH_DST="${HOME}/.pi/agent/kendex/hooks/write-home-guard.py"
REG="${HOME}/.pi/agent/kendex/hooks.json"

[ -f "$SRC" ] || { echo "FAIL: source missing: $SRC" >&2; exit 1; }
mkdir -p "$(dirname "$DST")"
# Atomic replace: a concurrent tool_call reader must never observe a
# truncated hook payload (fail-open), so stage to a temp file in the same
# directory and mv(2) rename it into place.
TMP="$DST.tmp.$$"
trap 'rm -f "$TMP"' EXIT
cp "$SRC" "$TMP"
chmod +x "$TMP"
mv "$TMP" "$DST"
trap - EXIT

# Companion guard: Write/Edit target-path sanity (ticket R3, 2026-10-26).
# Same atomic-copy pattern; hooks.json registration is manual (see README).
WHTMP="$WH_DST.tmp.$$"
trap 'rm -f "$WHTMP"' EXIT
cp "$WH_SRC" "$WHTMP"
chmod +x "$WHTMP"
mv "$WHTMP" "$WH_DST"
trap - EXIT
echo "sync ✓ $WH_DST (byte-identical: $(cmp -s "$WH_SRC" "$WH_DST" && echo yes || echo NO))"

# Registry check: hooks.json must reference the guard path (install does NOT
# write hooks.json — it is created once by pi-hooks; we only verify it).
# Parsed as JSON, not substring grep: a stale/commented/disabled mention must
# not count — an active tool_call listener with a Bash matcher must carry
# this exact script path in its command. A second listener with matcher
# "subagent" routes the pi-subagents SA1-SA4 guards; its absence is a WARN
# (bash guards work without it, the SA rules are silently off).
if [ -f "$REG" ] && python3 -c '
import json, sys
reg, dst = sys.argv[1], sys.argv[2]
try:
    with open(reg, encoding="utf-8") as f:
        data = json.load(f)
except Exception:
    sys.exit(1)
listeners = (data.get("hooks") or {}).get("tool_call") or []
has_bash = has_subagent = False
for m in listeners:
    matcher = str(m.get("matcher", ""))
    hit = any(dst in str(h.get("command", "")) for h in m.get("hooks") or [])
    if "Bash" in matcher and hit:
        has_bash = True
    if "subagent" in matcher and hit:
        has_subagent = True
sys.exit(0 if has_bash else 1)
' "$REG" "$DST"; then
  echo "hooks.json: registry entry present ✓"
else
  echo "WARN: $REG missing, invalid, or has no active Bash-matcher hook referencing bash-guards.py." >&2
  echo "      If guards never fire, register a tool_call listener (matcher \"Bash\", command \"/usr/bin/python3 $DST\", timeout 10) in pi-hooks." >&2
fi

# SA-route check: subagent matcher entry (WARN only — see comment above).
if [ -f "$REG" ] && python3 -c '
import json, sys
reg, dst = sys.argv[1], sys.argv[2]
try:
    with open(reg, encoding="utf-8") as f:
        data = json.load(f)
except Exception:
    sys.exit(1)
for m in (data.get("hooks") or {}).get("tool_call") or []:
    if "subagent" not in str(m.get("matcher", "")):
        continue
    if any(dst in str(h.get("command", "")) for h in m.get("hooks") or []):
        sys.exit(0)
sys.exit(1)
' "$REG" "$DST"; then
  echo "hooks.json: subagent (SA1-SA4) route present ✓"
else
  echo "WARN: $REG has no active subagent-matcher hook referencing bash-guards.py — SA1-SA4 guards are silently off." >&2
  echo "      Register a second tool_call listener (matcher \"subagent\", command \"/usr/bin/python3 $DST\", timeout 10) in pi-hooks." >&2
fi

# Byte-identical verification
if diff -q "$SRC" "$DST" >/dev/null; then
  echo "sync ✓ $DST (byte-identical)"
else
  echo "FAIL: diff after copy — abort" >&2
  exit 1
fi
