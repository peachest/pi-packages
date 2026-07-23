import { describe, it, expect } from "vitest";
import { replay } from "./replay";
import type { AttrPolicies } from "./types";

const defaultPolicies: AttrPolicies = {
  "core.exp": { min: 0, max: Infinity },
  "core.vitality": { min: 0, max: 100 },
};

describe("replay", () => {
  it("空条目列表返回所有已注册属性的零值", () => {
    const result = replay([], defaultPolicies);

    expect(result).toEqual({
      "core.exp": 0,
      "core.vitality": 0,
    });
  });

  it("单条目属性累加后被策略钳制", () => {
    const entries = [
      { sessionId: "s", seq: 1, responseId: "r1", timestamp: 1, mod: "feeding",
        attributes: { "core.vitality": 120, "core.exp": 50 } },
    ];
    const result = replay(entries, defaultPolicies);

    expect(result).toEqual({
      "core.exp": 50,
      "core.vitality": 100,
    });
  });

  it("多条目的属性 delta 连续累加", () => {
    const entries = [
      { sessionId: "s", seq: 1, responseId: "r1", timestamp: 1, mod: "feeding",
        attributes: { "core.exp": 100 } },
      { sessionId: "s", seq: 2, responseId: "r2", timestamp: 2, mod: "feeding",
        attributes: { "core.exp": 200, "core.vitality": 50 } },
      { sessionId: "s2", seq: 1, responseId: "r3", timestamp: 3, mod: "feeding",
        attributes: { "core.exp": 50, "core.vitality": 30 } },
    ];
    const result = replay(entries, defaultPolicies);

    expect(result).toEqual({
      "core.exp": 350,
      "core.vitality": 80,
    });
  });

  it("任意重排顺序重放结果一致（可交换性）——属性值均在边界内", () => {
    const makeEntry = (sid: string, seq: number, rid: string, attrs: Record<string, number>) =>
      ({ sessionId: sid, seq, responseId: rid, timestamp: 1, mod: "feeding", attributes: attrs });

    // 所有 delta 累加后不会触及 max 边界（可交换性生效条件）
    const entries = [
      makeEntry("a", 1, "a1", { "core.exp": 10, "core.vitality": 20 }),
      makeEntry("b", 1, "b1", { "core.exp": 30, "core.vitality": 40 }),
      makeEntry("a", 2, "a2", { "core.vitality": 10 }),
    ];

    const result1 = replay(entries, defaultPolicies);
    const result2 = replay([...entries].reverse(), defaultPolicies);

    expect(result1).toEqual(result2);
    expect(result1["core.exp"]).toBe(40);
    expect(result1["core.vitality"]).toBe(70);
  });

  it("属性值超出 max 被钳制到 max，低于 min 被钳制到 min", () => {
    const entries = [
      { sessionId: "s", seq: 1, responseId: "r1", timestamp: 1, mod: "feeding",
        attributes: { "core.vitality": -20 } },
    ];
    const result = replay(entries, defaultPolicies);

    expect(result["core.vitality"]).toBe(0);     // 钳制到 min
  });
});
