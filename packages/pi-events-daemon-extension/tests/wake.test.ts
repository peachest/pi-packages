/**
 * Ticket 36 — wake 长连接：推送注入 + 断线退避重连（2s→5min）+ snapshot 冲刷去重 + fork no-inherit + HarnessFault 降级。
 * C 层真 socket（harness daemon = serve+MemoryStore+startLoops 组合替身）+ B 层退避序列。
 * 正典：#31 L146 wake 通道 / G 档尽力投递 + notificationId 去重 / fork no-inherit（SESSION_START 注册时决定）。
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { entityRefKeyOf } from "pi-events-daemon/domain.ts";
import { WAKE_BACKOFF_BASE_MS, WAKE_BACKOFF_MAX_MS, startWake, wakeBackoffMs, type WakeInjection } from "../index.ts";
import { connectWakeClient, startTestDaemon, waitFor, type TestDaemon } from "./harness.ts";

const REF = { type: "fixture:widget", key: "external/w-1" };
const WIRE = entityRefKeyOf(REF);
const at = () => new Date().toISOString();

/** 直接种订阅行（loops.test.ts 先例：绕开 subscribe op/RunnerSlot，投递面测试只关心 fanOut 编址输入）。 */
const seedAutoSub = (daemon: TestDaemon): void => {
  daemon.store.putEntity({ type: REF.type, key: REF.key, state: null });
  daemon.store.putSubscription({
    subscriptionId: "sub-wake",
    sessionId: "s1",
    entityRefType: REF.type,
    entityRefKey: REF.key,
    template: "adhoc",
    check: "fixture-check",
    origin: "auto",
    createdAt: 0,
  });
};

const recorder = () => {
  const injections: WakeInjection[] = [];
  const notifications: Array<{ message: string; type?: string }> = [];
  const delays: number[] = [];
  return {
    injections,
    notifications,
    delays,
    inject: (m: WakeInjection) => injections.push(m),
    notify: (message: string, type?: "info" | "warning" | "error") => notifications.push({ message, type }),
    sleep: async (ms: number) => {
      delays.push(ms); // 记录退避节拍，立即返回（确定性，不真等 2s）
    },
  };
};

