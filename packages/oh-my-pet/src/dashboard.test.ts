import { describe, it, expect } from "vitest";
import { renderDashboard, fullnessBar, expBar, vitalityLabel, formatTimeAgo } from "./dashboard";

describe("expBar", () => {
  it("0 exp → 空进度条，Lv.1 0%", () => {
    expect(expBar(0)).toBe("░░░░░░░░░░ 0%");
  });
  it("500 exp → 5 格实心，Lv.1 50%", () => {
    expect(expBar(500)).toBe("█████░░░░░ 50%");
  });
  it("999 exp → Lv.1 100%", () => {
    expect(expBar(999)).toBe("██████████ 100%");
  });
  it("1000 exp → Lv.2 0%", () => {
    expect(expBar(1000)).toBe("░░░░░░░░░░ 0%");
  });
  it("1500 exp → Lv.2 50%", () => {
    expect(expBar(1500)).toBe("█████░░░░░ 50%");
  });
  it("2500 exp → Lv.3 50%", () => {
    expect(expBar(2500)).toBe("█████░░░░░ 50%");
  });
});

describe("fullnessBar", () => {
  it("0% → 空进度条", () => {
    expect(fullnessBar(0)).toBe("░░░░░░░░░░ 0%");
  });
  it("50% → 5 格实心", () => {
    expect(fullnessBar(50)).toBe("█████░░░░░ 50%");
  });
  it("100% → 满格", () => {
    expect(fullnessBar(100)).toBe("██████████ 100%");
  });
  it("75% → 7 格实心(rounding)", () => {
    const bar = fullnessBar(75);
    expect(bar).toContain("75%");
    expect(bar.match(/█/g)?.length).toBe(8); // round(75/10)=8
  });

  it("浮点数取整", () => {
    expect(fullnessBar(12.1777)).toBe("█░░░░░░░░░ 12.2%");
  });
});

describe("vitalityLabel", () => {
  it("0 → dormant", () => expect(vitalityLabel(0)).toBe("dormant (0)"));
  it("25 → slow", () => expect(vitalityLabel(25)).toBe("slow (25)"));
  it("50 → normal", () => expect(vitalityLabel(50)).toBe("normal (50)"));
  it("75 → fast", () => expect(vitalityLabel(75)).toBe("fast (75)"));
  it("100 → burst", () => expect(vitalityLabel(100)).toBe("burst (100)"));
});

describe("formatTimeAgo", () => {
  it("刚刚（<60s）", () => {
    expect(formatTimeAgo(Date.now() - 30_000)).toBe("刚刚");
  });
  it("N 分钟前", () => {
    expect(formatTimeAgo(Date.now() - 120_000)).toBe("2 分钟前");
  });
  it("N 小时前", () => {
    expect(formatTimeAgo(Date.now() - 3_600_000)).toBe("1 小时前");
  });
});

describe("renderDashboard", () => {
  it("完整面板输出包含所有属性", () => {
    const output = renderDashboard(
      { "core.exp": 2400, "core.vitality": 75 },
      "MyProject",
    );

    expect(output).toContain("🐣");
    expect(output).toContain("MyProject");
    expect(output).toContain("Lv.3");
    expect(output).toContain("📊 等级: 3");
    expect(output).toContain("📈 总经验: 2,400");
    expect(output).toContain("🎯 距下一级: 600 exp");
    expect(output).toContain("⚡ 活力: fast (75)");
    expect(output).not.toContain("🍖");
    expect(output).not.toContain("饱腹度");
  });

  it("Lv.1 当 exp=0", () => {
    const output = renderDashboard(
      { "core.exp": 0, "core.vitality": 0 },
      "Test",
    );
    expect(output).toContain("Lv.1");
    expect(output).toContain("📊 等级: 1");
    expect(output).toContain("📈 总经验: 0");
    expect(output).toContain("🎯 距下一级: 1,000 exp");
    expect(output).not.toContain("🍖");
    expect(output).not.toContain("饱腹度");
  });
});
