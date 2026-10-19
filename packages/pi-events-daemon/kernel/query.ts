/**
 * kernel/query — 读模型（票 42 拆分①：query/evidence 读侧归一自聚合写类分离）。
 *
 * 纯读面：只消费 Store 查询接口（不开写事务、不进 L0 队列），经 createQueryFace(store)
 * 构造注入；Kernel 保留同名委托方法（LoopsHandle Pick 消费面不变），行为与原
 * Kernel.query/evidence 逐行同源（票 11/40 正典）。唯一结构差异 = outbox 全表拉
 * （MAX_SAFE_INTEGER）收编为 store 谓词下推聚合（outboxSeqByRef）。
 */
import { type EntityRef, entityRefKeyOf, sameEntityRef } from "../domain/types.ts";
import { type SubscriptionScope, EVIDENCE_INLINE_LIMIT } from "../domain/delivery.ts";
import type { EntityRow, Store } from "../store/index.ts";

/** query B4 懒重探 ctx：probe runtime 是 RunnerSlot 侧数据（票 24 持有），读侧经调用注入。 */
export type QueryProbeCtx = {
  now: number;
  reprobeAfterMs: number;
  runtime: ReadonlyArray<{ entityRef: EntityRef; refcount: number; lastProbedAt: number | null }>;
};

export type QueryEntityEntry = {
  entityRef: EntityRef;
  state: string | null;
  payload: unknown;
  /** 实体最新事件写入序（无事件 = null）；端到端链 B 断言面。 */
  eventSeq: number | null;
  lastProbedAt: number | null;
  /** pending delivery 行数（经事件 join 归实体）。 */
  backlog: number;
  /** listChildren 单层展开（孩子条目不再嵌套 children，无级联）。 */
  children?: QueryEntityEntry[];
  /** B4 懒重探标记：refcount 0 且 lastProbedAt 超阈（null=未探过亦算陈旧）→ 单次重探；
   *  重探执行方记录 lastProbedAt 后条件自清（单次语义，query 读侧不写）。 */
  reprobeRequested?: boolean;
};

export type QueryResult = {
  entities: QueryEntityEntry[];
  deadLetters: ReadonlyArray<{ notificationId: string; sessionId: string; entityRef: EntityRef }>;
};

/** 读模型 seam（票 42）：LoopsHandle.kernel 的 query/evidence 消费形状。 */
export interface QueryFace {
  query(
    filter?: { entityRef?: EntityRef; scope?: SubscriptionScope; sessionId?: string },
    probe?: QueryProbeCtx,
  ): QueryResult;
  evidence(evidenceRef: string): { content: string; truncated: boolean };
}

