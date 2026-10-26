#!/usr/bin/env bash
# Fixture suite D — subagent (pi-subagents) parameter-shape guards (SA1-SA4).
# Mined 2026-10-22 (~/tmp/subagent-diag/ four-axis reports): 228 unique
# calls / 23 errors across the recent-20 window; these four shapes are
# deterministic from args alone. Each case feeds a no-command payload (the
# subagent tool's args dict rides through unrenamed — see pi-hooks vocab.ts);
# expectations are exit codes: 0 = allow, 2 = block.
set -u
GUARD="${GUARD:-$HOME/.pi/agent/kendex/hooks/bash-guards.py}"
PASS=0; FAIL=0

# usage: expect_args <exit> <label> <args-json>
expect_args() {
  local want="$1" label="$2" args="$3"
  local payload out rc
  payload=$(python3 -c "
import json,sys
print(json.dumps({'tool_input':json.loads(sys.argv[1]),'transcript_path':'/home/u/.pi/agent/sessions/x/2026-10-22T00-00-00-000Z_test.jsonl','session_id':'test'}))" "$args")
  out=$(printf '%s' "$payload" | python3 "$GUARD" 2>&1)
  rc=$?
  if [ "$rc" = "$want" ]; then
    PASS=$((PASS+1)); echo "PASS  $label"
  else
    FAIL=$((FAIL+1)); echo "FAIL  $label (want=$want got=$rc)"; echo "      out: ${out:0:160}"
  fi
}

echo "== SA1 options JSON string =="
expect_args 2 "SA1 blocks options as JSON string"  '{"agent":"delegate","task":"x","options":"{\"index\":0}"}'
expect_args 0 "SA1 allows options as object"       '{"agent":"delegate","task":"x","options":{"index":0}}'
expect_args 0 "SA1 silent when options absent"     '{"agent":"delegate","task":"x"}'

echo "== SA2 removed workflowScriptPath =="
expect_args 2 "SA2 blocks legacy workflowScriptPath" '{"workflowScriptPath":"./wf.js"}'
expect_args 0 "SA2 allows workflow file path"         '{"workflow":"/mnt/disk1/hyx/tmp/wf.js"}'

echo "== SA3 ~ workflow path =="
expect_args 2 "SA3 blocks ~/ workflow path"    '{"workflow":"~/research/lit/workflow.js","async":true}'
expect_args 0 "SA3 allows ./relative path"     '{"workflow":"./workflows/review.js"}'
expect_args 0 "SA3 allows true-string form"    '{"workflow":"true"}'

echo "== SA4 blacklisted agent names =="
expect_args 2 "SA4 blocks general"              '{"agent":"general","task":"x"}'
expect_args 2 "SA4 blocks general-purpose"      '{"agent":"general-purpose","task":"x"}'
expect_args 2 "SA4 blocks oracle"               '{"agent":"oracle","task":"x"}'
expect_args 2 "SA4 case-insensitive"            '{"agent":"General","task":"x"}'
expect_args 0 "SA4 allows worker"               '{"agent":"worker","task":"x"}'
expect_args 0 "SA4 allows researcher"           '{"agent":"researcher","task":"x"}'

echo "== fail-open: unrelated no-command tools =="
expect_args 0 "edit payload untouched"    '{"path":"/tmp/a.md","edits":[{"oldText":"a","newText":"b"}]}'
expect_args 0 "codemode payload untouched" '{"code":"return 1"}'
expect_args 0 "read payload untouched"    '{"path":"/tmp/a.md"}'

echo "== management actions pass through =="
expect_args 0 "action status"     '{"action":"status","id":"5d73fa29-c340-4a19-aee9-1946e9e92832"}'
expect_args 0 "action list"       '{"action":"list"}'

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
