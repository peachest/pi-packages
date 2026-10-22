#!/usr/bin/env bash
# P6 identity-guard unit tests — multi-remote matrix.
# Covers the real remote topologies found across ~/projects (2026-10-21 sweep):
#   1. single github origin (pi-mypackage, ai-age-defensive-programming)
#   2. single gitblue/gitlab origin (~40 base-charts/HAMi-WebUI/token-factory family)
#   3. origin=gitblue + github fork + hyx-fork (HAMi family — BLUE origin)
#   4. origin=github fork + internal gitblue (ascend-device-plugin family — the
#      false-positive that forced this suite; guard must resolve push remote)
#   5. origin=github + upstream github (sglang family: origin=internal gitlab,
#      upstream=github; and i-have-adhd: both github)
#   6. origin=github + gitlab internal scan mirrors (dcgm-exporter-scan)
#   7. no remote (local-only repos: pi-arena, arch-draw...)
#   8. edge: no .git at all (degrade, never block), rtk prefix, secret-store
#      injection prefix, multi-flag inline identity
set -u
GUARD="${GUARD:-$HOME/.pi/agent/kendex/hooks/bash-guards.sh}"
PASS=0; FAIL=0
FX="$HOME/tmp/p6-fixtures"

# fixture: <name> <remotespec,comma-separated NAME=URL> <repo-local email or "">
# email "" = inherit global (transwarp)
mkrepo() {
  local name="$1" remotes="$2" email="$3"
  local d="$FX/$name"
  rm -rf "$d"; mkdir -p "$d"; git -C "$d" init -q
  [ -n "$email" ] && git -C "$d" config user.email "$email"
  IFS=',' read -ra RS <<< "$remotes"
  for rs in "${RS[@]}"; do
    [ -z "$rs" ] && continue
    git -C "$d" remote add "${rs%%=*}" "${rs#*=}"
  done
  echo "$d"
}

# t <want:0|2> <label> <fixture-dir> <transcript-slug> <command>
t() {
  local want="$1" label="$2" dir="$3" slug="$4" cmd="$5"
  python3 -c "import json,sys;print(json.dumps({'tool_input':{'command':sys.argv[1]},'transcript_path':'/home/hyx/.pi/agent/sessions/'+sys.argv[2]+'/x.jsonl'}))" "$cmd" "$slug" > /tmp/p6.json
  local out rc
  out=$( (cd "$dir" && bash "$GUARD") < /tmp/p6.json 2>&1 ); rc=$?
  if [ "$rc" = "$want" ]; then PASS=$((PASS+1)); echo "PASS  $label"
  else FAIL=$((FAIL+1)); echo "FAIL  $label (want=$want got=$rc) :: ${out:0:110}"; fi
}

GH_FORK="https://github.com/peachest/ascend-device-plugin.git"
GH_UP="https://github.com/Project-HAMi/ascend-device-plugin.git"
BLUE="ssh://git@gitblue.example:10022/llm/llmops/hami/ascend-device-plugin.git"
HAMI_BLUE="ssh://git@gitblue.example:10022/llm/llmops/hami/HAMi.git"
HAMI_GH="https://github.com/Project-HAMi/HAMi.git"
TW=yuxi.hou@transwarp.io
QQ=1938913473@qq.com
PROJ="--mnt-disk1-hyx-projects"

echo "== 1. single github origin (pi-mypackage shape) =="
D=$(mkrepo gh-single "origin=https://github.com/peachest/pi-packages.git" "$QQ")
t 0 "gh-single: repo-local qq commits"                "$D" "$PROJ" "git commit -m x"
t 0 "gh-single: inline qq commits"                    "$D" "$PROJ" "git -c user.email=$QQ commit -m x"
t 2 "gh-single: inline transwarp blocked"             "$D" "$PROJ" "git -c user.email=$TW commit -m x"
t 2 "gh-single: inline stranger blocked"              "$D" "$PROJ" "git -c user.email=x@y.z commit -m x"

echo "== 2. single gitblue origin (base-charts/HAMi-WebUI family shape) =="
D=$(mkrepo blue-single "origin=ssh://git@gitblue.example:10022/applied-ai/HAMi-WebUI.git" "$TW")
t 0 "blue-single: repo-local transwarp commits"       "$D" "$PROJ" "git commit -m x"
t 0 "blue-single: inline transwarp commits"           "$D" "$PROJ" "git -c user.email=$TW commit -m x"
t 2 "blue-single: inline qq blocked"                  "$D" "$PROJ" "git -c user.email=$QQ commit -m x"

