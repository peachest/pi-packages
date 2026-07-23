/**
 * Tests for section-render.ts — rendering block functions
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { detectHemisphere, renderFooter, renderUpcomingSection, renderPeaceDaySection, filterChronicles, renderChroniclesSection, renderSummaryPanel, renderProgressBar, buildHeader, renderEventCard, renderActivitySection, renderWorldUpdateSection } = await import("./section-render.ts");
import type { PeaceDayConfig } from "./validation.ts";

describe("detectHemisphere", () => {
  it("returns north when not set", () => {
    delete process.env.EARTH_HEMISPHERE;
    assert.equal(detectHemisphere(), "north");
  });
  it("returns north when set", () => {
    process.env.EARTH_HEMISPHERE = "north"; assert.equal(detectHemisphere(), "north"); delete process.env.EARTH_HEMISPHERE;
  });
  it("returns south when set", () => {
    process.env.EARTH_HEMISPHERE = "south"; assert.equal(detectHemisphere(), "south"); delete process.env.EARTH_HEMISPHERE;
  });
});

describe("renderFooter", () => {
  it("renders Chinese", () => {
    const r = renderFooter(new Date(2026, 5, 1), "zh", { W: 80, O_INNER: 76, CARD_TOTAL: 74, CARD_INNER: 70, cardDashes: () => 0, cardBottomDashes: () => 0 } as any);
    assert.match(r[1], /🌍 地球 Online/);
  });
  it("renders English", () => {
    const r = renderFooter(new Date(2026, 11, 31), "en", { W: 80, O_INNER: 76, CARD_TOTAL: 74, CARD_INNER: 70, cardDashes: () => 0, cardBottomDashes: () => 0 } as any);
    assert.match(r[1], /🌍 Earth Online/);
  });
});

describe("renderUpcomingSection", () => {
  it("empty", () => assert.deepEqual(renderUpcomingSection([], "zh"), []));
  it("zh", () => assert.match(renderUpcomingSection([{ date: "06-18", icon: "🛒", name: "618 大促" }], "zh")[0], /📅 即将到来/));
  it("en", () => assert.match(renderUpcomingSection([{ date: "06-18", icon: "🛒", name: "618 Sale" }], "en")[0], /📅 Upcoming/));
});

describe("renderPeaceDaySection", () => {
  it("zh", () => assert.match(renderPeaceDaySection("zh")[0], /和平日/));
  it("en", () => assert.match(renderPeaceDaySection("en")[0], /Peace Day/));
  it("config", () => {
    const c: PeaceDayConfig = { zh: { title: "自定义", description: ["描述"] }, en: { title: "C", description: ["D"] } };
    assert.match(renderPeaceDaySection("zh", c)[0], /自定义/);
  });
});

describe("filterChronicles", () => {
  it("empty", () => assert.deepEqual(filterChronicles([], new Date()), []));
  it("match", () => {
    const e: Array<{ date: string; events: Array<{ title: string; epoch: number; tags?: string[]; description?: Record<string, string> }> }> = [{ date: "06-01", events: [{ title: "A", epoch: 2020, tags: ["game"] }] }];
    assert.equal(filterChronicles(e as any, new Date(2026, 5, 1)).length, 1);
  });
});

describe("renderChroniclesSection", () => {
  it("null for empty", () => assert.equal(renderChroniclesSection(new Date(), "zh", undefined), null));
  it("renders events", () => {
    const r = renderChroniclesSection(new Date(2026, 5, 1), "zh", [{ title: "事件", epoch: 2020, tags: ["game"], description: { zh: "说明", en: "desc" } }]);
    assert.ok(r && r.length >= 3);
    assert.match(r[2], /事件/);
  });
});

describe("renderSummaryPanel", () => {
  it("zh", () => {
    const c = { activeCount: 1, warmingCount: 1, upcomingCount: 2, worldEventCount: 2, rewardCount: 2, seasonCountdownDays: 4 };
    assert.match(renderSummaryPanel(c, "zh")[0], /📊 本期概览/);
  });
  it("en", () => {
    const c = { activeCount: 3, warmingCount: 0, upcomingCount: 1, worldEventCount: 1, rewardCount: 1, seasonCountdownDays: 10 };
    assert.match(renderSummaryPanel(c, "en")[0], /📊 This Edition/);
  });
});

describe("renderProgressBar", () => {
  it("active partial", () => {
    const r = renderProgressBar("active", 3, 7, "zh");
    assert.match(r, /剩余/); assert.match(r, /█/); assert.match(r, /░/);
  });
  it("ended", () => assert.match(renderProgressBar("ended", 7, 7, "zh"), /已结束/));
  it("warming", () => assert.match(renderProgressBar("warming", 5, 0, "zh"), /距正式开启/));
  it("English", () => assert.match(renderProgressBar("active", 3, 7, "en"), /remaining/));
});

describe("buildHeader", () => {
  it("renders Chinese header", () => {
    const c = { W: 50, O_INNER: 46, CARD_TOTAL: 44, CARD_INNER: 40, cardDashes: () => "", cardBottomDashes: () => "" } as any;
    const joined = buildHeader(new Date(2026, 5, 1), "zh", true, undefined, c).join("\n");
    assert.match(joined, /地球 Online/); assert.match(joined, /纪元 2026/); assert.match(joined, /世界刻/); assert.match(joined, /月相/); assert.match(joined, /世界事件/);
  });
  it("omits event line when false", () => {
    const joined = buildHeader(new Date(2026, 5, 1), "zh", false, undefined, { W: 50, O_INNER: 46 } as any).join("\n");
    assert.doesNotMatch(joined, /世界事件/);
  });
  it("uses English labels", () => {
    const joined = buildHeader(new Date(2026, 5, 1), "en", true, undefined, { W: 50, O_INNER: 46 } as any).join("\n");
    assert.match(joined, /Earth Online/); assert.match(joined, /Epoch/); assert.match(joined, /World Day/);
  });
});

interface EarthEvent {
  name?: string; type: string; icon: string; section: string;
  names?: Record<string, string>; descriptions?: Record<string, string>;
  description?: string; reward?: string;
  startDate?: string; endDate?: string; warmupDays?: number;
}

describe("renderEventCard", () => {
  it("renders full active event card", () => {
    const ev: EarthEvent = { name: "儿童节活动正式开启", type: "seasonal", icon: "🎮", section: "events", names: { zh: "儿童节活动正式开启", en: "Children's Day" }, descriptions: { zh: "所有玩家获得童心加成 BUFF" }, startDate: "2026-06-01", endDate: "2026-06-07", reward: "限定头像框" };
    const lines = renderEventCard(ev, "zh", new Date(2026, 5, 3));
    assert.match(lines[0], /^┌─/);
    assert.match(lines.join("\n"), /儿童节/);
  });
  it("hides reward line when none", () => {
    const ev: EarthEvent = { type: "seasonal", icon: "🎯", section: "events", startDate: "2026-06-01", endDate: "2026-06-07" };
    assert.doesNotMatch(renderEventCard(ev, "zh", new Date(2026, 5, 3)).join("\n"), /🎁/);
  });
  it("renders simplified card without dates", () => {
    const ev: EarthEvent = { name: "旧活动", type: "seasonal", icon: "🎯", section: "events", description: "旧格式活动描述" };
    const joined = renderEventCard(ev, "zh", new Date(2026, 5, 1)).join("\n");
    assert.match(joined, /旧活动/); assert.doesNotMatch(joined, /剩余/);
  });
  it("renders warming event card", () => {
    const ev: EarthEvent = { name: "京东618", type: "promotion", icon: "🛒", section: "events", startDate: "2026-06-18" };
    const joined = renderEventCard(ev, "zh", new Date(2026, 5, 1)).join("\n");
    assert.match(joined, /预热/); assert.match(joined, /距正式开启/);
  });
  it("renders ended event card", () => {
    const ev: EarthEvent = { type: "seasonal", icon: "🎯", section: "events", startDate: "2026-05-01", endDate: "2026-05-31" };
    const joined = renderEventCard(ev, "zh", new Date(2026, 5, 1)).join("\n");
    assert.match(joined, /已结束/); assert.match(joined, /▓▓▓/);
  });
});

describe("renderActivitySection", () => {
  it("renders sorted cards with header", () => {
    const active = { name: "进行中活动", type: "seasonal", icon: "🎮", section: "events", startDate: "2026-06-01", endDate: "2026-06-10", reward: "奖励A" } as EarthEvent;
    const warming = { name: "预热活动", type: "promotion", icon: "🛒", section: "events", startDate: "2026-06-15" } as EarthEvent;
    const events = [warming, active];
    const lines = renderActivitySection(events, "zh", new Date(2026, 5, 3));
    assert.ok(lines.length > 0);
    const joined = lines.join("\n");
    assert.match(joined, /活动中心/);
    assert.ok(joined.indexOf("进行中活动") < joined.indexOf("预热活动"), "active before warming");
  });
});

describe("renderWorldUpdateSection", () => {
  const date = new Date(2026, 5, 1); // June 1
  const mockTips = {
    spring: { buffs: [{ zh: "春之祝福", en: "Spring Bless" }], debuffs: [{ zh: "春雨绵绵", en: "Spring Rain" }] },
    summer: { buffs: [{ zh: "夏之活力", en: "Summer Energy" }], debuffs: [{ zh: "夏暑难耐", en: "Summer Heat" }] },
    autumn: { buffs: [{ zh: "秋之丰收", en: "Harvest" }], debuffs: [{ zh: "秋雨连绵", en: "Autumn Rain" }] },
    winter: { buffs: [{ zh: "冬之温暖", en: "Winter Warm" }], debuffs: [{ zh: "冰天雪地", en: "Freezing" }] },
  };

  it("renders Chinese", () => {
    const lines = renderWorldUpdateSection(date, "zh", "north", mockTips);
    assert.ok(lines.some((l: string) => l.includes("世界环境更新")));
    assert.ok(lines.some((l: string) => l.includes("服务器状态")));
    assert.ok(lines.some((l: string) => l.includes("旧历记录")));
  });

  it("renders English", () => {
    const lines = renderWorldUpdateSection(date, "en", "north", mockTips);
    assert.ok(lines.some((l: string) => l.includes("Environment Update")));
    assert.ok(lines.some((l: string) => l.includes("Server Status")));
  });

  it("flips season for south", () => {
    const north = renderWorldUpdateSection(date, "zh", "north", mockTips);
    const south = renderWorldUpdateSection(date, "zh", "south", mockTips);
    assert.ok(north.some((l: string) => l.includes("夏季")));
    assert.ok(south.some((l: string) => l.includes("冬季")));
  });

  it("works with empty tips", () => {
    const empty = { spring: { buffs: [], debuffs: [] }, summer: { buffs: [], debuffs: [] }, autumn: { buffs: [], debuffs: [] }, winter: { buffs: [], debuffs: [] } };
    const lines = renderWorldUpdateSection(date, "zh", "north", empty);
    assert.ok(Array.isArray(lines));
    assert.ok(lines.length > 3);
  });
});
