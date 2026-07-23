/**
 * Tests for world-update.ts
 *
 * Run: node --test src/world-update.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Dynamic import for .ts source
const {
  getCurrentSolarTerm,
  getNextSolarTerm,
  getSeason,
  getDayNightLength,
  getMoonPhaseBar,
} = await import("./world-update.ts");

// ─── getCurrentSolarTerm ──────────────────────────────────────────────────────

describe("getCurrentSolarTerm", () => {
  it("returns 小满 for 2026-06-01", () => {
    assert.equal(getCurrentSolarTerm(new Date(2026, 5, 1)), "小满");
  });

  it("returns the solar term name when today IS a solar term day", () => {
    // 2026-06-05 is 芒种
    assert.equal(getCurrentSolarTerm(new Date(2026, 5, 5)), "芒种");
  });

  it("returns 大寒 for a date before 立春", () => {
    // 2026-01-25 is after 大寒 (Jan 20), before 立春 (Feb 4)
    assert.equal(getCurrentSolarTerm(new Date(2026, 0, 25)), "大寒");
  });

  it("returns 立春 for a date right after 立春", () => {
    // 2026-02-10 is after 立春 (Feb 4)
    assert.equal(getCurrentSolarTerm(new Date(2026, 1, 10)), "立春");
  });

  it("returns a non-empty string for any date", () => {
    const d = new Date(2026, 6, 15); // mid-July
    const term = getCurrentSolarTerm(d);
    assert.ok(typeof term === "string" && term.length > 0);
  });
});

// ─── getNextSolarTerm ─────────────────────────────────────────────────────────

describe("getNextSolarTerm", () => {
  it("returns 芒种 for 2026-06-01", () => {
    const result = getNextSolarTerm(new Date(2026, 5, 1));
    assert.equal(result.name, "芒种");
    assert.equal(result.date.getFullYear(), 2026);
    assert.equal(result.date.getMonth(), 5); // June (0-indexed)
    assert.equal(result.date.getDate(), 5);
  });

  it("returns next year 小寒 when date is late December", () => {
    // 2026-12-25: after 冬至 (Dec 22), next is 小寒 (Jan 5, 2027)
    const result = getNextSolarTerm(new Date(2026, 11, 25));
    assert.equal(result.name, "小寒");
    assert.equal(result.date.getFullYear(), 2027);
  });

  it("returns 立春 for a date in late January", () => {
    // 2026-01-25: after 大寒 (Jan 20), next is 立春 (Feb 4)
    const result = getNextSolarTerm(new Date(2026, 0, 25));
    assert.equal(result.name, "立春");
  });

  it("returns result with date after input date", () => {
    const input = new Date(2026, 3, 10); // April 10
    const result = getNextSolarTerm(input);
    assert.ok(result.date.getTime() > input.getTime(),
      `next term date ${result.date.toISOString()} should be after input ${input.toISOString()}`);
  });
});

// ─── getSeason ────────────────────────────────────────────────────────────────

describe("getSeason", () => {
  it("returns summer for 2026-06-01", () => {
    assert.equal(getSeason(new Date(2026, 5, 1)), "summer");
  });

  it("returns spring for a date after 立春", () => {
    assert.equal(getSeason(new Date(2026, 1, 10)), "spring");
  });

  it("returns autumn for a date after 立秋", () => {
    assert.equal(getSeason(new Date(2026, 7, 10)), "autumn");
  });

  it("returns winter for a date after 立冬", () => {
    assert.equal(getSeason(new Date(2026, 10, 10)), "winter");
  });

  it("returns winter for a late January date", () => {
    assert.equal(getSeason(new Date(2026, 0, 25)), "winter");
  });

  it("returns spring for a date exactly on 立春", () => {
    // 2026-02-04 is 立春
    assert.equal(getSeason(new Date(2026, 1, 4)), "spring");
  });
});

// ─── getDayNightLength ────────────────────────────────────────────────────────

describe("getDayNightLength", () => {
  it("returns dayHours between 6 and 18 for any date", () => {
    const result = getDayNightLength(new Date(2026, 5, 1));
    assert.ok(result.dayHours >= 6 && result.dayHours <= 18,
      `dayHours ${result.dayHours} should be in [6, 18]`);
    assert.ok(result.nightHours >= 6 && result.nightHours <= 18,
      `nightHours ${result.nightHours} should be in [6, 18]`);
  });

  it("returns long day and short night around summer solstice", () => {
    const result = getDayNightLength(new Date(2026, 5, 21)); // June 21 ≈ summer solstice
    assert.ok(result.dayHours >= 13, `dayHours ${result.dayHours} should be >= 13 near summer solstice`);
    assert.ok(result.nightHours <= 11, `nightHours ${result.nightHours} should be <= 11 near summer solstice`);
  });

  it("returns short day and long night around winter solstice", () => {
    const result = getDayNightLength(new Date(2026, 11, 21)); // Dec 21 ≈ winter solstice
    assert.ok(result.dayHours <= 11, `dayHours ${result.dayHours} should be <= 11 near winter solstice`);
    assert.ok(result.nightHours >= 13, `nightHours ${result.nightHours} should be >= 13 near winter solstice`);
  });

  it("returns roughly equal day and night around equinox", () => {
    const result = getDayNightLength(new Date(2026, 2, 20)); // Mar 20 ≈ spring equinox
    assert.ok(Math.abs(result.dayHours - 12) <= 1,
      `dayHours ${result.dayHours} should be ≈12 near equinox`);
  });

  it("dayHours + nightHours equals 24", () => {
    const result = getDayNightLength(new Date(2026, 3, 15));
    assert.equal(result.dayHours + result.nightHours, 24);
  });
});

// ─── getMoonPhaseBar ──────────────────────────────────────────────────────────

describe("getMoonPhaseBar", () => {
  it("returns filled between 0 and 12, total=12, percent between 0 and 100", () => {
    const result = getMoonPhaseBar(new Date(2026, 5, 1));
    assert.ok(result.filled >= 0 && result.filled <= 12,
      `filled ${result.filled} should be in [0, 12]`);
    assert.equal(result.total, 12);
    assert.ok(result.percent >= 0 && result.percent <= 100,
      `percent ${result.percent} should be in [0, 100]`);
  });

  it("returns a non-empty phase name", () => {
    const result = getMoonPhaseBar(new Date(2026, 5, 1));
    assert.ok(typeof result.phaseName === "string" && result.phaseName.length > 0);
  });

  it("returns consistent results for the same date", () => {
    const d = new Date(2026, 6, 15);
    const r1 = getMoonPhaseBar(d);
    const r2 = getMoonPhaseBar(d);
    assert.deepEqual(r1, r2);
  });

  it("returns different results for different dates", () => {
    const r1 = getMoonPhaseBar(new Date(2026, 6, 1));
    const r2 = getMoonPhaseBar(new Date(2026, 6, 20));
    // At least one of filled or percent should differ
    assert.ok(
      r1.filled !== r2.filled || r1.percent !== r2.percent,
      "different lunar dates should differ",
    );
  });
});