export function createQueryFace(store: Store): QueryFace {
  /**
   * query（票 11，读侧归一）：实体清单（state/payload 摘要/eventSeq/lastProbedAt/backlog）
   * + listChildren 单层展开 + per-entity backlog + deadLetters 清单 + B4 懒重探标记。
   * backlog/deadLetters/eventSeq 归属：delivery/notificationId 经事件 join（tx 批量点查）。
   * 过滤面：entityRef 点查 + scope/session（票 40 评审 F5：开放订阅-实体 join——可见实体 =
   * 持有匹配 scope/session 的开放订阅；deadLetters 另按自身 sessionId 过滤）。
   */
  const query = (
    filter: { entityRef?: EntityRef; scope?: SubscriptionScope; sessionId?: string } = {},
    probe?: QueryProbeCtx,
  ): QueryResult => {
    const entities = store.queryEntities({});
    // scope/session 可见集（订阅-实体 join；closed 订阅不携带可见性；scope 缺省 project 同 L0 编址口径）
    let visible: Set<string> | null = null;
    if (filter.scope !== undefined || filter.sessionId !== undefined) {
      visible = new Set();
      for (const s of store.querySubscriptions(
        filter.sessionId !== undefined ? { sessionId: filter.sessionId } : {},
      )) {
        if (s.closedAt !== undefined) continue;
        if (filter.scope !== undefined && (s.scope ?? "project") !== filter.scope) continue;
        visible.add(entityRefKeyOf({ type: s.entityRefType, key: s.entityRefKey }));
      }
    }
    // latestSeq join（票 42 下推）：outbox⨝events 每实体最新 eventSeq 由 store 聚合返回，
    // 替代 outboxBatch(MAX_SAFE_INTEGER) 全表拉 + tx 内逐行点查
    const latestSeq = new Map<string, number>();
    for (const r of store.outboxSeqByRef()) {
      latestSeq.set(entityRefKeyOf({ type: r.entityRefType, key: r.entityRefKey }), r.eventSeq);
    }
    const pending = store.pendingDeliveries({});
    const dead = store.deadLetters({});
    const joins = store.tx((tx) => {
      const backlogByRef = new Map<string, number>();
      const deadList: { notificationId: string; sessionId: string; entityRef: EntityRef }[] = [];
      for (const d of pending) {
        const ev = tx.getEvent(d.notificationId);
        if (!ev) continue;
        const k = entityRefKeyOf({ type: ev.entityRefType, key: ev.entityRefKey });
        backlogByRef.set(k, (backlogByRef.get(k) ?? 0) + 1);
      }
      for (const d of dead) {
        const ev = tx.getEvent(d.notificationId);
        if (ev) deadList.push({ notificationId: d.notificationId, sessionId: d.sessionId, entityRef: { type: ev.entityRefType, key: ev.entityRefKey } });
      }
      return { backlogByRef, deadList };
    });

    // parent→children 索引一次构建（O(N)）：无过滤 query 全量 entryOf(true) 时，
    // 每实体全表扫父子关系是 O(N²)（万级实体同步阻塞）——单次建 Map 后 O(1) 查找
    const childrenByParent = new Map<string, EntityRow[]>();
    for (const e of entities) {
      if (e.parentType === undefined || e.parentKey === undefined) continue;
      const pk = entityRefKeyOf({ type: e.parentType, key: e.parentKey });
      const bucket = childrenByParent.get(pk);
      if (bucket) bucket.push(e);
      else childrenByParent.set(pk, [e]);
    }

    const entryOf = (row: EntityRow, withChildren: boolean): QueryEntityEntry => {
      const ref = { type: row.type, key: row.key };
      const k = entityRefKeyOf(ref);
      const rt = probe?.runtime.find((r) => sameEntityRef(r.entityRef, ref));
      const entry: QueryEntityEntry = {
        entityRef: ref,
        state: row.state,
        payload: row.payload ?? null,
        eventSeq: latestSeq.get(k) ?? null,
        lastProbedAt: rt?.lastProbedAt ?? null,
        backlog: joins.backlogByRef.get(k) ?? 0,
      };
      if (withChildren) {
        const children = (childrenByParent.get(k) ?? []).map((c) => entryOf(c, false)); // 单层：孩子不再展开
        if (children.length > 0) entry.children = children;
      }
      if (rt && rt.refcount === 0 && probe && (rt.lastProbedAt === null || probe.now - rt.lastProbedAt > probe.reprobeAfterMs)) {
        entry.reprobeRequested = true;
      }
      return entry;
    };

    const selected = entities.filter((e) => {
      if (filter.entityRef && !(e.type === filter.entityRef.type && e.key === filter.entityRef.key)) return false;
      if (visible && !visible.has(entityRefKeyOf({ type: e.type, key: e.key }))) return false;
      return true;
    });
    const deadLetters = joins.deadList.filter((d) => {
      if (filter.entityRef && !sameEntityRef(d.entityRef, filter.entityRef)) return false;
      if (filter.sessionId !== undefined && d.sessionId !== filter.sessionId) return false;
      if (visible && !visible.has(entityRefKeyOf(d.entityRef))) return false;
      return true;
    });
    return { entities: selected.map((e) => entryOf(e, true)), deadLetters };
  };

  /**
   * evidence（票 11）：FTS5 点查（B 层 = store.evidenceSearch 朴素子串 + 精确 ref 收口）。
   * 双 ref 形态：直接 evidence 行 ref，或 billboard 截断指针（= notificationId）→ 事件
   * evidenceRef → 全文（截断只发生在 billboard 内联，指针解引用不被吞）。truncated =
   * 全文超 2KB 内联上限（EVIDENCE_INLINE_LIMIT，UTF-8 字节）。
   */
  const evidence = (evidenceRef: string): { content: string; truncated: boolean } => {
    // 点查语义（票 40）：双 ref 形态都是 ref 精确读——FTS 搜索面（evidenceSearch）对含 ":" 的
    // 确定性 event id 形 ref 会解析成 FTS 列过滤器，不承载点查（getEvidence enumeration-completion）。
    const direct = store.getEvidence(evidenceRef);
    const row =
      direct ??
      (() => {
        const event = store.tx((tx) => tx.getEvent(evidenceRef));
        return event?.evidenceRef ? store.getEvidence(event.evidenceRef) : undefined;
      })();
    if (!row) throw new Error(`evidence not found: ${evidenceRef}`);
    return { content: row.content, truncated: Buffer.byteLength(row.content, "utf8") > EVIDENCE_INLINE_LIMIT };
  };

  return { query, evidence };
}
