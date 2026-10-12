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
import { startLoops, type LoopsCtx } from "./index.ts";

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
