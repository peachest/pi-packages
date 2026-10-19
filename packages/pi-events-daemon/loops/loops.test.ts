/**
 * Ticket 25 acceptance tests — L0 Mutation 唯一写者 + startLoops 骨架（loops 链起点）。
 * A 层：fx 全注入（FakeClock/FakeExec/FakePusher/FakeFs + MemoryStore），确定性推演。
 *
 * 断言组：
 *  1. L0 串行顺序（N 请求 → 提交序 = 消费序；重入提交 FIFO 续排）
 *  2. 缓存与 store 一致（唯一写点在提交回调；拒绝/无提交不动缓存）
 *  3. startLoops 假时钟/假 store 启动（后续 A 层票底座）+ 双轨重启恢复
 *     （decisionOrder ← mutation line、eventSeq ← 事件流尾，各从自己的真相源）
 */
import { describe, it, expect } from "vitest";
import { createMemoryStore, type Store } from "../store/index.ts";
import { FakeClock, FakeExec, FakeFs, FakePusher, type Pusher } from "../fx/index.ts";
import { deterministicEventId } from "../domain/intent.ts";
import { entityRefKeyOf } from "../domain/types.ts";
import { Kernel } from "../kernel/index.ts";
import { cronNextMs, startLoops, type LoopsCtx } from "./index.ts";

// --- fixture（数据，非 profile；kernel.test.ts 同法）---
const REF = { type: "fixture:widget", key: "external/fixture-1" };
const REF_KEY = entityRefKeyOf(REF);
const STATES = new Set(["passed", "failed", "waiting"]);
const at = (n: number) => `2026-01-01T00:00:${String(n).padStart(2, "0")}Z`;

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

describe("组 1：L0 串行队列——kernel 方法调用唯一路径，提交序 = 消费序", () => {
  it("N 请求入队：outbox 提交序 = 入队序，双轨游标按消费序单调分配", () => {
    const store = createMemoryStore();
    store.putEntity({ type: REF.type, key: REF.key, state: null });
    const loops = startLoops(makeCtx(store));

    const verdicts = ["waiting", "failed", "passed", "waiting", "failed"] as const;
    for (const verdict of verdicts) loops.submit({ kind: "transition", ref: REF, verdict, occurredAt: at(1) });

    // 提交序 = 消费序：outbox 插入序（Map 插入序 = 提交序）eventSeq 1..N，to 链 = 入队 verdict 链
    const outbox = store.outboxBatch(Number.MAX_SAFE_INTEGER);
    expect(outbox.map((r) => r.eventSeq)).toEqual([1, 2, 3, 4, 5]);
    const events = outbox.map((r) => store.tx((tx) => tx.getEvent(r.notificationId)!));
    expect(events.map((e) => e.to)).toEqual([...verdicts]);
    // 决策轨 = 消费序：确定性 event id 尾段 decisionOrder 1..N
    expect(events.map((e) => e.eventId)).toEqual(verdicts.map((_, i) => deterministicEventId(REF, i + 1)));
    expect(store.getEntity(REF.type, REF.key)?.state).toBe("failed");
  });

  it("重入提交 FIFO 续排：提交回调内再 submit 不插队、不双跑", () => {
    const store = createMemoryStore();
    store.putEntity({ type: REF.type, key: REF.key, state: null });
    const loops = startLoops(makeCtx(store));

    // 模拟 C2 on-transition 编排形态：首个提交的回调内再入队一个 transition
    let chained = false;
    store.onWrite((tables) => {
      if (!chained && tables.includes("entities")) {
        chained = true;
        loops.submit({ kind: "transition", ref: REF, verdict: "passed", occurredAt: at(2) });
      }
    });

    loops.submit({ kind: "transition", ref: REF, verdict: "failed", occurredAt: at(1) });
    const outbox = store.outboxBatch(Number.MAX_SAFE_INTEGER);
    expect(outbox.map((r) => r.eventSeq)).toEqual([1, 2]);
    const events = outbox.map((r) => store.tx((tx) => tx.getEvent(r.notificationId)!));
    expect(events.map((e) => e.to)).toEqual(["failed", "passed"]); // 链式请求排在外层请求之后
  });

  it("坏请求不死队列：kernel 拒绝（dead-letter 语义抛出）在 errors 可见，后续请求继续消费", () => {
    const store = createMemoryStore();
    store.putEntity({ type: REF.type, key: REF.key, state: null });
    const loops = startLoops(makeCtx(store));

    loops.submit({ kind: "transition", ref: { type: "fixture:ghost", key: "external/none" }, verdict: "failed", occurredAt: at(1) });
    expect(loops.errors).toHaveLength(1);

    loops.submit({ kind: "transition", ref: REF, verdict: "failed", occurredAt: at(1) });
    expect(store.outboxBatch(10)).toHaveLength(1); // 队列存活，下一请求正常提交
    expect(loops.errors).toHaveLength(1);
  });
});

describe("组 2：缓存只在提交回调更新——提交回调外无缓存写路径", () => {
  it("提交后缓存与 store 一致：states 投影逐实体相等", () => {
    const store = createMemoryStore();
    store.putEntity({ type: REF.type, key: REF.key, state: null });
    const other = { type: "fixture:widget", key: "external/fixture-2" };
    store.putEntity({ type: other.type, key: other.key, state: "passed" });
    const loops = startLoops(makeCtx(store));

    loops.submit({ kind: "transition", ref: REF, verdict: "failed", occurredAt: at(1) });
    loops.submit({ kind: "transition", ref: other, verdict: "failed", occurredAt: at(1) });

    const projection = new Map(
      store.queryEntities({}).map((e) => [entityRefKeyOf({ type: e.type, key: e.key }), e.state]),
    );
    expect(loops.cache.states.size).toBe(projection.size);
    for (const [k, v] of projection) expect(loops.cache.states.get(k)).toBe(v);
    expect(loops.cache.states.get(REF_KEY)).toBe("failed");
  });

  it("无提交不动缓存：被拒请求（unknown entity）后 cache 快照逐位不变", () => {
    const store = createMemoryStore();
    store.putEntity({ type: REF.type, key: REF.key, state: "passed" });
    const loops = startLoops(makeCtx(store));
    const before = [...loops.cache.states.entries()];

    loops.submit({ kind: "transition", ref: { type: "fixture:ghost", key: "external/none" }, verdict: "failed", occurredAt: at(1) });

    expect(loops.errors).toHaveLength(1);
    expect(store.tx((tx) => tx.getEvent(deterministicEventId({ type: "fixture:ghost", key: "external/none" }, 1)))).toBeUndefined();
    expect([...loops.cache.states.entries()]).toEqual(before); // 回调未触发 → 缓存零写
  });

});

