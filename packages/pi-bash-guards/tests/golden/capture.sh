#!/usr/bin/env bash
# Golden verdict capture (spec #142 step 1 / step 3 acceptance tool).
#
# Runs EVERY payload the fixture suites exercise — plus a bypass-boundary
# section below — through the engine given as $1, recording one JSON line per
# guard invocation: {"payload", "exit", "stdout", "stderr"}. The engine is
# reached through a recording wrapper that reproduces the verdict
# byte-for-byte, so the fixture suites run UNMODIFIED (GUARD env still points
# at a bash-executable file) while every verdict is logged.
#
# Usage:   bash tests/golden/capture.sh <engine-file> <out.jsonl>
# Compare: diff the old-engine archive against a fresh capture — a non-empty
# diff is a semantic drift and blocks the migration (spec #142 step 3).
#
# Determinism contract (both captures must be byte-identical):
#   - sandbox HOME is a FIXED path (/tmp/bash-guards-golden), recreated each
#     run, because suite C and the bypass section embed sandbox paths in
#     payloads;
#   - global git identity matches the vitest beforeAll setup;
#   - flock serializes concurrent captures (a second run would share the
#     fixed sandbox and /tmp/p6.json).
set -euo pipefail

REAL="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
OUT="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURES="$HERE/../fixtures"

exec 9>/tmp/bash-guards-golden.lock
flock 9

HOME_SBOX=/tmp/bash-guards-golden/home
rm -rf /tmp/bash-guards-golden
mkdir -p "$HOME_SBOX/tmp" \
	"$HOME_SBOX/.pi/agent/sessions/--mnt-disk1-hyx-projects--" \
	"$HOME_SBOX/.pi/agent/sessions/--mnt-disk1-hyx-projects-pi-mypackage--" \
	"$HOME_SBOX/.pi/agent/sessions/--mnt-disk1-hyx-skills--"
# Suite C's boundary worktree must live at ~/projects/<repo>-<slug> relative
# to the HOME the ENGINE sees (#153 layout exemption) — sandbox it so fixture
# trees never touch the real node (the header contract promised this already).
export HOME="$HOME_SBOX"

# Hermetic git: no env leakage from the invoking shell — and no writes to the
# node's real global config (a capture once overwrote it; git config --global
# is never acceptable inside a test harness). A sandbox gitconfig stands in.
GIT_CONFIG_GLOBAL="$HOME_SBOX/gitconfig"
GIT_CONFIG_SYSTEM=/dev/null
export GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM
git config --file "$GIT_CONFIG_GLOBAL" user.email dev@corp.example
git config --file "$GIT_CONFIG_GLOBAL" user.name test
git config --file "$GIT_CONFIG_GLOBAL" --add safe.directory '*'

rm -f "$OUT"

# ---- recording wrapper: fixtures exec it as $GUARD -------------------------
WRAPPER=/tmp/bash-guards-golden/golden-wrapper.sh
cat > "$WRAPPER" <<'WEOF'
#!/usr/bin/env bash
payload=$(cat)
err=$(mktemp)
ec=0
out=$(bash "$GUARD_REAL" <<<"$payload" 2>"$err") || ec=$?
GOLDEN_PAYLOAD="$payload" GOLDEN_EXIT="$ec" GOLDEN_ERR="$err" GOLDEN_STDOUT="$out" \
python3 -c '
import json, os
rec = {"payload": os.environ["GOLDEN_PAYLOAD"], "exit": int(os.environ["GOLDEN_EXIT"]),
       "stdout": os.environ["GOLDEN_STDOUT"],
       "stderr": open(os.environ["GOLDEN_ERR"], encoding="utf-8").read()}
with open(os.environ["GOLDEN_LOG"], "a", encoding="utf-8") as f:
    f.write(json.dumps(rec, ensure_ascii=False) + "\n")'
printf '%s' "$out"
cat "$err" >&2
rm -f "$err"
exit $ec
WEOF
chmod +x "$WRAPPER"
# Deterministic identity: the engine's conf is env-overridable; point every
# suite run at a sandbox conf so ambient node config can't leak into verdicts.
IDENT_SBOX="$HOME_SBOX/bash-guards-identity.conf"
cat > "$IDENT_SBOX" <<IDCONF
gitblue.example=dev@corp.example
gitlab.example=dev@corp.example
github=dev@personal.example
DEFAULT_EMAIL=dev@corp.example
IDCONF
export BASH_GUARDS_IDENTITY_CONF="$IDENT_SBOX"
export GUARD="$WRAPPER" GUARD_REAL="$REAL" GOLDEN_LOG="$OUT"

