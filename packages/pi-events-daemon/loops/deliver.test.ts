/**
 * Ticket 43 — loops/deliver.test.ts：L2 Deliver 段测试（自 loops.test.ts 票 27 系整体迁入）。
 * 迁移非改写：票 27 系 14 describe + 票 38 Group Push 2 describe 逐块原样搬运（断言不变，
 * round 6 验证的"各段自带闭合、拼接安全"模式）；共享 fixture 自 loops.test.ts 复制保持自闭合。
 */
import { describe, it, expect } from "vitest";
import { createMemoryStore, type Store } from "../store/index.ts";
import { FakeClock, FakeExec, FakePusher, FakeFs, type Pusher } from "../fx/index.ts";
import { deterministicEventId } from "../domain/intent.ts";
import { startLoops, type LoopsCtx } from "./index.ts";

// --- fixture（数据，非 profile；kernel.test.ts 同法；自 loops.test.ts 复制）---
const REF = { type: "fixture:widget", key: "external/fixture-1" };
const STATES = new Set(["passed", "failed", "waiting"]);
const at = (n: number) => `2026-01-01T00:00:${String(n).padStart(2, "0")}Z`;
const TPL = "fixture-tpl";
const micro = () => new Promise<void>((resolve) => setTimeout(resolve, 0)); // 微任务冲刷（prober.test 同法）

type MemStore = ReturnType<typeof createMemoryStore>;

const makeCtx = (store: Store, overrides: Partial<LoopsCtx> = {}): LoopsCtx => ({
  clock: new FakeClock(),
  exec: new FakeExec(),
  pusher: new FakePusher(),
  fs: new FakeFs(),
  store,
  states: STATES,
  ...overrides,
});

const subVia = (
  loops: ReturnType<typeof startLoops>,
  over: Partial<Parameters<ReturnType<typeof startLoops>["submit"]>[0] & object> = {},
  reqOver: Record<string, unknown> = {},
): void => {
  loops.submit({ kind: "subscribe", req: {
    sessionId: "session-1",
    entityRef: REF,
    template: TPL,
    check: "fixture-check",
    now: 0,
    ...reqOver,
  }, ...over } as Parameters<ReturnType<typeof startLoops>["submit"]>[0]);
};

// ==================== 票 27 — L2 Deliver：唤醒双通道 + 投递铁律 + 退避 dead-letter + batch 合流 + snapshot + 24h re-push ====================

const DELIVER_BATCH_MS = 2000;
const NID = (order: number) => deterministicEventId(REF, order);
type PushLine = { sessionId: string; count: number; entries: { notificationId: string; entityRef: string; verdict: string }[] };
const lineOf = (pusher: FakePusher | ScriptedPusher, at: number): PushLine => JSON.parse(pusher.pushed[at]!) as PushLine;

/** 直接种订阅行（不经 subscribe op：绕开 RunnerSlot/prober，投递面测试只关心 fanOut 编址输入）。 */
const seedSub = (store: MemStore, sessionId = "s1"): void => {
  store.putSubscription({
    subscriptionId: `sub-${sessionId}`,
    sessionId,
    entityRefType: REF.type,
    entityRefKey: REF.key,
    origin: "session",
    scope: "project",
    createdAt: 0,
  });
};