describe("组 4：ocr 评审修复——启动种子投影 / stop 解除订阅 / stop 终止 drain", () => {
  it("Finding 1：重启后初始投影——预置实体启动、无后续写 → 缓存含实体（不漏已有实体）", () => {
    const store = createMemoryStore();
    store.putEntity({ type: REF.type, key: REF.key, state: "passed" });
    const loops = startLoops(makeCtx(store));
    expect(loops.cache.states.get(REF_KEY)).toBe("passed"); // 启动即含已提交实体，不等新写
  });

  it("Finding 2：stop 解除订阅——stop 后外部提交不更新旧句柄缓存，stop 幂等", () => {
    const store = createMemoryStore();
    store.putEntity({ type: REF.type, key: REF.key, state: null });
    const loops = startLoops(makeCtx(store));
    loops.submit({ kind: "transition", ref: REF, verdict: "failed", occurredAt: at(1) });
    loops.stop();
    loops.stop(); // 幂等：不抛
    store.putEntity({ type: REF.type, key: REF.key, state: "passed" }); // 外部提交（绕过 L0）
    expect(loops.cache.states.get(REF_KEY)).toBe("failed"); // 订阅已解除，旧缓存停更
  });

  it("Finding 3：提交回调内重入 submit 后 stop()——旧 drain 不再消费剩余请求，重启侧无重复 eventSeq", () => {
    const store = createMemoryStore();
    store.putEntity({ type: REF.type, key: REF.key, state: null });
    const first = startLoops(makeCtx(store));
    let armed = false;
    store.onWrite((tables) => {
      if (!armed && tables.includes("entities")) {
        armed = true;
        first.submit({ kind: "transition", ref: REF, verdict: "passed", occurredAt: at(2) }); // 重入入队
        first.stop(); // 提交回调内停机：外层 drain 尚有剩余请求
      }
    });
    first.submit({ kind: "transition", ref: REF, verdict: "failed", occurredAt: at(1) });
    expect(store.outboxBatch(10).map((r) => r.eventSeq)).toEqual([1]); // 剩余请求丢弃，不消费
    // 重启侧 L0 重放自愈：位点接事件流尾，无重复 eventSeq
    const second = startLoops(makeCtx(store));
    second.submit({ kind: "transition", ref: REF, verdict: "waiting", occurredAt: at(3) });
    const outbox = store.outboxBatch(Number.MAX_SAFE_INTEGER);
    expect(outbox.map((r) => r.eventSeq)).toEqual([1, 2]);
    expect(outbox.map((r) => store.tx((tx) => tx.getEvent(r.notificationId)!.to))).toEqual(["failed", "waiting"]);
  });
});

describe("组 3：startLoops 假时钟/假 store 启动 + 双轨重启恢复", () => {
  it("重启重入：startLoops 二次接线后缓存重新挂回调、旧句柄缓存停更", () => {
    const store = createMemoryStore();
    store.putEntity({ type: REF.type, key: REF.key, state: null });
    const first = startLoops(makeCtx(store));
    first.submit({ kind: "transition", ref: REF, verdict: "failed", occurredAt: at(1) });
    first.stop();

    const second = startLoops(makeCtx(store));
    second.submit({ kind: "transition", ref: REF, verdict: "waiting", occurredAt: at(2) });
    expect(second.cache.states.get(REF_KEY)).toBe("waiting");
    expect(first.cache.states.get(REF_KEY)).toBe("failed"); // 旧句柄不再消费提交
    expect(first.errors).toHaveLength(0);
  });

  it("fx 全假注入可启动：骨架零定时器（无隐藏 busy-poll），stop 后 submit 拒绝", () => {
    const clock = new FakeClock();
    const store = createMemoryStore();
    store.putEntity({ type: REF.type, key: REF.key, state: null });
    const loops = startLoops(makeCtx(store, { clock }));

    expect(clock.pendingCount).toBe(2); // 常驻定时器 = 1s L2 兜底扫（票 27）+ L4 housekeeping 1h 周期（票 28）
    loops.submit({ kind: "transition", ref: REF, verdict: "failed", occurredAt: at(1) });
    clock.step(60_000); // 推演安全：兜底扫周期触发 + L4 housekeeping 未到期仍在（空投递面）
    expect(clock.pendingCount).toBe(2);
    expect(store.getEntity(REF.type, REF.key)?.state).toBe("failed");

    loops.stop();
    expect(() => loops.submit({ kind: "transition", ref: REF, verdict: "waiting", occurredAt: at(2) })).toThrow(/stopped/);
  });

  it("双轨重启恢复：decisionOrder ← mutation line（事件 id 尾段），eventSeq ← 事件流尾——重放不重新编号", () => {
    const store = createMemoryStore();
    store.putEntity({ type: REF.type, key: REF.key, state: null });
    const life1 = startLoops(makeCtx(store));
    life1.submit({ kind: "transition", ref: REF, verdict: "waiting", occurredAt: at(1) });
    life1.submit({ kind: "transition", ref: REF, verdict: "failed", occurredAt: at(2) });
    life1.stop();
    expect(store.outboxBatch(10).map((r) => r.eventSeq)).toEqual([1, 2]);

    // 双轨分叉的意图（决策轨 7 / 写入轨 9）：经 consumeIntent 消费终点落库
    const life2 = startLoops(makeCtx(store));
    life2.submit({
      kind: "consumeIntent",
      intent: {
        eventId: deterministicEventId(REF, 7),
        decisionOrder: 7,
        eventSeq: 9,
        entityRef: REF,
        from: "failed",
        to: "passed",
        occurredAt: at(3),
      },
    });
    life2.submit({ kind: "transition", ref: REF, verdict: "waiting", occurredAt: at(4) });

    const outbox = store.outboxBatch(Number.MAX_SAFE_INTEGER).sort((a, b) => a.eventSeq - b.eventSeq);
    expect(outbox.map((r) => r.eventSeq)).toEqual([1, 2, 9, 10]); // 写入轨接 9 → 10（事件流尾恢复）
    const events = outbox.map((r) => store.tx((tx) => tx.getEvent(r.notificationId)!));
    expect(events.map((e) => e.eventId)).toEqual([
      deterministicEventId(REF, 1),
      deterministicEventId(REF, 2),
      deterministicEventId(REF, 7),
      deterministicEventId(REF, 8), // 决策轨接 7 → 8（mutation line 位点恢复）
    ]);
    expect(events[3].to).toBe("waiting");
    expect(life2.errors).toHaveLength(0); // 无 corruption：编号未重置
  });
});

// =============================================================================
// 票 26 — L1 Probe：调度（cron/interval）+ completion 回流消费 + catch_up_one + once/twoStage
// A 层：fx 全注入（FakeClock 手动推演 + FakeExec/DeferredExec 脚本化 completion），确定性时序。
// =============================================================================

