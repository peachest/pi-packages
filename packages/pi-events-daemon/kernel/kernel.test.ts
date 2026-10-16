/**
 * Ticket 10 acceptance tests — kernel.transition 唯一写路径 + Intent 串行消费（链 B 核心）。
 * B 层：Store 内存 fake（createMemoryStore）注入，domain 纯函数直接 import（票面指定结构）。
 *
 * 试金石前置（I-01 / ADR 0005）：本测试集不含任何具体 profile 名——状态集与实体名
 * 全部是 fixture 数据经构造注入；新增 profile 零 kernel 改动。
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryStore, type Store, type TxView } from "../store/index.ts";
import { SqliteStore } from "../store/sqlite.ts";
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
    expect(kernel.transition(REF, "failed", at(1))).toMatchObject({ eventSeq: 1, from: "passed", to: "failed" });
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
    expect(kernel.transition(REF, "waiting", at(2))).toMatchObject({ eventSeq: 2, from: "failed", to: "waiting" });
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
    expect(kernel.transition(REF, "passed", at(1))).toMatchObject({ eventSeq: 1, from: null, to: "passed" });
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
    expect(kernel.migrateState(REF, { from: "alpha", to: "beta" }, at(1))).toMatchObject({
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
    expect(replayKernel.transition(REF, "failed", at(9))).toMatchObject({ eventSeq: 5, from: "passed", to: "failed" });
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
    expect(kernel.transition(REF, "failed", at(1))).toMatchObject({ eventSeq: 1, from: "passed", to: "failed" });
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
    expect(kernel.transition(REF, "failed", at(1))).toMatchObject({ eventSeq: 1, from: "passed", to: "failed" });
    // 同 eventId 单事件 + outbox 1:1：重试没有用推进后的序号重排出新事件
    expect(store.tx((tx) => tx.getEvent(deterministicEventId(REF, 1)))).toMatchObject({ eventSeq: 1, to: "failed" });
    expect(store.outboxBatch(10)).toEqual([{ notificationId: deterministicEventId(REF, 1), eventSeq: 1 }]);
    // 游标未被失败烧掉：下一 transition 续接 seq 2
    expect(kernel.transition(REF, "waiting", at(2))).toMatchObject({ eventSeq: 2, from: "failed", to: "waiting" });
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

  it("F3 实体滞留已删除旧态：transition 拒绝（from 执法，null 首转换豁免）；migrateState 显式迁移放行", () => {
    const store = createMemoryStore();
    seedEntity(store, "waiting"); // 持久化实体处于改名前旧态
    // profile 收缩：旧态 waiting 已移除，新状态集只含 {passed, failed}
    const postRename = new Kernel(store, new Set(["passed", "failed"]), 0);
    // 修复前：普通 transition 直写 from=waiting 的事件，绕过显式迁移入口
    expect(() => postRename.transition(REF, "failed", at(1))).toThrow(/outside profile closed set/);
    expect(store.outboxBatch(10)).toHaveLength(0);
    // 显式迁移是唯一出口（from 为历史名，不校验封闭集）
    expect(postRename.migrateState(REF, { from: "waiting", to: "passed" }, at(1))).toMatchObject({
      eventSeq: 1,
      from: "waiting",
      to: "passed",
    });
    expect(store.getEntity(REF.type, REF.key)?.state).toBe("passed");
    // 迁移后普通 transition 恢复
    expect(postRename.transition(REF, "failed", at(2))).toMatchObject({ eventSeq: 2, from: "passed", to: "failed" });
  });
});

// ==================== 票 11：fanOut 编址 + query/evidence/validate/templates/drain ====================
// B 层（链 B 里程碑）：Store 内存 fake 注入 + fake registry（静态面数据，I-01）。零具体 profile 名。

import type { SubscriptionRow } from "../store/index.ts";

const TPL = "fixture-tpl";
const EVT1 = deterministicEventId(REF, 1);
const sess = (id: string, scope: "project" | "user" = "project") => ({ sessionId: id, scope });
const sub = (over: Partial<SubscriptionRow>): SubscriptionRow => ({
  subscriptionId: "sub-x",
  sessionId: "session-x",
  entityRefType: REF.type,
  entityRefKey: REF.key,
  template: TPL,
  origin: "session",
  scope: "project",
  createdAt: 1,
  ...over,
});

/** fanOut 前置：实体 + 一次 transition（outbox 行即 fanOut 输入，I1 1:1）。 */
function seedTransitioned(store: MemStore, kernel: Kernel) {
  seedEntity(store, "passed");
  const r = kernel.transition(REF, "failed", at(1));
  if (!r) throw new Error("fixture: transition produced no event");
  return r;
}

describe("票 11 组 1：fanOut origin 编址三分支（#31 正典）", () => {
  it("origin=session 在线 → pending 直投行（写前持久化，I10/I12 载体）", () => {
    const store = createMemoryStore();
    const kernel = new Kernel(store, VERDICT_STATES, 0, { ownerEpoch: 7 });
    seedTransitioned(store, kernel);
    store.putSubscription(sub({ subscriptionId: "sub-a", sessionId: "session-a" }));
    const res = kernel.fanOut(EVT1, { activeSessions: [sess("session-a")] });
    expect(res).toEqual({ notificationId: EVT1, eventSeq: 1, delivered: ["session-a"], parked: [] });
    expect(store.getDelivery(EVT1, "session-a")).toEqual({
      notificationId: EVT1,
      sessionId: "session-a",
      state: "pending",
      recordEpoch: 7,
    });
  });

  it("origin=session 离线 → parked（E1：session-closed，只等 drain）", () => {
    const store = createMemoryStore();
    const kernel = new Kernel(store, VERDICT_STATES, 0);
    seedTransitioned(store, kernel);
    store.putSubscription(sub({ subscriptionId: "sub-a", sessionId: "session-a" }));
    const res = kernel.fanOut(EVT1, { activeSessions: [sess("other")] });
    expect(res).toEqual({ notificationId: EVT1, eventSeq: 1, delivered: [], parked: ["session-a"] });
    expect(store.getDelivery(EVT1, "session-a")?.state).toBe("parked");
  });

  it("origin=auto → scope 内活跃 session 直投，离线不发（不留行）；他 scope 不中", () => {
    const store = createMemoryStore();
    const kernel = new Kernel(store, VERDICT_STATES, 0);
    seedTransitioned(store, kernel);
    store.putSubscription(sub({ subscriptionId: "sub-auto", sessionId: "irrelevant", origin: "auto", scope: "project" }));
    const res = kernel.fanOut(EVT1, {
      activeSessions: [sess("proj-1"), sess("proj-2"), sess("user-1", "user")],
    });
    expect(res.delivered.sort()).toEqual(["proj-1", "proj-2"]);
    expect(res.parked).toEqual([]);
    expect(store.pendingDeliveries({}).map((d) => d.sessionId).sort()).toEqual(["proj-1", "proj-2"]);
    expect(store.getDelivery(EVT1, "user-1")).toBeUndefined();
  });

  it("origin=auto 零活跃 session / 无匹配订阅 → delivery 行不发（billboard 兜底归 query）", () => {
    const store = createMemoryStore();
    const kernel = new Kernel(store, VERDICT_STATES, 0);
    seedTransitioned(store, kernel);
    store.putSubscription(sub({ subscriptionId: "sub-auto", origin: "auto" }));
    expect(kernel.fanOut(EVT1, { activeSessions: [] })).toEqual({
      notificationId: EVT1,
      eventSeq: 1,
      delivered: [],
      parked: [],
    });
    // 无匹配订阅：实体没有订阅 → 零行（fresh store，隔离上段 auto 订阅）
    const store2 = createMemoryStore();
    const kernel2 = new Kernel(store2, VERDICT_STATES, 0);
    seedTransitioned(store2, kernel2);
    store2.putSubscription(sub({ subscriptionId: "sub-other-entity", entityRefKey: "external/other" }));
    expect(kernel2.fanOut(EVT1, { activeSessions: [sess("proj-1")] }).delivered).toEqual([]);
    expect(store2.pendingDeliveries({})).toEqual([]);
  });

  it("I10 幂等：同 notification 重复 fanOut 不产生第二行；notification 行 + billboard 截断指针", () => {
    const store = createMemoryStore();
    const kernel = new Kernel(store, VERDICT_STATES, 0);
    seedEntity(store, "passed");
    // 带 evidenceRef 的事件（probe 路径形状）：直写事件 + outbox 行（B 层 fixture）
    store.appendEventIfMissing({
      eventId: EVT1,
      eventSeq: 1,
      entityRefType: REF.type,
      entityRefKey: REF.key,
      from: "passed",
      to: "failed",
      occurredAt: at(1),
      evidenceRef: "ev-full",
    });
    store.putOutbox({ notificationId: EVT1, eventSeq: 1 });
    store.putEvidence({ evidenceRef: "ev-full", content: "x".repeat(3000), recordedAt: 1 });
    store.putSubscription(sub({ subscriptionId: "sub-a", sessionId: "session-a" }));

    kernel.fanOut(EVT1, { activeSessions: [sess("session-a")] });
    const second = kernel.fanOut(EVT1, { activeSessions: [sess("session-a")] });
    expect(second.delivered).toEqual([]); // 既有行跳过（I10）
    expect(store.pendingDeliveries({})).toHaveLength(1);

    const [notification] = store.notifications({});
    expect(notification).toMatchObject({ notificationId: EVT1, eventSeq: 1 });
    const billboard = JSON.parse(notification.billboardJson);
    expect(billboard.entityRef).toEqual(REF);
    expect(billboard.verdict).toBe("failed");
    expect(billboard.evidence).toHaveLength(2048); // >2KB 截断（UTF-8 字节口径）
    expect(billboard.evidenceRef).toBe(EVT1); // 截断指针 = notificationId（evidence op 据此解引用）
  });
});