describe("票 27 组 L2-1 — 唤醒双通道：update_hook 毫秒级主路径 + 1s 兜底补投（丢唤醒自愈）", () => {
  it("update_hook 唤醒：transition→outbox→fanOut→pending 入批开窗全程同步（零时钟推进窗口定时器已在）", async () => {
    const store = createMemoryStore();
    store.putEntity({ type: REF.type, key: REF.key, state: null });
    seedSub(store);
    const clock = new FakeClock();
    const pusher = new FakePusher();
    const loops = startLoops(makeCtx(store, { clock, pusher }));
    loops.sessionStart("s1"); // 活跃登记（fanOut 在线分支的 runtime 面）

    loops.submit({ kind: "transition", ref: REF, verdict: "passed", occurredAt: at(1) });
    // 毫秒级主路径证据：零时钟推进内投递面已开窗（fallback 兜底 + 批窗口 + L4 housekeeping = 3 定时器，票 28）
    expect(clock.pendingCount).toBe(3);
    expect(store.pendingDeliveries({ sessionId: "s1" })).toHaveLength(1); // fanOut 已物化 pending 行

    clock.step(1000); // 兜底 tick（行已在批，不重排）
    clock.step(1000); // 窗口 2000ms 到点冲刷——若唤醒丢失则需兜底 1s + 窗口 2s = 3s，此处 2s 即达
    await micro();
    expect(pusher.pushed).toHaveLength(1);
    const line = lineOf(pusher, 0);
    expect(line.count).toBe(1);
    expect(line.entries[0]).toEqual({
      notificationId: NID(1),
      entityRef: "fixture:widget:external/fixture-1",
      verdict: "passed",
    });
    // 投递铁律两段式 ack 段一：推送成功 → pending→accepted（verified 归 I9，L2 永不写）
    expect(store.getDelivery(NID(1), "s1")?.state).toBe("accepted");
  });

  it("update_hook 丢失（循环未运行时落盘的 pending 行）→ 1s 兜底扫补投：1s 入批开窗、3s 冲刷", async () => {
    const store = createMemoryStore();
    store.putEntity({ type: REF.type, key: REF.key, state: null });
    seedSub(store);
    // 循环未运行时落盘（丢唤醒形态）：event/outbox/delivery 全在 store，无任何唤醒到达 loops
    store.appendEventIfMissing({ eventId: NID(1), eventSeq: 1, entityRefType: REF.type, entityRefKey: REF.key, from: "passed", to: "passed", occurredAt: at(1) });
    store.putOutbox({ notificationId: NID(1), eventSeq: 1 });
    store.putDelivery({ notificationId: NID(1), sessionId: "s1", state: "pending", recordEpoch: 0 });

    const clock = new FakeClock();
    const pusher = new FakePusher();
    const loops = startLoops(makeCtx(store, { clock, pusher }));
    // 不 sessionStart：sessionStart 自身是唤醒通道（snapshot 含 pending 行会立即冲刷）——
    // 本测隔离兜底通道：行在 store、无任何唤醒到达，唯一拾取面 = 1s 兜底扫
    expect(pusher.pushed).toHaveLength(0);

    clock.step(999);
    expect(pusher.pushed).toHaveLength(0); // 1s 兜底未到
    clock.step(1); // 兜底扫：outbox 补消费（fanOut I10 幂等）+ pending 入批开窗
    expect(clock.pendingCount).toBe(3); // fallback 兜底 + 新开批窗口 + L4 housekeeping
    clock.step(1999);
    expect(pusher.pushed).toHaveLength(0); // 窗口未到
    clock.step(1);
    await micro();
    expect(pusher.pushed).toHaveLength(1); // 兜底补投完成
    expect(store.getDelivery(NID(1), "s1")?.state).toBe("accepted");
  });
});

describe("票 27 组 L2-2 — E2 退避序列 2s→…→5min×5→dead-letter（投递失败不丢不哑）", () => {
  it("14 次投递全失败：8 级指数等待后 5min 封顶 ×5，第 14 次失败进 dead-letter 终态且不再自动重试", async () => {
    const store = createMemoryStore();
    store.putEntity({ type: REF.type, key: REF.key, state: null });
    seedSub(store);
    const clock = new FakeClock();
    const pusher = new FakePusher();
    for (let i = 0; i < 14; i++) pusher.failures.push(new Error(`down-${i}`));
    const loops = startLoops(makeCtx(store, { clock, pusher }));
    loops.sessionStart("s1");
    loops.submit({ kind: "transition", ref: REF, verdict: "failed", occurredAt: at(1) }); // failed 绕行：首推立即
    await micro(); // push#1 拒绝结算 → 退避 2s
    expect(pusher.failures).toHaveLength(13);
    expect(store.getDelivery(NID(1), "s1")?.state).toBe("pending"); // 失败不迁状态，留在重试态

    const waits = [2, 4, 8, 16, 32, 64, 128, 256, 300, 300, 300, 300, 300]; // 秒；300 = 5min 封顶 ×5
    let pushes = 1;
    for (const w of waits) {
      clock.step(w * 1000 - 1);
      expect(pusher.failures).toHaveLength(14 - pushes); // 未到点：无新推
      clock.step(1);
      await micro();
      pushes += 1;
      expect(pusher.failures).toHaveLength(14 - pushes);
    }
    expect(pusher.failures).toHaveLength(0); // 14 次推送全部失败
    expect(store.getDelivery(NID(1), "s1")?.state).toBe("dead-letter"); // 退避耗尽 → dead-letter（正典边 retry-exhausted）
    clock.step(10 * 60_000);
    await micro();
    expect(store.getDelivery(NID(1), "s1")?.state).toBe("dead-letter"); // D2a 终态：不再自动重试
    expect(loops.errors).toHaveLength(0); // 投递失败是预期路径，不进 errors
  });
});

