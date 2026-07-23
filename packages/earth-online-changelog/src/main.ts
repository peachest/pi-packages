/**
 * Main — Earth Online Changelog
 *
 * Pi extension entry point.
 * Orchestrates data loading, festival API, notes rendering, and widget display.
 */

import type { ExtensionAPI, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

import { getExtensionDir, loadEarthData, loadEarthDataRange, loadChronicles, loadPeaceDayConfig } from "./data-loader.ts";
import type { SessionCtx } from "./state.ts";
import { persistState, wasShownToday } from "./state.ts";
import {
  buildPatchNotes,
  buildWidgetContent,
  detectLanguage,
} from "./patch-notes-orch.ts";
import { buildUpcomingEvents } from "./content-compute.ts";
import { getVersionString, getTodayDateString } from "./date-utils.ts";
import { detectHemisphere } from "./section-render.ts";
import { loadSeasonTips } from "./season-tips.ts";
import { getFestivalEvents } from "./provider/festival.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const WIDGET_ID = "earth-online";

// ─── Extension Entry ──────────────────────────────────────────────────────────

export default function earthOnline(pi: ExtensionAPI) {
  const extensionDir = getExtensionDir();

  // Pre-load chronicle data for command completions (static, rarely changes)
  const chroniclesForCompletion = loadChronicles(extensionDir);

  /**
   * Core function: fetch API data, build display, set widget, return markdown.
   * Reads data from disk lazily on each call (never stale).
   *
   * @param overrideDate — optional Date to use instead of "now" (for testing).
   */
  async function produceChangelog(ctx: SessionCtx, setWidget = true, overrideDate?: Date) {
    const now = overrideDate ?? new Date();
    const todayStr = getTodayDateString(now);
    const version = getVersionString(now);
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;

    const earthData = loadEarthData(extensionDir, currentYear, currentMonth);
    const todayEntry = earthData.entries.find((e) => e.date === todayStr);

    const nextMonth = currentMonth === 12 ? 1 : currentMonth + 1;
    const nextYear = currentMonth === 12 ? currentYear + 1 : currentYear;
    const dataByDate = loadEarthDataRange(
      extensionDir,
      currentYear,
      currentMonth,
      nextYear,
      nextMonth,
    );

    const lang = detectLanguage();

    const apiEvents = await getFestivalEvents(todayStr);

    const hemisphere = detectHemisphere();
    const seasonTips = loadSeasonTips(extensionDir);
    const chronicles = loadChronicles(extensionDir);
    const peaceDayConfig = loadPeaceDayConfig(extensionDir);

    const upcomingEvents = buildUpcomingEvents(
      dataByDate,
      todayStr,
      [],
      lang,
    );

    const markdown = buildPatchNotes(todayEntry, apiEvents, upcomingEvents, lang, now, hemisphere, seasonTips, chronicles, peaceDayConfig);

    if (setWidget && ctx?.hasUI) {
      const widgetContent = buildWidgetContent(todayEntry, apiEvents, lang);
      ctx.ui.setWidget(WIDGET_ID, widgetContent);
    }

    return { markdown, apiEvents, lang, todayStr, version };
  }

  // ── Register /earth command ──────────────────────────────────────────────

  pi.registerCommand("earth", {
    description: "显示地球 Online 今日更新 / Show Earth Online daily changelog. 支持 /earth YYYY-MM-DD 指定日期",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const today = new Date();
      const suggestions: { value: string; label: string }[] = [];

      // Relative dates
      const pad = (n: number) => String(n).padStart(2, "0");
      const y = today.getFullYear();
      const m = pad(today.getMonth() + 1);
      const d = pad(today.getDate());

      const relatives = [
        { offset: 0, label: "今天/today" },
        { offset: -1, label: "昨天/yesterday" },
        { offset: 1, label: "明天/tomorrow" },
      ];
      for (const rel of relatives) {
        const dt = new Date(today);
        dt.setDate(dt.getDate() + rel.offset);
        const val = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
        suggestions.push({ value: val, label: `${val} (${rel.label})` });
      }

      // Notable solar terms in the next ~60 days
      const notableTerms = [
        { date: "2026-06-05", label: "芒种" },
        { date: "2026-06-21", label: "夏至" },
        { date: "2026-07-07", label: "小暑" },
        { date: "2026-07-22", label: "大暑" },
        { date: "2026-08-07", label: "立秋" },
        { date: "2026-08-23", label: "处暑" },
        { date: "2026-09-07", label: "白露" },
        { date: "2026-09-23", label: "秋分" },
        { date: "2026-10-08", label: "寒露" },
        { date: "2026-10-23", label: "霜降" },
        { date: "2026-11-07", label: "立冬" },
        { date: "2026-11-22", label: "小雪" },
        { date: "2026-12-07", label: "大雪" },
        { date: "2026-12-21", label: "冬至" },
      ];
      for (const nt of notableTerms) {
        suggestions.push({ value: nt.date, label: `${nt.date} (${nt.label})` });
      }

      // Special dates
      suggestions.push(
        { value: "2026-01-01", label: "2026-01-01 (元旦)" },
        { value: "2026-06-01", label: "2026-06-01 (儿童节)" },
        { value: "2026-06-18", label: "2026-06-18 (618)" },
        { value: "2026-10-01", label: "2026-10-01 (国庆节)" },
        { value: "2026-12-25", label: "2026-12-25 (圣诞节)" },
      );

      // Chronicle dates — historically notable days
      for (const entry of chroniclesForCompletion.entries) {
        const [mm, dd] = entry.date.split("-");
        const val = `${y}-${mm}-${dd}`;
        const titles = entry.events.slice(0, 2).map((e) => e.title).join(" / ");
        suggestions.push({ value: val, label: `${val} (📖 ${titles})` });
      }

      // Filter by prefix
      const filtered = prefix
        ? suggestions.filter((s) => s.value.startsWith(prefix))
        : suggestions;

      return filtered.length > 0 ? filtered : null;
    },
    handler: async (_args, ctx) => {
      let overrideDate: Date | undefined;
      const rawArg = (_args as string | undefined)?.trim();
      if (rawArg) {
        // Accept YYYY-MM-DD or YYYY.MM.DD format
        const dateStr = rawArg.replace(/\./g, "-");
        const parsed = new Date(dateStr + "T00:00:00");
        if (isNaN(parsed.getTime())) {
          const lang = detectLanguage();
          const msg = lang === "zh"
            ? `无效日期: "${rawArg}"，请使用 YYYY-MM-DD 格式（如 /earth 2026-12-25）`
            : `Invalid date: "${rawArg}", use YYYY-MM-DD format (e.g. /earth 2026-12-25)`;
          ctx.ui.notify(msg, "warning");
          return;
        }
        overrideDate = parsed;
      }

      const { markdown, lang, version } = await produceChangelog(ctx, true, overrideDate);
      pi.sendMessage({
        customType: "earth-online",
        content: markdown,
        display: true,
      }, { triggerTurn: false });
      const langTitle = lang === "zh" ? "🌍 地球在线" : "🌍 Earth Online";
      ctx.ui.notify(`${langTitle} ${version} loaded`, "info");

      // Persist today state only when showing today (not override dates)
      if (!overrideDate) {
        persistState(pi, getTodayDateString());
      }
    },
  });

  // ── Auto-trigger on first daily session ──────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    if ((_event as SessionStartEvent).reason === "resume") return;

    const now = new Date();
    const todayStrCheck = getTodayDateString(now);

    if (wasShownToday(ctx, todayStrCheck)) return;

    const { apiEvents, lang, version } = await produceChangelog(ctx, true);
    const langTitle = lang === "zh" ? "🌍 地球在线" : "🌍 Earth Online";
    ctx.ui.notify(`${langTitle} ${version} loaded`, "info");
    persistState(pi, todayStrCheck);
  });

  // ── Session tree navigation: restore widget ──────────────────────────────

  pi.on("session_tree", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    const now = new Date();
    const todayStrCheck = getTodayDateString(now);
    if (wasShownToday(ctx, todayStrCheck)) {
      const earthData = loadEarthData(extensionDir, now.getFullYear(), now.getMonth() + 1);
      const todayEntry = earthData.entries.find((e) => e.date === todayStrCheck);
      const lang = detectLanguage();
      const apiEvents = await getFestivalEvents(todayStrCheck);
      const content = buildWidgetContent(todayEntry, apiEvents, lang);
      ctx.ui.setWidget(WIDGET_ID, content);
    }
  });
}
