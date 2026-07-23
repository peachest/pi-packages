/**
 * Tests for engine/section.ts — extracted from render-engine.test.ts
 *
 * Run: node --test src/engine/section.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { createCanvas, visibleWidth } = await import("./canvas.ts");
const { sectionHeader, innerDivider } = await import("./section.ts");

// createCanvas(56) → W=60, O_INNER=56
const c = createCanvas(56);

describe("Section components", () => {
  it("sectionHeader has visible width equals canvas.W", () => {
    const line = sectionHeader(c, "世界更新");
    assert.equal(visibleWidth(line), c.W);
  });

  it("sectionHeader contains ━━━ wrapping", () => {
    const line = sectionHeader(c, "标题");
    assert(line.includes("━━━ 标题 ━━━"), "should wrap title with ━━━");
  });

  it("innerDivider has visible width equals canvas.W", () => {
    const line = innerDivider(c);
    assert.equal(visibleWidth(line), c.W);
  });

  it("innerDivider starts with │ and ends with │", () => {
    const line = innerDivider(c);
    assert(line.startsWith("│  "));
    assert(line.endsWith("  │"));
  });

  it("innerDivider accepts custom char", () => {
    const line = innerDivider(c, "─");
    assert(line.startsWith("│  "));
    assert(line.endsWith("  │"));
    const inner = line.slice(3, -3);
    assert(inner.split("").every((ch) => ch === "─"));
  });
});
