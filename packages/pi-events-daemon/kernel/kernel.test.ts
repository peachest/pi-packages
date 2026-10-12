/**
 * Ticket 10 acceptance tests — kernel.transition 唯一写路径 + Intent 串行消费（链 B 核心）。
 * B 层：Store 内存 fake（createMemoryStore）注入，domain 纯函数直接 import（票面指定结构）。
 *
 * 试金石前置（I-01 / ADR 0005）：本测试集不含任何具体 profile 名——状态集与实体名
 * 全部是 fixture 数据经构造注入；新增 profile 零 kernel 改动。
 */
import { describe, it, expect } from "vitest";
import { createMemoryStore, type Store, type TxView } from "../store/index.ts";
import { FIRST_SEQUENCE, planTransition, deterministicEventId } from "../domain/intent.ts";
import { IntentCorruption, Kernel } from "./index.ts";

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

describe("组 3：B7 状态改名 = 显式迁移 TransitionEvent（唯一写路径，禁原地改名）", () => {
  it("迁移事件同族：from 旧名 → to 新名，经唯一写路径（确定性 event id + outbox 1:1）", () => {
    const store = createMemoryStore();
    seedEntity(store, "alpha");
    const kernel = new Kernel(store, RENAME_STATES, 0);
    expect(kernel.migrateState(REF, { from: "alpha", to: "beta" }, at(1))).toEqual({
      eventSeq: 1,
      from: "alpha",
      to: "beta",
    });
    expect(store.getEntity(REF.type, REF.key)?.state).toBe("beta");
    expect(store.outboxBatch(10)).toEqual([{ notificationId: deterministicEventId(REF, 1), eventSeq: 1 }]);
  });

  it("实体不在旧名态 → null（幂等不产第二事件，零残留）", () => {
    const store = createMemoryStore();
    seedEntity(store, "beta"); // 已在新名态
    const kernel = new Kernel(store, RENAME_STATES, 0);
    expect(kernel.migrateState(REF, { from: "alpha", to: "beta" }, at(1))).toBeNull();
    expect(store.outboxBatch(10)).toHaveLength(0);
  });

  it("新名不在封闭集 → I3 同步拒绝；迁移瞬时故障耗尽 → dead-letter + I1 零残留", () => {
    const store = createMemoryStore();
    seedEntity(store, "alpha");
    const kernel = new Kernel(store, RENAME_STATES, 0);
    expect(() => kernel.migrateState(REF, { from: "alpha", to: "gamma" }, at(1))).toThrow(
      /outside profile closed set/,
    );
    // 持久故障（重试不可恢复）→ 耗尽 3 次总尝试 → dead-letter；一次性 X1 停点会被重试吸收
    const down: Store = Object.assign(Object.create(store), {
      tx: () => {
        throw new Error("store unavailable");
      },
    });
    const broken = new Kernel(down, RENAME_STATES, 0);
    expect(() => broken.migrateState(REF, { from: "alpha", to: "beta" }, at(2))).toThrow(/dead-letter/);
    expect(store.getEntity(REF.type, REF.key)?.state).toBe("alpha");
    expect(store.outboxBatch(10)).toHaveLength(0);
  });
});

