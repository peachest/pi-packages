#!/usr/bin/env bash
# Check ~/.pi/agent/settings.json package sources for stale worktree deps.
# A package installed from a wt worktree (`packages/pi-xxx-feat-...`) breaks
# silently when the worktree is recycled — same failure family as the
# 2026-10-15 settings-skills drift. Also flags sources whose resolved path
# no longer exists.
# Part of `npm run check` (root package.json).
set -u
SETTINGS="${HOME}/.pi/agent/settings.json"
[ -f "$SETTINGS" ] || { echo "check-pi-settings: no settings file, nothing to check"; exit 0; }
python3 - "$SETTINGS" <<'PY'
import json, os, sys

settings = json.load(open(sys.argv[1]))
fail = 0
for pkg in settings.get("packages", []):
    src = pkg if isinstance(pkg, str) else pkg.get("source", "")
    if not src or src.startswith(("npm:", "git:", "http:", "https:")):
        continue
    resolved = os.path.normpath(os.path.join(os.path.dirname(sys.argv[1]), src)) \
        if src.startswith(".") else os.path.expanduser(src)
    parts = src.replace("\\", "/").split("/")
    stale = any(seg.startswith(("feat-", "fix-", "chore-", "ticket-")) and
                os.path.isdir(os.path.expanduser("~/projects/pi-mypackage")) is not None
                for seg in parts) or any("-feat-" in seg or "-fix-" in seg for seg in parts)
    if not os.path.exists(resolved):
        print(f"FAIL missing path: {src} (resolved {resolved}) — reinstall from main checkout or remove")
        fail = 1
    elif stale:
        print(f"FAIL worktree dep: {src} — the worktree can be recycled; reinstall from the main checkout path")
        fail = 1
sys.exit(fail)
PY
