/**
 * kernel — 聚合方法层（票 10：transition 经 kernel 唯一写路径 + Intent 串行消费，链 B 核心）。
 *
 * 每个方法 = 校验（domain 纯函数）→ 事务提交（Store.tx，一个方法一个事务单元 I1）
 * → Intent 串行消费（appendIfMissing 语义：同 id 跳过 / 异内容 corruption）的原子单元。
 *
 * I-01 / ADR 0005 试金石：封闭状态集经构造注入（数据）——本模块源码零状态字面量、
 * 零 profile import，新增 profile 零 kernel 改动。
 *
 * R1 双轨恢复前提（重放不得重新编号）：
 * - decisionOrder（决策轨）从 mutation line 位点经构造注入（mutation line 归 loops 侧管）；
 * - eventSeq（写入轨）从事件流尾恢复——首版经 outbox 行 eventSeq 最大值（outbox 行与
 *   transition 1:1 同事务写入，I1 组合面；事件流尾直查归 store 接口后续票精化）。
 */
import {
  type EntityRef,
  type TransitionIntent,
  type Transitioned,
  type Verdict,
  entityRefKeyOf,
  sameEntityRef,
} from "../domain/types.ts";
import { epochAccepts, intentToEvent, planTransition, requireStateIn } from "../domain/intent.ts";
import type { IntentSequences } from "../domain/intent.ts";
import {
  type SubscriptionAddressing,
  type SubscriptionScope,
  EVIDENCE_INLINE_LIMIT,
  deliveryTargets,
  makeBillboard,
  transitionDelivery,
} from "../domain/delivery.ts";
import type { EventRow, Store, TxView } from "../store/index.ts";
import type { EntityRow } from "../store/index.ts";

/** Intent 消费重试上界（spec 自定裁量：#31 仅"有限重试"未定数值，round-2 备注 → 3 次）。 */
const MAX_INTENT_ATTEMPTS = 3;

/** transition / migrateState 的返回形状（publish 契约同族：{eventSeq, from, to}）。 */
export type TransitionResult = { eventSeq: number; from: string | null; to: string };

/** 串行消费结果：appended 附带落库事件（断言面）；skipped = 同 id 同内容幂等重放。 */
export type ConsumeOutcome = { kind: "appended"; event: Transitioned } | { kind: "skipped" };

/** 同 id 异内容：确定性重放被破坏 / 多写者（票 09 corruption 判定的 kernel 侧形态）。确定性失败不重试。 */
export class IntentCorruption extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntentCorruption";
  }
}

/**
 * profile 注册表条目（I-01：profile 静态面作为数据声明注入，kernel 零 profile import）。
 * 票 11 消费面：templates 清单 / validate 三类错误 + ADR 0004 副作用 pattern；状态集仍走构造注入 states。
 */
export interface ProfileRegistryEntry {
  profileId: string;
  templates: ReadonlyArray<{
    name: string;
    entityType: string;
    states: readonly string[];
    params?: readonly string[];
    schedule?: unknown;
    usage?: string;
  }>;
  /** 已知副作用 pattern（子串匹配）：validate 命中出 warning 不阻断（ADR 0004 checks-are-probes）。 */
  sideEffectPatterns?: readonly string[];
}

/** fanOut 运行时 deps：活跃 session 是 socket runtime（transport 持有），经调用注入（kernel 不碰 socket）。 */
export type FanOutDeps = {
  activeSessions: ReadonlyArray<{ sessionId: string; scope: SubscriptionScope }>;
};

export type FanOutResult = {
  notificationId: string;
  eventSeq: number;
  /** pending 直投行目标（活跃）；parked = session 已关（E1），只等 drain。 */
  delivered: string[];
  parked: string[];
};

/** drain 出参：投递结果（重投行清单）+ dead-letter 只读摘要（D2a：零进入，可见性三件套①）。 */
export type DrainResult = {
  drained: ReadonlyArray<{ notificationId: string; sessionId: string }>;
  deadLetterSummary: { count: number; oldestAgeMs: number | null };
};

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

/** validate 请求（静态面）：profile 路由 + 模板形态/ ad-hoc 形态二选一。 */
export type ValidateRequest = {
  profile: string;
  template?: string;
  params?: Record<string, unknown>;
  check?: string;
};

