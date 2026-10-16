/**
 * Ticket 35 — 声明链 e2e（C 层，真 socket）：events.json → session 启动声明 → origin:auto 投递命中。
 *
 * daemon 侧 = 测试 harness（serve + MemoryStore + startLoops + Pusher→broadcastWake("wake")），
 * 即票 38 组合根的预演替身；extension 侧 = 被测实现（findEventsJson/readEventsJson/
 * loadTemplates/declareAutoSubscriptions + 真 op client + epoch 旁车文件）。
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOpClient, type OpClient } from "../index.ts";
import { declareAutoSubscriptions, findEventsJson, loadTemplates, readEventsJson } from "../index.ts";
import { connectWakeClient, EPOCH, startTestDaemon, waitFor, type TestDaemon } from "./harness.ts";

let daemon: TestDaemon | null = null;
let client: OpClient | null = null;
let wakeClient: Awaited<ReturnType<typeof connectWakeClient>> | null = null;

afterEach(async () => {
  await wakeClient?.client.close();
  await client?.close();
  await daemon?.close();
  daemon = null;
  client = null;
  wakeClient = null;
});

describe("票 35：声明链 e2e——events.json → 启动声明 → origin:auto 投递命中", () => {
  it("声明入 daemon（origin=auto/scope=project 行）→ transition failed 绕行直推 → 声明 session 收到 wake", async () => {
    daemon = startTestDaemon();
    const root = daemon.dir;
    mkdirSync(join(root, ".pi"));
    writeFileSync(
      join(root, ".pi", "events.json"),
      JSON.stringify({ subscriptions: [{ template: "df-free", params: { path: "/tmp", threshold_kb: "10240" }, on: "failed" }] }),
    );

    // session 启动声明链（index.ts session_start 钩子内的同一段流程，直接驱动）
    client = createOpClient({ socketPath: daemon.socketPath, epoch: EPOCH });
    const found = findEventsJson(root);
    expect(found).not.toBeNull();
    const doc = readEventsJson(found!.path);
    expect(doc.ok).toBe(true);
    const reg = loadTemplates();
    const r = await declareAutoSubscriptions(doc.ok ? doc.subscriptions : [], (op, params) => client!.request(op, params), reg);
    expect(r.failed).toEqual([]);

    // daemon 侧落账：订阅行 origin=auto；帧按同源契约通过
    await waitFor(() => daemon!.store.querySubscriptions({}).length === 1, "subscription row");
    const row = daemon!.store.querySubscriptions({})[0];
    expect(row.origin).toBe("auto");
    expect(row.template).toBe("df-free");
    expect(row.check).toContain("'/tmp'");
    expect(daemon!.subscribeFrames[0]).toMatchObject({ entityRef: expect.stringContaining("fs:path:"), check: expect.stringContaining("df -Pk") });

    // 声明 session 上线（长连接 = SESSION_START）；等注册信号后再翻转，保证 FIFO 下 fanOut 见已注册 session
    wakeClient = await connectWakeClient(daemon, "s1");
    await waitFor(() => daemon!.sessionStarted.includes("s1"), "session start registration");

    // 状态翻转（failed 绕行：不等批窗立即冲刷）→ origin:auto 投 scope 内活跃 session
    daemon!.loops.submit({ kind: "transition", ref: { type: "fs:path", key: "external//tmp" }, verdict: "failed", occurredAt: new Date().toISOString() });

    await waitFor(() => wakeClient!.notifications.length === 1, "wake push");
    const n = wakeClient!.notifications[0];
    expect(n.method).toBe("wake");
    const envelope = n.params as { sessionId: string; count: number; entries: Array<{ entityRef: string; verdict: string }> };
    expect(envelope.sessionId).toBe("s1");
    expect(envelope.count).toBe(1);
    expect(envelope.entries[0].verdict).toBe("failed");
    expect(envelope.entries[0].entityRef).toMatch(/^fs:path:external\//);

    // 投递铁律第一环：推送后行转 accepted（daemon 侧已持久化）
    await waitFor(() => daemon!.store.pendingDeliveries({}).every((d) => d.state === "accepted"), "row accepted");
  });
});
