/**
 * store — public surface. See packages/README.md (deep-module layout).
 *
 * ticket 09: Store 接口定死 + 内存 fake。Store 是零依赖叶（eda-leaf-zero-dep-store）：
 * 参数/返回值用本模块自定形状（D3 裁定：不 import domain，映射层在 kernel）。
 *
 * 双契约钉死（store spec round-1）：
 *  1. update_hook 等价回调 = 提交成功后**按提交序同步触发**（真 SQLite 侧为 update_hook）；
 *     内存 fake 与真实现行为一致，否则测试说谎。
 *  2. Store fake 注入回调 = 第五停点（崩溃矩阵 X1/X2 的 A 层注入面）：
 *     X1 = 事务中途崩溃；X2 = transition 已提交、outbox 行未写。
 *
 * 方法集来源：#31 D2 表清单 + round-1 frontier ruling 2026-10-12（补三写方法）。
 */
export type EventRow = {
  /** 去重匹配键（appendIfMissing）——与 domain Transitioned.eventId 同名结构（非 import，D3）。 */
  eventId: string;
  eventSeq: number;
  entityRefType: string;
  entityRefKey: string;
  from: string | null;
  to: string;
  contentIdentity?: string;
  occurredAt: string;
  evidenceRef?: string;
};

export type EntityRow = {
  type: string;
  key: string;
  state: string | null;
  payload?: unknown;
  profileId?: string;
  parentType?: string;
  parentKey?: string;
  retired?: boolean;
  /** 自转换身份对 (state, contentIdentity) 现值（ADR 0003 edge-trigger 输入；publish 路径写回，
   *  probe 路径保留；缺省/null = 无身份）。票 40 评审 F3。 */
  contentIdentity?: string;
};

export type SubscriptionRow = {
  subscriptionId: string;
  sessionId: string;
  entityRefType: string;
  entityRefKey: string;
  template?: string;
  origin: "session" | "auto";
  scope?: "project" | "user";
  createdAt: number;
  ttlMs?: number;
  // 票 24 订阅生命周期：opts 持久化（幂等比较 / 换参检测 / 槽阈值恢复；once/flip/readyCheck 判定消费归票 26）
  // + 关闭簿记（closedAt 有值 = 已关订阅；closedReason 封闭集 = 关闭路径）。
  check?: string;
  /** on 谓词（I5：不进槽键，仅订阅参数）。 */
  on?: string;
  once?: boolean;
  flip?: boolean;
  readyCheck?: string;
  thresholds?: { failureThreshold: number; successThreshold: number };
  closedAt?: number;
  closedReason?: "cancelled" | "replaced" | "ttl" | "once-passed" | "failed-terminal";
  /** 票 26：两阶段订阅相位（readyCheck flip 判定；缺省 startup）。 */
  phase?: "startup" | "flip";
};

export type DeliveryRowData = {
  notificationId: string;
  sessionId: string;
  state: "pending" | "accepted" | "verified" | "parked" | "failed" | "dead-letter";
  recordEpoch: number;
};

export type ProbeSpecRow = {
  slotKey: string;
  check: string;
  schedule: { type: "interval" | "cron"; intervalMs?: number; cron?: string; tz?: string };
  source: "poll" | "fs-watch" | "k8s-watch";
};

export type NotificationRow = {
  notificationId: string;
  eventSeq: number;
  billboardJson: string;
  evidenceRef?: string;
};

export type EvidenceRow = {
  evidenceRef: string;
  content: string;
  recordedAt: number;
};

export type OutboxRow = {
  notificationId: string;
  eventSeq: number;
};

export type RunLedgerRow = {
  slotKey: string;
  epoch: number;
  refcount: number;
  consecutiveFails: number;
  lastVerdict?: "passed" | "failed" | "waiting";
  nextDueAt?: number;
  /** 票 24：槽身份（EntityRef 平铺，kernel 槽创建时落）——completion 回流的 slotKey → ref 反查（票 26 L0 消费）。 */
  entityRefType?: string;
  entityRefKey?: string;
  /**
   * 槽 generation（评审 B 组，设计修正）：创建 = 0，销毁重建/换参重建 = +1（共享加入不变）。
   * loops 用它隔离槽代际：旧代 completion 丢弃（in-flight 标记比对）、阈值计数归零（重建不继承旧计数）。
   */
  generation?: number;
};

