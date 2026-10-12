// Pure decision logic for pi-timekeeper. No pi imports — fully unit-testable.
// Semantics mirror Codex's current_time_reminder (turn.rs:497 pull model):
// injection is computed at run boundaries only; nothing here wakes an idle session.

export interface TKState {
  /** Local calendar date (YYYY-MM-DD) of the last injected anchor. */
  lastDate?: string;
  /** Epoch ms of the last injected reminder anchor. */
  lastReminderAt?: number;
  /**
   * Persisted pending-reanchor flag (B2): set by session_compact alongside the
   * state snapshot so the re-anchor promise survives process restarts; consumed
   * (and thus cleared) by the next successful injection.
   */
  forcePending?: boolean;
}

export interface TKConfig {
  reminderEnabled: boolean;
  reminderIntervalSeconds: number;
}

export const DEFAULT_CONFIG: TKConfig = {
  reminderEnabled: true,
  reminderIntervalSeconds: 3600,
};

/** Wire key of the persisted state entry (single source of truth; index.ts imports this). */
export const STATE_ENTRY = "timekeeper.state";
/** Shape of the entries restoreState scans (structural subset of pi's SessionEntry). */
export interface StateEntry {
  customType?: string;
  data?: unknown;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): TKConfig {
  const enabled = env["TIMEKEEPER_REMINDER_ENABLED"];
  const interval = Number(env["TIMEKEEPER_INTERVAL_SECONDS"]);
  return {
    reminderEnabled: enabled != null ? enabled !== "false" && enabled !== "0" : DEFAULT_CONFIG.reminderEnabled,
    reminderIntervalSeconds: Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_CONFIG.reminderIntervalSeconds,
  };
}

/** Local calendar date, YYYY-MM-DD (sv-SE locale renders ISO order). */
export function localDate(ms: number): string {
  return new Date(ms).toLocaleDateString("sv-SE");
}

export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Wire key of the injected anchor message (single source of truth; index.ts imports this). */
export const MESSAGE_CUSTOM_TYPE = "timekeeper.environment";

/**
 * Wrap the anchor line in a channel tag. Wire-level the anchor is a bare user
 * turn (convertToLlm drops customType) placed after the user's prompt — the tag
 * is the only signal that this is environment fact, not a user statement (B1).
 */
export function anchorLine(ms: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString("sv-SE", { hour12: false });
  const weekday = d.toLocaleDateString("en-US", { weekday: "long" });
  return `<time_anchor>It is ${localDate(ms)} (${weekday}) ${time}, ${localTimeZone()}.</time_anchor>`;
}

export interface ComputeResult {
  /** Persisted custom message body; undefined when nothing is due. */
  content?: string;
  /** Custom message is only produced when due; callers skip sending otherwise. */
  injected: boolean;
  state: TKState;
}

/**
 * Decide whether a time anchor is due at a run boundary.
 * - date change (local calendar day differs from last anchor) re-anchors;
 * - reminder fires when interval has elapsed since the last anchor;
 * - `force` (compaction re-anchor) makes the injection unconditional; the
 *   reminder field force-refreshes only when reminder is enabled (2026-09-23
 *   adjudication: prototype semantics);
 * - persisted `state.forcePending` (survived a restart) behaves like `force`
 *   and is consumed by the injection (B2).
 * Codex-aligned no-catch-up: missed intervals collapse into this single injection.
 */
export function computeInjection(
  state: TKState,
  now: number,
  config: TKConfig,
  opts: { force?: boolean } = {},
): ComputeResult {
  const forced = opts.force === true || state.forcePending === true;
  const today = localDate(now);
  const dateChanged = forced || state.lastDate !== today;
  const reminderDue =
    config.reminderEnabled &&
    (forced ||
      state.lastReminderAt == null ||
      now - state.lastReminderAt >= config.reminderIntervalSeconds * 1000);

  if (!dateChanged && !reminderDue) {
    return { injected: false, state };
  }

  return {
    injected: true,
    content: anchorLine(now),
    // forcePending is consumed by this injection — the new state never carries it.
    state: {
      lastDate: today,
      lastReminderAt: reminderDue ? now : state.lastReminderAt,
    },
  };
}

/** Find the latest persisted state on the current branch (custom entries only). */
export function restoreState(
  entries: Array<StateEntry | undefined>,
): TKState {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e && e.customType === STATE_ENTRY && e.data && typeof e.data === "object") {
      const d = e.data as TKState;
      return {
        lastDate: typeof d.lastDate === "string" ? d.lastDate : undefined,
        lastReminderAt: typeof d.lastReminderAt === "number" ? d.lastReminderAt : undefined,
        forcePending: typeof d.forcePending === "boolean" ? d.forcePending : undefined,
      };
    }
  }
  return {};
}
