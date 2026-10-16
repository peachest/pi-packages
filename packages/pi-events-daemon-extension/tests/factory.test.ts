/**
 * Ticket 34 — 包入口：默认导出工厂向 pi 注册 9 op 工具（安装面结构断言）
 * + 票 36 session_start 接线（评审 H：fork 检查前退位旧 wake handle）。
 */
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { OP_NAMES } from "pi-events-daemon/protocol.ts";
import eventsDaemonExtension, { loadOpSchema } from "../index.ts";
import { startTestDaemon, waitFor, type TestDaemon } from "./harness.ts";

describe("票 34：pi install 结构面——包 manifest 指向的工厂注册 9 工具", () => {
  it("工厂注册 9 op 工具（fake pi 捕获）", () => {
    const registered: Array<{ name: string }> = [];
    const pi = {
      registerTool: (tool: { name: string }) => registered.push(tool),
      on: () => () => {},
    } as unknown as Parameters<typeof eventsDaemonExtension>[0];
    eventsDaemonExtension(pi, { opSchema: loadOpSchema(), sender: async () => ({}) });
    expect(registered.map((t) => t.name).sort()).toEqual([...OP_NAMES].sort());
  });
});

describe("评审 H：session_start fork——检查前退位旧 wake handle（父连接不活到子会话）", () => {
  it("spawn 建连可达 → fork 事件退位父 handle → 父会话推送零注入", async () => {
    const daemon: TestDaemon = startTestDaemon();
    try {
      const injections: unknown[] = [];
      const handlers: Record<string, Array<(event: { reason: string }, ctx: unknown) => void>> = {};
      const pi = {
        registerTool: () => {},
        on: (event: string, handler: (event: { reason: string }, ctx: unknown) => void) => {
          (handlers[event] ??= []).push(handler);
        },
        sendMessage: (m: unknown) => injections.push(m),
      } as unknown as Parameters<typeof eventsDaemonExtension>[0];
      const ctx = {
        cwd: tmpdir(), // 无 .pi/events.json → 声明链空转
        ui: { notify: () => {} },
        sessionManager: { getSessionId: () => "s1" },
      };
      eventsDaemonExtension(pi, { socketPath: daemon.socketPath, sender: async () => ({}) });

      const onSessionStart = handlers.session_start[0];
      onSessionStart({ reason: "new" }, ctx);
      await waitFor(() => daemon.sessionStarted.includes("s1"), "parent wake registered");
      daemon.handle.broadcastWake("wake", { sessionId: "s1", count: 1, entries: [{ notificationId: "n1", entityRef: "fixture:external/w-1", verdict: "failed" }] });
      await waitFor(() => injections.length === 1, "parent injection"); // 基线：父连接活着推送可达

      onSessionStart({ reason: "fork" }, ctx); // fork：先退位旧 handle 再返回
      await new Promise((res) => setTimeout(res, 80));
      daemon.handle.broadcastWake("wake", { sessionId: "s1", count: 1, entries: [{ notificationId: "n2", entityRef: "fixture:external/w-1", verdict: "failed" }] });
      await new Promise((res) => setTimeout(res, 80));
      expect(injections).toHaveLength(1); // fork 后父推送不再到达（no-inherit）
    } finally {
      await daemon.close();
    }
  });
});