/** validate 结果：三类静态错误（同步拒）| ok + ADR 0004 副作用 warning（不阻断）。
 *  op 表的 live-run 形状（verdict/durationMs/evidence）归 prober 执行面后续票。 */
export type ValidateResult =
  | { ok: false; error: "profile-not-found" | "invalid-params" | "checker-declaration"; reason: string }
  | { ok: true; warnings: readonly string[] };

export type TemplateMeta = {
  profileId: string;
  name: string;
  entityType: string;
  states: readonly string[];
  params?: readonly string[];
  schedule?: unknown;
  usage?: string;
};

/** eventSeq 事件流尾恢复（首版）：outbox 行与 transition 1:1，取 eventSeq 最大值；空库 = 0。 */
function recoverEventSeq(store: Store): number {
  let max = 0;
  for (const row of store.outboxBatch(Number.MAX_SAFE_INTEGER)) {
    if (row.eventSeq > max) max = row.eventSeq;
  }
  return max;
}

/** D3 映射层：domain Transitioned → store EventRow（entityRef 平铺；contentIdentity null 归一 undefined——EventRow 无 null 槽位，存储侧同形）。 */
function toEventRow(e: Transitioned): EventRow {
  return {
    eventId: e.eventId,
    eventSeq: e.eventSeq,
    entityRefType: e.entityRef.type,
    entityRefKey: e.entityRef.key,
    from: e.from,
    to: e.to,
    contentIdentity: e.contentIdentity ?? undefined,
    occurredAt: e.occurredAt,
    evidenceRef: e.evidenceRef,
  };
}

/**
 * 存储行 vs intent 的内容比较（appendIfMissing "异内容" 判定）。
 * 与 domain TRANSITIONED_CONTENT_FIELDS 同清单；entityRef 结构相等（sameEntityRef），
 * contentIdentity/evidenceRef 经 ?? undefined 归一（与 toEventRow 映射对称）。
 */
function sameContent(stored: EventRow, intent: TransitionIntent): boolean {
  return (
    stored.eventSeq === intent.eventSeq &&
    sameEntityRef({ type: stored.entityRefType, key: stored.entityRefKey }, intent.entityRef) &&
    stored.from === intent.from &&
    stored.to === intent.to &&
    (stored.contentIdentity ?? undefined) === (intent.contentIdentity ?? undefined) &&
    stored.occurredAt === intent.occurredAt &&
    (stored.evidenceRef ?? undefined) === (intent.evidenceRef ?? undefined)
  );
}

/**
 * Kernel — 聚合方法面。构造参数即全部注入点：Store（接口）、封闭状态集（I-01 数据）、
 * mutation line 决策序位点。eventSeq 由本类从 store 事件流尾自恢复。
 */
export class Kernel {
  private sequences: IntentSequences;
  /** I12：本 daemon 实例世代（daemon-main 组合根传入；0 = 未接线）。 */
  private readonly ownerEpoch: number;
  /** I-01 profile 注册表（静态面数据；票 11 消费于 validate/templates）。 */
  private readonly registry: ReadonlyArray<ProfileRegistryEntry>;

  constructor(
    private readonly store: Store,
    /** I-01：封闭状态集（数据注入）。校验 to 用；from=null 恒合法。 */
    private readonly states: ReadonlySet<string>,
    /** decisionOrder 起点双轨之决策轨：mutation line 尾位点（重放不得重新编号）。 */
    decisionOrder: number,
    opts: { ownerEpoch?: number; registry?: ReadonlyArray<ProfileRegistryEntry> } = {},
  ) {
    this.sequences = { decisionOrder, eventSeq: recoverEventSeq(store) };
    this.ownerEpoch = opts.ownerEpoch ?? 0;
    this.registry = opts.registry ?? [];
  }