describe("票 11 组 2：drain 只出 parked（D2a），dead-letter 零进入", () => {
  it("SESSION_START 语义：parked 行 sourceSessionId == 连接 session → 重投（parked→accepted，drain-redeliver 正典边）", () => {
    const store = createMemoryStore();
    const kernel = new Kernel(store, VERDICT_STATES, 0);
    seedTransitioned(store, kernel);
    store.putSubscription(sub({ subscriptionId: "sub-a", sessionId: "session-a" }));
    kernel.fanOut(EVT1, { activeSessions: [] }); // 离线 → parked
    expect(store.getDelivery(EVT1, "session-a")?.state).toBe("parked");

    const res = kernel.drain({ sessionId: "session-a", now: 5_000 });
    expect(res.drained).toEqual([{ notificationId: EVT1, sessionId: "session-a" }]);
    expect(store.getDelivery(EVT1, "session-a")?.state).toBe("accepted"); // 两段式：accepted=在线重试态
  });

  it("D2a：dead-letter 零进入——drain 不迁移 dead-letter，只读摘要", () => {
    const store = createMemoryStore();
    const kernel = new Kernel(store, VERDICT_STATES, 0);
    seedTransitioned(store, kernel);
    store.putDelivery({ notificationId: EVT1, sessionId: "session-a", state: "dead-letter", recordEpoch: 1 });
    const res = kernel.drain({ sessionId: "session-a", now: 5_000 });
    expect(res.drained).toEqual([]);
    expect(store.getDelivery(EVT1, "session-a")?.state).toBe("dead-letter"); // 终态无出边
    expect(res.deadLetterSummary).toEqual({ count: 1, oldestAgeMs: 5_000 - Date.parse(at(1)) });
  });

  it("sessionId 过滤：他 session 的 parked 不动；无 sessionId = 全量 parked；零 dead-letter → oldestAgeMs null", () => {
    const store = createMemoryStore();
    const kernel = new Kernel(store, VERDICT_STATES, 0);
    seedTransitioned(store, kernel);
    store.putSubscription(sub({ subscriptionId: "sub-a", sessionId: "session-a" }));
    store.putSubscription(sub({ subscriptionId: "sub-b", sessionId: "session-b" }));
    kernel.fanOut(EVT1, { activeSessions: [] }); // 两行 parked
    const res = kernel.drain({ sessionId: "session-b", now: 5_000 });
    expect(res.drained).toEqual([{ notificationId: EVT1, sessionId: "session-b" }]);
    expect(store.getDelivery(EVT1, "session-a")?.state).toBe("parked"); // 不动
    expect(res.deadLetterSummary).toEqual({ count: 0, oldestAgeMs: null });
    // 全量 drain 兜走剩余
    expect(kernel.drain({ now: 6_000 }).drained).toEqual([{ notificationId: EVT1, sessionId: "session-a" }]);
  });

  it("I12 epoch fence：drain 只重投本 epoch 的 parked 行——异 epoch 行不转换不返回（留给正确 epoch 的 daemon）", () => {
    const store = createMemoryStore();
    const kernel = new Kernel(store, VERDICT_STATES, 0, { ownerEpoch: 7 });
    seedTransitioned(store, kernel);
    // epoch 8 的 daemon 接管后写入的 parked 行；ownerEpoch 7 的僵尸 kernel 不得重投
    store.putDelivery({ notificationId: EVT1, sessionId: "session-a", state: "parked", recordEpoch: 8 });
    store.putDelivery({ notificationId: EVT1, sessionId: "session-b", state: "parked", recordEpoch: 7 });
    const res = kernel.drain({});
    expect(res.drained).toEqual([{ notificationId: EVT1, sessionId: "session-b" }]); // recordEpoch 7 正常出队
    expect(store.getDelivery(EVT1, "session-a")).toMatchObject({ state: "parked", recordEpoch: 8 }); // 不转换不动
  });
});