describe("组 2：Intent 串行消费——崩溃重放一致（顺序约束）+ 有界重试 + corruption", () => {
  it("顺序约束：N intent → 中断 → 全量重放 → 状态一致（不重新编号）", () => {
    const intents = planChain(4);

    // 基线：干净串行消费 4 个 intent
    const clean = createMemoryStore();
    seedEntity(clean, null);
    const cleanKernel = new Kernel(clean, VERDICT_STATES, 0);
    for (const intent of intents) cleanKernel.consumeIntent(intent);
    const expected = snapshot(clean);
    expect(expected.entities).toEqual([[REF.type, REF.key, "passed", null]]);
    expect(expected.trail).toHaveLength(4);

    // 崩溃场景：消费 2 个后进程停止（中断点状态可断言），重启后全量重放
    const crashed = createMemoryStore();
    seedEntity(crashed, null);
    const preCrash = new Kernel(crashed, VERDICT_STATES, 0);
    preCrash.consumeIntent(intents[0]);
    preCrash.consumeIntent(intents[1]);
    expect(crashed.getEntity(REF.type, REF.key)?.state).toBe("waiting"); // 中断点状态
    // —— 崩溃线 ——
    // 恢复：新 Kernel 实例（重启），decisionOrder=mutation line 尾（4），eventSeq 由 kernel 从事件流尾自恢复；
    // 重放首条再遇一次瞬断（一次性 X1 停点）——有界重试吸收，幂等收口
    const replayKernel = new Kernel(crashed, VERDICT_STATES, 4);
    crashed.injectCrash("tx");
    for (const intent of intents) replayKernel.consumeIntent(intent); // 全量重放：同 id 跳过 / 未达序追加
    expect(snapshot(crashed)).toEqual(expected);

    // 重放后新 transition 续接双轨尾（4 之后 = 5），不重新编号
    expect(replayKernel.transition(REF, "failed", at(9))).toEqual({ eventSeq: 5, from: "passed", to: "failed" });
    expect(crashed.tx((tx) => tx.getEvent(deterministicEventId(REF, 5)))).toMatchObject({
      eventSeq: 5,
      from: "passed",
      to: "failed",
    });
  });

  it("消费失败重试 3 次越界 → dead-letter 语义抛出 + I1 零残留", () => {
    const store = createMemoryStore();
    seedEntity(store, "passed");
    // 持久故障（重试不可恢复）→ 耗尽 3 次总尝试；一次性 X1 停点会被重试吸收（见界内恢复用例）
    const down: Store = Object.assign(Object.create(store), {
      tx: () => {
        throw new Error("store unavailable");
      },
    });
    const kernel = new Kernel(down, VERDICT_STATES, 0);
    expect(() => kernel.transition(REF, "failed", at(1))).toThrow(/dead-letter/);
    expect(() => kernel.transition(REF, "failed", at(1))).toThrow(/3 consume attempts/);
    expect(store.getEntity(REF.type, REF.key)?.state).toBe("passed");
    expect(store.outboxBatch(10)).toHaveLength(0);
  });

  it("重试界内恢复：第 3 次尝试成功且决策序未被失败烧掉", () => {
    const store = createMemoryStore();
    seedEntity(store, "passed");
    const kernel = new Kernel(store, VERDICT_STATES, 0);
    store.injectCrash("tx");
    store.injectCrash("tx");
    expect(kernel.transition(REF, "failed", at(1))).toEqual({ eventSeq: 1, from: "passed", to: "failed" });
    expect(store.tx((tx) => tx.getEvent(deterministicEventId(REF, 1)))).toBeTruthy(); // 同 decisionOrder=1，未重排
  });

  it("appendIfMissing 双分支经 kernel：同 id 同内容 skipped（零写入）/ 异内容 corruption", () => {
    const store = createMemoryStore();
    seedEntity(store, null);
    const kernel = new Kernel(store, VERDICT_STATES, 0);
    const intents = planChain(2);
    kernel.consumeIntent(intents[0]);
    kernel.consumeIntent(intents[1]);
    const before = snapshot(store);

    expect(kernel.consumeIntent(intents[1])).toEqual({ kind: "skipped" });
    expect(snapshot(store)).toEqual(before);

    const forged = { ...intents[1], to: intents[1].to === "failed" ? "waiting" : "failed" }; // 同 id 异内容
    expect(() => kernel.consumeIntent(forged)).toThrow(IntentCorruption);
    expect(snapshot(store)).toEqual(before); // corruption 零残留
  });
});

