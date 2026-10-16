import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createMemoryStore,
  MemoryStore,
  type DeliveryRowData,
  type EventRow,
  type EvidenceRow,
  type Store,
  type SubscriptionRow,
} from "./index.ts";
import { defaultStorePath, SqliteStore } from "./sqlite.ts";

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

// --- 双实现同测试集（store spec B 层：fake 契约即验收契约，真实现重复通过） ---

const tmpDirs: string[] = [];
function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "eda-store-"));
  tmpDirs.push(dir);
  return join(dir, "store.db");
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function dualSuite(label: string, make: () => Store & { close?(): void }): void {
  describe(`Store 契约 — ${label}`, () => {
    it("appendEventIfMissing：同 id 同内容 skipped / 同 id 异内容 corruption / 新 id appended", () => {
      const s = make();
      expect(s.appendEventIfMissing(ev(1)).kind).toBe("appended");
      expect(s.appendEventIfMissing(ev(1)).kind).toBe("skipped");
      expect(() => s.appendEventIfMissing(ev(1, { to: "failed" }))).toThrowError(/corruption/);
      expect(s.appendEventIfMissing(ev(2)).kind).toBe("appended");
      s.close?.();
    });

    it("I1 同事务：fn 抛错 = 全部回滚（X1 语义）", () => {
      const s = make();
      expect(() =>
        s.tx((tx) => {
          tx.putEntity({ type: "gitlab:mr", key: "external/1", state: null });
          tx.putEvent(ev(1));
          throw new Error("boom");
        }),
      ).toThrowError("boom");
      expect(s.getEntity("gitlab:mr", "external/1")).toBeUndefined();
      expect(s.queryEntities({})).toHaveLength(0);
      s.close?.();
    });

    it("tx 内写入事务外可见（提交后）", () => {
      const s = make();
      s.tx((tx) => {
        tx.putEntity({ type: "gitlab:mr", key: "external/1", state: "passed" });
      });
      expect(s.getEntity("gitlab:mr", "external/1")?.state).toBe("passed");
      s.close?.();
    });

    it("update_hook 等价：提交成功后按提交序同步触发（交错事务序不变）", () => {
      const s = make();
      const order: string[][] = [];
      s.onWrite((tables) => { order.push([...tables]); });
      s.tx((tx) => { tx.putEntity({ type: "a", key: "1", state: null }); });
      s.tx((tx) => { tx.putSubscription({ subscriptionId: "s1", sessionId: "sess", entityRefType: "a", entityRefKey: "1", origin: "session", createdAt: 0 }); });
      s.tx((tx) => { tx.putDelivery({ notificationId: "n1", sessionId: "sess", state: "pending", recordEpoch: 1 }); });
      expect(order).toEqual([["entities"], ["subscriptions"], ["deliveries"]]);
      s.close?.();
    });

    it("重入提交：监听器内再提交排队至当前提交全部监听器之后（FIFO 不插队）", () => {
      const s = make();
      const log: string[] = [];
      let reentered = false;
      s.onWrite((tables) => {
        log.push(tables.join("+"));
        if (!reentered) {
          reentered = true;
          // 重入提交：当前提交的通知分发中途再提交，通知必须排到当前提交全部监听器之后
          s.tx((tx) => { tx.putSubscription({ subscriptionId: "s1", sessionId: "sess", entityRefType: "a", entityRefKey: "1", origin: "session", createdAt: 0 }); });
        }
      });
      s.onWrite((tables) => { log.push("L2:" + tables.join("+")); });
      s.tx((tx) => { tx.putEntity({ type: "a", key: "1", state: null }); });
      expect(log).toEqual(["entities", "L2:entities", "subscriptions", "L2:subscriptions"]);
      expect(s.getSubscription("s1")).toBeDefined();
      s.close?.();
    });

    it("I10：同 (notification, session) 恰一行——按 key 存储 + upsert 覆盖不产第二行", () => {
      const s = make();
      const row: DeliveryRowData = { notificationId: "n1", sessionId: "sess1", state: "pending", recordEpoch: 1 };
      s.putDelivery(row);
      s.putDelivery({ ...row, state: "accepted" });
      expect(s.pendingDeliveries({})).toHaveLength(0); // accepted 非 pending
      expect(s.pendingDeliveries({ sessionId: "sess1" })).toHaveLength(0);
      const d = s.getDelivery("n1", "sess1");
      expect(d?.state).toBe("accepted");
      s.close?.();
    });

    it("pendingDeliveries / deadLetters 按 filter 直过滤，互不混入", () => {
      const s = make();
      const mk = (n: string, sess: string, state: DeliveryRowData["state"]): DeliveryRowData =>
        ({ notificationId: n, sessionId: sess, state, recordEpoch: 1 });
      s.tx((tx) => {
        tx.putDelivery(mk("n1", "sess1", "pending"));
        tx.putDelivery(mk("n2", "sess1", "dead-letter"));
        tx.putDelivery(mk("n3", "sess2", "pending"));
        tx.putDelivery(mk("n4", "sess1", "parked"));
        tx.putDelivery(mk("n5", "sess1", "accepted"));
      });
      expect(s.pendingDeliveries({ sessionId: "sess1" })).toHaveLength(1);
      expect(s.deadLetters({ sessionId: "sess1" })).toHaveLength(1);
      expect(s.pendingDeliveries({ sessionId: "sess2" })).toHaveLength(1);
      // deadLetters 不被 pendingDeliveries 混入（store spec：pendingDeliveries 不含 dead-letter）
      expect(s.pendingDeliveries({})).toHaveLength(2);
      // parkedDeliveries 同构直过滤（票 11 drain D2a 输入面）：只取 parked，不混入其它 state
      expect(s.parkedDeliveries({ sessionId: "sess1" })).toHaveLength(1);
      expect(s.parkedDeliveries({})).toHaveLength(1);
      // acceptedDeliveries 同构直过滤（票 27 评审 H3：24h verified-absence 扫描输入面）
      expect(s.acceptedDeliveries({ sessionId: "sess1" })).toHaveLength(1);
      expect(s.acceptedDeliveries({})).toHaveLength(1);
      s.close?.();
    });

    it("querySubscriptions 按 filter 直过滤（票 11 fanOut 读面）", () => {
      const s = make();
      const mk = (id: string, refType: string, refKey: string, sess: string, origin: SubscriptionRow["origin"]): SubscriptionRow =>
        ({ subscriptionId: id, sessionId: sess, entityRefType: refType, entityRefKey: refKey, origin, createdAt: 0 });
      s.tx((tx) => {
        tx.putSubscription(mk("s1", "a", "1", "sess1", "session"));
        tx.putSubscription(mk("s2", "a", "1", "sess2", "auto"));
        tx.putSubscription(mk("s3", "a", "2", "sess1", "session"));
      });
      expect(s.querySubscriptions({ entityRefType: "a", entityRefKey: "1" }).map((r) => r.subscriptionId)).toEqual(["s1", "s2"]);
      expect(s.querySubscriptions({ sessionId: "sess1" }).map((r) => r.subscriptionId)).toEqual(["s1", "s3"]);
      expect(s.querySubscriptions({ origin: "auto" }).map((r) => r.subscriptionId)).toEqual(["s2"]);
      expect(s.querySubscriptions({})).toHaveLength(3);
      s.close?.();
    });

    it("evidenceSearch：FTS5 检索命中（fake 为朴素子串，真实现 MATCH；共享 token 形态测试集）", () => {
      const s = make();
      const rows: EvidenceRow[] = [
        { evidenceRef: "ev1", content: "pipeline finished with trace xyz", recordedAt: 1 },
        { evidenceRef: "ev2", content: "pod crashed", recordedAt: 2 },
      ];
      s.tx((tx) => { rows.forEach((r) => tx.putEvidence(r)); });
      expect(s.evidenceSearch("xyz")).toHaveLength(1);
      expect(s.evidenceSearch("ev2")).toHaveLength(1);
      expect(s.evidenceSearch("nope")).toHaveLength(0);
      s.close?.();
    });

    it("outboxBatch：limit 截断", () => {
      const s = make();
      s.tx((tx) => {
        tx.putEvent(ev(1));
        tx.putOutbox({ notificationId: "n1", eventSeq: 1 });
        tx.putOutbox({ notificationId: "n2", eventSeq: 2 });
        tx.putOutbox({ notificationId: "n3", eventSeq: 3 });
      });
      expect(s.outboxBatch(2)).toHaveLength(2);
      expect(s.outboxBatch(10)).toHaveLength(3);
      s.close?.();
    });

    it("run_ledger：get/put/list + epoch 字段结构落位（D2）", () => {
      const s = make();
      s.putRunLedger({ slotKey: "gitlab:mr/external/1|gitlab-pipeline", epoch: 3, refcount: 2, consecutiveFails: 1 });
      expect(s.getRunLedger("gitlab:mr/external/1|gitlab-pipeline")?.epoch).toBe(3);
      expect(s.listRunLedger()).toHaveLength(1);
      s.close?.();
    });

    it("surface-pinning：接口面 = 枚举 + 三写方法裁决（2026-10-12, provisional enumeration-completion）", () => {
      const s = make();
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
      s.close?.();
    });

    it("notifications 按 sinceEventSeq 直过滤", () => {
      const s = make();
      s.tx((tx) => {
        tx.putNotification({ notificationId: "n1", eventSeq: 1, billboardJson: "{}" });
        tx.putNotification({ notificationId: "n2", eventSeq: 5, billboardJson: "{}" });
      });
      expect(s.notifications({})).toHaveLength(2);
      expect(s.notifications({ sinceEventSeq: 3 })).toHaveLength(1);
      s.close?.();
    });

    it("onWrite 返回取消订阅：解除后不再触发、重复解除幂等（票 25 Finding 2：stop 不累积监听器）", () => {
      const s = make();
      const log: string[] = [];
      const offA = s.onWrite(() => log.push("A"));
      s.onWrite(() => log.push("B"));
      offA();
      offA(); // 幂等：重复解除不抛
      s.tx((tx) => { tx.putEntity({ type: "a", key: "1", state: null }); });
      expect(log).toEqual(["B"]); // 已解除的监听器不触发（不累积）
      s.close?.();
    });

    it("票 24 订阅生命周期字段写后即读全字段往返（评审 A1：check/on/once/flip/readyCheck/thresholds/closedAt/closedReason/phase）", () => {
      const s = make();
      const base = { subscriptionId: "s1", sessionId: "sess", entityRefType: "a", entityRefKey: "1", origin: "session" as const, createdAt: 5 };
      const full: SubscriptionRow = {
        ...base,
        template: "tpl",
        check: "fixture-cmd",
        on: "passed",
        once: true,
        flip: false,
        readyCheck: "ready-cmd",
        thresholds: { failureThreshold: 2, successThreshold: 3 },
        closedAt: 9,
        closedReason: "once-passed",
        phase: "flip",
      };
      s.putSubscription(full);
      expect(s.getSubscription("s1")).toEqual(full);
      // 缺省可选字段保持缺省（幂等比较/换参检测依赖 undefined 语义，不得伪造 false/0）
      s.putSubscription(base);
      expect(s.getSubscription("s1")).toEqual(base);
      s.close?.();
    });

    it("run_ledger 槽身份两字段写后即读往返（评审 A2：entityRefType/entityRefKey）+ 缺省保持缺省", () => {
      const s = make();
      s.putRunLedger({ slotKey: "k", epoch: 1, refcount: 2, consecutiveFails: 0, entityRefType: "a", entityRefKey: "external/1" });
      expect(s.getRunLedger("k")).toEqual({ slotKey: "k", epoch: 1, refcount: 2, consecutiveFails: 0, entityRefType: "a", entityRefKey: "external/1" });
      s.putRunLedger({ slotKey: "k2", epoch: 1, refcount: 0, consecutiveFails: 0 });
      expect(s.getRunLedger("k2")).toEqual({ slotKey: "k2", epoch: 1, refcount: 0, consecutiveFails: 0 });
      s.close?.();
    });

    it("notifications：非单调 eventSeq 下增量仍按插入序返回（下推后语义与 fake 对齐）", () => {
      const s = make();
      s.tx((tx) => {
        tx.putNotification({ notificationId: "a", eventSeq: 100, billboardJson: "{}" });
        tx.putNotification({ notificationId: "b", eventSeq: 5, billboardJson: "{}" });
        tx.putNotification({ notificationId: "c", eventSeq: 50, billboardJson: "{}" });
      });
      expect(s.notifications({ sinceEventSeq: 10 }).map((n) => n.notificationId)).toEqual(["a", "c"]);
      expect(s.notifications({}).map((n) => n.notificationId)).toEqual(["a", "b", "c"]);
      s.close?.();
    });
  });
}

