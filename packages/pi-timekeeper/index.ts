// pi-timekeeper — Codex-style time awareness for pi.
// Pull-based: time anchors are computed only at run boundaries (before_agent_start),
// mirroring Codex turn.rs:497. No timers, no queues — structurally cannot wake an idle session.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  anchorLine,
  computeInjection,
  configFromEnv,
  restoreState,
  STATE_ENTRY,
  type TKState,
} from "./state.ts";

const MESSAGE_CUSTOM_TYPE = "timekeeper.environment";

export default function timekeeperExtension(pi: ExtensionAPI) {
  const config = configFromEnv();
  let state: TKState = {};
  let forceReanchor = false;

  pi.on("session_start", async (_event, ctx) => {
    // Restore from the active branch: survives resume/fork/restart (C2/C4: state lives
    // in tree-side custom entries, never in hook returns or process variables alone).
    try {
      const entries = (ctx.sessionManager.getBranch() ??
        ctx.sessionManager.getEntries()) as unknown as Array<Record<string, unknown>>;
      state = restoreState(
        entries.map((e) => ({
          customType: e?.customType as string | undefined,
          data: e?.data,
        })),
      );
    } catch {
      state = {};
    }
    // A fresh session has no anchor yet; the first run injects (Codex is_new_window).
  });

  pi.on("session_compact", async () => {
    // Compaction rebuilds context (prefix miss is free); the next run must re-anchor
    // because the summary may have dropped the previous time line.
    forceReanchor = true;
  });

  pi.on("before_agent_start", async () => {
    const now = Date.now();
    const result = computeInjection(state, now, config, { force: forceReanchor });
    if (!result.injected || result.content == null) {
      return;
    }
    state = result.state;
    forceReanchor = false;
    pi.appendEntry(STATE_ENTRY, state);
    return {
      message: {
        customType: MESSAGE_CUSTOM_TYPE,
        content: result.content,
        display: false,
      },
    };
  });
}

// Re-export for tests and downstream consumers.
export { anchorLine, computeInjection, configFromEnv, restoreState };