describe("票 11 组 3：query——listChildren 单层 + per-entity backlog/deadLetters + B4 懒重探", () => {
  it("端到端 B 层（链 B 里程碑）：publish→transition→query 返回新状态与 eventSeq", () => {
    const store = createMemoryStore();
    const kernel = new Kernel(store, VERDICT_STATES, 0);
    seedEntity(store, "passed");
    expect(kernel.transition(REF, "failed", at(1))).toMatchObject({ eventSeq: 1 });
    expect(kernel.query({ entityRef: REF })).toEqual({
      entities: [
        {
          entityRef: REF,
          state: "failed",
          payload: null,
          eventSeq: 1,
          lastProbedAt: null,
          backlog: 0,
        },
      ],
      deadLetters: [],
    });
  });

  it("listChildren 单层展开：parent 挂 children 一步；孙辈不上挂（无级联）", () => {
    const store = createMemoryStore();
    const kernel = new Kernel(store, VERDICT_STATES, 0);
    seedEntity(store, "passed");
    store.putEntity({ type: REF.type, key: "external/child", state: "waiting", parentType: REF.type, parentKey: REF.key });
    store.putEntity({ type: REF.type, key: "external/grandchild", state: "waiting", parentType: REF.type, parentKey: "external/child" });
    const res = kernel.query({ entityRef: REF });
    expect(res.entities).toHaveLength(1);
    expect(res.entities[0].children?.map((c) => c.entityRef.key)).toEqual(["external/child"]);
    expect(res.entities[0].children?.[0].children).toBeUndefined(); // 单层
  });

  it("per-entity backlog/deadLetters：pending 行计数进 backlog；dead-letter 行进清单（经事件 join 归实体）", () => {
    const store = createMemoryStore();
    const kernel = new Kernel(store, VERDICT_STATES, 0);
    seedTransitioned(store, kernel);
    store.putDelivery({ notificationId: EVT1, sessionId: "session-a", state: "pending", recordEpoch: 1 });
    store.putDelivery({ notificationId: EVT1, sessionId: "session-b", state: "dead-letter", recordEpoch: 1 });
    const res = kernel.query({ entityRef: REF });
    expect(res.entities[0].backlog).toBe(1);
    expect(res.deadLetters).toEqual([{ notificationId: EVT1, sessionId: "session-b", entityRef: REF }]);
  });

  it("B4 懒重探触发条件：refcount 0 且 lastProbedAt 超阈 → reprobeRequested；活跃/新鲜/无 ctx 不标", () => {
    const store = createMemoryStore();
    const kernel = new Kernel(store, VERDICT_STATES, 0);
    seedEntity(store, "passed");
    const probe = {
      now: 100_000,
      reprobeAfterMs: 60_000,
      runtime: [
        { entityRef: REF, refcount: 0, lastProbedAt: 10_000 }, // 0 + 超阈 → 标记
      ],
    };
    expect(kernel.query({ entityRef: REF }, probe).entities[0].reprobeRequested).toBe(true);

    // refcount > 0：probe 未停，不标
    expect(
      kernel.query({ entityRef: REF }, { ...probe, runtime: [{ entityRef: REF, refcount: 2, lastProbedAt: 10_000 }] })
        .entities[0].reprobeRequested,
    ).toBeUndefined();
    // 新鲜 lastProbedAt：未超阈，不标（单次语义：重探执行方记录 lastProbedAt 后条件自清）
    expect(
      kernel.query({ entityRef: REF }, { ...probe, runtime: [{ entityRef: REF, refcount: 0, lastProbedAt: 90_000 }] })
        .entities[0].reprobeRequested,
    ).toBeUndefined();
    // 无 probe ctx：读侧归一，不标（lastProbedAt 亦为 null）
    const bare = kernel.query({ entityRef: REF });
    expect(bare.entities[0].reprobeRequested).toBeUndefined();
    expect(bare.entities[0].lastProbedAt).toBeNull();
  });

  it("query 无关系大清单 O(N)：parent→children 索引一次构建——5 万实体全量正常返回（性能回归锚：O(N²) 全表扫必撞 vitest 5s 超时）", () => {
    const store = createMemoryStore();
    const kernel = new Kernel(store, VERDICT_STATES, 0);
    const N = 50_000;
    // 单事务批量造数：内存 store 每 tx 全表 staging 拷贝，逐行 putEntity 会把夹具自身变 O(N²)
    store.tx((tx) => {
      for (let i = 0; i < N; i++) tx.putEntity({ type: REF.type, key: `bulk/${i}`, state: "passed" });
    });
    const res = kernel.query({});
    expect(res.entities).toHaveLength(N);
    expect(res.entities.every((e) => e.children === undefined)).toBe(true); // 无关系 → 零 children 挂载
  });
});

// --- 票 11 fake registry（静态面数据注入，I-01：零 profile import、零具体 profile 名）---
const REGISTRY = [
  {
    profileId: "fixture-profile",
    templates: [
      {
        name: "fixture-tpl",
        entityType: "fixture:widget",
        states: ["passed", "failed", "waiting"],
        params: ["target"],
        usage: "fixture usage",
      },
      { name: "fixture-tpl-b", entityType: "fixture:gadget", states: ["passed", "failed"], usage: "b" },
    ],
    sideEffectPatterns: ["fixture-destructive"],
  },
] as const;
const kernelWithRegistry = (store: MemStore) => new Kernel(store, VERDICT_STATES, 0, { registry: REGISTRY });

describe("票 11 组 4：evidence FTS5 点查 + validate 三类错误 + templates 注册表清单", () => {
  it("evidence 点查：直接 ref 命中（truncated 按 2KB 内联上限判定）；未找到拒绝", () => {
    const store = createMemoryStore();
    const kernel = kernelWithRegistry(store);
    store.putEvidence({ evidenceRef: "ev-short", content: "probe ok", recordedAt: 1 });
    store.putEvidence({ evidenceRef: "ev-big", content: "y".repeat(3000), recordedAt: 2 });
    expect(kernel.evidence("ev-short")).toEqual({ content: "probe ok", truncated: false });
    expect(kernel.evidence("ev-big").truncated).toBe(true);
    expect(() => kernel.evidence("ev-missing")).toThrow(/ev-missing/);
  });

  it("evidence 经 billboard 截断指针解引用：ref=notificationId → 事件 evidenceRef → 全文（指针不被截断吞掉）", () => {
    const store = createMemoryStore();
    const kernel = kernelWithRegistry(store);
    store.appendEventIfMissing({
      eventId: EVT1,
      eventSeq: 1,
      entityRefType: REF.type,
      entityRefKey: REF.key,
      from: "passed",
      to: "failed",
      occurredAt: at(1),
      evidenceRef: "ev-full",
    });
    store.putEvidence({ evidenceRef: "ev-full", content: "z".repeat(3000), recordedAt: 1 });
    expect(kernel.evidence(EVT1)).toEqual({ content: "z".repeat(3000), truncated: true });
  });

  it("validate 三类错误：profile/template 未找到（列可用选项）/缺必填参数/ad-hoc 缺 check 声明", () => {
    const store = createMemoryStore();
    const kernel = kernelWithRegistry(store);
    expect(kernel.validate({ profile: "nope", check: "true" })).toMatchObject({
      ok: false,
      error: "profile-not-found",
    });
    expect((kernel.validate({ profile: "nope", check: "true" }) as { reason: string }).reason).toContain("fixture-profile");
    expect(kernel.validate({ profile: "fixture-profile", template: "nope-tpl" })).toMatchObject({
      ok: false,
      error: "profile-not-found",
    });
    expect(kernel.validate({ profile: "fixture-profile", template: "fixture-tpl" })).toMatchObject({
      ok: false,
      error: "invalid-params",
    });
    expect(kernel.validate({ profile: "fixture-profile" })).toMatchObject({
      ok: false,
      error: "checker-declaration",
    });
  });

  it("validate ADR 0004：已知副作用 pattern 命中 → warning 不阻断（ok:true）；干净 check 零 warning", () => {
    const store = createMemoryStore();
    const kernel = kernelWithRegistry(store);
    expect(kernel.validate({ profile: "fixture-profile", check: "fixture-destructive-cmd --force" })).toEqual({
      ok: true,
      warnings: [expect.stringContaining("fixture-destructive")],
    });
    expect(kernel.validate({ profile: "fixture-profile", check: "curl -sf http://x/health" })).toEqual({
      ok: true,
      warnings: [],
    });
  });

  it("templates：注册表注入内容的元数据清单（profileId 附带）+ profile 过滤 + 未知 profile 拒绝", () => {
    const store = createMemoryStore();
    const kernel = kernelWithRegistry(store);
    expect(kernel.templates()).toEqual({
      templates: [
        { profileId: "fixture-profile", name: "fixture-tpl", entityType: "fixture:widget", states: ["passed", "failed", "waiting"], params: ["target"], usage: "fixture usage" },
        { profileId: "fixture-profile", name: "fixture-tpl-b", entityType: "fixture:gadget", states: ["passed", "failed"], usage: "b" },
      ],
    });
    expect(kernel.templates("fixture-profile").templates).toHaveLength(2);
    expect(() => kernel.templates("nope")).toThrow(/fixture-profile/);
  });

  it("validate 歧义声明拒绝：template 与 check 同时提供 → checker-declaration（二选一，warnings 不再从 check 推导）", () => {
    const store = createMemoryStore();
    const kernel = kernelWithRegistry(store);
    const res = kernel.validate({
      profile: "fixture-profile",
      template: "fixture-tpl",
      params: { target: "x" },
      check: "fixture-destructive-cmd",
    });
    expect(res).toMatchObject({ ok: false, error: "checker-declaration" });
    expect((res as { reason: string }).reason).toContain("二选一");
  });

  it("validate 必填参数不吃原型链：params ['constructor'] + {} → invalid-params（own-property 判定，票 04 同修法）", () => {
    const store = createMemoryStore();
    const registry = [
      {
        profileId: "proto-profile",
        templates: [
          { name: "proto-tpl", entityType: "fixture:widget", states: ["passed", "failed"], params: ["constructor"], usage: "u" },
        ],
      },
    ] as const;
    const kernel = new Kernel(store, VERDICT_STATES, 0, { registry });
    const res = kernel.validate({ profile: "proto-profile", template: "proto-tpl", params: {} });
    expect(res).toMatchObject({ ok: false, error: "invalid-params" });
    expect((res as { reason: string }).reason).toContain("constructor");
  });
});

