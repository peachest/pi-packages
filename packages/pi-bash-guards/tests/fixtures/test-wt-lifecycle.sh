#!/usr/bin/env bash
# Fixture suite C — worktree lifecycle guards R1-R4 (#138, spec #137).
# Pattern follows suite A (test-bash-guards.sh): table-driven, self-reporting
# PASS/FAIL summary, exit non-zero on any failure. GUARD env points at the
# guard under test (vitest injects the packaged source).
#
# Covers (issue #138):
#   R1  raw `git worktree remove/prune` -> wt remove
#       (incidents: MR !688 HAMi cleanup; 2026-10-21 fix-eda-scan-fixes —
#        bash deleted its own cwd, spawn ENOENT, session stuck 2h)
#   R2  raw `git merge` (non --ff-only) -> wt merge / git pull --ff-only;
#       git pull family fully allowed
#   R3  cross-branch `git checkout <branch>` / `git switch <branch>` inside a
#       LINKED worktree (.git is a file) -> wt switch; main checkout (.git is
#       a dir) never touched; file restores and -b/-c creation allowed
#   R4  `wt merge -y/--yes` -> block (merge approval is the user's decision)
#   override channel: `# guard-override:` marker comment -> allow + stderr
#   audit warning
#   rtk prefix penetration for every rule
#   heredoc-body literal regression: document text quoting the guarded
#   command literals must NOT block (spec #137 was false-blocked twice by
#   full-text matching during its own creation)
set -u
GUARD="${GUARD:-$HOME/.pi/agent/kendex/hooks/bash-guards.sh}"
PASS=0; FAIL=0

PROJ="$HOME/.pi/agent/sessions/--mnt-disk1-hyx-projects--/2026-10-21T00-00-00-000Z_c.jsonl"

json_for() {
  python3 -c "
import json,sys
print(json.dumps({'tool_input':{'command':sys.argv[1]},'transcript_path':sys.argv[2],'session_id':'test'}))" "$1" "$2"
}

# All three helpers take an optional 5th cwd arg (suite B's t() pattern):
# the cd happens inside the command-substitution subshell so PASS/FAIL stay
# in this shell — R3's boundary cases need a real main-checkout vs linked-
# worktree cwd, and counting them from a `( cd … && expect … )` subshell
# would silently drop them from the self-report.

# expect <exit> <label> <transcript_path> <command> [cwd]
expect() {
  local want="$1" label="$2" tp="$3" cmd="$4" dir="${5:-.}"
  local out rc
  out=$(json_for "$cmd" "$tp" | (cd "$dir" && bash "$GUARD") 2>&1)
  rc=$?
  if [ "$rc" = "$want" ]; then
    PASS=$((PASS+1)); echo "PASS  $label"
  else
    FAIL=$((FAIL+1)); echo "FAIL  $label (want=$want got=$rc)"; echo "      out: ${out:0:160}"
  fi
}

# expect_msg <label> <output-pattern> <transcript_path> <command> [cwd]
# blocked (exit 2) AND the message names the correct replacement command
# (acceptance: reason + correct command + example in every block message).
expect_msg() {
  local label="$1" pattern="$2" tp="$3" cmd="$4" dir="${5:-.}"
  local out rc
  out=$(json_for "$cmd" "$tp" | (cd "$dir" && bash "$GUARD") 2>&1)
  rc=$?
  if [ "$rc" = 2 ] && printf '%s' "$out" | grep -q -- "$pattern"; then
    PASS=$((PASS+1)); echo "PASS  $label"
  else
    FAIL=$((FAIL+1)); echo "FAIL  $label (rc=$rc pattern='$pattern')"; echo "      out: ${out:0:160}"
  fi
}

