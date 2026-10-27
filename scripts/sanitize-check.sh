#!/usr/bin/env bash
# Sanitize gate for the public pi-packages repo (setup-gitleaks skill shape).
#
# Two layers: (1) pattern grep for internal identifiers, (2) gitleaks for
# credentials/identifiers per gitleaks.toml. "gitleaks 通过 ≠ 脱敏完成" —
# layer 1 exists because gitleaks can't judge bare project/node names.
# Exit 0 = clean, 1 = findings.
#
# Usage:
#   bash scripts/sanitize-check.sh              # tracked files (committed state)
#   bash scripts/sanitize-check.sh -u           # untracked + modified (pre-commit batch)
#   bash scripts/sanitize-check.sh <paths...>   # explicit files/dirs
#
# New internal identifier surfaced in review → append to PATTERNS below.
# Placeholder allowlist (must never match): gitlab.blue.example,
# gitlab.red.example, harbor.example.com, internal.example.com, 203.0.113.x.
set -uo pipefail

GITLEAKS_CONFIG="${GITLEAKS_CONFIG:-$PWD/gitleaks.toml}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# grep -E pattern. Word-bounded where the token is also a common substring.
PATTERNS='transwarp|gitblue(?!\.example)|harbor\.trans|harborblue|harbor\.example|\bapplied-ai\b|\bnodexpu\b|NodeXpu|kube-nodexpu|yuxi\.hou|\bllm1[0-9]\b|\bllm(2[0-9]|3[0-9])\b|\bdev(17|32|119)\b|172\.1[6-9]\.|\bbase-charts\b|ppu-device|ppu-device-plugin|\bdflash\b|\bllmops\b|\bmlops\b|\bmwh\b|\bapplet\b|\bkgpu\b|\bhamife\b'

mode="tracked"
if [[ "${1:-}" == "-u" ]]; then mode="untracked"; shift; fi

if [[ $# -gt 0 ]]; then
    mapfile -t files < <(find "$@" -type f 2>/dev/null)
elif [[ "$mode" == "untracked" ]]; then
    mapfile -t files < <(git status --porcelain -uall | cut -c4-)
else
    mapfile -t files < <(git ls-files)
fi

rc=0

# Exempt paths（用户拍板的豁免类，2026-10-27）：词表自引用 / vendored 上游产物 /
# 身份矩阵测试 fixture（词是测试对象非泄漏）。llmops-wiki 引用不在豁免列——
# 正在去引用（票面见 .scratch/180-llmops-wiki-deref/）。
EXEMPT_RE='^(scripts/sanitize-check\.sh|gitleaks\.toml|packages/[^/]+/upstream/|packages/pi-bash-guards/tests/fixtures/|packages/pi-bash-guards/tests/golden/)'

# Layer 1: manual-checklist patterns
echo "== pattern scan (${#files[@]} files, mode=$mode) =="
hits=0
for f in "${files[@]}"; do
    [[ "$f" =~ $EXEMPT_RE ]] && continue   # self-rules / vendored / identity-matrix fixtures（见 EXEMPT_RE 注释）
    while IFS= read -r line; do
        echo "PATTERN  $line"
        hits=$((hits+1))
    done < <(grep -nPH "$PATTERNS" -- "$f" 2>/dev/null)
done
[[ $hits -gt 0 ]] && rc=1
echo "pattern findings: $hits"

# Layer 2: gitleaks (credentials + internal identifiers) — full-repo scan,
# findings filtered to selected targets (vendored/cache noise lives in the
# gitleaks.toml allowlist instead of here).
echo "== gitleaks scan =="
if [[ -f "$GITLEAKS_CONFIG" ]] && command -v gitleaks >/dev/null 2>&1; then
    report=$(mktemp)
    if gitleaks dir . --config "$GITLEAKS_CONFIG" --report-format json --report-path "$report" >/dev/null 2>&1; then
        echo "gitleaks findings: 0"
    else
        out=$(python3 -c "
import json
finds = json.load(open('$report'))
targets = set('''${files[*]}'''.split())
mine = [f for f in finds if f['File'] in targets]
for f in mine: print(f\"GITLEAKS {f['File']}:{f['StartLine']} {f['RuleID']}\")
print('FINDINGS ' + str(len(mine)))")
        echo "$out" | grep -v '^FINDINGS'
        n=$(echo "$out" | grep '^FINDINGS' | cut -d' ' -f2)
        [[ "$n" != "0" ]] && rc=1
    fi
    rm -f "$report"
else
    echo "WARN: gitleaks or config missing ($GITLEAKS_CONFIG) — credential layer skipped" >&2
fi

echo "== result: $([[ $rc -eq 0 ]] && echo CLEAN || echo DIRTY) =="
exit $rc
