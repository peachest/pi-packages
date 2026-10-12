// pi-timekeeper — Codex-style time awareness for pi.
// Pull-based: time anchors are computed only at run boundaries (before_agent_start),
// mirroring Codex turn.rs:497. No timers, no queues — structurally cannot wake an idle session.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  anchorLine,
  computeInjection,
  configFromEnv,
  MESSAGE_CUSTOM_TYPE,
  restoreState,
  STATE_ENTRY,
  type StateEntry,
  type TKState,
} from "./state.ts";

export default function timekeeperExtension(pi: ExtensionAPI) {
  const config = configFromEnv();
  let state: TKState = {};
  let forceReanchor = false;

  pi.on("session_start", async (_event, ctx) => {
    // Restore from the active branch: survives resume/fork/restart (C2/C4: state lives
    // in tree-side custom entries, never in hook returns or process variables alone).
    restoreFromBranch(ctx);
    // A fresh session has no anchor yet; the first run injects (Codex is_new_window).
  });

  pi.on("session_tree", async (_event, ctx) => {
    // Q3: /tree navigation does not re-fire session_start (pi 1.1.0 dist: agent-session.js
    // emits session_tree only) — re-restore so in-memory state follows the new branch.
    restoreFromBranch(ctx);
  });

  pi.on("session_compact", async () => {
    // Compaction rebuilds context (prefix miss is free); the next run must re-anchor
    // because the summary may have dropped the previous time line.
    // Q4: unconditional — before_agent_start fires once per run (prompt path only), so
    // an overflow-retry turn inside the same run never re-injects; adding a willRetry
    // branch would lose the re-anchor instead of fixing it.
    // B2: persist the pending flag alongside state so the re-anchor promise survives
    // a process restart between compaction and the next run.
    forceReanchor = true;
    pi.appendEntry(STATE_ENTRY, { ...state, forcePending: true });
  });

  pi.on("before_agent_start", async () => {
    // Q2 clock guard: the Intl formatting inside computeInjection is the thrower, not
    // Date.now. On failure: no injection this run, state and force untouched — the
    // pending re-anchor is consumed only by a successful injection.
    let result;
    try {
      result = computeInjection(state, Date.now(), config, { force: forceReanchor });
    } catch {
      return;
    }
    if (!result.injected || result.content == null) {
      return;
    }
    // OCR O2：先持久化再提交内存状态——appendEntry 失败时内存里的 pending（forcePending 或
    // forceReanchor）原封不动，下个 run 重试；先改 state 会把待重锚信号消费掉。
    pi.appendEntry(STATE_ENTRY, result.state);
    state = result.state;
    forceReanchor = false;
    return {
      message: {
        customType: MESSAGE_CUSTOM_TYPE,
        content: result.content,
        display: false,
      },
    };
  });

  // sessionManager 的完整类型未从 pi 公共入口导出；用结构子集 + 边界 cast（review S1 判定接受）。
  // OCR O1：restore 后同步 forceReanchor 归属当前分支——分支 A 的 compact 残留不得泄漏到分支 B；
  // 异常回退同样清零（无 state 即无 pending）。
  function restoreFromBranch(ctx: { sessionManager: { getBranch(): unknown; getEntries(): unknown } }) {
    try {
      const entries = (ctx.sessionManager.getBranch() ?? ctx.sessionManager.getEntries()) as StateEntry[];
      state = restoreState(entries);
      forceReanchor = state.forcePending === true;
    } catch {
      state = {};
      forceReanchor = false;
    }
  }
}
