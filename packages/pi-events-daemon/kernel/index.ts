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
 * - eventSeq（写入轨）从事件流尾恢复——经 store.outboxMaxEventSeq() 聚合下推（outbox 行与
 *   transition 1:1 同事务写入，I1 组合面；票 42 全表拉收编）。
 */
import {
  type EntityRef,
  type TransitionIntent,
  type Transitioned,
  type Verdict,
  entityRefKeyOf,
  sameEntityRef,
} from "../domain/types.ts";
import {
  adoptThresholds,
  checkForPhase,
  cronNextMs,
  epochAccepts,
  intentToEvent,
  planTransition,
  requireStateIn,
  restoreSlotThresholds,
  runnerSlotKey,
} from "../domain/intent.ts";
import type { IntentSequences, ThresholdConfig } from "../domain/intent.ts";
import {
  type SubscriptionAddressing,
  type SubscriptionScope,
  deliveryTargets,
  makeBillboard,
  onMatches,
  transitionDelivery,
} from "../domain/delivery.ts";
import { publish as domainPublish, type Entity } from "../domain/entity.ts";
import type { EventRow, Store, SubscriptionRow, TxView } from "../store/index.ts";

// I-01 类型面：profiles 依 eda-profiles-deps 只许经 kernel 取 domain 类型（profiles→{domain,protocol,store} 全禁），
// 故在此转发 EntityRef；单一来源仍是 domain/types.ts（本文件上方 import 同源，零第二定义）。
export type { EntityRef } from "../domain/types.ts";

/** Intent 消费重试上界（spec 自定裁量：#31 仅"有限重试"未定数值，round-2 备注 → 3 次）。 */
const MAX_INTENT_ATTEMPTS = 3;

/** 槽 ProbeSpec 缺省（ad-hoc 形态 spec 默认：60s interval；source 缺省 poll——watch 源随 checker 声明携带）。 */
const DEFAULT_PROBE_SCHEDULE: NonNullable<SubscribeOpts["schedule"]> = { type: "interval", intervalMs: 60_000 };
const DEFAULT_PROBE_SOURCE = "poll" as const;

// --- 票 24：register / subscribe / cancel 请求与结果形状（#31 操作面 subscribe/cancel 契约的 kernel 内形）---

/** register（publish/status op 的执行底座簿记）：实体注册记 profileId——一个实体一个状态机（US-32）。 */
export type RegisterRequest = {
  entityRef: EntityRef;
  profileId: string;
  state?: string | null;
  payload?: unknown;
  parent?: EntityRef;
  /** 票 40 评审 F2：status op register+首转换同事务（一个 store.tx 单元）——transition 拒绝
   *  （封闭集/retired）整体回滚，无半注册残留。结构位承载 to+occurredAt 的耦合（缺一即类型错）。 */
  firstTransition?: { to: string; occurredAt: string };
};

export type RegisterResult = {
  entityRef: EntityRef;
  state: string | null;
  created: boolean;
  /** firstTransition 实际产生的转换事件（同态无事件 = 缺省）。 */
  event?: TransitionResult;
};

/** subscribe opts（#31 操作面正典：{on, once, flip, template, smoke, sessionId, readyCheck, ttl, thresholds}；
 *  template 提升为请求结构位；schedule/source 是模板资产解析产物（caller 传入，kernel 零 profile import——opts 永不含 shell）。 */
export type SubscribeOpts = {
  /** on 谓词（状态值/状态集/命名转换）——I5：不进槽键。 */
  on?: string;
  once?: boolean;
  flip?: boolean;
  smoke?: boolean;
  readyCheck?: string;
  /** 到期自动关闭（I8）；触发归 loops L4，kernel 只持久化。 */
  ttl?: number;
  origin?: "session" | "auto";
  scope?: "project" | "user";
  failureThreshold?: number;
  successThreshold?: number;
  schedule?: { type: "interval"; intervalMs: number } | { type: "cron"; cron: string; tz?: string };
  source?: "poll" | "fs-watch" | "k8s-watch";
};

export type SubscribeRequest = {
  sessionId: string;
  entityRef: EntityRef;
  template: string;
  /** checker shell（模板资产派生 / ad-hoc）——profiles=静态面、kernel=协调、prober=执行。 */
  check: string;
  /** 模板所属 profile（US-32 冲突拒绝面；实体已归属异 profile 时拒绝）。 */
  profileId?: string;
  /** createdAt/closedAt 时钟注入（kernel 零时钟，occurredAt 同法）。 */
  now: number;
  opts?: SubscribeOpts;
};