// =============================================================================
// 票 24 — 订阅生命周期：register / subscribe（幂等/换参/smoke）/ cancel / RunnerSlot
// B 层：MemoryStore fake 注入；槽键 (EntityRef, 模板) 不含谓词（I5）；阈值先建者定（R2）。
// =============================================================================

const SLOT_TEMPLATE = "fixture-tpl";
const SLOT_KEY = `slot:${REF.type}:${REF.key}#${SLOT_TEMPLATE}`;

type SubscribeRequest = Parameters<Kernel["subscribe"]>[0];
type SubscribeDeps = Parameters<Kernel["subscribe"]>[1];

/** 票 24 fixture 请求：模板形态（check 由 profiles 静态面解析产物，caller 传入——kernel 零 profile import）。 */
const subReq = (over: Partial<SubscribeRequest> = {}): SubscribeRequest => ({
  sessionId: "session-1",
  entityRef: REF,
  template: SLOT_TEMPLATE,
  check: "fixture-check-a",
  now: 1_000,
  ...over,
});

const subId = (r: ReturnType<Kernel["subscribe"]>): string => {
  if (!r.subscribed) throw new Error(`expected subscribed, got ${JSON.stringify(r)}`);
  return r.subscriptionId;
};

describe("票 24 — RunnerSlot 全周期：首订阅创建（阈值从 0 起先建者定）→ 共享 → 末 cancel 销毁", () => {
  it("首订阅建槽：ProbeSpec 落库（check/schedule/source）+ RunLedger refcount 1 + 槽身份平铺；共享订阅 refcount 递增", () => {
    const store = createMemoryStore();
    seedEntity(store, "passed");
    const kernel = new Kernel(store, VERDICT_STATES, 0);
    expect(kernel.subscribe(subReq()).subscribed).toBe(true);
    expect(store.getProbeSpec(SLOT_KEY)).toMatchObject({
      slotKey: SLOT_KEY,
      check: "fixture-check-a",
      schedule: { type: "interval", intervalMs: 60_000 },
      source: "poll",
    });
    expect(store.getRunLedger(SLOT_KEY)).toMatchObject({
      refcount: 1,
      consecutiveFails: 0,
      entityRefType: REF.type,
      entityRefKey: REF.key,
    });
    expect(kernel.subscribe(subReq({ sessionId: "session-2" })).subscribed).toBe(true);
    expect(store.getRunLedger(SLOT_KEY)?.refcount).toBe(2);
  });

  it("阈值先建者定：第二订阅不同阈值 → warning + 沿用槽值（订阅行存沿用值，首订阅者 cancel 后语义延续）；同值零 warning", () => {
    const store = createMemoryStore();
    seedEntity(store, "passed");
    const kernel = new Kernel(store, VERDICT_STATES, 0);
    const r1 = kernel.subscribe(subReq({ opts: { failureThreshold: 3, successThreshold: 2 } }));
    expect(r1.subscribed && r1.warnings).toEqual([]);
    const r2 = kernel.subscribe(subReq({ sessionId: "session-2", opts: { failureThreshold: 1, successThreshold: 1 } }));
    expect(r2.subscribed && r2.warnings).toEqual([expect.stringContaining("first-creator-wins")]);
    // 沿用值落在新订阅行（restoreSlotThresholds 重启重建的数据载体）
    const row2 = store.querySubscriptions({ sessionId: "session-2" })[0];
    expect(row2.thresholds).toEqual({ failureThreshold: 3, successThreshold: 2 });
    // 同值加入：零 warning
    const r3 = kernel.subscribe(subReq({ sessionId: "session-3", opts: { failureThreshold: 3, successThreshold: 2 } }));
    expect(r3.subscribed && r3.warnings).toEqual([]);
    expect(store.getRunLedger(SLOT_KEY)?.refcount).toBe(3);
  });

  it("末 cancel 销毁槽（refcount 0 计数清零）；重建后阈值重新先建者定；cancel 幂等/未知安全", () => {
    const store = createMemoryStore();
    seedEntity(store, "passed");
    const kernel = new Kernel(store, VERDICT_STATES, 0);
    const idA = subId(kernel.subscribe(subReq({ opts: { failureThreshold: 3, successThreshold: 2 } })));
    const idB = subId(kernel.subscribe(subReq({ sessionId: "session-2", opts: { failureThreshold: 1 } })));
    expect(kernel.cancel({ subscriptionId: idA, now: 2_000 })).toEqual({ cancelled: true });
    expect(store.getRunLedger(SLOT_KEY)?.refcount).toBe(1); // 共享槽存活
    expect(store.getProbeSpec(SLOT_KEY)).toBeDefined();
    expect(kernel.cancel({ subscriptionId: idB, now: 2_100 })).toEqual({ cancelled: true });
    // 末 cancel：槽销毁 = refcount 0 + 计数清零（probe_spec 行无 delete 语义，refcount 0 即惰性终结）
    expect(store.getRunLedger(SLOT_KEY)).toMatchObject({ refcount: 0, consecutiveFails: 0, lastVerdict: undefined });
    // 幂等 cancel / 未知 id：安全不抛
    expect(kernel.cancel({ subscriptionId: idB, now: 2_200 })).toEqual({ cancelled: false });
    expect(kernel.cancel({ subscriptionId: "sub-none", now: 2_200 })).toEqual({ cancelled: false });
    // 重建：阈值从 0 起重新先建者定（先建者 2/2 采纳，非沿用旧槽 3/2）
    const rC = kernel.subscribe(subReq({ opts: { failureThreshold: 2, successThreshold: 2 } }));
    expect(rC.subscribed && rC.warnings).toEqual([]);
    expect(store.getRunLedger(SLOT_KEY)?.refcount).toBe(1);
    expect(store.querySubscriptions({ sessionId: "session-1" }).at(-1)?.thresholds).toEqual({ failureThreshold: 2, successThreshold: 2 });
  });

  it("cancel 越权拒绝：非本 session 的订阅 cancel → 明确错误；不带 sessionId（loops 内部关闭路径）放行", () => {
    const store = createMemoryStore();
    seedEntity(store, "passed");
    const kernel = new Kernel(store, VERDICT_STATES, 0);
    const id = subId(kernel.subscribe(subReq()));
    expect(() => kernel.cancel({ subscriptionId: id, sessionId: "session-9", now: 2_000 })).toThrow(/belongs to session session-1/);
    expect(kernel.cancel({ subscriptionId: id, now: 2_000 })).toEqual({ cancelled: true });
  });

  it("槽 generation 生命周期（评审 B 组核心）：首建 0、共享加入不变、末 cancel 后重建 +1、换参重建再 +1", () => {
    const store = createMemoryStore();
    seedEntity(store, "passed");
    const kernel = new Kernel(store, VERDICT_STATES, 0);
    const idA = subId(kernel.subscribe(subReq()));
    expect(store.getRunLedger(SLOT_KEY)?.generation).toBe(0); // 创建 = 0
    const idB = subId(kernel.subscribe(subReq({ sessionId: "session-2" })));
    expect(store.getRunLedger(SLOT_KEY)?.generation).toBe(0); // 共享加入不换代
    expect(kernel.cancel({ subscriptionId: idA, now: 2_000 })).toEqual({ cancelled: true });
    expect(kernel.cancel({ subscriptionId: idB, now: 2_100 })).toEqual({ cancelled: true });
    expect(store.getRunLedger(SLOT_KEY)?.refcount).toBe(0); // 槽销毁（行保留）
    kernel.subscribe(subReq()); // 重建 +1
    expect(store.getRunLedger(SLOT_KEY)).toMatchObject({ refcount: 1, generation: 1 });
    const idD = subId(kernel.subscribe(subReq({ sessionId: "session-2" })));
    expect(store.getRunLedger(SLOT_KEY)?.generation).toBe(1); // 共享加入仍不换代
    kernel.cancel({ subscriptionId: idD, now: 2_200 });
    kernel.subscribe(subReq({ check: "fixture-check-b" })); // 换参重建再 +1
    expect(store.getRunLedger(SLOT_KEY)).toMatchObject({ refcount: 1, generation: 2 });
  });
});

