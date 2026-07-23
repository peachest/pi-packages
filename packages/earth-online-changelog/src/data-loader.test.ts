/**
 * Tests for data-loader.ts
 *
 * Run: node --test src/data-loader.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Dynamic import for .ts source
const { loadChronicles } = await import("./data-loader.ts");

describe("loadChronicles", () => {
  it("loads this-day.yaml and returns typed ChronicleData", () => {
    const dir = join(__dirname, "..");
    const data = loadChronicles(dir);

    assert.ok(Array.isArray(data.entries));
    assert.ok(data.entries.length > 0, "should have at least one entry");

    const first = data.entries[0];
    assert.match(first.date, /^\d{2}-\d{2}$/, "date should be MM-DD");
    assert.ok(Array.isArray(first.events));
    assert.ok(first.events.length > 0);

    const ev = first.events[0];
    assert.ok(typeof ev.title === "string" && ev.title.length > 0);
    assert.ok(typeof ev.epoch === "number" && ev.epoch > 1900);
  });

  it("returns empty entries when this-day.yaml does not exist", () => {
    const data = loadChronicles("/nonexistent/dir");
    assert.ok(Array.isArray(data.entries));
    assert.equal(data.entries.length, 0);
  });

  it("loads description and tags for each event", () => {
    const dir = join(__dirname, "..");
    const data = loadChronicles(dir);

    // Find the 06-01 entry (has two events with game/milestone/e3 tags)
    const june1 = data.entries.find((e) => e.date === "06-01");
    assert.ok(june1, "should have 06-01 entry");
    assert.equal(june1.events.length, 2);

    const first = june1.events[0];
    assert.ok(first.description, "should have description");
    assert.ok(first.description.zh);
    assert.ok(first.description.en);
    assert.ok(first.tags);
    assert.ok(first.tags.includes("game"));
  });

  it("loads entries for multiple dates", () => {
    const dir = join(__dirname, "..");
    const data = loadChronicles(dir);

    const dates = data.entries.map((e) => e.date);
    assert.ok(dates.includes("06-01"));
    assert.ok(dates.includes("07-20"));
    assert.ok(dates.includes("11-09"));
    assert.ok(dates.includes("12-01"));
  });
});
