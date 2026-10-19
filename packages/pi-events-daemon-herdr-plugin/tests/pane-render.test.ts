/**
 * 票 44 — 订阅面板纯渲染面单测（pane-render.ts；bin IO 不进本集）。
 */
import { describe, it, expect } from "vitest";
import {
  visibleSubs,
  groupBySession,
  relativeTime,
  scheduleBrief,
  onBrief,
  formatSub,
  renderPanel,
  type PanelData,
  type WireSubscription,
} from "../pane-render.ts";

const NOW = Date.parse("2026-10-19T09:00:00Z");

const sub = (over: Partial<WireSubscription> = {}): WireSubscription => ({
  subscriptionId: "sub-1",
  sessionId: "aaaaaaaa-1111-2222-3333-444444444444",
  entityRef: "adhoc:project/7bf355e6",
  state: "failed",
  origin: "session",
  on: ["failed"],
  schedule: { type: "interval", intervalMs: 60_000 },
  backlog: 0,
  createdAt: "2026-10-19T08:00:00.000Z",
  ...over,
});

const data = (over: Partial<PanelData> = {}): PanelData => ({
  subs: [sub()],
  deadLetters: 0,
  connected: true,
  epoch: 1234,
  lastEdgeAt: null,
  ...over,
});

describe("visibleSubs — 全量/自己两视图", () => {
  it("self 视图只留锚 session；无锚 session 落全量（action 未解析出 agent session）", () => {
    const d = data({ subs: [sub(), sub({ subscriptionId: "sub-2", sessionId: "bbbbbbbb-1111-2222-3333-444444444444" })] });
    expect(visibleSubs(d, "self", "aaaaaaaa-1111-2222-3333-444444444444").map((s) => s.subscriptionId)).toEqual(["sub-1"]);
    expect(visibleSubs(d, "all", "aaaaaaaa-1111-2222-3333-444444444444")).toHaveLength(2);
    expect(visibleSubs(d, "self", null)).toHaveLength(2);
  });
});

describe("groupBySession — session 维度分组", () => {
  it("按 sessionId 分桶且组序字典序；同组行序保持", () => {
    const rows = [
      sub({ subscriptionId: "b", sessionId: "s2" }),
      sub({ subscriptionId: "a", sessionId: "s1" }),
      sub({ subscriptionId: "c", sessionId: "s2" }),
    ];
    expect(groupBySession(rows).map((g) => [g.sessionId, g.subs.map((s) => s.subscriptionId)])).toEqual([
      ["s1", ["a"]],
      ["s2", ["b", "c"]],
    ]);
  });
});

describe("字段摘要", () => {
  it("relativeTime 阶梯；lastProbedAt 缺省 = —", () => {
    expect(relativeTime("2026-10-19T08:59:30.000Z", NOW)).toBe("30s ago");
    expect(relativeTime("2026-10-19T08:30:00.000Z", NOW)).toBe("30m ago");
    expect(relativeTime("2026-10-18T09:00:00.000Z", NOW)).toBe("1d ago");
    expect(relativeTime(undefined, NOW)).toBe("—");
  });
  it("scheduleBrief：interval 秒/毫秒与 cron；无槽 = —", () => {
    expect(scheduleBrief(sub())).toBe("60s");
    expect(scheduleBrief(sub({ schedule: { type: "interval", intervalMs: 1500 } }))).toBe("1500ms");
    expect(scheduleBrief(sub({ schedule: { type: "cron", cron: "0 * * *" } }))).toBe("cron 0 * * *");
    expect(scheduleBrief(sub({ schedule: undefined }))).toBe("—");
  });
  it("onBrief：集合/单值/once+flip 标记；缺省 any", () => {
    expect(onBrief(sub())).toBe("[failed]");
    expect(onBrief(sub({ on: "passed" }))).toBe("passed");
    expect(onBrief(sub({ on: undefined, once: true, flip: true }))).toBe("any once+flip");
  });
  it("formatSub 单行：id · 实体→状态 · 谓词 · 节奏 · backlog · probe", () => {
    const line = formatSub(sub({ thresholds: { failureThreshold: 2, successThreshold: 1 }, phase: "flip", lastProbedAt: "2026-10-19T08:59:00.000Z" }), NOW);
    expect(line).toContain("sub-1");
    expect(line).toContain("adhoc:project/7bf355e6 → failed");
    expect(line).toContain("on=[failed]");
    expect(line).toContain("every=60s thr 2/1 phase=flip");
    expect(line).toContain("backlog 0");
    expect(line).toContain("probe 1m ago");
    expect(formatSub(sub({ state: null }), NOW)).toContain("→ ○ none");
  });
});

describe("renderPanel — 整屏", () => {
  it("头部带视图/计数/daemon 状态；self 分组 ◆ 标记；空态提示", () => {
    const all = renderPanel(data({ epoch: 42, deadLetters: 2 }), "all", "aaaaaaaa-1111-2222-3333-444444444444", NOW);
    expect(all).toContain("[all sessions]");
    expect(all).toContain("1 subs · 2 dead-letters");
    expect(all).toContain("● daemon running epoch 42");
    expect(all).toContain("◆ session aaaaaaaa-1111"); // 全视图也标注本 session
    const self = renderPanel(data(), "self", "aaaaaaaa-1111-2222-3333-444444444444", NOW);
    expect(self).toContain("[self aaaaaaaa]");
    expect(self).toContain("◆ session aaaaaaaa-1111");
    expect(renderPanel(data({ subs: [] }), "all", null, NOW)).toContain("无订阅");
  });
  it("断连降级文案", () => {
    expect(renderPanel(data({ connected: false }), "all", null, NOW)).toContain("✗ daemon unreachable");
  });
});