# expect_out <label> <exit> <output-pattern> <transcript_path> <command> [cwd]
# arbitrary exit code with a required marker in combined output (stderr trail).
expect_out() {
  local label="$1" want="$2" pattern="$3" tp="$4" cmd="$5" dir="${6:-.}"
  local out rc
  out=$(json_for "$cmd" "$tp" | (cd "$dir" && bash "$GUARD") 2>&1)
  rc=$?
  if [ "$rc" = "$want" ] && printf '%s' "$out" | grep -q -- "$pattern"; then
    PASS=$((PASS+1)); echo "PASS  $label"
  else
    FAIL=$((FAIL+1)); echo "FAIL  $label (want=$want got=$rc pattern='$pattern')"; echo "      out: ${out:0:160}"
  fi
}

# ---- real git fixtures: main checkout (.git dir) + linked worktree (.git file)
FX="$HOME/tmp/guardc-fixtures"
rm -rf "$FX"; mkdir -p "$FX"
MAIN="$FX/main-repo"
git init -q "$MAIN"
git -C "$MAIN" config user.email guardc@example.com
git -C "$MAIN" config user.name guardc
echo readme > "$MAIN/README.md"
git -C "$MAIN" add README.md
git -C "$MAIN" commit -qm init
git -C "$MAIN" worktree add -q "$FX/linked-wt" -b side
echo wt > "$FX/linked-wt/WT.md"
git -C "$FX/linked-wt" add WT.md
git -C "$FX/linked-wt" commit -qm wt-init
LINKED="$FX/linked-wt"

# P6 fixture repos (rolling-r1): known-platform repo with matching identity,
# plus an unknown-platform remote repo (platform not in the expected map).
P6GH="$FX/p6-gh"
git init -q "$P6GH"
git -C "$P6GH" config user.email 1938913473@qq.com
git -C "$P6GH" remote add origin https://github.com/peachest/pi-packages.git
P6UNK="$FX/p6-unknown"
git init -q "$P6UNK"
git -C "$P6UNK" config user.email guardc@example.com
git -C "$P6UNK" remote add origin https://gitlab.internal/team/repo.git

echo "== R1 worktree remove/prune (first-token anchored) =="
expect 0 "worktree list allowed"                "$PROJ" "git worktree list"
expect 0 "mid-line literal in echo allowed"     "$PROJ" "echo 'use wt remove, not git worktree remove'"
expect 2 "worktree remove blocked"              "$PROJ" "git worktree remove ../pi-mypackage-feat-old"
expect 2 "worktree prune blocked"               "$PROJ" "git worktree prune"
expect 2 "worktree remove --force blocked"      "$PROJ" "git worktree remove --force ../x"
expect 2 "rtk-prefixed prune blocked"           "$PROJ" "rtk git worktree prune"
expect_msg "remove msg points to wt remove"     "wt remove" "$PROJ" "git worktree remove ../x"

echo "== R2 raw merge (pull family + --ff-only allowed) =="
expect 0 "git pull allowed"                     "$PROJ" "git pull"
expect 0 "pull --ff-only allowed"               "$PROJ" "git pull --ff-only origin main"
expect 0 "merge --ff-only allowed"              "$PROJ" "git merge --ff-only origin/main"
expect 0 "merge --abort allowed (rescue)"       "$PROJ" "git merge --abort"
expect 2 "raw merge blocked"                    "$PROJ" "git merge origin/feat/wt-guardrails"
expect 2 "merge --no-ff blocked"                "$PROJ" "git merge --no-ff feat/x"
expect 2 "chained merge segment blocked"        "$PROJ" "git fetch origin && git merge origin/main"
expect 2 "rtk-prefixed merge blocked"           "$PROJ" "rtk git merge feat/x"
expect_msg "merge msg points to wt merge / pull --ff-only" "pull --ff-only" "$PROJ" "git merge origin/main"

