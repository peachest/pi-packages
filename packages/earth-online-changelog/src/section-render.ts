/**
 * Section Render — block rendering functions for patch notes
 *
 * Extracted from notes-renderer.ts.
 * Functions added one at a time via TDD.
 */

import type { Canvas } from "./engine/canvas.ts";
import { boxLine, boxSpacer, boxCenter } from "./engine/box.ts";
import { visibleWidth, padRight } from "./engine/canvas.ts";
import { pad, getWorldDay, formatWeekday, getMoonPhaseDisplay } from "./date-utils.ts";
import { getEventStatus, MS_PER_DAY } from "./event-status.ts";
import { midnightOf, getCurrentSolarTerm, getNextSolarTerm, getSeason, getDayNightLength, getMoonPhaseBar, SOLAR_TERM_EN } from "./world-update.ts";
import { getEventName, getEventDescription } from "./config-parser.ts";
import type { EarthEvent, UpcomingEvent } from "./config-parser.ts";
import type { PeaceDayConfig } from "./validation.ts";
import type { ChronicleEntry } from "./data-loader.ts";
import type { SummaryCounts } from "./content-compute.ts";
import { collectHeaderTexts } from "./content-compute.ts";
import type { SeasonTips } from "./season-tips.ts";
import { getRandomSeasonTip } from "./season-tips.ts";
import { Solar } from "lunar-typescript";

// ─── Hemisphere Detection ─────────────────────────────────────────────────────

/**
 * Detect current server hemisphere.
 * Priority: EARTH_HEMISPHERE env var → default "north".
 */
export function detectHemisphere(): "north" | "south" {
  const env = process.env["EARTH_HEMISPHERE"];
  if (env === "south") return "south";
  return "north";
}

// ─── Footer ──────────────────────────────────────────────────────────────────

/**
 * Render the Footer section for the end of the patch notes.
 */
export function renderFooter(today: Date, lang: string, canvas: Canvas): string[] {
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const nextVersion = `${tomorrow.getFullYear()}.${pad(tomorrow.getMonth() + 1)}.${pad(tomorrow.getDate())}`;

  if (lang === "zh") {
    return [
      boxSpacer(canvas),
      boxLine(canvas, "🌍 地球 Online  ·  EarthOnline Studio"),
      boxLine(canvas, "「世界是我们的游戏场」"),
      boxSpacer(canvas),
      boxLine(canvas, `下一版本: Patch ${nextVersion}  |  预计于次日 UTC+8 06:00 发布`),
      boxLine(canvas, "感谢您今天的冒险，我们明天再见。"),
    ];
  }
  return [
    boxSpacer(canvas),
    boxLine(canvas, "🌍 Earth Online  ·  EarthOnline Studio"),
    boxLine(canvas, "\"The world is our playground\""),
    boxSpacer(canvas),
    boxLine(canvas, `Next Patch: ${nextVersion}  |  ETA tomorrow UTC+8 06:00`),
    boxLine(canvas, "Thank you for your adventure today. See you tomorrow."),
  ];
}


// ─── Upcoming Section ──────────────────────────────────────────────────────────

export function renderUpcomingSection(upcomingEvents: UpcomingEvent[], lang: string): string[] {
  if (upcomingEvents.length === 0) return [];
  const title = lang === "zh" ? "📅 即将到来" : "📅 Upcoming";
  const lines: string[] = [`━━━ ${title} ━━━`];
  for (const ue of upcomingEvents) {
    lines.push(`- ${ue.date} ${ue.icon} ${ue.name}`);
  }
  lines.push("");
  return lines;
}

// ─── Peace Day Section ───────────────────────────────────────────────────────

