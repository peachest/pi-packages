/**
 * Tests for event-status.ts — extracted from notes-renderer.test.ts
 *
 * Run: node --test src/event-status.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { EarthEvent } from "./config-parser.ts";

const { getEventStatus, MS_PER_DAY, DEFAULT_WARMUP_DAYS } = await import("./event-status.ts");

// ─── getEventStatus ───────────────────────────────────────────────────────────

describe("getEventStatus", () => {
  it("returns active for events with no dates (backward compat)", () => {
    const event: EarthEvent = { name: "旧活动", type: "seasonal", icon: "🎯", section: "events" };
    const today = new Date(2026, 5, 1);
    assert.equal(getEventStatus(event, today), "active");
  });

  it("returns ended when endDate is before today", () => {
    const event: EarthEvent = {
      name: "已结束活动", type: "seasonal", icon: "🎯", section: "events",
      startDate: "2026-05-01", endDate: "2026-05-31",
    };
    const today = new Date(2026, 5, 1); // June 1
    assert.equal(getEventStatus(event, today), "ended");
  });

  it("returns active when today is within date range", () => {
    const event: EarthEvent = {
      name: "进行中", type: "seasonal", icon: "🎯", section: "events",
      startDate: "2026-06-01", endDate: "2026-06-07",
    };
    const today = new Date(2026, 5, 3); // June 3
    assert.equal(getEventStatus(event, today), "active");
  });

  it("returns warming when startDate is within default 14-day warmup window", () => {
    const event: EarthEvent = {
      name: "预热活动", type: "seasonal", icon: "🎯", section: "events",
      startDate: "2026-06-10",
    };
    const today = new Date(2026, 5, 1); // June 1 — 9 days before start
    assert.equal(getEventStatus(event, today), "warming");
  });

  it("returns upcoming when startDate is beyond warmup window", () => {
    const event: EarthEvent = {
      name: "远期活动", type: "seasonal", icon: "🎯", section: "events",
      startDate: "2026-07-01",
    };
    const today = new Date(2026, 5, 1); // June 1 — 30 days before start
    assert.equal(getEventStatus(event, today), "upcoming");
  });

  it("respects custom warmupDays override", () => {
    const event: EarthEvent = {
      name: "短期预热", type: "seasonal", icon: "🎯", section: "events",
      startDate: "2026-06-10", warmupDays: 5,
    };
    // With warmupDays=5, 2026-06-05 to 2026-06-09 is warming
    const today = new Date(2026, 5, 6); // June 6 — 4 days before
    assert.equal(getEventStatus(event, today), "warming");
    // 2026-06-01 is 9 days before → upcoming
    const today2 = new Date(2026, 5, 1);
    assert.equal(getEventStatus(event, today2), "upcoming");
  });

  it("returns active for edge case: startDate = today", () => {
    const event: EarthEvent = {
      name: "今日开始", type: "seasonal", icon: "🎯", section: "events",
      startDate: "2026-06-01",
    };
    const today = new Date(2026, 5, 1);
    assert.equal(getEventStatus(event, today), "active");
  });

  it("returns ended for edge case: endDate = today", () => {
    // endDate is "on or before" — if endDate = today, event is still active today
    const event: EarthEvent = {
      name: "今日结束", type: "seasonal", icon: "🎯", section: "events",
      startDate: "2026-05-25", endDate: "2026-06-01",
    };
    const today = new Date(2026, 5, 1);
    assert.equal(getEventStatus(event, today), "active");
  });
});

// ─── Constants ────────────────────────────────────────────────────────────────

describe("MS_PER_DAY", () => {
  it("equals 86400000 (milliseconds in one day)", () => {
    assert.equal(MS_PER_DAY, 86400000);
  });
});

describe("DEFAULT_WARMUP_DAYS", () => {
  it("equals 14", () => {
    assert.equal(DEFAULT_WARMUP_DAYS, 14);
  });
});
