import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "fs";
import { join } from "path";
import { BinlogManager } from "./binlog";
import { encodeProjectPath } from "./utils";

describe("BinlogManager", () => {
  let tmpPetsBase: string;
  let tmpProjectRoot: string;
  let manager: BinlogManager;

  beforeEach(() => {
    tmpPetsBase = mkdtempSync("/tmp/pet-binlog-base-");
    tmpProjectRoot = mkdtempSync("/tmp/pet-project-");
    manager = new BinlogManager(tmpPetsBase, tmpProjectRoot);
  });

  afterEach(() => {
    rmSync(tmpPetsBase, { recursive: true, force: true });
    rmSync(tmpProjectRoot, { recursive: true, force: true });
  });

  it("写入一条 entry 后能完整读回，数据一一对应", () => {
    const entry = {
      sessionId: "session-1",
      responseId: "resp-001",
      timestamp: 1700000000000,
      mod: "feeding",
      attributes: { "core.exp": 50, "core.fullness": 80 },
    };

    manager.appendEntry("session-1", entry);

    const entries = manager.readAllEntries();
    expect(entries).toHaveLength(1);

    const read = entries[0];
    expect(read.sessionId).toBe("session-1");
    expect(read.seq).toBe(1);
    expect(read.responseId).toBe("resp-001");
    expect(read.timestamp).toBe(1700000000000);
    expect(read.mod).toBe("feeding");
    expect(read.attributes).toEqual({ "core.exp": 50, "core.fullness": 80 });
  });

  it("同一 session 连续追加多条 entry，seq 递增", () => {
    manager.appendEntry("session-1", { responseId: "r1", timestamp: 1, mod: "feeding", attributes: {} });
    manager.appendEntry("session-1", { responseId: "r2", timestamp: 2, mod: "feeding", attributes: {} });
    manager.appendEntry("session-1", { responseId: "r3", timestamp: 3, mod: "feeding", attributes: {} });

    const entries = manager.readAllEntries();
    expect(entries).toHaveLength(3);
    expect(entries.map(e => e.seq)).toEqual([1, 2, 3]);
  });

  it("同 session 同 responseId 重复推送被静默忽略", () => {
    manager.appendEntry("session-1", { responseId: "dup", timestamp: 1, mod: "feeding", attributes: { "core.exp": 10 } });
    manager.appendEntry("session-1", { responseId: "dup", timestamp: 2, mod: "feeding", attributes: { "core.exp": 10 } });
    manager.appendEntry("session-1", { responseId: "uniq", timestamp: 3, mod: "feeding", attributes: { "core.exp": 20 } });

    const entries = manager.readAllEntries();
    expect(entries).toHaveLength(2);
    expect(entries.map(e => e.responseId)).toEqual(["dup", "uniq"]);
    expect(entries.map(e => e.seq)).toEqual([1, 2]);
  });

  it("不同 session 写入各自文件，seq 独立计数", () => {
    manager.appendEntry("session-a", { responseId: "a1", timestamp: 1, mod: "feeding", attributes: { "core.exp": 10 } });
    manager.appendEntry("session-b", { responseId: "b1", timestamp: 2, mod: "feeding", attributes: { "core.exp": 20 } });
    manager.appendEntry("session-a", { responseId: "a2", timestamp: 3, mod: "feeding", attributes: { "core.exp": 30 } });

    const entries = manager.readAllEntries();
    expect(entries).toHaveLength(3);

    const a = entries.filter(e => e.sessionId === "session-a");
    expect(a.map(e => e.seq)).toEqual([1, 2]);

    const b = entries.filter(e => e.sessionId === "session-b");
    expect(b.map(e => e.seq)).toEqual([1]);
  });

  it("readAllEntries 跨 session 聚合 + deleteSession 后条目消失", () => {
    manager.appendEntry("s1", { responseId: "r1", timestamp: 1, mod: "feeding", attributes: {} });
    manager.appendEntry("s2", { responseId: "r2", timestamp: 2, mod: "feeding", attributes: {} });

    expect(manager.readAllEntries()).toHaveLength(2);

    manager.deleteSession("s1");
    const remaining = manager.readAllEntries();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].sessionId).toBe("s2");
  });

  it("损坏的符号链接（模拟 ENOENT 竞态）不崩溃", () => {
    // 写入一条有效 session
    manager.appendEntry("s1", { responseId: "r1", timestamp: 1, mod: "test", attributes: {} });

    // 在 binlog 目录中创建一个指向不存在文件的符号链接
    // 模拟并发场景：readdirSync 看到此文件，readFileSync 时已被删除
    const encoded = encodeProjectPath(tmpProjectRoot);
    const binlogDirPath = join(tmpPetsBase, encoded, "binlogs");
    symlinkSync("/nonexistent/dead-file", join(binlogDirPath, "orphan.log"));

    let entries: import("./types").BinlogEntry[] = [];
    expect(() => { entries = manager.readAllEntries(); }).not.toThrow();
    expect(entries).toHaveLength(1);
    expect(entries[0].sessionId).toBe("s1");
  });
});
