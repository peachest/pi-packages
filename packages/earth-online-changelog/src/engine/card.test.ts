/**
 * Tests for engine/card.ts — extracted from render-engine.test.ts
 *
 * Run: node --test src/engine/card.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { createCanvas, visibleWidth } = await import("./canvas.ts");
const { cardTop, cardLine, cardDivider, cardSpacer, cardBottom, indentedLine } = await import("./card.ts");

// createCanvas(56) → W=60, O_INNER=56, CARD_INNER=50
const c = createCanvas(56);

describe("Card components", () => {
  it("cardTop has visible width equals canvas.W", () => {
    const line = cardTop(c, "🎮", "测试");
    assert.equal(visibleWidth(line), c.W);
  });

  it("cardTop starts with │  ┌─ and ends with ┐  │", () => {
    const line = cardTop(c, "🎮", "测试");
    assert(line.startsWith("│  ┌─"));
    assert(line.endsWith("┐  │"));
  });

  it("cardTop dash fill uses cardDashes", () => {
    const titleContent = " 🎮 测试 ";
    const titleVis = visibleWidth(titleContent);
    const expectedDashes = c.cardDashes(titleVis);
    const line = cardTop(c, "🎮", "测试");
    const inner = line.slice(5, -4); // strip │  ┌─ and ┐  │
    const dashCount = inner.split("").filter((ch) => ch === "─").length;
    assert.equal(dashCount, expectedDashes);
  });

  it("cardLine has visible width equals canvas.W", () => {
    const line = cardLine(c, "content");
    assert.equal(visibleWidth(line), c.W);
  });

  it("cardLine starts with │  │ and ends with │  │", () => {
    const line = cardLine(c, "test");
    assert(line.startsWith("│  │"));
    assert(line.endsWith("│  │"));
  });

  it("cardDivider has visible width equals canvas.W", () => {
    const line = cardDivider(c);
    assert.equal(visibleWidth(line), c.W);
  });

  it("cardSpacer has visible width equals canvas.W", () => {
    const line = cardSpacer(c);
    assert.equal(visibleWidth(line), c.W);
  });

  it("cardBottom has visible width equals canvas.W", () => {
    const line = cardBottom(c);
    assert.equal(visibleWidth(line), c.W);
  });

  it("cardBottom starts with │  └ and ends with ┘  │", () => {
    const line = cardBottom(c);
    assert(line.startsWith("│  └"));
    assert(line.endsWith("┘  │"));
  });

  it("indentedLine has visible width equals canvas.W", () => {
    const line = indentedLine(c, 4, "▷ content");
    assert.equal(visibleWidth(line), c.W);
  });

  it("indentedLine preserves indent", () => {
    const line = indentedLine(c, 4, "text");
    assert(line.startsWith("│     text"));
  });
});

describe("indentedLine", () => {
  const c2 = createCanvas(56);

  it("preserves indent spacing", () => {
    const line = indentedLine(c2, 3, "▷ 测试");
    assert.equal(visibleWidth(line), c2.W);
    const content = line.slice(2, -2);
    assert.equal(content.slice(0, 3), "   ");
  });
});