/** 查询过滤器（形状最小化，字段语义见票面）。 */
export type EntityFilter = { type?: string; parentType?: string; parentKey?: string; retired?: boolean };
export type SubscriptionFilter = { entityRefType?: string; entityRefKey?: string; sessionId?: string; origin?: SubscriptionRow["origin"] };
export type NotificationFilter = { entityRefType?: string; entityRefKey?: string; sessionId?: string; sinceEventSeq?: number };
export type DeliveryFilter = { sessionId?: string; state?: DeliveryRowData["state"] | readonly DeliveryRowData["state"][] };

/** 事务句柄：fn 内通过它读写，返回值即提交内容。 */
export interface TxView {
  getEvent(eventId: string): EventRow | undefined;
  putEvent(row: EventRow): void;
  getEntity(type: string, key: string): EntityRow | undefined;
  putEntity(row: EntityRow): void;
  getSubscription(subscriptionId: string): SubscriptionRow | undefined;
  putSubscription(row: SubscriptionRow): void;
  getDelivery(notificationId: string, sessionId: string): DeliveryRowData | undefined;
  putDelivery(row: DeliveryRowData): void;
  getProbeSpec(slotKey: string): ProbeSpecRow | undefined;
  putProbeSpec(row: ProbeSpecRow): void;
  putNotification(row: NotificationRow): void;
  putEvidence(row: EvidenceRow): void;
  /** outbox 行写入：L0 在 tx(fn) 内调用（I1：transition+TransitionEvent+outbox 行原子）。X2 注入点=transition 提交后、本方法提交前。 */
  putOutbox(row: OutboxRow): void;
  getRunLedger(slotKey: string): RunLedgerRow | undefined;
  putRunLedger(row: RunLedgerRow): void;
  // --- 票 28 删除面（enumeration-completion，2026-10-16 派发裁定：票 09 "无 delete" 故意后置在此收口）---
  // staged 删除原语，提交语义（X1 原子/update_hook 等价回调）与 put* 一致。
  deleteEvidence(evidenceRefs: readonly string[]): void;
  deleteNotification(notificationId: string): boolean;
  deleteEntity(type: string, key: string): boolean;
}

