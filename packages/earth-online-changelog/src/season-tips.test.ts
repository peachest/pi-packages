/**
 * Tests for season-tips.ts
 *
 * Run: node --test src/season-tips.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import type { SeasonTips } from "./season-tips.ts";

// Dynamic import for .ts source
const { loadSeasonTips, getRandomSeasonTip } = await import("./season-tips.ts");

// ─── loadSeasonTips ───────────────────────────────────────────────────────────

describe("loadSeasonTips", () => {
  it("loads season-tips.yaml from config/base/", () => {
    const dir = join(__dirname, "..");
    const tips = loadSeasonTips(dir);

    // Check structure
    assert.ok(tips.spring);
    assert.ok(tips.summer);
    assert.ok(tips.autumn);
    assert.ok(tips.winter);

    // Each season must have >=5 buffs and >=5 debuffs
    const seasons = ["spring", "summer", "autumn", "winter"];
    for (const season of seasons) {
      const set = (tips as any)[season];
      assert.ok(set.buffs.length >= 5, `${season} buffs should have >=5 entries, got ${set.buffs.length}`);
      assert.ok(set.debuffs.length >= 5, `${season} debuffs should have >=5 entries, got ${set.debuffs.length}`);
    }
  });

  it("returns fallback defaults when YAML file does not exist", () => {
    // Use a non-existent directory
    const fbTips = loadSeasonTips("/nonexistent/dir");

    // Should still return valid structure with fallback content
    assert.ok(fbTips.spring);
    assert.ok(fbTips.summer);
    assert.ok(fbTips.autumn);
    assert.ok(fbTips.winter);

    // Each season should have at least 1 buff and 1 debuff from fallback
    const seasons = ["spring", "summer", "autumn", "winter"];
    for (const season of seasons) {
      const set = (fbTips as any)[season];
      assert.ok(set.buffs.length >= 1, `${season} fallback should have >=1 buff`);
      assert.ok(set.debuffs.length >= 1, `${season} fallback should have >=1 debuff`);
    }
  });
});

// ─── getRandomSeasonTip ───────────────────────────────────────────────────────

describe("getRandomSeasonTip", () => {
  // Pre-load tips once for all tests in this block
  const tips = loadSeasonTips(join(__dirname, ".."));

  function inPool(tip: string, season: string, type: "buff" | "debuff"): boolean {
    const set = tips[season as keyof SeasonTips];
    if (!set) return false;
    const pool = type === "buff" ? set.buffs : set.debuffs;
    return pool.some((t) => Object.values(t).some((v) => v === tip));
  }

  it("returns a tip from summer buffs pool", () => {
    const tip = getRandomSeasonTip(tips, "summer", "buff", "zh");
    assert.ok(inPool(tip, "summer", "buff"), `tip "${tip}" not found in summer buffs pool`);
  });

  it("returns a tip from autumn debuffs pool", () => {
    const tip = getRandomSeasonTip(tips, "autumn", "debuff", "zh");
    assert.ok(inPool(tip, "autumn", "debuff"), `tip "${tip}" not found in autumn debuffs pool`);
  });

  it("returns a tip from spring buffs pool", () => {
    const tip = getRandomSeasonTip(tips, "spring", "buff", "zh");
    assert.ok(inPool(tip, "spring", "buff"), `tip "${tip}" not found in spring buffs pool`);
  });

  it("returns a tip from winter debuffs pool", () => {
    const tip = getRandomSeasonTip(tips, "winter", "debuff", "zh");
    assert.ok(inPool(tip, "winter", "debuff"), `tip "${tip}" not found in winter debuffs pool`);
  });

  it("returns an English tip when lang=en", () => {
    const tip = getRandomSeasonTip(tips, "summer", "buff", "en");
    assert.ok(inPool(tip, "summer", "buff"), `tip "${tip}" not found in summer buffs pool`);
    // English tips should not contain CJK characters
    assert.doesNotMatch(tip, /[\u4e00-\u9fff]/);
  });

  it("falls back to first language key when lang is missing", () => {
    // "fr" does not exist in the tip entries, should fall back to first key
    const tipFr = getRandomSeasonTip(tips, "summer", "buff", "fr");
    assert.ok(tipFr.length > 0, "should return non-empty string even for unknown lang");
    // Unknown lang should return a value that exists in the pool
    assert.ok(inPool(tipFr, "summer", "buff"));
  });

  it("returns different tips across multiple calls (randomness check)", () => {
    // Call many times, collect unique results. With >=5 options,
    // we should get more than 1 unique result in ~20 calls.
    const results = new Set<string>();
    for (let i = 0; i < 20; i++) {
      results.add(getRandomSeasonTip(tips, "summer", "buff", "zh"));
    }
    // With >=5 options, probability of all-same in 20 calls is essentially 0
    assert.ok(results.size > 1, "should produce more than 1 unique result in 20 calls");
  });
});