describe("票 27 组 L2-3 — batch 合流 I2：per-session 窗口合流 billboard=count+实体+verdict；failed 绕行携带同窗 pending", () => {
  it("failed 绕行不等窗口立即冲刷，并携带同窗 pending 条目合为一条（eventSeq 序）", async () => {
    const store = createMemoryStore();
    store.putEntity({ type: REF.type, key: REF.key, state: null });
    seedSub(store);
    const clock = new FakeClock();
    const pusher = new FakePusher();
    const loops = startLoops(makeCtx(store, { clock, pusher }));
    loops.sessionStart("s1");

    loops.submit({ kind: "transition", ref: REF, verdict: "passed", occurredAt: at(1) }); // 窗口开（t=0，2000ms 到点）
    clock.step(500); // 未到兜底 tick、未到窗口
    loops.submit({ kind: "transition", ref: REF, verdict: "failed", occurredAt: at(2) }); // failed 绕行：立即冲刷（t=500 < 2000）
    await micro();
    expect(pusher.pushed).toHaveLength(1); // 合流为一条，窗口定时器被吞
    const line = lineOf(pusher, 0);
    expect(line.count).toBe(2); // billboard 条目形态：count + 实体 + verdict
    expect(line.entries.map((e) => e.verdict)).toEqual(["passed", "failed"]); // eventSeq 序
    expect(line.entries.map((e) => e.notificationId)).toEqual([NID(1), NID(2)]);
    expect(store.getDelivery(NID(1), "s1")?.state).toBe("accepted");
    expect(store.getDelivery(NID(2), "s1")?.state).toBe("accepted");

    clock.step(60_000);
    await micro();
    expect(pusher.pushed).toHaveLength(1); // 无重复推送（窗口取消 + accepted 不再入批）
  });

  it("同窗多事件（无 failed）按 batchMs 合流一条：窗口内不推、到点一次推齐", async () => {
    const store = createMemoryStore();
    store.putEntity({ type: REF.type, key: REF.key, state: null });
    seedSub(store);
    const clock = new FakeClock();
    const pusher = new FakePusher();
    const loops = startLoops(makeCtx(store, { clock, pusher }));
    loops.sessionStart("s1");

    loops.submit({ kind: "transition", ref: REF, verdict: "passed", occurredAt: at(1) });
    clock.step(1000); // 兜底 tick（不冲刷）
    loops.submit({ kind: "transition", ref: REF, verdict: "waiting", occurredAt: at(2) }); // 同窗第二事件
    expect(pusher.pushed).toHaveLength(0); // 窗口内：held

    clock.step(1000); // 窗口 2000ms 到点
    await micro();
    expect(pusher.pushed).toHaveLength(1);
    const line = lineOf(pusher, 0);
    expect(line.count).toBe(2);
    expect(line.entries.map((e) => e.verdict)).toEqual(["passed", "waiting"]);
    expect(store.getDelivery(NID(1), "s1")?.state).toBe("accepted");
    expect(store.getDelivery(NID(2), "s1")?.state).toBe("accepted");
  });
});

describe("票 27 组 L2-4 — SESSION_START→drain（只投 parked D2a）+ wake snapshot 冲刷；24h verified-absence re-push 独立通道", () => {
  it("离线期 parked 行：SESSION_START drain 重投 + snapshot 立即冲刷（不等窗口）；dead-letter 零进入（D2a）", async () => {
    const store = createMemoryStore();
    store.putEntity({ type: REF.type, key: REF.key, state: null });
    seedSub(store);
    const clock = new FakeClock();
    const pusher = new FakePusher();
    const loops = startLoops(makeCtx(store, { clock, pusher }));
    // 无活跃 session：fanOut 会话已关分支 → parked（不重试不超时，只等 drain）
    loops.submit({ kind: "transition", ref: REF, verdict: "failed", occurredAt: at(1) });
    await micro();
    expect(pusher.pushed).toHaveLength(0); // 离线不推（离线不发）
    expect(store.getDelivery(NID(1), "s1")?.state).toBe("parked");
    store.putDelivery({ notificationId: "evt:fixture:widget:external/fixture-1#0", sessionId: "s1", state: "dead-letter", recordEpoch: 0 }); // D2a 反例行

    loops.sessionStart("s1"); // drain（parked→accepted）+ snapshot 组装一次性推送冲刷
    await micro();
    expect(pusher.pushed).toHaveLength(1); // 立即冲刷：不等 batchMs 窗口
    const line = lineOf(pusher, 0);
    expect(line.count).toBe(1); // dead-letter 不入 snapshot
    expect(line.entries[0]!.notificationId).toBe(NID(1));
    expect(store.getDelivery(NID(1), "s1")?.state).toBe("accepted"); // drain-redeliver 两段式段一
    expect(store.getDelivery("evt:fixture:widget:external/fixture-1#0", "s1")?.state).toBe("dead-letter"); // D2a：dead-letter 不经 drain
  });

  it("24h verified-absence：accepted 行迟到满 24h 恰一次 re-push（不经 drain：无状态迁移无新行）；此后 verified/repushed 恒 hold", async () => {
    const store = createMemoryStore();
    store.putEntity({ type: REF.type, key: REF.key, state: null });
    seedSub(store);
    const clock = new FakeClock();
    const pusher = new FakePusher();
    const loops = startLoops(makeCtx(store, { clock, pusher }));
    loops.sessionStart("s1");
    loops.submit({ kind: "transition", ref: REF, verdict: "passed", occurredAt: at(1) });
    clock.step(2000); // 窗口冲刷 → accepted，pushedAt=2000
    await micro();
    expect(pusher.pushed).toHaveLength(1);

    clock.step(24 * 3600_000 - 1); // 满 24h 前 1ms：hold
    expect(pusher.pushed).toHaveLength(1);
    clock.step(1); // 恰满 24h：兜底扫触发独立通道
    await micro();
    expect(pusher.pushed).toHaveLength(2); // 恰一次 re-push
    expect(lineOf(pusher, 1).entries[0]!.notificationId).toBe(NID(1));
    expect(store.getDelivery(NID(1), "s1")?.state).toBe("accepted"); // 不经 drain：状态不迁移
    expect(store.pendingDeliveries({})).toHaveLength(0); // 不产生新投递行（I10 复用唯一行）

    store.putDelivery({ notificationId: NID(1), sessionId: "s1", state: "verified", recordEpoch: 0 }); // 此后 verified 终态
    clock.step(48 * 3600_000);
    await micro();
    expect(pusher.pushed).toHaveLength(2); // verified 恒 hold；repushed 置位亦恒 hold
    loops.stop();
  });
});

