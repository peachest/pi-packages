/**
 * Tests for section-pipeline.ts — Section interface, classes, CanvasStrategy, Pipeline
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const {
  CanvasStrategy, WorldUpdateSection, ActivitySection, PromotionSection,
  ChroniclesSection, UpcomingSection, SummaryPanelSection,
  runPipeline, runBodyPipeline,
} = await import("./section-pipeline.ts");
import type { Section, SectionCtx } from "./section-pipeline.ts";

function makeCtx(overrides?: Partial<SectionCtx>): SectionCtx {
  return {
    today: new Date(2026, 5, 1),
    lang: "zh",
    mergedEvents: [],
    hemisphere: "north",
    upcomingEvents: [],
    ...overrides,
  };
}

describe("Section interface", () => {
  it("Section type can be implemented", () => {
    const s: Section = {
      collectWidths() { return [10]; },
      shouldRender() { return true; },
      render() { return ["line"]; },
    };
    assert.equal(typeof s.collectWidths, "function");
  });
});

describe("CanvasStrategy", () => {
  it("returns min-width canvas for empty sections", () => {
    const canvas = CanvasStrategy.compute([], makeCtx());
    assert.ok(canvas.W >= 50);
  });
  it("filters out non-renderable sections", () => {
    const s: Section = { collectWidths() { return [100]; }, shouldRender() { return false; }, render() { return []; } };
    const canvas = CanvasStrategy.compute([s], makeCtx());
    assert.ok(canvas.W < 100);
  });
});

describe("WorldUpdateSection", () => {
  it("does not render without seasonTips", () => {
    const s = new WorldUpdateSection();
    assert.equal(s.shouldRender(makeCtx()), false);
  });
  it("renders with seasonTips", () => {
    const s = new WorldUpdateSection();
    const tips = { spring: { buffs: [], debuffs: [] }, summer: { buffs: [], debuffs: [] }, autumn: { buffs: [], debuffs: [] }, winter: { buffs: [], debuffs: [] } };
    assert.equal(s.shouldRender(makeCtx({ seasonTips: tips })), true);
    const lines = s.render({ W: 50 } as Canvas, makeCtx({ seasonTips: tips }));
    assert.match(lines.join("\n"), /世界环境更新/);
  });
});

describe("ActivitySection", () => {
  it("does not render without events-section events", () => {
    assert.equal(new ActivitySection().shouldRender(makeCtx()), false);
  });
  it("renders with events-section events", () => {
    const events = [{ name: "活动A", type: "seasonal", icon: "🎮", section: "events", startDate: "2026-06-01", endDate: "2026-06-10" }] as any;
    assert.equal(new ActivitySection().shouldRender(makeCtx({ mergedEvents: events })), true);
  });
});

describe("PromotionSection", () => {
  it("does not render without non-events events", () => {
    assert.equal(new PromotionSection().shouldRender(makeCtx()), false);
  });
  it("renders with promotion-section events", () => {
    const events = [{ name: "促销", type: "promotion", icon: "🛒", section: "promotion" }] as any;
    const s = new PromotionSection();
    assert.equal(s.shouldRender(makeCtx({ mergedEvents: events })), true);
    const lines = s.render({ W: 50 } as Canvas, makeCtx({ mergedEvents: events }));
    assert.match(lines.join("\n"), /限时促销/);
  });
  it("renders system-section events", () => {
    const events = [{ name: "系统", type: "recurring", icon: "🔧", section: "system" }] as any;
    assert.equal(new PromotionSection().shouldRender(makeCtx({ mergedEvents: events })), true);
  });
});

describe("ChroniclesSection", () => {
  it("does not render without chronicles", () => {
    assert.equal(new ChroniclesSection().shouldRender(makeCtx()), false);
  });
  it("renders with matching chronicle data", () => {
    const chronicles = { entries: [{ date: "06-01", events: [{ title: "旧事", epoch: 2020, tags: ["game"], description: { zh: "描述", en: "desc" } }] }] };
    assert.equal(new ChroniclesSection().shouldRender(makeCtx({ chronicles })), true);
  });
});

describe("UpcomingSection", () => {
  it("does not render without upcoming events", () => {
    assert.equal(new UpcomingSection().shouldRender(makeCtx()), false);
  });
  it("renders with upcoming events", () => {
    const ctx = makeCtx({ upcomingEvents: [{ date: "06-18", icon: "🛒", name: "618" }] });
    assert.equal(new UpcomingSection().shouldRender(ctx), true);
  });
});

describe("SummaryPanelSection", () => {
  it("does not render without merged events", () => {
    assert.equal(new SummaryPanelSection().shouldRender(makeCtx()), false);
  });
  it("renders with merged events", () => {
    const events = [{ name: "事件", type: "seasonal", icon: "🎮", section: "events" }] as any;
    assert.equal(new SummaryPanelSection().shouldRender(makeCtx({ mergedEvents: events })), true);
  });
});

describe("runPipeline", () => {
  it("filters and renders sections in order", () => {
    const sections = [
      { collectWidths() { return []; }, shouldRender() { return false; }, render() { return ["hidden"]; } },
      { collectWidths() { return []; }, shouldRender() { return true; }, render() { return ["visible"]; } },
    ] as Section[];
    const lines = runPipeline(sections, { W: 50 } as Canvas, makeCtx());
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /visible/);
  });
});

describe("runBodyPipeline", () => {
  it("runs default body sections", () => {
    const lines = runBodyPipeline({ W: 50 } as Canvas, makeCtx());
    // Zero events: only WorldUpdate (no tips), Chronicles (no data), Upcoming (none), Summary (no events)
    // → nothing should render
    assert.equal(lines.length, 0);
  });
  it("renders sections when conditions met", () => {
    const events = [{ name: "事件A", type: "seasonal", icon: "🎮", section: "events" }] as any;
    const ctx = makeCtx({ mergedEvents: events });
    const lines = runBodyPipeline({ W: 50 } as Canvas, ctx);
    assert.ok(lines.length > 0);
    // Should include SummaryPanel (mergeEvents.length > 0)
    assert.ok(lines.some((l: string) => l.includes("本期概览")));
  });
});
