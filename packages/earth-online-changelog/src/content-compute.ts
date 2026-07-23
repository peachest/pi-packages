/**
 * Content Compute — pure data transformations, no rendering
 *
 * Extracted from notes-renderer.ts.
 * Functions that compute, filter, merge, and collect data.
 * No canvas, no box characters.
 */

import type { EarthEvent, EarthEntry, UpcomingEvent } from "./config-parser.ts";
import { getEventName, getEventDescription } from "./config-parser.ts";
import { getEventStatus, MS_PER_DAY, DEFAULT_WARMUP_DAYS } from "./event-status.ts";
import { pad, getTodayDateString, getVersionString, getWorldDay, formatWeekday, getMoonPhaseDisplay } from "./date-utils.ts";
import { getNextSolarTerm, midnightOf } from "./world-update.ts";
import { Solar } from "lunar-typescript";

// ─── Constants ─────────────────────────────────────────────────────────────────

export const UPCOMING_WINDOW_DAYS = 6;

// ─── Header Text Collection ────────────────────────────────────────────────────

/** Collect pure text lines from header for pass 1 width calculation. */
export function collectHeaderTexts(date: Date, lang: string, hasEvents: boolean, eventName?: string): string[] {
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const dateStr = `${y}.${m}.${d}`;
  const weekday = formatWeekday(date, lang);
  const worldDay = getWorldDay(date);
  const version = getVersionString(date);

  const solar = Solar.fromYmd(y, date.getMonth() + 1, date.getDate());
  const lunar = solar.getLunar();
  const ganzhiYear = lunar.getYearInGanZhi();
  const lunarMonth = lunar.getMonthInChinese();
  const lunarDay = lunar.getDayInChinese();
  const moonPhaseInfo = getMoonPhaseDisplay(date, lang);

  const texts: string[] = [];

  const title = lang === "zh"
    ? "🌍 地球 Online · 版本更新公告"
    : "🌍 Earth Online · Patch Notes";
  texts.push(title);

  const epochLabel = lang === "zh" ? "纪元" : "Epoch";
  const worldDayLabel = lang === "zh" ? "世界刻" : "World Day";
  texts.push(`📅 ${dateStr}  ${weekday}  [${epochLabel} ${y} · ${worldDayLabel} ${worldDay}]`);

  const calPrefix = lang === "zh" ? "🗓️ 旧历:" : "🗓️ Old Calendar:";
  texts.push(`${calPrefix} ${ganzhiYear}年${lunarMonth}月${lunarDay}  |  ${moonPhaseInfo}`);

  if (hasEvents) {
    texts.push(eventName
      ? (lang === "zh" ? `🏷️ 世界事件: ${eventName}` : `🏷️ World Event: ${eventName}`)
      : (lang === "zh" ? "🏷️ 世界事件" : "🏷️ World Event"));
  }

  texts.push(`🆔 ${version}`);

  return texts;
}

// ─── Card Text Collection ──────────────────────────────────────────────────────

/** Collect pure text lines from event cards for pass 1 width calculation. */
export function collectCardTexts(events: EarthEvent[], lang: string, today: Date): string[] {
  const texts: string[] = [];
  for (const event of events) {
    const name = getEventName(event, lang);
    const status = getEventStatus(event, today);

    texts.push(` ${event.icon} ${name} `);

    const desc = getEventDescription(event, lang);
    if (desc) {
      texts.push(desc);
    }

    const hasDates = event.startDate || event.endDate;
    if (hasDates) {
      if (status === "active" && event.startDate && event.endDate) {
        const endMs = new Date(`${event.endDate}T00:00:00`).getTime();
        const todayMs = midnightOf(today);
        const startMs = new Date(`${event.startDate}T00:00:00`).getTime();
        const totalDays = Math.round((endMs - startMs) / MS_PER_DAY);
        const consumed = Math.round((todayMs - startMs) / MS_PER_DAY);
        const remaining = totalDays - consumed;
        const remainingLabel = lang === "zh" ? `剩余: ${remaining} 天` : `${remaining}d remaining`;
        const endStr = event.endDate.replace(/-/g, ".");
        const todayLabel = lang === "zh" ? "本日 →" : "Today →";
        texts.push(`⏳ ${remainingLabel}  |  ${todayLabel} ${endStr}`);
      } else if (status === "warming" || status === "upcoming") {
        const startMs = event.startDate ? new Date(`${event.startDate}T00:00:00`).getTime() : 0;
        const todayMs = midnightOf(today);
        const daysUntil = Math.round((startMs - todayMs) / MS_PER_DAY);
        const countdownLabel = lang === "zh" ? `距正式开启 ${daysUntil} 天` : `${daysUntil} days until start`;
        const prefix = lang === "zh" ? "⏳ 预热倒计时:" : "⏳ Countdown:";
        texts.push(`${prefix} ${countdownLabel}`);
      }
    }

    if (event.reward) {
      const rewardPrefix = lang === "zh" ? "🎁 活动奖励:" : "🎁 Reward:";
      texts.push(`${rewardPrefix} ${event.reward}`);
    }

    if (hasDates) {
      if (event.startDate && event.endDate) {
        const startMmdd = event.startDate.slice(5);
        const endMmdd = event.endDate.slice(5);
        const dateLabel = lang === "zh" ? "📅 活动开放:" : "📅 Open:";
        texts.push(`${dateLabel} ${startMmdd} → ${endMmdd}  (UTC+8)`);
      } else if (event.startDate) {
        const startMmdd = event.startDate.slice(5);
        const dateLabel = lang === "zh" ? "📅 正式开启:" : "📅 Starts:";
        texts.push(`${dateLabel} ${startMmdd}  (UTC+8)`);
      }
    }
  }
  return texts;
}

