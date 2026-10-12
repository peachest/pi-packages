import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { FakeFs, type Fs } from "../fx.ts";
import { createTranscriptAdapter } from "../transcript-adapter.ts";

/**
 * 票 19 B 层 fixture——代表性样本，字段表随 harness-v2 对齐（#31 授权实现票固化；残留风险正典 #31）。
 * 形态来源：
 *  - v3：真机 ground truth（pi 1.1.0 @earendil-works/pi-coding-agent dist/core/session-manager.js
 *    appendCustomMessageEntry + 真实 session 文件采样 2026-10-12）：
 *    头行 {"type":"session","version":3,...}；通知条目 {"type":"custom_message","customType",
 *    "content","display","details"?,"id","parentId","timestamp"}。
 *  - v4：harness-v2 研究（~/research/pi-harness-v2/harness-v2.md L1448-1476/L1672-1687）：
 *    头行 {"kind":"header","version":4,...}；v3 custom_message 规范化为 custom agent
 *    message（pi 1.1.0 dist/core/messages.js createCustomMessage → message:{role:"custom",
 *    customType,content,display,details}）；行级 lane 信封 = message.content 数组内带
 *    sessionId 字段的条目（herdr/multi-agent 派发场景，coordinator 裁定 2026-10-12）。
 * 通知条目载体 = customType 为 NOTIFICATION_CUSTOM_TYPE 的 custom message；
 * 机器校验三元组（notificationId/verdict/evidenceRef）住 details（pi API 语义：
 * extension 专有元数据，不进 LLM 上下文）。
 */
const V3_HEADER = '{"type":"session","version":3,"id":"019ff957-13b4-7069-9a72-362ccce9e5f8","timestamp":"2026-08-13T04:17:41.301Z","cwd":"/tmp/proj"}';
const V4_HEADER = '{"kind":"header","version":4,"id":"s-4","createdAt":"2026-10-12T03:21:40.505Z","cwd":"/tmp/proj"}';

const REF = { sessionFile: "/tmp/fake-session.jsonl" };

function v3NotificationLine(id: string, verdict: string, evidenceRef?: string): string {
  const details: Record<string, string> = { notificationId: id, verdict };
  if (evidenceRef !== undefined) details.evidenceRef = evidenceRef;
  return JSON.stringify({
    type: "custom_message",
    customType: "pi-events.notification",
    content: `billboard: ${id}`,
    display: true,
    details,
    id: "e9",
    parentId: "e8",
    timestamp: "2026-10-12T03:22:00.000Z",
  });
}

function v4NotificationLine(id: string, verdict: string, evidenceRef?: string): string {
  const details: Record<string, string> = { notificationId: id, verdict };
  if (evidenceRef !== undefined) details.evidenceRef = evidenceRef;
  return JSON.stringify({
    kind: "entry",
    id: "e12",
    parentId: "e11",
    type: "message",
    timestamp: 1760236920000,
    message: {
      role: "custom",
      customType: "pi-events.notification",
      content: `billboard: ${id}`,
      display: true,
      details,
    },
  });
}

describe("票 19 组 2——verify(notificationId)：v3/v4 正例（字段路径表逐条）", () => {
  it("v3 custom_message：details 三元组命中 → passed + evidenceRef + form.format=v3", async () => {
    const fs = new FakeFs({ [REF.sessionFile]: `${V3_HEADER}\n${v3NotificationLine("n-1", "passed", "ev-1")}\n` });
    expect(await createTranscriptAdapter(fs).verify(REF, "n-1")).toEqual({
      verdict: "passed",
      evidenceRef: "ev-1",
      format: "v3",
    });
  });

  it("v4 custom agent message：message.details 三元组命中 → failed + evidenceRef + format=v4", async () => {
    const fs = new FakeFs({ [REF.sessionFile]: `${V4_HEADER}\n${v4NotificationLine("n-2", "failed", "ev-2")}\n` });
    expect(await createTranscriptAdapter(fs).verify(REF, "n-2")).toEqual({
      verdict: "failed",
      evidenceRef: "ev-2",
      format: "v4",
    });
  });
});

