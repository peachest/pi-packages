/**
 * Tests for render-engine.ts
 *
 * Run: node --test src/render-engine.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Dynamic import for .ts source
const {
  visibleWidth,
  padRight,
  centerPad,
  createCanvas,
  boxTop,
  boxSep,
  boxBottom,
  boxLine,
  boxCenter,
  boxSpacer,
  sectionHeader,
  innerDivider,
  cardTop,
  cardLine,
  cardDivider,
  cardSpacer,
  cardBottom,
  indentedLine,
} = await import("./render-engine.ts");

describe("render-engine: visibleWidth", () => {
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

describe("render-engine: padRight", () => {
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

describe("render-engine: centerPad", () => {
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

describe("render-engine: createCanvas", () => {
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

describe("render-engine: Box components", () => {
  // createCanvas(56) → W=60, O_INNER=56
  const c = createCanvas(56);

  it("boxTop length equals canvas.W", () => {
    const line = boxTop(c);
    assert.equal(line.length, c.W);
    assert.equal(line[0], "┌");
    assert.equal(line[line.length - 1], "┐");
  });

  it("boxSep length equals canvas.W", () => {
    const line = boxSep(c);
    assert.equal(line.length, c.W);
    assert.equal(line[0], "├");
    assert.equal(line[line.length - 1], "┤");
  });

  it("boxBottom length equals canvas.W", () => {
    const line = boxBottom(c);
    assert.equal(line.length, c.W);
    assert.equal(line[0], "└");
    assert.equal(line[line.length - 1], "┘");
  });

  it("boxLine text has visibleWidth = W and content fills O_INNER", () => {
    const line = boxLine(c, "测试");
    assert.equal(visibleWidth(line), c.W, "visual width should equal W");
    assert.equal(line[0], "│");
    assert.equal(line[line.length - 1], "│");
    // content between │ and │ should have visibleWidth = O_INNER
    const content = line.slice(2, -2);
    assert.equal(visibleWidth(content), c.O_INNER);
  });

  it("boxCenter centers text", () => {
    const line = boxCenter(c, "hello");
    assert.equal(visibleWidth(line), c.W);
    const content = line.slice(2, -2);
    assert.equal(visibleWidth(content), c.O_INNER);
  });

  it("boxSpacer length equals canvas.W (spacer is all ASCII)", () => {
    const line = boxSpacer(c);
    assert.equal(line.length, c.W);
  });

  it("frame-only lines have JS length === W (no CJK content)", () => {
    const c2 = createCanvas(66); // W = 70
    assert.equal(boxTop(c2).length, 70);
    assert.equal(boxSep(c2).length, 70);
    assert.equal(boxBottom(c2).length, 70);
    assert.equal(boxSpacer(c2).length, 70);
  });
});

describe("render-engine: Section components", () => {
  // createCanvas(56) → W=60, O_INNER=56
  const c = createCanvas(56);

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
    // all inner chars should be ─
    const inner = line.slice(3, -3);
    assert(inner.split("").every((ch) => ch === "─"));
  });
});

describe("render-engine: Card components", () => {
  // createCanvas(56) → W=60, O_INNER=56, CARD_INNER=50
  const c = createCanvas(56);

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
    // The dashes between the title content and ┐
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
    // boxLine adds │ (1) + space (1), indent adds 4 spaces = 6 total prefix
    // But visible width: │ = 1, spaces = 6, so 7 visible units before text
    assert(line.startsWith("│     text")); // │ + 1 space from boxLine + 4 spaces from indent = 5 spaces
  });
});

describe("render-engine: width consistency across all widths", () => {
  // Test at lower, upper, and middle widths
  // Use visibleWidth() for content lines, length for frame-only lines
  const widths = [50, 60, 70, 80];
  const testTitle = "世界更新";

  for (const w of widths) {
    it(`all components have visible width ${w} for W=${w}`, () => {
      const c = createCanvas(w - 4);
      assert.equal(c.W, w);

      // Frame-only lines: JS length === W (no CJK in the line)
      assert.equal(boxTop(c).length, w);
      assert.equal(boxSep(c).length, w);
      assert.equal(boxBottom(c).length, w);
      assert.equal(boxSpacer(c).length, w);

      // Content lines: visible width === W (CJK may make JS length < W)
      assert.equal(visibleWidth(boxLine(c, "测试内容")), w);
      assert.equal(visibleWidth(boxCenter(c, "测试")), w);
      assert.equal(visibleWidth(sectionHeader(c, testTitle)), w);
      assert.equal(visibleWidth(innerDivider(c)), w);
      assert.equal(visibleWidth(cardTop(c, "🎮", "测试标题")), w);
      assert.equal(visibleWidth(cardLine(c, "内容")), w);
      assert.equal(visibleWidth(cardDivider(c)), w);
      assert.equal(visibleWidth(cardSpacer(c)), w);
      assert.equal(visibleWidth(cardBottom(c)), w);
      assert.equal(visibleWidth(indentedLine(c, 3, "▷ 内容")), w);
    });
  }
});

describe("render-engine: indentedLine", () => {
  // createCanvas(56) → W=60, O_INNER=56
  const c = createCanvas(56);

  it("preserves indent spacing", () => {
    const line = indentedLine(c, 3, "▷ 测试");
    assert.equal(visibleWidth(line), c.W);
    // Between │ and │ should have 3 spaces + content
    const content = line.slice(2, -2);
    assert.equal(content.slice(0, 3), "   ");
  });

  it("uses boxLine for rendering", () => {
    const direct = boxLine(c, "   ▷ 内容");
    const viaIndent = indentedLine(c, 3, "▷ 内容");
    assert.equal(direct, viaIndent);
  });
});
