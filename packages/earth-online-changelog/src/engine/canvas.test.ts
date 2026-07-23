/**
 * Tests for engine/canvas.ts — extracted from render-engine.test.ts
 *
 * Run: node --test src/engine/canvas.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { visibleWidth, padRight, centerPad, createCanvas } = await import("./canvas.ts");

describe("visibleWidth", () => {
  it("returns correct length for ASCII characters", () => {
    assert.equal(visibleWidth("hello"), 5);
  });

  it("returns 2x length for pure CJK", () => {
    assert.equal(visibleWidth("测试"), 4);
  });

  it("returns 2 for single emoji", () => {
    assert.equal(visibleWidth("🎮"), 2);
  });

  it("computes mixed strings correctly", () => {
    assert.equal(visibleWidth("hello世界🎮"), 5 + 4 + 2);
  });

  it("returns 0 for empty string", () => {
    assert.equal(visibleWidth(""), 0);
  });

  it("handles CJK range characters (U+3000-U+303f, U+FF00-U+FFEF)", () => {
    assert.equal(visibleWidth("　（）"), 6); // fullwidth parens
  });

  it("handles emoji from extended range", () => {
    assert.equal(visibleWidth("🎉🎊"), 4);
  });
});

describe("padRight", () => {
  it("pads short string to target width", () => {
    assert.equal(padRight("hi", 4), "hi  ");
  });

  it("returns original string if already >= width", () => {
    assert.equal(padRight("hello", 4), "hello");
  });

  it("handles CJK padding correctly", () => {
    assert.equal(padRight("测试", 6), "测试  ");
  });

  it("handles empty string", () => {
    assert.equal(padRight("", 3), "   ");
  });
});

describe("centerPad", () => {
  it("centers text with equal padding", () => {
    assert.equal(centerPad("ab", 6), "  ab  ");
  });

  it("centers with odd difference (left 1 less)", () => {
    assert.equal(centerPad("abc", 6), " abc  ");
  });

  it("returns original if text fits exactly", () => {
    assert.equal(centerPad("abcd", 4), "abcd");
  });

  it("centers CJK text", () => {
    assert.equal(centerPad("测", 6), "  测  ");
  });

  it("centers mixed CJK and ASCII", () => {
    assert.equal(centerPad("测试ab", 10), "  测试ab  ");
  });
});

describe("createCanvas", () => {
  it("returns W=50 for coreMaxWidth=46", () => {
    const c = createCanvas(46);
    assert.equal(c.W, 50);
    assert.equal(c.O_INNER, 46);
    assert.equal(c.CARD_TOTAL, 44);
    assert.equal(c.CARD_INNER, 40);
  });

  it("returns W=80 for coreMaxWidth=76", () => {
    const c = createCanvas(76);
    assert.equal(c.W, 80);
    assert.equal(c.O_INNER, 76);
    assert.equal(c.CARD_TOTAL, 74);
    assert.equal(c.CARD_INNER, 70);
  });

  it("caps at W=80 for coreMaxWidth=100", () => {
    const c = createCanvas(100);
    assert.equal(c.W, 80);
  });

  it("floors at W=50 for coreMaxWidth=30", () => {
    const c = createCanvas(30);
    assert.equal(c.W, 50);
  });

  it("cardDashes returns W-9-titleVis", () => {
    const c = createCanvas(56); // W = 60
    assert.equal(c.cardDashes(10), c.W - 9 - 10);
  });

  it("cardBottomDashes returns W-8", () => {
    const c = createCanvas(56); // W = 60
    assert.equal(c.cardBottomDashes(), c.W - 8);
  });

  it("cardDashes does not go below 0", () => {
    const c = createCanvas(46); // W = 50
    assert.equal(c.cardDashes(100), 0);
  });
});