# ---- 1-3. the three fixture suites, unmodified ------------------------------
# Suite A's P6 cases probe the CURRENT repo's git config — run them from a
# sandbox repo with the placeholder identity so ambient checkouts never leak.
SUITE_A_REPO="$HOME_SBOX/suite-a-repo"
git init -q "$SUITE_A_REPO" 2>/dev/null
git -C "$SUITE_A_REPO" remote add origin https://github.com/x/y 2>/dev/null || true
git -C "$SUITE_A_REPO" config user.email dev@personal.example
( cd "$SUITE_A_REPO" && bash "$FIXTURES/test-bash-guards.sh" >/dev/null )
( cd "$SUITE_A_REPO" && bash "$FIXTURES/test-p6-multiremote.sh" >/dev/null )
( cd "$SUITE_A_REPO" && bash "$FIXTURES/test-wt-lifecycle.sh" >/dev/null )

# ---- 4. bypass-boundary payloads (r1/r2/r3/debt edges) ----------------------
# Capture-only: the old engine is the oracle here, the golden diff is the
# assertion. cwd contexts use real git fixtures built fresh below.
BP="$HOME_SBOX/tmp/golden-bp"
rm -rf "$BP"; mkdir -p "$BP"
MAIN="$BP/main-repo"
git init -q "$MAIN"
git -C "$MAIN" config user.email guardc@example.com
git -C "$MAIN" config user.name guardc
echo readme > "$MAIN/README.md"
git -C "$MAIN" add README.md
git -C "$MAIN" commit -qm init
mkdir -p "$HOME_SBOX/projects"
# R3 enforces only wt-layout trees (~/projects/<repo>-<slug>, #153): the
# boundary worktree must sit in that layout for the blocked payloads below.
git -C "$MAIN" worktree add -q "$HOME_SBOX/projects/golden-main-side" -b side
mkdir -p "$HOME_SBOX/projects/golden-main-side/sub"
LINKED="$HOME_SBOX/projects/golden-main-side"
P6B="$BP/p6-noremote"   # no remotes -> default identity is the only match
git init -q "$P6B"
git -C "$P6B" config user.email stranger@example.com
P6GH="$BP/p6-gh"        # github platform, matching repo-local identity
git init -q "$P6GH"
git -C "$P6GH" config user.email dev@personal.example
git -C "$P6GH" remote add origin https://github.com/peachest/pi-packages.git
P6UNK="$BP/p6-unknown"  # unknown platform -> fail-open
git init -q "$P6UNK"
git -C "$P6UNK" config user.email guardc@example.com
git -C "$P6UNK" remote add origin https://gitlab.internal/team/repo.git

