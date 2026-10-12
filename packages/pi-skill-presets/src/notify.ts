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
export const notificationLog: RecordedNotification[] = [];

export function resetNotificationLog(): void {
  notificationLog.length = 0;
}

export function recordNotify(
  ui: { notify(message: string, type?: NotifyLevel): void },
  msg: string,
  level: NotifyLevel,
): void {
  notificationLog.push({ msg, level });
  ui.notify(msg, level);
}