echo "== R3 cross-branch in linked worktree (.git is a file) =="
expect 2 "checkout branch blocked"            "$PROJ" "git checkout main" "$LINKED"
expect 2 "switch branch blocked"              "$PROJ" "git switch main" "$LINKED"
expect 2 "checkout -f branch blocked"         "$PROJ" "git checkout -f main" "$LINKED"
expect 2 "checkout detached rev blocked"      "$PROJ" "git checkout origin/main" "$LINKED"
expect 0 "checkout -- file allowed"           "$PROJ" "git checkout -- README.md" "$LINKED"
expect 0 "checkout existing path allowed"     "$PROJ" "git checkout README.md" "$LINKED"
expect 0 "checkout -b allowed"                "$PROJ" "git checkout -b nb2" "$LINKED"
expect 0 "switch -c allowed"                  "$PROJ" "git switch -c nb3" "$LINKED"
expect 0 "checkout rev -- path allowed"       "$PROJ" "git checkout origin/main -- README.md" "$LINKED"
expect_msg "r3 msg points to wt switch" "wt switch" "$PROJ" "git checkout main" "$LINKED"

echo "== R3 boundary: main checkout (.git is a dir) never blocked =="
expect 0 "main checkout branch allowed"       "$PROJ" "git checkout main" "$MAIN"
expect 0 "main checkout switch allowed"       "$PROJ" "git switch side" "$MAIN"

echo "== R3 cd/subshell resolution (rolling-r1 L191) =="
# Hook cwd = MAIN (the incident shape: session sits in a main checkout); the
# checkout targets the linked worktree through a cd the guard must follow.
expect 2 "subshell cd into linked wt blocked"  "$PROJ" "(cd $LINKED && git checkout main)" "$MAIN"
expect 2 "plain cd into linked wt blocked"     "$PROJ" "cd $LINKED && git checkout main" "$MAIN"
expect 2 "multi-line cd into linked wt blocked" "$PROJ" "cd $LINKED
git checkout main" "$MAIN"
expect 0 "subshell cd into main checkout allowed" "$PROJ" "(cd $MAIN && git checkout main)" "$MAIN"
expect 0 "subshell pop restores outer cwd"     "$PROJ" "(cd $LINKED && git status); git checkout main" "$MAIN"
expect 0 "file restore via subshell cd allowed" "$PROJ" "(cd $LINKED && git checkout -- README.md)" "$MAIN"

echo "== R4 wt merge approval flag =="
expect 2 "wt merge -y blocked"                  "$PROJ" "wt merge -y"
expect 2 "wt merge --yes blocked"               "$PROJ" "wt merge --yes"
expect 2 "rtk wt merge -y blocked"              "$PROJ" "rtk wt merge -y"
expect 0 "wt merge plain allowed"               "$PROJ" "wt merge"
expect 0 "wt merge --no-remove allowed"         "$PROJ" "wt merge --no-remove"
expect_msg "r4 msg names the approval rule"     "approval" "$PROJ" "wt merge -y"

echo "== override channel (# guard-override: marker) =="
expect 0 "override marker allows worktree remove" "$PROJ" "git worktree remove ../x # guard-override: rescue"
expect 0 "override marker allows wt merge -y"   "$PROJ" "wt merge -y # guard-override: user pre-approved"
expect 0 "override marker on own line allows"   "$PROJ" "# guard-override: deliberate cleanup
git worktree prune"
expect_out "override leaves stderr audit trail" 0 "guard-override" "$PROJ" "git worktree prune # guard-override: x"

echo "== heredoc body literals must not trip R1/R2 (spec #137 creation incident) =="
DOC=$(cat <<'FEOF'
gh issue create --title wt-guard-spec --body "$(cat <<'EOF'
## R1 删树/剪枝
- `git worktree` 的 remove/prune 子命令 → 指向 `wt remove`
- raw `git merge` → 指向 wt merge 或 git pull --ff-only
文档代码块示例（非命令）:
git worktree remove ../demo
git merge origin/main --no-ff
EOF
)"
FEOF
)
expect 0 "heredoc doc body not blocked"         "$PROJ" "$DOC"

