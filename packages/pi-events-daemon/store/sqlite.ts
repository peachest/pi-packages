/**
 * store/sqlite — 真 SQLite adapter（ticket 22）。实现 Store 接口（./index.ts）。
 *
 * 驱动 = node:sqlite 内置模块（零第三方依赖；daemon 不 import 第三方库的正典约束，
 * store 驱动属基础设施且 node:sqlite 为正典最优解）。
 *
 * 契约来源（与 MemoryStore 相同的两条钉死契约）：
 *  1. update_hook 等价回调 = 提交成功后按提交序同步触发。node:sqlite 未暴露
 *     sqlite3_update_hook（原生 hook 是逐语句触发、先于 COMMIT，不满足本契约），
 *     故在提交边界用写跟踪实现等价回调：tx 内 put* 标记触碰表，COMMIT 成功后
 *     按首次触碰序同步触发 listener。
 *  2. X1/X2 注入 = fake only，真实现为 no-op——SQLite 事务原子性天然覆盖
 *     （fn 抛错 = ROLLBACK，已提交事务不受进程崩溃影响，WAL 保证）。
 *
 * 数据布局正典（#31）：~/.pi/data/pi-events/store.db；表清单 = #31 D2 投票定案。
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import {
  sameEventContent,
  type DeliveryFilter,
  type DeliveryRowData,
  type EntityFilter,
  type EntityRow,
  type EventRow,
  type EvidenceRow,
  type NotificationFilter,
  type NotificationRow,
  type OutboxRow,
  type ProbeSpecRow,
  type RunLedgerRow,
  type Store,
  type SubscriptionFilter,
  type SubscriptionRow,
  type TxView,
} from "./index.ts";

/** 正典默认路径（#31 数据布局）。独立导出供测试断言形状（不落盘）。 */
export function defaultStorePath(): string {
  return join(homedir(), ".pi", "data", "pi-events", "store.db");
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  event_seq INTEGER NOT NULL,
  entity_ref_type TEXT NOT NULL,
  entity_ref_key TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  content_identity TEXT,
  occurred_at TEXT NOT NULL,
  evidence_ref TEXT
);
CREATE TABLE IF NOT EXISTS entities (
  type TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  state TEXT,
  payload_json TEXT,
  profile_id TEXT,
  parent_type TEXT,
  parent_key TEXT,
  retired INTEGER,
  PRIMARY KEY (type, entity_key)
);
CREATE TABLE IF NOT EXISTS outbox (
  notification_id TEXT PRIMARY KEY,
  event_seq INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS subscriptions (
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
CREATE TABLE IF NOT EXISTS probe_specs (
  slot_key TEXT PRIMARY KEY,
  check_name TEXT NOT NULL,
  schedule_json TEXT NOT NULL,
  source TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deliveries (
  notification_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  state TEXT NOT NULL,
  record_epoch INTEGER NOT NULL,
  PRIMARY KEY (notification_id, session_id)
);
CREATE TABLE IF NOT EXISTS notifications (
  notification_id TEXT PRIMARY KEY,
  event_seq INTEGER NOT NULL,
  billboard_json TEXT NOT NULL,
  evidence_ref TEXT
);
-- notifications 增量查询（sinceEventSeq）下推：全表搬运反模式收口（ocr 评审 finding 2）
CREATE INDEX IF NOT EXISTS idx_notifications_event_seq ON notifications(event_seq);
CREATE TABLE IF NOT EXISTS evidence (
  evidence_ref TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS evidence_fts USING fts5(evidence_ref, content);
-- entity_profile：D2 表清单成员，暂无 Store 方法（接口面已定死，访问器随 profile 注册表消费票落地）
CREATE TABLE IF NOT EXISTS entity_profile (
  profile_id TEXT PRIMARY KEY,
  definition_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS run_ledger (
  slot_key TEXT PRIMARY KEY,
  epoch INTEGER NOT NULL,
  refcount INTEGER NOT NULL,
  consecutive_fails INTEGER NOT NULL,
  last_verdict TEXT,
  next_due_at INTEGER
);
-- events append-only（D2）：UPDATE/DELETE 在库层拒绝（事件流永久保留；无 Store delete 路径）
CREATE TRIGGER IF NOT EXISTS events_append_only_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_append_only_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
`;

/** node:sqlite 行值域（SQLOutputValue 的本地形状，不依赖类型导出面）。 */
type RawRow = Record<string, null | number | bigint | string | Uint8Array>;

const str = (v: RawRow[string]): string | undefined => (v === null || v === undefined ? undefined : String(v));
const num = (v: RawRow[string]): number | undefined => (v === null || v === undefined ? undefined : Number(v));
const bool = (v: RawRow[string]): boolean | undefined => (v === null || v === undefined ? undefined : v !== 0);

function rowToEvent(r: RawRow): EventRow {
  return {
    eventId: String(r.event_id),
    eventSeq: Number(r.event_seq),
    entityRefType: String(r.entity_ref_type),
    entityRefKey: String(r.entity_ref_key),
    from: r.from_state === null || r.from_state === undefined ? null : String(r.from_state),
    to: String(r.to_state),
    ...(r.content_identity === null || r.content_identity === undefined ? {} : { contentIdentity: String(r.content_identity) }),
    occurredAt: String(r.occurred_at),
    ...(r.evidence_ref === null || r.evidence_ref === undefined ? {} : { evidenceRef: String(r.evidence_ref) }),
  };
}

function rowToEntity(r: RawRow): EntityRow {
  return {
    type: String(r.type),
    key: String(r.entity_key),
    state: r.state === null || r.state === undefined ? null : String(r.state),
    ...(r.payload_json === null || r.payload_json === undefined ? {} : { payload: JSON.parse(String(r.payload_json)) }),
    ...str(r.profile_id) !== undefined ? { profileId: str(r.profile_id) } : {},
    ...str(r.parent_type) !== undefined ? { parentType: str(r.parent_type) } : {},
    ...str(r.parent_key) !== undefined ? { parentKey: str(r.parent_key) } : {},
    ...bool(r.retired) !== undefined ? { retired: bool(r.retired) } : {},
  };
}

function rowToSubscription(r: RawRow): SubscriptionRow {
  return {
    subscriptionId: String(r.subscription_id),
    sessionId: String(r.session_id),
    entityRefType: String(r.entity_ref_type),
    entityRefKey: String(r.entity_ref_key),
    ...str(r.template) !== undefined ? { template: str(r.template) } : {},
    origin: String(r.origin) as SubscriptionRow["origin"],
    ...str(r.scope) !== undefined ? { scope: str(r.scope) as SubscriptionRow["scope"] } : {},
    createdAt: Number(r.created_at),
    ...num(r.ttl_ms) !== undefined ? { ttlMs: num(r.ttl_ms) } : {},
  };
}

function rowToDelivery(r: RawRow): DeliveryRowData {
  return {
    notificationId: String(r.notification_id),
    sessionId: String(r.session_id),
    state: String(r.state) as DeliveryRowData["state"],
    recordEpoch: Number(r.record_epoch),
  };
}

function rowToProbeSpec(r: RawRow): ProbeSpecRow {
  return {
    slotKey: String(r.slot_key),
    check: String(r.check_name),
    schedule: JSON.parse(String(r.schedule_json)) as ProbeSpecRow["schedule"],
    source: String(r.source) as ProbeSpecRow["source"],
  };
}

function rowToNotification(r: RawRow): NotificationRow {
  return {
    notificationId: String(r.notification_id),
    eventSeq: Number(r.event_seq),
    billboardJson: String(r.billboard_json),
    ...str(r.evidence_ref) !== undefined ? { evidenceRef: str(r.evidence_ref) } : {},
  };
}

function rowToRunLedger(r: RawRow): RunLedgerRow {
  return {
    slotKey: String(r.slot_key),
    epoch: Number(r.epoch),
    refcount: Number(r.refcount),
    consecutiveFails: Number(r.consecutive_fails),
    ...str(r.last_verdict) !== undefined ? { lastVerdict: str(r.last_verdict) as RunLedgerRow["lastVerdict"] } : {},
    ...num(r.next_due_at) !== undefined ? { nextDueAt: num(r.next_due_at) } : {},
  };
}

export class SqliteStore implements Store {
  /** 测试/诊断专用：底层连接（D2 结构断言、WAL 并发验证；Store 接口本身不暴露 SQL）。 */
  readonly db: DatabaseSync;
  private readonly stmts = new Map<string, StatementSync>();
  private readonly writeListeners: Array<(tables: readonly string[]) => void> = [];
  /** 提交通知队列 + 分发中标记：重入提交（监听器内再提交）排到当前提交全部监听器之后（FIFO）。 */
  private readonly notifyQueue: string[][] = [];
  private dispatching = false;

  constructor(path: string = defaultStorePath()) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { timeout: 5000 });
    this.db.exec("PRAGMA journal_mode = WAL"); // 读者不阻塞单写者（#31 WAL 裁定）
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** 第五停点（fake only，真实现 no-op）：SQLite 事务原子性天然覆盖 X1/X2。 */
  injectCrash(_point: "tx" | "outbox"): void {}

  onWrite(cb: (tables: readonly string[]) => void): () => void {
    this.writeListeners.push(cb);
    return () => {
      const i = this.writeListeners.indexOf(cb);
      if (i >= 0) this.writeListeners.splice(i, 1);
    };
  }

  private st(sql: string): StatementSync {
    let stmt = this.stmts.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.stmts.set(sql, stmt);
    }
    return stmt;
  }

  tx<T>(fn: (tx: TxView) => T): T {
    const touched = new Set<string>();
    const mark = (table: string) => touched.add(table);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn(this.txView(mark));
      this.db.exec("COMMIT");
      // update_hook 等价：提交成功后按提交序同步触发（与 fake 语义一致；重入提交排队见 notifyCommit）
      this.notifyCommit([...touched]);
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // 连接已中止（如 BUSY 超时）——无需回滚
      }
      throw err;
    }
  }

  private notifyCommit(tables: string[]): void {
    this.notifyQueue.push(tables);
    if (this.dispatching) return; // 重入提交：外层分发循环收尾时按 FIFO 继续
    this.dispatching = true;
    try {
      while (this.notifyQueue.length > 0) {
        const batch = this.notifyQueue.shift()!;
        // 快照分发：监听器内取消订阅（含自解除）不影响本批已入快照的分发，后续提交不再触发
        for (const cb of [...this.writeListeners]) cb(batch);
      }
    } finally {
      this.dispatching = false;
    }
  }

  private txView(mark: (table: string) => void): TxView {
    return {
      getEvent: (eventId) => {
        const r = this.st("SELECT * FROM events WHERE event_id = ?").get(eventId) as RawRow | undefined;
        return r && rowToEvent(r);
      },
      putEvent: (row) => {
        // 事件写只走追加（appendEventIfMissing 守卫在前）；同 id 直写由 PRIMARY KEY 拒绝（corruption 面）
        this.st("INSERT INTO events (event_id, event_seq, entity_ref_type, entity_ref_key, from_state, to_state, content_identity, occurred_at, evidence_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
          row.eventId, row.eventSeq, row.entityRefType, row.entityRefKey, row.from ?? null, row.to,
          row.contentIdentity ?? null, row.occurredAt, row.evidenceRef ?? null,
        );
        mark("events");
      },
      getEntity: (type, key) => {
        const r = this.st("SELECT * FROM entities WHERE type = ? AND entity_key = ?").get(type, key) as RawRow | undefined;
        return r && rowToEntity(r);
      },
      putEntity: (row) => {
        this.st("INSERT INTO entities (type, entity_key, state, payload_json, profile_id, parent_type, parent_key, retired) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (type, entity_key) DO UPDATE SET state = excluded.state, payload_json = excluded.payload_json, profile_id = excluded.profile_id, parent_type = excluded.parent_type, parent_key = excluded.parent_key, retired = excluded.retired").run(
          row.type, row.key, row.state ?? null, row.payload === undefined ? null : JSON.stringify(row.payload),
          row.profileId ?? null, row.parentType ?? null, row.parentKey ?? null,
          row.retired === undefined ? null : Number(row.retired),
        );
        mark("entities");
      },
      getSubscription: (subscriptionId) => {
        const r = this.st("SELECT * FROM subscriptions WHERE subscription_id = ?").get(subscriptionId) as RawRow | undefined;
        return r && rowToSubscription(r);
      },
      putSubscription: (row) => {
        this.st("INSERT INTO subscriptions (subscription_id, session_id, entity_ref_type, entity_ref_key, template, origin, scope, created_at, ttl_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (subscription_id) DO UPDATE SET session_id = excluded.session_id, entity_ref_type = excluded.entity_ref_type, entity_ref_key = excluded.entity_ref_key, template = excluded.template, origin = excluded.origin, scope = excluded.scope, created_at = excluded.created_at, ttl_ms = excluded.ttl_ms").run(
          row.subscriptionId, row.sessionId, row.entityRefType, row.entityRefKey,
          row.template ?? null, row.origin, row.scope ?? null, row.createdAt, row.ttlMs ?? null,
        );
        mark("subscriptions");
      },
      getDelivery: (notificationId, sessionId) => {
        const r = this.st("SELECT * FROM deliveries WHERE notification_id = ? AND session_id = ?").get(notificationId, sessionId) as RawRow | undefined;
        return r && rowToDelivery(r);
      },
      putDelivery: (row) => {
        this.st("INSERT INTO deliveries (notification_id, session_id, state, record_epoch) VALUES (?, ?, ?, ?) ON CONFLICT (notification_id, session_id) DO UPDATE SET state = excluded.state, record_epoch = excluded.record_epoch").run(
          row.notificationId, row.sessionId, row.state, row.recordEpoch,
        );
        mark("deliveries");
      },
      getProbeSpec: (slotKey) => {
        const r = this.st("SELECT * FROM probe_specs WHERE slot_key = ?").get(slotKey) as RawRow | undefined;
        return r && rowToProbeSpec(r);
      },
      putProbeSpec: (row) => {
        this.st("INSERT INTO probe_specs (slot_key, check_name, schedule_json, source) VALUES (?, ?, ?, ?) ON CONFLICT (slot_key) DO UPDATE SET check_name = excluded.check_name, schedule_json = excluded.schedule_json, source = excluded.source").run(
          row.slotKey, row.check, JSON.stringify(row.schedule), row.source,
        );
        mark("probe_specs");
      },
      putNotification: (row) => {
        this.st("INSERT INTO notifications (notification_id, event_seq, billboard_json, evidence_ref) VALUES (?, ?, ?, ?) ON CONFLICT (notification_id) DO UPDATE SET event_seq = excluded.event_seq, billboard_json = excluded.billboard_json, evidence_ref = excluded.evidence_ref").run(
          row.notificationId, row.eventSeq, row.billboardJson, row.evidenceRef ?? null,
        );
        mark("notifications");
      },
      putEvidence: (row) => {
        this.st("INSERT INTO evidence (evidence_ref, content, recorded_at) VALUES (?, ?, ?) ON CONFLICT (evidence_ref) DO UPDATE SET content = excluded.content, recorded_at = excluded.recorded_at").run(
          row.evidenceRef, row.content, row.recordedAt,
        );
        // FTS5 同步按基础表 rowid 对齐：evidence_ref 非 FTS 索引列（WHERE 全扫 O(N)），rowid 点删 O(1)；
        // upsert 冲突时保留原 rowid，本方法独占 FTS 写入 → rowid 恒对齐
        const base = this.st("SELECT rowid FROM evidence WHERE evidence_ref = ?").get(row.evidenceRef) as { rowid: number | bigint };
        this.st("DELETE FROM evidence_fts WHERE rowid = ?").run(base.rowid);
        this.st("INSERT INTO evidence_fts (rowid, evidence_ref, content) VALUES (?, ?, ?)").run(base.rowid, row.evidenceRef, row.content);
        mark("evidence");
      },
      putOutbox: (row) => {
        this.st("INSERT INTO outbox (notification_id, event_seq) VALUES (?, ?) ON CONFLICT (notification_id) DO UPDATE SET event_seq = excluded.event_seq").run(
          row.notificationId, row.eventSeq,
        );
        mark("outbox");
      },
      getRunLedger: (slotKey) => {
        const r = this.st("SELECT * FROM run_ledger WHERE slot_key = ?").get(slotKey) as RawRow | undefined;
        return r && rowToRunLedger(r);
      },
      putRunLedger: (row) => {
        this.st("INSERT INTO run_ledger (slot_key, epoch, refcount, consecutive_fails, last_verdict, next_due_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (slot_key) DO UPDATE SET epoch = excluded.epoch, refcount = excluded.refcount, consecutive_fails = excluded.consecutive_fails, last_verdict = excluded.last_verdict, next_due_at = excluded.next_due_at").run(
          row.slotKey, row.epoch, row.refcount, row.consecutiveFails, row.lastVerdict ?? null, row.nextDueAt ?? null,
        );
        mark("run_ledger");
      },
    };
  }

  appendEventIfMissing(row: EventRow): { kind: "appended" } | { kind: "skipped" } {
    return this.tx((tx) => {
      const existing = tx.getEvent(row.eventId);
      if (existing) {
        if (!sameEventContent(existing, row)) {
          throw new Error(`corruption: event ${row.eventId} exists with different content`);
        }
        return { kind: "skipped" as const };
      }
      tx.putEvent(row);
      return { kind: "appended" as const };
    });
  }

  getEntity(type: string, key: string): EntityRow | undefined {
    const r = this.st("SELECT * FROM entities WHERE type = ? AND entity_key = ?").get(type, key) as RawRow | undefined;
    return r && rowToEntity(r);
  }
  putEntity(row: EntityRow): void {
    this.tx((tx) => { tx.putEntity(row); });
  }
  getSubscription(subscriptionId: string): SubscriptionRow | undefined {
    const r = this.st("SELECT * FROM subscriptions WHERE subscription_id = ?").get(subscriptionId) as RawRow | undefined;
    return r && rowToSubscription(r);
  }
  putSubscription(row: SubscriptionRow): void {
    this.tx((tx) => { tx.putSubscription(row); });
  }
  getDelivery(notificationId: string, sessionId: string): DeliveryRowData | undefined {
    const r = this.st("SELECT * FROM deliveries WHERE notification_id = ? AND session_id = ?").get(notificationId, sessionId) as RawRow | undefined;
    return r && rowToDelivery(r);
  }
  putDelivery(row: DeliveryRowData): void {
    this.tx((tx) => { tx.putDelivery(row); });
  }
  getProbeSpec(slotKey: string): ProbeSpecRow | undefined {
    const r = this.st("SELECT * FROM probe_specs WHERE slot_key = ?").get(slotKey) as RawRow | undefined;
    return r && rowToProbeSpec(r);
  }
  putProbeSpec(row: ProbeSpecRow): void {
    this.tx((tx) => { tx.putProbeSpec(row); });
  }
  putNotification(row: NotificationRow): void {
    this.tx((tx) => { tx.putNotification(row); });
  }
  putEvidence(row: EvidenceRow): void {
    this.tx((tx) => { tx.putEvidence(row); });
  }
  /** outbox 写便捷路径：正常投递路径应在 tx 内组合（I1）；此单行方法仅供测试/工具使用。 */
  putOutbox(row: OutboxRow): void {
    this.tx((tx) => { tx.putOutbox(row); });
  }
  getRunLedger(slotKey: string): RunLedgerRow | undefined {
    const r = this.st("SELECT * FROM run_ledger WHERE slot_key = ?").get(slotKey) as RawRow | undefined;
    return r && rowToRunLedger(r);
  }
  putRunLedger(row: RunLedgerRow): void {
    this.tx((tx) => { tx.putRunLedger(row); });
  }
  listRunLedger(): RunLedgerRow[] {
    return (this.st("SELECT * FROM run_ledger ORDER BY rowid").all() as RawRow[]).map(rowToRunLedger);
  }

  queryEntities(filter: EntityFilter): EntityRow[] {
    const where: string[] = [];
    const params: Array<string | number | null> = [];
    if (filter.type !== undefined) { where.push("type = ?"); params.push(filter.type); }
    if (filter.parentType !== undefined) { where.push("parent_type = ?"); params.push(filter.parentType); }
    if (filter.parentKey !== undefined) { where.push("parent_key = ?"); params.push(filter.parentKey); }
    if (filter.retired !== undefined) { where.push("(retired IS NOT NULL AND retired != 0) = ?"); params.push(filter.retired ? 1 : 0); }
    const sql = `SELECT * FROM entities${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY rowid`;
    return (this.st(sql).all(...params) as RawRow[]).map(rowToEntity);
  }

  querySubscriptions(filter: SubscriptionFilter): SubscriptionRow[] {
    const where: string[] = [];
    const params: Array<string | number | null> = [];
    if (filter.entityRefType !== undefined) { where.push("entity_ref_type = ?"); params.push(filter.entityRefType); }
    if (filter.entityRefKey !== undefined) { where.push("entity_ref_key = ?"); params.push(filter.entityRefKey); }
    if (filter.sessionId !== undefined) { where.push("session_id = ?"); params.push(filter.sessionId); }
    if (filter.origin !== undefined) { where.push("origin = ?"); params.push(filter.origin); }
    const sql = `SELECT * FROM subscriptions${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY rowid`;
    return (this.st(sql).all(...params) as RawRow[]).map(rowToSubscription);
  }

  outboxBatch(limit: number): OutboxRow[] {
    return (this.st("SELECT notification_id, event_seq FROM outbox ORDER BY rowid LIMIT ?").all(limit) as RawRow[])
      .map((r) => ({ notificationId: String(r.notification_id), eventSeq: Number(r.event_seq) }));
  }

  pendingDeliveries(filter: DeliveryFilter): DeliveryRowData[] {
    return this.deliveriesByState("pending", filter);
  }

  deadLetters(filter: DeliveryFilter): DeliveryRowData[] {
    return this.deliveriesByState("dead-letter", filter);
  }

  parkedDeliveries(filter: DeliveryFilter): DeliveryRowData[] {
    return this.deliveriesByState("parked", filter);
  }

  /** fake 语义对齐：state 固定为本方法的 target（pending/dead-letter/parked），matchDelivery 的 filter.state 若与此矛盾则空集。 */
  private deliveriesByState(state: string, filter: DeliveryFilter): DeliveryRowData[] {
    if (filter.state !== undefined) {
      const states = typeof filter.state === "string" ? [filter.state] : filter.state;
      if (!states.includes(state as DeliveryRowData["state"])) return [];
    }
    const where = ["state = ?"];
    const params: Array<string | number | null> = [state];
    if (filter.sessionId !== undefined) { where.push("session_id = ?"); params.push(filter.sessionId); }
    return (this.st(`SELECT * FROM deliveries WHERE ${where.join(" AND ")} ORDER BY rowid`).all(...params) as RawRow[]).map(rowToDelivery);
  }

  evidenceSearch(fts5Query: string): EvidenceRow[] {
    return (this.st(
      "SELECT e.evidence_ref, e.content, e.recorded_at FROM evidence_fts f JOIN evidence e ON e.evidence_ref = f.evidence_ref WHERE evidence_fts MATCH ?",
    ).all(fts5Query) as RawRow[]).map((r) => ({
      evidenceRef: String(r.evidence_ref),
      content: String(r.content),
      recordedAt: Number(r.recorded_at),
    }));
  }

  notifications(filter: NotificationFilter): NotificationRow[] {
    if (filter.sinceEventSeq === undefined) {
      return (this.st("SELECT * FROM notifications ORDER BY rowid").all() as RawRow[]).map(rowToNotification);
    }
    // 增量下推 SQL：WHERE event_seq 走 idx_notifications_event_seq，不搬全表进内存；
    // 索引扫描按 event_seq 序返回，JS 按 rowid 重排保持 fake 插入序（结果集已收敛，排序代价可忽略）
    const rows = this.st("SELECT rowid, * FROM notifications WHERE event_seq > ?").all(filter.sinceEventSeq) as RawRow[];
    return rows.sort((a, b) => Number(a.rowid) - Number(b.rowid)).map(rowToNotification);
  }
}