  /**
   * probe 路径唯一写入口：verdict → 校验（存在/未 retired/I3 封闭集/edge-trigger）
   * → planTransition 双轨分配 → 串行消费（tx 内 appendIfMissing + 实体写回 + outbox 行，I1 原子）。
   * 同态 verdict → null（无转换无事件，ADR 0003）。
   */
  transition(ref: EntityRef, verdict: Verdict, occurredAt: string): TransitionResult | null {
    return this.withRetry(`transition ${entityRefKeyOf(ref)}/${verdict}`, () => {
      // F1：回调只产出 {业务结果, 待推进游标}，Store.tx 成功返回后才推进——
      // 回调完成、提交失败的回滚场景下重试重排同序 → 同确定性 eventId（幂等不烧号）
      const planned = this.store.tx(
        (tx): { result: TransitionResult; sequences: IntentSequences } | null => {
          const entity = tx.getEntity(ref.type, ref.key);
          if (!entity) throw new Error(`transition rejected: unknown entity ${entityRefKeyOf(ref)}`);
          if (entity.retired) {
            throw new Error(`transition rejected: entity ${entityRefKeyOf(ref)} is retired — retired entities never revive`);
          }
          requireStateIn(this.states, verdict);
          // F3：from 态同受封闭集执法（null 首转换豁免）——已删除旧态的唯一出口是 migrateState 显式迁移
          requireStateIn(this.states, entity.state);
          if (entity.state === verdict) return null;
          const { intent, sequences } = planTransition(this.sequences, {
            entityRef: ref,
            from: entity.state,
            to: verdict,
            occurredAt,
          });
          this.consumeTx(tx, intent);
          return { result: { eventSeq: intent.eventSeq, from: intent.from, to: intent.to }, sequences };
        },
      );
      if (planned === null) return null;
      this.sequences = planned.sequences;
      return planned.result;
    });
  }

  /**
   * Intent 串行消费（崩溃重放的幂等入口）：按 intent 自带双轨序消费，不重新编号——
   * 同 id 同内容 skipped / 同 id 异内容 corruption / 未达序 appended（I1 原子单元）。
   * 成功后游标推进到已消费尾（max），后续 transition 从重放尾续接。
   * 封闭集校验在 consumeTx 追加路径（F2）：相同历史事件直接 skipped 豁免——
   * 状态改名后重启重放不得被新状态集阻断；新追加仍执法。
   */
  consumeIntent(intent: TransitionIntent): ConsumeOutcome {
    const outcome = this.withRetry(`intent ${intent.eventId}`, () =>
      this.store.tx((tx) => this.consumeTx(tx, intent)),
    );
    this.sequences = {
      decisionOrder: Math.max(this.sequences.decisionOrder, intent.decisionOrder),
      eventSeq: Math.max(this.sequences.eventSeq, intent.eventSeq),
    };
    return outcome;
  }

  /**
   * B7 状态改名迁移：显式迁移 TransitionEvent（同族，from 旧名 → to 新名），禁原地改名——
   * 经唯一写路径（consumeTx）提交。from 是历史名（不在新封闭集），不做封闭集校验，
   * 以实体当前状态匹配为准；实体不在旧名态 → 无可迁移返回 null（幂等，不产事件）。
   */
  migrateState(
    ref: EntityRef,
    mapping: { from: string; to: string },
    occurredAt: string,
  ): TransitionResult | null {
    requireStateIn(this.states, mapping.to);
    return this.withRetry(`migration ${entityRefKeyOf(ref)}/${mapping.from}->${mapping.to}`, () => {
      // F1 同 transition：游标推进仅在 Store.tx 成功返回后（提交失败不烧号）
      const planned = this.store.tx(
        (tx): { result: TransitionResult; sequences: IntentSequences } | null => {
          const entity = tx.getEntity(ref.type, ref.key);
          if (!entity) throw new Error(`migration rejected: unknown entity ${entityRefKeyOf(ref)}`);
          if (entity.retired) {
            throw new Error(`migration rejected: entity ${entityRefKeyOf(ref)} is retired — retired entities never revive`);
          }
          if (entity.state !== mapping.from) return null;
          const { intent, sequences } = planTransition(this.sequences, {
            entityRef: ref,
            from: mapping.from,
            to: mapping.to,
            occurredAt,
          });
          this.consumeTx(tx, intent);
          return { result: { eventSeq: intent.eventSeq, from: intent.from, to: intent.to }, sequences };
        },
      );
      if (planned === null) return null;
      this.sequences = planned.sequences;
      return planned.result;
    });
  }

