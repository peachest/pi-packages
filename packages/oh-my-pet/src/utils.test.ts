import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { findProjectRoot, formatStatusLine, encodeProjectPath, resolvePetsBase, migrateOldPetData } from "./utils";

describe("findProjectRoot", () => {
  it("返回非空字符串", () => {
    const root = findProjectRoot();
    expect(typeof root).toBe("string");
    expect(root.length).toBeGreaterThan(0);
  });
});

describe("formatStatusLine", () => {
  it("Lv.1 + 0% + dormant", () => {
    const line = formatStatusLine({
      "core.exp": 0,
      "core.vitality": 0,
    });
    expect(line).toBe("[🐣 Lv.1] ░░░░░░░░░░ 0% ⚡dormant");
  });

  it("Lv.3 + 40% + fast", () => {
    const line = formatStatusLine({
      "core.exp": 2400,
      "core.vitality": 75,
    });
    expect(line).toContain("Lv.3");
    expect(line).toContain("40%");
    expect(line).toContain("fast");
  });

  it("缺失属性默认为 0", () => {
    const line = formatStatusLine({});
    expect(line).toContain("Lv.1");
    expect(line).toContain("0%");
  });
});

describe("encodeProjectPath", () => {
  it("将路径中的 / 替换为 - 并包裹 --", () => {
    const encoded = encodeProjectPath("/mnt/disk1/hyx/projects/foo");
    expect(encoded).toBe("--mnt-disk1-hyx-projects-foo--");
  });

  it("将点号也替换为 -", () => {
    const encoded = encodeProjectPath("/home/user/.config/test");
    expect(encoded).toBe("--home-user--config-test--");
  });

  it("末尾斜杠处理", () => {
    const encoded = encodeProjectPath("/a/b/");
    expect(encoded).toBe("--a-b--");
  });
});

describe("resolvePetsBase", () => {
  const ORIG = process.env.PI_PETS_DIR;

  afterEach(() => {
    if (ORIG === undefined) {
      delete process.env.PI_PETS_DIR;
    } else {
      process.env.PI_PETS_DIR = ORIG;
    }
  });

  it("PI_PETS_DIR 未设置时返回 ~/.pi/agent/pets", () => {
    delete process.env.PI_PETS_DIR;
    const base = resolvePetsBase();
    expect(base.endsWith("/.pi/agent/pets")).toBe(true);
  });

  it("PI_PETS_DIR 设置后返回环境变量值", () => {
    process.env.PI_PETS_DIR = "/custom/pets-dir";
    expect(resolvePetsBase()).toBe("/custom/pets-dir");
  });

  it("PI_PETS_DIR 为空字符串时回退默认路径", () => {
    process.env.PI_PETS_DIR = "";
    const base = resolvePetsBase();
    expect(base.endsWith("/.pi/agent/pets")).toBe(true);
  });
});

describe("migrateOldPetData", () => {
  it("旧 .pet/binlogs 存在时迁移到新位置", () => {
    const tmpBase = mkdtempSync("/tmp/pet-migrate-base-");
    const tmpProject = mkdtempSync("/tmp/pet-migrate-project-");

    const oldBinlogDir = join(tmpProject, ".pet", "binlogs");
    mkdirSync(oldBinlogDir, { recursive: true });
    writeFileSync(join(oldBinlogDir, "session-1.log"), '{"sessionId":"s1"}\n');
    writeFileSync(join(oldBinlogDir, "session-2.log"), '{"sessionId":"s2"}\n');

    migrateOldPetData(tmpProject, tmpBase);

    const encoded = encodeProjectPath(tmpProject);
    const newBinlogDir = join(tmpBase, encoded, "binlogs");
    expect(existsSync(newBinlogDir)).toBe(true);
    expect(existsSync(join(newBinlogDir, "session-1.log"))).toBe(true);
    expect(existsSync(join(newBinlogDir, "session-2.log"))).toBe(true);
    expect(existsSync(join(tmpProject, ".pet"))).toBe(false);

    rmSync(tmpBase, { recursive: true, force: true });
    rmSync(tmpProject, { recursive: true, force: true });
  });

  it("旧数据不存在时静默跳过", () => {
    const tmpBase = mkdtempSync("/tmp/pet-migrate-base-");
    const tmpProject = mkdtempSync("/tmp/pet-migrate-nodata-");

    expect(() => migrateOldPetData(tmpProject, tmpBase)).not.toThrow();

    rmSync(tmpBase, { recursive: true, force: true });
    rmSync(tmpProject, { recursive: true, force: true });
  });

  it("新位置已有数据时不覆盖", () => {
    const tmpBase = mkdtempSync("/tmp/pet-migrate-nocopy-");
    const tmpProject = mkdtempSync("/tmp/pet-migrate-collide-");

    const oldDir = join(tmpProject, ".pet", "binlogs");
    mkdirSync(oldDir, { recursive: true });
    writeFileSync(join(oldDir, "session-1.log"), '{"sessionId":"old"}\n');

    const encoded = encodeProjectPath(tmpProject);
    const newDir = join(tmpBase, encoded, "binlogs");
    mkdirSync(newDir, { recursive: true });
    writeFileSync(join(newDir, "session-1.log"), '{"sessionId":"new"}\n');

    migrateOldPetData(tmpProject, tmpBase);

    const content = readFileSync(join(newDir, "session-1.log"), "utf-8");
    expect(content).toBe('{"sessionId":"new"}\n');
    expect(existsSync(oldDir)).toBe(true);

    rmSync(tmpBase, { recursive: true, force: true });
    rmSync(tmpProject, { recursive: true, force: true });
  });
});