export interface Store {
  /** 事务包装：fn 抛错 = 全部回滚（X1 注入点=fn 执行中途）。返回值透传。 */
  tx<T>(fn: (tx: TxView) => T): T;
  /** 事件追加幂等：同 eventId 跳过返回 skipped；异内容（sameEventContent 语义）= corruption 抛错。 */
  appendEventIfMissing(row: EventRow): { kind: "appended" } | { kind: "skipped" };
  // 聚合读写（tx 外单行便捷路径 = 各自单语句自动事务）
  getEntity(type: string, key: string): EntityRow | undefined;
  putEntity(row: EntityRow): void;
  getSubscription(subscriptionId: string): SubscriptionRow | undefined;
  putSubscription(row: SubscriptionRow): void;
  getDelivery(notificationId: string, sessionId: string): DeliveryRowData | undefined;
  putDelivery(row: DeliveryRowData): void;
  getProbeSpec(slotKey: string): ProbeSpecRow | undefined;
  putProbeSpec(row: ProbeSpecRow): void;
  putNotification(row: NotificationRow): void;
  putEvidence(row: EvidenceRow): void;
  /** outbox 写便捷路径：正常投递路径在 tx 内组合（I1）。X2 注入点语义见 TxView.putOutbox。 */
  putOutbox(row: OutboxRow): void;
  // 查询（fake 语义钉死：evidenceSearch 朴素子串匹配、notifications/deadLetters/queryEntities 按 filter 字段直过滤）
  queryEntities(filter: EntityFilter): EntityRow[];
  querySubscriptions(filter: SubscriptionFilter): SubscriptionRow[];
  outboxBatch(limit: number): OutboxRow[];
  pendingDeliveries(filter: DeliveryFilter): DeliveryRowData[];
  /** drain D2a 输入面：parked 行读取（与 pendingDeliveries/deadLetters 同构直过滤；票 11 最小增补）。 */
  parkedDeliveries(filter: DeliveryFilter): DeliveryRowData[];
  /** 24h verified-absence 扫描输入面（票 27 评审 H3）：accepted 行读取（与 pendingDeliveries/parkedDeliveries/deadLetters 同构直过滤）。 */
  acceptedDeliveries(filter: DeliveryFilter): DeliveryRowData[];
  evidenceSearch(fts5Query: string): EvidenceRow[];
  /** evidence op 点查（票 40 enumeration-completion）：ref 精确读——FTS 搜索对含 ":" 的确定性
   *  event id 形 ref 会解析成 FTS 列过滤器（no such column），点查与搜索是两个语义面。 */
  getEvidence(evidenceRef: string): EvidenceRow | undefined;
  notifications(filter: NotificationFilter): NotificationRow[];
  deadLetters(filter: DeliveryFilter): DeliveryRowData[];
  // run_ledger（D2 建表裁定）
  getRunLedger(slotKey: string): RunLedgerRow | undefined;
  putRunLedger(row: RunLedgerRow): void;
  listRunLedger(): RunLedgerRow[];
  // 票 28 读面：L3 verify 扫描输入 + evidence 按期查询（store spec：清理执行归 loops，store 提供按期查询）
  /** accepted 行读取（pendingDeliveries/parkedDeliveries/deadLetters 同构直过滤）。 */
  acceptedDeliveries(filter: DeliveryFilter): DeliveryRowData[];
  /** recordedAt < cutoffMs 的 evidence 行（严格小于，期界不含）。 */
  evidenceOlderThan(cutoffMs: number): EvidenceRow[];
  // --- 票 28 删除面（enumeration-completion，同 TxView 注；便捷路径各自单事务）---
  /** evidence 保留期执行面：按 ref 精确删（SQLite 侧 FTS 行同步对齐）。 */
  deleteEvidence(evidenceRefs: readonly string[]): void;
  /** 实体事件残留清理：删该实体 occurredAt < cutoffMs 事件的派生投递残留（notifications billboard 物化行），
   *  返回删除行数。events 行本体不删（D2 append-only 正典，SQLite 层触发器拒绝）；outbox 行不删
   *  （decisionOrder 恢复真相源——删除会令同 key 重注册的确定性 event id 与幸存事件碰撞 → corruption）。 */
  deleteEventsBefore(entityRefType: string, entityRefKey: string, cutoffMs: number): number;
  /** 实体行删除（ephemeral retired 到期清理收口，US-33 残留归零）：复活防护不依赖行存在
   *  （transition/publish 对未知实体同拒）；返回是否存在。 */
  deleteEntity(type: string, key: string): boolean;
  // update_hook 等价回调注册：提交成功后按提交序同步触发（真实现=SQLite update_hook）；
  // 返回取消订阅函数（幂等，票 25 Finding 2：stop 不累积监听器）
  onWrite(cb: (tables: readonly string[]) => void): () => void;
  // 第五停点注入（fake only）：注入回调，真实现为 no-op。X1="tx"，X2="outbox" 触发点。
  injectCrash?(point: "tx" | "outbox"): void;
}

// --- 内存 fake 实现 ---

type Table = Map<string, unknown>;

/** 提交序记录（update_hook 断言用）。 */
interface CommitRecord {
  tables: string[];
  /** X2 标记：本事务计划写 outbox 但被注入中止（行已入 staging，未落 committed）。 */
  outboxPending?: OutboxRow[];
}

