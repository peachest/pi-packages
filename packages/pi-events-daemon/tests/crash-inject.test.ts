/**
 * Ticket 23 — X1/X2 崩溃注入验收（第五停点恢复语义收口）+ 链 C 里程碑 e2e（B 层进程外）。
 *
 * 与票 15 的分工：15 证明注入面可达（映射表逐类样例）；23 验证注入后的完整恢复语义：
 *  - X1（事务中途）：回滚零残留——真消费链（L0 → kernel.transition）重试界内吸收，游标不烧号
 *    （F1：提交失败不推进），终态与无崩溃基线逐位相等；
 *  - X2（已提交未写 outbox）：注入中止留痕（outbox 缺席 + commitOrder.outboxPending 重放输入），
 *    重启重放补齐（位点自真相源恢复 → 同确定性 eventId，重放不重新编号），appendIfMissing
 *    幂等收口无重复事件；kernel 进程未死时同一注入被重试界内吸收。
 *
 * 链 C 里程碑（B 层进程外）：FakeExec probe → completion queue 回流（D4）→ L0 唯一写者
 * → kernel.transition 落 store（event+entity+outbox）→ fanOut 物化 notification/delivery
 * →（进程外 leg）session transcript 落盘（extension 忠实转写 daemon 物化的 billboard）
 * → transcript-adapter verify 以 daemon 铸造的 notificationId 点查——probe verdict 闭环可查。
 *
 * 位置：integration 测试文件（票面允许）；tests/ 受 tests-through-entrypoints 约束，经包根
 * 入口命名空间导入（同 fx-mapping.test.ts 惯例）。domain entrypoint 尚未接线（ticket 01 壳），
 * 确定性 event id 正典格式（deterministicEventId = evt:<type>:<key>#<decisionOrder>）以 fixture
 * 字面量钉住；断言一律走 store 观测面，不自铸 id。
 */
import { describe, expect, it } from "vitest";
import { fx, kernel, loops, prober, store, transcriptAdapter } from "../index.ts";

const { FakeClock, FakeExec, FakeFs, FakePusher } = fx;

// --- fixture（数据，非 profile；kernel.test/loops.test 同法）---
const REF = { type: "fixture:widget", key: "external/fixture-1" } as const;
const STATES = new Set(["passed", "failed", "waiting"]);
const at = (n: number) => `2026-10-12T00:00:${String(n).padStart(2, "0")}Z`;
/** 微任务冲刷：FakeExec 立即 resolve，settle→回流经微任务落地（prober.test 同法）。 */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const SESSION_ID = "s1";
const SESSION_FILE = "/sessions/s1.jsonl";
/** 最小 v3 头（isHeaderV3 判据 type==="session" && version===3 的最小形）。 */
const V3_HEADER = '{"type":"session","version":3}';

/** 确定性 event id 正典格式钉死（见文件头注）：fixture 唯一字面量，消费方全走 store 观测面。 */
const EVENT_ID_1 = "evt:fixture:widget:external/fixture-1#1";

type MemStore = ReturnType<typeof store.createMemoryStore>;

const seed = (s: store.Store): void => void s.putEntity({ type: REF.type, key: REF.key, state: "passed" });

const makeCtx = (s: store.Store): loops.LoopsCtx => ({
  clock: new FakeClock(),
  exec: new FakeExec(),
  pusher: new FakePusher(),
  fs: new FakeFs(),
  store: s,
  states: STATES,
});

/** store 观测面快照：实体态 + 事件语义面（outbox 与 transition 1:1）+ 提交序（孤儿半事务留痕检查）。 */
const snapshot = (s: MemStore) => ({
  entity: s.getEntity(REF.type, REF.key)?.state,
  events: s.outboxBatch(Number.MAX_SAFE_INTEGER).map((r) => {
    const e = s.tx((tx) => tx.getEvent(r.notificationId)!);
    return { eventId: e.eventId, eventSeq: e.eventSeq, from: e.from, to: e.to };
  }),
  commits: s.getCommitOrder().map((c) => c.tables),
});

/** v3 通知条目行（extension 转写形，adapter.test 同构）：机器三元组住 details。 */
const v3NotificationLine = (notificationId: string, verdict: string): string =>
  JSON.stringify({
    type: "custom_message",
    customType: transcriptAdapter.NOTIFICATION_CUSTOM_TYPE,
    content: `billboard: ${notificationId}`,
    display: true,
    details: { notificationId, verdict },
    id: "e2",
    parentId: "e1",
    timestamp: "2026-10-12T00:00:01.000Z",
  });