// =============================================================================
// 票 27 ocr 评审修复 — L2 异步边界缺陷群（8H3M1L，逐 finding 回归）
// =============================================================================

/** 可脚本化推送器：hold（手动放行）/reject 注入 + 在飞并发计数（M3 单飞守卫断言面）；未排脚本立即送达 1。
 *  Pusher 契约（票 38 评审）：resolve = 送达数；hold 放行/默认路径送达 1，reject 路径保持抛错。 */
class ScriptedPusher implements Pusher {
  readonly pushed: string[] = [];
  active = 0;
  maxConcurrent = 0;
  private script: (() => Promise<number>)[] = [];

  push(line: string): Promise<number> {
    this.pushed.push(line);
    this.active += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.active);
    const next = this.script.shift();
    const settle = () => {
      this.active -= 1;
    };
    if (!next) return Promise.resolve(1).then((n) => (settle(), n));
    return next().then(
      (n) => (settle(), n),
      (err: unknown) => {
        settle();
        throw err;
      },
    );
  }

  enqueueHold(): { resolve(): void; reject(err: unknown): void } {
    let r!: () => void;
    let j!: (e: unknown) => void;
    this.script.push(
      () =>
        new Promise<number>((res, rej) => {
          r = () => res(1);
          j = rej;
        }),
    );
    return { resolve: () => r(), reject: (e: unknown) => j(e) };
  }

  enqueueReject(err: Error): void {
    this.script.push(() => Promise.reject(err));
  }
}

describe("票 27 评审修复 — H1/H2：I12 epoch fence 过异步结算与 24h 通道", () => {
  it("H1：在飞 push 期间行换代 → 结算不 ack 替换行（保持 pending，行与簿记都不动）", async () => {
    const store = createMemoryStore();
    store.putEntity({ type: REF.type, key: REF.key, state: null });
    seedSub(store);
    const clock = new FakeClock();
    const pusher = new ScriptedPusher();
    const hold = pusher.enqueueHold();
    const loops = startLoops(makeCtx(store, { clock, pusher }));
    loops.sessionStart("s1");
    loops.submit({ kind: "transition", ref: REF, verdict: "passed", occurredAt: at(1) });

    clock.step(2000); // 窗口冲刷：push 在飞（held）
    store.putDelivery({ notificationId: NID(1), sessionId: "s1", state: "pending", recordEpoch: 1 }); // 在飞期间换代
    hold.resolve();
    await micro();
    // 替换行保持 pending：本 owner 从未推过它（recordEpoch=1 ≠ ownerEpoch=0）
    expect(store.getDelivery(NID(1), "s1")).toEqual({
      notificationId: NID(1),
      sessionId: "s1",
      state: "pending",
      recordEpoch: 1,
    });
    expect(loops.errors).toHaveLength(0);
    loops.stop();
  });

  it("H2：已推行换代 → 24h 扫描不 re-push 且簿记清出", async () => {
    const store = createMemoryStore();
    store.putEntity({ type: REF.type, key: REF.key, state: null });
    seedSub(store);
    const clock = new FakeClock();
    const pusher = new FakePusher();
    const loops = startLoops(makeCtx(store, { clock, pusher }));
    loops.sessionStart("s1");
    loops.submit({ kind: "transition", ref: REF, verdict: "passed", occurredAt: at(1) });
    clock.step(2000);
    await micro();
    expect(pusher.pushed).toHaveLength(1);
    store.putDelivery({ notificationId: NID(1), sessionId: "s1", state: "accepted", recordEpoch: 1 }); // 换代
    clock.step(24 * 3600_000 + 60_000);
    await micro();
    expect(pusher.pushed).toHaveLength(1); // 旧世代 owner 不 re-push 他人行
    loops.stop();
  });
});

describe("票 27 评审修复 — H3：重启种子（24h 恢复通道跨重启存活）", () => {
  it("既有 accepted 行窗口自重启重新计时；重启后满 24h 恢复推（不经 drain 状态不迁移）", async () => {
    const store = createMemoryStore();
    store.putEntity({ type: REF.type, key: REF.key, state: null });
    seedSub(store);
    const clock = new FakeClock();
    const pusher1 = new FakePusher();
    const life1 = startLoops(makeCtx(store, { clock, pusher: pusher1 }));
    life1.sessionStart("s1");
    life1.submit({ kind: "transition", ref: REF, verdict: "passed", occurredAt: at(1) });
    clock.step(2000);
    await micro();
    expect(pusher1.pushed).toHaveLength(1);
    life1.stop();

    clock.step(23 * 3600_000); // 重启前再走 23h（自原推累计已 24h+）
    const pusher2 = new FakePusher();
    const life2 = startLoops(makeCtx(store, { clock, pusher: pusher2 })); // 种子：pushedAt=重启点
    clock.step(3600_000); // 重启后 1h：自原推已满 24h，但窗口重新计时 → hold
    await micro();
    expect(pusher2.pushed).toHaveLength(0);
    clock.step(23 * 3600_000); // 重启后满 24h → 恢复推
    await micro();
    expect(pusher2.pushed).toHaveLength(1);
    expect(lineOf(pusher2, 0).entries[0]!.notificationId).toBe(NID(1));
    expect(store.getDelivery(NID(1), "s1")?.state).toBe("accepted"); // 不经 drain：状态不迁移
    life2.stop();
  });
});

