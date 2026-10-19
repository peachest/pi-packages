#!/usr/bin/env bash
# Launcher for the subscriptions pane (票 44 open-subscriptions action).
# herdr actions run a command — there is no declarative "open this pane" field —
# so this shells back into the herdr CLI and opens the [[panes]] entrypoint as a
# split beside the current work (open-dagr 同模式).
#
# Pane context is resolved HERE, at action time (the user's pane is
# unambiguously the focused one): the focused pane's pi session uuid is read
# from `herdr pane list` agent_session, written into a state dir, and passed
# down with --cwd — the pane process reads ./session for the self view anchor.
set -uo pipefail

herdr_bin="${HERDR_BIN_PATH:-herdr}"
plugin_id="${HERDR_PLUGIN_ID:-herdr-pi-events}"

place="${1:-right}"
case "$place" in
  right) direction="right"; swap="" ;;
  down)  direction="down";  swap="" ;;
  left)  direction="right"; swap="left" ;;
  up)    direction="down";  swap="up" ;;
  *)     direction="right"; swap="" ;;
esac

# 焦点 pane → 本 session 的订阅锚（agent_session.value = <ts>_<uuid>.jsonl）；
# 焦点 pane 非 agent（无 agent_session）→ 空文件 = 全量视图。
state_dir="${XDG_RUNTIME_DIR:-$HOME/.pi/run}/pi-events-subscriptions"
mkdir -p "$state_dir"
"$herdr_bin" pane list | node -e '
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  const doc0 = JSON.parse(raw) as { result?: { panes?: unknown[] }; panes?: unknown[] };
  const panes = (Array.isArray(doc0) ? doc0 : doc0.result?.panes ?? doc0.panes ?? []) as Array<Record<string, unknown>>;
  const focused = panes.find((p) => p.focused === true);
  const v = ((focused?.agent_session as { value?: string } | undefined)?.value) ?? "";
  const m = v.match(/_([0-9a-f-]{36})\.jsonl$/i);
  process.stdout.write(m ? m[1] : "");
});' > "$state_dir/session" 2>/dev/null

args=(plugin pane open
  --plugin "$plugin_id"
  --entrypoint subscriptions
  --placement split
  --direction "$direction"
  --cwd "$state_dir"
  --focus)

if [ -z "$swap" ]; then
  exec "$herdr_bin" "${args[@]}"
fi

out=$("$herdr_bin" "${args[@]}") || exit 1
pane_id=$(printf '%s' "$out" | sed -nE 's/.*"pane_id":"([^"]+)".*/\1/p' | head -1)
if [ -n "$pane_id" ]; then
  "$herdr_bin" pane swap --pane "$pane_id" --direction "$swap" >/dev/null
fi