const TPL = "fixture-tpl";
const SLOT_KEY = `slot:${REF.type}:${REF.key}#${TPL}`;
const micro = () => new Promise<void>((resolve) => setTimeout(resolve, 0)); // 微任务冲刷（prober.test 同法）

/** 可控延迟执行器：run 挂起、按调用序手动放行（回流稳序/并发场景）。 */
class DeferredExec {
  readonly calls: { command: string }[] = [];
  private resolvers: ((r: { exitCode: number | null; signal: string | null; stdout: string; stderr: string; timedOut: boolean }) => void)[] = [];
  run(command: string): Promise<{ exitCode: number | null; signal: string | null; stdout: string; stderr: string; timedOut: boolean }> {
    this.calls.push({ command });
    return new Promise((resolve) => this.resolvers.push(resolve));
  }
  resolve(at: number, result: Partial<{ exitCode: number | null; signal: string | null; stdout: string; stderr: string; timedOut: boolean }> = {}): void {
    this.resolvers[at]({ exitCode: 0, signal: null, stdout: "", stderr: "", timedOut: false, ...result });
  }
}

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

describe("票 26 — cron 到点排 probe + missed tick catch_up_one 补触发恰一次", () => {
  it("cron 到点：新建槽首探即时、到点前不跑、到点恰一次、下一到点才再跑", async () => {
    const store = createMemoryStore();
    store.putEntity({ type: REF.type, key: REF.key, state: null });
    const clock = new FakeClock();
    const exec = new FakeExec();
    exec.enqueue({ exitCode: 1 }, { exitCode: 1 }, { exitCode: 1 }); // waiting：不翻转不发事件
    const loops = startLoops(makeCtx(store, { clock, exec }));
    subVia(loops, {}, { opts: { schedule: { type: "cron", cron: "*/5 * * * *" } } });

    clock.step(0);
    await micro();
    expect(exec.calls).toHaveLength(1); // 新建槽首探（归零重探同精神）
    expect(store.getRunLedger(SLOT_KEY)?.nextDueAt).toBe(5 * 60_000); // cronNext 下一到点

    clock.step(4 * 60_000);
    await micro();
    expect(exec.calls).toHaveLength(1); // 4min：未到点

    clock.step(60_000);
    await micro();
    expect(exec.calls).toHaveLength(2); // 5min 到点：恰一次
    expect(store.getRunLedger(SLOT_KEY)?.nextDueAt).toBe(10 * 60_000);

    clock.step(60_000);
    await micro();
    expect(exec.calls).toHaveLength(2); // 6min：下一到点 10min，不提前
    loops.stop();
  });

  it("missed tick catch_up_one：停机跨过 6 个 cron 点 → 启动补触发恰一次（合一不逐点补），回流进 L0 完成转换", async () => {
    const store = createMemoryStore();
    store.putEntity({ type: REF.type, key: REF.key, state: null });
    // 停机现场：槽 nextDueAt 停在 5min；重启时时钟已到 30min（跨 5/10/15/20/25/30 六个到点）
    store.putProbeSpec({ slotKey: SLOT_KEY, check: "fixture-check", schedule: { type: "cron", cron: "*/5 * * * *" }, source: "poll" });
    store.putRunLedger({ slotKey: SLOT_KEY, epoch: 0, refcount: 1, consecutiveFails: 0, nextDueAt: 5 * 60_000, entityRefType: REF.type, entityRefKey: REF.key });
    store.putSubscription({ subscriptionId: "sub-seed", sessionId: "session-1", entityRefType: REF.type, entityRefKey: REF.key, template: TPL, check: "fixture-check", origin: "session", createdAt: 0 });

    const clock = new FakeClock();
    clock.step(30 * 60_000);
    const exec = new FakeExec();
    exec.enqueue({ exitCode: 2 }); // failed：翻转沿发事件
    const loops = startLoops(makeCtx(store, { clock, exec }));

    await micro();
    expect(exec.calls).toHaveLength(1); // 补触发恰一次（非 6 次）
    expect(store.getRunLedger(SLOT_KEY)?.nextDueAt).toBe(35 * 60_000); // 直接跳下一未来到点
    expect(store.getEntity(REF.type, REF.key)?.state).toBe("failed"); // completion → L1 → L0 转换应用
    clock.step(60_000);
    await micro();
    expect(exec.calls).toHaveLength(1); // 恰一次：不重复补
    loops.stop();
  });
});

describe("票 26 — L1→L0 verdict 应用串行（并发回流不乱序）+ watch 回流同路", () => {
  it("并发回流稳序：completion 按提交序应用（B 先结算不插队，A 结算后 A→B 依次串行）", async () => {
    const store = createMemoryStore();
    const REF_B = { type: "fixture:widget", key: "external/fixture-2" };
    store.putEntity({ type: REF.type, key: REF.key, state: null });
    store.putEntity({ type: REF_B.type, key: REF_B.key, state: null });
    const clock = new FakeClock();
    const exec = new DeferredExec();
    const loops = startLoops(makeCtx(store, { clock, exec: exec as unknown as FakeExec }));
    subVia(loops, {}, { check: "check-a", template: "tpl-a" });
    subVia(loops, {}, { check: "check-b", template: "tpl-b", entityRef: REF_B });

    clock.step(0); // 双槽首探（提交序 A、B）
    expect(exec.calls.map((c) => c.command)).toEqual(["check-a", "check-b"]);
    exec.resolve(1, { exitCode: 2 }); // B 先结算 → prober 稳序缓冲滞留，回流不交付
    await micro();
    expect(store.outboxBatch(10)).toHaveLength(0);

    exec.resolve(0, { exitCode: 0 }); // A 结算 → A、B 依次回流，L0 串行应用
    await micro();
    const outbox = store.outboxBatch(10);
    expect(outbox.map((r) => r.eventSeq)).toEqual([1, 2]);
    expect(store.tx((tx) => tx.getEvent(outbox[0].notificationId))).toMatchObject({ entityRefKey: REF.key, to: "passed" });
    expect(store.tx((tx) => tx.getEvent(outbox[1].notificationId))).toMatchObject({ entityRefKey: REF_B.key, to: "failed" });
    loops.stop();
  });

  it("fs-watch 回流同路消费：非 poll 槽不占到点调度，ingestProbeResult 直入 L1→L0", () => {
    const store = createMemoryStore();
    store.putEntity({ type: REF.type, key: REF.key, state: null });
    const clock = new FakeClock();
    const exec = new FakeExec();
    const loops = startLoops(makeCtx(store, { clock, exec }));
    subVia(loops, {}, { opts: { source: "fs-watch", schedule: { type: "interval", intervalMs: 60_000 } } });

    clock.step(10 * 60_000); // 到点也不排 probe（fs-watch 原生推送，调度归 prober watch 票）
    expect(exec.calls).toHaveLength(0);

    loops.ingestProbeResult({ slotKey: SLOT_KEY, verdict: "passed", reason: "watch event", evidence: "", durationMs: 1 });
    expect(store.getEntity(REF.type, REF.key)?.state).toBe("passed"); // L1→L0 同路串行应用
    expect(store.getRunLedger(SLOT_KEY)?.lastVerdict).toBe("passed");
    loops.stop();
  });
});