echo "== P6 unknown remote platform (rolling-r1) =="
expect 0 "unknown platform remote: commit allowed"   "$PROJ" "git commit -m x" "$P6UNK"
expect 2 "no-remote default identity still enforced" "$PROJ" "git commit -m x" "$MAIN"
expect 0 "email literal in -m message not an identity" "$PROJ" "git commit -m 'docs: see user.email=someone@example.com note'" "$P6GH"
expect 2 "inline -c stranger still blocked"          "$PROJ" "git -c user.email=wrong@evil.com commit -m x" "$P6GH"
expect 0 "inline -c matching identity allowed"        "$PROJ" "git -c user.email=1938913473@qq.com commit -m x" "$P6GH"

echo "== G1 hand-copy destination parsing (rolling-r1) =="
expect 2 "cp -t into extensions blocked"       "$PROJ" "cp -t ~/.pi/agent/extensions x"
expect 2 "cp --target-directory= into skills blocked" "$PROJ" "cp --target-directory=~/.agents/skills x"
expect 0 "cp -t to tmp allowed"                "$PROJ" "cp -t ~/tmp x"
expect 0 "cp -t FROM skills into tmp allowed (reads)" "$PROJ" "cp -t ~/tmp ~/.agents/skills/hook-me/SKILL.md"
expect 2 "cp via $HOME var into extensions blocked"   "$PROJ" "cp x \"\$HOME/.pi/agent/extensions/\""
expect 2 "cp via unresolvable var dest blocked"       "$PROJ" "cp x \"\$PI_EXTENSIONS\""
expect 2 "cp quoted-tilde dest into skills blocked"   "$PROJ" "cp x \"~/.agents/skills/y\""
expect 0 "cp var dest to tmp allowed"                 "$PROJ" "cp x \"\$HOME/tmp/notes\""

echo "== guard-2 segment hardening (rolling-r1) =="
D=dock; D=${D}er  # literal spelled obliquely so this fixture file never trips other guards
expect 2 "docker hidden behind ssh segment blocked"  "$PROJ" "ssh host true; ${D} rm x"
expect 2 "docker hidden behind scp && blocked"       "$PROJ" "scp f host:x && ${D} ps"
expect 0 "remote docker arg still allowed"           "$PROJ" "ssh host '${D} ps'"
expect 2 "if-wrapped container cmd blocked"          "$PROJ" "if ${D} ps; then echo ok; fi"
expect 2 "while-wrapped container cmd blocked"       "$PROJ" "while ${D} ps; do :; done"
expect 2 "negated container cmd blocked"             "$PROJ" "! ${D} ps"
expect 2 "brace-group container cmd blocked"          "$PROJ" "{ ${D} ps; }"
expect 0 "if with probe cmd allowed"                  "$PROJ" "if grep -q x /f; then echo ok; fi"
expect 2 "env-wrapped raw merge blocked"               "$PROJ" "env git merge origin/main"
expect 2 "env-wrapped container cmd blocked"          "$PROJ" "env ${D} run x"
expect 2 "nohup-wrapped container cmd blocked"        "$PROJ" "nohup ${D} ps"
expect 2 "command-wrapped container cmd blocked"      "$PROJ" "command ${D} ps"
expect 0 "command -v probe still allowed"             "$PROJ" "command -v ${D}"
expect 2 "if-wrapped raw merge blocked"               "$PROJ" "if true; then git merge origin/main; fi"

echo "== quoted punctuation is argument text, not a command boundary (rolling-r2 L165) =="
expect 0 "quoted ; literal is not a merge command"    "$PROJ" "printf '%s\\n' 'example; git merge topic'"
expect 0 "quoted ; literal is not a container cmd"    "$PROJ" "printf '%s\\n' 'example; ${D} ps'"
expect 0 "quoted && literal is not a container cmd"   "$PROJ" "printf '%s\\n' 'a && ${D} ps'"
expect 0 "quoted remote cmd with ; still allowed"     "$PROJ" "ssh host 'true; ${D} ps'"
expect 2 "genuine chained merge still blocked"        "$PROJ" "echo start; git merge origin/main"

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