describe("票 27 评审修复 — H4：wire envelope 携带目标 sessionId", () => {
  it("两 session 各收各的批次（编址不丢、不跨 session 合流）", async () => {
    const store = createMemoryStore();
    store.putEntity({ type: REF.type, key: REF.key, state: null });
    seedSub(store, "s1");
    seedSub(store, "s2");
    const clock = new FakeClock();
    const pusher = new FakePusher();
    const loops = startLoops(makeCtx(store, { clock, pusher }));
    loops.sessionStart("s1");
    loops.sessionStart("s2");
    loops.submit({ kind: "transition", ref: REF, verdict: "passed", occurredAt: at(1) }); // fanOut → s1/s2 各一行 pending
    clock.step(2000);
    await micro();
    expect(pusher.pushed).toHaveLength(2); // 每 session 一条
    const l1 = lineOf(pusher, 0);
    const l2 = lineOf(pusher, 1);
    expect([l1.sessionId, l2.sessionId]).toEqual(["s1", "s2"]);
    expect(l1.count).toBe(1);
    expect(l1.entries[0]!.notificationId).toBe(NID(1));
    expect(l2.count).toBe(1);
    expect(l2.entries[0]!.notificationId).toBe(NID(1));
    loops.stop();
  });
});

describe("票 27 评审修复 — H5：耗尽只结算失败尝试快照", () => {
  it("末次重试在飞期间新入批行不被连带 dead-letter，重开窗获得自己的投递机会", async () => {
    const store = createMemoryStore();
    store.putEntity({ type: REF.type, key: REF.key, state: null });
    seedSub(store);
    const clock = new FakeClock();
    const pusher = new ScriptedPusher();
    for (let i = 0; i < 13; i++) pusher.enqueueReject(new Error(`down-${i}`)); // 尝试 1-13 失败
    const hold = pusher.enqueueHold(); // 尝试 14（末次重试）在飞挂起
    const loops = startLoops(makeCtx(store, { clock, pusher }));
    loops.sessionStart("s1");
    loops.submit({ kind: "transition", ref: REF, verdict: "failed", occurredAt: at(1) }); // failed 绕行首推
    await micro();
    expect(store.getDelivery(NID(1), "s1")?.state).toBe("pending");

    for (const w of [2, 4, 8, 16, 32, 64, 128, 256, 300, 300, 300, 300, 300]) {
      clock.step(w * 1000);
      await micro();
    }
    expect(store.getDelivery(NID(1), "s1")?.state).toBe("pending"); // 末次重试在飞

    loops.submit({ kind: "transition", ref: REF, verdict: "waiting", occurredAt: at(2) }); // 新行在飞期入批
    hold.reject(new Error("final down"));
    await micro();
    expect(store.getDelivery(NID(1), "s1")?.state).toBe("dead-letter"); // 耗尽只结算尝试快照（行 1）
    expect(store.getDelivery(NID(2), "s1")?.state).toBe("pending"); // 未参与失败推送：不连带

    clock.step(2000); // 幸存行重开窗自投
    await micro();
    expect(store.getDelivery(NID(2), "s1")?.state).toBe("accepted");
    loops.stop();
  });
});

describe("票 27 评审修复 — H6：outbox 成功才消费", () => {
  it("fanOut 三次事务尝试耗尽 → errors 可见；Store 恢复后兜底 tick 重试创建投递（无重启）", async () => {
    const base = createMemoryStore();
    base.putEntity({ type: REF.type, key: REF.key, state: null });
    seedSub(base);
    base.appendEventIfMissing({ eventId: NID(1), eventSeq: 1, entityRefType: REF.type, entityRefKey: REF.key, from: "passed", to: "passed", occurredAt: at(1) });
    base.putOutbox({ notificationId: NID(1), eventSeq: 1 }); // 投递行不存在：fanOut 尚未成功
    let failTx = 0;
    const store: Store = Object.create(base);
    store.tx = (fn) => {
      if (failTx > 0) {
        failTx -= 1;
        throw new Error("store down");
      }
      return base.tx(fn);
    };
    const clock = new FakeClock();
    const pusher = new FakePusher();
    const loops = startLoops(makeCtx(store, { clock, pusher }));
    loops.sessionStart("s1"); // 活跃登记：fanOut 重试成功后在线直投（pending 而非 parked）

    failTx = 6; // 覆盖 fanOut 3 次尝试 + startLoops 后续 tx 消耗（重试全失败语义不变）
    clock.step(1000);
    await micro();
    expect(loops.errors.length).toBeGreaterThanOrEqual(1); // fanOut 耗尽 + sessionStart drain 等后续 tick 各自记录（语义等价）
    expect(String(loops.errors[0])).toContain("store down");
    expect(store.getDelivery(NID(1), "s1")).toBeUndefined(); // 未消费：投递行未创建

    failTx = 0; // Store 恢复
    clock.step(1000); // 兜底 tick 重试
    await micro();
    expect(store.getDelivery(NID(1), "s1")?.state).toBe("pending"); // 投递行终创建（无重启）
    clock.step(2000);
    await micro();
    expect(store.getDelivery(NID(1), "s1")?.state).toBe("accepted");
    loops.stop();
  });
});