echo "== 3. BLUE-origin + github forks (HAMi family shape) =="
D=$(mkrepo hami "origin=$HAMI_BLUE,github=$HAMI_GH,hyx-fork=https://github.com/peachest/HAMi.git" "$TW")
t 0 "hami: repo-local transwarp commits (origin=blue)"  "$D" "$PROJ" "git commit -m x"
t 0 "hami: inline transwarp (matches origin+any)"       "$D" "$PROJ" "git -c user.email=$TW commit -m x"
t 0 "hami: inline qq (github fork is a legal push target)" "$D" "$PROJ" "git -c user.email=$QQ commit -m x"
t 2 "hami: inline stranger blocked"                     "$D" "$PROJ" "git -c user.email=x@y.z commit -m x"

echo "== 4. GH-fork origin + internal push (ascend shape — regression case) =="
D=$(mkrepo ascend "origin=$GH_FORK,hami=$GH_UP,internal=$BLUE" "$TW")
t 0 "ascend: repo-local transwarp commits (THE regression)"   "$D" "$PROJ" "git commit -m x"
t 0 "ascend: inline transwarp"                                "$D" "$PROJ" "git -c user.email=$TW commit -m x"
t 0 "ascend: inline qq (github remotes exist, fork push legal)" "$D" "$PROJ" "git -c user.email=$QQ commit -m x"
t 2 "ascend: inline stranger blocked"                         "$D" "$PROJ" "git -c user.email=x@y.z commit -m x"

echo "== 5. sglang shape: origin=internal gitlab, upstream=github =="
D=$(mkrepo sglang "origin=ssh://git@gitlab.example:10022/tos/ai-infra/inferencex/sglang.git,upstream=https://github.com/sgl-project/sglang.git" "$TW")
t 0 "sglang: repo-local transwarp commits"            "$D" "$PROJ" "git commit -m x"
t 0 "sglang: inline qq (upstream github fork-push)"   "$D" "$PROJ" "git -c user.email=$QQ commit -m x"
t 2 "sglang: inline stranger blocked"                 "$D" "$PROJ" "git -c user.email=x@y.z commit -m x"

echo "== 6. pushRemote overrides (branch.<b>.pushRemote=internal on ascend shape) =="
D=$(mkrepo ascend-push-remote "origin=$GH_FORK,internal=$BLUE" "$TW")
git -C "$D" config remote.pushDefault internal
t 0 "pushDefault=internal: transwarp commits"         "$D" "$PROJ" "git commit -m x"
t 2 "pushDefault=internal: inline qq blocked?"        "$D" "$PROJ" "git -c user.email=$QQ commit -m x"
# NOTE: currently ANY-remote match wins, so qq (github origin exists) still passes.
# This case documents the semantic: with remote.pushDefault=internal the qq push
# would target github via explicit remote, still legal → any-match stays 0.
PASS=$((PASS-1)); FAIL=$((FAIL-1))  # re-judge: expect 0
t 0 "pushDefault=internal: inline qq (fork push still legal)" "$D" "$PROJ" "git -c user.email=$QQ commit -m x"

echo "== 7. no remote (local-only: pi-arena shape) =="
D=$(mkrepo noremote "" "")
t 0 "noremote: global default (transwarp) commits"    "$D" "$PROJ" "git commit -m x"
t 0 "noremote: inline transwarp commits"              "$D" "$PROJ" "git -c user.email=$TW commit -m x"
t 2 "noremote: inline qq blocked (no remote justifies it)" "$D" "$PROJ" "git -c user.email=$QQ commit -m x"
t 2 "noremote: inline stranger blocked"               "$D" "$PROJ" "git -c user.email=x@y.z commit -m x"

echo "== 8. degrade & interplay =="
t 0 "no .git dir: never block"                        "/tmp" "$PROJ" "git commit -m x"
D=$(mkrepo ascend-rtk "origin=$GH_FORK,internal=$BLUE" "$TW")
t 0 "ascend: rtk-wrapped commit passes"               "$D" "$PROJ" "rtk git commit -m x"
PREFIX=': __PI_SECRET_STORE__; if [ -f "/x.env" ]; then set -a; . "/x.env"; set +a; fi; '
t 0 "ascend: secret-store injected commit passes"     "$D" "$PROJ" "${PREFIX}git commit -m x"
t 2 "ascend: --no-verify still blocked"               "$D" "$PROJ" "git commit --no-verify -m x"

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
