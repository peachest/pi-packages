/**
 * Section Pipeline — Section interface, SectionCtx, CanvasStrategy
 *
 * Implements the Section/Pipeline pattern for composing
 * patch-note body sections without manual concatenation.
 */

import type { EarthEvent, EarthEntry, UpcomingEvent } from "./config-parser.ts";
import { getEventName, getEventDescription } from "./config-parser.ts";
import type { Canvas } from "./engine/canvas.ts";
import type { SeasonTips } from "./season-tips.ts";
import type { ChronicleData } from "./data-loader.ts";
import type { PeaceDayConfig } from "./validation.ts";
import { createCanvas, visibleWidth } from "./render-engine.ts";
import { getEventStatus, MS_PER_DAY } from "./event-status.ts";
import { 
  renderWorldUpdateSection, renderActivitySection, renderChroniclesSection,
  renderUpcomingSection, renderSummaryPanel, filterChronicles,
} from "./section-render.ts";
import { collectCardTexts, computeSummaryCounts } from "./content-compute.ts";

// ─── SectionCtx ──────────────────────────────────────────────────────────────

export interface SectionCtx {
  today: Date;
  lang: string;
  mergedEvents: EarthEvent[];
  todayEntry?: EarthEntry;
  hemisphere: string;
  seasonTips?: SeasonTips;
  chronicles?: ChronicleData;
  peaceDayConfig?: PeaceDayConfig;
  upcomingEvents: UpcomingEvent[];
}

// ─── Section Interface ───────────────────────────────────────────────────────

export interface Section {
  /** Collect text visible widths for canvas size computation. */
  collectWidths(ctx: SectionCtx): number[];
  /** Whether this section should render in the given context. */
  shouldRender(ctx: SectionCtx): boolean;
  /** Render section lines with a computed canvas. */
  render(canvas: Canvas, ctx: SectionCtx): string[];
}

// ─── CanvasStrategy ──────────────────────────────────────────────────────────

export class CanvasStrategy {
  /** Compute optimal canvas width from all renderable sections. */
  static compute(sections: Section[], ctx: SectionCtx): Canvas {
    const widths = sections
      .filter((s) => s.shouldRender(ctx))
      .flatMap((s) => s.collectWidths(ctx));
    const maxWidth = widths.length > 0 ? Math.max(...widths) : 0;
    return createCanvas(maxWidth);
  }
}

// ─── Section Order (用于 Pipeline) ────────────────────────────────────────────

// SECTION_ORDER uses keys matching actual data (config YAML uses "events", "promotion").
// Add new keys here when the data schema expands.
const SECTION_ORDER: string[] = [
  "events", "promotion", "system",
];

const SECTION_TITLES: Record<string, { zh: string; en: string }> = {
  events: { zh: "活动中心", en: "Activity Center" },
  promotion: { zh: "限时促销", en: "Limited-Time Sales" },
  system: { zh: "系统更新", en: "System Updates" },
};

// ─── Section Implementations ─────────────────────────────────────────────────

/** Filter events by section field. */
function filterBySection(events: EarthEvent[], section: string): EarthEvent[] {
  return events.filter((e) => e.section === section);
}

/** World Update — environment, server status, old calendar. */
export class WorldUpdateSection implements Section {
  collectWidths(): number[] { return []; }
  shouldRender(ctx: SectionCtx): boolean { return ctx.seasonTips !== undefined; }
  render(_canvas: Canvas, ctx: SectionCtx): string[] {
    return renderWorldUpdateSection(ctx.today, ctx.lang, ctx.hemisphere, ctx.seasonTips!);
  }
}

/** Activity Center — events-section event cards sorted by status. */
export class ActivitySection implements Section {
  collectWidths(ctx: SectionCtx): number[] {
    const events = filterBySection(ctx.mergedEvents, "events");
    return events.length > 0 ? collectCardTexts(events, ctx.lang, ctx.today).map(visibleWidth) : [];
  }
  shouldRender(ctx: SectionCtx): boolean {
    return filterBySection(ctx.mergedEvents, "events").length > 0;
  }
  render(_canvas: Canvas, ctx: SectionCtx): string[] {
    const events = filterBySection(ctx.mergedEvents, "events");
    return renderActivitySection(events, ctx.lang, ctx.today);
  }
}

