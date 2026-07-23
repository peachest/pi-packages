/**
 * Patch Notes Orchestrator — orchestration functions for building patch notes
 *
 * Extracted from notes-renderer.ts.
 */

import type { EarthEvent, EarthEntry, UpcomingEvent } from "./config-parser.ts";
import { getEventName } from "./config-parser.ts";
import { getNextSolarTerm, midnightOf, SOLAR_TERM_EN } from "./world-update.ts";
import { visibleWidth, padRight, createCanvas, boxTop, boxSep, boxBottom, boxCenter, boxLine, boxSpacer } from "./render-engine.ts";
import type { Canvas } from "./render-engine.ts";
import type { SeasonTips } from "./season-tips.ts";
import type { ChronicleData } from "./data-loader.ts";
import type { PeaceDayConfig } from "./validation.ts";
import { getTodayDateString, getVersionString } from "./date-utils.ts";
import { getEventStatus, MS_PER_DAY } from "./event-status.ts";
import { collectHeaderTexts, collectCardTexts, mergeEvents, isPeaceDay, buildUpcomingEvents, abbreviateEventName, computeSummaryCounts } from "./content-compute.ts";
import { detectHemisphere, buildHeader, renderPeaceDaySection, renderFooter } from "./section-render.ts";
import { CanvasStrategy, runBodyPipeline, bodySections } from "./section-pipeline.ts";
import type { SectionCtx } from "./section-pipeline.ts";

// ─── detectLanguage ──────────────────────────────────────────────────────────

export function detectLanguage(): string {
  const override = process.env["EARTH_LANG"];
  if (override === "zh" || override === "en") return override;
  const locale = process.env["LANG"] || "";
  if (locale.startsWith("zh")) return "zh";
  return "en";
}

// ─── buildPatchNotes ─────────────────────────────────────────────────────────

export function buildPatchNotes(
  todayEntry: EarthEntry | undefined,
  apiEvents: EarthEvent[],
  upcomingEvents: UpcomingEvent[],
  lang: string,
  date: Date = new Date(),
  hemisphere?: string,
  seasonTips?: SeasonTips,
  chronicles?: ChronicleData,
  peaceDayConfig?: PeaceDayConfig,
): string {
  const mergedEvents = mergeEvents(
    todayEntry?.events ?? [],
    apiEvents,
  );

  const hasEvents = mergedEvents.some((e) => e.section !== "system");
  const firstNonSystemEvent = mergedEvents.find((e) => e.section !== "system");
  const eventName = firstNonSystemEvent ? getEventName(firstNonSystemEvent, lang) : undefined;
  const hemi = hemisphere || detectHemisphere();

  // Build SectionCtx for Pipeline
  const ctx: SectionCtx = {
    today: date,
    lang,
    mergedEvents,
    todayEntry,
    hemisphere: hemi,
    seasonTips,
    chronicles,
    peaceDayConfig,
    upcomingEvents,
  };

  // Compute canvas from header + body widths
  const headerTexts = collectHeaderTexts(date, lang, hasEvents, eventName);
  const bodyCanvas = CanvasStrategy.compute(bodySections, ctx);
  const headerWidth = Math.max(...headerTexts.map(visibleWidth), 0);
  const canvas = createCanvas(Math.max(headerWidth, bodyCanvas.W));
  const headerLines = buildHeader(date, lang, hasEvents, eventName, canvas);

  // Assemble output
  const lines: string[] = [];
  lines.push(boxTop(canvas));
  lines.push(...headerLines);
  lines.push(boxSep(canvas));
  lines.push(boxSpacer(canvas));

  if (mergedEvents.length === 0) {
    // Peace day path
    lines.push(...renderPeaceDaySection(lang, peaceDayConfig));
  } else if (todayEntry?.highlight) {
    lines.push("━━━ ✨ 版本亮点 ━━━");
    lines.push(todayEntry.highlight);
    lines.push("");
  }

  // Body sections via Pipeline
  lines.push(...runBodyPipeline(canvas, ctx));

  lines.push(boxSpacer(canvas));
  lines.push(boxSep(canvas));
  lines.push(...renderFooter(date, lang, canvas));
  lines.push(boxSpacer(canvas));
  lines.push(boxBottom(canvas));

  return lines.join("\n");
}

// ─── Widget Builder ───────────────────────────────────────────────────────────

