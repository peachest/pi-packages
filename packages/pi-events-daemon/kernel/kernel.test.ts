/**
 * Ticket 10 acceptance tests — kernel.transition 唯一写路径 + Intent 串行消费（链 B 核心）。
 * B 层：Store 内存 fake（createMemoryStore）注入，domain 纯函数直接 import（票面指定结构）。
 *
 * 试金石前置（I-01 / ADR 0005）：本测试集不含任何具体 profile 名——状态集与实体名
 * 全部是 fixture 数据经构造注入；新增 profile 零 kernel 改动。
 */
import { describe, it, expect } from "vitest";
import { createMemoryStore } from "../store/index.ts";
import { FIRST_SEQUENCE, planTransition, deterministicEventId } from "../domain/intent.ts";
import { Kernel } from "./index.ts";

// --- fixture（数据，非 profile）---
const REF = { type: "fixture:widget", key: "external/fixture-1" };
const VERDICT_STATES = new Set(["passed", "failed", "waiting"]);
const RENAME_STATES = new Set(["alpha", "beta"]);
const at = (n: number) => `2026-01-01T00:00:${String(n).padStart(2, "0")}Z`;

type MemStore = ReturnType<typeof createMemoryStore>;

const seedEntity = (store: MemStore, state: string | null, extra: Record<string, unknown> = {}) =>
  store.putEntity({ type: REF.type, key: REF.key, state, ...extra });

/** 状态一致性快照：实体归约态 + outbox 双轨尾迹（outbox 行与 transition 1:1，I1 组合面）。 */
const snapshot = (store: MemStore) => ({
  entities: store
    .queryEntities({})
    .map((e) => [e.type, e.key, e.state, e.payload ?? null])
    .sort(),
  trail: store
    .outboxBatch(Number.MAX_SAFE_INTEGER)
    .map((r) => [r.eventSeq, r.notificationId] as const)
    .sort((a, b) => a[0] - b[0]),
});

/** 构造 N 个 intent（域侧正典构造路径 planTransition；from/to 沿实体链推进）。 */
function planChain(n: number) {
  let seq = FIRST_SEQUENCE;
  const intents = [];
  const chain = ["failed", "waiting", "failed", "passed", "failed"];
  let from: string | null = null;
  for (let i = 0; i < n; i++) {
    const planned = planTransition(seq, { entityRef: REF, from, to: chain[i], occurredAt: at(i + 1) });
    intents.push(planned.intent);
    seq = planned.sequences;
    from = chain[i];
  }
  return intents;
}

describe("组 1：kernel.transition 唯一写路径——校验（domain）→ 事务（Store.tx）→ Intent 串行消费", () => {
  it("纯链提交：planTransition 双轨分配 → tx 内 appendEventIfMissing → {eventSeq, from, to}", () => {
    const store = createMemoryStore();
    seedEntity(store, "passed");
    const kernel = new Kernel(store, VERDICT_STATES, 0);
    expect(kernel.transition(REF, "failed", at(1))).toEqual({ eventSeq: 1, from: "passed", to: "failed" });
    expect(store.getEntity(REF.type, REF.key)?.state).toBe("failed");
    expect(store.tx((tx) => tx.getEvent(deterministicEventId(REF, 1)))).toMatchObject({
      eventSeq: 1,
      entityRefType: REF.type,
      entityRefKey: REF.key,
      from: "passed",
      to: "failed",
      occurredAt: at(1),
    });
    // I1 组合面：outbox 行与事件同事务 1:1（notificationId = 确定性 event id）
    expect(store.outboxBatch(10)).toEqual([{ notificationId: deterministicEventId(REF, 1), eventSeq: 1 }]);
  });

  it("双轨游标连续：第二次 transition decisionOrder/eventSeq 接续不重号", () => {
    const store = createMemoryStore();
    seedEntity(store, "passed");
    const kernel = new Kernel(store, VERDICT_STATES, 0);
    expect(kernel.transition(REF, "failed", at(1))).toMatchObject({ eventSeq: 1 });
    expect(kernel.transition(REF, "waiting", at(2))).toEqual({ eventSeq: 2, from: "failed", to: "waiting" });
    expect(store.tx((tx) => tx.getEvent(deterministicEventId(REF, 2)))).toMatchObject({ eventSeq: 2, to: "waiting" });
  });

  it("edge-trigger：同态 verdict 无转换无事件（ADR 0003：(state, identity) 对未变）", () => {
    const store = createMemoryStore();
    seedEntity(store, "failed");
    const kernel = new Kernel(store, VERDICT_STATES, 0);
    expect(kernel.transition(REF, "failed", at(1))).toBeNull();
    expect(store.outboxBatch(10)).toHaveLength(0);
    expect(store.getEntity(REF.type, REF.key)?.state).toBe("failed");
  });

  it("首转换 from=null 合法（无 unprobed 前置态）", () => {
    const store = createMemoryStore();
    seedEntity(store, null);
    const kernel = new Kernel(store, VERDICT_STATES, 0);
    expect(kernel.transition(REF, "passed", at(1))).toEqual({ eventSeq: 1, from: null, to: "passed" });
  });

  it("I3 封闭集执法：verdict 不在注入状态集 → 同步拒绝（明确错误，非 waiting）", () => {
    const store = createMemoryStore();
    seedEntity(store, null);
    const kernel = new Kernel(store, new Set(["passed", "failed"]), 0);
    expect(() => kernel.transition(REF, "waiting", at(1))).toThrow(/outside profile closed set/);
    expect(store.outboxBatch(10)).toHaveLength(0);
  });

  it("retired 拒 transition（不复活）；未知实体拒绝", () => {
    const store = createMemoryStore();
    seedEntity(store, "passed", { retired: true });
    const kernel = new Kernel(store, VERDICT_STATES, 0);
    expect(() => kernel.transition(REF, "failed", at(1))).toThrow(/retired/);

    const empty = createMemoryStore();
    const orphan = new Kernel(empty, VERDICT_STATES, 0);
    expect(() => orphan.transition(REF, "failed", at(1))).toThrow(/unknown entity/);
  });
});