describe("票 36：wake 到达 session 内提示（注入路径，真 socket）", () => {
  it("transition failed 绕行 → daemon 推送行 → inject（followUp）含实体与 verdict；异 session envelope 不注入", async () => {
    const daemon: TestDaemon = startTestDaemon();
    try {
      const r = recorder();
      const wake = startWake({ sessionId: "s1", socketPath: daemon.socketPath, inject: r.inject, notify: r.notify, sleep: r.sleep });
      await waitFor(() => wake.isConnected(), "wake connected");
      expect(daemon.sessionStarted).toContain("s1"); // 长连接建立 = SESSION_START 信号
      seedAutoSub(daemon); // sessionStarted 断言即屏障：harness onSessionStart 同步栈内已入队 SESSION_START，L0 FIFO 保证其后提交必见注册

      daemon.loops.submit({ kind: "transition", ref: REF, verdict: "failed", occurredAt: at() });
      await waitFor(() => r.injections.length === 1, "wake injection");

      const m = r.injections[0];
      expect(m.customType).toBe("pi-events-daemon.wake");
      expect(m.display).toBe(true);
      expect(m.content).toContain(WIRE);
      expect(m.content).toContain("failed");
      expect(m.content).toContain("wake");
      expect(m.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
      expect(r.notifications).toEqual([]); // 通道健康：无降级通知

      // 编址过滤（评审 H4：envelope 携带目标 sessionId，接收端过滤）
      daemon.handle.broadcastWake("wake", { sessionId: "other", count: 1, entries: [{ notificationId: "n-x", entityRef: WIRE, verdict: "passed" }] });
      await new Promise((res) => setTimeout(res, 60));
      expect(r.injections).toHaveLength(1);
      await wake.stop();
    } finally {
      await daemon.close();
    }
  });
});

describe("票 36：断线重连 → snapshot 冲刷不丢不重（去重断言）", () => {
  it("批窗内断连（行仍 pending）→ daemon 重启（同 store）→ 重连 SESSION_START snapshot 直推 → 恰一次注入；同 notificationId 重推不重复", async () => {
    const daemon1: TestDaemon = startTestDaemon();
    const store = daemon1.store;
    const path = daemon1.socketPath;
    const r = recorder();
    const wake = startWake({ sessionId: "s1", socketPath: path, inject: r.inject, notify: r.notify, sleep: r.sleep });
    try {
      await waitFor(() => wake.isConnected(), "first connect");
      expect(daemon1.sessionStarted).toContain("s1");
      seedAutoSub(daemon1); // 同上：sessionStarted 屏障先于本提交

      // 批窗事件（passed 非 failed：走 2s 窗口，不立即冲刷）
      daemon1.loops.submit({ kind: "transition", ref: REF, verdict: "passed", occurredAt: at() });
      await waitFor(() => store.pendingDeliveries({}).length === 1, "pending row in batch window");

      // 断连（daemon 死亡）→ 行留 pending（未及 flush）
      await daemon1.close();
      await waitFor(() => !wake.isConnected(), "disconnected");

      // daemon 重启（同 store 同 socket 路径；epoch 旁车重写）
      const daemon2: TestDaemon = startTestDaemon({ store, socketPath: path });
      try {
        await waitFor(() => wake.isConnected(), "reconnected"); // 退避 2s（sleep 注入即时返回）
        expect(r.delays).toContain(WAKE_BACKOFF_BASE_MS); // 首次重连退避 2s

        // 重连 SESSION_START → daemon snapshot（pending 行）→ 冲刷直推 → 不丢
        await waitFor(() => r.injections.length === 1, "snapshot flush injection");
        expect(r.injections[0].content).toContain(WIRE);

        // 不重：同 notificationId 重推（G 档 at-least-once 兜底面）→ 去重
        const dup = { sessionId: "s1", count: 1, entries: [{ notificationId: "dup-n1", entityRef: WIRE, verdict: "passed" }] };
        daemon2.handle.broadcastWake("wake", dup);
        daemon2.handle.broadcastWake("wake", dup);
        await new Promise((res) => setTimeout(res, 80));
        expect(r.injections).toHaveLength(2); // 1（snapshot）+ 1（dup 首次）——重复条目被吞

        // 去重簿记可观测
        expect(wake.seenCount()).toBeGreaterThanOrEqual(2);
      } finally {
        await daemon2.close();
      }
      await wake.stop();
    } finally {
      await wake.stop();
    }
  });
});

describe("票 36：fork no-inherit（子会话零推送）", () => {
  it("fork wake 不建立长连接（transport SESSION_START 注册时决定）→ daemon 广播零到达", async () => {
    const daemon: TestDaemon = startTestDaemon();
    try {
      const r = recorder();
      const wake = startWake({ sessionId: "child", fork: true, socketPath: daemon.socketPath, inject: r.inject, notify: r.notify, sleep: r.sleep });
      await new Promise((res) => setTimeout(res, 60));
      expect(wake.attempts()).toBe(0); // 未发起任何连接
      expect(daemon.sessionStarted).toEqual([]); // 无注册 → daemon 不推

      daemon.handle.broadcastWake("wake", { sessionId: "child", count: 1, entries: [{ notificationId: "n-f", entityRef: WIRE, verdict: "failed" }] });
      await new Promise((res) => setTimeout(res, 60));
      expect(r.injections).toEqual([]); // 子会话零推送
      await wake.stop();
    } finally {
      await daemon.close();
    }
  });
});

describe("票 36：通道失败 → HarnessFault 降级（尽力通知）+ 退避 2s→5min", () => {
  it("socket 不可达：降级通知一次 + 后台退避重试持续（B 层序列 2s..5min 封顶）", async () => {
    const r = recorder();
    const missing = join(tmpdir(), `pi-ext-t36-${Date.now()}-missing.sock`);
    const wake = startWake({ sessionId: "s1", socketPath: missing, inject: r.inject, notify: r.notify, sleep: r.sleep });
    await waitFor(() => r.notifications.length >= 1, "degrade notify");
    expect(r.notifications[0].type).toBe("warning");
    expect(r.notifications[0].message).toContain("降级");
    await waitFor(() => wake.attempts() >= 3, "background retries continue");

    // B 层：退避序列（自定裁量，借用 #31 L2 投递退避数字）
    expect(wakeBackoffMs(0)).toBe(WAKE_BACKOFF_BASE_MS);
    expect(wakeBackoffMs(1)).toBe(4000);
    expect(wakeBackoffMs(7)).toBe(256000);
    expect(wakeBackoffMs(8)).toBe(WAKE_BACKOFF_MAX_MS);
    expect(wakeBackoffMs(20)).toBe(WAKE_BACKOFF_MAX_MS); // 封顶 5min 不再翻倍
    await wake.stop();
    const after = wake.attempts();
    await new Promise((res) => setTimeout(res, 30));
    expect(wake.attempts()).toBe(after); // stop 后不再重试
  });
});
