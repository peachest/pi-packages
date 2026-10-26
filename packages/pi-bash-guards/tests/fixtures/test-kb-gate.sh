#!/usr/bin/env bash
# Fixture suite E — knowledge-base-first gate KB (2026-10-26).
# Pattern follows suite C (test-wt-lifecycle.sh): table-driven, self-reporting
# PASS/FAIL summary, exit non-zero on any failure. GUARD env points at the
# guard under test (vitest injects the packaged source); HOME is sandboxed by
# vitest so the flag/read-log state lands under the sandbox ~/.pi/agent.
#
# Covers:
#   KB  block: kubectl/crictl/journalctl/dmesg/nvidia-smi in command position
#       with no vault read this session -> exit 2, message routes to the
#       diag-search rg / ~/ops/index.md
#       satisfy: ANY command touching ~/ops or llmops-wiki opens the gate for
#       the rest of the session (per-transcript flag)
#       fail-open: no transcript_path -> allow; non-projects slug -> allow
#       narrow triggers: rg/grep over code (no KB path) never gates; helm /
#       nerdctl / docker stay ungated (deploy/mgmt-heavy)
#       read log: every decision appends a line to readlog-YYYYMM.jsonl
#       doc granularity: satisfy lines carry a doc field (ops filename /
#       wiki topic dir / list on multi-hit / null when no specific file);
#       block/pass lines carry no doc field
set -u
GUARD="${GUARD:-$HOME/.pi/agent/kendex/hooks/bash-guards.py}"
PASS=0; FAIL=0

SLUG="$HOME/.pi/agent/sessions/--mnt-disk1-hyx-projects--"
mkdir -p "$SLUG" "$HOME/.pi/agent/sessions/--mnt-disk1-hyx-home--"
GLOB="$HOME/.pi/agent/sessions/--mnt-disk1-hyx-home--/g.jsonl"

json_for() { # json_for <cmd> <transcript>
  python3 -c "
import json,sys
print(json.dumps({'tool_input':{'command':sys.argv[1]},'transcript_path':sys.argv[2],'session_id':'test'}))" "$1" "$2"
}

# expect <exit> <label> <transcript> <command>
expect() {
  local want="$1" label="$2" tp="$3" cmd="$4"
  local out rc
  out=$(json_for "$cmd" "$tp" | bash "$GUARD" 2>&1); rc=$?
  if [ "$rc" = "$want" ]; then
    PASS=$((PASS+1)); echo "PASS  $label"
  else
    FAIL=$((FAIL+1)); echo "FAIL  $label (want=$want got=$rc)"; echo "      out: ${out:0:160}"
  fi
}

# last_doc — doc field of the newest readlog line (compact JSON, MISSING if absent)
last_doc() {
  python3 -c "
import json,glob,sys
fs=sorted(glob.glob(sys.argv[1]+'/readlog-*.jsonl'))
if not fs: print('MISSING'); raise SystemExit
r=json.loads(open(fs[-1]).read().strip().split('\n')[-1])
print('MISSING' if 'doc' not in r else json.dumps(r['doc'],separators=(',',':')))" \
    "$HOME/.pi/agent/kendex/state/kb"
}

# expect_doc <label> <transcript> <command> <expected-doc-json>
expect_doc() {
  local label="$1" tp="$2" cmd="$3" want="$4" got rc
  json_for "$cmd" "$tp" | bash "$GUARD" >/dev/null 2>&1; rc=$?
  got=$(last_doc)
  if [ "$rc" = 0 ] && [ "$got" = "$want" ]; then
    PASS=$((PASS+1)); echo "PASS  $label"
  else
    FAIL=$((FAIL+1)); echo "FAIL  $label (want=$want got=$got rc=$rc)"
  fi
}

# expect_msg <label> <pattern> <transcript> <command> — rc 2 AND message names
# the recommended vault search (three-element acceptance).
expect_msg() {
  local label="$1" pattern="$2" tp="$3" cmd="$4"
  local out rc
  out=$(json_for "$cmd" "$tp" | bash "$GUARD" 2>&1); rc=$?
  if [ "$rc" = 2 ] && printf '%s' "$out" | grep -q -- "$pattern"; then
    PASS=$((PASS+1)); echo "PASS  $label"
  else
    FAIL=$((FAIL+1)); echo "FAIL  $label (rc=$rc pattern='$pattern')"; echo "      out: ${out:0:160}"
  fi
}

# Independent scenario = independent transcript file (state key is a hash of
# the transcript path). One scenario per trigger family.

# S1: block + message routes to the vault
T1="$SLUG/kb-s1.jsonl"
expect_msg "S1 kubectl blocks with vault route" "rg -l 'labels:" "$T1" "kubectl get pods -A"
# S1: read log got the block line
[ -n "$(ls "$HOME/.pi/agent/kendex/state/kb/"readlog-*.jsonl 2>/dev/null)" ] \
  && { PASS=$((PASS+1)); echo "PASS  S1 read log written"; } \
  || { FAIL=$((FAIL+1)); echo "FAIL  S1 read log written"; }