  /**
   * fanOut（票 11）：notification 编址解析的唯一所在（spec story 5）。
   * 输入 = outbox 行 notificationId（= 确定性 event id，I1 与 transition 1:1）：
   * 事件 → 实体 → 匹配订阅（store.querySubscriptions）→ domain deliveryTargets 按 origin 分支：
   * session → sourceSessionId 精确匹配（会话已关投 parked）；auto → scope 内活跃 session（活跃直投、离线不发）；
   * 无匹配订阅 → delivery 行不发（billboard 兜底由 query 承担）。
   * 同事务物化 NotificationRow（billboard；>2KB 截断 + evidenceRef=notificationId 指针，makeBillboard 正典）。
   * I10：每 (notification, session) 恰一行——重复 fanOut 幂等跳过。
   */
  fanOut(notificationId: string, deps: FanOutDeps): FanOutResult {
    return this.withRetry(`fanOut ${notificationId}`, () =>
      this.store.tx((tx) => {
        const event = tx.getEvent(notificationId);
        if (!event) throw new Error(`fanOut rejected: unknown notification ${notificationId}`);
        const ref = { type: event.entityRefType, key: event.entityRefKey };
        const subs = this.store.querySubscriptions({ entityRefType: ref.type, entityRefKey: ref.key });
        // billboard evidence 内容：事件 evidenceRef → evidence 表（无则空 billboard）
        const evidence = event.evidenceRef
          ? (this.store.evidenceSearch(event.evidenceRef).find((e) => e.evidenceRef === event.evidenceRef)?.content ?? "")
          : "";
        tx.putNotification({
          notificationId,
          eventSeq: event.eventSeq,
          billboardJson: JSON.stringify(
            makeBillboard(notificationId, { entityRef: ref, verdict: event.to as Verdict, evidence }),
          ),
        });
        const delivered: string[] = [];
        const parked: string[] = [];
        for (const subRow of subs) {
          const addressing: SubscriptionAddressing =
            subRow.origin === "session"
              ? { origin: "session", scope: subRow.scope ?? "project", sourceSessionId: subRow.sessionId }
              : { origin: "auto", scope: "project" };
          for (const target of deliveryTargets(addressing, deps.activeSessions)) {
            if (tx.getDelivery(notificationId, target)) continue; // I10 恰一行
            const active = deps.activeSessions.some((s) => s.sessionId === target);
            // parked 态由 domain 迁移表推导（pending + session-closed，E1 正典边）
            const closed = transitionDelivery("pending", "session-closed");
            if (!closed.ok) throw new Error(`fanOut: canonical edge pending+session-closed rejected: ${closed.reason}`);
            tx.putDelivery({
              notificationId,
              sessionId: target,
              state: active ? "pending" : closed.to,
              recordEpoch: this.ownerEpoch,
            });
            (active ? delivered : parked).push(target);
          }
        }
        return { notificationId, eventSeq: event.eventSeq, delivered, parked };
      }),
    );
  }

  /**
   * drain（票 11，D2a）：只投 parked——重投 = parked 经 drain-redeliver 正典边回 accepted
   * （两段式：accepted = 在线重试态，wake/verified 归 transport/transcript）。
   * dead-letter 零进入：出口仅 reckon 对账 / query 查看 / 24h re-push，不经 drain——本方法结构上只读 parkedDeliveries。
   * deadLetterSummary 为只读摘要（可见性三件套①）；最老年龄按底层事件 occurredAt 计
   * （DeliveryRow 无入列时间戳，B 层近似）；now 缺省时 age 为 null。
   * 范围标注：命中规则本票只落 sourceSessionId 精确匹配（行 sessionId == 连接 session）；
   * scope 匹配第二规则需行携带 scope（store 行无此字段），归订阅/行形状后绕票。
   * I12 epoch fence：重投仅限本 epoch 的 parked 行（epochAccepts 过滤）——僵尸 daemon
   * 不重投别的世代记录，异 epoch 行不转换不返回（留给正确 epoch 的 daemon）。
   */
  drain(opts: { sessionId?: string; now?: number } = {}): DrainResult {
    const filter = opts.sessionId ? { sessionId: opts.sessionId } : {};
    const parked = this.store
      .parkedDeliveries(filter)
      .filter((row) => epochAccepts(row.recordEpoch, this.ownerEpoch));
    const dead = this.store.deadLetters(filter);
    const drained = this.store.tx((tx) =>
      parked.flatMap((row) => {
        const edge = transitionDelivery(row.state, "drain-redeliver");
        if (!edge.ok) return []; // 防御：快照后竞态变业（理论不可达）
        tx.putDelivery({ ...row, state: edge.to });
        return [{ notificationId: row.notificationId, sessionId: row.sessionId }];
      }),
    );
    let oldestAgeMs: number | null = null;
    if (dead.length > 0 && opts.now !== undefined) {
      const oldestOccurredAt = this.store.tx((tx) =>
        Math.min(...dead.map((d) => Date.parse(tx.getEvent(d.notificationId)?.occurredAt ?? ""))),
      );
      if (Number.isFinite(oldestOccurredAt)) oldestAgeMs = opts.now - oldestOccurredAt;
    }
    return { drained, deadLetterSummary: { count: dead.length, oldestAgeMs } };
  }

