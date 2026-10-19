/**
 * Ticket 46 — footer daemon 存活状态位：三态文本快照 + 零副作用探测 + 沿刷新矩阵
 * （session_start 探测 / op 副作用 / wake 断连沿，#111 简化口径）。
 */
import { writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import eventsDaemonExtension, {
  createFooterStatus,
  DAEMON_STATUS_KEY,
  probeDaemonStatus,
  renderDaemonStatus,
  startWake,
} from "../index.ts";
import { startTestDaemon, waitFor, type TestDaemon } from "./harness.ts";

const cleanup: string[] = [];
afterEach(() => {
  while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

describe("票 46：三态文本快照（herdr indicators 视觉语法）", () => {
  it("● running / ○ idle / ✗ down，key = pi-events", () => {
    expect(DAEMON_STATUS_KEY).toBe("pi-events");
    expect(renderDaemonStatus("running")).toBe("● pi-events running");
    expect(renderDaemonStatus("idle")).toBe("○ pi-events idle");
    expect(renderDaemonStatus("down")).toBe("✗ pi-events down");
  });
});

describe("票 46：零副作用探测矩阵", () => {
  it("socket 不存在 → idle；真 daemon → running；socket 文件在但连接失败 → down", async () => {
    const missing = join(tmpdir(), `pi-t46-missing-${Date.now()}.sock`);
    expect(await probeDaemonStatus(missing)).toBe("idle");

    const daemon = startTestDaemon();
    try {
      expect(await probeDaemonStatus(daemon.socketPath)).toBe("running");
    } finally {
      await daemon.close();
    }

    const dead = join(tmpdir(), `pi-t46-dead-${Date.now()}.sock`);
    writeFileSync(dead, ""); // 非socket普通文件：连接必败
    cleanup.push(dead);
    expect(await probeDaemonStatus(dead)).toBe("down");
  });
});

describe("票 46：footer 控制器（沿驱动：同态不重绘 / 无 UI 跳过）", () => {
  it("同态 set 不重复 setStatus；无 hasUI 不写", () => {
    const writes: string[] = [];
    const footer = createFooterStatus();
    footer.bind({ hasUI: true, ui: { setStatus: (_k, v) => writes.push(v!) } });
    footer.set("running");
    footer.set("running"); // 同态跳过
    footer.set("idle");
    expect(writes).toEqual(["● pi-events running", "○ pi-events idle"]);

    const silent = createFooterStatus();
    silent.bind({ hasUI: false, ui: { setStatus: () => writes.push("should-not-write") } });
    silent.set("down");
    expect(writes).toHaveLength(2);

    silent.bind(null);
    silent.set("running");
    expect(writes).toHaveLength(2);
  });
});

describe("票 46：extension 接线——沿刷新矩阵", () => {
  function makePi() {
    const statuses: Array<{ key: string; text?: string }> = [];
    const handlers: Record<string, Array<(event: unknown, ctx: unknown) => void>> = {};
    const registered: Array<{ name: string; execute: (...a: unknown[]) => unknown }> = [];
    const pi = {
      registerTool: (tool: never) => registered.push(tool as never),
      on: (event: string, handler: (event: unknown, ctx: unknown) => void) => {
        (handlers[event] ??= []).push(handler);
      },
      sendMessage: () => {},
    } as unknown as Parameters<typeof eventsDaemonExtension>[0];
    const ctx = {
      cwd: tmpdir(), // 无 .pi/events.json → 声明链空转
      hasUI: true,
      ui: {
        notify: () => {},
        setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }),
      },
      sessionManager: { getSessionId: () => "s1" },
    };
    return { statuses, handlers, registered, pi, ctx };
  }

  it("session_start：socket 缺失 → ○ idle，零副作用（launcher 不被调）", async () => {
    const { statuses, handlers, pi, ctx } = makePi();
    let launched = 0;
    const missing = join(tmpdir(), `pi-t46-wire-${Date.now()}.sock`);
    cleanup.push(missing);
    eventsDaemonExtension(pi, {
      socketPath: missing,
      sender: async () => ({}),
      launcher: async () => {
        launched++;
      },
    });
    handlers.session_start![0]({ reason: "new" }, ctx);
    await waitFor(() => statuses.some((s) => s.key === DAEMON_STATUS_KEY), "footer probe");
    expect(statuses.map((s) => s.text)).toEqual(["○ pi-events idle"]);
    await new Promise((res) => setTimeout(res, 60));
    expect(launched).toBe(0); // 探测不拉起 daemon
  });

  it("op 副作用沿：成功 → running；传输失败 → 按 socket 存在性归类", async () => {
    const { statuses, handlers, registered, pi, ctx } = makePi();
    let fail = false;
    eventsDaemonExtension(pi, {
      socketPath: join(tmpdir(), `pi-t46-op-${Date.now()}.sock`),
      sender: async () => {
        if (fail) throw new Error("ECONNREFUSED");
        return {};
      },
    });
    handlers.session_start![0]({ reason: "new" }, ctx);
    const templates = registered.find((t) => t.name === "templates")!;
    await templates.execute("call-1", {}, undefined, undefined, {});
    await waitFor(() => statuses.some((s) => s.text === "● pi-events running"), "op success → running");

    fail = true;
    await templates.execute("call-2", {}, undefined, undefined, {}); // 错误被包为 ToolResult，不抛
    await waitFor(() => statuses.some((s) => s.text === "○ pi-events idle"), "transport fail + socket missing → idle");
  });

  it("wake 断连沿：daemon 起停一次，footer running → 离开 running", async () => {
    const { statuses, handlers, pi, ctx } = makePi();
    const daemon: TestDaemon = startTestDaemon();
    try {
      eventsDaemonExtension(pi, { socketPath: daemon.socketPath, sender: async () => ({}) });
      handlers.session_start![0]({ reason: "new" }, ctx);
      await waitFor(() => statuses.some((s) => s.text === "● pi-events running"), "probe/wake → running");

      await daemon.close(); // 断连沿
      await waitFor(() => statuses.at(-1)!.text !== "● pi-events running", "leave running on disconnect edge");
      // socket 文件未清理 → down（daemon 挂了）；若实现清理 socket → idle，两态皆合法
      expect(["✗ pi-events down", "○ pi-events idle"]).toContain(statuses.at(-1)!.text);
    } finally {
      void daemon.close();
    }
  });

  it("fork 会话：不探测不建连接，footer 保持未写", async () => {
    const { statuses, handlers, pi, ctx } = makePi();
    eventsDaemonExtension(pi, { socketPath: join(tmpdir(), `pi-t46-fork-${Date.now()}.sock`), sender: async () => ({}) });
    handlers.session_start![0]({ reason: "fork" }, ctx);
    await new Promise((res) => setTimeout(res, 80));
    expect(statuses).toEqual([]);
  });
});

describe("票 46：wake 降级 notify 去重（每次断供只一次）", () => {
  it("多次退避重试期间 notifications 停在 1 条", async () => {
    const notifications: Array<{ message: string; type?: string }> = [];
    const missing = join(tmpdir(), `pi-t46-dedup-${Date.now()}.sock`);
    const sleep = async () => {}; // 退避即时返回 → 多轮快速重试
    const wake = startWake({
      sessionId: "s1",
      socketPath: missing,
      inject: () => {},
      notify: (message, type) => notifications.push({ message, type }),
      sleep,
    });
    await waitFor(() => wake.attempts() >= 5, "multiple retry rounds");
    expect(notifications).toHaveLength(1); // 去重：不再每轮弹
    expect(notifications[0]!.type).toBe("warning");
    expect(notifications[0]!.message).toContain("降级");
    await wake.stop();
    expect(existsSync(missing)).toBe(false);
  });
});