export function renderPeaceDaySection(lang: string, config?: PeaceDayConfig): string[] {
  if (config) {
    const c = lang === "zh" ? config.zh : config.en;
    return ["  " + c.title, "  " + "─".repeat(60), "", ...c.description.map((line: string) => "  " + line)];
  }
  const divider = "  " + "─".repeat(60);
  if (lang === "zh") {
    return ["  ✨ 和平日 — 自由探索", divider, "", "  本日服务器未安排活动更新。", "  世界正常运行，玩家可自由探索。", "  下一版本更新预计于次日 UTC+8 06:00 发布。"];
  }
  return ["  ✨ Peace Day — Free Exploration", divider, "", "  No scheduled events today.", "  The world is running normally.", "  Next patch expected tomorrow at UTC+8 06:00."];
}

// ─── Tag Priority ────────────────────────────────────────────────────────────

const TAG_PRIORITY: Record<string, number> = { game: 0, tech: 1, culture: 2, internet: 3 };

function getTagPriority(tags?: string[]): number {
  if (!tags || tags.length === 0) return 99;
  let best = 99;
  for (const t of tags) { const p = TAG_PRIORITY[t]; if (p !== undefined && p < best) best = p; }
  return best;
}

// ─── Chronicles ──────────────────────────────────────────────────────────────

export function filterChronicles(entries: ChronicleEntry[], today: Date): ChronicleEntry["events"] {
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  const mmdd = mm + "-" + dd;
  const entry = entries.find((e) => e.date === mmdd);
  if (!entry) return [];
  const sorted = [...entry.events].sort((a, b) => {
    const pa = getTagPriority(a.tags);
    const pb = getTagPriority(b.tags);
    if (pa !== pb) return pa - pb;
    return b.epoch - a.epoch;
  });
  return sorted.slice(0, 2);
}

export function renderChroniclesSection(today: Date, lang: string, events: ChronicleEntry["events"] | undefined): string[] | null {
  if (!events || events.length === 0) return null;
  const m = String(today.getMonth() + 1).padStart(2, "0");
  const d = String(today.getDate()).padStart(2, "0");
  const epochLabel = lang === "zh" ? "纪元" : "Epoch";
  const header = lang === "zh" ? "━━━ 🏛️ 世界编年史 — 旧世记录 ━━━" : "━━━ 🏛️ World Chronicles — Records of the Old World ━━━";
  const lines: string[] = [header, ""];
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    lines.push(`📖 [${epochLabel} ${event.epoch}-${m}-${d}]  ${event.title}`);
    const desc = event.description?.[lang];
    if (desc) lines.push("" + " ".repeat(22) + desc);
    if (i < events.length - 1) lines.push("");
  }
  return lines;
}

// ─── Summary Panel ───────────────────────────────────────────────────────────

const CONTENT_WIDTH = 62;

export function renderSummaryPanel(counts: SummaryCounts, lang: string): string[] {
  const sep = "━".repeat(CONTENT_WIDTH);
  if (lang === "zh") {
    return [`📊 本期概览`, sep, `进行中: ${counts.activeCount}  |  预热中: ${counts.warmingCount}  |  预告: ${counts.upcomingCount}  |  世界事件: ${counts.worldEventCount}`, sep, `活跃活动: ${counts.activeCount + counts.warmingCount}  ·  可领取奖励: ${counts.rewardCount}  ·  季节切换倒计时: ${counts.seasonCountdownDays} 天`];
  }
  return [`📊 This Edition`, sep, `Active: ${counts.activeCount}  |  Warming: ${counts.warmingCount}  |  Upcoming: ${counts.upcomingCount}  |  World Events: ${counts.worldEventCount}`, sep, `Top-level active: ${counts.activeCount + counts.warmingCount}  ·  Claimable rewards: ${counts.rewardCount}  ·  season change countdown: ${counts.seasonCountdownDays} days`];
}


const PROGRESS_BAR_SEGMENTS = 10;

// ─── Progress Bar ────────────────────────────────────────────────────────────