export class MemoryStore implements Store {
  private tables: Record<string, Table> = {
    events: new Map(),
    entities: new Map(),
    subscriptions: new Map(),
    deliveries: new Map(),
    probe_specs: new Map(),
    notifications: new Map(),
    evidence: new Map(),
    outbox: new Map(),
    run_ledger: new Map(),
  };
  private writeListeners: Array<(tables: readonly string[]) => void> = [];
  private commitOrder: CommitRecord[] = [];
  private crashPoint: "tx" | "outbox" | null = null;
  /** 提交通知队列 + 分发中标记：重入提交（监听器内再提交）排到当前提交全部监听器之后（FIFO）。 */
  private notifyQueue: string[][] = [];
  private dispatching = false;

  onWrite(cb: (tables: readonly string[]) => void): () => void {
    this.writeListeners.push(cb);
    return () => {
      const i = this.writeListeners.indexOf(cb);
      if (i >= 0) this.writeListeners.splice(i, 1);
    };
  }

  /** 第五停点（fake only，真实现 no-op）：下一次对应点触发崩溃模拟。 */
  injectCrash(point: "tx" | "outbox"): void {
    this.crashPoint = point;
  }

  /** 测试专用：提交序记录（update_hook 按提交序同步触发的断言面）。 */
  getCommitOrder(): readonly CommitRecord[] {
    return this.commitOrder;
  }