describe("票 27 评审修复 — H7/L12：pre-cancel fanOut 活跃投影统一", () => {
  it("H7：once 订阅达标即推终端事件（活跃 session 直投），不等重连 drain", async () => {
    const store = createMemoryStore();
    store.putEntity({ type: REF.type, key: REF.key, state: null });
    const clock = new FakeClock();
    const exec = new FakeExec();
    exec.enqueue({ exitCode: 0 });
    const pusher = new FakePusher();
    const loops = startLoops(makeCtx(store, { clock, exec, pusher }));
    subVia(loops, {}, { opts: { once: true, schedule: { type: "interval", intervalMs: 60_000 } } });
    loops.sessionStart("session-1"); // 活跃登记先于达标翻转沿

    clock.step(0); // 首探 passed：transition + pre-cancel fanOut（活跃投影）+ cancel
    await micro();
    expect(store.getDelivery(NID(1), "session-1")?.state).toBe("pending"); // 在线直投（非 parked）
    clock.step(2000);
    await micro();
    expect(pusher.pushed).toHaveLength(1); // 终端事件已推，无需重连
    expect(lineOf(pusher, 0).entries[0]).toEqual({
      notificationId: NID(1),
      entityRef: "fixture:widget:external/fixture-1",
      verdict: "passed",
    });
    expect(store.querySubscriptions({ sessionId: "session-1" })[0]?.closedReason).toBe("once-passed");
    loops.stop();
  });
});

describe("票 27 评审修复 — H8：结算异常 containment", () => {
  it("推送成功后 putDelivery 失败 → 记 errors 批转退避（不自困 inflight、无未处理 rejection）；恢复后 session 复活", async () => {
    const base = createMemoryStore();
    base.putEntity({ type: REF.type, key: REF.key, state: null });
    seedSub(base);
    let failPut = 0;
    const store: Store = Object.create(base);
    store.putDelivery = (row) => {
      if (failPut > 0) {
        failPut -= 1;
        throw new Error("put down");
      }
      base.putDelivery(row);
    };
    const clock = new FakeClock();
    const pusher = new FakePusher();
    const loops = startLoops(makeCtx(store, { clock, pusher }));
    loops.sessionStart("s1");
    loops.submit({ kind: "transition", ref: REF, verdict: "passed", occurredAt: at(1) });
    failPut = 1; // 首次结算 putDelivery 失败
    clock.step(2000);
    await micro();
    expect(store.getDelivery(NID(1), "s1")?.state).toBe("pending"); // ack 未落
    expect(loops.errors).toHaveLength(1); // containment：errors 可见
    clock.step(2000); // 退避 2s 重试（failPut 已耗尽 = Store 恢复）
    await micro();
    expect(store.getDelivery(NID(1), "s1")?.state).toBe("accepted"); // session 复活，非困死 inflight
    loops.stop();
  });
});

describe("票 27 评审修复 — M1：failed 绕行在飞期到达", () => {
  it("结算即冲刷余量 failed 行，不再吃整窗 2000ms（零时钟推进证据）", async () => {
    const store = createMemoryStore();
    store.putEntity({ type: REF.type, key: REF.key, state: null });
    seedSub(store);
    const clock = new FakeClock();
    const pusher = new ScriptedPusher();
    const hold = pusher.enqueueHold();
    const loops = startLoops(makeCtx(store, { clock, pusher }));
    loops.sessionStart("s1");
    loops.submit({ kind: "transition", ref: REF, verdict: "passed", occurredAt: at(1) });
    clock.step(2000); // 窗口冲刷：push#1 在飞挂起
    loops.submit({ kind: "transition", ref: REF, verdict: "failed", occurredAt: at(2) }); // failed 事件在飞期到达
    hold.resolve();
    await micro(); // 结算 → 余量含 failed → 立即冲刷 push#2（零时钟推进）
    expect(pusher.pushed).toHaveLength(2);
    expect(lineOf(pusher, 1).entries[0]).toEqual({
      notificationId: NID(2),
      entityRef: "fixture:widget:external/fixture-1",
      verdict: "failed",
    });
    expect(store.getDelivery(NID(2), "s1")?.state).toBe("accepted");
    loops.stop();
  });
});

