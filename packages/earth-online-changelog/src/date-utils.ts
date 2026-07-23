/**
 * Date Utilities — pure date/calendar helper functions
 *
 * Extracted from notes-renderer.ts.
 * Zero external dependencies (besides world-update.ts for moon phase).
 */

import { getMoonPhaseBar } from "./world-update.ts";

// ─── Number formatting ─────────────────────────────────────────────────────────

export function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

// ─── Date strings ──────────────────────────────────────────────────────────────

export function getTodayDateString(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function getVersionString(now: Date = new Date()): string {
  return `Patch ${now.getFullYear()}.${pad(now.getMonth() + 1)}.${pad(now.getDate())}`;
}

// ─── World day ─────────────────────────────────────────────────────────────────

export function getWorldDay(date: Date): string {
  const startOfYear = new Date(date.getFullYear(), 0, 0);
  const diff = date.getTime() - startOfYear.getTime();
  const dayOfYear = Math.floor(diff / (1000 * 60 * 60 * 24));
  return dayOfYear.toString().padStart(3, "0");
}

// ─── Weekday constants and formatting ──────────────────────────────────────────

export const WEEKDAY_ZH = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
export const WEEKDAY_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function formatWeekday(date: Date, lang: string): string {
  const day = date.getDay();
  return lang === "zh" ? WEEKDAY_ZH[day] : WEEKDAY_EN[day];
}

// ─── Moon phase ────────────────────────────────────────────────────────────────

export function getMoonPhaseDisplay(date: Date, lang: string): string {
  const bar = getMoonPhaseBar(date);
  return lang === "zh"
    ? `月相: ${bar.phaseName} (${bar.percent}%)`
    : `Moon: ${bar.phaseName} ${bar.percent}%`;
}
