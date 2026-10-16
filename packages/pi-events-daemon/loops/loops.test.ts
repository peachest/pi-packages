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
import { FakeClock, FakeExec, FakeFs, FakePusher } from "../fx/index.ts";
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

    expect(clock.pendingCount).toBe(0); // 骨架不排定时器；L1-L4 兜底扫随后续票挂入
    loops.submit({ kind: "transition", ref: REF, verdict: "failed", occurredAt: at(1) });
    clock.step(60_000); // 推演安全：无定时器可触发，零副作用
    expect(clock.pendingCount).toBe(0);
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