describe("票 26 — 阈值计数评估在 L0 消费时调用（domain observeVerdict）", () => {
  it("连续 failed 达 failureThreshold 才翻转发事件；计数期内不翻转不发；账本镜像 consecutiveFails", async () => {
    const store = createMemoryStore();
    store.putEntity({ type: REF.type, key: REF.key, state: null });
    const clock = new FakeClock();
    const exec = new FakeExec();
    exec.enqueue({ exitCode: 2 });
    const loops = startLoops(makeCtx(store, { clock, exec }));
    subVia(loops, {}, { opts: { failureThreshold: 3, schedule: { type: "interval", intervalMs: 60_000 } } });

    clock.step(0);
    await micro();
    expect(store.outboxBatch(10)).toHaveLength(0); // 第 1 次 failed：计数 1，不翻转
    expect(store.getRunLedger(SLOT_KEY)?.consecutiveFails).toBe(1);

    loops.ingestProbeResult({ slotKey: SLOT_KEY, verdict: "failed", reason: "exit 2", evidence: "", durationMs: 1 });
    expect(store.outboxBatch(10)).toHaveLength(0); // 第 2 次 failed：计数 2，仍在阈值内不翻转
    loops.ingestProbeResult({ slotKey: SLOT_KEY, verdict: "failed", reason: "exit 2", evidence: "", durationMs: 1 });
    expect(store.getEntity(REF.type, REF.key)?.state).toBe("failed"); // 第 3 次 failed 到达阈值 → 翻转发事件
    expect(store.outboxBatch(10)).toHaveLength(1);
    expect(store.getRunLedger(SLOT_KEY)?.consecutiveFails).toBe(3);
    loops.stop();
  });
});

describe("票 26 — once 自动关订阅 + 两阶段 readyCheck 切换", () => {
  it("once 首 passed：L0 消费转换后关订阅（once-passed），solo 槽 refcount 归零；后续 verdict 不再驱动", async () => {
    const store = createMemoryStore();
    store.putEntity({ type: REF.type, key: REF.key, state: null });
    const clock = new FakeClock();
    const exec = new FakeExec();
    exec.enqueue({ exitCode: 0 });
    const loops = startLoops(makeCtx(store, { clock, exec }));
    subVia(loops, {}, { opts: { once: true, schedule: { type: "interval", intervalMs: 60_000 } } });

    clock.step(0);
    await micro();
    expect(store.getEntity(REF.type, REF.key)?.state).toBe("passed"); // 转换先于关闭
    const row = store.querySubscriptions({ sessionId: "session-1" })[0];
    expect(row.closedReason).toBe("once-passed");
    expect(row.closedAt).toBeDefined();
    expect(store.getRunLedger(SLOT_KEY)?.refcount).toBe(0); // solo 槽随末订阅关闭销毁

    loops.ingestProbeResult({ slotKey: SLOT_KEY, verdict: "failed", reason: "exit 2", evidence: "", durationMs: 1 });
    await micro();
    expect(store.outboxBatch(10)).toHaveLength(1); // stale completion 丢弃（无新事件）
    expect(loops.errors).toHaveLength(0);
    loops.stop();
  });

  it("两阶段：startup check 通过 → phase=flip + solo 槽换 readyCheck；第二探针用 flip 判定 check；flip 相位 stay-open", async () => {
    const store = createMemoryStore();
    store.putEntity({ type: REF.type, key: REF.key, state: null });
    const clock = new FakeClock();
    const exec = new FakeExec();
    exec.enqueue({ exitCode: 0 }, { exitCode: 0 }, { exitCode: 0 });
    const loops = startLoops(makeCtx(store, { clock, exec }));
    subVia(loops, {}, {
      check: "fixture-startup-check",
      opts: { flip: true, readyCheck: "fixture-ready-check", schedule: { type: "interval", intervalMs: 60_000 } },
    });

    clock.step(0);
    await micro();
    expect(exec.calls[0]?.command).toBe("fixture-startup-check"); // startup 相位用 check
    const row = () => store.querySubscriptions({ sessionId: "session-1" })[0];
    expect(row().phase).toBe("flip"); // startup passed → flip 切换
    expect(store.getProbeSpec(SLOT_KEY)?.check).toBe("fixture-ready-check"); // solo 槽 checker 替换

    clock.step(60_000);
    await micro();
    expect(exec.calls[1]?.command).toBe("fixture-ready-check"); // 第二探针调度归 L1，用 readyCheck
    expect(row().closedAt).toBeUndefined(); // flip 相位 passed → stay-open（监视形态）

    loops.ingestProbeResult({ slotKey: SLOT_KEY, verdict: "passed", reason: "exit 0", evidence: "", durationMs: 1 });
    expect(row().phase).toBe("flip"); // 二次推进幂等（仅 startup→flip 一跳）
    loops.stop();
  });
});