# S2: satisfy via ops rg, then the gate stays open for this session
T2="$SLUG/kb-s2.jsonl"
expect 0 "S2 vault rg satisfies" "$T2" "rg -l 'labels:.*hami' ~/ops/*.md"
expect 0 "S2 gate open after satisfy" "$T2" "kubectl get pods -A"
expect 0 "S2 gate open for journalctl too" "$T2" "journalctl -u kubelet -n 100"

# S3: satisfy via reading the index
T3="$SLUG/kb-s3.jsonl"
expect 0 "S3 cat index satisfies" "$T3" "cat ~/ops/index.md"
expect 0 "S3 gate open" "$T3" "sudo kubectl describe node x"

# S4: satisfy via llmops-wiki touch
T4="$SLUG/kb-s4.jsonl"
expect 0 "S4 wiki rg satisfies" "$T4" "rg devmem ~/projects/llmops-wiki/gold/gpu-mem-units/contracts.md"
expect 0 "S4 gate open" "$T4" "dmesg | tail -50"

# S5: every trigger family blocks a fresh session
for trig in "crictl ps" "nvidia-smi" "dmesg -T"; do
  T="$SLUG/kb-s5-$(echo "$trig" | tr ' ' '-').jsonl"
  expect 2 "S5 blocks: $trig" "$T" "$trig"
done

# S6: fail-open without a transcript
expect 0 "S6 no transcript fail-open" "" "kubectl get pods -A"

# S7: non-projects slug (global layer) never gates
expect 0 "S7 global layer not gated" "$GLOB" "kubectl get pods -A"

# S8: guard-override marker is inert since #153 (channel removed) — kubectl
# with the marker still blocks
T8="$SLUG/kb-s8.jsonl"
expect 2 "S8 override marker inert (channel removed #153)" "$T8" "kubectl get pods -A # guard-override: quoting for docs"

# S9: narrow triggers — code search without a KB path is not gated
T9="$SLUG/kb-s9.jsonl"
expect 0 "S9 rg over code not gated" "$T9" "rg -n 'Device' ~/projects/HAMi/pkg/"
expect 0 "S9 grep not gated" "$T9" "grep -rn device-plugin ~/projects/"

# S10: deploy/mgmt tools stay ungated
T10="$SLUG/kb-s10.jsonl"
expect 0 "S10 helm not gated" "$T10" "helm list -A"
expect 0 "S10 nerdctl not gated" "$T10" "sudo nerdctl ps"

# S11: satisfy doc granularity — ops filename
T11="$SLUG/kb-s11.jsonl"
expect_doc "S11 doc: ops index filename" "$T11" "cat ~/ops/index.md" '"index.md"'

# S12: absolute ops path also extracts the filename
T12="$SLUG/kb-s12.jsonl"
expect_doc "S12 doc: absolute ops path" "$T12" "cat /mnt/disk1/hyx/ops/diag/foo.md" '"foo.md"'

# S13: wiki touch extracts the topic dir (first two path segments)
T13="$SLUG/kb-s13.jsonl"
expect_doc "S13 doc: wiki topic dir" "$T13" \
  "rg devmem ~/projects/llmops-wiki/gold/gpu-mem-units/contracts.md" '"gold/gpu-mem-units"'

# S14: multi-hit command records a list, deduplicated
T14="$SLUG/kb-s14.jsonl"
expect_doc "S14 doc: multi-hit list" "$T14" \
  "cat ~/ops/a.md ~/ops/a.md ~/ops/b.md" '["a.md","b.md"]'

# S15: bare ~/ops directory touch (no specific file) records null
T15="$SLUG/kb-s15.jsonl"
expect_doc "S15 doc: bare ops dir -> null" "$T15" "ls ~/ops" 'null'

# S16: block lines carry no doc field at all
T16="$SLUG/kb-s16.jsonl"
json_for "kubectl get pods -A" "$T16" | bash "$GUARD" >/dev/null 2>&1
BLOCKNODOC=$(python3 -c "
import json,glob
fs=sorted(glob.glob('$HOME/.pi/agent/kendex/state/kb/readlog-*.jsonl'))
r=json.loads(open(fs[-1]).read().strip().split('\n')[-1])
print('yes' if r['kind']=='block' and 'doc' not in r else 'no')")
if [ "$BLOCKNODOC" = yes ]; then
  PASS=$((PASS+1)); echo "PASS  S16 block line has no doc field"
else
  FAIL=$((FAIL+1)); echo "FAIL  S16 block line has no doc field"
fi

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