describe("票 24 — subscribe 幂等与换参", () => {
  it("同 session 同参重复 subscribe → 幂等返回既有订阅（不新建行、refcount 不变）", () => {
    const store = createMemoryStore();
    seedEntity(store, "passed");
    const kernel = new Kernel(store, VERDICT_STATES, 0);
    const id1 = subId(kernel.subscribe(subReq({ opts: { on: "x", once: true, ttl: 60_000 } })));
    const r2 = kernel.subscribe(subReq({ opts: { on: "x", once: true, ttl: 60_000 } }));
    expect(subId(r2)).toBe(id1);
    expect(store.querySubscriptions({ sessionId: "session-1" })).toHaveLength(1);
    expect(store.getRunLedger(SLOT_KEY)?.refcount).toBe(1);
  });

  it("换参：旧关新开（closedReason replaced）、checker 替换（solo 槽 ProbeSpec 换 check）、在途投递不撤", () => {
    const store = createMemoryStore();
    seedEntity(store, "passed");
    const kernel = new Kernel(store, VERDICT_STATES, 0);
    const idOld = subId(kernel.subscribe(subReq({ opts: { on: "failed" } }))); // on 匹配即将到来的 failed 事件（F18 谓词过滤）
    // 在途投递：transition + fanOut 产生 delivery 行（旧订阅编址）
    kernel.transition(REF, "failed", at(1));
    kernel.fanOut(deterministicEventId(REF, 1), { activeSessions: [{ sessionId: "session-1", scope: "project" }] });
    const deliveryBefore = store.getDelivery(deterministicEventId(REF, 1), "session-1");
    expect(deliveryBefore).toMatchObject({ state: "pending" });

    const r2 = kernel.subscribe(subReq({ check: "fixture-check-b", opts: { on: "y" } }));
    expect(r2.subscribed).toBe(true);
    const rows = store.querySubscriptions({ sessionId: "session-1" });
    expect(rows).toHaveLength(2);
    const oldRow = rows.find((r) => r.subscriptionId === idOld)!;
    const newRow = rows.find((r) => r.subscriptionId !== idOld)!;
    expect(oldRow.closedAt).toBe(1_000);
    expect(oldRow.closedReason).toBe("replaced");
    expect(newRow.check).toBe("fixture-check-b");
    expect(newRow.on).toBe("y");
    expect(newRow.closedAt).toBeUndefined();
    // checker 替换可观测（solo 槽销毁重建）；refcount 净零不变
    expect(store.getProbeSpec(SLOT_KEY)?.check).toBe("fixture-check-b");
    expect(store.getRunLedger(SLOT_KEY)?.refcount).toBe(1);
    // 在途投递不撤：已落盘 delivery 行原样
    expect(store.getDelivery(deterministicEventId(REF, 1), "session-1")).toEqual(deliveryBefore);
  });

  it("已关订阅不收新投递：fanOut 跳过 closedAt 有值的订阅（取消会话零新行）", () => {
    const store = createMemoryStore();
    seedEntity(store, "passed");
    const kernel = new Kernel(store, VERDICT_STATES, 0);
    const id1 = subId(kernel.subscribe(subReq()));
    const id2 = subId(kernel.subscribe(subReq({ sessionId: "session-2" })));
    kernel.cancel({ subscriptionId: id2, now: 1_500 });
    kernel.transition(REF, "waiting", at(2));
    kernel.fanOut(deterministicEventId(REF, 1), {
      activeSessions: [
        { sessionId: "session-1", scope: "project" },
        { sessionId: "session-2", scope: "project" },
      ],
    });
    expect(store.getDelivery(deterministicEventId(REF, 1), "session-1")).toMatchObject({ state: "pending" });
    expect(store.getDelivery(deterministicEventId(REF, 1), "session-2")).toBeUndefined();
    expect(store.getRunLedger(SLOT_KEY)?.refcount).toBe(1);
    void id1;
  });
});

describe("票 24 — subscribe smoke（live-run 经 prober 同步路径：kernel 协调、不自行 spawn）", () => {
  const failSync: SubscribeDeps = {
    probeSync: () => ({ verdict: "failed", reason: "exit 2", evidence: "asserted unreachable", durationMs: 5 }),
  };

  it("smoke 失败：{subscribed:false, validate} 不抛错；订阅/槽/账本零写入（bad checker 不进 store）", () => {
    const store = createMemoryStore();
    seedEntity(store, "passed");
    const kernel = new Kernel(store, VERDICT_STATES, 0);
    expect(kernel.subscribe(subReq({ opts: { smoke: true } }), failSync)).toEqual({
      subscribed: false,
      validate: { verdict: "failed", reason: "exit 2", evidence: "asserted unreachable", durationMs: 5 },
    });
    expect(store.querySubscriptions({ sessionId: "session-1" })).toHaveLength(0);
    expect(store.getProbeSpec(SLOT_KEY)).toBeUndefined();
    expect(store.getRunLedger(SLOT_KEY)).toBeUndefined();
  });

  it("smoke waiting 同样拒绝（通过 = 首探 passed 才落订阅）；smoke 通过：落订阅 + validate 回显 + checker 只跑一次", () => {
    const store = createMemoryStore();
    seedEntity(store, "passed");
    const kernel = new Kernel(store, VERDICT_STATES, 0);
    const waits: SubscribeDeps = { probeSync: () => ({ verdict: "waiting", reason: "exit 1", evidence: "", durationMs: 3 }) };
    expect(kernel.subscribe(subReq({ opts: { smoke: true } }), waits).subscribed).toBe(false);

    const checks: string[] = [];
    const passSync: SubscribeDeps = {
      probeSync: (check) => {
        checks.push(check);
        return { verdict: "passed", reason: "exit 0", evidence: "ok", durationMs: 7 };
      },
    };
    const r = kernel.subscribe(subReq({ check: "fixture-probe-cmd", opts: { smoke: true } }), passSync);
    expect(r.subscribed && r.validate).toEqual({ verdict: "passed", reason: "exit 0", evidence: "ok", durationMs: 7 });
    expect(checks).toEqual(["fixture-probe-cmd"]); // kernel 协调一次，不自行重试
    expect(store.querySubscriptions({ sessionId: "session-1" })).toHaveLength(1);
  });

  it("smoke 无执行器注入 → 明确抛错（协调失败不静默降级）", () => {
    const store = createMemoryStore();
    seedEntity(store, "passed");
    const kernel = new Kernel(store, VERDICT_STATES, 0);
    expect(() => kernel.subscribe(subReq({ opts: { smoke: true } }))).toThrow(/probeSync/);
    expect(store.querySubscriptions({ sessionId: "session-1" })).toHaveLength(0);
  });
});

