/**
 * Tests for config-parser.ts (parseEarthYaml)
 *
 * Run: node --test src/config-parser.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Dynamic import for .ts source
const { parseEarthYaml } = await import("./config-parser.ts");

describe("parseEarthYaml", () => {
  it("parses a complete month file with all fields", () => {
    const yaml = `
entries:
  - date: "2026-06-01"
    tag: "儿童节"
    highlight: "儿童节活动开启！"
    events:
      - name: "儿童节活动正式开启"
        type: seasonal
        icon: "🎮"
        section: events
        names:
          zh: "儿童节活动正式开启"
          en: "Children's Day Event Now Live"
        descriptions:
          zh: "登录即送限定头像框！"
          en: "Log in for a limited avatar frame!"
`;
    const data = parseEarthYaml(yaml);
    assert.equal(data.entries.length, 1);
    const entry = data.entries[0];
    assert.equal(entry.date, "2026-06-01");
    assert.equal(entry.tag, "儿童节");
    assert.equal(entry.highlight, "儿童节活动开启！");
    assert.equal(entry.events.length, 1);
    const ev = entry.events[0];
    assert.equal(ev.name, "儿童节活动正式开启");
    assert.equal(ev.type, "seasonal");
    assert.equal(ev.icon, "🎮");
    assert.equal(ev.section, "events");
    assert.equal(ev.names?.zh, "儿童节活动正式开启");
    assert.equal(ev.names?.en, "Children's Day Event Now Live");
    assert.equal(ev.descriptions?.zh, "登录即送限定头像框！");
  });

  it("handles empty file", () => {
    const data = parseEarthYaml("");
    assert.deepEqual(data.entries, []);
  });

  it("handles file with only comments", () => {
    const data = parseEarthYaml("# Just a comment\n# Another comment\n");
    assert.deepEqual(data.entries, []);
  });

  it("handles missing optional fields (highlight, section defaults to events)", () => {
    const yaml = `
entries:
  - date: "2026-06-01"
    events:
      - name: "测试活动"
        type: seasonal
        icon: "🎯"
`;
    const data = parseEarthYaml(yaml);
    assert.equal(data.entries.length, 1);
    assert.equal(data.entries[0].highlight, undefined);
    assert.equal(data.entries[0].events[0].section, "events");
  });

  it("parses multiple entries", () => {
    const yaml = `
entries:
  - date: "2026-06-01"
    events:
      - name: "Event 1"
        type: seasonal
        icon: "🎯"
        section: events
  - date: "2026-06-18"
    events:
      - name: "Event 2"
        type: promotion
        icon: "🛒"
        section: promotion
`;
    const data = parseEarthYaml(yaml);
    assert.equal(data.entries.length, 2);
    assert.equal(data.entries[0].date, "2026-06-01");
    assert.equal(data.entries[1].date, "2026-06-18");
    assert.equal(data.entries[0].events[0].section, "events");
    assert.equal(data.entries[1].events[0].section, "promotion");
  });

  it("handles special characters in names and descriptions", () => {
    const yaml = `
entries:
  - date: "2026-04-01"
    events:
      - name: "愚人节彩蛋！"
        type: special
        icon: "🎭"
        section: events
        descriptions:
          zh: "trick or treat！不给糖就捣蛋！"
          en: "Trick or treat!"
`;
    const data = parseEarthYaml(yaml);
    assert.equal(data.entries.length, 1);
    assert.equal(data.entries[0].events[0].name, "愚人节彩蛋！");
    assert.equal(data.entries[0].events[0].descriptions?.zh, "trick or treat！不给糖就捣蛋！");
  });

  it("parses new activity card fields (startDate, endDate, reward, warmupDays)", () => {
    const yaml = `
entries:
  - date: "2026-06-01"
    events:
      - name: "儿童节活动"
        type: seasonal
        icon: "🎮"
        section: events
        startDate: "2026-06-01"
        endDate: "2026-06-07"
        reward: "限定头像框 · 角色经验 ×1.5"
        warmupDays: 7
`;
    const data = parseEarthYaml(yaml);
    assert.equal(data.entries.length, 1);
    const ev = data.entries[0].events[0];
    assert.equal(ev.startDate, "2026-06-01");
    assert.equal(ev.endDate, "2026-06-07");
    assert.equal(ev.reward, "限定头像框 · 角色经验 ×1.5");
    assert.equal(ev.warmupDays, 7);
  });

  it("omits optional activity fields when not present in YAML", () => {
    const yaml = `
entries:
  - date: "2026-06-01"
    events:
      - name: "测试活动"
        type: seasonal
        icon: "🎯"
        section: events
`;
    const data = parseEarthYaml(yaml);
    const ev = data.entries[0].events[0];
    assert.equal(ev.startDate, undefined);
    assert.equal(ev.endDate, undefined);
    assert.equal(ev.reward, undefined);
    assert.equal(ev.warmupDays, undefined);
  });

  it("rejects invalid dates like 2026-02-30", () => {
    const yaml = `
entries:
  - date: "2026-06-01"
    events:
      - name: "无效日期活动"
        type: seasonal
        icon: "🎯"
        section: events
        startDate: "2026-02-30"
`;
    const data = parseEarthYaml(yaml);
    assert.equal(data.entries.length, 0, "entry with invalid date should be dropped");
  });

  it("rejects invalid month like 2026-13-01", () => {
    const yaml = `
entries:
  - date: "2026-06-01"
    events:
      - name: "无效月份活动"
        type: seasonal
        icon: "🎯"
        section: events
        startDate: "2026-13-01"
`;
    const data = parseEarthYaml(yaml);
    assert.equal(data.entries.length, 0, "entry with invalid month should be dropped");
  });
});
