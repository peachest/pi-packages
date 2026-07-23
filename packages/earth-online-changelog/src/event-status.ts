/**
 * Event Status — determine the lifecycle status of an Earth Event
 *
 * Extracted from notes-renderer.ts.
 */

import type { EarthEvent } from "./config-parser.ts";
import { midnightOf } from "./world-update.ts";

// ─── Constants ─────────────────────────────────────────────────────────────────

export const MS_PER_DAY = 86400000;
export const DEFAULT_WARMUP_DAYS = 14;

// ─── Status Logic ──────────────────────────────────────────────────────────────

/**
 * Determine event status based on dates and warmup threshold.
 *
 * Rules:
 * - No dates → "active" (backward compat)
 * - endDate before today → "ended"
 * - startDate ≤ today ≤ endDate → "active"
 * - today < startDate ≤ today + warmupDays → "warming"
 * - today < startDate beyond warmup → "upcoming"
 */
export function getEventStatus(event: EarthEvent, today: Date): "active" | "warming" | "upcoming" | "ended" {
  const todayMs = midnightOf(today);
  const startMs = event.startDate ? new Date(`${event.startDate}T00:00:00`).getTime() : null;
  const endMs = event.endDate ? new Date(`${event.endDate}T00:00:00`).getTime() : null;
  const warmupDays = event.warmupDays ?? DEFAULT_WARMUP_DAYS;

  // No dates → active (backward compat)
  if (startMs === null && endMs === null) return "active";

  // Ended: endDate is before today
  if (endMs !== null && endMs < todayMs) return "ended";

  // Active: startDate ≤ today ≤ endDate (or no endDate)
  if (startMs !== null && startMs <= todayMs) {
    if (endMs === null || todayMs <= endMs) return "active";
  }

  // Warming: today < startDate ≤ today + warmupDays
  if (startMs !== null && todayMs < startMs) {
    const warmupThreshold = todayMs + warmupDays * MS_PER_DAY;
    if (startMs <= warmupThreshold) return "warming";
    return "upcoming";
  }

  return "active";
}