/** smoke 首探结果（prober 同步路径的回流形状，= ProbeResult 去 slotKey）。 */
export type SmokeValidate = { verdict: Verdict; reason: string; evidence: string; durationMs: number };

/** subscribe 运行时 deps：smoke live-run 执行器（真壳 = prober 同步路径，B 层 fake 注入）。 */
export type SubscribeDeps = { probeSync?: (check: string) => SmokeValidate };

/** subscribe 结果（#31 操作面：成功 {subscriptionId, entityRef, state, validate?, warnings}；smoke 失败 {subscribed:false, validate} 不抛错）。 */
export type SubscribeResult =
  | { subscribed: true; subscriptionId: string; entityRef: EntityRef; state: string | null; validate?: SmokeValidate; warnings: readonly string[] }
  | { subscribed: false; validate: SmokeValidate };

/** cancel（op 契约幂等：未知/已关 → {cancelled:false}；sessionId 给定时校验归属；loops 内部关闭路径不带 sessionId，
 *  reason 覆盖全部关闭面：op 侧 cancelled/ttl + L0 verdict 侧 once-passed/failed-terminal（票 26））。 */
export type CancelRequest = {
  subscriptionId: string;
  sessionId?: string;
  reason?: "cancelled" | "ttl" | "once-passed" | "failed-terminal";
  now: number;
};

/** 幂等比较域（换参检测）：check/on/once/flip/readyCheck/ttl/origin/scope。
 *  thresholds 不入比较域——阈值是槽级（先建者定），差异走 adoptThresholds warning+沿用，不构成换参（票面验收分组）。 */
function sameSubscribeParams(row: SubscriptionRow, req: SubscribeRequest, opts: SubscribeOpts): boolean {
  return (
    row.check === req.check &&
    (row.on ?? undefined) === (opts.on ?? undefined) &&
    (row.once ?? false) === (opts.once ?? false) &&
    (row.flip ?? false) === (opts.flip ?? false) &&
    (row.readyCheck ?? undefined) === (opts.readyCheck ?? undefined) &&
    (row.ttlMs ?? undefined) === (opts.ttl ?? undefined) &&
    row.origin === (opts.origin ?? "session") &&
    (row.scope ?? undefined) === (opts.scope ?? undefined)
  );
}

/** 槽现值阈值：随槽内订阅的创建序恢复（先建者定跨重启延续，restoreSlotThresholds 正典路径）。 */
function slotThresholdsOf(rows: readonly SubscriptionRow[]): ThresholdConfig | null {
  const carried = rows.filter((r) => r.thresholds !== undefined);
  if (carried.length === 0) return null;
  return restoreSlotThresholds(carried.map((r) => ({ createdAt: r.createdAt, thresholds: r.thresholds! })));
}

/** transition / migrateState 的返回形状（publish 契约同族：{eventSeq, from, to}）。 */
export type TransitionResult = { eventSeq: number; from: string | null; to: string;
  /** 确定性事件 id（= notificationId）——loops 关闭路径 fanOut 物化投递目标用（评审 F11）。 */
  eventId: string };

/** 串行消费结果：appended 附带落库事件（断言面）；skipped = 同 id 同内容幂等重放。 */
export type ConsumeOutcome = { kind: "appended"; event: Transitioned } | { kind: "skipped" };

/** 同 id 异内容：确定性重放被破坏 / 多写者（票 09 corruption 判定的 kernel 侧形态）。确定性失败不重试。 */
export class IntentCorruption extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntentCorruption";
  }
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