const WIDGET_MAX_FIELDS = 4;

/**
 * Build the widget content (single-line format, v2).
 */
export function buildWidgetContent(
  todayEntry: EarthEntry | undefined,
  apiEvents: EarthEvent[],
  lang: string,
): string[] {
  const now = new Date();
  const version = getVersionString().replace("Patch ", "");
  const versionField = `🌍 v${version}`;

  const mergedEvents = mergeEvents(
    todayEntry?.events ?? [],
    apiEvents,
  );

  if (isPeaceDay(todayEntry, apiEvents)) {
    if (lang === "zh") {
      return [`${versionField} | ✨ 和平日 · 自由探索`];
    }
    return [`${versionField} | ✨ Peace Day · Free Exploration`];
  }

  const nowMs = midnightOf(now);
  const sorted = [...mergedEvents].sort((a, b) => {
    const sa = getEventStatus(a, now);
    const sb = getEventStatus(b, now);
    const prio: Record<string, number> = { active: 0, warming: 1, upcoming: 2, ended: 3 };
    const dp = (prio[sa] ?? 99) - (prio[sb] ?? 99);
    if (dp !== 0) return dp;

    if (sa === "active") {
      const remA = a.endDate ? Math.round((new Date(a.endDate + "T00:00:00").getTime() - nowMs) / MS_PER_DAY) : Infinity;
      const remB = b.endDate ? Math.round((new Date(b.endDate + "T00:00:00").getTime() - nowMs) / MS_PER_DAY) : Infinity;
      return remA - remB;
    }
    if (sa === "warming" || sa === "upcoming") {
      const untilA = a.startDate ? Math.round((new Date(a.startDate + "T00:00:00").getTime() - nowMs) / MS_PER_DAY) : Infinity;
      const untilB = b.startDate ? Math.round((new Date(b.startDate + "T00:00:00").getTime() - nowMs) / MS_PER_DAY) : Infinity;
      return untilA - untilB;
    }
    return 0;
  });

  const fields: string[] = [versionField];
  const usedFields = new Set<string>();

  for (const event of sorted) {
    if (fields.length >= WIDGET_MAX_FIELDS) break;

    const name = abbreviateEventName(getEventName(event, lang));
    const status = getEventStatus(event, now);
    const icon = event.icon;

    let field: string;
    if (status === "active") {
      if (event.endDate) {
        const endMs = new Date(event.endDate + "T00:00:00").getTime();
        const remaining = Math.round((endMs - nowMs) / MS_PER_DAY);
        const daysLabel = lang === "zh" ? `剩${remaining}天` : `${remaining}d left`;
        field = `${icon} ${name}${daysLabel} 🟢`;
      } else {
        field = `${icon} ${name} 🟢`;
      }
    } else if (status === "warming") {
      const warmLabel = lang === "zh" ? "预热" : "warming";
      field = `${icon} ${name}${warmLabel} 🟡`;
    } else if (status === "upcoming") {
      field = `${icon} ${name} 🟠`;
    } else {
      continue;
    }

    if (!usedFields.has(name)) {
      usedFields.add(name);
      fields.push(field);
    }
  }

  if (fields.length < WIDGET_MAX_FIELDS) {
    const nextTerm = getNextSolarTerm(now);
    const nextMs = midnightOf(nextTerm.date);
    const daysUntil = Math.round((nextMs - nowMs) / MS_PER_DAY);
    if (daysUntil <= 7) {
      const termLabel = lang === "zh" ? nextTerm.name : (SOLAR_TERM_EN[nextTerm.name] || nextTerm.name);
      const countdownText = lang === "zh" ? `倒数${daysUntil}天` : `${daysUntil}d`;
      fields.push(`🌿 ${termLabel}${countdownText}`);
    }
  }

  const visibleNames = new Set(
    fields.slice(1).map((f) => {
      const name = sorted.find((e) => f.includes(abbreviateEventName(getEventName(e, lang))));
      return name ? abbreviateEventName(getEventName(name, lang)) : "";
    }),
  );
  const remainingCount = sorted.filter((e) => {
    const status = getEventStatus(e, now);
    if (status === "ended") return false;
    return !visibleNames.has(abbreviateEventName(getEventName(e, lang)));
  }).length;

  if (remainingCount > 0) {
    fields.push(`+${remainingCount} more`);
  }

  return [fields.join(" | ")];
}
