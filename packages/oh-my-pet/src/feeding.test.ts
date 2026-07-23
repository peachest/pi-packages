import { describe, it, expect } from "vitest";
import { computeDeltas, classifyVitality } from "./feeding";
import { replay } from "./replay";
import type { FeedingMemo } from "./types";

function freshMemo(): FeedingMemo {
  return { lastVitality: 0 };
}

describe("computeDeltas", () => {
  it("outputTokens 直接转换成 core.exp", () => {
    const deltas = computeDeltas(
      { outputTokens: 500, outputTokensPerSec: 30 },
      freshMemo(),
    );
    expect(deltas["core.exp"]).toBe(500);
  });

  it("不含 core.fullness", () => {
    const deltas = computeDeltas(
      { outputTokens: 100, outputTokensPerSec: 0 },
      freshMemo(),
    );
    expect(deltas["core.fullness"]).toBeUndefined();
  });

  it("vitality 分类：0 tok/s → dormant(0)", () => {
    expect(classifyVitality(0)).toBe(0);
  });

  it("vitality 分类：各阈值正确映射", () => {
    expect(classifyVitality(5)).toBe(25);
    expect(classifyVitality(9)).toBe(25);
    expect(classifyVitality(10)).toBe(50);
    expect(classifyVitality(49)).toBe(50);
    expect(classifyVitality(50)).toBe(75);
    expect(classifyVitality(99)).toBe(75);
    expect(classifyVitality(100)).toBe(100);
  });

  it("vitality delta 编码：分类从 slow→fast 时 delta 正确", () => {
    const memo = freshMemo();
    const d1 = computeDeltas({ outputTokens: 0, outputTokensPerSec: 5 }, memo);
    expect(d1["core.vitality"]).toBe(25);
    expect(memo.lastVitality).toBe(25);

    const d2 = computeDeltas({ outputTokens: 0, outputTokensPerSec: 60 }, memo);
    expect(d2["core.vitality"]).toBe(50);
    expect(memo.lastVitality).toBe(75);
  });

  it("集成测试：两轮 feeding → binlog entries → replay 得到正确属性", () => {
    const memo = freshMemo();
    const entries = [];

    const d1 = computeDeltas(
      { outputTokens: 300, outputTokensPerSec: 45 },
      memo,
    );
    entries.push({
      sessionId: "s",
      seq: 1,
      responseId: "r1",
      timestamp: 1,
      mod: "feeding",
      attributes: d1,
    });

    const d2 = computeDeltas(
      { outputTokens: 200, outputTokensPerSec: 60 },
      memo,
    );
    entries.push({
      sessionId: "s",
      seq: 2,
      responseId: "r2",
      timestamp: 2,
      mod: "feeding",
      attributes: d2,
    });

    const policies = {
      "core.exp": { min: 0, max: Infinity },
      "core.vitality": { min: 0, max: 100 },
    };
    const result = replay(entries, policies);

    expect(result["core.exp"]).toBe(500);
    expect(result["core.vitality"]).toBe(75);
  });
});