describe("票 23 组 1：X1 事务中途崩溃 → 回滚无残留（消费链重试吸收收口）", () => {
  it("注入 → L0 消费链重试界内吸收：终态与无崩溃基线逐位相等、无孤儿半事务、游标不烧号续发无空洞", () => {
    const baseline = store.createMemoryStore();
    seed(baseline);
    const base = loops.startLoops(makeCtx(baseline));
    base.submit({ kind: "transition", ref: REF, verdict: "failed", occurredAt: at(1) });

    const crashed = store.createMemoryStore();
    seed(crashed);
    crashed.injectCrash("tx"); // 第五停点：事务中途崩溃（先 seed 后 arm——seed 自身走 tx）
    const l = loops.startLoops(makeCtx(crashed));
    l.submit({ kind: "transition", ref: REF, verdict: "failed", occurredAt: at(1) });

    expect(l.errors).toEqual([]); // 重试界内吸收，无 dead-letter
    expect(snapshot(crashed)).toEqual(snapshot(baseline)); // 回滚零残留：终态逐位相等
    expect(snapshot(crashed).entity).toBe("failed");
    expect(snapshot(crashed).events).toEqual([
      { eventId: EVENT_ID_1, eventSeq: 1, from: "passed", to: "failed" },
    ]);

    // 游标不烧号（F1）：失败尝试不推进——续发转换接 eventSeq 2 / decisionOrder 2，无空洞
    l.submit({ kind: "transition", ref: REF, verdict: "passed", occurredAt: at(2) });
    expect(snapshot(crashed).events.map((e) => e.eventSeq)).toEqual([1, 2]);
  });
});

describe("票 23 组 2：X2 已提交未写 outbox → 重启补齐、无重复事件（重放幂等收口）", () => {
  it("注入中止留痕（outbox 缺席 + outboxPending 重放输入）；重启 L0 重放补齐——同确定性 id 不重新编号", () => {
    const s = store.createMemoryStore();
    seed(s);

    // 崩溃进程：X2 注入——mutation 写形镜像 kernel.consumeTx（事件+实体+outbox 同事务 I1），
    // 注入点 = transition 提交后、outbox 提交前；无进程内重试 = 进程死亡语义
    s.injectCrash("outbox");
    expect(() =>
      s.tx((tx) => {
        tx.putEvent({
          eventId: EVENT_ID_1,
          eventSeq: 1,
          entityRefType: REF.type,
          entityRefKey: REF.key,
          from: "passed",
          to: "failed",
          occurredAt: at(1),
        });
        tx.putEntity({ type: REF.type, key: REF.key, state: "failed" });
        tx.putOutbox({ notificationId: EVENT_ID_1, eventSeq: 1 }); // 注入点：outbox 写步
      }),
    ).toThrow(/X2 crash/);

    // 崩溃现场（fake 原子语义）：outbox 缺席、事件/实体回滚；outboxPending 留重放输入
    // （标记断言须先于任何只读 tx——只读提交也入 commitOrder，会顶掉 .at(-1)）
    expect(s.outboxBatch(10)).toHaveLength(0);
    expect(s.getEntity(REF.type, REF.key)?.state).toBe("passed");
    expect(s.getCommitOrder().at(-1)?.outboxPending).toEqual([
      { notificationId: EVENT_ID_1, eventSeq: 1 },
    ]);
    expect(s.tx((tx) => tx.getEvent(EVENT_ID_1))).toBeUndefined();

    // 重启：二次接线——双轨位点自真相源恢复（outbox 空 → 0），L0 重放同一 mutation
    const rebooted = loops.startLoops(makeCtx(s));
    rebooted.submit({ kind: "transition", ref: REF, verdict: "failed", occurredAt: at(1) });

    // 补齐：outbox 行落地、实体推进；重放不重新编号（同确定性 eventId、同 eventSeq）
    expect(s.outboxBatch(10)).toEqual([{ notificationId: EVENT_ID_1, eventSeq: 1 }]);
    expect(s.tx((tx) => tx.getEvent(EVENT_ID_1))).toMatchObject({
      eventId: EVENT_ID_1,
      eventSeq: 1,
      from: "passed",
      to: "failed",
    });
    expect(s.getEntity(REF.type, REF.key)?.state).toBe("failed");

    // 无重复事件（重放幂等收口）：同态重发不发事件（ADR 0003）+ 同 id 同内容 intent 消费 skipped（I10）
    rebooted.submit({ kind: "transition", ref: REF, verdict: "failed", occurredAt: at(1) });
    rebooted.submit({
      kind: "consumeIntent",
      intent: {
        eventId: EVENT_ID_1,
        eventSeq: 1,
        entityRef: REF,
        from: "passed",
        to: "failed",
        occurredAt: at(1),
        decisionOrder: 1,
      },
    });
    expect(s.outboxBatch(10)).toHaveLength(1); // 事件流仍恰一行（outbox 与 transition 1:1）
    expect(rebooted.errors).toEqual([]);
  });

  it("X2 注入经真消费方：进程未死时 L0 消费链重试界内吸收——同事务重排落齐 outbox 恰一行", () => {
    const s = store.createMemoryStore();
    seed(s);
    s.injectCrash("outbox");
    const l = loops.startLoops(makeCtx(s));
    l.submit({ kind: "transition", ref: REF, verdict: "failed", occurredAt: at(1) });

    expect(l.errors).toEqual([]); // kernel 重试吸收（F1：游标只在提交成功后推进，重排同 id）
    expect(s.outboxBatch(10)).toEqual([{ notificationId: EVENT_ID_1, eventSeq: 1 }]);
    expect(s.getEntity(REF.type, REF.key)?.state).toBe("failed");
  });
});

