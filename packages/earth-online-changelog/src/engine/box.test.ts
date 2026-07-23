/**
 * Tests for engine/box.ts — extracted from render-engine.test.ts
 *
 * Run: node --test src/engine/box.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { boxTop, boxSep, boxBottom, boxLine, boxCenter, boxSpacer, createCanvas, visibleWidth } = await import("./canvas.ts");

// Re-import box functions from the module being tested (after it exists)
const mod = await import("./box.ts");
const boxMod = {
  boxTop: mod.boxTop,
  boxSep: mod.boxSep,
  boxBottom: mod.boxBottom,
  boxLine: mod.boxLine,
  boxCenter: mod.boxCenter,
  boxSpacer: mod.boxSpacer,
};

// createCanvas(56) → W=60, O_INNER=56
const c = createCanvas(56);

describe("Box components", () => {
  it("boxTop length equals canvas.W", () => {
    const line = boxMod.boxTop(c);
    assert.equal(line.length, c.W);
    assert.equal(line[0], "┌");
    assert.equal(line[line.length - 1], "┐");
  });

  it("boxSep length equals canvas.W", () => {
    const line = boxMod.boxSep(c);
    assert.equal(line.length, c.W);
    assert.equal(line[0], "├");
    assert.equal(line[line.length - 1], "┤");
  });

  it("boxBottom length equals canvas.W", () => {
    const line = boxMod.boxBottom(c);
    assert.equal(line.length, c.W);
    assert.equal(line[0], "└");
    assert.equal(line[line.length - 1], "┘");
  });

  it("boxLine text has visibleWidth = W and content fills O_INNER", () => {
    const line = boxMod.boxLine(c, "测试");
    assert.equal(visibleWidth(line), c.W, "visual width should equal W");
    assert.equal(line[0], "│");
    assert.equal(line[line.length - 1], "│");
    const content = line.slice(2, -2);
    assert.equal(visibleWidth(content), c.O_INNER);
  });

  it("boxCenter centers text", () => {
    const line = boxMod.boxCenter(c, "hello");
    assert.equal(visibleWidth(line), c.W);
    const content = line.slice(2, -2);
    assert.equal(visibleWidth(content), c.O_INNER);
  });

  it("boxSpacer length equals canvas.W (spacer is all ASCII)", () => {
    const line = boxMod.boxSpacer(c);
    assert.equal(line.length, c.W);
  });

  it("frame-only lines have JS length === W (no CJK content)", () => {
    const c2 = createCanvas(66); // W = 70
    assert.equal(boxMod.boxTop(c2).length, 70);
    assert.equal(boxMod.boxSep(c2).length, 70);
    assert.equal(boxMod.boxBottom(c2).length, 70);
    assert.equal(boxMod.boxSpacer(c2).length, 70);
  });
});