dualSuite("memory fake", () => createMemoryStore());
dualSuite("真 SQLite（ticket 22）", () => new SqliteStore(tmpDbPath()));

// --- fake 注入面（第五停点，memory only） ---

describe("ticket 09: X1/X2 崩溃注入（fake only）", () => {
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
});

// --- ticket 22 B 层：真库专属断言 ---

describe("ticket 22: 真 SQLite（B 层）", () => {
  it("撕裂恢复：kill 模拟（原连接不 close）后重开库，已提交事务不丢", () => {
    const p = tmpDbPath();
    const s1 = new SqliteStore(p); // 故意不 close——进程死亡不会走 close（真 kill -9 归票 39）
    s1.tx((tx) => {
      tx.putEvent(ev(1));
      tx.putEntity({ type: "gitlab:mr", key: "external/123", state: "passed" });
      tx.putOutbox({ notificationId: "n1", eventSeq: 1 });
    });
    const s2 = new SqliteStore(p);
    expect(s2.getEntity("gitlab:mr", "external/123")?.state).toBe("passed");
    expect(s2.outboxBatch(10)).toHaveLength(1);
    expect(s2.getRunLedger("k")).toBeUndefined();
    s1.close();
    s2.close();
  });

  it("WAL：第二连接持有读事务时写者提交不被阻塞（读者不阻塞单写者）", () => {
    const p = tmpDbPath();
    const w = new SqliteStore(p);
    const r = new DatabaseSync(p);
    r.exec("BEGIN");
    r.prepare("SELECT * FROM entities").all(); // 读事务开启快照
    expect(() => w.tx((tx) => { tx.putEntity({ type: "a", key: "1", state: "s" }); })).not.toThrow();
    r.exec("COMMIT"); // 读者快照结束后可见新行
    expect(r.prepare("SELECT count(*) AS c FROM entities").get()).toEqual({ c: 1 });
    w.close();
    r.close();
  });

  it("D2 结构落库：表清单 + run_ledger(slot_key+epoch) + events append-only 拒 UPDATE/DELETE", () => {
    const s = new SqliteStore(tmpDbPath());
    s.putRunLedger({ slotKey: "gitlab:mr/external/1|gitlab-pipeline", epoch: 3, refcount: 2, consecutiveFails: 1 });
    const names = new Set(
      (s.db.prepare("SELECT name FROM sqlite_master").all() as Array<{ name: string }>).map((r) => r.name),
    );
    for (const t of ["events", "entities", "outbox", "subscriptions", "probe_specs", "deliveries", "notifications", "evidence", "entity_profile", "run_ledger", "evidence_fts"]) {
      expect(names.has(t)).toBe(true);
    }
    const cols = new Set(
      (s.db.prepare("SELECT name FROM pragma_table_info('run_ledger')").all() as Array<{ name: string }>).map((r) => r.name),
    );
    expect(cols.has("slot_key")).toBe(true);
    expect(cols.has("epoch")).toBe(true);
    s.appendEventIfMissing({ eventId: "e1", eventSeq: 1, entityRefType: "t", entityRefKey: "k", from: null, to: "s", occurredAt: "2026-10-12T00:00:00Z" });
    expect(() => s.db.exec("UPDATE events SET to_state = 'x'")).toThrowError(/append-only/);
    expect(() => s.db.exec("DELETE FROM events")).toThrowError(/append-only/);
    s.close();
  });

  it("evidence upsert：重写同 ref 更新 FTS 索引不残留旧 token", () => {
    const s = new SqliteStore(tmpDbPath());
    s.putEvidence({ evidenceRef: "e1", content: "first alpha", recordedAt: 1 });
    s.putEvidence({ evidenceRef: "e1", content: "second beta", recordedAt: 2 });
    expect(s.evidenceSearch("alpha")).toHaveLength(0);
    expect(s.evidenceSearch("beta")).toHaveLength(1);
    expect(s.evidenceSearch("e1")).toHaveLength(1);
    s.close();
  });

  it("notifications 增量下推：WHERE event_seq 走索引不搬运全表（EXPLAIN）+ 大历史行为等价", () => {
    const s = new SqliteStore(tmpDbPath());
    s.tx((tx) => {
      for (let i = 1; i <= 200; i++) tx.putNotification({ notificationId: `n${i}`, eventSeq: i, billboardJson: `{"i":${i}}` });
    });
    expect(s.notifications({ sinceEventSeq: 197 }).map((n) => n.notificationId)).toEqual(["n198", "n199", "n200"]);
    expect(s.notifications({})).toHaveLength(200);
    // SQL 层防回归：过滤下推且命中 event_seq 索引（JS 全表搬运 → EXPLAIN 无索引即红）
    const plan = (s.db.prepare("EXPLAIN QUERY PLAN SELECT rowid, * FROM notifications WHERE event_seq > ?").all(197) as Array<{ detail: string }>)
      .map((r) => r.detail).join("\n");
    expect(plan).toContain("idx_notifications_event_seq");
    expect(plan).toContain("event_seq>?");
    s.close();
  });

  it("putEvidence FTS 同步按基础表 rowid 对齐：新增+更新后行集合一致无孤儿（evidence_ref 全扫 → rowid 点删）", () => {
    const s = new SqliteStore(tmpDbPath());
    s.putEvidence({ evidenceRef: "e1", content: "alpha one", recordedAt: 1 });
    s.putEvidence({ evidenceRef: "e2", content: "beta two", recordedAt: 2 });
    s.putEvidence({ evidenceRef: "e1", content: "alpha three", recordedAt: 3 }); // 更新场景
    // rowid 对齐 = DELETE WHERE rowid 点删的前提；更新后 FTS 行集必须等于基础表行集
    const baseIds = (s.db.prepare("SELECT rowid FROM evidence ORDER BY rowid").all() as Array<{ rowid: number }>).map((r) => Number(r.rowid));
    const ftsIds = (s.db.prepare("SELECT rowid FROM evidence_fts ORDER BY rowid").all() as Array<{ rowid: number }>).map((r) => Number(r.rowid));
    expect(ftsIds).toEqual(baseIds);
    expect(s.db.prepare("SELECT count(*) AS c FROM evidence_fts").get()).toEqual({ c: 2 });
    // 检索语义不回归：旧 token 清除、新 token 命中
    expect(s.evidenceSearch("one")).toHaveLength(0);
    expect(s.evidenceSearch("three")).toHaveLength(1);
    expect(s.evidenceSearch("beta")).toHaveLength(1);
    s.close();
  });

  it("迁移幂等：旧版库缺票 24/26 列 → 开库自动补列，旧行可读、新字段读写可用", () => {
    const p = tmpDbPath();
    // 手工建旧版（票 22 时刻）schema + 一条旧订阅行
    const raw = new DatabaseSync(p);
    raw.exec(
      `CREATE TABLE subscriptions (
        subscription_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        entity_ref_type TEXT NOT NULL,
        entity_ref_key TEXT NOT NULL,
        template TEXT,
        origin TEXT NOT NULL,
        scope TEXT,
        created_at INTEGER NOT NULL,
        ttl_ms INTEGER
      );
      CREATE TABLE run_ledger (
        slot_key TEXT PRIMARY KEY,
        epoch INTEGER NOT NULL,
        refcount INTEGER NOT NULL,
        consecutive_fails INTEGER NOT NULL,
        last_verdict TEXT,
        next_due_at INTEGER
      );`,
    );
    raw.prepare("INSERT INTO subscriptions (subscription_id, session_id, entity_ref_type, entity_ref_key, origin, created_at) VALUES ('legacy', 'sess', 'a', '1', 'session', 0)").run();
    raw.close();

    const s = new SqliteStore(p);
    expect(s.getSubscription("legacy")).toMatchObject({ subscriptionId: "legacy", createdAt: 0 }); // 旧行可读
    // 新字段经补列后写入即读（幂等关闭簿记/阈值/相位全走持久层）
    const row = s.getSubscription("legacy")!;
    s.putSubscription({ ...row, check: "cmd", once: true, closedAt: 7, closedReason: "cancelled", thresholds: { failureThreshold: 2, successThreshold: 2 } });
    expect(s.getSubscription("legacy")).toMatchObject({
      check: "cmd",
      once: true,
      closedAt: 7,
      closedReason: "cancelled",
      thresholds: { failureThreshold: 2, successThreshold: 2 },
    });
    s.putRunLedger({ slotKey: "k", epoch: 0, refcount: 1, consecutiveFails: 0, entityRefType: "a", entityRefKey: "1" });
    expect(s.getRunLedger("k")).toMatchObject({ entityRefType: "a", entityRefKey: "1" });
    s.close();

    // 重开：迁移重复执行不抛（幂等），数据保持
    const s2 = new SqliteStore(p);
    expect(s2.getSubscription("legacy")?.check).toBe("cmd");
    s2.close();
  });

  it("defaultStorePath：正典数据布局形状（不触盘）", () => {
    expect(defaultStorePath().endsWith(join(".pi", "data", "pi-events", "store.db"))).toBe(true);
  });
});
