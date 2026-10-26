/**
 * Notification sink with per-name warning dedup (WarningLedger).
 *
 * SDK command contexts use a no-op UI, so tests cannot observe ctx.ui.notify
 * directly; routing failure-visibility messages (warnings, errors) through
 * this wrapper makes their content assertable.
 *
 * Dedup policy (WarningLedger): once a skill name has been warned — by an
 * explicit /preset-load warning or by the per-turn replay path — later turns
 * do not repeat the warning for that name. `resetScope()` clears the ledger
 * at session_start / session_tree boundaries, so a replay cycle re-warns
 * names that are still unavailable after navigation or restart. Actions
 * within one scope intentionally re-warn (repeat load of a bad preset warns
 * again — no cross-action dedup).
 */

export type NotifyLevel = "info" | "warning" | "error";

export interface RecordedNotification {
  msg: string;
  level: NotifyLevel;
}

/** Module-level log: one extension instance per test file, reset per scenario. */
export type NotifyObserver = (n: RecordedNotification) => void;

// Test-only capture (ocr R3): production never stores notifications (zero
// memory growth); tests arm an observer via setNotifyObserver.
let observer: NotifyObserver | null = null;

export function setNotifyObserver(fn: NotifyObserver | null): void {
  observer = fn;
}

// --- WarningLedger: per-name warning dedup --------------------------------
// Scoped to one replay cycle (session_start / session_tree reset it).
const warnedSkillNames = new Set<string>();

/**
 * Record skill names as already-warned, so the per-turn replay path does not
 * repeat their warning (ocr-F2 dedup policy, now owned here).
 */
export function markWarned(names: string[]): void {
  for (const name of names) warnedSkillNames.add(name);
}

/** Names not yet warned in the current scope. */
export function unseenWarned(names: string[]): string[] {
  return names.filter((name) => !warnedSkillNames.has(name));
}

/** Clear the ledger at replay-scope boundaries (session_start / session_tree). */
export function resetScope(): void {
  warnedSkillNames.clear();
}

/** Read-only snapshot of already-warned names (turn-gate input). */
export function warnedNames(): ReadonlySet<string> {
  return warnedSkillNames;
}

export function recordNotify(
  ui: { notify(message: string, type?: NotifyLevel): void } | undefined,
  msg: string,
  level: NotifyLevel,
): void {
  observer?.({ msg, level });
  // SDK/no-op contexts can carry no ui — still record for observers (tests).
  ui?.notify(msg, level);
}