export function renderProgressBar(status: "active" | "warming" | "upcoming" | "ended", consumed: number, total: number, lang: string): string {
  if (status === "ended") return lang === "zh" ? "▓▓▓▓▓▓▓▓▓▓  活动已结束" : "▓▓▓▓▓▓▓▓▓▓  Ended";
  if (status === "warming" || status === "upcoming") {
    const days = consumed;
    const label = lang === "zh" ? `距正式开启 ${days} 天` : `${days} days until start`;
    return `░░░░░░░░░░  ${label}`;
  }
  const filled = total > 0 ? Math.round((consumed / total) * PROGRESS_BAR_SEGMENTS) : 0;
  const bar = "█".repeat(filled) + "░".repeat(PROGRESS_BAR_SEGMENTS - filled);
  const remaining = total - consumed;
  const label = lang === "zh" ? `剩余 ${remaining} 天` : `${remaining} days remaining`;
  return `${bar}  ${label}`;
}


// ─── Header ──────────────────────────────────────────────────────────────────

export function buildHeader(date: Date, lang: string, hasEvents: boolean, eventName: string | undefined, canvas: Canvas): string[] {
  const texts = collectHeaderTexts(date, lang, hasEvents, eventName);
  const lines: string[] = [];
  lines.push(boxCenter(canvas, texts[0]!));
  lines.push(boxSpacer(canvas));
  for (let i = 1; i < texts.length; i++) {
    lines.push(boxLine(canvas, texts[i]!));
  }
  return lines;
}
export function renderEventCard(event: EarthEvent, lang: string, today: Date): string[] {
  const innerW = CONTENT_WIDTH;
  const lines: string[] = [];
  const name = getEventName(event, lang);
  const status = getEventStatus(event, today);

  // Status emojis and labels
  const statusEmoji: Record<string, string> = {
    active: "🟢", warming: "🟡", upcoming: "🟠", ended: "🔴",
  };
  const statusLabel: Record<string, Record<string, string>> = {
    zh: { active: "活动进行中", warming: "预热中", upcoming: "即将开启", ended: "活动已结束" },
    en: { active: "Active", warming: "Pre-launch", upcoming: "Upcoming", ended: "Ended" },
  };

  const typeLabel: Record<string, Record<string, string>> = {
    zh: { seasonal: "季节性活动", promotion: "促销活动", limited: "限时活动", recurring: "周期性活动", special: "特别活动" },
    en: { seasonal: "Seasonal", promotion: "Promotion", limited: "Limited", recurring: "Recurring", special: "Special" },
  };

  // ── Title line ──
  const titleContent = ` ${event.icon} ${name} `;
  const titleVis = visibleWidth(titleContent);
  const dashes = "─".repeat(Math.max(0, innerW - titleVis));
  lines.push(`┌─${titleContent}${dashes}┐`);

  // ── Progress bar line (only if dates exist) ──
  const hasDates = event.startDate || event.endDate;
  if (hasDates) {
    lines.push(`│ ${"─".repeat(innerW)} │`);

    let progressLine = "";
    if (status === "active" && event.startDate && event.endDate) {
      const startMs = new Date(event.startDate + "T00:00:00").getTime();
      const endMs = new Date(event.endDate + "T00:00:00").getTime();
      const todayMs = midnightOf(today);
      const totalDays = Math.round((endMs - startMs) / MS_PER_DAY);
      const consumed = Math.round((todayMs - startMs) / MS_PER_DAY);
      const remaining = totalDays - consumed;
      const filled = totalDays > 0 ? Math.round((consumed / totalDays) * 10) : 0;
      const visualBar = "█".repeat(filled) + "░".repeat(PROGRESS_BAR_SEGMENTS - filled);
      const endStr = event.endDate.replace(/-/g, ".");
      const remainingLabel = lang === "zh" ? `剩余: ${remaining} 天` : `${remaining}d remaining`;
      const todayLabel = lang === "zh" ? "本日 →" : "Today →";
      progressLine = `⏳ ${remainingLabel}  |  ${visualBar}  ${todayLabel} ${endStr}`;
    } else if (status === "warming" || status === "upcoming") {
      const startMs = event.startDate ? new Date(event.startDate + "T00:00:00").getTime() : 0;
      const todayMs = midnightOf(today);
      const daysUntil = Math.round((startMs - todayMs) / MS_PER_DAY);
      const visualBar = "░".repeat(PROGRESS_BAR_SEGMENTS);
      const countdownLabel = lang === "zh" ? `距正式开启 ${daysUntil} 天` : `${daysUntil} days until start`;
      const prefix = lang === "zh" ? "⏳ 预热倒计时:" : "⏳ Countdown:";
      progressLine = `${prefix} ${countdownLabel}  |  ${visualBar}`;
    } else if (status === "ended") {
      const bar = renderProgressBar("ended", 0, 0, lang);
      progressLine = `📅 ${bar}`;
    }
    lines.push(`│ ${padRight(progressLine, innerW)} │`);
    lines.push(`│ ${"─".repeat(innerW)} │`);
  }

  // ── Empty spacer ──
  lines.push(`│ ${" ".repeat(innerW)} │`);

  // ── Description ──
  const desc = getEventDescription(event, lang);
  if (desc) {
    lines.push(`│ ${padRight(desc, innerW)} │`);
  }

  // ── Warming/upcoming: formal start date notice ──
  if ((status === "warming" || status === "upcoming") && event.startDate) {
    const startStr = event.startDate.replace(/-/g, ".");
    const notice = lang === "zh"
      ? `正式活动将于 ${startStr} 上线`
      : `Event launches on ${startStr}`;
    lines.push(`│ ${padRight(notice, innerW)} │`);
  }

  // ── Reward ──
  if (event.reward) {
    const rewardPrefix = lang === "zh" ? "🎁 活动奖励:" : "🎁 Reward:";
    lines.push(`│ ${padRight(`${rewardPrefix} ${event.reward}`, innerW)} │`);
  }

  // ── Empty spacer ──
  lines.push(`│ ${" ".repeat(innerW)} │`);

  // ── Tag + status line ──
  const tagText = `🏷️ #${typeLabel[lang]?.[event.type] || event.type}  ${statusEmoji[status]} ${statusLabel[lang]?.[status] || status}`;
  lines.push(`│ ${padRight(tagText, innerW)} │`);

  // ── Date line ──
  if (hasDates) {
    if (status === "ended" && event.endDate) {
      const endMmdd = event.endDate.slice(5);
      const dateLabel = lang === "zh" ? "📅 活动已结束:" : "📅 Ended:";
      lines.push(`│ ${padRight(`${dateLabel} ${endMmdd}  (UTC+8)`, innerW)} │`);
    } else if (event.startDate && event.endDate) {
      const startMmdd = event.startDate.slice(5);
      const endMmdd = event.endDate.slice(5);
      const dateLabel = lang === "zh" ? "📅 活动开放:" : "📅 Open:";
      lines.push(`│ ${padRight(`${dateLabel} ${startMmdd} → ${endMmdd}  (UTC+8)`, innerW)} │`);
    } else if (event.startDate) {
      const startMmdd = event.startDate.slice(5);
      const dateLabel = lang === "zh" ? "📅 正式开启:" : "📅 Starts:";
      lines.push(`│ ${padRight(`${dateLabel} ${startMmdd}  (UTC+8)`, innerW)} │`);
    }
  }

  // ── Bottom border ──
  lines.push(`└${"─".repeat(innerW)}┘`);

  return lines;
}
export function renderActivitySection(events: EarthEvent[], lang: string, today: Date): string[] {
  if (events.length === 0) return [];

  const todayMs = midnightOf(today);

  // Status priority for sorting
  const statusOrder: Record<string, number> = {
    active: 0, warming: 1, upcoming: 2, ended: 3,
  };

  const sorted = [...events].sort((a, b) => {
    const sa = getEventStatus(a, today);
    const sb = getEventStatus(b, today);

    // Primary: status priority
    const orderDiff = (statusOrder[sa] ?? 99) - (statusOrder[sb] ?? 99);
    if (orderDiff !== 0) return orderDiff;

    // Secondary: within same status
    if (sa === "active") {
      // By remaining days ascending
      const remA = a.endDate ? Math.round((new Date(a.endDate + "T00:00:00").getTime() - todayMs) / MS_PER_DAY) : Infinity;
      const remB = b.endDate ? Math.round((new Date(b.endDate + "T00:00:00").getTime() - todayMs) / MS_PER_DAY) : Infinity;
      return remA - remB;
    }
    if (sa === "warming" || sa === "upcoming") {
      // By days until start ascending
      const untilA = a.startDate ? Math.round((new Date(a.startDate + "T00:00:00").getTime() - todayMs) / MS_PER_DAY) : Infinity;
      const untilB = b.startDate ? Math.round((new Date(b.startDate + "T00:00:00").getTime() - todayMs) / MS_PER_DAY) : Infinity;
      return untilA - untilB;
    }
    if (sa === "ended") {
      // By endDate descending
      const endA = a.endDate ? new Date(a.endDate + "T00:00:00").getTime() : 0;
      const endB = b.endDate ? new Date(b.endDate + "T00:00:00").getTime() : 0;
      return endB - endA;
    }
    return 0;
  });

  const lines: string[] = [];

  // Section header
  const activeCount = sorted.filter((e) => getEventStatus(e, today) === "active").length;
  const header = lang === "zh"
    ? `📋 活动中心 (${activeCount} 项活跃)`
    : `📋 Activity Center (${activeCount} active)`;
  const headerSep = "━".repeat(CONTENT_WIDTH);
  lines.push(header);
  lines.push(headerSep);

  // Cards
  for (const event of sorted) {
    lines.push(...renderEventCard(event, lang, today));
    lines.push(""); // blank line between cards
  }

  return lines;
}