BP_TP="$HOME_SBOX/.pi/agent/sessions/--mnt-disk1-hyx-projects--/2026-10-22T00-00-00-000Z_golden.jsonl"
bp() { # bp <cwd> <command> — projects slug, capture only (no assertion)
	local dir="$1" cmd="$2" payload
	payload=$(python3 -c "
import json,sys
print(json.dumps({'tool_input':{'command':sys.argv[1]},'transcript_path':sys.argv[2],'session_id':'golden'}))" "$cmd" "$BP_TP")
	printf '%s' "$payload" | (cd "$dir" && bash "$GUARD") >/dev/null 2>&1 || :
}

PFX=': __PI_SECRET_STORE__; if [ "/x.env" ]; then set -a; . "/x.env" 2>/dev/null; set +a; fi; '

# prefix penetration
bp "$HOME_SBOX" "rtk git merge origin/dev"
bp "$HOME_SBOX" "sudo git worktree prune"
bp "$HOME_SBOX" "${PFX}git merge origin/x"
bp "$HOME_SBOX" "${PFX}git worktree remove ../x"
# docker: command position, probes, ssh skip, and the heredoc-body behavior
# of the docker loop (it walks `code` lines — bodies are NOT exempt; locked
# here so the migration cannot silently change it either direction)
bp "$HOME_SBOX" "cat <<EOF
docker ps
EOF"
bp "$HOME_SBOX" "docker"
bp "$HOME_SBOX" "dockerize app"
bp "$HOME_SBOX" "sudo docker ps"
bp "$HOME_SBOX" "ssh host 'docker ps'"
bp "$HOME_SBOX" "echo docker ps"
bp "$HOME_SBOX" "which docker"
bp "$HOME_SBOX" "FOO=1 docker ps"
bp "$HOME_SBOX" "docker ps | grep x"
# bare cd
bp "$HOME_SBOX" "cd"
bp "$HOME_SBOX" "cd /x; ls"
bp "$HOME_SBOX" "cd /x
cd /y"
bp "$HOME_SBOX" "cd /x <<EOF
hello
EOF"
bp "$HOME_SBOX" "echo 'cd'"
# R2 merge discipline
bp "$HOME_SBOX" "git merge --ff-only origin/main"
bp "$HOME_SBOX" "git merge origin/main --ff-only"
bp "$HOME_SBOX" "git merge --quit"
bp "$HOME_SBOX" "git -C /tmp merge origin/y"
bp "$HOME_SBOX" "git pull --rebase origin dev"
bp "$HOME_SBOX" "echo 'git merge x'"
bp "$HOME_SBOX" "cat <<EOF
git merge x
EOF"
bp "$HOME_SBOX" "if true; then git merge x; fi"
bp "$HOME_SBOX" "git merge x && git merge y"
# guard-override marker is inert since #153 (channel removed): the dangerous
# commands below must now block on their own rule; the marker is just text.
bp "$HOME_SBOX" "git merge origin/x # guard-override: rescue"
bp "$HOME_SBOX" "echo '# guard-override: fake'"
bp "$HOME_SBOX" "git merge origin/x && echo '# guard-override: x'"
bp "$HOME_SBOX" "ls
git merge origin/x # guard-override: y"
bp "$HOME_SBOX" "cat <<EOF
# guard-override: x
EOF"
bp "$HOME_SBOX" "rtk git merge origin/x # guard-override: y"
# R1 / guard-3 debt asymmetry
bp "$HOME_SBOX" "echo 'use git worktree add here'"
bp "$HOME_SBOX" "git worktree move a b"
bp "$HOME_SBOX" "git worktree lock ../x"
# R3 linked-worktree boundary (real .git file/dir fixtures)
bp "$LINKED" "git checkout main"
bp "$LINKED" "git switch main"
bp "$LINKED" "git checkout -- README.md"
bp "$LINKED" "git checkout -b newbr"
bp "$LINKED" "git checkout main -- README.md"
bp "$LINKED/sub" "git checkout main"
bp "$MAIN" "git checkout main"
bp "$MAIN" "git -C $LINKED checkout main"
bp "$MAIN" "cd $LINKED && git checkout main"
bp "$LINKED" "rtk git checkout main"
bp "$LINKED" "(cd $MAIN && git checkout main)"
# R4 approval flag
bp "$HOME_SBOX" "wt merge -y"
bp "$HOME_SBOX" "wt merge --yes origin/x"
bp "$HOME_SBOX" "wt merge origin/x"
bp "$HOME_SBOX" "wt list"
# no-verify token discipline (push -n is dry-run; message ordering)
bp "$HOME_SBOX" "git commit --no-verify -m x"
bp "$HOME_SBOX" "git commit -n -m x"
bp "$HOME_SBOX" "git push --no-verify origin main"
bp "$HOME_SBOX" "git push -n origin main"
bp "$HOME_SBOX" "git push --no-verify && git commit --no-verify"
bp "$HOME_SBOX" "git commit -m 'x --no-verify'"
bp "$HOME_SBOX" "sudo git commit --no-verify"
# G1 destinations
bp "$HOME_SBOX" 'cp x $UNSET_VAR/y'
bp "$HOME_SBOX" "cp a b"
bp "$HOME_SBOX" "cp dist ~/.pi/agent/extensions/x/"
bp "$HOME_SBOX" "cp ~/.agents/skills/x/SKILL.md ~/tmp/"
bp "$HOME_SBOX" 'echo $FOO'
# P2/P3 full-text debt locks
bp "$HOME_SBOX" "echo 'run git add -A first'"
bp "$HOME_SBOX" "echo sleep 120"
bp "$HOME_SBOX" "sleep 59"
bp "$HOME_SBOX" "sleep 60"
bp "$HOME_SBOX" "sleep 0.5m"
bp "$HOME_SBOX" "sleep 1h"
# P6 identity edges
bp "$P6B" "git commit -m x"
bp "$P6B" "git -c user.email=dev@corp.example commit -m x"
bp "$P6GH" "git commit --no-verify -m x"
bp "$P6UNK" "git commit -m x"

echo "golden capture: $(wc -l < "$OUT") verdicts -> $OUT"