// 票 42：query 读模型形状迁 kernel/query.ts（本文件 re-export 保持既有 import 路径）
export type { QueryEntityEntry, QueryProbeCtx, QueryResult } from "./query.ts";
import { createQueryFace, type QueryFace, type QueryProbeCtx, type QueryResult } from "./query.ts";

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
  /** 票 42：读模型面（query/evidence 实现迁 kernel/query.ts；本类保留委托签名，消费面不变）。 */
  private readonly readFace: QueryFace;
  /** I12：本 daemon 实例世代（daemon-main 组合根传入；0 = 未接线）。 */
  private readonly ownerEpoch: number;
  /** 订阅 id 序（sub-NNNN）：从既有行恢复 max——重启后新订阅不撞旧 id。 */
  private subSeq: number;

  constructor(
    private readonly store: Store,
    /** I-01：封闭状态集（数据注入）。校验 to 用；from=null 恒合法。 */
    private readonly states: ReadonlySet<string>,
    /** decisionOrder 起点双轨之决策轨：mutation line 尾位点（重放不得重新编号）。 */
    decisionOrder: number,
    opts: { ownerEpoch?: number } = {},
  ) {
    this.readFace = createQueryFace(store);
    this.sequences = { decisionOrder, eventSeq: store.outboxMaxEventSeq() };
    this.ownerEpoch = opts.ownerEpoch ?? 0;
    this.subSeq = 0;
    for (const s of store.querySubscriptions({})) {
      const m = /^sub-(\d+)$/.exec(s.subscriptionId);
      if (m) this.subSeq = Math.max(this.subSeq, Number(m[1]));
    }
  }

  /** 订阅 id 铸造：sub-NNNN 单调（prototype 同形），重启经构造恢复位点。 */
  private nextSubscriptionId(): string {
    return `sub-${String(++this.subSeq).padStart(4, "0")}`;
  }

  /**
   * register（簿记底座）：实体注册记 profileId。同 EntityRef 已归属异 profile → 明确拒绝
   * （不静默覆盖，US-32：一实体不跨两 profile）；同 profile 重注册幂等（不覆盖既有 state/payload）。
   * firstTransition（票 40 评审 F2）：status op 的 register+首转换同事务——转换拒绝（封闭集/retired）
   * 整体回滚（含 E16 profileId 补写），无半注册残留。
   */
  register(req: RegisterRequest): RegisterResult {
    return this.withRetry(`register ${entityRefKeyOf(req.entityRef)}`, () => {
      const planned = this.store.tx(
        (tx): { result: RegisterResult; sequences?: IntentSequences } => {
          const existing = tx.getEntity(req.entityRef.type, req.entityRef.key);
          let state: string | null;
          let created: boolean;
          if (existing) {
            if (existing.profileId && existing.profileId !== req.profileId) {
              throw new Error(
                `register rejected: entity ${entityRefKeyOf(req.entityRef)} already belongs to profile "${existing.profileId}" — refusing re-register under "${req.profileId}" (one entity, one profile/state machine)`,
              );
            }
            if (!existing.profileId) {
              // 评审 E16：无 profileId 遗留实体——register 同事务补写（保留 state/payload/parent），
              // 补写后异 profile 注册走上方拒绝路径（US-32：一实体一 profile）
              tx.putEntity({ ...existing, profileId: req.profileId });
            }
            state = existing.state;
            created = false;
          } else {
            if (req.state !== undefined && req.state !== null) requireStateIn(this.states, req.state);
            tx.putEntity({
              type: req.entityRef.type,
              key: req.entityRef.key,
              state: req.state ?? null,
              ...(req.payload !== undefined ? { payload: req.payload } : {}),
              profileId: req.profileId,
              ...(req.parent ? { parentType: req.parent.type, parentKey: req.parent.key } : {}),
            });
            state = req.state ?? null;
            created = true;
          }
          if (req.firstTransition === undefined) return { result: { entityRef: req.entityRef, state, created } };
          // 同事务首转换：transitionTx 拒绝即整 tx 回滚（register 无残留）
          const t = this.transitionTx(tx, req.entityRef, req.firstTransition.to as Verdict, req.firstTransition.occurredAt);
          if (t === null) return { result: { entityRef: req.entityRef, state, created } };
          return {
            result: { entityRef: req.entityRef, state: t.result.to, created, event: t.result },
            sequences: t.sequences,
          };
        },
      );
      // F1 同 transition：游标推进仅在 Store.tx 成功返回后（提交失败不烧号，重试重排同序）
      if (planned.sequences !== undefined) this.sequences = planned.sequences;
      return planned.result;
    });
  }

  /**
   * subscribe（票 24）：订阅生命周期 + RunnerSlot 编排。
   * - 幂等：同 session 同 (entityRef, template) 同参 → 返回既有订阅（R1；阈值差异不构成换参，走 warning+沿用）。
   * - 换参 = 关旧开新（checker 替换）：同 session 同槽旧订阅关（replaced）、新订阅开；旧订阅在途投递不撤（已落盘照投）。
   * - 槽（I5）：键 = (EntityRef, 模板) 不含谓词；首订阅创建（ProbeSpec + RunLedger，阈值计数从 0 起 = 先建者定），
   *   末 cancel 销毁（refcount 0 计数清零；probe_spec 行无 delete 语义，refcount 0 即惰性终结——L1 不调度）。
   * - smoke：checker 首探经注入的 prober 同步路径（kernel 协调不自行 spawn）；非 passed →
   *   {subscribed:false, validate} 不建订阅不抛错（通过才落订阅）。
   * 一个方法 = 一个事务单元（Subscribe 跨 ProbeSpec+RunLedger+Subscription 例外按 store spec 单写者事务处理）。
   */
  subscribe(req: SubscribeRequest, deps: SubscribeDeps = {}): SubscribeResult {
    const opts = req.opts ?? {};
    // 评审 D11：schedule 校验在事务外（确定性拒绝不进 withRetry）——坏 cron 运行期只会在 dispatch
    // 逐槽记 error 永不触发，入口即拒（domain cronNextMs 单一解析）
    const incomingSchedule = opts.schedule ?? DEFAULT_PROBE_SCHEDULE;
    if (incomingSchedule.type === "cron") {
      try {
        cronNextMs(incomingSchedule.cron, 0);
      } catch (err) {
        throw new Error(
          `subscribe rejected: invalid cron schedule: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    // smoke 先于事务：checker 执行不进 tx，事务重试不重跑探针
    let validate: SmokeValidate | undefined;
    if (opts.smoke) {
      if (!deps.probeSync) {
        throw new Error("subscribe smoke: deps.probeSync 未注入（live-run 归 prober 同步路径，kernel 仅协调）");
      }
      validate = deps.probeSync(req.check);
      if (validate.verdict !== "passed") return { subscribed: false, validate };
    }
    const entity = this.store.getEntity(req.entityRef.type, req.entityRef.key);
    if (!entity) {
      throw new Error(`subscribe rejected: unknown entity ${entityRefKeyOf(req.entityRef)} — register/status first`);
    }
    if (req.profileId && entity.profileId && entity.profileId !== req.profileId) {
      throw new Error(
        `subscribe rejected: entity ${entityRefKeyOf(req.entityRef)} belongs to profile "${entity.profileId}", refusing subscribe under "${req.profileId}" (US-32: one entity never split across two profiles)`,
      );
    }
    return this.withRetry(`subscribe ${entityRefKeyOf(req.entityRef)}#${req.template}`, () =>
      this.store.tx((tx): SubscribeResult => {
        const openAll = () =>
          this.store
            .querySubscriptions({ entityRefType: req.entityRef.type, entityRefKey: req.entityRef.key })
            .filter((s) => s.closedAt === undefined);
        const incoming: ThresholdConfig = {
          failureThreshold: opts.failureThreshold ?? 1,
          successThreshold: opts.successThreshold ?? 1,
        };
        const mine = openAll().filter((s) => s.sessionId === req.sessionId && s.template === req.template);
        const slotOthers = openAll().filter((s) => s.template === req.template && s.sessionId !== req.sessionId);
        const adopted = adoptThresholds(slotThresholdsOf(slotOthers), incoming);
        const slotKey = runnerSlotKey(req.entityRef, req.template);
        const slotSpec = tx.getProbeSpec(slotKey);
        const incomingSource = opts.source ?? DEFAULT_PROBE_SOURCE;
        // 评审 F19：schedule/source 改变实际探测行为，幂等比较必须含槽 ProbeSpec 现值
        const sameProbeConfig =
          slotSpec !== undefined &&
          slotSpec.source === incomingSource &&
          slotSpec.schedule.type === incomingSchedule.type &&
          (incomingSchedule.type === "interval"
            ? slotSpec.schedule.intervalMs === incomingSchedule.intervalMs
            : slotSpec.schedule.cron === incomingSchedule.cron);
        if (slotOthers.length > 0 && slotSpec) {
          // 评审 C9/F19：共享槽 = 单一 ProbeSpec 服务全员（I5）——相位/两阶段形态/schedule 配置不一致
          // 在入口明确拒绝；静默沿用先建者配置（错探针/漏探针）比拒绝更贵（错误列形态 = 抛错进 errors）。
          const incomingFlip = opts.flip ?? false;
          const incomingFlipCheck = opts.readyCheck ?? req.check;
          for (const other of slotOthers) {
            if ((other.phase ?? "startup") === "flip")
              throw new Error(`subscribe rejected: shared slot ${slotKey} 已有 flip 相位订阅（MVP 不支持混合相位订阅）`);
            if ((other.flip ?? false) !== incomingFlip)
              throw new Error(
                `subscribe rejected: shared slot ${slotKey} 两阶段形态不一致（other=${other.flip ? "flip" : "startup"} vs incoming=${incomingFlip ? "flip" : "startup"}）`,
              );
            if (incomingFlip && (other.readyCheck ?? other.check) !== incomingFlipCheck)
              throw new Error(`subscribe rejected: shared slot ${slotKey} flip 相位 checker 不一致（readyCheck 冲突）`);
          }
          if (!sameProbeConfig)
            throw new Error(`subscribe rejected: shared slot ${slotKey} 探测配置（schedule/source）与先建者冲突`);
        }
        // 幂等：同参返回既有（R1）；schedule/source 变化探测行为，同参比较含槽配置（评审 F19）
        const existing = mine.find((s) => sameSubscribeParams(s, req, opts) && sameProbeConfig);
        if (existing) {
          // 评审 E15：幂等分支的槽现值必须含 existing 自身——thresholds 不入比较域，同参异阈值仍幂等；
          // 异阈值 → warning + 沿用既有槽值（槽不重建，先建者定跨幂等重订阅延续）
          const adoptedExisting = adoptThresholds(slotThresholdsOf([...slotOthers, existing]), incoming);
          return {
            subscribed: true,
            subscriptionId: existing.subscriptionId,
            entityRef: req.entityRef,
            state: entity.state,
            validate,
            warnings: adoptedExisting.warning ? [adoptedExisting.warning] : [],
          };
        }
        // 换参 = 关旧开新（checker 替换；同槽其余 session 订阅不动）
        for (const old of mine) {
          tx.putSubscription({ ...old, closedAt: req.now, closedReason: "replaced" });
        }
        if (slotOthers.length === 0) {
          // 槽（重）建：先建者定——ProbeSpec/check 与 RunLedger 计数从 0 起（solo 换参即 checker 替换）。
          // generation 递增（评审 B 组）：销毁重建/换参重建 = 旧代 +1，旧 completion/阈值计数不跨代
          const prevLedger = tx.getRunLedger(slotKey);
          tx.putProbeSpec({
            slotKey,
            check: req.check,
            schedule: opts.schedule ?? DEFAULT_PROBE_SCHEDULE,
            source: opts.source ?? DEFAULT_PROBE_SOURCE,
          });
          tx.putRunLedger({
            slotKey,
            epoch: this.ownerEpoch,
            refcount: 1,
            consecutiveFails: 0,
            entityRefType: req.entityRef.type,
            entityRefKey: req.entityRef.key,
            generation: (prevLedger?.generation ?? -1) + 1,
          });
        } else {
          const ledger = tx.getRunLedger(slotKey);
          if (!ledger) throw new Error(`subscribe: slot ledger missing for shared slot ${slotKey}`);
          tx.putRunLedger({
            ...ledger,
            refcount: slotOthers.length + 1,
            entityRefType: ledger.entityRefType ?? req.entityRef.type,
            entityRefKey: ledger.entityRefKey ?? req.entityRef.key,
          });
        }
        const subscriptionId = this.nextSubscriptionId();
        tx.putSubscription({
          subscriptionId,
          sessionId: req.sessionId,
          entityRefType: req.entityRef.type,
          entityRefKey: req.entityRef.key,
          template: req.template,
          check: req.check,
          // on 允许 string | string[]（skill 文档形态）；SQLite bind 只收标量——数组序列化为 JSON 串，读取侧 str() 再解析（#31 follow-up：adhoc 订阅数组 on 崩 param-11）
          on: Array.isArray(opts.on) ? JSON.stringify(opts.on) : opts.on,
          once: opts.once,
          flip: opts.flip,
          readyCheck: opts.readyCheck,
          thresholds: adopted.thresholds,
          origin: opts.origin ?? "session",
          scope: opts.scope,
          createdAt: req.now,
          ttlMs: opts.ttl,
        });
        return {
          subscribed: true,
          subscriptionId,
          entityRef: req.entityRef,
          state: entity.state,
          validate,
          warnings: adopted.warning ? [adopted.warning] : [],
        };
      }),
    );
  }

  /**
   * cancel（op 契约幂等）：关订阅 + 槽 refcount 重算（归零 = 槽销毁）。在途投递不撤（delivery 行独立于订阅）。
   * loops 内部关闭路径（once-passed/failed-terminal/ttl）复用本方法：不带 sessionId、reason 指明关闭路径。
   */
  cancel(req: CancelRequest): { cancelled: boolean } {
    // 归属校验在重试面外：确定性拒绝不进 withRetry（重试无意义，包装稀释错误语义）——subscribe 的实体/profile 校验同法
    const current = this.store.getSubscription(req.subscriptionId);
    if (!current || current.closedAt !== undefined) return { cancelled: false };
    if (req.sessionId !== undefined && current.sessionId !== req.sessionId) {
      throw new Error(
        `cancel rejected: subscription ${req.subscriptionId} belongs to session ${current.sessionId}, not ${req.sessionId}`,
      );
    }
    return this.withRetry(`cancel ${req.subscriptionId}`, () =>
      this.store.tx((tx) => {
        const row = tx.getSubscription(req.subscriptionId);
        if (!row || row.closedAt !== undefined) return { cancelled: false };
        tx.putSubscription({ ...row, closedAt: req.now, closedReason: req.reason ?? "cancelled" });
        this.refreshSlotRefCount(tx, row);
        return { cancelled: true };
      }),
    );
  }

  /**
   * unregister（终审裁定②）：实体 retired 标记的唯一写路径（#31：ad-hoc terminal → retired，
   * 不复活——publish/transition/migrate 对 retired 的拒绝由 domain/kernel 既有执法承担，本方法只标记）。
   * 消费方 = loops L4 ephemeral 清理（7d 到期判定留在 L4，标记写路径归此）。幂等契约对齐 cancel：
   * 未知/已 retired → {unregistered:false} 不抛；既有快照字段（state/payload/profile/parent）不动。
   */
  unregister(ref: EntityRef): { unregistered: boolean } {
    return this.withRetry(`unregister ${entityRefKeyOf(ref)}`, () =>
      this.store.tx((tx) => {
        const entity = tx.getEntity(ref.type, ref.key);
        if (!entity || entity.retired) return { unregistered: false };
        tx.putEntity({ ...entity, retired: true });
        return { unregistered: true };
      }),
    );
  }

  /**
   * 两阶段订阅推进（票 26 L0 消费路径调用）：startup passed → phase=flip（仅一跳，幂等）。
   * solo 槽（无其他活跃订阅）同步替换 ProbeSpec.check = readyCheck ?? check（flip 判定第二 check，
   * 缺省沿用 check）；共享槽不换——first-creator fetch 共享（I5），混合相位 MVP 不支持。
   */
  flipSubscription(subscriptionId: string): { advanced: boolean } {
    return this.withRetry(`flip ${subscriptionId}`, () =>
      this.store.tx((tx) => {
        const row = tx.getSubscription(subscriptionId);
        if (!row || row.closedAt !== undefined) return { advanced: false };
        if ((row.phase ?? "startup") !== "startup") return { advanced: false };
        tx.putSubscription({ ...row, phase: "flip" });
        if (row.template && row.check) {
          const slotKey = runnerSlotKey({ type: row.entityRefType, key: row.entityRefKey }, row.template);
          const others = this.store
            .querySubscriptions({ entityRefType: row.entityRefType, entityRefKey: row.entityRefKey })
            .filter(
              (s) => s.closedAt === undefined && s.template === row.template && s.subscriptionId !== row.subscriptionId,
            );
          const spec = tx.getProbeSpec(slotKey);
          if (spec) {
            // 评审 F12：相位与 checker 一致时统一切换槽 ProbeSpec（solo = 无 others 同路径；
            // 共享槽全员 flip 且 flip checker 一致才换——不一致配置 subscribe 入口已拒，此处防御性再验）
            const selfFlipCheck = checkForPhase({ check: row.check, readyCheck: row.readyCheck }, "flip");
            const othersAllFlip = others.every((s) => (s.phase ?? "startup") === "flip");
            const othersChecksConsistent = others.every(
              (s) => checkForPhase({ check: s.check ?? spec.check, readyCheck: s.readyCheck }, "flip") === selfFlipCheck,
            );
            if (othersAllFlip && othersChecksConsistent) {
              tx.putProbeSpec({ ...spec, check: selfFlipCheck });
            }
          }
        }
        return { advanced: true };
      }),
    );
  }

  /** 槽 refcount 重算（订阅关闭后）；归零 = 槽销毁（计数清零，账本行保留惰性终结）。
   *  计数排除本行：MemoryStore 事务内读的是已提交视图（本行关闸尚未提交），排除后与 SQLite 同连接读语义一致。 */
  private refreshSlotRefCount(tx: TxView, sub: SubscriptionRow): void {
    const ref = { type: sub.entityRefType, key: sub.entityRefKey };
    const slotKey = runnerSlotKey(ref, sub.template ?? "");
    const ledger = tx.getRunLedger(slotKey);
    if (!ledger) return;
    const refcount = this.store
      .querySubscriptions({ entityRefType: ref.type, entityRefKey: ref.key })
      .filter((s) => s.closedAt === undefined && s.template === sub.template && s.subscriptionId !== sub.subscriptionId)
      .length;
    tx.putRunLedger({
      slotKey,
      epoch: ledger.epoch,
      refcount,
      consecutiveFails: refcount === 0 ? 0 : ledger.consecutiveFails,
      lastVerdict: refcount === 0 ? undefined : ledger.lastVerdict,
      nextDueAt: refcount === 0 ? undefined : ledger.nextDueAt,
      entityRefType: ledger.entityRefType ?? ref.type,
      entityRefKey: ledger.entityRefKey ?? ref.key,
      generation: ledger.generation,
    });
  }

  /**
   * transition 事务体（transition/register firstTransition 共用；调用方必须在 store.tx 内调）。
   * verdict → 校验（存在/未 retired/I3 封闭集含 from）→ planTransition 双轨分配 → 串行消费
   * （tx 内 appendIfMissing + 实体写回 + outbox 行，I1 原子）。同态 verdict → null（无转换无事件，ADR 0003）。
   */
  private transitionTx(
    tx: TxView,
    ref: EntityRef,
    verdict: Verdict,
    occurredAt: string,
  ): { result: TransitionResult; sequences: IntentSequences } | null {
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
    return { result: { eventSeq: intent.eventSeq, from: intent.from, to: intent.to, eventId: intent.eventId }, sequences };
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
      const planned = this.store.tx((tx) => this.transitionTx(tx, ref, verdict, occurredAt));
      if (planned === null) return null;
      this.sequences = planned.sequences;
      return planned.result;
    });
  }

  /**
   * publish（票 40 接线：#31 操作面 publish/SetState 的 kernel 内形）——agent 断言转换。
   * 与 probe 路径（transition）的差异：to 为封闭集任意状态（非法 to 同步报错）、可携带
   * contentIdentity/payload（payload 随事务写回实体）；同态且无 contentIdentity = 无事件
   * （ADR 0003：自转换事件族以 (state, contentIdentity) 为键，返回 null）；retired 拒 publish。
   * 返回 TransitionResult | null（null = 同态无事件；语义与 transition 的 null 一致）。
   */
  publish(
    ref: EntityRef,
    to: string,
    opts: { contentIdentity?: string | null; payload?: unknown; occurredAt: string },
  ): TransitionResult | null {
    // F1 同 transition：回调只产出 {业务结果, 待推进游标}，Store.tx 成功返回后才推进——
    // 回调完成、提交失败的回滚场景下重试重排同序 → 同确定性 eventId（幂等不烧号）
    const planned = this.withRetry(`publish ${entityRefKeyOf(ref)}/${to}`, () =>
      this.store.tx(
        (tx): { result: TransitionResult; sequences: IntentSequences } | null => {
          const row = tx.getEntity(ref.type, ref.key);
          if (!row) throw new Error(`publish rejected: unknown entity ${entityRefKeyOf(ref)} — register/status first`);
          if (row.retired) {
            throw new Error(`publish rejected: entity ${entityRefKeyOf(ref)} is retired — retired entities never revive`);
          }
          // F3（票 40 评审 F9）：from 态同受封闭集执法（null 首态豁免）——旧名态不经 publish 绕行 B7，
          // 唯一出口是 migrateState 显式迁移；同步拒保持 kernel 错误面（domain 同款检查仅双保险）
          requireStateIn(this.states, to);
          requireStateIn(this.states, row.state);
          // 票 40 评审 F3：edge-trigger（(state, contentIdentity) 对未变 → null，ADR 0003）判定
          // 归 domain publish 纯函数——kernel 不自写判定（只查 to 不查身份 → 同对重复发事件的根因）
          const sequences = {
            decisionOrder: this.sequences.decisionOrder + 1,
            eventSeq: this.sequences.eventSeq + 1,
          };
          const intent = domainPublish(
            {
              ref,
              profileId: row.profileId ?? "",
              state: row.state,
              contentIdentity: row.contentIdentity ?? null,
              payload: row.payload ?? null,
              parent:
                row.parentType !== undefined && row.parentKey !== undefined
                  ? { type: row.parentType, key: row.parentKey }
                  : null,
              retired: row.retired ?? false,
            },
            {
              to,
              ...(typeof opts.contentIdentity === "string" ? { contentIdentity: opts.contentIdentity } : {}),
              ...(opts.payload !== undefined ? { payload: opts.payload } : {}),
            },
            {
              states: this.states,
              occurredAt: opts.occurredAt,
              eventSeq: sequences.eventSeq,
              decisionOrder: sequences.decisionOrder,
            },
          );
          if (intent === null) return null;
          // payload 保真：publish 契约=不携带则不动既有快照（domain 无 payload 快照置 null，此处还原为不写）
          const effect = opts.payload === undefined && intent.payload === null ? { ...intent, payload: undefined } : intent;
          this.consumeTx(tx, effect);
          return {
            result: { eventSeq: intent.eventSeq, from: intent.from, to: intent.to, eventId: intent.eventId },
            sequences,
          };
        },
      ),
    );
    if (planned === null) return null;
    this.sequences = planned.sequences;
    return planned.result;
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
          return { result: { eventSeq: intent.eventSeq, from: intent.from, to: intent.to, eventId: intent.eventId }, sequences };
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
        const subs = this.store
          .querySubscriptions({ entityRefType: ref.type, entityRefKey: ref.key })
          // 评审 F18：on 谓词参与事件匹配——按事件终态评估，on="passed" 不再收 failed；缺省收全部
          .filter((s) => s.closedAt === undefined && onMatches({ to: event.to }, s.on)); // 已关订阅不收新投递（换参/cancel 后零新行；在途行不撤）
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
   * verify（票 28 L3 收口）：两段式 ack 终点——accepted → verified（正典边，domain 迁移表执法）。
   * 调用前提 = I9 点查命中（transcript-adapter 是唯一权威点，本方法不做判定只做收口写）。
   * 出参：{verified:true} 本次收口 / {verified:false, reason:"not-accepted" | "unknown-delivery"}
   * —— 已 verified/终态行再 verify 归 not-accepted（迁移表拒绝，无第二写，幂等面）。
   * I12 无 epoch fence（与 drain 相反）：verified 判定来自 transcript 全局真相（adapter 点查），
   * 异 epoch 行同收口——fence 只挡重投不挡对账，留 Accepted 不收口的异 epoch 行将无人收口。
   */
  verify(notificationId: string, sessionId: string): { verified: boolean; reason?: "not-accepted" | "unknown-delivery" } {
    return this.withRetry(`verify ${notificationId}/${sessionId}`, () =>
      this.store.tx((tx) => {
        const row = tx.getDelivery(notificationId, sessionId);
        if (!row) return { verified: false, reason: "unknown-delivery" as const };
        const edge = transitionDelivery(row.state, "verified");
        if (!edge.ok) return { verified: false, reason: "not-accepted" as const };
        tx.putDelivery({ ...row, state: edge.to });
        return { verified: true };
      }),
    );
  }

  /**
   * query（票 11，读侧归一）：实体清单 + 单层展开 + per-entity backlog + deadLetters + B4 懒重探标记。
   * 票 42：实现迁 kernel/query.ts 读模型（本类委托，LoopsHandle Pick 消费面不变）。
   */
  query(
    filter: { entityRef?: EntityRef; scope?: SubscriptionScope; sessionId?: string } = {},
    probe?: QueryProbeCtx,
  ): QueryResult {
    return this.readFace.query(filter, probe);
  }

  /** evidence（票 11）：双 ref 形态精确读。票 42：实现迁 kernel/query.ts（本类委托）。 */
  evidence(evidenceRef: string): { content: string; truncated: boolean } {
    return this.readFace.evidence(evidenceRef);
  }

  // 票 42：validate/templates 静态面迁 profiles（ProfileRegistry.validate/templates +
  // validateEntry/profileTemplates 纯函数）；注册表注入随消费面同步删除。

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
      // 票 40 评审 F3：自转换身份对现值随 publish 路径写回（edge-trigger 的跨调用输入；
      // probe 路径无身份字段 → 保留既有值）；显式 null = 清除（身份对回到无身份态）
      ...(intent.contentIdentity !== undefined ? { contentIdentity: intent.contentIdentity ?? undefined } : {}),
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
