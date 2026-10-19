/**
 * loops — 五控制循环的调度与触发（模块 spec loops.md）。票 25：L0 Mutation 唯一写者 + startLoops 骨架；
 * 票 26：L1 Probe（completion 回流消费 + cron/interval 到点排 probe + catch_up_one + once/readyCheck 调度）；
 * 票 27：L2 Deliver（outbox 消费→fanOut 编址 + update_hook/1s 兜底双通道唤醒 + per-session batch 合流
 * + 退避重试/dead-letter + SESSION_START drain+snapshot + 24h verified-absence re-push）。
 *
 * startLoops(ctx) 装配形态：fx 四端口 + Store 注入（票 25 面定）；Kernel 由 startLoops 构造并私有持有——
 * 与 loops.md「ctx 内注入 kernel」的偏差按票 25 要点裁定：kernel.transition/consumeIntent 是 L0 消费终点、
 * 票 10 双轨恢复前提（decisionOrder←mutation line、eventSeq←事件流尾）在 L0 侧落地（构造先于位点注入）。
 *
 * L0 唯一写者：kernel 变更方法的唯一调用路径 = submit() 队列，串行消费（提交序 = 消费序，
 * 双轨游标按消费序分配）。缓存纪律：状态缓存只在 store 提交回调（update_hook 等价）更新——
 * 写路径单一，缓存不可能先于提交。全部循环 level-trigger：L0 消费队列至空（无边缘依赖）。
 * L1→L0 串行链（D4）：prober completion（poll 到点执行 / fs-watch·k8s-watch 原生推送回流同路）经
 * ingestProbeResult 进 L0 队列，L0 消费时调 domain observeVerdict 评估阈值（翻转沿才 transition）
 * 与 onVerdict 真值表（once 关订阅 / twoStage flip 切换）——verdict 应用与订阅生命周期判定全在唯一写者内串行。
 */
import { type EntityRef, type TransitionIntent, type Verdict, entityRefKeyOf } from "../domain/types.ts";
import { createHash } from "node:crypto";
import {
  INITIAL_THRESHOLD_STATE,
  cronNextMs,
  deterministicEventId,
  observeVerdict,
  onVerdict,
  restoreSlotThresholds,
  runnerSlotKey,
  ttlExpired,
  type ThresholdState,
} from "../domain/intent.ts";
import { type SubscriptionScope, EVIDENCE_RETENTION, evidenceRetentionExpired } from "../domain/delivery.ts";
import { retiredCleanupDue } from "../domain/entity.ts";

// cronNextMs 归 domain（单一解析：kernel subscribe 校验 + loops 调度共用）；此处保持既有导出位兼容
export { cronNextMs } from "../domain/intent.ts";
import {
  Kernel,
  type CancelRequest,
  type RegisterRequest,
  type SubscribeDeps,
  type SubscribeRequest,
} from "../kernel/index.ts";
import { createDeliver } from "./deliver.ts";
import { Prober, type ProbeResult } from "../prober/index.ts";
import type { Clock, Exec, Fs, Pusher } from "../fx/index.ts";
import type { ProbeSpecRow, Store, SubscriptionRow } from "../store/index.ts";
import type { SessionRef, TranscriptAdapter } from "../transcript-adapter/index.ts";

/** L0 变更请求——kernel 变更方法（票 10 消费终点 transition/consumeIntent + 票 24/26 subscribe/cancel）的队列载体；
 *  probeVerdict 是 L1 回流（prober completion queue）进 L0 的串行链入口（D4：L1 消费回流，L0 唯一写者）；
 *  fanOut/sessionStart 是票 27 L2 入口（outbox 消费编址、SESSION_START 注册，kernel 方法仍只在 L0 消费内调）。 */
export type MutationRequest =
  | { kind: "transition"; ref: EntityRef; verdict: Verdict; occurredAt: string }
  | { kind: "consumeIntent"; intent: TransitionIntent }
  // 票 40：publish op（#31 操作面 agent 断言）——to 为封闭集任意状态，可携带 contentIdentity/payload
  | { kind: "publish"; ref: EntityRef; to: string; contentIdentity?: string | null; payload?: unknown; occurredAt: string }
  // 票 40 评审 F1/F2：register 经 L0（status/subscribe 的簿记底座；firstTransition 同事务含首转换）
  | { kind: "register"; req: RegisterRequest }
  // 终审裁定②：unregister（retired 标记）经 L0——L4 ephemeral 清理的写路径收归 kernel 唯一写法
  | { kind: "unregister"; ref: EntityRef }
  | { kind: "subscribe"; req: SubscribeRequest; deps?: SubscribeDeps }
  | { kind: "cancel"; req: CancelRequest }
  | { kind: "probeVerdict"; slotKey: string; verdict: Verdict; occurredAt: string;
      /** 评审 B 组：dispatch 时刻的槽 generation——旧代 completion 拒应用；缺省（watch 回流等无 dispatch 来源）不判代。 */
      generation?: number;
      /** 票 47：probe evidence 落盘铸造的指针（L1 回流处铸造；空 evidence 无指针）。 */
      evidenceRef?: string }
  | { kind: "fanOut"; notificationId: string }
  | { kind: "sessionStart"; sessionId: string; scope?: SubscriptionScope }
  | { kind: "sessionEnd"; sessionId: string }
  // 票 28：L3 verify 收口（I9 点查命中后经唯一写路径落账）+ drain 触发载体（L2/transport 接线前的队列面）
  | { kind: "verify"; notificationId: string; sessionId: string }
  | { kind: "drain"; sessionId?: string };


/** submit 结算面（票 40 op 结果管道）：消费成功携 kernel 结果，失败携原错误（不 reject——
 *  fire-and-forget 内部提交方忽略返回值也不产生 unhandled rejection；errors[] 面不变）。 */