describe("票 27 评审修复 — M2：兜底扫异常自愈", () => {
  it("单次 outboxUnconsumed 读异常（票 123 游标化后同语义）→ 记 errors 后照常重排；24h 扫描通道同 tick 照跑、后续 tick 无重复异常", async () => {
    const base = createMemoryStore();
    base.putEntity({ type: REF.type, key: REF.key, state: null });
    seedSub(base);
    let failOutbox = 0;
    const store: Store = Object.create(base);
    store.outboxUnconsumed = (afterSeq) => {
      if (failOutbox > 0) {
        failOutbox -= 1;
        throw new Error("read down");
      }
      return base.outboxUnconsumed(afterSeq);
    };
    const clock = new FakeClock();
    const pusher = new FakePusher();
    const loops = startLoops(makeCtx(store, { clock, pusher }));
    loops.sessionStart("s1");
    loops.submit({ kind: "transition", ref: REF, verdict: "passed", occurredAt: at(1) });
    clock.step(2000);
    await micro();
    expect(pusher.pushed).toHaveLength(1); // accepted，pushedAt=2000

    failOutbox = 1;
    clock.step(1000); // 下一兜底 tick：deliverScan 抛（contained）→ repushScan 同 tick 照跑（hold）→ 重排
    await micro();
    expect(loops.errors).toHaveLength(1);
    expect(String(loops.errors[0])).toContain("read down");
    failOutbox = 0;
    clock.step(24 * 3600_000); // 24h 扫描通道未被禁用：恢复推照常发生
    await micro();
    expect(pusher.pushed).toHaveLength(2);
    expect(lineOf(pusher, 1).entries[0]!.notificationId).toBe(NID(1));
    expect(loops.errors).toHaveLength(1); // 后续 tick 无重复异常（重排存活）
    loops.stop();
  });
});

describe("票 27 评审修复 — M3：24h re-push 与常规批共享 per-session 单飞守卫", () => {
  it("批在飞时 re-push 让路（不产生第二未结算 push）；守卫释放后下一兜底 tick 恰一次补推", async () => {
    const store = createMemoryStore();
    store.putEntity({ type: REF.type, key: REF.key, state: null });
    seedSub(store);
    const clock = new FakeClock();
    const pusher = new ScriptedPusher();
    const loops = startLoops(makeCtx(store, { clock, pusher }));
    loops.sessionStart("s1");
    loops.submit({ kind: "transition", ref: REF, verdict: "passed", occurredAt: at(1) });
    clock.step(2000); // push#1 成功 → accepted（pushedAt=2000）
    await micro();
    expect(store.getDelivery(NID(1), "s1")?.state).toBe("accepted");

    const hold = pusher.enqueueHold(); // push#2（常规批）挂起
    loops.submit({ kind: "transition", ref: REF, verdict: "waiting", occurredAt: at(2) });
    clock.step(2000); // 窗口冲刷：push#2 在飞
    expect(store.getDelivery(NID(2), "s1")?.state).toBe("pending");

    clock.step(24 * 3600_000); // re-push 到点：守卫 busy → 全程让路，无第二未结算 push
    expect(pusher.maxConcurrent).toBe(1);
    expect(pusher.pushed).toHaveLength(2); // 无 re-push 行

    hold.resolve();
    await micro(); // push#2 结算 → 守卫释放
    expect(store.getDelivery(NID(2), "s1")?.state).toBe("accepted");
    clock.step(1000); // 下一兜底 tick：re-push 获守卫 → 恰一次
    await micro();
    expect(pusher.pushed).toHaveLength(3);
    expect(lineOf(pusher, 2).entries[0]!.notificationId).toBe(NID(1));
    expect(store.getDelivery(NID(1), "s1")?.state).toBe("accepted"); // 不经 drain：状态不迁移
    expect(pusher.maxConcurrent).toBe(1);
    loops.stop();
  });
});

// =============================================================================
// 票 38 评审修复 — Group Push：broadcastWake 假成功（送达数门 H）+ sessionEnd 注销（M）
// =============================================================================

describe("票 38 评审修复 — Group Push H：0 送达不迁移（保持 pending，尽力唤醒不退避不 dead-letter）", () => {
  it("零送达 push（resolve 0）→ pending 不变；反复重试仍 pending 不 dead-letter（客户端随时可连）", async () => {
    const store = createMemoryStore();
    store.putEntity({ type: REF.type, key: REF.key, state: null });
    seedSub(store);
    const clock = new FakeClock();
    const zeroPusher: Pusher = { push: async () => 0 }; // transport 零注册连接形态：broadcastWake 送达 0
    const loops = startLoops(makeCtx(store, { clock, pusher: zeroPusher }));
    loops.sessionStart("s1");
    loops.submit({ kind: "transition", ref: REF, verdict: "passed", occurredAt: at(1) });

    clock.step(2000); // 窗口到点冲刷
    await micro();
    expect(store.getDelivery(NID(1), "s1")?.state).toBe("pending"); // 0 送达不迁移（修复前假迁移 accepted）

    for (let i = 0; i < 16; i++) {
      // 兜底重开窗反复重试：不进退避（否则 14 次后 dead-letter）、不假成功
      clock.step(10_000);
      await micro();
      expect(store.getDelivery(NID(1), "s1")?.state).toBe("pending");
    }
    expect(loops.errors).toHaveLength(0);
    loops.stop();
  });
});

