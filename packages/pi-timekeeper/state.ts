// Pure decision logic for pi-timekeeper. No pi imports — fully unit-testable.
// Semantics mirror Codex's current_time_reminder (turn.rs:497 pull model):
// injection is computed at run boundaries only; nothing here wakes an idle session.

export interface TKState {
  /** Local calendar date (YYYY-MM-DD) of the last injected anchor. */
  lastDate?: string;
  /** Epoch ms of the last injected reminder anchor. */
  lastReminderAt?: number;
}

export interface TKConfig {
  reminderEnabled: boolean;
  reminderIntervalSeconds: number;
}

export const DEFAULT_CONFIG: TKConfig = {
  reminderEnabled: true,
  reminderIntervalSeconds: 3600,
};

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

/** "It is 2026-09-23 (Tuesday) 14:02:11, Asia/Shanghai." */
export function anchorLine(ms: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString("sv-SE", { hour12: false });
  const weekday = d.toLocaleDateString("en-US", { weekday: "long" });
  return `It is ${localDate(ms)} (${weekday}) ${time}, ${localTimeZone()}.`;
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
 * - `force` (compaction re-anchor) makes both due regardless.
 * Codex-aligned no-catch-up: missed intervals collapse into this single injection.
 */
export function computeInjection(
  state: TKState,
  now: number,
  config: TKConfig,
  opts: { force?: boolean } = {},
): ComputeResult {
  const today = localDate(now);
  const dateChanged = opts.force === true || state.lastDate !== today;
  const reminderDue =
    config.reminderEnabled &&
    (opts.force === true ||
      state.lastReminderAt == null ||
      now - state.lastReminderAt >= config.reminderIntervalSeconds * 1000);

  if (!dateChanged && !reminderDue) {
    return { injected: false, state };
  }

  return {
    injected: true,
    content: anchorLine(now),
    state: {
      lastDate: today,
      lastReminderAt: reminderDue ? now : state.lastReminderAt,
    },
  };
}

/** Find the latest persisted state on the current branch (custom entries only). */
export function restoreState(
  entries: Array<{ customType?: string; data?: unknown } | undefined>,
): TKState {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e && e.customType === "timekeeper.state" && e.data && typeof e.data === "object") {
      const d = e.data as TKState;
      return {
        lastDate: typeof d.lastDate === "string" ? d.lastDate : undefined,
        lastReminderAt: typeof d.lastReminderAt === "number" ? d.lastReminderAt : undefined,
      };
    }
  }
  return {};
}