  /**
   * query（票 11，读侧归一）：实体清单（state/payload 摘要/eventSeq/lastProbedAt/backlog）
   * + listChildren 单层展开 + per-entity backlog + deadLetters 清单 + B4 懒重探标记。
   * backlog/deadLetters/eventSeq 归属：delivery/notificationId 经事件 join（tx 批量点查）。
   * 过滤面本票最小化 {entityRef}（op 表 scope/session 过滤需订阅-实体 join 面，随订阅票补）。
   */
  query(filter: { entityRef?: EntityRef } = {}, probe?: QueryProbeCtx): QueryResult {
    const entities = this.store.queryEntities({});
    const outbox = this.store.outboxBatch(Number.MAX_SAFE_INTEGER);
    const pending = this.store.pendingDeliveries({});
    const dead = this.store.deadLetters({});
    const joins = this.store.tx((tx) => {
      const latestSeq = new Map<string, number>();
      const backlogByRef = new Map<string, number>();
      const deadList: { notificationId: string; sessionId: string; entityRef: EntityRef }[] = [];
      for (const o of outbox) {
        const ev = tx.getEvent(o.notificationId);
        if (!ev) continue;
        const k = entityRefKeyOf({ type: ev.entityRefType, key: ev.entityRefKey });
        latestSeq.set(k, Math.max(latestSeq.get(k) ?? 0, ev.eventSeq));
      }
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
      return { latestSeq, backlogByRef, deadList };
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
        eventSeq: joins.latestSeq.get(k) ?? null,
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

    const selected = filter.entityRef
      ? entities.filter((e) => e.type === filter.entityRef!.type && e.key === filter.entityRef!.key)
      : entities;
    const deadLetters = filter.entityRef
      ? joins.deadList.filter((d) => sameEntityRef(d.entityRef, filter.entityRef!))
      : joins.deadList;
    return { entities: selected.map((e) => entryOf(e, true)), deadLetters };
  }

  /**
   * evidence（票 11）：FTS5 点查（B 层 = store.evidenceSearch 朴素子串 + 精确 ref 收口）。
   * 双 ref 形态：直接 evidence 行 ref，或 billboard 截断指针（= notificationId）→ 事件
   * evidenceRef → 全文（截断只发生在 billboard 内联，指针解引用不被吞）。truncated =
   * 全文超 2KB 内联上限（EVIDENCE_INLINE_LIMIT，UTF-8 字节）。
   */
  evidence(evidenceRef: string): { content: string; truncated: boolean } {
    const direct = this.store.evidenceSearch(evidenceRef).find((e) => e.evidenceRef === evidenceRef);
    const row =
      direct ??
      (() => {
        const event = this.store.tx((tx) => tx.getEvent(evidenceRef));
        return event?.evidenceRef
          ? this.store.evidenceSearch(event.evidenceRef).find((e) => e.evidenceRef === event.evidenceRef)
          : undefined;
      })();
    if (!row) throw new Error(`evidence not found: ${evidenceRef}`);
    return { content: row.content, truncated: Buffer.byteLength(row.content, "utf8") > EVIDENCE_INLINE_LIMIT };
  }

  /**
   * validate（票 11，静态面）：三类错误同步拒（错误信息一律列可用选项）+ ADR 0004 已知
   * 副作用 pattern 命中出 warning 不阻断。数据全部来自构造注入注册表（I-01）；live-run
   * 执行（verdict/durationMs）归 prober 后续票，kernel 不 spawn。
   */
  validate(req: ValidateRequest): ValidateResult {
    const entry = this.registry.find((r) => r.profileId === req.profile);
    if (!entry) {
      return {
        ok: false,
        error: "profile-not-found",
        reason: `profile "${req.profile}" 未找到 — 可用: [${this.registry.map((r) => r.profileId).sort().join(", ")}]`,
      };
    }
    if (req.template !== undefined && req.check !== undefined) {
      return {
        ok: false,
        error: "checker-declaration",
        reason: "template 与 check 二选一：模板形态（check 由模板派生）或 ad-hoc 形态（显式声明 check）",
      };
    }
    if (req.template !== undefined) {
      const tpl = entry.templates.find((t) => t.name === req.template);
      if (!tpl) {
        return {
          ok: false,
          error: "profile-not-found",
          reason: `template "${req.template}" 未找到 — 可用: [${entry.templates.map((t) => t.name).join(", ")}]`,
        };
      }
      // own-property 判定（票 04 校验器同修法）：不吃 Object.prototype 原型链（"constructor" 等）；显式 undefined 仍算缺失
      const provided = req.params ?? {};
      const missing = (tpl.params ?? []).filter(
        (p) => !Object.prototype.hasOwnProperty.call(provided, p) || provided[p] === undefined,
      );
      if (missing.length > 0) {
        return { ok: false, error: "invalid-params", reason: `缺少必填参数: ${missing.join(", ")}` };
      }
    }
    const check = req.check;
    if (check !== undefined && check.trim() === "") {
      return { ok: false, error: "checker-declaration", reason: "check 声明为空" };
    }
    if (check === undefined && req.template === undefined) {
      return { ok: false, error: "checker-declaration", reason: "ad-hoc 形态必须显式声明 check（模板形态由模板派生）" };
    }
    const warnings = (entry.sideEffectPatterns ?? [])
      .filter((p) => (check ?? "").includes(p))
      .map((p) => `check 命中已知副作用 pattern "${p}"（ADR 0004：探测零副作用，不阻断）`);
    return { ok: true, warnings };
  }

  /** templates（票 11）：模板元数据清单，全部来自注册表注入内容（渐进式披露面）。 */
  templates(profile?: string): { templates: readonly TemplateMeta[] } {
    if (profile !== undefined && !this.registry.some((r) => r.profileId === profile)) {
      throw new Error(`profile "${profile}" 未找到 — 可用: [${this.registry.map((r) => r.profileId).sort().join(", ")}]`);
    }
    const templates = this.registry
      .filter((r) => profile === undefined || r.profileId === profile)
      .flatMap((r) => r.templates.map((t) => ({ profileId: r.profileId, ...t })));
    return { templates };
  }

  /**
   * 串行消费的事务内形态（I1：事件 + 实体状态 + outbox 行同事务原子）。
   * appendIfMissing 语义：同 id 同内容 skipped（零写入）/ 异内容 IntentCorruption /
   * appended（putEvent + putEntity 写回 + putOutbox 确定性 notificationId = eventId）。
   */
  private consumeTx(tx: TxView, intent: TransitionIntent): ConsumeOutcome {
    const existing = tx.getEvent(intent.eventId);
    if (existing) {
      if (!sameContent(existing, intent)) {
        throw new IntentCorruption(
          `corruption: event ${intent.eventId} exists with different content (deterministic replay violated / multi-writer)`,
        );
      }
      // F2：相同历史事件直接跳过，不做封闭集校验（状态改名后重放豁免）
      return { kind: "skipped" };
    }
    // F2：封闭集执法只落在追加路径（from 侧不校验——migrateState 的历史旧名态合法）
    requireStateIn(this.states, intent.to);
    const event = intentToEvent(intent);
    tx.putEvent(toEventRow(event));
    const entity = tx.getEntity(intent.entityRef.type, intent.entityRef.key);
    if (!entity) throw new Error(`consume rejected: unknown entity ${entityRefKeyOf(intent.entityRef)}`);
    tx.putEntity({
      ...entity,
      state: intent.to,
      ...(intent.payload !== undefined ? { payload: intent.payload } : {}),
    });
    tx.putOutbox({ notificationId: intent.eventId, eventSeq: intent.eventSeq });
    return { kind: "appended", event };
  }

  /** 有界重试（3 次总尝试）：瞬时失败重跑整个事务单元；corruption 确定性失败不重试；越界 = dead-letter 语义抛出（intent 身份随错误保留）。 */
  private withRetry<T>(label: string, fn: () => T): T {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_INTENT_ATTEMPTS; attempt++) {
      try {
        return fn();
      } catch (err) {
        if (err instanceof IntentCorruption) throw err;
        lastError = err;
      }
    }
    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(
      `dead-letter: ${label} exhausted ${MAX_INTENT_ATTEMPTS} consume attempts — last error: ${reason}`,
    );
  }
}
