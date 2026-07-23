/**
 * Tests for date-utils.ts — extracted from notes-renderer.test.ts
 *
 * Run: node --test src/date-utils.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const {
  pad,
  getTodayDateString,
  getVersionString,
  getWorldDay,
  formatWeekday,
  getMoonPhaseDisplay,
  WEEKDAY_ZH,
  WEEKDAY_EN,
} = await import("./date-utils.ts");

// ─── pad ─────────────────────────────────────────────────────────────────────

describe("pad", () => {
  it("pads single-digit numbers to 2 digits", () => {
    assert.equal(pad(1), "01");
    assert.equal(pad(9), "09");
  });

  it("leaves double-digit numbers unchanged", () => {
    assert.equal(pad(10), "10");
    assert.equal(pad(99), "99");
  });

  it("handles 0", () => {
    assert.equal(pad(0), "00");
  });
});

// ─── getTodayDateString / getVersionString ─────────────────────────────────────

describe("getTodayDateString", () => {
  it("returns formatted date for given Date object", () => {
    const d = new Date(2026, 5, 1);
    assert.equal(getTodayDateString(d), "2026-06-01");
  });

  it("returns correct date for end of month", () => {
    const d = new Date(2026, 11, 31);
    assert.equal(getTodayDateString(d), "2026-12-31");
  });

  it("returns single-digit month and day padded", () => {
    const d = new Date(2026, 0, 5);
    assert.equal(getTodayDateString(d), "2026-01-05");
  });

  it("works without argument (returns today)", () => {
    const result = getTodayDateString();
    const today = new Date();
    const expected = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    assert.equal(result, expected);
  });
});

describe("getVersionString", () => {
  it("returns formatted version with Patch prefix for given Date object", () => {
    const d = new Date(2026, 5, 1);
    assert.equal(getVersionString(d), "Patch 2026.06.01");
  });

  it("works without argument (returns today with Patch prefix)", () => {
    const result = getVersionString();
    const today = new Date();
    const expected = `Patch ${today.getFullYear()}.${String(today.getMonth() + 1).padStart(2, "0")}.${String(today.getDate()).padStart(2, "0")}`;
    assert.equal(result, expected);
  });
});

// ─── getWorldDay ──────────────────────────────────────────────────────────────

describe("getWorldDay", () => {
  it("returns 001 for January 1", () => {
    assert.equal(getWorldDay(new Date(2026, 0, 1)), "001");
  });

  it("returns 365 for December 31 in non-leap year", () => {
    assert.equal(getWorldDay(new Date(2026, 11, 31)), "365");
  });

  it("returns 366 for December 31 in leap year", () => {
    assert.equal(getWorldDay(new Date(2024, 11, 31)), "366");
  });

  it("returns 060 for March 1 (non-leap)", () => {
    assert.equal(getWorldDay(new Date(2026, 2, 1)), "060");
  });
});

// ─── formatWeekday ────────────────────────────────────────────────────────────

describe("formatWeekday", () => {
  it("returns Chinese weekday for zh", () => {
    // 2026-06-01 is Monday
    assert.equal(formatWeekday(new Date(2026, 5, 1), "zh"), "星期一");
  });

  it("returns English 3-letter abbreviation for en", () => {
    assert.equal(formatWeekday(new Date(2026, 5, 1), "en"), "Mon");
  });

  it("maps Sunday correctly in zh", () => {
    // 2026-05-31 is Sunday
    assert.equal(formatWeekday(new Date(2026, 4, 31), "zh"), "星期日");
  });

  it("maps Sunday correctly in en", () => {
    assert.equal(formatWeekday(new Date(2026, 4, 31), "en"), "Sun");
  });
});

// ─── getMoonPhaseDisplay ──────────────────────────────────────────────────────

describe("getMoonPhaseDisplay", () => {
  it("returns moon phase name and percentage for zh", () => {
    // 2026-06-01 lunar day 16 of 29, 16/29 ≈ 55%
    const result = getMoonPhaseDisplay(new Date(2026, 5, 1), "zh");
    assert.match(result, /月相/);
    assert.match(result, /\d+%/);
  });

  it("returns moon phase name and percentage for en", () => {
    const result = getMoonPhaseDisplay(new Date(2026, 5, 1), "en");
    assert.match(result, /Moon/);
    assert.match(result, /\d+%/);
  });
});

// ─── WEEKDAY constants ────────────────────────────────────────────────────────

describe("WEEKDAY_ZH", () => {
  it("contains 7 Chinese weekday names", () => {
    assert.equal(WEEKDAY_ZH.length, 7);
    assert.equal(WEEKDAY_ZH[0], "星期日");
    assert.equal(WEEKDAY_ZH[1], "星期一");
    assert.equal(WEEKDAY_ZH[6], "星期六");
  });
});

describe("WEEKDAY_EN", () => {
  it("contains 7 English 3-letter abbreviations", () => {
    assert.equal(WEEKDAY_EN.length, 7);
    assert.equal(WEEKDAY_EN[0], "Sun");
    assert.equal(WEEKDAY_EN[1], "Mon");
    assert.equal(WEEKDAY_EN[6], "Sat");
  });
});
