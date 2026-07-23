/**
 * Integration tests for Earth Online Changelog
 *
 * Run: node --test index.test.ts
 *
 * Tests the full rendering pipeline (buildPatchNotes, buildWidgetContent)
 * and cross-module integrations.
 * Unit tests for individual functions live alongside their source files in src/.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Type imports
import type {
  EarthEvent,
  EarthEntry,
} from "./src/config-parser.ts";
import type { ChronicleData, ChronicleEntry } from "./src/data-loader.ts";

// Dynamic import for .ts source
const mod = await import("./index.ts");
const buildPatchNotes = mod.buildPatchNotes;
const buildWidgetContent = mod.buildWidgetContent;
const loadSeasonTips = mod.loadSeasonTips;
import { visibleWidth, createCanvas, boxSep } from "./src/render-engine.ts";

// ─── Test Fixtures ────────────────────────────────────────────────────────────

interface UpcomingEvent {
  date: string;
  icon: string;
  name: string;
}

const sampleEvent: EarthEvent = {
  name: "测试活动",
  type: "seasonal",
  icon: "🎮",
  section: "events",
  names: { zh: "测试活动", en: "Test Event" },
  descriptions: { zh: "这是一个测试", en: "This is a test" },
};

function sampleEntry(overrides?: Partial<EarthEntry>): EarthEntry {
  return {
    date: "2026-06-01",
    tag: "儿童节",
    highlight: "儿童节活动开启！",
    events: [sampleEvent, {
      name: "限时促销",
      type: "promotion",
      icon: "🛒",
      section: "promotion",
      names: { zh: "限时促销", en: "Flash Sale" },
    }],
    ...overrides,
  };
}

function upcomingEvent(overrides?: Partial<UpcomingEvent>): UpcomingEvent {
  return {
    date: "06-18",
    icon: "🛒",
    name: "618 大促",
    ...overrides,
  };
}

// Shared constants for world update integration tests
const seasonTipsForTest = loadSeasonTips(join(__dirname));

// ─── buildPatchNotes ──────────────────────────────────────────────────────────

describe("buildPatchNotes", () => {
  it("renders full layout with outer box, header, body, footer", () => {
    const testDate = new Date(2026, 5, 1);
    const entry = sampleEntry();
    const api: EarthEvent[] = [];
    const upcoming: UpcomingEvent[] = [upcomingEvent()];

    const output = buildPatchNotes(entry, api, upcoming, "zh", testDate);

    // Outer box structure
    const lines = output.split("\n");
    assert.match(lines[0], /^┌/); // boxTop
    assert.match(lines[lines.length - 1], /^└/); // boxBottom
    assert.match(output, /├─/); // boxSep separator after header

    // Width consistency: all non-empty lines have same visual width
    // Width consistency: boxTop (line 0) sets the expected canvas.W
    const expectedW = visibleWidth(lines[0]);
    // All engine-formatted lines must be ≥ expectedW (none are narrower than canvas)
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l === "") continue;
      if (/^[│┌├└]/.test(l)) {
        assert.ok(visibleWidth(l) >= expectedW,
          `engine line ${i} visual width ${visibleWidth(l)} < ${expectedW}: "${l!.slice(0, 40)}..."`);
      }
    }

    // Check header content
    assert.match(output, /地球 Online/);
    assert.match(output, /纪元 2026/);
    assert.match(output, /世界刻/);
    assert.match(output, /世界事件/);
    // Check body sections
    assert.match(output, /版本亮点/);
    assert.match(output, /儿童节活动开启/);
    assert.match(output, /活动中心/);
    assert.match(output, /测试活动/);
    assert.match(output, /限时促销/);
    assert.match(output, /📅 即将到来/);
    assert.match(output, /06-18 🛒 618 大促/);
    // Sections ordered: highlight → events → promotion → upcoming
    const hlIdx = output.indexOf("版本亮点");
    const eventsIdx = output.indexOf("活动中心");
    const promoIdx = output.indexOf("限时促销");
    const upcIdx = output.indexOf("即将到来");
    assert.ok(hlIdx < eventsIdx);
    assert.ok(eventsIdx < promoIdx);
    assert.ok(promoIdx < upcIdx);
  });

  it("omits empty sections", () => {
    const testDate = new Date(2026, 5, 1);
    const entry = sampleEntry({ events: [sampleEvent] }); // only events
    const api: EarthEvent[] = [];
    const upcoming: UpcomingEvent[] = [];

    const output = buildPatchNotes(entry, api, upcoming, "zh", testDate);

    assert.match(output, /活动中心/);
    assert.doesNotMatch(output, /限时促销/);
    assert.doesNotMatch(output, /📅 即将到来/);
  });

  it("omits highlight when not present", () => {
    const testDate = new Date(2026, 5, 1);
    const entry = sampleEntry({ highlight: undefined });
    const api: EarthEvent[] = [];
    const upcoming: UpcomingEvent[] = [upcomingEvent()];

    const output = buildPatchNotes(entry, api, upcoming, "zh", testDate);

    assert.doesNotMatch(output, /版本亮点/);
    assert.match(output, /活动中心/);
  });

  it("shows full peace day bulletin for zero events (zh) with outer box", () => {
    const testDate = new Date(2026, 5, 1);
    const output = buildPatchNotes(undefined, [], [], "zh", testDate);
    const lines = output.split("\n");
    assert.match(lines[0], /^┌/); // boxTop
    assert.match(lines[lines.length - 1], /^└/); // boxBottom
    assert.match(output, /├─/); // boxSep separator
    assert.match(output, /地球 Online/);
    assert.match(output, /和平日/);
    assert.match(output, /自由探索/);
    assert.doesNotMatch(output, /世界事件/);
  });

  it("shows English peace day for zero events", () => {
    const testDate = new Date(2026, 5, 1);
    const output = buildPatchNotes(undefined, [], [], "en", testDate);
    assert.match(output, /Earth Online/);
    assert.match(output, /Peace Day/);
  });

  it("uses English section titles and event names when lang=en", () => {
    const testDate = new Date(2026, 5, 1);
    const entry = sampleEntry();
    const api: EarthEvent[] = [];
    const upcoming: UpcomingEvent[] = [];

    const output = buildPatchNotes(entry, api, upcoming, "en", testDate);

    assert.match(output, /Activity Center/);
    assert.match(output, /Limited-Time Sales/);
    assert.match(output, /Test Event/);
    assert.doesNotMatch(output, /新增活动/);
  });

  it("deduplicates API events by name (static wins)", () => {
    const testDate = new Date(2026, 5, 1);
    const entry = sampleEntry({ events: [sampleEvent] });
    const api: EarthEvent[] = [
      { name: "测试活动", type: "seasonal", icon: "🎊", section: "events" },
    ];
    const upcoming: UpcomingEvent[] = [];

    const output = buildPatchNotes(entry, api, upcoming, "zh", testDate);

    // Static event has icon 🎮, API event has 🎊 — static should win
    assert.match(output, /🎮/);
    assert.doesNotMatch(output, /🎊.*测试活动/);
  });

  it("omits upcoming section when there are no upcoming events", () => {
    const testDate = new Date(2026, 5, 1);
    const entry = sampleEntry();
    const api: EarthEvent[] = [];
    const upcoming: UpcomingEvent[] = [];

    const output = buildPatchNotes(entry, api, upcoming, "zh", testDate);

    assert.doesNotMatch(output, /即将到来/);
    assert.doesNotMatch(output, /Upcoming/);
  });

  it("renders multiple events in the same section", () => {
    const testDate = new Date(2026, 5, 1);
    const entry = sampleEntry({
      events: [
        { ...sampleEvent, name: "Event A", names: { zh: "Event A", en: "Event A" }, descriptions: undefined },
        { ...sampleEvent, name: "Event B", names: { zh: "Event B", en: "Event B" }, descriptions: undefined },
      ],
    });
    const output = buildPatchNotes(entry, [], [], "zh", testDate);
    assert.match(output, /Event A/);
    assert.match(output, /Event B/);
  });
});

// ─── buildPatchNotes — Peace Day ────────────────────────────────────────────

describe("buildPatchNotes - Peace Day", () => {
  it("zero events output does NOT contain activity center", () => {
    const testDate = new Date(2026, 5, 1);
    const output = buildPatchNotes(undefined, [], [], "zh", testDate);
    assert.doesNotMatch(output, /活动中心/);
  });

  it("zero events output contains footer", () => {
    const testDate = new Date(2026, 5, 1);
    const output = buildPatchNotes(undefined, [], [], "zh", testDate);
    assert.match(output, /感谢您今天的冒险/);
  });

  it("zero events with chronicles contains chronicles section", () => {
    const testDate = new Date(2026, 5, 1);
    const chronicles: ChronicleData = {
      entries: [{
        date: "06-01",
        events: [
          { title: "Test Event", epoch: 2020, description: { zh: "测试", en: "test" }, tags: ["game"] },
        ],
      }],
    };
    const output = buildPatchNotes(undefined, [], [], "zh", testDate, "north", undefined, chronicles);
    assert.match(output, /世界编年史/);
    assert.match(output, /Test Event/);
  });

  it("zero events with upcoming contains upcoming section", () => {
    const testDate = new Date(2026, 5, 1);
    const upcoming: UpcomingEvent[] = [{ date: "06-05", icon: "🌿", name: "芒种" }];
    const output = buildPatchNotes(undefined, [], upcoming, "zh", testDate);
    assert.match(output, /即将到来/);
    assert.match(output, /芒种/);
  });

  it("zero events does not contain summary panel", () => {
    const testDate = new Date(2026, 5, 1);
    const output = buildPatchNotes(undefined, [], [], "zh", testDate);
    assert.doesNotMatch(output, /本期概览/);
  });

  it("non-zero events output remains unchanged (still renders activity center)", () => {
    const testDate = new Date(2026, 5, 1);
    const entry = sampleEntry();
    const output = buildPatchNotes(entry, [], [], "zh", testDate);
    assert.match(output, /活动中心/);
    assert.match(output, /测试活动/);
  });
});

// ─── Adaptive Canvas ─────────────────────────────────────────────────────────

describe("Adaptive canvas width in buildPatchNotes", () => {
  it("uses minimum canvas width for short content (peace day)", () => {
    const output = buildPatchNotes(undefined, [], [], "zh", new Date(2026, 5, 1));
    const firstLine = output.split("\n")[0];
    // canvas.W >= 50, visual width = canvas.W for boxTop
    assert.ok(visibleWidth(firstLine) <= 56, `peace day canvas should be near minimum, got ${visibleWidth(firstLine)}`);
  });

  it("uses larger canvas for content with long event names", () => {
    const longEvent: EarthEvent = {
      name: "超长活动名称超长活动名称",
      type: "seasonal",
      icon: "🎮",
      section: "events",
      names: { zh: "超长活动名称超长活动名称超长活动名称" },
      descriptions: { zh: "超长描述超长描述超长描述超长描述超长描述超长描述超长描述" },
      startDate: "2026-06-01",
      endDate: "2026-06-15",
      reward: "超长奖励名称超长奖励名称超长奖励名称",
    };
    const entry: EarthEntry = {
      date: "2026-06-01",
      events: [longEvent],
    };
    const output = buildPatchNotes(entry, [], [], "zh", new Date(2026, 5, 5));
    const firstLine = output.split("\n")[0];
    // canvas.W should be > 50 due to long CJK content
    assert.ok(visibleWidth(firstLine) > 50, `long content canvas should exceed minimum, got ${visibleWidth(firstLine)}`);
  });

  it("uses maximum canvas width for very long content", () => {
    const veryLongEvent: EarthEvent = {
      name: "大促活动正式开启大促活动正式开启大促活动",
      type: "seasonal",
      icon: "🎮",
      section: "events",
      names: { zh: "大促活动正式开启大促活动正式开启大促活动正式开启大促活动正式开启" },
      descriptions: { zh: "这是一个非常长的活动描述这是一个非常长的活动描述这是一个非常长的活动描述这是一个非常长的活动描述这是一个非常长的活动描述" },
      startDate: "2026-06-01",
      endDate: "2026-06-30",
      reward: "非常长的奖励名称非常长的奖励名称非常长的奖励名称非常长的奖励名称",
    };
    const entry: EarthEntry = {
      date: "2026-06-01",
      events: [veryLongEvent],
    };
    const output = buildPatchNotes(entry, [], [], "zh", new Date(2026, 5, 10));
    const firstLine = output.split("\n")[0];
    // canvas.W capped at 80
    assert.ok(visibleWidth(firstLine) <= 82, `long content canvas should be capped, got ${visibleWidth(firstLine)}`);
  });

  it("engine lines are never narrower than canvas width in peace day output", () => {
    const output = buildPatchNotes(undefined, [], [], "zh", new Date(2026, 5, 1));
    const lines = output.split("\n");
    const expectedW = visibleWidth(lines[0]); // boxTop
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l === "") continue;
      if (/^[│┌├└]/.test(l)) {
        assert.ok(visibleWidth(l) >= expectedW,
          `peace day engine line ${i} visual width ${visibleWidth(l)} < ${expectedW}: "${l!.slice(0, 40)}..."`);
      }
    }
  });
});

// ─── buildWidgetContent ───────────────────────────────────────────────────────

describe("buildWidgetContent", () => {
  const testDate = new Date(2026, 5, 1); // June 1

  it("returns 和平日 format for zero events (zh)", () => {
    const output = buildWidgetContent(undefined, [], "zh");
    assert.equal(output.length, 1);
    assert.match(output[0], /🌍 v/);
    assert.match(output[0], /和平日/);
    assert.match(output[0], /自由探索/);
  });

  it("returns peaceful day format for zero events (en)", () => {
    const output = buildWidgetContent(undefined, [], "en");
    assert.equal(output.length, 1);
    assert.match(output[0], /🌍 v/);
    assert.match(output[0], /Peace Day/);
    assert.match(output[0], /Free Exploration/);
  });

  it("shows active event with status emoji and remaining days", () => {
    const activeEvent: EarthEvent = {
      name: "儿童节", type: "seasonal", icon: "🎮", section: "events",
      names: { zh: "儿童节", en: "Children's Day" },
      startDate: "2026-06-01", endDate: "2026-06-08",
    };
    const entry = sampleEntry({ events: [activeEvent] });
    const output = buildWidgetContent(entry, [], "zh");
    assert.match(output[0], /🎮/);
    assert.match(output[0], /儿童节/);
    assert.match(output[0], /剩.*天/);
    assert.match(output[0], /🟢/);
  });

  it("shows warming event with 预热 label", () => {
    const warmingEvent: EarthEvent = {
      name: "618大促", type: "promotion", icon: "🛒", section: "events",
      names: { zh: "618大促", en: "618 Sale" },
      startDate: "2026-06-10",
    };
    const entry = sampleEntry({ events: [warmingEvent] });
    const output = buildWidgetContent(entry, [], "zh");
    assert.match(output[0], /🛒/);
    assert.match(output[0], /618大促/);
    assert.match(output[0], /预热/);
    assert.match(output[0], /🟡/);
  });

  it("sorts active events by remaining days ascending", () => {
    const e1: EarthEvent = {
      name: "A短", type: "seasonal", icon: "🎮", section: "events",
      startDate: "2026-05-28", endDate: "2026-06-03",
    };
    const e2: EarthEvent = {
      name: "B长", type: "seasonal", icon: "🎯", section: "events",
      startDate: "2026-05-28", endDate: "2026-06-10",
    };
    const entry = sampleEntry({ events: [e2, e1] });
    const output = buildWidgetContent(entry, [], "zh");
    // e1 should appear first (shorter remaining)
    const idxA = output[0].indexOf("A短");
    const idxB = output[0].indexOf("B长");
    assert.ok(idxA < idxB, "A短 should appear before B长");
  });

  it("shows +N more when exceeding 4 fields", () => {
    const events: EarthEvent[] = [
      { name: "A", type: "seasonal", icon: "🎮", section: "events", startDate: "2026-05-28", endDate: "2026-06-05" },
      { name: "B", type: "seasonal", icon: "🎯", section: "events", startDate: "2026-05-28", endDate: "2026-06-05" },
      { name: "C", type: "promotion", icon: "🛒", section: "events", startDate: "2026-06-10" },
      { name: "D", type: "special", icon: "🎁", section: "events", startDate: "2026-06-12" },
      { name: "E", type: "special", icon: "🎉", section: "events", startDate: "2026-06-15" },
    ];
    const entry = sampleEntry({ events });
    const output = buildWidgetContent(entry, [], "zh");
    assert.match(output[0], /\+\d+ more/);
  });

  it("uses English names when lang=en", () => {
    const event: EarthEvent = {
      name: "测试", type: "seasonal", icon: "🎮", section: "events",
      names: { zh: "测试活动", en: "Test Event" },
      startDate: "2026-06-01", endDate: "2026-06-08",
    };
    const entry = sampleEntry({ events: [event] });
    const output = buildWidgetContent(entry, [], "en");
    assert.match(output[0], /Test Event/);
    assert.doesNotMatch(output[0], /测试活动/);
  });

  it("handles API events merged with static events", () => {
    const entry = sampleEntry({ events: [sampleEvent] });
    const api: EarthEvent[] = [
      { name: "API Event", type: "seasonal", icon: "🎊", section: "events" },
    ];
    const output = buildWidgetContent(entry, api, "zh");
    assert.match(output[0], /测试活动/);
    assert.match(output[0], /API Event/);
  });

  it("deduplicates with API events (static wins)", () => {
    const entry = sampleEntry({ events: [sampleEvent] });
    const api: EarthEvent[] = [
      { ...sampleEvent, icon: "🎊" },
    ];
    const output = buildWidgetContent(entry, api, "zh");
    // Static icon 🎮 should remain, API 🎊 should not appear
    assert.match(output[0], /🎮/);
    assert.doesNotMatch(output[0], /🎊/);
  });

  it("shows event without dates with active emoji (backward compat)", () => {
    const output = buildWidgetContent(sampleEntry(), [], "zh");
    assert.match(output[0], /🟢/);
  });
});

// ─── Activity Card Integration ────────────────────────────────────────────────

describe("Activity Card Integration in buildPatchNotes", () => {
  it("renders activity cards instead of plain list for events section", () => {
    const testDate = new Date(2026, 5, 3); // June 3
    const entry = sampleEntry({
      events: [{
        name: "儿童节活动", type: "seasonal", icon: "🎮", section: "events",
        names: { zh: "儿童节活动" },
        startDate: "2026-06-01", endDate: "2026-06-07",
        reward: "限定头像框",
      }],
    });
    const output = buildPatchNotes(entry, [], [], "zh", testDate);

    // Should use card format, not plain list
    assert.match(output, /┌─/);
    assert.match(output, /└─/);
    assert.match(output, /活动中心/);
    // Should NOT use old plain list format for events
    assert.doesNotMatch(output, /━━━ 🎯 新增活动 ━━━/);
  });

  it("still renders promotion and system sections in plain list format", () => {
    const testDate = new Date(2026, 5, 3);
    const entry = sampleEntry({
      events: [
        { name: "活动1", type: "seasonal", icon: "🎮", section: "events" },
        { name: "促销1", type: "promotion", icon: "🛒", section: "promotion",
          startDate: "2026-06-01", endDate: "2026-06-30" },
        { name: "维护1", type: "recurring", icon: "🔧", section: "system",
          startDate: "2026-06-01", endDate: "2026-06-02" },
      ],
    });
    const output = buildPatchNotes(entry, [], [], "zh", testDate);

    // events → cards
    assert.match(output, /活动中心/);
    // promotion → old format
    assert.match(output, /限时促销/);
    // system → old format
    assert.match(output, /系统更新/);
    assert.match(output, /🔧/);
  });

  it("omits activity section when there are no event-section events", () => {
    const testDate = new Date(2026, 5, 3);
    const entry = sampleEntry({
      events: [
        { name: "促销1", type: "promotion", icon: "🛒", section: "promotion" },
      ],
    });
    const output = buildPatchNotes(entry, [], [], "zh", testDate);
    assert.doesNotMatch(output, /活动中心/);
    assert.match(output, /限时促销/);
  });
});

// ─── World Update Integration in buildPatchNotes ─────────────────────────────

describe("World Update section in buildPatchNotes", () => {
  const worldUpdateDate = new Date(2026, 5, 1); // June 1, 2026

  it("includes world update section when todayEntry has events", () => {
    const entry = sampleEntry();
    const output = buildPatchNotes(entry, [], [], "zh", worldUpdateDate, "north", seasonTipsForTest);
    assert.match(output, /世界更新/);
  });

  it("peace day output now includes world update section", () => {
    const output = buildPatchNotes(undefined, [], [], "zh", worldUpdateDate, "north", seasonTipsForTest);
    assert.match(output, /世界更新/);
    assert.match(output, /和平日/);
  });

  it("world update section appears after header and before activity cards", () => {
    const entry = sampleEntry();
    const output = buildPatchNotes(entry, [], [], "zh", worldUpdateDate, "north", seasonTipsForTest);

    // Header elements should come before world update
    const headerIdx = output.indexOf("版本更新公告");
    const worldUpdateIdx = output.indexOf("世界更新");
    const activityIdx = output.indexOf("活动中心");

    assert.ok(headerIdx < worldUpdateIdx, "header should be before world update");
    assert.ok(worldUpdateIdx < activityIdx, "world update should be before activity cards");
  });
});

// ─── Chronicles Integration in buildPatchNotes ───────────────────────────────

describe("Chronicles section in buildPatchNotes", () => {
  const chronicleData: ChronicleData = {
    entries: [{
      date: "06-01",
      events: [
        { title: "历史上的游戏事件", epoch: 2010, tags: ["game"], description: { zh: "这是编年史说明" } },
      ],
    }],
  };

  it("includes chronicles section when data has matching date", () => {
    const entry = sampleEntry();
    const testDate = new Date(2026, 5, 1); // June 1
    const output = buildPatchNotes(entry, [], [], "zh", testDate, undefined, seasonTipsForTest, chronicleData);

    assert.match(output, /世界编年史/);
    assert.match(output, /旧世记录/);
    assert.match(output, /历史上的游戏事件/);
    assert.match(output, /这是编年史说明/);
  });

  it("excludes chronicles section when data has no matching date", () => {
    const entry = sampleEntry();
    const testDate = new Date(2026, 2, 15); // March 15 — no chronicle entry
    const output = buildPatchNotes(entry, [], [], "zh", testDate, undefined, seasonTipsForTest, chronicleData);

    assert.doesNotMatch(output, /世界编年史/);
  });

  it("excludes chronicles when chronicleData is undefined", () => {
    const entry = sampleEntry();
    const testDate = new Date(2026, 5, 1);
    const output = buildPatchNotes(entry, [], [], "zh", testDate, undefined, seasonTipsForTest);

    assert.doesNotMatch(output, /世界编年史/);
  });

  it("places chronicles as the last section after all events", () => {
    const entry = sampleEntry();
    const testDate = new Date(2026, 5, 1);
    const output = buildPatchNotes(entry, [], [], "zh", testDate, undefined, seasonTipsForTest, chronicleData);

    const activityIdx = output.indexOf("活动中心");
    const chronicleIdx = output.indexOf("世界编年史");

    assert.ok(activityIdx < chronicleIdx, "chronicles should be after activity cards");
  });

  it("renders chronicles in English when lang=en", () => {
    const entry = sampleEntry();
    const testDate = new Date(2026, 5, 1);
    const chronicleEn: ChronicleData = {
      entries: [{
        date: "06-01",
        events: [
          { title: "Historical Game Event", epoch: 2010, tags: ["game"], description: { en: "This is a chronicle desc" } },
        ],
      }],
    };
    const output = buildPatchNotes(entry, [], [], "en", testDate, undefined, seasonTipsForTest, chronicleEn);

    assert.match(output, /World Chronicles/);
    assert.match(output, /Historical Game Event/);
    assert.match(output, /This is a chronicle desc/);
  });
});