// ─── World Update Section ─────────────────────────────────────────────────────

/** Season display labels keyed by English season name. */
const SEASON_LABELS: Record<string, { zh: string; en: string }> = {
  spring: { zh: "春季", en: "Spring" },
  summer: { zh: "夏季", en: "Summer" },
  autumn: { zh: "秋季", en: "Autumn" },
  winter: { zh: "冬季", en: "Winter" },
};

/** Hemisphere flip: south maps the opposite season. */
const SOUTH_FLIP: Record<string, string> = {
  spring: "autumn", summer: "winter", autumn: "spring", winter: "summer",
};

export function renderWorldUpdateSection(today: Date, lang: string, hemisphere: string, seasonTips: SeasonTips): string[] {
  const lines: string[] = [];
  const currentTerm = getCurrentSolarTerm(today);
  const nextTerm = getNextSolarTerm(today);
  const season = getSeason(today);
  const { dayHours, nightHours } = getDayNightLength(today);
  const moonBar = getMoonPhaseBar(today);
  const worldDay = getWorldDay(today);
  const todayMs = midnightOf(today);
  const nextMs = new Date(nextTerm.date).getTime();
  const daysUntil = Math.round((nextMs - todayMs) / MS_PER_DAY);
  const nextDate = new Date(nextTerm.date);
  const nextDateLabel = `${nextDate.getFullYear()}.${pad(nextDate.getMonth() + 1)}.${pad(nextDate.getDate())}`;
  const displaySeason = hemisphere === "south" ? (SOUTH_FLIP[season] || season) : season;
  const seasonLabel = SEASON_LABELS[displaySeason] || SEASON_LABELS.spring;
  const hemiLabelZh = hemisphere === "south" ? "南半球服务器" : "北半球服务器";
  const hemiLabelEn = hemisphere === "south" ? "Southern Hemisphere" : "Northern Hemisphere";
  const currentTermLabel = lang === "zh" ? currentTerm : (SOLAR_TERM_EN[currentTerm] || currentTerm);
  const nextTermLabel = lang === "zh" ? nextTerm.name : (SOLAR_TERM_EN[nextTerm.name] || nextTerm.name);
  const buff = getRandomSeasonTip(seasonTips, displaySeason, "buff", lang);
  const debuff = getRandomSeasonTip(seasonTips, displaySeason, "debuff", lang);
  const filledBlocks = "█".repeat(moonBar.filled);
  const emptyBlocks = "░".repeat(12 - moonBar.filled);
  const moonVisual = `${filledBlocks}${emptyBlocks}`;
  const header = lang === "zh" ? "🌿 世界更新 — 环境 & 服务器状态" : "🌿 World Update — Environment & Server Status";
  lines.push(`━━━ ${header} ━━━`);
  lines.push("");
  lines.push(lang === "zh" ? "🌱 【世界环境更新】" : "🌱 【Environment Update】");
  lines.push(lang === "zh" ? `   当前区域节气: ${currentTermLabel} → ${nextTermLabel}（纪元 ${nextDateLabel} 切换）` : `   Current solar term: ${currentTermLabel} → ${nextTermLabel} (Epoch ${nextDateLabel})`);
  lines.push(lang === "zh" ? `   ${hemiLabelZh}:  ${seasonLabel.zh}模式` : `   ${hemiLabelEn}:  ${seasonLabel.en} Mode`);
  lines.push(lang === "zh" ? `   ▷ 昼长: ≈${dayHours}h  ·  夜长: ≈${nightHours}h` : `   ▷ Day length: ≈${dayHours}h  ·  Night length: ≈${nightHours}h`);
  if (buff && debuff) {
    const bLabel = lang === "zh" ? "昼行性玩家" : "Diurnal players";
    const dLabel = lang === "zh" ? "夜行性玩家" : "Nocturnal players";
    lines.push(`   ▷ ${bLabel}:  ${buff}  |  ${dLabel}:  ${debuff}`);
  } else if (buff) lines.push(`   ▷ ${lang === "zh" ? "昼行性玩家" : "Diurnal players"}:  ${buff}`);
  else if (debuff) lines.push(`   ▷ ${lang === "zh" ? "夜行性玩家" : "Nocturnal players"}:  ${debuff}`);
  lines.push("");
  lines.push(lang === "zh" ? "🌐 【服务器状态】" : "🌐 【Server Status】");
  lines.push(lang === "zh" ? "   时区: UTC+8 (亚洲服务器组)" : "   Timezone: UTC+8 (Asia Server Group)");
  lines.push(`   ${lang === "zh" ? "本日世界刻" : "Today's World Day"}: ${worldDay} / 365`);
  lines.push(`   ${lang === "zh" ? "季节变更倒计时" : "Season change countdown"}: ${lang === "zh" ? `${daysUntil} 天` : `${daysUntil} days`} (${nextTermLabel})`);
  lines.push("");
  lines.push(lang === "zh" ? "📜 【旧历记录】" : "📜 【Old Calendar Record】");
  const lunarSolar = Solar.fromYmd(today.getFullYear(), today.getMonth() + 1, today.getDate());
  const lunarInfo = lunarSolar.getLunar();
  const ganzhiYear = lunarInfo.getYearInGanZhi();
  const lunarMonth = lunarInfo.getMonthInChinese();
  const lunarDay = lunarInfo.getDayInChinese();
  const oldCalZh = `副本历: ${ganzhiYear}年${lunarMonth}月${lunarDay}`;
  const oldCalEn = `Lunar calendar: ${ganzhiYear}-${lunarMonth}-${lunarDay}`;
  lines.push(`   · ${lang === "zh" ? oldCalZh : oldCalEn}`);
  lines.push(`   · ${lang === "zh" ? "月相近度" : "Moon phase"}: ${moonBar.phaseName}  ${moonVisual}  (${moonBar.percent}%)`);
  lines.push(`   · ${lang === "zh" ? `下一主要节气: ${nextTermLabel}  (${daysUntil} 日后)` : `Next major solar term: ${nextTermLabel}  (in ${daysUntil} days)`}`);
  lines.push("");
  return lines;
}