describe("评审修复 — 槽 generation 隔离（B 组：重建/换参后旧计数清零、旧 completion 拒应用）", () => {
  it("B3 solo 换参重建槽：新 checker 首次失败不触发（旧计数清零、generation+1）", async () => {
    const store = createMemoryStore();
    store.putEntity({ type: REF.type, key: REF.key, state: null });
    const clock = new FakeClock();
    const exec = new FakeExec();
    exec.enqueue({ exitCode: 2 });
    const loops = startLoops(makeCtx(store, { clock, exec }));
    subVia(loops, {}, { check: "check-a", opts: { failureThreshold: 2, schedule: { type: "interval", intervalMs: 60_000 } } });

    clock.step(0);
    await micro();
    expect(store.outboxBatch(10)).toHaveLength(0); // 第 1 次 failed：计数 1 不翻转
    expect(store.getRunLedger(SLOT_KEY)).toMatchObject({ consecutiveFails: 1, generation: 0 });

    // 换参（checker 替换）→ 槽重建 generation +1，阈值计数归零
    subVia(loops, {}, { check: "check-b", opts: { failureThreshold: 2, schedule: { type: "interval", intervalMs: 60_000 } } });
    await micro();
    expect(store.getRunLedger(SLOT_KEY)).toMatchObject({ consecutiveFails: 0, generation: 1 });

    // 新 checker 首次失败：若旧计数未清则 1+1=2 触发；清零后仅计数 1，不发事件。
    // 重建 = 新槽语义：首探即时（nextDueAt 归零 → timer due 0），step(0) 即触发；
    // 若 step(60_000) 会先撞上探针 10s 超时定时器（同步 step 窗口内）→ waiting 回流非本测语义。
    exec.enqueue({ exitCode: 2 });
    clock.step(0);
    await micro();
    expect(store.outboxBatch(10)).toHaveLength(0);
    expect(store.getRunLedger(SLOT_KEY)?.consecutiveFails).toBe(1);
    loops.stop();
  });

  it("B5 probe pending 中取消末订阅再重订阅（共享槽双订阅）：旧 completion 不串新槽，新 completion 正常应用", async () => {
    const store = createMemoryStore();
    store.putEntity({ type: REF.type, key: REF.key, state: null });
    const clock = new FakeClock();
    const exec = new DeferredExec();
    const loops = startLoops(makeCtx(store, { clock, exec: exec as unknown as FakeExec }));
    subVia(loops, {}, { check: "shared-check" });
    subVia(loops, {}, { check: "shared-check", sessionId: "session-2" });

    clock.step(0); // 首探 dispatch（in-flight，generation 0）
    expect(exec.calls).toHaveLength(1);

    // 双订阅全取消（槽销毁 refcount 0）→ 重订阅（同 slotKey 重建 generation 1）
    const subs = store.querySubscriptions({});
    for (const s of subs) loops.submit({ kind: "cancel", req: { subscriptionId: s.subscriptionId, now: 1_000 } });
    await micro();
    expect(store.getRunLedger(SLOT_KEY)?.refcount).toBe(0);
    subVia(loops, {}, { check: "shared-check", sessionId: "session-1" });
    await micro();
    expect(store.getRunLedger(SLOT_KEY)?.generation).toBe(1);

    exec.resolve(0, { exitCode: 2 }); // 旧 completion（generation 0 dispatch）回流
    await micro();
    expect(store.outboxBatch(10)).toHaveLength(0); // 旧 generation verdict 被拒

    clock.step(0); // 旧 completion 结算后 in-flight 清空 → 下一代首探
    expect(exec.calls).toHaveLength(2);
    exec.resolve(1, { exitCode: 2 }); // 新 completion（generation 1）
    await micro();
    expect(store.getEntity(REF.type, REF.key)?.state).toBe("failed"); // 新 verdict 正常应用
    expect(store.outboxBatch(10)).toHaveLength(1);
    loops.stop();
  });

  it("B4 generation 变化时旧 completion 被拒：probeVerdict 载体带旧 generation → 丢弃，同代正常应用", () => {
    const store = createMemoryStore();
    store.putEntity({ type: REF.type, key: REF.key, state: null });
    store.putProbeSpec({ slotKey: SLOT_KEY, check: "fixture-check", schedule: { type: "interval", intervalMs: 60_000 }, source: "poll" });
    store.putRunLedger({ slotKey: SLOT_KEY, epoch: 0, refcount: 1, consecutiveFails: 0, entityRefType: REF.type, entityRefKey: REF.key, generation: 1 });
    store.putSubscription({ subscriptionId: "sub-seed", sessionId: "session-1", entityRefType: REF.type, entityRefKey: REF.key, template: TPL, check: "fixture-check", origin: "session", createdAt: 0 });
    const clock = new FakeClock();
    const loops = startLoops(makeCtx(store, { clock }));

    loops.submit({ kind: "probeVerdict", slotKey: SLOT_KEY, verdict: "failed", occurredAt: at(1), generation: 0 });
    expect(store.outboxBatch(10)).toHaveLength(0); // 旧代 completion 丢弃
    expect(store.getRunLedger(SLOT_KEY)?.consecutiveFails).toBe(0);

    loops.submit({ kind: "probeVerdict", slotKey: SLOT_KEY, verdict: "failed", occurredAt: at(2), generation: 1 });
    expect(store.getEntity(REF.type, REF.key)?.state).toBe("failed"); // 同代正常应用
    loops.stop();
  });
});

describe("票 26 — cronNextMs（5 字段 UTC 分钟粒度纯函数）", () => {
  it("步进/每日固定点/列表/周区间/dom+dow 双受限 OR/字段数校验", () => {
    const T0 = Date.UTC(2026, 0, 1, 12, 3); // 2026-01-01（周四）12:03
    expect(cronNextMs("*/5 * * * *", T0)).toBe(Date.UTC(2026, 0, 1, 12, 5));
    expect(cronNextMs("30 2 * * *", T0)).toBe(Date.UTC(2026, 0, 2, 2, 30)); // 次日到点
    expect(cronNextMs("0,15,30,45 * * * *", T0)).toBe(Date.UTC(2026, 0, 1, 12, 15));
    expect(cronNextMs("0 9 * * 1-5", Date.UTC(2026, 0, 3, 10, 0))).toBe(Date.UTC(2026, 0, 5, 9, 0)); // 周六 10:00 → 周一 09:00
    // dom+dow 双受限 OR：13 号或周一任一命中（1/5 周一先到，dom 13 单用会是 1/13）
    expect(cronNextMs("0 0 13 * 1", Date.UTC(2026, 0, 1, 0, 1))).toBe(Date.UTC(2026, 0, 5, 0, 0));
    // 1/12（周一）00:01 起：1/13 周二 dom 命中先于下周一 1/19
    expect(cronNextMs("0 0 13 * 1", Date.UTC(2026, 0, 12, 0, 1))).toBe(Date.UTC(2026, 0, 13, 0, 0));
    expect(() => cronNextMs("* * * *", 0)).toThrow(/5 字段/);
  });
});

