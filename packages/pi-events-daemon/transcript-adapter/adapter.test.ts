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