describe("票 24 — register 簿记与 profile 冲突拒绝（US-32：一实体不跨两 profile）", () => {
  it("register：创建实体记 profileId；同 profile 幂等不覆盖既有 state/payload；冲突 profile 明确拒绝", () => {
    const store = createMemoryStore();
    const kernel = new Kernel(store, VERDICT_STATES, 0);
    expect(kernel.register({ entityRef: REF, profileId: "fixture-profile", state: "passed" })).toEqual({
      entityRef: REF,
      state: "passed",
      created: true,
    });
    expect(store.getEntity(REF.type, REF.key)?.profileId).toBe("fixture-profile");
    expect(
      kernel.register({ entityRef: REF, profileId: "fixture-profile", state: "failed", payload: { x: 1 } }),
    ).toEqual({ entityRef: REF, state: "passed", created: false });
    expect(store.getEntity(REF.type, REF.key)).toMatchObject({ state: "passed", profileId: "fixture-profile" });
    expect(store.getEntity(REF.type, REF.key)?.payload).toBeUndefined();
    expect(() => kernel.register({ entityRef: REF, profileId: "other-profile" })).toThrow(
      /already belongs to profile "fixture-profile"/,
    );
  });

  it("subscribe 携异 profile → 拒绝（不静默覆盖实体归属）；一致 profile 可订阅", () => {
    const store = createMemoryStore();
    const kernel = new Kernel(store, VERDICT_STATES, 0);
    kernel.register({ entityRef: REF, profileId: "fixture-profile", state: null });
    expect(() => kernel.subscribe(subReq({ profileId: "other-profile" }))).toThrow(/belongs to profile/);
    expect(kernel.subscribe(subReq({ profileId: "fixture-profile" })).subscribed).toBe(true);
  });

  it("subscribe 未注册实体 → 明确拒绝（probe 路径 transition 需实体存在，fail-fast）", () => {
    const store = createMemoryStore();
    const kernel = new Kernel(store, VERDICT_STATES, 0);
    expect(() => kernel.subscribe(subReq())).toThrow(/unknown entity/);
  });
});

describe("评审 A 组 — SqliteStore 真库订阅流程（票 24 新增字段持久化端到端）", () => {
  const tmpDirs: string[] = [];
  const tmpDbPath = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "eda-kernel-"));
    tmpDirs.push(dir);
    return join(dir, "store.db");
  };
  afterAll(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  });

  it("真 SQLite 下 subscribe 幂等/关闭/相位推进/换参重建（字段往返过持久层）", () => {
    const s = new SqliteStore(tmpDbPath());
    const kernel = new Kernel(s, VERDICT_STATES, 0);
    kernel.register({ entityRef: REF, profileId: "fixture-profile", state: null });

    const r1 = kernel.subscribe(subReq({ opts: { on: "passed", flip: false, readyCheck: "fixture-ready" } }));
    expect(r1.subscribed).toBe(true);
    const id1 = subId(r1);
    // 幂等：同参返回既有订阅，行含票 24 字段且经落库往返无损（false 显式存活，不坍缩 undefined）
    expect(subId(kernel.subscribe(subReq({ opts: { on: "passed", flip: false, readyCheck: "fixture-ready" } })))).toBe(id1);
    expect(s.getSubscription(id1)).toMatchObject({ check: "fixture-check-a", on: "passed", flip: false });

    // 相位推进：phase 落库 + solo 槽 ProbeSpec 换 readyCheck
    expect(kernel.flipSubscription(id1)).toEqual({ advanced: true });
    expect(s.getSubscription(id1)?.phase).toBe("flip");
    expect(s.getProbeSpec(SLOT_KEY)?.check).toBe("fixture-ready");

    // 关闭簿记：closedAt/closedReason 落库；换参重建后 refcount 恢复
    expect(kernel.cancel({ subscriptionId: id1, now: 2_000 })).toEqual({ cancelled: true });
    expect(s.getSubscription(id1)).toMatchObject({ closedAt: 2_000, closedReason: "cancelled" });
    const r2 = kernel.subscribe(subReq({ check: "fixture-check-b", opts: { on: "passed", flip: false } }));
    expect(r2.subscribed).toBe(true);
    expect(s.getRunLedger(SLOT_KEY)?.refcount).toBe(1);
    expect(s.getProbeSpec(SLOT_KEY)?.check).toBe("fixture-check-b");
    s.close();
  });
});

// ==================== 评审修复 — C 组：on 谓词匹配 / 关闭前物化投递 / 共享槽相位统一 / schedule 幂等 ====================
describe("评审修复 — C 组（kernel 面）", () => {
  it("C6/F18：on 谓词参与事件匹配——同槽不同谓词分别接收（共享槽 I5 保持），缺省收全部", () => {
    const store = createMemoryStore();
    seedEntity(store, "passed");
    const kernel = new Kernel(store, VERDICT_STATES, 0);
    kernel.subscribe(subReq({ sessionId: "session-passed", opts: { on: "passed" } }));
    kernel.subscribe(subReq({ sessionId: "session-failed", opts: { on: "failed" } }));
    kernel.subscribe(subReq({ sessionId: "session-any" })); // 缺省 on = 收全部事件
    expect(store.getRunLedger(SLOT_KEY)?.refcount).toBe(3); // I5：谓词不进槽键，三订阅共享同槽

    const res = kernel.transition(REF, "failed", at(2));
    kernel.fanOut(res!.eventId, { activeSessions: [{ sessionId: "session-failed", scope: "project" }] });
    expect(store.getDelivery(res!.eventId, "session-failed")).toMatchObject({ state: "pending" });
    expect(store.getDelivery(res!.eventId, "session-passed")).toBeUndefined(); // on="passed" 不收 failed
    expect(store.getDelivery(res!.eventId, "session-any")).toMatchObject({ state: "parked" }); // 缺省收全部；会话不活跃 → parked

    // C8：fanOut 产出的 parked 行带本 epoch，drain 重投正常过 I12 epoch fence
    expect(kernel.drain({ sessionId: "session-any" }).drained).toEqual([
      { notificationId: res!.eventId, sessionId: "session-any" },
    ]);
  });

  it("C9/F12：共享槽两订阅同相位同 checker——先后 advance，全员 flip 时统一切换槽 ProbeSpec", () => {
    const store = createMemoryStore();
    seedEntity(store, null);
    const kernel = new Kernel(store, VERDICT_STATES, 0);
    const id1 = subId(kernel.subscribe(subReq({ opts: { flip: true, readyCheck: "fixture-ready" } })));
    const id2 = subId(kernel.subscribe(subReq({ sessionId: "session-2", opts: { flip: true, readyCheck: "fixture-ready" } })));
    kernel.flipSubscription(id1);
    expect(store.getProbeSpec(SLOT_KEY)?.check).toBe("fixture-check-a"); // 另一订阅仍 startup：槽保持 startup check
    kernel.flipSubscription(id2);
    expect(store.getProbeSpec(SLOT_KEY)?.check).toBe("fixture-ready"); // 全员 flip 且 checker 一致 → 统一切换
  });

  it("C9：共享槽相位/形态不一致 → subscribe 明确拒绝（错误列形态）", () => {
    const store = createMemoryStore();
    seedEntity(store, null);
    const kernel = new Kernel(store, VERDICT_STATES, 0);
    kernel.subscribe(subReq({ opts: { flip: true, readyCheck: "fixture-ready" } }));
    expect(() => kernel.subscribe(subReq({ sessionId: "session-2" }))).toThrow(/两阶段形态不一致/);
    expect(() =>
      kernel.subscribe(subReq({ sessionId: "session-2", opts: { flip: true, readyCheck: "other-ready" } })),
    ).toThrow(/checker 不一致/);
    const id1 = store.querySubscriptions({ sessionId: "session-1" })[0].subscriptionId;
    kernel.flipSubscription(id1); // 已推进 flip 相位
    expect(() =>
      kernel.subscribe(subReq({ sessionId: "session-3", opts: { flip: true, readyCheck: "fixture-ready" } })),
    ).toThrow(/混合相位/);
  });

  it("F19：solo 槽 schedule 变化 = 换参重建（ProbeSpec 更新），幂等请求不再吞配置", () => {
    const store = createMemoryStore();
    seedEntity(store, null);
    const kernel = new Kernel(store, VERDICT_STATES, 0);
    const id1 = subId(kernel.subscribe(subReq({ opts: { schedule: { type: "interval", intervalMs: 60_000 } } })));
    const id2 = subId(kernel.subscribe(subReq({ opts: { schedule: { type: "interval", intervalMs: 1_000 } } })));
    expect(id2).not.toBe(id1); // 配置变化不构成幂等 → 关旧开新
    const rows = store.querySubscriptions({ sessionId: "session-1" });
    expect(rows.find((r) => r.subscriptionId === id1)?.closedReason).toBe("replaced");
    expect(store.getProbeSpec(SLOT_KEY)?.schedule).toEqual({ type: "interval", intervalMs: 1_000 });
    expect(subId(kernel.subscribe(subReq({ opts: { schedule: { type: "interval", intervalMs: 1_000 } } })))).toBe(id2); // 同参幂等
  });

  it("F19：共享槽 schedule 冲突 → subscribe 拒绝", () => {
    const store = createMemoryStore();
    seedEntity(store, null);
    const kernel = new Kernel(store, VERDICT_STATES, 0);
    kernel.subscribe(subReq({ opts: { schedule: { type: "interval", intervalMs: 60_000 } } }));
    expect(() =>
      kernel.subscribe(subReq({ sessionId: "session-2", opts: { schedule: { type: "interval", intervalMs: 1_000 } } })),
    ).toThrow(/探测配置/);
  });
});

