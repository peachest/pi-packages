import { describe, expect, it } from "vitest";
import { FakeFs } from "../fx/index.ts";
import { createTranscriptAdapter } from "./index.ts";

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