describe("票 38 评审修复 — Group Push M：sessionEnd 注销（断连后 fanOut 不再投它）", () => {
  it("sessionEnd 从活跃面删除：后续事件编址 parked 零推送；重连 drain 后照常送达 accepted", async () => {
    const store = createMemoryStore();
    store.putEntity({ type: REF.type, key: REF.key, state: null });
    seedSub(store);
    const clock = new FakeClock();
    const pusher = new FakePusher();
    const loops = startLoops(makeCtx(store, { clock, pusher }));
    loops.sessionStart("s1");
    loops.sessionEnd("s1"); // 断连注销（transport onSessionEnd 接线）

    loops.submit({ kind: "transition", ref: REF, verdict: "failed", occurredAt: at(1) }); // failed 绕行立即冲刷
    await micro();
    expect(store.getDelivery(NID(1), "s1")?.state).toBe("parked"); // 不在活跃面 → parked（修复前残留活跃假推送）
    expect(pusher.pushed).toHaveLength(0);

    loops.sessionStart("s1"); // 重连：drain（只投 parked D2a）+ snapshot 冲刷
    await micro();
    expect(pusher.pushed).toHaveLength(1);
    expect(lineOf(pusher, 0).entries[0]!.notificationId).toBe(NID(1));
    expect(store.getDelivery(NID(1), "s1")?.state).toBe("accepted");
    loops.stop();
  });

  it("sessionEnd 未知/重复 session 幂等；stopped 后抛错（与 submit 同语义）", () => {
    const store = createMemoryStore();
    store.putEntity({ type: REF.type, key: REF.key, state: null });
    const loops = startLoops(makeCtx(store));
    expect(() => loops.sessionEnd("never-started")).not.toThrow();
    expect(() => loops.sessionEnd("never-started")).not.toThrow(); // 重复注销幂等
    loops.stop();
    expect(() => loops.sessionEnd("s1")).toThrow(/loops stopped/); // stopped 后抛错
  });
});


describe("票 44 — Transitioned 沿广播（观察面板 edge-driven 刷新）", () => {
  class EdgePusher implements Pusher {
    readonly pushed: string[] = [];
    readonly edges: string[] = [];
    push(line: string): Promise<number> {
      this.pushed.push(line);
      return Promise.resolve(1);
    }
    pushEdge(line: string): Promise<number> {
      this.edges.push(line);
      return Promise.resolve(1);
    }
  }

  it("每次事件消费（fanOut）后推一行 transitioned 沿（entityRef/from/to/eventSeq）；无 pushEdge 实现则跳过不炸", async () => {
    const pusher = new EdgePusher();
    const store = createMemoryStore();
    const clock = new FakeClock();
    const loops = startLoops(makeCtx(store, { clock, pusher }));
    store.putEntity({ type: REF.type, key: REF.key, state: null });
    await loops.submit({ kind: "transition", ref: REF, verdict: "failed", occurredAt: "2026-01-01T00:00:00Z" });
    await micro();
    expect(pusher.edges).toHaveLength(1);
    expect(JSON.parse(pusher.edges[0]!)).toEqual({
      kind: "transitioned",
      entityRef: "fixture:widget:external/fixture-1",
      from: null,
      to: "failed",
      eventSeq: 1,
    });

    // 无 pushEdge 的 pusher（旧 fake/旧实现）：沿跳过，主 wake 路径不受影响
    const bare = startLoops(makeCtx(store, { clock: new FakeClock() }));
    store.putEntity({ type: REF.type, key: "external/other", state: null });
    await bare.submit({ kind: "transition", ref: { type: REF.type, key: "external/other" }, verdict: "passed", occurredAt: "2026-01-01T00:00:01Z" });
    await micro();
    bare.stop();
    loops.stop();
  });

  it("票 44 评审：pushEdge 同步 throw 不改变主链结果（fanOut 已提交、事件已消费、consumeFanOut 不报错）", async () => {
    class ThrowingEdgePusher implements Pusher {
      push(line: string): Promise<number> {
        return Promise.resolve(1);
      }
      pushEdge(_line: string): Promise<number> {
        throw new Error("sync boom"); // promise 返回前同步炸
      }
    }
    const pusher = new ThrowingEdgePusher();
    const store = createMemoryStore();
    const clock = new FakeClock();
    const loops = startLoops(makeCtx(store, { clock, pusher }));
    store.putEntity({ type: REF.type, key: REF.key, state: null });
    await expect(
      loops.submit({ kind: "transition", ref: REF, verdict: "failed", occurredAt: "2026-01-01T00:00:00Z" }),
    ).resolves.toBeDefined(); // 主链成功：观测同步 throw 被吞
    await micro();
    expect(store.tx((tx) => tx.getEvent(NID(1)))).toBeDefined(); // 事件已落盘（fanOut 已提交）
    loops.stop();
  });
});