// ==================== 评审修复 — D 组（kernel 面）：调度入口校验 ====================
describe("评审修复 — D 组（kernel 面）", () => {
  it("D11：非法 cron schedule → subscribe 明确拒绝（不落订阅不建槽）", () => {
    const store = createMemoryStore();
    seedEntity(store, null);
    const kernel = new Kernel(store, VERDICT_STATES, 0);
    expect(() => kernel.subscribe(subReq({ opts: { schedule: { type: "cron", cron: "bad" } } }))).toThrow(/invalid cron/);
    expect(store.querySubscriptions({})).toHaveLength(0);
    expect(store.getProbeSpec(SLOT_KEY)).toBeUndefined();
  });
});

// ==================== 评审修复 — E 组（kernel 面）：幂等阈值 warning / 遗留实体补写 profileId ====================
describe("评审修复 — E 组（kernel 面）", () => {
  it("E15：幂等重订阅异阈值 → warning + 沿用既有（existing 自身计入槽现值，不重建不改阈值）", () => {
    const store = createMemoryStore();
    seedEntity(store, null);
    const kernel = new Kernel(store, VERDICT_STATES, 0);
    const id = subId(kernel.subscribe(subReq({ opts: { failureThreshold: 3, successThreshold: 2 } })));
    const same = kernel.subscribe(subReq({ opts: { failureThreshold: 3, successThreshold: 2 } }));
    expect(same.subscribed && same.warnings).toEqual([]); // 同阈值零 warning
    const diff = kernel.subscribe(subReq({ opts: { failureThreshold: 5, successThreshold: 5 } }));
    expect(diff.subscribed && diff.warnings).toEqual([expect.stringContaining("first-creator-wins")]);
    expect(diff.subscribed && diff.subscriptionId).toBe(id); // thresholds 不入比较域 → 仍幂等返回既有
    const row = store.querySubscriptions({ sessionId: "session-1" }).find((s) => s.subscriptionId === id);
    expect(row?.thresholds).toEqual({ failureThreshold: 3, successThreshold: 2 }); // 沿用既有不改写
  });

  it("E16：无 profileId 遗留实体 register 同事务补写（保留 state/payload），其后异 profile 注册拒绝", () => {
    const store = createMemoryStore();
    store.putEntity({ type: REF.type, key: REF.key, state: "passed", payload: { legacy: true } });
    const kernel = new Kernel(store, VERDICT_STATES, 0);
    expect(kernel.register({ entityRef: REF, profileId: "fixture-profile" })).toEqual({
      entityRef: REF,
      state: "passed",
      created: false,
    });
    const row = store.getEntity(REF.type, REF.key);
    expect(row?.profileId).toBe("fixture-profile"); // 补写
    expect(row?.state).toBe("passed"); // 保留既有
    expect(row?.payload).toEqual({ legacy: true }); // 保留既有
    expect(() => kernel.register({ entityRef: REF, profileId: "other-profile" })).toThrow(
      /already belongs to profile "fixture-profile"/, // 补写后跨 profile 走拒绝路径
    );
  });
});

// =============================================================================
// 票 28 — kernel.verify：两段式 ack 收口（accepted → verified，I9 点查命中后的唯一写路径）
// =============================================================================

describe("票 28 — kernel.verify 收口", () => {
  const seedDelivery = (store: MemStore, state: DeliveryStateForTest, notificationId = "evt:x#1") =>
    store.putDelivery({ notificationId, sessionId: "sess-1", state, recordEpoch: 0 });
  type DeliveryStateForTest = "pending" | "accepted" | "verified" | "parked" | "failed" | "dead-letter";

  it("accepted → verified：正典边收口，出参 {verified:true}；行状态落库", () => {
    const store = createMemoryStore();
    seedDelivery(store, "accepted");
    const kernel = new Kernel(store, VERDICT_STATES, 0);
    expect(kernel.verify("evt:x#1", "sess-1")).toEqual({ verified: true });
    expect(store.getDelivery("evt:x#1", "sess-1")?.state).toBe("verified");
  });

  it("幂等/非法边：已 verified 再 verify → {verified:false, reason:not-accepted}，无第二写；未知行 → unknown-delivery", () => {
    const store = createMemoryStore();
    seedDelivery(store, "verified");
    const kernel = new Kernel(store, VERDICT_STATES, 0);
    expect(kernel.verify("evt:x#1", "sess-1")).toEqual({ verified: false, reason: "not-accepted" });

    expect(kernel.verify("evt:ghost#1", "sess-1")).toEqual({ verified: false, reason: "unknown-delivery" });
    // 非 accepted 态同拒（pending/parked 收口归 L2 wake / L3 链路，不经本方法）
    seedDelivery(store, "pending", "evt:x#2");
    expect(kernel.verify("evt:x#2", "sess-1")).toEqual({ verified: false, reason: "not-accepted" });
    expect(store.getDelivery("evt:x#2", "sess-1")?.state).toBe("pending");
  });

  it("I12 无 epoch fence（与 drain 相反）：异 epoch 行同收口——verified 判定来自 transcript 全局真相，fence 只挡重投不挡对账", () => {
    const store = createMemoryStore();
    store.putDelivery({ notificationId: "evt:x#1", sessionId: "sess-1", state: "accepted", recordEpoch: 7 });
    const kernel = new Kernel(store, VERDICT_STATES, 0, { ownerEpoch: 9 });
    expect(kernel.verify("evt:x#1", "sess-1")).toEqual({ verified: true });
    expect(store.getDelivery("evt:x#1", "sess-1")?.state).toBe("verified");
  });
});

// =============================================================================
// 票 40 评审修复 — F3/F9 kernel.publish 经 domain publish 纯函数 + F2 register firstTransition
// + F5 query scope/session 过滤
// =============================================================================

describe("票 40 评审 F3 — kernel.publish edge-trigger 归 domain publish 纯函数", () => {
  it("同 state 同 contentIdentity 二次 publish → null 无新事件；(state, contentIdentity) 对未变（ADR 0003）", () => {
    const store = createMemoryStore();
    const kernel = new Kernel(store, VERDICT_STATES, 0);
    kernel.register({ entityRef: REF, profileId: "p" });
    expect(kernel.publish(REF, "passed", { contentIdentity: "digest-1", occurredAt: at(1) })).toMatchObject({
      eventSeq: 1,
      from: null,
      to: "passed",
    });
    // 同对二次：edge-trigger → null，无事件无游标推进（修复前：只查 to 不查身份 → 重复发事件）
    expect(kernel.publish(REF, "passed", { contentIdentity: "digest-1", occurredAt: at(2) })).toBeNull();
    expect(store.outboxBatch(10)).toHaveLength(1);
    // 异身份同态：真实对变化 → 新事件 + 身份写回
    expect(kernel.publish(REF, "passed", { contentIdentity: "digest-2", occurredAt: at(3) })).toMatchObject({
      eventSeq: 2,
      from: "passed",
      to: "passed",
    });
    expect(store.getEntity(REF.type, REF.key)?.contentIdentity).toBe("digest-2");
    expect(store.outboxBatch(10)).toHaveLength(2);
  });

  it("身份对随 probe 转换保留：绕行 probe 后回到同 (state, contentIdentity) 对仍不重发", () => {
    const store = createMemoryStore();
    const kernel = new Kernel(store, VERDICT_STATES, 0);
    kernel.register({ entityRef: REF, profileId: "p" });
    kernel.publish(REF, "passed", { contentIdentity: "digest-1", occurredAt: at(1) });
    kernel.transition(REF, "failed", at(2)); // probe 路径无身份字段 → 保留既有值
    kernel.transition(REF, "passed", at(3));
    expect(kernel.publish(REF, "passed", { contentIdentity: "digest-1", occurredAt: at(4) })).toBeNull();
    expect(store.outboxBatch(10)).toHaveLength(3);
  });

  it("payload 保真：publish 不携带 payload 不清既有快照（与 probe 路径同形）", () => {
    const store = createMemoryStore();
    const kernel = new Kernel(store, VERDICT_STATES, 0);
    kernel.register({ entityRef: REF, profileId: "p", payload: { keep: true } });
    kernel.publish(REF, "passed", { occurredAt: at(1) });
    expect(store.getEntity(REF.type, REF.key)?.payload).toEqual({ keep: true });
    kernel.publish(REF, "failed", { payload: { next: 1 }, occurredAt: at(2) });
    expect(store.getEntity(REF.type, REF.key)?.payload).toEqual({ next: 1 });
  });
});

