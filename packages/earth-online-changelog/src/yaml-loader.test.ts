/**
 * Tests for yaml-loader.ts — thin I/O layer
 *
 * Run: node --test src/yaml-loader.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { loadYamlFile } = await import("./yaml-loader.ts");

const testDir = join(tmpdir(), "earth-online-yaml-loader-test-" + Date.now());

before(() => {
  mkdirSync(join(testDir, "config", "base"), { recursive: true });
});

after(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("loadYamlFile", () => {
  it("returns null when file does not exist", () => {
    const result = loadYamlFile(testDir, "config/base/nonexistent.yaml");
    assert.equal(result, null);
  });

  it("returns null for invalid YAML (parse error)", () => {
    writeFileSync(join(testDir, "config/base", "invalid.yaml"), "key: [unclosed\n", "utf-8");
    const result = loadYamlFile(testDir, "config/base/invalid.yaml");
    assert.equal(result, null);
  });

  it("returns parsed object for valid YAML", () => {
    const yaml = `spring:
  buffs:
    - zh: "光合作用增强"
      en: "Photosynthesis boost"
    - zh: "生长加速"
      en: "Growth acceleration"
  debuffs:
    - zh: "花粉过敏"
      en: "Pollen allergy"
summer:
  buffs:
    - zh: "日光浴加成"
      en: "Sunbathing bonus"
  debuffs:
    - zh: "蚊虫叮咬"
      en: "Mosquito bites"
autumn:
  buffs:
    - zh: "收获速度提升"
      en: "Harvest speed up"
  debuffs:
    - zh: "落叶导致迷路"
      en: "Getting lost in leaves"
winter:
  buffs:
    - zh: "保暖护甲"
      en: "Thermal armor"
  debuffs:
    - zh: "冻伤风险"
      en: "Frostbite risk"
`;
    writeFileSync(join(testDir, "config/base", "valid.yaml"), yaml, "utf-8");
    const result = loadYamlFile(testDir, "config/base/valid.yaml");
    assert.ok(result !== null);
    assert.equal(typeof result, "object");
    // @ts-expect-error: result is unknown but should be object
    assert.ok(result.spring);
    // @ts-expect-error: result is unknown but should be object
    assert.equal(result.spring.buffs.length, 2);
  });

  it("returns parsed data matching YAML structure", () => {
    const yaml = `name: "test"
count: 42
items:
  - a
  - b
`;
    writeFileSync(join(testDir, "config/base", "simple.yaml"), yaml, "utf-8");
    const result = loadYamlFile(testDir, "config/base/simple.yaml");
    assert.ok(result !== null);
    // @ts-expect-error: result is unknown
    assert.equal(result.name, "test");
    // @ts-expect-error: result is unknown
    assert.equal(result.count, 42);
    // @ts-expect-error: result is unknown
    assert.deepEqual(result.items, ["a", "b"]);
  });
});