describe("票 23 组 3：链 C 里程碑 e2e（B 层进程外）——probe → queue 回流 → store 落盘 → TADP verify 可查", () => {
  it("probe verdict 经回流落 store，daemon 铸造的 notificationId 为 I9 点查键，verify 闭环可查", async () => {
    const s = store.createMemoryStore();
    seed(s);
    s.putSubscription({
      subscriptionId: "sub-1",
      sessionId: SESSION_ID,
      entityRefType: REF.type,
      entityRefKey: REF.key,
      origin: "session",
      scope: "project",
      createdAt: 0,
    });
    const l = loops.startLoops(makeCtx(s));

    const exec = new FakeExec();
    exec.enqueue({ exitCode: 2, stdout: "FAIL: widget missing\n" }); // 平台原形：2 = failed 断言
    const queued: prober.ProbeResult[] = [];
    // D4 completion queue 回流：verdict 请求进 L0 唯一写者（L1 接线前的 B 层装配形）
    const p = new prober.Prober({
      exec,
      clock: new FakeClock(),
      onResult: (r) => {
        queued.push(r);
        l.submit({ kind: "transition", ref: REF, verdict: r.verdict, occurredAt: at(1) });
      },
    });

    p.probe({ slotKey: "slot-1", check: "check-widget" });
    await tick();

    // 回流可见：verdict 语义名 + 掩码后 evidence，退出码不外泄
    expect(queued).toEqual([
      { slotKey: "slot-1", verdict: "failed", reason: "exit 2", evidence: "FAIL: widget missing\n", durationMs: 0 },
    ]);
    // store 落盘：transition 语义面（事件+实体+outbox）
    const [outbox] = s.outboxBatch(1);
    const notificationId = outbox!.notificationId; // daemon 铸造（I1 与 transition 1:1）
    expect(s.tx((tx) => tx.getEvent(notificationId)!)).toMatchObject({
      eventId: notificationId,
      eventSeq: 1,
      from: "passed",
      to: "failed",
    });
    expect(s.getEntity(REF.type, REF.key)?.state).toBe("failed");

    // 投递面：fanOut 物化 notification（billboard verdict = probe verdict）+ pending delivery
    new kernel.Kernel(s, STATES, 1).fanOut(notificationId, {
      activeSessions: [{ sessionId: SESSION_ID, scope: "project" }],
    });
    const billboard = JSON.parse(s.notifications({})[0]!.billboardJson) as { verdict: string };
    expect(billboard.verdict).toBe("failed");
    expect(s.pendingDeliveries({ sessionId: SESSION_ID })).toEqual([
      { notificationId, sessionId: SESSION_ID, state: "pending", recordEpoch: 0 },
    ]);

    // 进程外 leg：session transcript 落盘——extension 忠实转写 daemon 物化的通知（daemon 只读）
    const fs = new FakeFs({ [SESSION_FILE]: `${V3_HEADER}\n` });
    fs.files.set(SESSION_FILE, `${V3_HEADER}\n${v3NotificationLine(notificationId, billboard.verdict)}\n`);

    // TADP verify：probe 产生的 verdict（exit 2）闭环可查，notificationId 为点查键
    expect(
      await transcriptAdapter.createTranscriptAdapter(fs).verify({ sessionFile: SESSION_FILE }, notificationId),
    ).toEqual({ verdict: "failed", format: "v3" });
  });
});