describe("票 19 组 3——lane 信封（herdr/multi-agent 派发场景：content 数组内带 sessionId 字段的条目，单列透传）", () => {
  it("content 数组含 sessionId 条目：verdict 载体不变（details），sessionId 单列 → lane", async () => {
    const line = JSON.stringify({
      kind: "entry",
      id: "e14",
      parentId: "e13",
      type: "message",
      timestamp: 1760236920000,
      message: {
        role: "custom",
        customType: "pi-events.notification",
        content: [
          { type: "text", text: "billboard: n-3" },
          { sessionId: "w3:pA" },
        ],
        display: true,
        details: { notificationId: "n-3", verdict: "waiting", evidenceRef: "ev-3" },
      },
    });
    const fs = new FakeFs({ [REF.sessionFile]: `${V4_HEADER}\n${line}\n` });
    expect(await createTranscriptAdapter(fs).verify(REF, "n-3")).toEqual({
      verdict: "waiting",
      evidenceRef: "ev-3",
      format: "v4",
      lane: "w3:pA",
    });
  });

  it("无 sessionId 条目：lane 不出现（信封缺席 = 无派发场景）", async () => {
    const fs = new FakeFs({ [REF.sessionFile]: `${V4_HEADER}\n${v4NotificationLine("n-4", "passed")}\n` });
    const result = await createTranscriptAdapter(fs).verify(REF, "n-4");
    expect(result.lane).toBeUndefined();
  });
});

describe("票 19 组 4——撕裂尾行：截断于任意字节均不误判（JSONL 无 fsync，尾行 = 未确认写入）", () => {
  // 尾行 = 未确认写入（harness-v2 原义）：撕裂只影响该行——前文判定不受影响；
  // 撕裂的半行若恰是通知条目自身 = 从未落盘确认 → 不得计入（零误判两面）。
  const good = v3NotificationLine("n-t", "passed", "ev-t");
  const tail = '{"type":"message","id":"e15","parentId":"e9"'; // 半行合法 JSONL 条目（撕裂于任意字节）
  it.each([1, 5, 17, 40, tail.length])("撕裂尾行截断至 %i 字节：前文判定不受影响 → passed", (cut) => {
    const fs = new FakeFs({ [REF.sessionFile]: `${V3_HEADER}\n${good}\n${tail.slice(0, cut)}` });
    return expect(createTranscriptAdapter(fs).verify(REF, "n-t")).resolves.toEqual({
      verdict: "passed",
      evidenceRef: "ev-t",
      format: "v3",
    });
  });

  it.each([1, 30])("v4 撕裂尾行截断至 %i 字节：同容错 → passed", (cut) => {
    const good4 = v4NotificationLine("n-t4", "passed", "ev-t4");
    const fs = new FakeFs({ [REF.sessionFile]: `${V4_HEADER}\n${good4}\n${tail.slice(0, cut)}` });
    return expect(createTranscriptAdapter(fs).verify(REF, "n-t4")).resolves.toMatchObject({ verdict: "passed" });
  });

  it("撕裂的半行恰是通知条目自身：从未确认 → 不计入（零误判，不产生假阳性）", async () => {
    const fs = new FakeFs({ [REF.sessionFile]: `${V3_HEADER}\n${good}\n${good.slice(0, 30)}` });
    expect(await createTranscriptAdapter(fs).verify(REF, "n-t")).toEqual({
      verdict: "passed", // 前文完整条目仍在，判定不变
      evidenceRef: "ev-t",
      format: "v3",
    });
    expect(await createTranscriptAdapter(fs).verify(REF, "n-never-written")).toEqual({
      verdict: "waiting",
      reason: "not-found",
    });
  });

  it("中段坏行 ≠ 撕裂（其后仍有合法行）→ unknown（corrupt-line）", async () => {
    const fs = new FakeFs({
      [REF.sessionFile]: `${V3_HEADER}\n{not json}\n${v3NotificationLine("n-c", "passed")}\n`,
    });
    expect(await createTranscriptAdapter(fs).verify(REF, "n-c")).toEqual({
      verdict: "unknown",
      reason: "corrupt-line",
    });
  });
});