/** Promotion / non-events sections — rendered as section-header lists. */
export class PromotionSection implements Section {
  collectWidths(ctx: SectionCtx): number[] {
    const nonEvents = ctx.mergedEvents.filter((e) => e.section !== "events");
    return nonEvents.length > 0 ? collectCardTexts(nonEvents, ctx.lang, ctx.today).map(visibleWidth) : [];
  }
  shouldRender(ctx: SectionCtx): boolean {
    return ctx.mergedEvents.some((e) => e.section !== "events");
  }
  render(_canvas: Canvas, ctx: SectionCtx): string[] {
    const nonEvents = ctx.mergedEvents.filter((e) => e.section !== "events");
    const bySection = new Map<string, EarthEvent[]>();
    for (const e of nonEvents) {
      if (!bySection.has(e.section)) bySection.set(e.section, []);
      bySection.get(e.section)!.push(e);
    }
    const lines: string[] = [];
    for (const sectionKey of SECTION_ORDER) {
      const sectionEvents = bySection.get(sectionKey);
      if (!sectionEvents || sectionEvents.length === 0) continue;
      const title = SECTION_TITLES[sectionKey];
      if (!title) continue;
      lines.push(`━━━ ${ctx.lang === "zh" ? title.zh : title.en} ━━━`);
      for (const event of sectionEvents) {
        const name = getEventName(event, ctx.lang);
        const desc = getEventDescription(event, ctx.lang);
        lines.push(`- ${event.icon} **${name}**`);
        if (desc) lines.push(`  ${desc}`);
      }
      lines.push("");
    }
    return lines;
  }
}

/** Chronicles — historical events matching today's date. */
export class ChroniclesSection implements Section {
  collectWidths(): number[] { return []; }
  shouldRender(ctx: SectionCtx): boolean {
    if (!ctx.chronicles) return false;
    return filterChronicles(ctx.chronicles.entries, ctx.today).length > 0;
  }
  render(_canvas: Canvas, ctx: SectionCtx): string[] {
    const events = filterChronicles(ctx.chronicles!.entries, ctx.today);
    const rendered = renderChroniclesSection(ctx.today, ctx.lang, events);
    return rendered || [];
  }
}

/** Upcoming — future events list. */
export class UpcomingSection implements Section {
  collectWidths(): number[] { return []; }
  shouldRender(ctx: SectionCtx): boolean { return ctx.upcomingEvents.length > 0; }
  render(_canvas: Canvas, ctx: SectionCtx): string[] {
    return renderUpcomingSection(ctx.upcomingEvents, ctx.lang);
  }
}

/** Summary Panel — counts overview. */
export class SummaryPanelSection implements Section {
  collectWidths(): number[] { return []; }
  shouldRender(ctx: SectionCtx): boolean { return ctx.mergedEvents.length > 0; }
  render(_canvas: Canvas, ctx: SectionCtx): string[] {
    const counts = computeSummaryCounts(ctx.mergedEvents, ctx.today);
    return renderSummaryPanel(counts, ctx.lang);
  }
}

// ─── Pipeline ────────────────────────────────────────────────────────────────

/** Default body sections in render order. */
export const bodySections: Section[] = [
  new WorldUpdateSection(),
  new ActivitySection(),
  new PromotionSection(),
  new ChroniclesSection(),
  new UpcomingSection(),
  new SummaryPanelSection(),
];

/**
 * Run the section pipeline: filter, render, flatten.
 * Returns rendered lines for all sections where shouldRender is true.
 */
export function runPipeline(sections: Section[], canvas: Canvas, ctx: SectionCtx): string[] {
  return sections
    .filter((s) => s.shouldRender(ctx))
    .flatMap((s) => s.render(canvas, ctx));
}

/** Default body pipeline. */
export function runBodyPipeline(canvas: Canvas, ctx: SectionCtx): string[] {
  return runPipeline(bodySections, canvas, ctx);
}