describe("票 40 评审 F9 — kernel.publish from 封闭集执法（B7 绕行收口）", () => {
  it("from 是历史旧名态 → 拒且零写入；显式 migrateState 迁移仍是唯一出口", () => {
    const store = createMemoryStore();
    store.putEntity({ type: REF.type, key: REF.key, state: "legacy" });
    const kernel = new Kernel(store, VERDICT_STATES, 0);
    expect(() => kernel.publish(REF, "passed", { occurredAt: at(1) })).toThrow(/outside profile closed set/);
    expect(store.outboxBatch(10)).toHaveLength(0);
    expect(store.getEntity(REF.type, REF.key)?.state).toBe("legacy");
    // to 侧执法保持（既有面）
    store.putEntity({ type: REF.type, key: REF.key, state: "passed" });
    expect(() => kernel.publish(REF, "bogus", { occurredAt: at(1) })).toThrow(/outside profile closed set/);
    // migrateState 显式迁移不受影响（例外保留）
    expect(kernel.migrateState(REF, { from: "passed", to: "waiting" }, at(2))).toMatchObject({ from: "passed", to: "waiting" });
  });
});

describe("票 40 评审 F2 — register firstTransition 同事务（status op 底座）", () => {
  it("新实体 register+首转换同事务发事件；同态重注册不重发", () => {
    const store = createMemoryStore();
    const kernel = new Kernel(store, VERDICT_STATES, 0);
    const r = kernel.register({ entityRef: REF, profileId: "p", firstTransition: { to: "waiting", occurredAt: at(1) } });
    expect(r.created).toBe(true);
    expect(r.event).toMatchObject({ eventSeq: 1, from: null, to: "waiting" });
    expect(store.getEntity(REF.type, REF.key)?.state).toBe("waiting");
    expect(store.outboxBatch(10)).toHaveLength(1);
    const again = kernel.register({ entityRef: REF, profileId: "p", firstTransition: { to: "waiting", occurredAt: at(2) } });
    expect(again.created).toBe(false);
    expect(again.event).toBeUndefined();
    expect(store.outboxBatch(10)).toHaveLength(1);
  });

  it("无效 state：register+transition 整体回滚，无残留实体（半注册收口）", () => {
    const store = createMemoryStore();
    const kernel = new Kernel(store, VERDICT_STATES, 0);
    expect(() =>
      kernel.register({ entityRef: REF, profileId: "p", firstTransition: { to: "bogus", occurredAt: at(1) } }),
    ).toThrow(/outside profile closed set/);
    expect(store.getEntity(REF.type, REF.key)).toBeUndefined();
    expect(store.outboxBatch(10)).toHaveLength(0);
    // 既有无 profileId 遗留实体同理：E16 补写随事务回滚
    store.putEntity({ type: REF.type, key: REF.key, state: "passed" });
    expect(() =>
      kernel.register({ entityRef: REF, profileId: "p", firstTransition: { to: "bogus", occurredAt: at(1) } }),
    ).toThrow(/outside profile closed set/);
    expect(store.getEntity(REF.type, REF.key)?.profileId).toBeUndefined();
  });

  it("register 首转换后游标推进：后续 publish 从新位点分配（同 id 异内容 corruption 收口）", () => {
    const store = createMemoryStore();
    const kernel = new Kernel(store, VERDICT_STATES, 0);
    kernel.register({ entityRef: REF, profileId: "p", firstTransition: { to: "waiting", occurredAt: at(1) } });
    expect(kernel.publish(REF, "passed", { occurredAt: at(2) })).toMatchObject({ eventSeq: 2 });
    expect(store.tx((tx) => tx.getEvent(deterministicEventId(REF, 2)))).toMatchObject({ to: "passed" });
    expect(store.outboxBatch(10).map((r) => r.eventSeq)).toEqual([1, 2]);
  });
});

describe("票 40 评审 F5 — query scope/session 过滤（开放订阅-实体 join）", () => {
  it("session/scope 过滤命中持有开放订阅的实体；closed 订阅不携带可见性；deadLetters 随 entity 可见性与自身 session 过滤", () => {
    const store = createMemoryStore();
    const kernel = new Kernel(store, VERDICT_STATES, 0);
    const e1 = { type: "fixture:widget", key: "external/1" };
    const e2 = { type: "fixture:widget", key: "external/2" };
    const e3 = { type: "fixture:widget", key: "external/3" };
    for (const e of [e1, e2, e3]) kernel.register({ entityRef: e, profileId: "p" });
    const base = { origin: "session" as const, createdAt: 1 };
    store.putSubscription({ subscriptionId: "sub-1", sessionId: "s1", entityRefType: e1.type, entityRefKey: e1.key, template: "t", ...base });
    store.putSubscription({ subscriptionId: "sub-2", sessionId: "s2", entityRefType: e2.type, entityRefKey: e2.key, template: "t", scope: "user", ...base });
    store.putSubscription({
      subscriptionId: "sub-3", sessionId: "s1", entityRefType: e3.type, entityRefKey: e3.key, template: "t",
      closedAt: 9, closedReason: "cancelled", ...base,
    });
    const keys = (r: { entities: { entityRef: { key: string } }[] }) => r.entities.map((e) => e.entityRef.key);
    expect(keys(kernel.query({ sessionId: "s1" }))).toEqual(["external/1"]);
    expect(keys(kernel.query({ scope: "user" }))).toEqual(["external/2"]);
    expect(keys(kernel.query({ scope: "project", sessionId: "s2" }))).toEqual([]);
    expect(kernel.query({}).entities).toHaveLength(3);
    // deadLetters：sessionId 直配 + entity 可见性
    store.putDelivery({ notificationId: "n1", sessionId: "s9", state: "dead-letter", recordEpoch: 0 });
    store.putDelivery({ notificationId: "n2", sessionId: "s1", state: "dead-letter", recordEpoch: 0 });
    store.tx((tx) => {
      tx.putEvent({ eventId: "n1", eventSeq: 1, entityRefType: e2.type, entityRefKey: e2.key, from: null, to: "failed", occurredAt: at(1) });
      tx.putEvent({ eventId: "n2", eventSeq: 2, entityRefType: e1.type, entityRefKey: e1.key, from: null, to: "failed", occurredAt: at(1) });
    });
    expect(kernel.query({ sessionId: "s1" }).deadLetters.map((d) => d.notificationId)).toEqual(["n2"]);
    expect(kernel.query({ sessionId: "s2" }).deadLetters.map((d) => d.notificationId)).toEqual([]);
    // scope 是实体可见性过滤（delivery 行无 scope）：实体经 user 订阅可见 → 其 dead-letter 可见
    expect(kernel.query({ scope: "user" }).deadLetters.map((d) => d.notificationId)).toEqual(["n1"]);
  });
});