// ==================== 评审修复 — C7/F11：达标才关 + 关闭前物化投递（事件→fanOut→cancel） ====================
describe("评审修复 — C 组（loops 面：关闭路径投递不丢）", () => {
  it("C7：once+successThreshold=2 未达标不关不投；达标 passed 物化投递（parked，epoch 0）后再关", async () => {
    const store = createMemoryStore();
    store.putEntity({ type: REF.type, key: REF.key, state: null });
    const clock = new FakeClock();
    const exec = new FakeExec();
    exec.enqueue({ exitCode: 0 }, { exitCode: 0 });
    const loops = startLoops(makeCtx(store, { clock, exec }));
    subVia(loops, {}, { opts: { once: true, successThreshold: 2, schedule: { type: "interval", intervalMs: 60_000 } } });

    clock.step(0);
    await micro();
    expect(store.getEntity(REF.type, REF.key)?.state).toBeNull(); // 未达标：不转换
    expect(store.outboxBatch(10)).toHaveLength(0); // 无事件
    expect(store.querySubscriptions({ sessionId: "session-1" })[0].closedAt).toBeUndefined(); // 不关（F6 旧缺陷在此提前关）
    loops.stop();
  });

  it("C7：达标 passed → 事件→fanOut（parked 投递行）→cancel 关订阅，顺序可观测", async () => {
    const store = createMemoryStore();
    store.putEntity({ type: REF.type, key: REF.key, state: null });
    const clock = new FakeClock();
    const exec = new FakeExec();
    exec.enqueue({ exitCode: 0 }, { exitCode: 0 });
    const loops = startLoops(makeCtx(store, { clock, exec }));
    subVia(loops, {}, { opts: { once: true, successThreshold: 2, schedule: { type: "interval", intervalMs: 60_000 } } });

    clock.step(0);
    await micro();
    clock.step(60_000); // 第二次 passed：达标翻转沿
    await micro();

    const eventId = deterministicEventId(REF, 1);
    expect(store.getEntity(REF.type, REF.key)?.state).toBe("passed"); // 转换已提交
    expect(store.outboxBatch(10)).toHaveLength(1);
    const delivery = store.getDelivery(eventId, "session-1");
    expect(delivery).toMatchObject({ state: "parked" }); // 关闭前已物化投递目标（loops 无 session runtime → parked 走 drain）
    expect(delivery?.recordEpoch).toBe(0); // I12：本 epoch 产出，drain fence 可重投
    const row = store.querySubscriptions({ sessionId: "session-1" })[0];
    expect(row.closedReason).toBe("once-passed");
    expect(store.getRunLedger(SLOT_KEY)?.refcount).toBe(0);
    loops.stop();
  });

  it("C7 崩溃重放同态：事件已在 outbox、订阅仍开 → 归零重评同态 flip 扫 outbox 补物化再关（无新事件）", async () => {
    const store = createMemoryStore();
    store.putEntity({ type: REF.type, key: REF.key, state: null });
    // 崩溃前缀模拟：transition 已提交（事件在 outbox），fanOut/cancel 未及执行（订阅尚不存在→重启后新订阅，无 delivery）
    const preKernel = new Kernel(store, STATES, 0);
    preKernel.transition(REF, "passed", at(1));
    const eventId = deterministicEventId(REF, 1);
    expect(store.outboxBatch(10)).toHaveLength(1);

    const clock = new FakeClock();
    const exec = new FakeExec();
    exec.enqueue({ exitCode: 0 }); // 重启归零重探：首个 fresh passed
    const loops = startLoops(makeCtx(store, { clock, exec }));
    subVia(loops, {}, { opts: { once: true, schedule: { type: "interval", intervalMs: 60_000 } } });
    clock.step(0);
    await micro();

    expect(store.outboxBatch(10)).toHaveLength(1); // 同态：不重编号不新增事件
    expect(store.getDelivery(eventId, "session-1")).toMatchObject({ state: "parked" }); // 补物化（评审 C7「崩溃重放后也成立」）
    const row = store.querySubscriptions({ sessionId: "session-1" })[0];
    expect(row.closedReason).toBe("once-passed");
    loops.stop();
  });
});

// ==================== 评审修复 — D 组：调度面（哨兵定时器 / 坏槽隔离 / 在飞上限 / 重启重探） ====================
describe("评审修复 — D 组（调度面）", () => {
  it("D10：never-fire cron 哨兵（366 天无匹配）不占定时器——完成回流后 pendingCount 0（无 1ms 忙循环）", async () => {
    const store = createMemoryStore();
    store.putEntity({ type: REF.type, key: REF.key, state: null });
    const clock = new FakeClock();
    const exec = new FakeExec();
    exec.enqueueFailure(new Error("boom"), true); // 同步失败 → tick 窗口内同步完成回流
    const loops = startLoops(makeCtx(store, { clock, exec }));
    subVia(loops, {}, { opts: { schedule: { type: "cron", cron: "0 0 31 2 *" } } }); // 2/31 不存在 → 永不触发
    clock.step(0); // 新建槽首探（timer due 0）→ 同步失败回流 → reschedule 见 nextDueAt 哨兵
    await micro();
    expect(store.getRunLedger(SLOT_KEY)?.nextDueAt).toBe(Number.MAX_SAFE_INTEGER);
    expect(clock.pendingCount).toBe(2); // 哨兵不排定时器（未修时 delay=MAX_SAFE_INTEGER 常驻成 1ms 忙循环）；常驻 2 = L2 兜底扫 + L4 housekeeping
    expect(loops.errors).toHaveLength(0);
    loops.stop();
  });

  it("D11：坏 cron 槽（直接注入 store 模拟遗留行）dispatch 记 error 跳过，其余槽照常 dispatch，启动不 abort", async () => {
    const store = createMemoryStore();
    store.putEntity({ type: REF.type, key: REF.key, state: null });
    store.putEntity({ type: REF.type, key: `${REF.key}-2`, state: null });
    store.putProbeSpec({ slotKey: SLOT_KEY, check: "bad-check", schedule: { type: "cron", cron: "bad" }, source: "poll" });
    store.putRunLedger({ slotKey: SLOT_KEY, epoch: 0, refcount: 1, consecutiveFails: 0, entityRefType: REF.type, entityRefKey: REF.key });
    const SLOT2 = `slot:${REF.type}:${REF.key}-2#${TPL}`;
    store.putProbeSpec({ slotKey: SLOT2, check: "good-check", schedule: { type: "interval", intervalMs: 60_000 }, source: "poll" });
    store.putRunLedger({ slotKey: SLOT2, epoch: 0, refcount: 1, consecutiveFails: 0, entityRefType: REF.type, entityRefKey: `${REF.key}-2` });
    store.putSubscription({ subscriptionId: "sub-bad", sessionId: "session-1", entityRefType: REF.type, entityRefKey: REF.key, template: TPL, check: "bad-check", origin: "session", createdAt: 0 });
    store.putSubscription({ subscriptionId: "sub-good", sessionId: "session-1", entityRefType: REF.type, entityRefKey: `${REF.key}-2`, template: TPL, check: "good-check", origin: "session", createdAt: 0 });
    const exec = new FakeExec();
    exec.enqueue({ exitCode: 2 });
    const loops = startLoops(makeCtx(store, { exec })); // 启动 dispatch 不 abort
    await micro();
    expect(loops.errors).toHaveLength(1); // 坏槽逐槽 catch 记 error
    expect(exec.calls.map((c) => c.command)).toEqual(["good-check"]); // 好槽照常首探
    loops.stop();
  });

  it("D12：慢 checker 快间隔——在飞不重排，10s 窗口内该槽至多 1 pending（不堆 100 job）", async () => {
    const store = createMemoryStore();
    store.putEntity({ type: REF.type, key: REF.key, state: null });
    const clock = new FakeClock();
    const exec = new DeferredExec();
    const loops = startLoops(makeCtx(store, { clock, exec: exec as unknown as FakeExec }));
    subVia(loops, {}, { opts: { schedule: { type: "interval", intervalMs: 100 } } });
    clock.step(0);
    expect(exec.calls).toHaveLength(1); // 首探 dispatch（在飞）
    clock.step(9_999); // 100ms × ~100 tick 窗口；在飞 guard 全跳过（9_999 < 10s 探针超时，不触超时回流）
    expect(exec.calls).toHaveLength(1);
    exec.resolve(0, { exitCode: 2 });
    await micro();
    clock.step(0); // 完成回流后 nextDueAt 已过 → 补探恰一次
    expect(exec.calls).toHaveLength(2);
    loops.stop();
  });

  it("D13：重启不恢复 nextDueAt——活跃槽启动即重探（R1 A5 归零重探），refcount 0 槽不探", async () => {
    const store = createMemoryStore();
    store.putEntity({ type: REF.type, key: REF.key, state: null });
    store.putProbeSpec({ slotKey: SLOT_KEY, check: "active-check", schedule: { type: "interval", intervalMs: 60_000 }, source: "poll" });
    store.putRunLedger({ slotKey: SLOT_KEY, epoch: 0, refcount: 1, consecutiveFails: 0, nextDueAt: 3_600_000, entityRefType: REF.type, entityRefKey: REF.key });
    store.putSubscription({ subscriptionId: "sub-seed", sessionId: "session-1", entityRefType: REF.type, entityRefKey: REF.key, template: TPL, check: "active-check", origin: "session", createdAt: 0 });
    const IDLE = `slot:${REF.type}:${REF.key}-idle#${TPL}`;
    store.putProbeSpec({ slotKey: IDLE, check: "idle-check", schedule: { type: "interval", intervalMs: 60_000 }, source: "poll" });
    store.putRunLedger({ slotKey: IDLE, epoch: 0, refcount: 0, consecutiveFails: 0, nextDueAt: 3_600_000 });
    const exec = new FakeExec();
    exec.enqueue({ exitCode: 2 });
    const loops = startLoops(makeCtx(store, { exec })); // 不 step：启动 dispatch 立即重探
    expect(exec.calls.map((c) => c.command)).toEqual(["active-check"]);
    expect(store.getRunLedger(SLOT_KEY)?.nextDueAt).toBe(60_000); // 清零后按 spec 重算
    loops.stop();
  });
});