describe("票 19 组 5——歧义保守降级（C1：unknown 是正常返回值，不抛异常）", () => {
  it("同 notificationId 双条目 verdict 冲突 → unknown + conflicting-verdicts", async () => {
    const fs = new FakeFs({
      [REF.sessionFile]: `${V3_HEADER}\n${v3NotificationLine("n-x", "passed")}\n${v3NotificationLine("n-x", "failed")}\n`,
    });
    expect(await createTranscriptAdapter(fs).verify(REF, "n-x")).toEqual({
      verdict: "unknown",
      reason: "conflicting-verdicts",
    });
  });

  it("命中条目无 verdict 字段 → unknown + verdict-missing", async () => {
    const line = JSON.stringify({
      type: "custom_message",
      customType: "pi-events.notification",
      content: "billboard: n-y",
      details: { notificationId: "n-y" },
      id: "e20",
      parentId: "e19",
      timestamp: "2026-10-12T03:22:00.000Z",
    });
    const fs = new FakeFs({ [REF.sessionFile]: `${V3_HEADER}\n${line}\n` });
    expect(await createTranscriptAdapter(fs).verify(REF, "n-y")).toEqual({
      verdict: "unknown",
      reason: "verdict-missing",
    });
  });

  it("条目未出现 → waiting + not-found（未落盘 ≠ 不存在，撕裂窗口零假阴性）", async () => {
    const fs = new FakeFs({ [REF.sessionFile]: `${V3_HEADER}\n${v3NotificationLine("other", "passed")}\n` });
    expect(await createTranscriptAdapter(fs).verify(REF, "n-z")).toEqual({
      verdict: "waiting",
      reason: "not-found",
    });
  });

  it("文件不可读 → unknown + unreadable", async () => {
    expect(await createTranscriptAdapter(new FakeFs({})).verify(REF, "n-1")).toEqual({
      verdict: "unknown",
      reason: "unreadable",
    });
  });
});

describe("票 19 Finding 修复——形态归类按命中条目字段路径（header 仅提示；ocr 评审 medium：无 header 的 v4 文件不误报 v3）", () => {
  it("无 header 的 v4 文件（无 lane 信封）：v4 路径命中 → format v4", async () => {
    const fs = new FakeFs({ [REF.sessionFile]: `${v4NotificationLine("n-h4", "passed", "ev-h4")}\n` });
    expect(await createTranscriptAdapter(fs).verify(REF, "n-h4")).toEqual({
      verdict: "passed",
      evidenceRef: "ev-h4",
      format: "v4",
    });
  });

  it("无 header 的 v3 文件：v3 路径命中 → format v3（对称钉住）", async () => {
    const fs = new FakeFs({ [REF.sessionFile]: `${v3NotificationLine("n-h3", "failed")}\n` });
    expect(await createTranscriptAdapter(fs).verify(REF, "n-h3")).toEqual({
      verdict: "failed",
      format: "v3",
    });
  });
});