export type SubmitOutcome = { ok: true; value: unknown } | { ok: false; error: unknown };

/** 提交回调维护的状态缓存（只读视图；运行期唯一写点在 store.onWrite 回调内，启动时另有种子投影 = 已提交状态初始快照，票 25 验收面）。 */
export interface LoopsCache {
  /** refKey（entityRefKeyOf）→ 已提交状态；逐提交与 store 实体表同步。 */
  readonly states: ReadonlyMap<string, string | null>;
}

/** startLoops 注入面（票 25：fx 四端口 + Store；states/ownerEpoch 是 kernel 构造数据，registry 是 onTransition 编排注入）。 */
export interface LoopsCtx {
  clock: Clock;
  exec: Exec;
  pusher: Pusher;
  fs: Fs;
  /** 真相源：L0 唯一写者的持久化面（提交回调挂这里） */
  store: Store;
  /** I-01：封闭状态集（数据，profiles 装载产物） */
  states: ReadonlySet<string>;
  /** I-01：profile 注册表静态面。票 42 裁定：onTransition 编排消费的结构子集——正典形状 =
   *  profiles ProfileRegistryEntry（组合根经 entries() 注入）；loops 禁 import profiles
   *  （eda-loops-deps），经结构类型消费注入数据；kernel validate/templates 消费已随票 42
   *  迁 profiles 静态面，kernel 构造不再收注册表。 */
  registry?: ReadonlyArray<{
    profileId: string;
    onTransition?: ReadonlyArray<{ on: string | string[]; action: string; params?: Record<string, unknown> }>;
  }>;
  /** I12：本 daemon 实例世代（缺省 0 = 未接线） */
  ownerEpoch?: number;
  /** 票 28 L3：I9 唯一权威点接线（adapter + session→transcript 解析，transport 注册面在组合根接入）。
   *  缺省 = L3 关闭（零扫描零定时器）。 */
  transcript?: {
    adapter: TranscriptAdapter;
    /** sessionId → SessionRef；未注册 session 的投递保持 accepted 待扫（level-trigger 自愈）。 */
    sessionRefOf(sessionId: string): SessionRef | undefined;
  };
  /** 票 28 L4：housekeeping 配置。缺省 = 保留期清理/dead-letter 提示（开）执行；ephemeral/快照域缺省关闭。 */
  housekeeping?: {
    /** dead-letter 每日提示开关（settings 可关，#31 B6③；缺省开）。 */
    deadLetterNotice?: boolean;
    /** ephemeral 清理域：profileIds ∩ terminalStates 命中的实体走 terminal→retired 标记与 7d 到期清理
     *  （profiles 票接线后由组合根注入；缺省无域 = 职责不激活）。 */
    ephemeral?: { profileIds: ReadonlySet<string>; terminalStates: ReadonlySet<string> };
    /** 快照触发阈值（单实体事件数；#31 性能条件 MVP 面——快照机制本体归后票，候选上报在 handle.housekeeping）。 */
    snapshotThreshold?: number;
  };
}

export interface LoopsHandle {
  /** L0 唯一写路径：变更请求入队串行消费；stopped 后抛错（重启经 stop → 重新 startLoops）。
   *  票 40：返回结算 promise（队列同步消费，await 即得该请求的 kernel 结果/错误；
   *  op 结果管道选型 = submit 返回 Promise<SubmitOutcome>，消费回调回写方案备选未采）。 */
  submit(req: MutationRequest): Promise<SubmitOutcome>;
  /** L1 回流入口：prober completion queue 消费（startLoops 构造 Prober 时 onResult 接线；
   *  fs-watch/k8s-watch 原生推送回流同路）；stopped 后迟到 completion 静默丢弃。 */
  ingestProbeResult(result: ProbeResult): void;
  /** 提交回调维护的缓存快照（L1-L4 的 level-trigger 扫描输入）。 */
  readonly cache: LoopsCache;
  /** 票 28 L4：housekeeping 最近一次扫的可观测面（snapshotNeeded = 快照触发候选——性能条件上报，
   *  快照机制本体归后票）。 */
  readonly housekeeping: {
    readonly lastSweepAt: number | null;
    readonly snapshotNeeded: readonly string[];
  };
  /** 逐请求捕获的消费错误（kernel 越界 dead-letter 抛出在此可见；队列不死，消费继续）。 */
  readonly errors: readonly unknown[];
  /** 票 27 L2 入口：SESSION_START 注册（transport 连接回调接线）——登记活跃 session（fanOut auto 编址消费面）
   *  + 对该 session 执行 drain（只投 parked，D2a）+ wake snapshot 组装一次性推送并冲刷。stopped 后抛错。 */
  sessionStart(sessionId: string, scope?: SubscriptionScope): void;
  /** 票 38 评审 M：断连注销（transport onSessionEnd 接线）——从活跃面删除，fanOut 编址不再含该
   *  session（后续事件 parked，重连 drain 照常送达）。幂等；stopped 后抛错。 */
  sessionEnd(sessionId: string): void;
  /** 停机：L0 队列关闭、提交回调脱钩、L1 调度定时器取消（幂等）。 */
  stop(): void;
  /** 票 40 评审 F1：op 直调面只余读侧（query/evidence）——变更类（subscribe/transition/register）
   *  只经 L0 submit 单一写路径，stopped 后 submit 结算拒绝，不再存在绕过队列的活变更方法。
   *  票 42：读模型实现迁 kernel/query.ts（Pick 收窄至读侧）；templates/validate 静态面迁
   *  profiles 注册表（组合根/ op-dispatch 直调 ProfileRegistry 面）。
   *  kernel 实例仍由 startLoops 私有构造（票 25 裁定不变）。 */
  readonly kernel: Pick<Kernel, "query" | "evidence">;
}

