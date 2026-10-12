import { describe, it, expect } from "vitest";
import {
  createMemoryStore,
  MemoryStore,
  type EventRow,
  type DeliveryRowData,
  type EvidenceRow,
} from "./index.ts";

/** 与 domain/intent.ts 的七字段+键一致的事件行工厂（同名结构，D3 非 import）。 */
function ev(n: number, over: Partial<EventRow> = {}): EventRow {
  return {
    eventId: `evt:gitlab:mr-1#${n}`,
    eventSeq: n,
    entityRefType: "gitlab:mr",
    entityRefKey: "external/123",
    from: "running",
    to: "passed",
    contentIdentity: `sha-${n}`,
    occurredAt: `2026-10-12T00:00:${String(n).padStart(2, "0")}Z`,
    ...over,
  };
}

describe("ticket 09: Store 接口 + 内存 fake", () => {
  it("appendEventIfMissing：同 id 同内容 skipped / 同 id 异内容 corruption / 新 id appended", () => {
    const s = createMemoryStore();
    expect(s.appendEventIfMissing(ev(1)).kind).toBe("appended");
    expect(s.appendEventIfMissing(ev(1)).kind).toBe("skipped");
    expect(() => s.appendEventIfMissing(ev(1, { to: "failed" }))).toThrowError(/corruption/);
    expect(s.appendEventIfMissing(ev(2)).kind).toBe("appended");
  });

  it("I1 同事务：fn 抛错 = 全部回滚（X1 语义）", () => {
    const s = createMemoryStore();
    expect(() =>
      s.tx((tx) => {
        tx.putEntity({ type: "gitlab:mr", key: "external/1", state: null });
        tx.putEvent(ev(1));
        throw new Error("boom");
      }),
    ).toThrowError("boom");
    expect(s.getEntity("gitlab:mr", "external/1")).toBeUndefined();
    expect(s.queryEntities({})).toHaveLength(0);
  });

  it("tx 内写入事务外可见（提交后）", () => {
    const s = createMemoryStore();
    s.tx((tx) => {
      tx.putEntity({ type: "gitlab:mr", key: "external/1", state: "passed" });
    });
    expect(s.getEntity("gitlab:mr", "external/1")?.state).toBe("passed");
  });

  it("update_hook 等价：提交成功后按提交序同步触发（交错事务序不变）", () => {
    const s = createMemoryStore();
    const order: string[][] = [];
    s.onWrite((tables) => { order.push([...tables]); });
    s.tx((tx) => { tx.putEntity({ type: "a", key: "1", state: null }); });
    s.tx((tx) => { tx.putSubscription({ subscriptionId: "s1", sessionId: "sess", entityRefType: "a", entityRefKey: "1", origin: "session", createdAt: 0 }); });
    s.tx((tx) => { tx.putDelivery({ notificationId: "n1", sessionId: "sess", state: "pending", recordEpoch: 1 }); });
    expect(order).toEqual([["entities"], ["subscriptions"], ["deliveries"]]);
  });

  it("I10：同 (notification, session) 恰一行——按 key 存储 + upsert 覆盖不产第二行", () => {
    const s = createMemoryStore();
    const row: DeliveryRowData = { notificationId: "n1", sessionId: "sess1", state: "pending", recordEpoch: 1 };
    s.putDelivery(row);
    s.putDelivery({ ...row, state: "accepted" });
    expect(s.pendingDeliveries({})).toHaveLength(0); // accepted 非 pending
    expect(s.pendingDeliveries({ sessionId: "sess1" })).toHaveLength(0);
    const d = s.getDelivery("n1", "sess1");
    expect(d?.state).toBe("accepted");
  });

  it("pendingDeliveries / deadLetters 按 filter 直过滤，互不混入", () => {
    const s = createMemoryStore();
    const mk = (n: string, sess: string, state: DeliveryRowData["state"]): DeliveryRowData =>
      ({ notificationId: n, sessionId: sess, state, recordEpoch: 1 });
    s.tx((tx) => {
      tx.putDelivery(mk("n1", "sess1", "pending"));
      tx.putDelivery(mk("n2", "sess1", "dead-letter"));
      tx.putDelivery(mk("n3", "sess2", "pending"));
      tx.putDelivery(mk("n4", "sess1", "parked"));
    });
    expect(s.pendingDeliveries({ sessionId: "sess1" })).toHaveLength(1);
    expect(s.deadLetters({ sessionId: "sess1" })).toHaveLength(1);
    expect(s.pendingDeliveries({ sessionId: "sess2" })).toHaveLength(1);
    // deadLetters 不被 pendingDeliveries 混入（store spec：pendingDeliveries 不含 dead-letter）
    expect(s.pendingDeliveries({})).toHaveLength(2);
  });

  it("evidenceSearch：朴素子串匹配（fake 契约）", () => {
    const s = createMemoryStore();
    const rows: EvidenceRow[] = [
      { evidenceRef: "ev1", content: "pipeline finished with trace xyz", recordedAt: 1 },
      { evidenceRef: "ev2", content: "pod crashed", recordedAt: 2 },
    ];
    s.tx((tx) => { rows.forEach((r) => tx.putEvidence(r)); });
    expect(s.evidenceSearch("xyz")).toHaveLength(1);
    expect(s.evidenceSearch("ev2")).toHaveLength(1);
    expect(s.evidenceSearch("nope")).toHaveLength(0);
  });

  it("outboxBatch：limit 截断", () => {
    const s = createMemoryStore();
    s.tx((tx) => {
      tx.putEvent(ev(1));
      tx.putOutbox({ notificationId: "n1", eventSeq: 1 });
      tx.putOutbox({ notificationId: "n2", eventSeq: 2 });
      tx.putOutbox({ notificationId: "n3", eventSeq: 3 });
    });
    expect(s.outboxBatch(2)).toHaveLength(2);
    expect(s.outboxBatch(10)).toHaveLength(3);
  });

  it("X1 注入：事务中途崩溃，staging 丢弃且 committed 无残留", () => {
    const s = createMemoryStore();
    s.putEntity({ type: "gitlab:mr", key: "external/0", state: "running" });
    (s as MemoryStore).injectCrash("tx");
    expect(() =>
      s.tx((tx) => {
        tx.putEntity({ type: "gitlab:mr", key: "external/1", state: null });
        tx.putEvent(ev(9));
      }),
    ).toThrowError(/X1 crash/);
    // 注入一次性
    s.tx((tx) => { tx.putEntity({ type: "gitlab:mr", key: "external/1", state: "passed" }); });
    expect(s.getEntity("gitlab:mr", "external/1")?.state).toBe("passed");
    expect(s.queryEntities({ type: "gitlab:mr" })).toHaveLength(2);
  });

  it("X2 注入：已提交（staging）未写 outbox——回滚且记录 outboxPending", () => {
    const s = createMemoryStore();
    (s as MemoryStore).injectCrash("outbox");
    expect(() =>
      s.tx((tx) => {
        tx.putEvent(ev(7));
        tx.putOutbox({ notificationId: "n7", eventSeq: 7 });
      }),
    ).toThrowError(/X2 crash/);
    // 事务原子：outbox 未落库（重启后由重放补齐，appendIfMissing 幂等收口）
    expect(s.outboxBatch(10)).toHaveLength(0);
    expect((s as MemoryStore).getCommitOrder().at(-1)?.outboxPending).toHaveLength(1);
  });

  it("run_ledger：get/put/list + epoch 字段结构落位（D2）", () => {
    const s = createMemoryStore();
    s.putRunLedger({ slotKey: "gitlab:mr/external/1|gitlab-pipeline", epoch: 3, refcount: 2, consecutiveFails: 1 });
    expect(s.getRunLedger("gitlab:mr/external/1|gitlab-pipeline")?.epoch).toBe(3);
    expect(s.listRunLedger()).toHaveLength(1);
  });

  it("surface-pinning：接口面 = 枚举 + 三写方法裁决（2026-10-12, provisional enumeration-completion）", () => {
    const s = createMemoryStore();
    // 16 枚举 + putNotification/putEvidence/putOutbox
    for (const m of [
      "tx", "appendEventIfMissing",
      "getEntity", "putEntity", "getSubscription", "putSubscription",
      "getDelivery", "putDelivery", "getProbeSpec", "putProbeSpec",
      "queryEntities", "outboxBatch", "pendingDeliveries", "evidenceSearch",
      "notifications", "deadLetters",
      "getRunLedger", "putRunLedger", "listRunLedger",
      "onWrite",
      "putNotification", "putEvidence", "putOutbox",
    ] as const) {
      expect(typeof (s as unknown as Record<string, unknown>)[m]).toBe("function");
    }
    // TxView 同面
    s.tx((tx) => {
      for (const m of [
        "getEvent", "putEvent", "getEntity", "putEntity", "getSubscription", "putSubscription",
        "getDelivery", "putDelivery", "getProbeSpec", "putProbeSpec",
        "putNotification", "putEvidence", "putOutbox",
        "getRunLedger", "putRunLedger",
      ] as const) {
        expect(typeof (tx as unknown as Record<string, unknown>)[m]).toBe("function");
      }
    });
    // 无 delete 方法（evidence 保留期删除归票 28/L4，故意后置）
    expect((s as unknown as Record<string, unknown>).deleteEvidence).toBeUndefined();
    expect((s as unknown as Record<string, unknown>).deleteEvent).toBeUndefined();
  });

  it("notifications 按 sinceEventSeq 直过滤", () => {
    const s = createMemoryStore();
    s.tx((tx) => {
      tx.putNotification({ notificationId: "n1", eventSeq: 1, billboardJson: "{}" });
      tx.putNotification({ notificationId: "n2", eventSeq: 5, billboardJson: "{}" });
    });
    expect(s.notifications({})).toHaveLength(2);
    expect(s.notifications({ sinceEventSeq: 3 })).toHaveLength(1);
  });
});
