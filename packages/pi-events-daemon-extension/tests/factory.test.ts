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
    const commands: string[] = [];
    const shortcuts: string[] = [];
    const pi = {
      registerTool: (tool: { name: string }) => registered.push(tool),
      on: () => () => {},
      registerCommand: (name: string) => commands.push(name),
      registerShortcut: (key: string) => shortcuts.push(key),
    } as unknown as Parameters<typeof eventsDaemonExtension>[0];
    eventsDaemonExtension(pi, { opSchema: loadOpSchema(), sender: async () => ({}) });
    expect(registered.map((t) => t.name).sort()).toEqual([...OP_NAMES].sort());
    // 票 45：dock 入口结构面（默认 ctrl+alt+e——bg dock 占 shift+down，让位换键）
    expect(commands).toEqual(["events-dock"]);
    expect(shortcuts).toEqual(["ctrl+alt+e"]);
  });

  it("dockShortcut: null 关闭快捷键注册（命令入口常驻）", () => {
    const shortcuts: string[] = [];
    const pi = {
      registerTool: () => {},
      on: () => () => {},
      registerCommand: () => {},
      registerShortcut: (key: string) => shortcuts.push(key),
    } as unknown as Parameters<typeof eventsDaemonExtension>[0];
    eventsDaemonExtension(pi, { opSchema: loadOpSchema(), sender: async () => ({}), dockShortcut: null });
    expect(shortcuts).toEqual([]);
  });
});

describe("#189：subscribe 缺省 sessionId 并入（live sessionId 在 session_start 后才可知）", () => {
  it("agent 不传 opts.sessionId 时，daemon 收到的 subscribe 帧带本 session id（sub-0302 事故回归）", async () => {
    const daemon: TestDaemon = startTestDaemon();
    try {
      const handlers: Record<string, Array<(event: unknown, ctx: unknown) => void>> = {};
      const tools: Array<{ name: string; execute: (id: string, params: unknown) => Promise<unknown> }> = [];
      const pi = {
        registerTool: (tool: { name: string; execute: (id: string, params: unknown) => Promise<unknown> }) => tools.push(tool),
        on: (event: string, handler: (event: unknown, ctx: unknown) => void) => {
          (handlers[event] ??= []).push(handler);
        },
        registerCommand: () => {},
        registerShortcut: () => {},
      } as unknown as Parameters<typeof eventsDaemonExtension>[0];
      // 不注入 sender——走真实 createOpClient 路径（票 136 的缺省并入在 client 层不可达）
      eventsDaemonExtension(pi, { opSchema: loadOpSchema(), socketPath: daemon.socketPath, launcher: async () => {} });

      const ctx = {
        cwd: tmpdir(),
        ui: { notify: () => {}, setStatus: () => {} },
        sessionManager: { getSessionId: () => "s1" },
      };
      handlers.session_start[0]({ reason: "new" }, ctx);
      const subscribe = tools.find((t) => t.name === "subscribe");
      expect(subscribe).toBeDefined();
      await subscribe!.execute("t1", { entityRef: "fixture:external/x", opts: { once: true } });
      expect(daemon.subscribeFrames[0]?.opts?.sessionId).toBe("s1");
    } finally {
      await daemon.close();
    }
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
        registerCommand: () => {},
        registerShortcut: () => {},
      } as unknown as Parameters<typeof eventsDaemonExtension>[0];
      const ctx = {
        cwd: tmpdir(), // 无 .pi/events.json → 声明链空转
        ui: { notify: () => {}, setStatus: () => {} }, // 票 45：dock hint 刷新沿（wake 建连）需要 setStatus 面
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