/** startLoops——loops 模块唯一入口：装配 L0（唯一写者）；L1-L4 后续票在此挂入。 */
export function startLoops(ctx: LoopsCtx): LoopsHandle {
  // 决策轨位点（R1 双轨前提）：mutation line 的持久形态 = 事件流，单写者纪律下每个已提交决策
  // 恰一事件（I1），decisionOrder 内嵌于确定性 event id 尾段 #N（deterministicEventId）——store
  // 聚合尾段 max 恢复（票 42 评审 F1：锁步分配 ≠ 位点相等，consumeIntent 可持久分叉
  // decisionOrder=7/eventSeq=9，两轨各自恢复，重放不重新编号；写入轨 eventSeq 由 Kernel 内部
  // outboxMaxEventSeq 恢复，原 loops 侧 recoverDecisionOrderTail 全表拉已下推进 store 聚合）。
  const kernel = new Kernel(ctx.store, ctx.states, ctx.store.outboxMaxDecisionOrder(), {
    ownerEpoch: ctx.ownerEpoch,
  });

  // 缓存：唯一写点 = 提交回调（store 契约：提交成功后按提交序同步触发，fake/SQLite 两实现一致）。
  // 全量重投影 = 接口忠实形态（回调只给表名，无行级增量；行级下推归 store 接口后续票）。
  // 启动种子投影（票 25 Finding 1）：startLoops 返回句柄前先从已提交状态建一次初始快照——
  // 重启后无新 entities 写时缓存不空（level-trigger 扫描不漏已有实体）；种子是读侧已提交
  // 状态的初始快照（store 读接口），运行期唯一缓存写点仍是提交回调。
  const states = new Map<string, string | null>();
  const reproject = (): void => {
    states.clear();
    for (const e of ctx.store.queryEntities({})) {
      states.set(entityRefKeyOf({ type: e.type, key: e.key }), e.state);
    }
  };
  let stopped = false;
  const offWrite = ctx.store.onWrite((tables) => {
    if (stopped) return;
    if (tables.includes("entities")) reproject();
    // 票 27：deliveries/outbox 写 = update_hook 唤醒（毫秒级主路径）——pending 行扫描开窗 / outbox 消费编址
    if (tables.includes("deliveries") || tables.includes("outbox")) deliver.onWriteScan();
  });
  reproject();

  const queue: { req: MutationRequest; settle: (o: SubmitOutcome) => void }[] = [];
  const errors: unknown[] = [];
  let draining = false;

  /** C2 onTransition.on 匹配：状态名/状态集命中 to；"from>to" 转换全等（空 from 侧 = 首转换 from=null）。 */
  const onTransitionMatches = (on: string | string[], from: string | null, to: string): boolean =>
    (Array.isArray(on) ? on : [on]).some((p) => {
      const gt = p.indexOf(">");
      if (gt === -1) return p === to;
      return (gt === 0 ? from === null : p.slice(0, gt) === from) && p.slice(gt + 1) === to;
    });

  /**
   * C2 on-transition 编排（终审裁定⑥）：transition 消费成功后查该实体 profile 的 onTransition 规则
   * （数据 = ctx.registry 注入 ProfileRegistryEntry.onTransition）→ 匹配 from/to → 经 L0 队列执行
   * subscribe/close。防递归（结构不可达）：编排只产 subscribe/cancel 请求，两者 apply 不再查 onTransition；
   * 规则链的后续转换由真实 probe 翻转沿驱动（edge-trigger 终止）。坏规则记 errors 不死队列。
   */
  const orchestrateOnTransition = (ref: EntityRef, from: string | null, to: string): void => {
    const entity = ctx.store.getEntity(ref.type, ref.key);
    if (!entity?.profileId) return;
    const entry = (ctx.registry ?? []).find((r) => r.profileId === entity.profileId);
    for (const rule of entry?.onTransition ?? []) {
      if (!onTransitionMatches(rule.on, from, to)) continue;
      if (rule.action === "close") {
        const template = (rule.params as { template?: unknown } | undefined)?.template;
        const open = ctx.store
          .querySubscriptions({ entityRefType: ref.type, entityRefKey: ref.key })
          .filter((s) => s.closedAt === undefined && (template === undefined || s.template === template));
        for (const s of open) {
          void doSubmit({ kind: "cancel", req: { subscriptionId: s.subscriptionId, reason: "cancelled", now: ctx.clock.now() } });
        }
      } else if (rule.action === "subscribe") {
        const p = (rule.params ?? {}) as Record<string, unknown>;
        if (typeof p.sessionId !== "string" || typeof p.template !== "string" || typeof p.check !== "string") {
          errors.push(new Error(`onTransition subscribe rejected: params 需 sessionId/template/check（profile ${entity.profileId}）`));
          continue;
        }
        void doSubmit({
          kind: "subscribe",
          req: {
            sessionId: p.sessionId,
            entityRef: ref,
            template: p.template,
            check: p.check,
            profileId: entity.profileId,
            now: ctx.clock.now(),
            opts: { origin: "auto" }, // 编排订阅非会话动作：auto origin（投递编址走 scope 活跃 session 面）
          },
        });
      } else {
        errors.push(new Error(`onTransition 未知 action "${rule.action}"（profile ${entity.profileId}）——规则跳过`));
      }
    }
  };

  const apply = (req: MutationRequest): unknown => {
    switch (req.kind) {
      case "transition": {
        const r = kernel.transition(req.ref, req.verdict, req.occurredAt);
        if (r) orchestrateOnTransition(req.ref, r.from, r.to);
        return r;
      }
      case "consumeIntent": {
        const o = kernel.consumeIntent(req.intent);
        if (o.kind === "appended") orchestrateOnTransition(req.intent.entityRef, o.event.from, o.event.to);
        return o;
      }
      case "publish": {
        // 票 40：publish op 消费终点（kernel.publish = #31 agent 断言路径；同态无身份变化 = null 无事件）
        const r = kernel.publish(req.ref, req.to, {
          contentIdentity: req.contentIdentity,
          payload: req.payload,
          occurredAt: req.occurredAt,
        });
        if (r) orchestrateOnTransition(req.ref, r.from, r.to);
        return r;
      }
      case "register": {
        // 票 40 评审 F1/F2：register（含 firstTransition 同事务）唯一经 L0 串行——直调面不暴露变更方法
        const r = kernel.register(req.req);
        if (r.event) orchestrateOnTransition(req.req.entityRef, r.event.from, r.event.to); // status op 首转换/状态变更同链
        return r;
      }
      case "unregister":
        // 终审裁定②：retired 标记唯一写路径（L4 ephemeral 清理消费方，7d 到期判定留在 L4）
        return kernel.unregister(req.ref);
      case "subscribe":
        return kernel.subscribe(req.req, req.deps);
      case "cancel":
        return kernel.cancel(req.req);
      case "probeVerdict":
        applyProbeVerdict(req);
        return undefined;
      case "fanOut":
        // 评审 H6 防重入/成功才消费语义随实现迁 deliver.consumeFanOut（票 43）
        return deliver.consumeFanOut(req.notificationId, kernel.fanOut.bind(kernel));
      case "sessionStart":
        deliver.applySessionStart(req.sessionId, req.scope ?? "project");
        return undefined;
      case "sessionEnd":
        // 票 38 评审 M 断连注销语义随实现迁 deliver.consumeSessionEnd（票 43）
        deliver.consumeSessionEnd(req.sessionId);
        return undefined;
      case "verify":
        // 出参 outcome 由 store 真相承载（level-trigger 下一扫自愈）；reason 面契约已由 kernel.verify 钉死
        return kernel.verify(req.notificationId, req.sessionId);
      case "drain":
        return kernel.drain({
          ...(req.sessionId !== undefined ? { sessionId: req.sessionId } : {}),
          now: ctx.clock.now(),
        });
    }
  };

  // 票 26：verdict 计数评估（domain observeVerdict）在 L0 消费时调用——计数状态是槽 runtime
  // （内存权威，重启归零重探 R1 A5：持久层不承载翻转态，重启后首个 fresh verdict 视为到达）。
  // 评审 B 组：值携带槽 generation——generation 变化（槽重建/换参）时评估状态归零，不继承旧计数。
  const thresholdStates = new Map<string, { generation: number; state: ThresholdState }>();

  const applyProbeVerdict = (req: Extract<MutationRequest, { kind: "probeVerdict" }>): void => {
    const ledger = ctx.store.getRunLedger(req.slotKey);
    if (!ledger || ledger.refcount === 0 || !ledger.entityRefType || !ledger.entityRefKey) return; // 槽已销毁/身份缺失：stale completion 丢弃
    // 评审 B4/B5：旧代 completion 拒应用——槽重建/换参后 generation 已递增，带旧代标记的回流不驱动新槽
    if (req.generation !== undefined && (ledger.generation ?? 0) !== req.generation) return;
    const ref = { type: ledger.entityRefType, key: ledger.entityRefKey };
    const slotSubs = ctx.store
      .querySubscriptions({ entityRefType: ref.type, entityRefKey: ref.key })
      .filter(
        (s: SubscriptionRow) =>
          s.closedAt === undefined && runnerSlotKey(ref, s.template ?? "") === req.slotKey,
      );
    if (slotSubs.length === 0) return; // 无活跃订阅：verdict 不再驱动
    // 阈值评估（槽级）：翻转沿才发事件（计数期内不翻转不发，#31 R2）；换代归零
    const carried = slotSubs.filter((s) => s.thresholds !== undefined);
    const cfg = restoreSlotThresholds(
      carried.map((s) => ({ createdAt: s.createdAt, thresholds: s.thresholds! })),
    );
    const generation = ledger.generation ?? 0;
    const prevThreshold = thresholdStates.get(req.slotKey);
    const baseThreshold = prevThreshold && prevThreshold.generation === generation ? prevThreshold.state : INITIAL_THRESHOLD_STATE;
    const step = observeVerdict(baseThreshold, req.verdict, cfg);
    // 镜像账本（可观测面；翻转判定以内存 ThresholdState 为准）
    const mirrorLedger = () =>
      ctx.store.putRunLedger({ ...ledger, consecutiveFails: step.state.consecutiveFails, lastVerdict: req.verdict });
    if (!step.flipped) {
      // 评审 F6：未达标翻转沿不进生命周期真值表——once/两阶段不因未达标观察提前关/换相
      thresholdStates.set(req.slotKey, { generation, state: step.state });
      mirrorLedger();
      return;
    }
    // 达标翻转沿：先转换提交，提交成功才落 settle（评审 F7——提交失败进 errors，
    // thresholdStates 保留旧值，下一个同 verdict 重评重试，不因内存先行 settled 而永丢转换）
    const result = kernel.transition(ref, req.verdict, req.occurredAt, req.evidenceRef);
    if (result) orchestrateOnTransition(ref, result.from, result.to); // C2：probe 翻转沿转换同链编排
    const actions = slotSubs.map((s) => ({
      sub: s,
      action: onVerdict({ once: s.once ?? false, twoStage: s.flip ?? false }, s.phase ?? "startup", req.verdict),
    }));
    if (actions.some((a) => a.action.action === "close")) {
      // 评审 F11/C7：关闭前物化该事件投递目标（事件→fanOut→cancel 各自事务；fanOut/cancel 幂等，
      // 崩溃重放安全）。transition null = 同态重放（崩溃重启后归零重评，事件已在 outbox）——
      // 按实体+verdict 扫尾补 eventId。评审 H7/L12：pre-cancel fanOut 同用活跃 session 投影
      // （fanOutSessions）——once 达标即推终端事件不等重连 drain；消灭内联重复投影。
      const eventId = result ? result.eventId : lastEventIdFor(ref, req.verdict);
      if (eventId) kernel.fanOut(eventId, { activeSessions: deliver.fanOutSessions() });
    }
    thresholdStates.set(req.slotKey, { generation, state: step.state });
    mirrorLedger(); // 镜像先于生命周期：cancel 的 refcount 重算会读本行并保留/清零计数
    // 订阅生命周期（I7 收窄真值表，domain onVerdict）：仅达标翻转沿消费——once 首 passed 转换后关订阅；两阶段 startup passed 切 flip
    for (const { sub, action } of actions) {
      if (action.action === "close") kernel.cancel({ subscriptionId: sub.subscriptionId, reason: action.reason, now: ctx.clock.now() });
      else if (action.action === "advance") kernel.flipSubscription(sub.subscriptionId);
    }
  };

  /** 同态重放补物化用：实体+verdict 的最后事件 id（outbox 行 notificationId = 确定性 event id）。
   *  shortcut: O(outbox) 全扫逐行点查，仅同态翻转沿触发（崩溃重启后首个 fresh verdict）——
   *  量大时归 store 接口按实体索引查（票 10「事件流直查归 store 接口后续票精化」同面）。 */
  const lastEventIdFor = (ref: EntityRef, to: string): string | undefined => {
    let found: string | undefined;
    for (const row of ctx.store.outboxBatch(Number.MAX_SAFE_INTEGER)) {
      const ev = ctx.store.tx((tx) => tx.getEvent(row.notificationId));
      if (ev && ev.entityRefType === ref.type && ev.entityRefKey === ref.key && ev.to === to) found = row.notificationId;
    }
    return found;
  };

  // L0 串行消费：队列至空；重入提交（提交回调内再 submit，C2 编排形态）由外层收尾按 FIFO 继续。
  // stopped 检查提前到每次消费前（票 25 Finding 3）：提交回调内 stop() 后剩余请求丢弃——
  // 已提交部分持久化，未消费请求由重启侧 L0 重放自愈，不产生重复 eventSeq。
  const drain = (): void => {
    if (draining) return;
    draining = true;
    try {
      while (!stopped && queue.length > 0) {
        const entry = queue.shift()!;
        try {
          entry.settle({ ok: true, value: apply(entry.req) });
        } catch (err) {
          errors.push(err); // 队列不死：坏请求不阻断后续消费（level-trigger 自愈），dead-letter 语义在 errors 可见
          entry.settle({ ok: false, error: err });
        }
      }
    } finally {
      draining = false;
    }
  };

  // --- L1 Probe（票 26）：prober completion queue 消费 + cron/interval 到点排 probe + missed tick catch_up_one ---

  /** per-slot in-flight 标记：slotKey → dispatch 时刻槽 generation（评审 B 组）。
   *  一槽至多一在飞（dispatchDue/reshedule 跳过在飞槽，排队上限 1）；完成回流时按标记判代。 */
  const inflight = new Map<string, number>();

  /** 票 47（known-unresolved #1 收口）：probe evidence 落盘铸造——D4 分工最后一公里。
   *  ref = 内容哈希（同 probe 结果重放同 ref，putEvidence upsert 不重复行）；已存在跳过
   *  写入（免 FTS 重索引 churn）。保留期归 L4 既有删除域（无事件 join 的行按 30d 桶老化）。 */
  const mintEvidence = (content: string, recordedAt: number): string => {
    const evidenceRef = `ev:${createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16)}`;
    if (!ctx.store.getEvidence(evidenceRef)) ctx.store.putEvidence({ evidenceRef, content, recordedAt });
    return evidenceRef;
  };

  const ingestProbeResult = (result: ProbeResult): void => {
    if (stopped) return; // 停机后迟到 completion 丢弃（重启侧归零重探自愈）
    const generation = inflight.get(result.slotKey);
    inflight.delete(result.slotKey);
    // 票 47 验收补注：evidence = verdict reason + checker 输出（stdout+stderr，prober 已合并掩码）——
    // 静默失败（curl -sf 401 类零输出退出）时 reason 单独可答「probe 当时看到了什么」
    const text = [result.reason, result.evidence].filter((s) => s !== "").join("\n");
    const evidenceRef = text ? mintEvidence(text, ctx.clock.now()) : undefined;
    doSubmit({ kind: "probeVerdict", slotKey: result.slotKey, verdict: result.verdict, occurredAt: new Date(ctx.clock.now()).toISOString(), generation, evidenceRef });
  };

  /** 槽的下一到点；null = 366 天内无匹配或缺 cron → MAX_SAFE_INTEGER 封口（永不触发，不回退为“立即可探”死循环）。 */
  const nextFireOf = (spec: ProbeSpecRow, fromMs: number): number =>
    spec.schedule.type === "interval"
      ? fromMs + (spec.schedule.intervalMs ?? 60_000)
      : spec.schedule.cron
        ? (cronNextMs(spec.schedule.cron, fromMs) ?? Number.MAX_SAFE_INTEGER)
        : Number.MAX_SAFE_INTEGER;

  const prober = new Prober({ exec: ctx.exec, clock: ctx.clock, onResult: ingestProbeResult });

  /** 到点排 probe：refcount 0 槽不调度；非 poll 源不调度（fs-watch/k8s-watch 原生推送回流，watch 执行归 prober watch 票）；
   *  在飞槽不重排（评审 B5/D12：排队上限 1，慢 checker 快间隔不堆 job）。 */
  const dispatchDue = (now: number): void => {
    for (const row of ctx.store.listRunLedger()) {
      if (row.refcount === 0) continue;
      const spec = ctx.store.getProbeSpec(row.slotKey);
      if (!spec || spec.source !== "poll") continue;
      try {
        if (inflight.has(row.slotKey)) continue;
        if (row.nextDueAt !== undefined && row.nextDueAt > now) continue;
        const nextDue = nextFireOf(spec, now);
        // 标记先置后探（评审 D12）：同步完成的 probe（exec 同步抛错回流）在 probe 返回前已清标记，
        // 若探后置位则残留脏标记 → 槽被永久跳过（L1 死槽）
        inflight.set(row.slotKey, row.generation ?? 0);
        prober.probe({ slotKey: row.slotKey, check: spec.check, source: spec.source });
        // 重读后写（评审 E14）：同步完成的 probe 在 probe 内已回流应用（mirrorLedger 可能已写
        // lastVerdict/consecutiveFails）——用捕获的 row 直接覆盖会把它冲掉
        const current = ctx.store.getRunLedger(row.slotKey);
        if (current) ctx.store.putRunLedger({ ...current, nextDueAt: nextDue });
      } catch (err) {
        inflight.delete(row.slotKey); // probe 同步抛错未完成回流：清标记，槽不被卡死
        errors.push(err); // 评审 D11：坏槽（如非法 cron spec）记 error 跳过，不拖垮其余槽 dispatch、不 abort 启动
      }
    }
  };

  let scheduleTimer: { cancel(): void } | null = null;

  /** 重排主定时器：最早 nextDueAt（nextDueAt 缺省 = 新建槽首探立即可发）；无活跃 poll 槽则无定时器。 */
  const reschedule = (): void => {
    if (stopped) return;
    scheduleTimer?.cancel();
    scheduleTimer = null;
    const now = ctx.clock.now();
    let earliest: number | null = null;
    for (const row of ctx.store.listRunLedger()) {
      if (row.refcount === 0) continue;
      const spec = ctx.store.getProbeSpec(row.slotKey);
      if (!spec || spec.source !== "poll") continue;
      if (inflight.has(row.slotKey)) continue; // 在飞槽的重排由完成回流接管（doSubmit→reschedule）
      const due = row.nextDueAt ?? now;
      if (earliest === null || due < earliest) earliest = due;
    }
    if (earliest === null || earliest >= Number.MAX_SAFE_INTEGER) return; // 永不触发哨兵不占定时器（评审 D10）；超长到点由 SystemClock 2^31 钳制 + 到点重排轮询兜底
    scheduleTimer = ctx.clock.setTimeout(tick, Math.max(0, earliest - now));
  };

  const tick = (): void => {
    if (stopped) return;
    dispatchDue(ctx.clock.now());
    reschedule();
  };

  const doSubmit = (req: MutationRequest): Promise<SubmitOutcome> => {
    if (stopped) throw new Error("loops stopped: L0 queue closed");
    let settle!: (o: SubmitOutcome) => void;
    const settled = new Promise<SubmitOutcome>((res) => (settle = res));
    queue.push({ req, settle });
    drain();
    reschedule(); // subscribe/cancel 改变槽面（新建槽首探、销毁槽撤定时器）——level-trigger 重排
    return settled;
  };

  // --- L2 Deliver（票 27→43）：段体迁 loops/deliver.ts；submit/drain/errors 注入，五 seam + L0 消费钩拼装 ---
  const deliver = createDeliver(ctx, { submit: doSubmit, drain: kernel.drain.bind(kernel), errors });
  // 评审 D13：重启即重探（R1 A5 归零重探）——持久 nextDueAt 是停机前调度遗留，重启一律清零
  // （清零后走新建槽同路径首探）；refcount 0 槽不重探，非 poll 源不归调度管。
  for (const row of ctx.store.listRunLedger()) {
    if (row.refcount === 0 || row.nextDueAt === undefined) continue;
    const spec = ctx.store.getProbeSpec(row.slotKey);
    if (!spec || spec.source !== "poll") continue;
    ctx.store.putRunLedger({ ...row, nextDueAt: undefined });
  }

  // missed tick catch_up_one：停机跨过的 cron/interval 到点补触发一次且仅一次（#31 正典：补触发，
  // 非投递 redrive）——N 个 missed tick（nextDueAt 已成过去）合并为本次一次探针，nextDueAt 直接
  // 跳到下一未来到点不逐点补；新建槽（nextDueAt 缺省）同路径获得首探（归零重探同精神）。
  // 评审 E14：启动 dispatch 在 doSubmit 定义之后——启动即同步完成的 probe（exec 同步抛错）经
  // ingestProbeResult→doSubmit，先于定义则 TDZ ReferenceError 被 prober.deliver 吞掉、completion 静默丢失。
  dispatchDue(ctx.clock.now());
  reschedule();

  // --- L3 Verify（票 28）：accepted 投递的 I9 点查收口（两段式 ack 段二）---
  // 周期扫（1s，对齐 L2 兼底扫节奏；level-trigger：丢唤醒/迟到由下一扫自愈）。C1 降级（票 21 对接）：
  // 降级期不点查不收口——推送即 accepted 权威基面；恢复后下一扫正常收口。
  const L3_SCAN_INTERVAL_MS = 1_000;
  const transcript = ctx.transcript;
  let scanTimer: { cancel(): void } | null = null;
  let scanning = false;
  const verifyScan = (): void => {
    if (!transcript || stopped || scanning) return;
    if (transcript.adapter.isDegraded()) return;
    const accepted = ctx.store.acceptedDeliveries({});
    if (accepted.length === 0) return;
    scanning = true;
    void (async () => {
      try {
        for (const row of accepted) {
          if (stopped) return;
          const sessionRef = transcript.sessionRefOf(row.sessionId);
          if (!sessionRef) continue; // 未注册 session：保持 accepted 待扫
          const result = await transcript.adapter.verify(sessionRef, row.notificationId);
          if (transcript.adapter.isDegraded()) break; // await 期间降级（ocr M）：复查门——余行零点查零收口，留待恢复后重扫
          // I9 判定（domain transcriptVerifies 同语义：notificationId 落盘即投递）——
          // 非 unknown 且非 not-found = 命中条目（passed/failed/waiting 皆已落盘）→ 经 L0 队列收口
          if (result.verdict !== "unknown" && result.reason !== "not-found") {
            doSubmit({ kind: "verify", notificationId: row.notificationId, sessionId: row.sessionId });
          }
        }
      } catch (err) {
        errors.push(err); // 扫描不死：下一 tick level-trigger 重扫
      } finally {
        scanning = false;
      }
    })();
  };
  let scannedOnce = false;
  const scheduleVerifyScan = (): void => {
    if (!transcript || stopped) return;
    scanTimer = ctx.clock.setTimeout(
      () => {
        scannedOnce = true;
        scanTimer = null;
        try {
          verifyScan();
        } catch (err) {
          errors.push(err); // 同步异常不逃逸（store 读面等）：扫描不死语义
        } finally {
          scheduleVerifyScan(); // 重排在 finally（ocr M）：同步异常不再永久停摆 L3
        }
      },
      scannedOnce ? L3_SCAN_INTERVAL_MS : 0, // 启动首扫不等首周期
    );
  };
  scheduleVerifyScan();

  // --- L4 Housekeeping（票 28）：保留期清理 / ephemeral retired 清理 / dead-letter 每日提示 /
  // ttl 关订阅 / run_ledger 对账 / 快照触发。启动惰性首扫（#31 L154）+ 1h 周期；簿记/审计直写
  // store（#31 L82：ephemeral 清理是簿记非事件，不经 kernel；缓存一致性由提交回调保全），
  // 例外 = ttl 关订阅 + retired 标记（终审裁定②：写路径归 kernel.unregister，经 L0 队列 submit）。
  const HOUSEKEEPING_INTERVAL_MS = 3_600_000;
  const DAY_MS = 86_400_000;
  const hk = ctx.housekeeping;
  const housekeepingView = { lastSweepAt: null as number | null, snapshotNeeded: [] as string[] };
  let sweepTimer: { cancel(): void } | null = null;
  let lastNoticeDay: number | null = null;
  let sweptOnce = false;
  const sweep = (): void => {
    if (stopped) return;
    const now = ctx.clock.now();
    // ① evidence 保留期清理（判定归 domain 纯函数）：7d 桶下界取回，30d 长桶在谓词内收口。
    //    verdict join：evidenceRef → 事件终态（outbox 行与事件 1:1 全扫；shortcut: O(outbox)，量大时归 store 接口按 evidenceRef 索引查）。
    const verdictByRef = new Map<string, string>();
    const latestEventMsByEntity = hk?.ephemeral ? new Map<string, number>() : null;
    const snapshotThreshold = hk?.snapshotThreshold;
    const eventCountByEntity = snapshotThreshold !== undefined ? new Map<string, number>() : null;
    for (const row of ctx.store.outboxBatch(Number.MAX_SAFE_INTEGER)) {
      const ev = ctx.store.tx((tx) => tx.getEvent(row.notificationId));
      if (!ev) continue;
      // 共享 ref 连坐守门（ocr H）：桶判定取最严格——任一非 passed 引用即 30d，后枚举的 passed
      // 不得把 failed/waiting 在案的 ref 降级成 7d 桶误删
      if (ev.evidenceRef) {
        const prev = verdictByRef.get(ev.evidenceRef);
        if (prev === undefined || prev === "passed") verdictByRef.set(ev.evidenceRef, ev.to);
      }
      const entityKey = `${ev.entityRefType}/${ev.entityRefKey}`;
      if (latestEventMsByEntity) {
        const t = Date.parse(ev.occurredAt);
        if (Number.isFinite(t) && t > (latestEventMsByEntity.get(entityKey) ?? -Infinity)) latestEventMsByEntity.set(entityKey, t);
      }
      if (eventCountByEntity) eventCountByEntity.set(entityKey, (eventCountByEntity.get(entityKey) ?? 0) + 1);
    }
    const stale = ctx.store.evidenceOlderThan(now - EVIDENCE_RETENTION.passedMs);
    const due = stale.filter((r) => evidenceRetentionExpired(r.recordedAt, verdictByRef.get(r.evidenceRef) ?? "", now));
    if (due.length > 0) ctx.store.deleteEvidence(due.map((r) => r.evidenceRef));
    // ② ephemeral terminal → retired 标记 + retired 7d 到期清理（标记与清理同扫：daemon 停机一周后
    //    首扫一次完成）。到期锚 = 终态转换事件 occurredAt（标记时刻可能滞后，锚取终态到达时刻）；
    //    无事件锚（注册即终态）不清理——到期时刻不可知，保守保留（profiles 票接线后由注册元数据承载）。
    const eph = hk?.ephemeral;
    if (eph) {
      for (const e of ctx.store.queryEntities({})) {
        if (!e.profileId || !eph.profileIds.has(e.profileId)) continue;
        if (e.state === null || !eph.terminalStates.has(e.state)) continue;
        if (!e.retired) void doSubmit({ kind: "unregister", ref: { type: e.type, key: e.key } }); // 终审裁定②：写路径归 kernel（L0 队列，timer 上下文同步消费）
        const anchor = latestEventMsByEntity?.get(`${e.type}/${e.key}`);
        if (anchor !== undefined && retiredCleanupDue(anchor, now)) {
          ctx.store.deleteEventsBefore(e.type, e.key, now); // 派生投递残留（events/outbox 永久，见 store 契约注）
          ctx.store.deleteEntity(e.type, e.key);
        }
      }
    }
    // ③ dead-letter 每日提示（#31 B6③）：非空 → 活跃 session 提示一次/日（day-key 门控；settings 可关）。
    //    单连接推送（SocketPusher = 活跃 session 面）；逐 session 编址归 transport 票接线。
    const dead = ctx.store.deadLetters({});
    if (dead.length > 0 && (hk?.deadLetterNotice ?? true)) {
      const day = Math.floor(now / DAY_MS);
      if (lastNoticeDay !== day) {
        // 门在送达后置位（ocr M；票 38 评审：送达数 > 0 才算送达）：断连失败不抑制当天余时重试
        void ctx.pusher.push(JSON.stringify({ kind: "dead-letter-notice", count: dead.length })).then(
          (delivered: number) => {
            if (delivered > 0) lastNoticeDay = day;
          },
          (err: unknown) => errors.push(err),
        );
      }
    }
    // ④ ttl 到期关订阅（#57 ttl 触发）：判定归 domain ttlExpired（严格过期，与 evidence/retired 边界同法）；
    //    关闭经 L0 队列（kernel 变更唯一写路径）复用 cancel 幂等（重扫安全）；先于对账——关后槽
    //    refcount 由 kernel 归算，对账只补残余漂移。
    for (const s of ctx.store.querySubscriptions({})) {
      if (s.closedAt !== undefined || s.ttlMs === undefined) continue;
      if (!ttlExpired({ createdAt: s.createdAt, ttlMs: s.ttlMs }, now)) continue;
      doSubmit({ kind: "cancel", req: { subscriptionId: s.subscriptionId, reason: "ttl", now } });
    }
    // ⑤ run_ledger 对账（A2：槽账本是 runtime 簿记非真相源，订阅表是真相）：逐活跃订阅聚槽计数，
    //    账本行 refcount 与真相不符即纠正；归零走槽销毁语义（计数/镜像态清零，行保留惰性终结，
    //    与 kernel.refreshSlotRefCount 归零同形）。惰性 0 行不复活、缺行不重建——重建需
    //    checker/schedule（subscribe 路径职责），L4 不发明。
    const openCountBySlot = new Map<string, number>();
    for (const s of ctx.store.querySubscriptions({})) {
      if (s.closedAt !== undefined) continue;
      const k = runnerSlotKey({ type: s.entityRefType, key: s.entityRefKey }, s.template ?? "");
      openCountBySlot.set(k, (openCountBySlot.get(k) ?? 0) + 1);
    }
    for (const row of ctx.store.listRunLedger()) {
      if (row.refcount <= 0) continue; // 已归零惰性行不复活（B4 陈旧实体停探是正常态）
      const expected = openCountBySlot.get(row.slotKey) ?? 0;
      if (expected === row.refcount) continue;
      ctx.store.putRunLedger(
        expected === 0
          ? { ...row, refcount: 0, consecutiveFails: 0, lastVerdict: undefined, nextDueAt: undefined }
          : { ...row, refcount: expected },
      );
    }
    // ⑥ 快照触发候选（#31 性能条件 MVP 面：单实体事件数阈值；快照机制本体归后票，候选上报
    //    handle.housekeeping）：计数来自 ① 的 outbox 扫描面；候选 = 存活实体且事件数严格超阈值。
    if (eventCountByEntity && snapshotThreshold !== undefined) {
      const alive = new Set(ctx.store.queryEntities({}).map((e) => `${e.type}/${e.key}`));
      housekeepingView.snapshotNeeded = [...eventCountByEntity]
        .filter(([k, n]) => n > snapshotThreshold && alive.has(k))
        .map(([k]) => k);
    } else {
      housekeepingView.snapshotNeeded = [];
    }
    housekeepingView.lastSweepAt = now;
  };
  const scheduleSweep = (): void => {
    if (stopped) return;
    sweepTimer = ctx.clock.setTimeout(
      () => {
        sweptOnce = true;
        sweepTimer = null;
        try {
          sweep();
        } catch (err) {
          errors.push(err); // sweep 单步失败不死循环（level-trigger 下一周期重试）
        }
        scheduleSweep();
      },
      sweptOnce ? HOUSEKEEPING_INTERVAL_MS : 0, // 启动惰性清理（#31 L154）
    );
  };
  scheduleSweep();

  return {
    submit: doSubmit,
    ingestProbeResult,
    sessionStart: deliver.sessionStart,
    sessionEnd: deliver.sessionEnd,
    cache: { states },
    housekeeping: housekeepingView,
    errors,
    // 票 40 评审 F1：运行期真收窄（非仅类型 Pick）——变更类方法不再可从 handle 直调；
    // 票 42：读模型面收窄至 query/evidence（templates/validate 静态面迁 profiles，组合根直调）。
    // 内部消费用闭包内 kernel 变量不受影响
    kernel: {
      query: kernel.query.bind(kernel),
      evidence: kernel.evidence.bind(kernel),
    },
    stop(): void {
      stopped = true;
      // 票 40：未消费请求结算为 stopped 错误（提交方 await 不悬挂；stop 后无重放窗口）
      for (const e of queue.splice(0)) e.settle({ ok: false, error: new Error("loops stopped: L0 queue closed") });
      scheduleTimer?.cancel();
      scheduleTimer = null;
      deliver.stopDeliver(); // 票 43：L2 runtime 清理随迁（兜底定时器 + 批定时器/活跃面/单飞守卫）
      scanTimer?.cancel(); // 票 28 L3 扫描定时器（未接线时为 null）
      scanTimer = null;
      sweepTimer?.cancel(); // 票 28 L4 housekeeping 定时器
      sweepTimer = null;
      offWrite(); // 幂等取消订阅（票 25 Finding 2）：重复启停不累积监听器、旧闭包可回收
    },
  };
}
