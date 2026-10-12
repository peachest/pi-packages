/**
 * Notification sink that records every message it delivers.
 *
 * SDK command contexts use a no-op UI, so tests cannot observe ctx.ui.notify
 * directly; routing failure-visibility messages (warnings, errors) through
 * this wrapper makes their content assertable.
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

export function recordNotify(
  ui: { notify(message: string, type?: NotifyLevel): void } | undefined,
  msg: string,
  level: NotifyLevel,
): void {
  observer?.({ msg, level });
  // SDK/no-op contexts can carry no ui — still record for observers (tests).
  ui?.notify(msg, level);
}