describe("组 4：评审修复回归——提交成功后推进游标（F1）/ 重放豁免封闭集（F2）/ from 态封闭集执法（F3）", () => {
  it("F1 回调完成、提交失败：重试重排同序 → 同 eventId 幂等收口，游标不烧号", () => {
    const store = createMemoryStore();
    seedEntity(store, "passed");
    // 提交失败模型：失败尝试的回调对真实库读、写全部丢弃（= 提交阶段失败回滚），回调返回后包装层抛错；
    // 游标若在回调内推进（旧 bug），重试即用已烧序号重排 → 换 eventId
    let failuresLeft = 1;
    const discardTx = (t: TxView): TxView => ({
      ...t,
      putEvent: () => {},
      putEntity: () => {},
      putSubscription: () => {},
      putDelivery: () => {},
      putProbeSpec: () => {},
      putNotification: () => {},
      putEvidence: () => {},
      putOutbox: () => {},
      putRunLedger: () => {},
    });
    const flaky: Store = Object.assign(Object.create(store), {
      tx: <T,>(fn: (tx: TxView) => T): T => {
        if (failuresLeft-- > 0) {
          store.tx((t) => fn(discardTx(t))); // 回调完整执行，提交失败 = 写丢弃
          throw new Error("commit failed after callback completed");
        }
        return store.tx(fn); // 重试成功路径：真实提交
      },
    });
    const kernel = new Kernel(flaky, VERDICT_STATES, 0);
    expect(kernel.transition(REF, "failed", at(1))).toEqual({ eventSeq: 1, from: "passed", to: "failed" });
    // 同 eventId 单事件 + outbox 1:1：重试没有用推进后的序号重排出新事件
    expect(store.tx((tx) => tx.getEvent(deterministicEventId(REF, 1)))).toMatchObject({ eventSeq: 1, to: "failed" });
    expect(store.outboxBatch(10)).toEqual([{ notificationId: deterministicEventId(REF, 1), eventSeq: 1 }]);
    // 游标未被失败烧掉：下一 transition 续接 seq 2
    expect(kernel.transition(REF, "waiting", at(2))).toEqual({ eventSeq: 2, from: "failed", to: "waiting" });
  });

  it("F2 改名后重放历史事件：skipped 豁免封闭集校验；迁移事件重放 + 新追加仍执法", () => {
    const store = createMemoryStore();
    seedEntity(store, null);
    // 历史：alpha 态事件 + alpha→beta 显式迁移（旧状态集 {alpha, beta}）；
    // to=alpha 经 intent 消费面构造（Transitioned.to 是普通 string，非 Verdict 联合）
    const replay = (seq: number, from: string | null, to: string, when: string) =>
      // planTransition 自增：传序前值，产出 decisionOrder/eventSeq = seq 的同 id intent
      planTransition({ decisionOrder: seq - 1, eventSeq: seq - 1 }, { entityRef: REF, from, to, occurredAt: when }).intent;
    const oldKernel = new Kernel(store, new Set(["alpha", "beta"]), 0);
    oldKernel.consumeIntent(replay(1, null, "alpha", at(1)));
    oldKernel.migrateState(REF, { from: "alpha", to: "beta" }, at(2));
    // profile 改名生效：新状态集只含 beta（alpha 移除），重启恢复后全量重放历史 intent
    const restored = new Kernel(store, new Set(["beta"]), 2);
    expect(restored.consumeIntent(replay(1, null, "alpha", at(1)))).toEqual({ kind: "skipped" }); // 修复前：抛 outside closed set
    expect(restored.consumeIntent(replay(2, "alpha", "beta", at(2)))).toEqual({ kind: "skipped" }); // 迁移事件重放
    expect(store.outboxBatch(10)).toHaveLength(2); // 重放零新写入
    // 新追加仍受封闭集执法（重放豁免不等于全面豁免）
    expect(() => restored.consumeIntent(replay(3, "beta", "alpha", at(3)))).toThrow(/outside profile closed set/);
  });
});