// ─── Merge Logic ──────────────────────────────────────────────────────────────

/** Merge static events with API events, deduplicating by name (static wins). */
export function mergeEvents(staticEvents: EarthEvent[], apiEvents: EarthEvent[]): EarthEvent[] {
  const seen = new Set<string>();
  const result: EarthEvent[] = [];
  for (const e of staticEvents) {
    result.push(e);
    seen.add(e.name);
  }
  for (const e of apiEvents) {
    if (!seen.has(e.name)) {
      result.push(e);
      seen.add(e.name);
    }
  }
  return result;
}

// ─── Peace Day Detection ───────────────────────────────────────────────────────

/** Determine if a given day is a "peace day" (no events at all). */
export function isPeaceDay(todayEntry: EarthEntry | undefined, apiEvents: EarthEvent[]): boolean {
  const merged = mergeEvents(todayEntry?.events ?? [], apiEvents);
  return merged.length === 0;
}

// ─── Upcoming Events Builder ──────────────────────────────────────────────────

/** Build upcoming events list for the next 6 days. */
export function buildUpcomingEvents(
  dataByDate: Map<string, EarthEntry>,
  todayStr: string,
  apiEvents: EarthEvent[],
  lang: string,
): UpcomingEvent[] {
  const upcoming: UpcomingEvent[] = [];
  const [y, m, d] = todayStr.split("-").map(Number);
  const today = new Date(y ?? 0, (m ?? 1) - 1, d ?? 1);
  for (let i = 1; i <= UPCOMING_WINDOW_DAYS; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() + i);
    const dateStr = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    const mmdd = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    const entry = dataByDate.get(dateStr);
    if (!entry) continue;
    const merged = mergeEvents(entry.events, apiEvents);
    for (const e of merged) {
      upcoming.push({ date: mmdd, icon: e.icon, name: getEventName(e, lang) });
    }
  }
  return upcoming;
}

// ─── Event Name Abbreviation ─────────────────────────────────────────────────

/** Abbreviate a long event name for Widget display. */
export function abbreviateEventName(name: string, maxZhLen = 8, maxEnLen = 12): string {
  const isCJK = (ch: string) => /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch);
  const hasCJK = [...name].some(isCJK);
  if (hasCJK && name.length <= maxZhLen) return name;
  if (!hasCJK && name.length <= maxEnLen) return name;
  const suffixPatterns = [
    /活动正式开启$/, /活动火热进行中$/, /年度大促活动$/,
    /活动限时开放$/, /活动进行中$/, /活动$/,
    /正式开启$/, /已开启$/,
  ];
  for (const pat of suffixPatterns) {
    const stripped = name.replace(pat, "");
    if (stripped.length <= maxZhLen) return stripped;
  }
  if (hasCJK) return name.slice(0, maxZhLen);
  return name.slice(0, maxEnLen);
}

// ─── Summary Counts ───────────────────────────────────────────────────────────

export interface SummaryCounts {
  activeCount: number;
  warmingCount: number;
  upcomingCount: number;
  worldEventCount: number;
  rewardCount: number;
  seasonCountdownDays: number;
}

/** Compute summary counts from a list of events for a given date. */
export function computeSummaryCounts(events: EarthEvent[], date: Date): SummaryCounts {
  let activeCount = 0;
  let warmingCount = 0;
  let upcomingCount = 0;
  let rewardCount = 0;
  for (const event of events) {
    const status = getEventStatus(event, date);
    if (status === "active") { activeCount++; if (event.reward) rewardCount++; }
    else if (status === "warming") { warmingCount++; }
    else if (status === "upcoming") { upcomingCount++; }
  }
  let worldEventCount = 0;
  const solar = Solar.fromYmd(date.getFullYear(), date.getMonth() + 1, date.getDate());
  const lunar = solar.getLunar();
  if (lunar.getJieQi()) { worldEventCount++; }
  const SEASON_BOUNDARIES = ["立春", "立夏", "立秋", "立冬"];
  const nextTerm = getNextSolarTerm(date);
  const nextMs = midnightOf(nextTerm.date);
  const todayMs = midnightOf(date);
  const daysUntil = Math.round((nextMs - todayMs) / MS_PER_DAY);
  if (SEASON_BOUNDARIES.includes(nextTerm.name) && daysUntil <= 7) {
    worldEventCount++;
  }
  worldEventCount = Math.min(2, worldEventCount);
  return { activeCount, warmingCount, upcomingCount, worldEventCount, rewardCount, seasonCountdownDays: daysUntil };
}
