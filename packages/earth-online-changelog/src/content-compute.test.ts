/**
 * Tests for content-compute.ts — extracted from notes-renderer.test.ts
 *
 * Run: node --test src/content-compute.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { collectHeaderTexts, collectCardTexts, computeSummaryCounts, abbreviateEventName, mergeEvents, isPeaceDay, buildUpcomingEvents, UPCOMING_WINDOW_DAYS } = await import("./content-compute.ts");

// Re-exported types for tests
import type { EarthEvent, EarthEntry } from "./config-parser.ts";

const { createCanvas, boxCenter, visibleWidth } = await import("./engine/index.ts");

const sampleEvent: EarthEvent = {
  name: "测试活动",
  type: "seasonal",
  icon: "🎮",
  section: "events",
  names: { zh: "测试活动", en: "Test Event" },
  descriptions: { zh: "这是一个测试", en: "This is a test" },
};

const promotionEvent: EarthEvent = {
  name: "限时促销",
  type: "promotion",
  icon: "🛒",
  section: "promotion",
  names: { zh: "限时促销", en: "Flash Sale" },
};

// ─── collectHeaderTexts ────────────────────────────────────────────────────────

describe("collectHeaderTexts", () => {
  it("returns pure text lines for header (no box/engine chars)", () => {
    const texts = collectHeaderTexts(new Date(2026, 5, 1), "zh", false, undefined);
    assert.ok(Array.isArray(texts));
    assert.ok(texts.length > 0);
    for (const t of texts) {
      assert.doesNotMatch(t, /│/);
      assert.doesNotMatch(t, /┌/);
      assert.doesNotMatch(t, /┐/);
    }
    assert.match(texts[0], /地球 Online/);
  });

  it("returns pure text (no box chars) for en", () => {
    const texts = collectHeaderTexts(new Date(2026, 5, 1), "en", true, undefined);
    for (const t of texts) {
      assert.doesNotMatch(t, /│/);
    }
  });

  it("has one extra line when hasEvents=true (event tag)", () => {
    const withEvents = collectHeaderTexts(new Date(2026, 5, 1), "zh", true, "活动名");
    const withoutEvents = collectHeaderTexts(new Date(2026, 5, 1), "zh", false, undefined);
    assert.equal(withEvents.length, withoutEvents.length + 1);
  });

  it("visible widths are non-zero and reasonable", () => {
    const zhTexts = collectHeaderTexts(new Date(2026, 5, 1), "zh", true, "活动名");
    const enTexts = collectHeaderTexts(new Date(2026, 5, 1), "en", true, "Event");
    const maxZh = Math.max(...zhTexts.map(visibleWidth));
    const maxEn = Math.max(...enTexts.map(visibleWidth));
    assert.ok(maxZh > 0, "Chinese header should have positive width");
    assert.ok(maxEn > 0, "English header should have positive width");
  });
});

// ─── collectCardTexts ──────────────────────────────────────────────────────────

describe("collectCardTexts", () => {
  it("returns pure text lines from event cards (no box chars)", () => {
    const events: EarthEvent[] = [{
      name: "测试", type: "seasonal", icon: "🎮", section: "events",
      names: { zh: "测试活动" },
      descriptions: { zh: "这是描述" },
      startDate: "2026-06-01", endDate: "2026-06-07",
      reward: "限定头像框",
    }];
    const texts = collectCardTexts(events, "zh", new Date(2026, 5, 3));
    assert.ok(Array.isArray(texts));
    assert.ok(texts.length > 0);
    for (const t of texts) {
      assert.doesNotMatch(t, /│/);
    }
    const joined = texts.join("\n");
    assert.match(joined, /测试活动/);
    assert.match(joined, /这是描述/);
  });

  it("returns empty array for empty events", () => {
    const texts = collectCardTexts([], "zh", new Date());
    assert.deepEqual(texts, []);
  });

  it("texts have varying visible widths", () => {
    const events: EarthEvent[] = [{
      name: "短", type: "seasonal", icon: "🎮", section: "events",
      startDate: "2026-06-01", endDate: "2026-06-07",
      reward: "超长奖励名称超长奖励名称超长奖励名称",
    }];
    const texts = collectCardTexts(events, "zh", new Date(2026, 5, 3));
    const widths = texts.map(visibleWidth);
    const uniqueWidths = new Set(widths);
    assert.ok(uniqueWidths.size >= 2);
  });
});

// ─── mergeEvents ──────────────────────────────────────────────────────────────

describe("mergeEvents", () => {
  it("returns static events when there are no API events", () => {
    const result = mergeEvents([sampleEvent], []);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "测试活动");
  });
  it("appends API events when there are no static events", () => {
    const api: EarthEvent[] = [{ name: "API Festival", type: "seasonal", icon: "🎊", section: "events" }];
    const result = mergeEvents([], api);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "API Festival");
  });
  it("deduplicates by name — static wins", () => {
    const api: EarthEvent[] = [{ ...sampleEvent, icon: "🎊" }];
    const result = mergeEvents([sampleEvent], api);
    assert.equal(result.length, 1);
    assert.equal(result[0].icon, "🎮");
  });
});

// ─── buildUpcomingEvents ──────────────────────────────────────────────────────

describe("buildUpcomingEvents", () => {
  const sampleEntry: EarthEntry = { date: "2026-06-03", events: [sampleEvent] };

  it("returns empty array when dataByDate has no matching entries", () => {
    const dataByDate = new Map<string, EarthEntry>();
    const result = buildUpcomingEvents(dataByDate, "2026-06-01", [], "zh");
    assert.equal(result.length, 0);
  });

  it("returns events from next 6 days", () => {
    const dataByDate = new Map<string, EarthEntry>([["2026-06-03", sampleEntry]]);
    const result = buildUpcomingEvents(dataByDate, "2026-06-01", [], "zh");
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "测试活动");
  });

  it("uses language-specific event names", () => {
    const dataByDate = new Map<string, EarthEntry>([["2026-06-03", sampleEntry]]);
    const result = buildUpcomingEvents(dataByDate, "2026-06-01", [], "en");
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "Test Event");
  });
});

// ─── isPeaceDay ────────────────────────────────────────────────────────────────

describe("isPeaceDay", () => {
  it("returns true when both entry and apiEvents are empty", () => {
    assert.equal(isPeaceDay(undefined, []), true);
  });
  it("returns false when entry has events", () => {
    const entry: EarthEntry = { date: "2026-06-02", events: [sampleEvent] };
    assert.equal(isPeaceDay(entry, []), false);
  });
  it("returns false when apiEvents has events", () => {
    const api: EarthEvent[] = [{ name: "API Event", type: "seasonal", icon: "🎊", section: "events" }];
    assert.equal(isPeaceDay(undefined, api), false);
  });
});

// ─── abbreviateEventName ───────────────────────────────────────────────────────

describe("abbreviateEventName", () => {
  it("returns short names unchanged", () => {
    assert.equal(abbreviateEventName("儿童节"), "儿童节");
  });
  it("abbreviates long Chinese names to main noun", () => {
    assert.equal(abbreviateEventName("儿童节活动正式开启"), "儿童节");
  });
  it("handles English names by truncating", () => {
    const result = abbreviateEventName("Children's Day Celebration Event Now Live");
    assert.ok(result.length < "Children's Day Celebration Event Now Live".length);
  });
});

// ─── computeSummaryCounts ─────────────────────────────────────────────────────

describe("computeSummaryCounts", () => {
  it("returns all zeros for empty events", () => {
    const counts = computeSummaryCounts([], new Date(2026, 5, 1));
    assert.equal(counts.activeCount, 0);
    assert.equal(counts.warmingCount, 0);
    assert.equal(counts.upcomingCount, 0);
    assert.equal(counts.rewardCount, 0);
  });

  it("counts active events correctly", () => {
    const events: EarthEvent[] = [{
      name: "active", type: "seasonal", icon: "🎮", section: "events",
      startDate: "2026-05-20", endDate: "2026-06-10",
    }];
    const counts = computeSummaryCounts(events, new Date(2026, 5, 1));
    assert.equal(counts.activeCount, 1);
  });

  it("counts events with rewards (active only)", () => {
    const events: EarthEvent[] = [{
      name: "rewarded", type: "seasonal", icon: "🎮", section: "events",
      startDate: "2026-05-20", endDate: "2026-06-10",
      reward: "奖品",
    }];
    const counts = computeSummaryCounts(events, new Date(2026, 5, 1));
    assert.equal(counts.rewardCount, 1);
  });

  it("counts mixed statuses in single call", () => {
    const events: EarthEvent[] = [
      { name: "active", type: "seasonal", icon: "🎮", section: "events", startDate: "2026-05-20", endDate: "2026-06-10" },
      { name: "warming", type: "seasonal", icon: "🛒", section: "events", startDate: "2026-06-10" },
      { name: "upcoming", type: "seasonal", icon: "🎭", section: "events", startDate: "2026-08-01" },
    ];
    const counts = computeSummaryCounts(events, new Date(2026, 5, 1));
    assert.equal(counts.activeCount, 1);
    assert.equal(counts.warmingCount, 1);
    assert.equal(counts.upcomingCount, 1);
  });
});

// ─── UPCOMING_WINDOW_DAYS ─────────────────────────────────────────────────────

describe("UPCOMING_WINDOW_DAYS", () => {
  it("equals 6", () => {
    assert.equal(UPCOMING_WINDOW_DAYS, 6);
  });
});
