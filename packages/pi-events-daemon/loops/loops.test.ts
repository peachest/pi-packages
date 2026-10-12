/**
 * Ticket 25 acceptance tests — L0 Mutation 唯一写者 + startLoops 骨架（loops 链起点）。
 * A 层：fx 全注入（FakeClock/FakeExec/FakePusher/FakeFs + MemoryStore），确定性推演。
 *
 * 断言组：
 *  1. L0 串行顺序（N 请求 → 提交序 = 消费序；重入提交 FIFO 续排）
 *  （组 2/3 随后续 commit：缓存只在提交回调更新 / startLoops 假注入启动 + 双轨重启恢复）
 */
import { describe, it, expect } from "vitest";
import { createMemoryStore, type Store } from "../store/index.ts";
import { FakeClock, FakeExec, FakeFs, FakePusher } from "../fx/index.ts";
import { deterministicEventId } from "../domain/intent.ts";
import { startLoops, type LoopsCtx } from "./index.ts";

// --- fixture（数据，非 profile；kernel.test.ts 同法）---
const REF = { type: "fixture:widget", key: "external/fixture-1" };
const STATES = new Set(["passed", "failed", "waiting"]);
const at = (n: number) => `2026-01-01T00:00:${String(n).padStart(2, "0")}Z`;

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