  tx<T>(fn: (tx: TxView) => T): T {
    // X1 注入：事务中途崩溃 = staging 丢弃，committed 不变
    if (this.crashPoint === "tx") {
      this.crashPoint = null;
      throw new Error("X1 crash injected: tx aborted mid-flight");
    }
    const staging: Record<string, Map<string, unknown>> = {};
    const stagedTables = new Set<string>();
    const outboxStaged: OutboxRow[] = [];
    let outboxInjected = false;

    const table = (name: string): Map<string, unknown> => {
      if (!staging[name]) staging[name] = new Map(this.tables[name]);
      return staging[name];
    };
    const mark = (name: string) => stagedTables.add(name);

    const view: TxView = {
      getEvent: (id) => table("events").get(id) as EventRow | undefined,
      putEvent: (row) => { table("events").set(row.eventId, row); mark("events"); },
      getEntity: (t, k) => table("entities").get(`${t}/${k}`) as EntityRow | undefined,
      putEntity: (row) => { table("entities").set(`${row.type}/${row.key}`, row); mark("entities"); },
      getSubscription: (id) => table("subscriptions").get(id) as SubscriptionRow | undefined,
      putSubscription: (row) => { table("subscriptions").set(row.subscriptionId, row); mark("subscriptions"); },
      getDelivery: (n, s) => table("deliveries").get(`${n}/${s}`) as DeliveryRowData | undefined,
      putDelivery: (row) => { table("deliveries").set(`${row.notificationId}/${row.sessionId}`, row); mark("deliveries"); },
      getProbeSpec: (k) => table("probe_specs").get(k) as ProbeSpecRow | undefined,
      putProbeSpec: (row) => { table("probe_specs").set(row.slotKey, row); mark("probe_specs"); },
      putNotification: (row) => { table("notifications").set(row.notificationId, row); mark("notifications"); },
      putEvidence: (row) => { table("evidence").set(row.evidenceRef, row); mark("evidence"); },
      putOutbox: (row) => {
        table("outbox").set(row.notificationId, row);
        outboxStaged.push(row);
        mark("outbox");
        // X2 注入：transition 已进 staging（"已提交"语义面），outbox 行未落 committed
        if (this.crashPoint === "outbox") {
          this.crashPoint = null;
          outboxInjected = true;
          throw new Error("X2 crash injected: committed transition, outbox not written");
        }
      },
      getRunLedger: (k) => table("run_ledger").get(k) as RunLedgerRow | undefined,
      putRunLedger: (row) => { table("run_ledger").set(row.slotKey, row); mark("run_ledger"); },
      // 票 28 删除面：staged 删除，提交语义与 put* 一致
      deleteEvidence: (refs) => {
        for (const r of refs) table("evidence").delete(r);
        if (refs.length > 0) mark("evidence");
      },
      deleteNotification: (notificationId) => {
        const had = table("notifications").delete(notificationId);
        if (had) mark("notifications");
        return had;
      },
      deleteEntity: (type, key) => {
        const had = table("entities").delete(`${type}/${key}`);
        if (had) mark("entities");
        return had;
      },
    };

    let result: T;
    try {
      result = fn(view);
    } catch (err) {
      if (outboxInjected) {
        // X2 语义：staging 全部丢弃（outbox 行未提交），但调用方已"提交"的 transition 也回滚——
        // 真实崩溃由重启后 catch_up/重放补齐（appendIfMissing 幂等收口）。这里按"事务原子"处理。
        this.commitOrder.push({ tables: [], outboxPending: outboxStaged });
      }
      throw err;
    }
    // 提交：staging → committed
    for (const name of stagedTables) {
      this.tables[name] = staging[name];
    }
    this.commitOrder.push({ tables: [...stagedTables] });
    // update_hook 等价：提交成功后按提交序同步触发（重入提交排队，见 notifyCommit）
    this.notifyCommit([...stagedTables]);
    return result;
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

  getEntity(type: string, key: string) { return this.tables.entities.get(`${type}/${key}`) as EntityRow | undefined; }
  putEntity(row: EntityRow) { this.tx((tx) => { tx.putEntity(row); }); }
  getSubscription(id: string) { return this.tables.subscriptions.get(id) as SubscriptionRow | undefined; }
  putSubscription(row: SubscriptionRow) { this.tx((tx) => { tx.putSubscription(row); }); }
  getDelivery(n: string, s: string) { return this.tables.deliveries.get(`${n}/${s}`) as DeliveryRowData | undefined; }
  putDelivery(row: DeliveryRowData) { this.tx((tx) => { tx.putDelivery(row); }); }
  getProbeSpec(k: string) { return this.tables.probe_specs.get(k) as ProbeSpecRow | undefined; }
  putProbeSpec(row: ProbeSpecRow) { this.tx((tx) => { tx.putProbeSpec(row); }); }
  putNotification(row: NotificationRow) { this.tx((tx) => { tx.putNotification(row); }); }
  putEvidence(row: EvidenceRow) { this.tx((tx) => { tx.putEvidence(row); }); }
  /** outbox 写便捷路径：正常投递路径应在 tx 内组合（I1）；此单行方法仅供测试/工具使用。 */
  putOutbox(row: OutboxRow) { this.tx((tx) => { tx.putOutbox(row); }); }
  getRunLedger(k: string) { return this.tables.run_ledger.get(k) as RunLedgerRow | undefined; }
  putRunLedger(row: RunLedgerRow) { this.tx((tx) => { tx.putRunLedger(row); }); }
  listRunLedger() { return [...this.tables.run_ledger.values()] as RunLedgerRow[]; }

  queryEntities(filter: EntityFilter): EntityRow[] {
    return [...this.tables.entities.values() as IterableIterator<EntityRow>].filter((e) =>
      (filter.type === undefined || e.type === filter.type) &&
      (filter.parentType === undefined || e.parentType === filter.parentType) &&
      (filter.parentKey === undefined || e.parentKey === filter.parentKey) &&
      (filter.retired === undefined || !!e.retired === filter.retired),
    );
  }

  querySubscriptions(filter: SubscriptionFilter): SubscriptionRow[] {
    return [...this.tables.subscriptions.values() as IterableIterator<SubscriptionRow>].filter((s) =>
      (filter.entityRefType === undefined || s.entityRefType === filter.entityRefType) &&
      (filter.entityRefKey === undefined || s.entityRefKey === filter.entityRefKey) &&
      (filter.sessionId === undefined || s.sessionId === filter.sessionId) &&
      (filter.origin === undefined || s.origin === filter.origin),
    );
  }

  outboxBatch(limit: number): OutboxRow[] {
    return [...this.tables.outbox.values() as IterableIterator<OutboxRow>].slice(0, limit);
  }

  pendingDeliveries(filter: DeliveryFilter): DeliveryRowData[] {
    return [...this.tables.deliveries.values() as IterableIterator<DeliveryRowData>].filter((d) =>
      this.matchDelivery(d, filter) && d.state === "pending",
    );
  }

  deadLetters(filter: DeliveryFilter): DeliveryRowData[] {
    return [...this.tables.deliveries.values() as IterableIterator<DeliveryRowData>].filter((d) =>
      this.matchDelivery(d, filter) && d.state === "dead-letter",
    );
  }

  parkedDeliveries(filter: DeliveryFilter): DeliveryRowData[] {
    return [...this.tables.deliveries.values() as IterableIterator<DeliveryRowData>].filter((d) =>
      this.matchDelivery(d, filter) && d.state === "parked",
    );
  }


  evidenceSearch(fts5Query: string): EvidenceRow[] {
    // fake 语义钉死：朴素子串匹配（真实现 FTS5 MATCH）
    return [...this.tables.evidence.values() as IterableIterator<EvidenceRow>].filter((e) =>
      e.content.includes(fts5Query) || e.evidenceRef.includes(fts5Query),
    );
  }

  getEvidence(evidenceRef: string): EvidenceRow | undefined {
    return this.tables.evidence.get(evidenceRef) as EvidenceRow | undefined;
  }

  acceptedDeliveries(filter: DeliveryFilter): DeliveryRowData[] {
    return [...this.tables.deliveries.values() as IterableIterator<DeliveryRowData>].filter((d) =>
      this.matchDelivery(d, filter) && d.state === "accepted",
    );
  }

  evidenceOlderThan(cutoffMs: number): EvidenceRow[] {
    return [...this.tables.evidence.values() as IterableIterator<EvidenceRow>].filter((e) => e.recordedAt < cutoffMs);
  }

  deleteEvidence(refs: readonly string[]): void {
    this.tx((tx) => { tx.deleteEvidence(refs); });
  }

  /** 事件 id 扫描在事务外（只读已提交态），删除在 tx 内 staged（与 SQLite 实现同序同语义）。 */
  deleteEventsBefore(entityRefType: string, entityRefKey: string, cutoffMs: number): number {
    const ids: string[] = [];
    for (const e of this.tables.events.values() as IterableIterator<EventRow>) {
      if (e.entityRefType === entityRefType && e.entityRefKey === entityRefKey && Date.parse(e.occurredAt) < cutoffMs) {
        ids.push(e.eventId);
      }
    }
    if (ids.length === 0) return 0;
    return this.tx((tx) => ids.reduce((n, id) => n + (tx.deleteNotification(id) ? 1 : 0), 0));
  }

  deleteEntity(type: string, key: string): boolean {
    return this.tx((tx) => tx.deleteEntity(type, key));
  }

  notifications(filter: NotificationFilter): NotificationRow[] {
    return [...this.tables.notifications.values() as IterableIterator<NotificationRow>].filter((n) =>
      (filter.sinceEventSeq === undefined || n.eventSeq > filter.sinceEventSeq),
    );
  }

  private matchDelivery(d: DeliveryRowData, filter: DeliveryFilter): boolean {
    if (filter.sessionId !== undefined && d.sessionId !== filter.sessionId) return false;
    if (filter.state !== undefined) {
      const states = typeof filter.state === "string" ? [filter.state] : filter.state;
      if (!states.includes(d.state)) return false;
    }
    return true;
  }
}

// 内容比较域与 domain/types.ts TRANSITIONED_CONTENT_FIELDS 为同一清单的两份拷贝（D3 豁免：store 行形状拆 entityRefType/entityRefKey，非 import），漂移须双向同步。
export const CONTENT_FIELDS = ["eventSeq", "entityRefType", "entityRefKey", "from", "to", "contentIdentity", "occurredAt", "evidenceRef"] as const;

/** appendIfMissing 内容比较域（fake/SqliteStore 共用，sameEventContent 语义）。undefined 与 undefined 相等。 */
export function sameEventContent(a: EventRow, b: EventRow): boolean {
  return CONTENT_FIELDS.every((f) => {
    const va = (a as unknown as Record<string, unknown>)[f];
    const vb = (b as unknown as Record<string, unknown>)[f];
    return (va === undefined && vb === undefined) || va === vb;
  });
}

// --- 便捷工厂 ---

export function createMemoryStore(): Store & MemoryStore {
  return new MemoryStore();
}