describe("评审修复 — D 组补充：同步完成不残留 in-flight 标记", () => {
  it("D12：首探同步失败（exec 同步抛错）后到点仍重探——in-flight 标记先置后清，槽不被永久卡死", async () => {
    const store = createMemoryStore();
    store.putEntity({ type: REF.type, key: REF.key, state: null });
    const clock = new FakeClock();
    const exec = new FakeExec();
    exec.enqueueFailure(new Error("sync-boom"), true); // 首探同步完成（回流先于 dispatch 的标记置位）
    const loops = startLoops(makeCtx(store, { clock, exec }));
    subVia(loops, {}, { opts: { schedule: { type: "interval", intervalMs: 60_000 } } });
    clock.step(0);
    await micro();
    expect(exec.calls).toHaveLength(1);
    exec.enqueue({ exitCode: 2 });
    clock.step(60_000); // 到点重探：标记残留时该槽永久跳过（L1 死槽）
    await micro();
    expect(exec.calls).toHaveLength(2);
    loops.stop();
  });
});

// ==================== 评审修复 — E 组（loops 面）：启动 dispatch TDZ ====================
describe("评审修复 — E 组（loops 面）", () => {
  it("E14：启动 dispatch 即同步完成（exec 同步抛错）→ completion 不丢（doSubmit 先于启动 dispatch 定义）", async () => {
    const store = createMemoryStore();
    store.putEntity({ type: REF.type, key: REF.key, state: null });
    store.putProbeSpec({ slotKey: SLOT_KEY, check: "fixture-check", schedule: { type: "interval", intervalMs: 60_000 }, source: "poll" });
    store.putRunLedger({ slotKey: SLOT_KEY, epoch: 0, refcount: 1, consecutiveFails: 0, entityRefType: REF.type, entityRefKey: REF.key });
    store.putSubscription({ subscriptionId: "sub-seed", sessionId: "session-1", entityRefType: REF.type, entityRefKey: REF.key, template: TPL, check: "fixture-check", origin: "session", createdAt: 0 });
    const exec = new FakeExec();
    exec.enqueueFailure(new Error("sync-boom"), true); // 同步抛错 → 启动 dispatch 窗口内同步回流
    const loops = startLoops(makeCtx(store, { exec }));
    await micro();
    expect(loops.errors).toHaveLength(0); // 无 TDZ ReferenceError（也未静默吞进 prober.deliver）
    expect(store.getRunLedger(SLOT_KEY)?.lastVerdict).toBe("waiting"); // verdict 已应用（未修时 completion 丢失）
    loops.stop();
  });
});

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
  it("单次 outboxBatch 读异常 → 记 errors 后照常重排；24h 扫描通道同 tick 照跑、后续 tick 无重复异常", async () => {
    const base = createMemoryStore();
    base.putEntity({ type: REF.type, key: REF.key, state: null });
    seedSub(base);
    let failOutbox = 0;
    const store: Store = Object.create(base);
    store.outboxBatch = (limit) => {
      if (failOutbox > 0) {
        failOutbox -= 1;
        throw new Error("read down");
      }
      return base.outboxBatch(limit);
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

// =============================================================================
// 票 40 评审 F1 — register 经 L0（LoopsHandle 变更面收窄）
// =============================================================================

describe("票 40 评审 F1 — register 经 L0 submit（变更类只经单一写路径）", () => {
  it("submit kind register：簿记落库 + firstTransition 同事务；stopped 后 submit 结算拒绝", async () => {
    const store = createMemoryStore();
    const loops = startLoops(makeCtx(store));
    const outcome = await loops.submit({
      kind: "register",
      req: { entityRef: REF, profileId: "p", firstTransition: { to: "waiting", occurredAt: at(1) } },
    });
    expect(outcome).toMatchObject({ ok: true, value: { created: true, event: { to: "waiting" } } });
    expect(store.getEntity(REF.type, REF.key)).toMatchObject({ profileId: "p", state: "waiting" });

    loops.stop();
    // stopped 后 submit 同步抛（submit 契约：stopped 后抛错；在途请求结算 {ok:false}）
    expect(() =>
      loops.submit({ kind: "register", req: { entityRef: { type: "fixture:widget", key: "external/x" }, profileId: "p" } }),
    ).toThrow(/loops stopped/);
  });

  it("handle.kernel 收窄：直调面只余读方法 query/evidence（变更类不暴露；票 42 templates/validate 迁 profiles 静态面）", () => {
    const store = createMemoryStore();
    const loops = startLoops(makeCtx(store));
    expect("register" in loops.kernel).toBe(false);
    expect("transition" in loops.kernel).toBe(false);
    for (const m of ["query", "evidence"] as const) {
      expect(typeof loops.kernel[m]).toBe("function");
    }
    loops.stop();
  });
});

// ==================== 终审修复批 1（2026-10-18 用户五项裁定落地） ====================

describe("终审修复② — L4 ephemeral retired 标记经 kernel.unregister（L0 唯一写路径）", () => {
  it("ephemeral 终态实体：扫后 retired 标记（写路径归 kernel，经 L0）；7d 到期同扫清理实体与派生残留", () => {
    const store = createMemoryStore();
    store.putEntity({ type: REF.type, key: REF.key, state: "passed", profileId: "p-eph", payload: { snap: 1 } });
    // 到期锚 = 终态转换事件 occurredAt；锚 0（epoch 原点）+ clock 推进 8d > 7d 保留窗 → 到期
    store.appendEventIfMissing({
      eventId: NID(1), eventSeq: 1, entityRefType: REF.type, entityRefKey: REF.key,
      from: "failed", to: "passed", occurredAt: new Date(0).toISOString(),
    });
    store.putOutbox({ notificationId: NID(1), eventSeq: 1 });
    store.putNotification({ notificationId: NID(1), eventSeq: 1, billboardJson: "{}" });
    const clock = new FakeClock();
    const loops = startLoops(makeCtx(store, {
      clock,
      housekeeping: { ephemeral: { profileIds: new Set(["p-eph"]), terminalStates: new Set(["passed"]) } },
    }));
    clock.step(0); // 启动惰性首扫：标记 + 8d 未到只标记
    expect(store.getEntity(REF.type, REF.key)).toMatchObject({ retired: true, payload: { snap: 1 } }); // 快照字段不动
    expect(store.getEntity(REF.type, REF.key)?.state).toBe("passed");
    clock.step(8 * 86_400_000); // 7d 保留窗到期：同扫清理（deleteEventsBefore + deleteEntity）
    expect(store.getEntity(REF.type, REF.key)).toBeUndefined();
    expect(store.notifications({})).toHaveLength(0); // 派生投递残留（billboard 物化行）清零
    expect(store.tx((tx) => tx.getEvent(NID(1)))).toBeDefined(); // events 本体不删（D2 append-only 正典）
    expect(store.outboxBatch(10)).toHaveLength(1); // outbox 行永久（decisionOrder 恢复真相源）
    loops.stop();
  });
});

describe("终审修复⑥ — C2 on-transition 编排（transition 消费成功后查 profile 规则 → 经 L0 执行 subscribe/close）", () => {
  const ORCH_RULES = [{ on: "passed", action: "close" }] as const;
  const orchRegistry = (rules: ReadonlyArray<{ on: string | string[]; action: string; params?: Record<string, unknown> }>) => [
    { profileId: "p-orch", templates: [], onTransition: rules },
  ];

  it("fixture profile onTransition {on:passed, action:close}：transition passed 后该实体开放订阅自动关闭（非 once——不走 onVerdict 关闭面）", () => {
    const store = createMemoryStore();
    store.putEntity({ type: REF.type, key: REF.key, state: "waiting", profileId: "p-orch" });
    const loops = startLoops(makeCtx(store, { registry: orchRegistry(ORCH_RULES as unknown as Parameters<typeof orchRegistry>[0]) }));
    subVia(loops);
    expect(store.querySubscriptions({})[0].closedAt).toBeUndefined();
    loops.submit({ kind: "transition", ref: REF, verdict: "passed", occurredAt: at(1) });
    const sub = store.querySubscriptions({})[0];
    expect(sub.closedAt).toBeDefined();
    expect(sub.closedReason).toBe("cancelled"); // 编排关闭 = op 侧语义（封闭集 reason）
    expect(loops.errors).toHaveLength(0);
    loops.stop();
  });

  it("probe passed 翻转同链生效（US-13 自动链 stub 全链）：probeVerdict 翻转沿转换后订阅自动关闭；waiting 中性不触发", () => {
    const store = createMemoryStore();
    store.putEntity({ type: REF.type, key: REF.key, state: "waiting", profileId: "p-orch" });
    const loops = startLoops(makeCtx(store, { registry: orchRegistry(ORCH_RULES as unknown as Parameters<typeof orchRegistry>[0]) }));
    subVia(loops, {}, { opts: { schedule: { type: "interval", intervalMs: 60_000 } } });
    loops.ingestProbeResult({ slotKey: SLOT_KEY, verdict: "waiting", reason: "exit 1", evidence: "", durationMs: 1 });
    expect(store.querySubscriptions({})[0].closedAt).toBeUndefined(); // waiting 中性：无转换无编排
    loops.ingestProbeResult({ slotKey: SLOT_KEY, verdict: "passed", reason: "exit 0", evidence: "", durationMs: 1 });
    const sub = store.querySubscriptions({})[0];
    expect(sub.closedAt).toBeDefined();
    expect(sub.closedReason).toBe("cancelled");
    loops.stop();
  });

  it("action:subscribe 经 params 编排新订阅（origin auto）；参数缺失记 errors 不死队列；无规则 profile 不受影响", () => {
    const store = createMemoryStore();
    store.putEntity({ type: REF.type, key: REF.key, state: "waiting", profileId: "p-orch" });
    const loops = startLoops(makeCtx(store, {
      registry: orchRegistry([
        { on: "failed", action: "subscribe", params: { sessionId: "s-orch", template: TPL, check: "orch-check" } },
        { on: "passed", action: "close" },
      ]),
    }));
    subVia(loops); // session-1 的订阅：passed 时被编排关闭，failed 时新增编排订阅
    loops.submit({ kind: "transition", ref: REF, verdict: "failed", occurredAt: at(1) });
    const open = store.querySubscriptions({}).filter((s) => s.closedAt === undefined);
    expect(open).toHaveLength(2);
    const orch = open.find((s) => s.sessionId === "s-orch");
    expect(orch).toMatchObject({ check: "orch-check", origin: "auto", template: TPL });
    loops.submit({ kind: "transition", ref: REF, verdict: "passed", occurredAt: at(2) });
    // 编排 close 关的是该实体全部开放订阅（含编排自产的 auto 订阅——同实体规则集一致语义）
    expect(store.querySubscriptions({}).every((s) => s.closedAt !== undefined)).toBe(true);
    loops.stop();
  });

  it("防递归：编排只产 subscribe/cancel 请求，两者 apply 不再查 onTransition（结构不可达）；未知 action 记 errors 跳过", () => {
    const store = createMemoryStore();
    store.putEntity({ type: REF.type, key: REF.key, state: "waiting", profileId: "p-orch" });
    const loops = startLoops(makeCtx(store, {
      registry: orchRegistry([{ on: ["passed", "failed"], action: "explode" }]),
    }));
    loops.submit({ kind: "transition", ref: REF, verdict: "passed", occurredAt: at(1) });
    expect(loops.errors).toHaveLength(1); // 未知 action 不死队列，规则跳过
    expect(loops.errors[0]).toBeInstanceOf(Error);
    loops.stop();
  });
});
