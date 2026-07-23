/**
 * State Manager — Earth Online Changelog
 *
 * Manages the "already shown today" state via Pi's session entry API.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ChangelogState {
  lastShownDate: string; // YYYY-MM-DD
}

/**
 * Minimal session context interface for state operations.
 * Covers the subset of Pi's ctx used by this module.
 */
export interface SessionCtx {
  sessionManager: {
    getBranch: () => any[];
  };
  hasUI?: boolean;
  ui?: {
    setWidget: (id: string, content: string[]) => void;
    notify: (message: string, type: string) => void;
  };
}

// ─── Constants ────────────────────────────────────────────────────────────────

const STATE_KEY = "earth-online-state";

// ─── State Helpers ────────────────────────────────────────────────────────────

export function persistState(pi: ExtensionAPI, lastShownDate: string) {
  pi.appendEntry<ChangelogState>(STATE_KEY, { lastShownDate });
}

function collectStates(ctx: SessionCtx): ChangelogState[] {
  const states: ChangelogState[] = [];
  try {
    const entries = ctx.sessionManager.getBranch();
    for (const entry of entries) {
      if (entry.type === "custom" && entry.customType === STATE_KEY) {
        const data = entry.data as ChangelogState | undefined;
        if (data?.lastShownDate) states.push(data);
      }
    }
  } catch {
    // session tree might not be available yet
  }
  return states;
}

/**
 * Check if the changelog was already shown for the given date.
 * Returns true if the last recorded state matches todayStr.
 */
export function wasShownToday(ctx: SessionCtx, todayStr: string): boolean {
  const states = collectStates(ctx);
  if (states.length === 0) return false;
  return states[states.length - 1]?.lastShownDate === todayStr;
}