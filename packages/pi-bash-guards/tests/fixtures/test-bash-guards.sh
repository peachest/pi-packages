#!/usr/bin/env bash
# Fixture tests for bash-guards.sh (extended 2026-10-20).
# Each case feeds a payload JSON on stdin; expectations are exit codes.
# 0 = allow, 2 = block.
set -u
GUARD="${GUARD:-$HOME/.pi/agent/kendex/hooks/bash-guards.sh}"
PASS=0; FAIL=0

# usage: expect <exit> <label> <transcript_path> <command>
expect() {
  local want="$1" label="$2" tp="$3" cmd="$4"
  local payload out rc
  payload=$(python3 -c "
import json,sys
print(json.dumps({'tool_input':{'command':sys.argv[1]},'transcript_path':sys.argv[2],'session_id':'test'}))" "$cmd" "$tp")
  out=$(printf '%s' "$payload" | bash "$GUARD" 2>&1)
  rc=$?
  if [ "$rc" = "$want" ]; then
    PASS=$((PASS+1)); echo "PASS  $label"
  else
    FAIL=$((FAIL+1)); echo "FAIL  $label (want=$want got=$rc)"; echo "      out: ${out:0:160}"
  fi
}

PROJ="$HOME/.pi/agent/sessions/--mnt-disk1-hyx-projects--/2026-10-20T00-00-00-000Z_test.jsonl"
PROJ_MYPKG="$HOME/.pi/agent/sessions/--mnt-disk1-hyx-projects-pi-mypackage--/2026-10-20T00-00-00-000Z_test.jsonl"
SKILL="$HOME/.pi/agent/sessions/--mnt-disk1-hyx-skills--/2026-10-20T00-00-00-000Z_test.jsonl"

echo "== layer gate =="
expect 0 "projects cwd, plain ls"              "$PROJ" "ls -la"
expect 0 "skills cwd, glpat literal (P1 not armed)" "$SKILL" "curl -H 'Authorization: Bearer glpat-AbCdEfGhIjKlMnOpQrStUv' https://gitblue.example/api"

echo "== original guards still work =="
expect 2 "docker blocked"                      "$PROJ" "docker ps"
expect 0 "sudo nerdctl allowed"                "$PROJ" "sudo nerdctl ps"
expect 2 "bare cd blocked"                     "$PROJ" "cd /mnt/disk1/hyx/projects"
expect 2 "worktree add blocked"                "$PROJ" "git worktree add ../x feat/x"
expect 0 "git commit --help evaluates identity without crash" "$PROJ" "git -c user.email=dev@personal.example commit --help | head -3"

echo "== P1 secrets (now owned by pi-secret-store; guard allows) =="
expect 0 "glpat literal blocked"               "$PROJ" "curl -H 'Authorization: Bearer glpat-AbCdEfGhIjKlMnOpQrStUv' https://gitblue.example/api"
expect 0 "glpat via \$VAR allowed"             "$PROJ" "curl -H \"Authorization: Bearer \$GLAB_TOKEN\" https://gitblue.example/api"
expect 0 "glpat dummy value allowed"           "$PROJ" "curl -H 'Authorization: Bearer glpat-dummydummydummydummydummy' https://x"
expect 0 "no token shape allowed"              "$PROJ" "glab mr view 123"
expect 0 "ghp_ blocked"                        "$PROJ" "git clone https://ghp_AbCdEfGhIjKlMnOpQrStUvwxYzAbCdEfGhIj@github.com/x/y"
expect 0 "sk- bare 20+ blocked (deepseek-style)" "$PROJ" "curl https://api.deepseek.com/v1 -H 'Authorization: Bearer sk-AbCdEfGhIjKlMnOpQrStUvwx'"
expect 0 "short sk- allowed (not a key)"       "$PROJ" "echo sk-short"
expect 0 "AIza blocked"                        "$PROJ" "curl 'https://maps.googleapis.com/maps/api/geocode/json?address=x&key=AIzaSyA1234567890abcdefghijklmnopqrstuv'"
expect 0 "AKIA blocked"                        "$PROJ" "aws s3 ls --region us-east-1 AWS_ACCESS_KEY_ID=AKIAIOSFODNN7ZXTSTQX"
expect 0 "AKIA doc-example value allowed (whitelist)" "$PROJ" "echo AKIAIOSFODNN7EXAMPLE"
expect 0 "LTAI blocked"                        "$PROJ" "ossutil ls -i LTAI5tAbCdEfGhIjKlMnOp -k secret"
expect 0 "hf_ blocked"                         "$PROJ" "huggingface-cli login --token hf_xxxxREPLACE_WITH_REAL_TOKEN_xxxx"
expect 0 "xoxb blocked"                        "$PROJ" "curl -d 'token=xoxb-123456789012-AbCdEfGhIjKl' https://slack.com/api/auth.test"
expect 2 "dckr_pat_ still blocked — docker guard, not P1"                   "$PROJ" "docker login -u x -p dckr_pat_AbCdEfGhIjKlMnOpQrStUv"

echo "== P2 git add =="
expect 2 "git add -A blocked"                  "$PROJ" "git add -A && git commit -m x"
expect 2 "git add --all blocked"               "$PROJ" "git add --all"
expect 2 "git add . blocked"                   "$PROJ" "git add ."
expect 0 "git add explicit path allowed"       "$PROJ" "git add src/main.go"
expect 0 "git add -u allowed"                  "$PROJ" "git add -u"
expect 0 "git add .github allowed"             "$PROJ" "git add .github/workflows/ci.yaml"

echo "== P3 sleep =="
expect 2 "sleep 300 blocked"                   "$PROJ" "sleep 300 && glab ci status"
expect 2 "sleep 1m blocked"                    "$PROJ" "sleep 1m; kubectl get pods"
expect 2 "sleep 2h blocked"                    "$PROJ" "sleep 2h"
expect 0 "sleep 30 allowed (short backoff)"    "$PROJ" "sleep 30 && retry"
expect 0 "sleep 5 allowed"                     "$PROJ" "sleep 5"

echo "== P6 commit identity (uses guard cwd = session cwd) =="
FAKE_REPO=~/tmp/hook-mining/fake-gh-repo
mkdir -p "$FAKE_REPO"; git -C "$FAKE_REPO" init -q 2>/dev/null; git -C "$FAKE_REPO" remote add origin https://github.com/x/y 2>/dev/null
( cd "$FAKE_REPO" && expect 2 "wrong identity (stranger vs github remote) blocked" "$PROJ" "git -c user.email=stranger@x.y commit -m x" )
( cd "$FAKE_REPO" && expect 0 "correct identity via -c allowed" "$PROJ" "git -c user.email=dev@personal.example commit -m x" )
# repo-local correct identity: sandbox-local github-remote repo, email set repo-locally
# (the real pi-mypackage checkout is outside the sandbox — ambient identity leaks).
mkdir -p "$FAKE_REPO-local"; git -C "$FAKE_REPO-local" init -q 2>/dev/null
git -C "$FAKE_REPO-local" remote add origin https://github.com/x/y 2>/dev/null
git -C "$FAKE_REPO-local" config user.email dev@personal.example
( cd "$FAKE_REPO-local" && expect 0 "repo-local correct identity allowed" "$PROJ" "git commit -m x" )

echo "== G1 agent-dir hand-copy (global) =="
expect 2 "cp into extensions blocked (skills cwd)" "$SKILL" "cp dist/extension.js ~/.pi/agent/extensions/my-ext/"
expect 2 "ln -s into ~/.agents/skills blocked (skills cwd)" "$SKILL" "ln -s ~/skills/in-progress/x ~/.agents/skills/x"
expect 2 "ln -s into extensions blocked (projects cwd)" "$PROJ" "ln -s /mnt/disk1/hyx/skills/extensions/pi-x.ts ~/.pi/agent/extensions/pi-x.ts"
expect 2 "cp into ~/.agents/skills blocked (projects cwd)" "$PROJ" "cp -r dist ~/.agents/skills/my-skill/"
expect 0 "pi install allowed"                  "$PROJ" "pi install /mnt/disk1/hyx/skills"
expect 0 "npx skills add allowed"              "$PROJ" "npx skills add -g ./in-progress/hook-me -a pi -y"
expect 0 "cp FROM install dir allowed (reads)" "$PROJ" "cp ~/.agents/skills/hook-me/SKILL.md ~/tmp/for-reference.md"
expect 0 "ls install dir allowed"              "$PROJ" "ls ~/.pi/agent/extensions"

echo "== pi-secret-store injection interplay =="
PREFIX=': __PI_SECRET_STORE__; if [ "/mnt/disk1/hyx/.pi/agent/secret-store.env" ]; then set -a; . "/mnt/disk1/hyx/.pi/agent/secret-store.env" 2>/dev/null; set +a; fi; '
expect 2 "G1 blocked through injected prefix"   "$PROJ" "${PREFIX}ln -s /x ~/.pi/agent/extensions/y"
expect 0 "P1 through injected prefix now owned by secret-store (guard allows)"   "$PROJ" "${PREFIX}curl -H 'Authorization: Bearer glpat-AbCdEfGhIjKlMnOpQrStUv' https://x"
expect 0 "\$NAME reference through prefix allowed" "$PROJ" "${PREFIX}curl -H \"Authorization: Bearer \$GITBLUE_TOKEN\" https://x"
expect 0 "plain cmd through prefix allowed"     "$PROJ" "${PREFIX}go build ./..."

echo "== quoting / robustness =="
expect 0 "broken json does not crash"          "$PROJ" "ls"
expect 0 "empty command allowed"               "$PROJ" ""

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