describe("票 19 组 6——只读断言（无写调用）：fx Fs 接口无写方法 + adapter 调用前后文件面不变", () => {
  it("locate/verify 前后 FakeFs 文件面逐字节不变", async () => {
    const fs = new FakeFs({ [REF.sessionFile]: `${V3_HEADER}\n${v3NotificationLine("n-r", "passed", "ev-r")}\n{torn` });
    const before = new Map(fs.files);
    const adapter = createTranscriptAdapter(fs);
    await adapter.locate(REF);
    await adapter.verify(REF, "n-r");
    await adapter.verify(REF, "n-never");
    expect(fs.files.size).toBe(before.size);
    for (const [k, v] of before) expect(fs.files.get(k)).toBe(v); // 逐键同串：零写入零改写
  });

  it("fx Fs 接口面本身无写方法（类型层只读，票 12 收窄裁定）", () => {
    // 编译层断言：Fs 唯一方法 readFile；运行时键集同构证明无写入通道。
    const fs = new FakeFs({});
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(fs)).filter((m) => m !== "constructor")).toEqual(["readFile"]);
  });
});

describe("票 19 组 1——locate(sessionRef)→transcript 路径 + 文件头采样形态判别（#31 逐 session 后端探测）", () => {
  it("v3 文件：返回路径 + format v3", async () => {
    const fs = new FakeFs({ [REF.sessionFile]: `${V3_HEADER}\n` });
    expect(await createTranscriptAdapter(fs).locate(REF)).toEqual({ path: REF.sessionFile, format: "v3" });
  });

  it("v4 文件：返回路径 + format v4", async () => {
    const fs = new FakeFs({ [REF.sessionFile]: `${V4_HEADER}\n` });
    expect(await createTranscriptAdapter(fs).locate(REF)).toEqual({ path: REF.sessionFile, format: "v4" });
  });

  it("头行缺失/空文件：路径仍在，format unknown（#31 歧义 → 按 JSONL 扫描最保守路径）", async () => {
    const fs = new FakeFs({ [REF.sessionFile]: "\n" });
    expect(await createTranscriptAdapter(fs).locate(REF)).toEqual({ path: REF.sessionFile, format: "unknown" });
  });

  it("locate 失败路径：文件不存在（ENOENT）→ null", async () => {
    expect(await createTranscriptAdapter(new FakeFs({})).locate(REF)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 票 20——逐 session 双后端分流（#31 双后端 MVP 裁定 2026-10-10：v3 JSONL 与 harness-v2 SQLite 并存）
// ---------------------------------------------------------------------------

const SETTINGS_PATH = "/tmp/fake-pi-settings.json";
// 待对齐：harness-v2 会话存储 settings key 未定稿，此为代表形态（fixture 自造）。
const SETTINGS_SQLITE = JSON.stringify({ sessionStorage: { backend: "sqlite" } });

const tmpDirs: string[] = [];
function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "eda-tadapter-"));
  tmpDirs.push(dir);
  return join(dir, "sessions.db");
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/** 真实 SQLite fixture 库（harness-v2 形态代表性样本，待对齐：schema 以 packages/session-backends/sqlite-node 定稿为准）。 */
function makeHarnessV2Db(
  dbPath: string,
  sessionId: string,
  notifications: Array<{ seq: number; id: string; notificationId?: string; verdict?: string; evidenceRef?: string }>,
): void {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session_sequences (session_id TEXT PRIMARY KEY, next_seq INTEGER NOT NULL);
    CREATE TABLE entries (
      session_id TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL, parent_id TEXT,
      type TEXT NOT NULL, timestamp TEXT, payload TEXT NOT NULL, PRIMARY KEY (session_id, seq)
    );
    CREATE TABLE branch_entries (
      session_id TEXT NOT NULL, branch_id TEXT NOT NULL, entry_id TEXT NOT NULL,
      entry_seq INTEGER NOT NULL, entry_type TEXT, custom_type TEXT
    );
    CREATE TABLE branch_tips (session_id TEXT NOT NULL, branch_id TEXT NOT NULL, tip_id TEXT NOT NULL, PRIMARY KEY (session_id, branch_id));
  `);
  db.prepare("INSERT INTO session_sequences VALUES (?, 100)").run(sessionId);
  const putEntry = db.prepare("INSERT INTO entries VALUES (?, ?, ?, NULL, 'message', '2026-10-12T00:00:00.000Z', ?)");
  const putBranch = db.prepare("INSERT INTO branch_entries VALUES (?, 'B1', ?, ?, 'message', ?)");
  for (const n of notifications) {
    const details: Record<string, string> = {};
    if (n.notificationId !== undefined) details.notificationId = n.notificationId;
    if (n.verdict !== undefined) details.verdict = n.verdict;
    if (n.evidenceRef !== undefined) details.evidenceRef = n.evidenceRef;
    putEntry.run(
      sessionId,
      n.seq,
      n.id,
      JSON.stringify({ role: "custom", customType: "pi-events.notification", content: `billboard: ${n.notificationId ?? ""}`, display: true, details }),
    );
    putBranch.run(sessionId, n.id, n.seq, n.notificationId !== undefined ? "pi-events.notification" : null);
  }
  db.close();
}

describe("票 20 组 7——逐 session 后端判别（registerSession：pi settings + 文件头采样，#31）", () => {
  it("JSONL 命中：无 settings 信号 + v4 头 → backend jsonl 无 warning，verify 走 JSONL 扫描", async () => {
    const fs = new FakeFs({ [REF.sessionFile]: `${V4_HEADER}\n${v4NotificationLine("n-1", "passed", "ev-1")}\n` });
    const a = createTranscriptAdapter(fs);
    expect(await a.registerSession(REF)).toEqual({ backend: "jsonl" });
    expect(await a.verify(REF, "n-1")).toEqual({ verdict: "passed", evidenceRef: "ev-1", format: "v4" });
  });

  it("SQLite 命中：settings=sqlite + sessionId + 非 JSONL 头（库文件）→ backend sqlite，verify 走 SQL 点查", async () => {
    const dbPath = tmpDbPath();
    makeHarnessV2Db(dbPath, "s-1", [{ seq: 1, id: "e1", notificationId: "n-9", verdict: "failed", evidenceRef: "ev-9" }]);
    const fs = new FakeFs({ [SETTINGS_PATH]: SETTINGS_SQLITE });
    const a = createTranscriptAdapter(fs, { settingsPath: SETTINGS_PATH });
    const ref = { sessionFile: dbPath, sessionId: "s-1" };
    expect(await a.registerSession(ref)).toEqual({ backend: "sqlite" });
    expect(await a.verify(ref, "n-9")).toEqual({ verdict: "failed", evidenceRef: "ev-9", format: "v4" });
  });

  it("歧义→JSONL+warning：settings=sqlite 但文件头为 v4 JSONL（信号矛盾）→ 保守回退 JSONL 扫描", async () => {
    const fs = new FakeFs({
      [SETTINGS_PATH]: SETTINGS_SQLITE,
      [REF.sessionFile]: `${V4_HEADER}\n${v4NotificationLine("n-2", "waiting")}\n`,
    });
    const a = createTranscriptAdapter(fs, { settingsPath: SETTINGS_PATH });
    expect(await a.registerSession(REF)).toEqual({ backend: "jsonl", warning: "ambiguous-backend" });
    expect(await a.verify(REF, "n-2")).toEqual({ verdict: "waiting", format: "v4" });
  });

  it("歧义→JSONL+warning：settings=sqlite 但 ref 缺 sessionId（sqlite 信号不完整，库内无法定域）", async () => {
    const fs = new FakeFs({ [SETTINGS_PATH]: SETTINGS_SQLITE });
    const a = createTranscriptAdapter(fs, { settingsPath: SETTINGS_PATH });
    expect(await a.registerSession({ sessionFile: "/tmp/some-session.db" })).toEqual({
      backend: "jsonl",
      warning: "ambiguous-backend",
    });
  });
});

describe("票 20 组 8——两后端等价面（同一 notificationId 经 JSONL 与 SQLite verify 结果一致）", () => {
  it("同逻辑条目双后端 verify 深相等（verdict/evidenceRef/format）", async () => {
    const jsonlAdapter = createTranscriptAdapter(
      new FakeFs({ [REF.sessionFile]: `${V4_HEADER}\n${v4NotificationLine("n-eq", "passed", "ev-eq")}\n` }),
    );
    const dbPath = tmpDbPath();
    makeHarnessV2Db(dbPath, "s-eq", [{ seq: 7, id: "e7", notificationId: "n-eq", verdict: "passed", evidenceRef: "ev-eq" }]);
    const sqliteAdapter = createTranscriptAdapter(new FakeFs({ [SETTINGS_PATH]: SETTINGS_SQLITE }), { settingsPath: SETTINGS_PATH });
    const ref = { sessionFile: dbPath, sessionId: "s-eq" };
    expect(await sqliteAdapter.registerSession(ref)).toEqual({ backend: "sqlite" });
    expect(await sqliteAdapter.verify(ref, "n-eq")).toEqual(await jsonlAdapter.verify(REF, "n-eq"));
  });
});

describe("票 20 组 9——注册路径（新 session 注册触发判别并缓存路由）", () => {
  it("注册后 settings 信号改变不影响已注册 session 的路由（判别在注册时点）", async () => {
    const dbPath = tmpDbPath();
    makeHarnessV2Db(dbPath, "s-1", [{ seq: 1, id: "e1", notificationId: "n-9", verdict: "passed" }]);
    const fs = new FakeFs({ [SETTINGS_PATH]: SETTINGS_SQLITE });
    const a = createTranscriptAdapter(fs, { settingsPath: SETTINGS_PATH });
    const ref = { sessionFile: dbPath, sessionId: "s-1" };
    expect(await a.registerSession(ref)).toEqual({ backend: "sqlite" });
    fs.files.delete(SETTINGS_PATH); // settings 消失
    expect(await a.verify(ref, "n-9")).toEqual({ verdict: "passed", format: "v4" });
  });
});

// ---------------------------------------------------------------------------
// 票 21——C1 启动自检 + 双层降级（全局降级模式 vs 单条兜底，#31 C1 正典语义）
// ---------------------------------------------------------------------------

/** 系统性不可读（EACCES）——非 ENOENT，后端故障形态。 */
class DenyFs implements Fs {
  readFile(): Promise<string> {
    return Promise.reject(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }));
  }
}

describe("票 21 组 10——C1 启动自检 + 全局降级（推送即视为 accepted、不再 verify）", () => {
  it("自检通过：注册可读 session → {ok:true}、非降级、verify 正常推导", async () => {
    const fs = new FakeFs({ [REF.sessionFile]: `${V4_HEADER}\n${v4NotificationLine("n-1", "passed", "ev-1")}\n` });
    const a = createTranscriptAdapter(fs);
    await a.registerSession(REF);
    expect(await a.selfCheck()).toEqual({ ok: true });
    expect(a.isDegraded()).toBe(false);
    expect(await a.verify(REF, "n-1")).toEqual({ verdict: "passed", evidenceRef: "ev-1", format: "v4" });
  });

  it("自检失败（后端系统性不可读 EACCES）→ {ok:false,reason} + 降级标志 + verify 拒推 verdict（unknown+degraded）", async () => {
    const a = createTranscriptAdapter(new DenyFs());
    await a.registerSession(REF);
    expect(await a.selfCheck()).toEqual({ ok: false, reason: expect.stringContaining(REF.sessionFile) });
    expect(a.isDegraded()).toBe(true);
    expect(a.degradeReason()).toContain("unreadable");
    expect(await a.verify(REF, "n-1")).toEqual({ verdict: "unknown", reason: "degraded" });
  });

  it("自检失败（中段坏行 corrupt-line）同样置全局降级", async () => {
    const fs = new FakeFs({ [REF.sessionFile]: `${V4_HEADER}\n{broken\n${v4NotificationLine("n-1", "passed")}\n` });
    const a = createTranscriptAdapter(fs);
    await a.registerSession(REF);
    expect((await a.selfCheck()).ok).toBe(false);
    expect(a.isDegraded()).toBe(true);
  });

  it("恢复路径：自检恢复成功 → 降级清除、verify 回正常推导", async () => {
    const fs = new FakeFs({ [REF.sessionFile]: `${V4_HEADER}\n{broken\n${v4NotificationLine("n-1", "passed")}\n` });
    const a = createTranscriptAdapter(fs);
    await a.registerSession(REF);
    expect((await a.selfCheck()).ok).toBe(false);
    fs.files.set(REF.sessionFile, `${V4_HEADER}\n${v4NotificationLine("n-1", "passed", "ev-1")}\n`);
    expect(await a.selfCheck()).toEqual({ ok: true });
    expect(a.isDegraded()).toBe(false);
    expect(a.degradeReason()).toBeUndefined();
    expect(await a.verify(REF, "n-1")).toEqual({ verdict: "passed", evidenceRef: "ev-1", format: "v4" });
  });

  it("单条歧义与全局降级区分：非降级→单条原因码 conflicting-verdicts；降级→同一查询 unknown+degraded（模式级）", async () => {
    const conflict = `${V4_HEADER}\n${v4NotificationLine("n-c", "passed")}\n${v4NotificationLine("n-c", "failed")}\n`;
    const healthy = createTranscriptAdapter(new FakeFs({ [REF.sessionFile]: conflict }));
    await healthy.registerSession(REF);
    expect((await healthy.selfCheck()).ok).toBe(true);
    expect(await healthy.verify(REF, "n-c")).toEqual({ verdict: "unknown", reason: "conflicting-verdicts" });

    const degraded = createTranscriptAdapter(new DenyFs());
    await degraded.registerSession(REF);
    await degraded.selfCheck();
    expect(await degraded.verify(REF, "n-c")).toEqual({ verdict: "unknown", reason: "degraded" });
  });

  it("ENOENT（新会话未落盘）≠ 后端故障：自检不因此降级，单条兜底照旧 unknown+unreadable", async () => {
    const a = createTranscriptAdapter(new FakeFs({}));
    await a.registerSession(REF);
    expect(await a.selfCheck()).toEqual({ ok: true });
    expect(a.isDegraded()).toBe(false);
    expect(await a.verify(REF, "n-1")).toEqual({ verdict: "unknown", reason: "unreadable" });
  });

  it("SQLite 后端自检：注册 session 的库不可读（文件被删）→ 降级；恢复后回正常", async () => {
    const dbPath = tmpDbPath();
    makeHarnessV2Db(dbPath, "s-1", [{ seq: 1, id: "e1", notificationId: "n-9", verdict: "passed" }]);
    const fs = new FakeFs({ [SETTINGS_PATH]: SETTINGS_SQLITE });
    const a = createTranscriptAdapter(fs, { settingsPath: SETTINGS_PATH });
    const ref = { sessionFile: dbPath, sessionId: "s-1" };
    await a.registerSession(ref);
    expect((await a.selfCheck()).ok).toBe(true);

    rmSync(dbPath);
    expect((await a.selfCheck()).ok).toBe(false);
    expect(a.isDegraded()).toBe(true);
    expect(await a.verify(ref, "n-9")).toEqual({ verdict: "unknown", reason: "degraded" });

    makeHarnessV2Db(dbPath, "s-1", [{ seq: 1, id: "e1", notificationId: "n-9", verdict: "passed" }]);
    expect(await a.selfCheck()).toEqual({ ok: true });
    expect(a.isDegraded()).toBe(false);
    expect(await a.verify(ref, "n-9")).toEqual({ verdict: "passed", format: "v4" });
  });
});
