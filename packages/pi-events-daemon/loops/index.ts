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
import {
  INITIAL_THRESHOLD_STATE,
  cronNextMs,
  deterministicEventId,
  epochAccepts,
  observeVerdict,
  onVerdict,
  repushDecision,
  restoreSlotThresholds,
  runnerSlotKey,
  type ThresholdState,
} from "../domain/intent.ts";
import { transitionDelivery, type SubscriptionScope } from "../domain/delivery.ts";

// cronNextMs 归 domain（单一解析：kernel subscribe 校验 + loops 调度共用）；此处保持既有导出位兼容
export { cronNextMs } from "../domain/intent.ts";
import {
  Kernel,
  type CancelRequest,
  type ProfileRegistryEntry,
  type SubscribeDeps,
  type SubscribeRequest,
} from "../kernel/index.ts";
import { Prober, type ProbeResult } from "../prober/index.ts";
import type { Clock, Exec, Fs, Pusher } from "../fx/index.ts";
import type { DeliveryRowData, ProbeSpecRow, Store, SubscriptionRow } from "../store/index.ts";

/** L0 变更请求——kernel 变更方法（票 10 消费终点 transition/consumeIntent + 票 24/26 subscribe/cancel）的队列载体；
 *  probeVerdict 是 L1 回流（prober completion queue）进 L0 的串行链入口（D4：L1 消费回流，L0 唯一写者）；
 *  fanOut/sessionStart 是票 27 L2 入口（outbox 消费编址、SESSION_START 注册，kernel 方法仍只在 L0 消费内调）。 */
export type MutationRequest =
  | { kind: "transition"; ref: EntityRef; verdict: Verdict; occurredAt: string }
  | { kind: "consumeIntent"; intent: TransitionIntent }
  | { kind: "subscribe"; req: SubscribeRequest; deps?: SubscribeDeps }
  | { kind: "cancel"; req: CancelRequest }
  | { kind: "probeVerdict"; slotKey: string; verdict: Verdict; occurredAt: string;
      /** 评审 B 组：dispatch 时刻的槽 generation——旧代 completion 拒应用；缺省（watch 回流等无 dispatch 来源）不判代。 */
      generation?: number }
  | { kind: "fanOut"; notificationId: string }
  | { kind: "sessionStart"; sessionId: string; scope?: SubscriptionScope };


/** 提交回调维护的状态缓存（只读视图；运行期唯一写点在 store.onWrite 回调内，启动时另有种子投影 = 已提交状态初始快照，票 25 验收面）。 */
export interface LoopsCache {
  /** refKey（entityRefKeyOf）→ 已提交状态；逐提交与 store 实体表同步。 */
  readonly states: ReadonlyMap<string, string | null>;
}

/** startLoops 注入面（票 25：fx 四端口 + Store；states/registry/ownerEpoch 是 kernel 构造数据）。 */
export interface LoopsCtx {
  clock: Clock;
  exec: Exec;
  pusher: Pusher;
  fs: Fs;
  /** 真相源：L0 唯一写者的持久化面（提交回调挂这里） */
  store: Store;
  /** I-01：封闭状态集（数据，profiles 装载产物） */
  states: ReadonlySet<string>;
  /** I-01：profile 注册表静态面（kernel validate/templates 消费） */
  registry?: ReadonlyArray<ProfileRegistryEntry>;
  /** I12：本 daemon 实例世代（缺省 0 = 未接线） */
  ownerEpoch?: number;
}

export interface LoopsHandle {
  /** L0 唯一写路径：变更请求入队串行消费；stopped 后抛错（重启经 stop → 重新 startLoops）。 */
  submit(req: MutationRequest): void;
  /** L1 回流入口：prober completion queue 消费（startLoops 构造 Prober 时 onResult 接线；
   *  fs-watch/k8s-watch 原生推送回流同路）；stopped 后迟到 completion 静默丢弃。 */
  ingestProbeResult(result: ProbeResult): void;
  /** 提交回调维护的缓存快照（L1-L4 的 level-trigger 扫描输入）。 */
  readonly cache: LoopsCache;
  /** 逐请求捕获的消费错误（kernel 越界 dead-letter 抛出在此可见；队列不死，消费继续）。 */
  readonly errors: readonly unknown[];
  /** 票 27 L2 入口：SESSION_START 注册（transport 连接回调接线）——登记活跃 session（fanOut auto 编址消费面）
   *  + 对该 session 执行 drain（只投 parked，D2a）+ wake snapshot 组装一次性推送并冲刷。stopped 后抛错。 */
  sessionStart(sessionId: string, scope?: SubscriptionScope): void;
  /** 停机：L0 队列关闭、提交回调脱钩、L1 调度定时器取消（幂等）。 */
  stop(): void;
}

/**
 * 决策轨恢复（R1 双轨前提，loops 侧落地）：mutation line 的持久形态 = 事件流——单写者纪律下
 * 每个已提交决策恰一事件（I1：transition+事件+outbox 行同事务原子），decisionOrder 内嵌于
 * 确定性 event id 尾段 `#N`（deterministicEventId）。outbox 行与 transition 1:1（与 kernel
 * recoverEventSeq 同源同法，事件流直查归 store 接口后续票精化），max = mutation line 位点，重放不重新编号。
 */
function recoverDecisionOrderTail(store: Store): number {
  let tail = 0;
  for (const row of store.outboxBatch(Number.MAX_SAFE_INTEGER)) {
    const order = Number(row.notificationId.slice(row.notificationId.lastIndexOf("#") + 1));
    if (Number.isInteger(order) && order > tail) tail = order;
  }
  return tail;
}

/** startLoops——loops 模块唯一入口：装配 L0（唯一写者）；L1-L4 后续票在此挂入。 */
export function startLoops(ctx: LoopsCtx): LoopsHandle {
  const kernel = new Kernel(ctx.store, ctx.states, recoverDecisionOrderTail(ctx.store), {
    ownerEpoch: ctx.ownerEpoch,
    registry: ctx.registry,
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
    if (tables.includes("deliveries") || tables.includes("outbox")) deliverScan();
  });
  reproject();

  const queue: MutationRequest[] = [];
  const errors: unknown[] = [];
  let draining = false;

  const apply = (req: MutationRequest): void => {
    switch (req.kind) {
      case "transition":
        kernel.transition(req.ref, req.verdict, req.occurredAt);
        return;
      case "consumeIntent":
        kernel.consumeIntent(req.intent);
        return;
      case "subscribe":
        kernel.subscribe(req.req, req.deps);
        return;
      case "cancel":
        kernel.cancel(req.req);
        return;
      case "probeVerdict":
        applyProbeVerdict(req);
        return;
      case "fanOut":
        kernel.fanOut(req.notificationId, {
          activeSessions: [...activeSessions].map(([sessionId, scope]) => ({ sessionId, scope })),
        });
        return;
      case "sessionStart":
        applySessionStart(req.sessionId, req.scope ?? "project");
        return;
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
    const result = kernel.transition(ref, req.verdict, req.occurredAt);
    const actions = slotSubs.map((s) => ({
      sub: s,
      action: onVerdict({ once: s.once ?? false, twoStage: s.flip ?? false }, s.phase ?? "startup", req.verdict),
    }));
    if (actions.some((a) => a.action.action === "close")) {
      // 评审 F11/C7：关闭前物化该事件投递目标（事件→fanOut→cancel 各自事务；fanOut/cancel 幂等，
      // 崩溃重放安全）。transition null = 同态重放（崩溃重启后归零重评，事件已在 outbox）——
      // 按实体+verdict 扫尾补 eventId。loops 无 session runtime：activeSessions 空 → 全部 parked
      // 走 drain 重投（I12 epoch fence 过滤；transport 票接线后改直投）。
      const eventId = result ? result.eventId : lastEventIdFor(ref, req.verdict);
      if (eventId) kernel.fanOut(eventId, { activeSessions: [] });
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
        const req = queue.shift()!;
        try {
          apply(req);
        } catch (err) {
          errors.push(err); // 队列不死：坏请求不阻断后续消费（level-trigger 自愈），dead-letter 语义在 errors 可见
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

  const ingestProbeResult = (result: ProbeResult): void => {
    if (stopped) return; // 停机后迟到 completion 丢弃（重启侧归零重探自愈）
    const generation = inflight.get(result.slotKey);
    inflight.delete(result.slotKey);
    doSubmit({ kind: "probeVerdict", slotKey: result.slotKey, verdict: result.verdict, occurredAt: new Date(ctx.clock.now()).toISOString(), generation });
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

  const doSubmit = (req: MutationRequest): void => {
    if (stopped) throw new Error("loops stopped: L0 queue closed");
    queue.push(req);
    drain();
    reschedule(); // subscribe/cancel 改变槽面（新建槽首探、销毁槽撤定时器）——level-trigger 重排
  };

  // --- L2 Deliver（票 27）：唤醒双通道 + 投递铁律 + batch 合流 + 退避重试 + drain/snapshot + 24h re-push ---

  /** batch 合流窗口（#31：batchMs daemon 全局默认 2000ms，per-session）。 */
  const DELIVER_BATCH_MS = 2000;
  /** 兜底扫周期（丢唤醒自愈）。 */
  const DELIVER_FALLBACK_MS = 1000;
  /** E2 重试退避：2s 起指数倍增，5min 封顶。 */
  const DELIVER_BACKOFF_BASE_MS = 2000;
  const DELIVER_BACKOFF_MAX_MS = 300_000;
  /** 退避耗尽 = 封顶前尝试（首投 + 8 次指数等待 2s…256s，均 <5min）+ 封顶值上 5 次（票 27 断言 2s→…→5min×5）→ dead-letter。 */
  const DELIVER_BACKOFF_PRE_CAP_ATTEMPTS = 9;
  const DELIVER_BACKOFF_CAP_ATTEMPTS = 5;

  /** per-session 投递批：窗口/重试/在飞三态单飞（一 session 至多一未结算 push，新行随批携带）。 */
  interface DeliverBatch {
    rows: Map<string, DeliveryRowData>;
    fails: number;
    mode: "window" | "retry" | "inflight";
    timer: { cancel(): void } | null;
  }
  const batches = new Map<string, DeliverBatch>();
  /** I9 在等 verified 的已推行簿记（24h repush 扫描输入）：sessionId → notificationId → {pushedAt, repushed}。
   *  shortcut: 推送簿记是 L2 runtime（store 行 4 字段冻结，票 09 裁定）；repushed/pushedAt 持久载体归 store 行形状扩展票。
   *  重启清零 = 24h 窗口重新计时（R1 A5 归零重探同精神）；窗口内恰一次由 repushed 置位保证。 */
  const pushBook = new Map<string, Map<string, { pushedAt: number; repushed: boolean }>>();
  /** 活跃 session 运行时（sessionStart 登记；断连注销归 transport 票 29 接线）——fanOut auto 编址消费面。 */
  const activeSessions = new Map<string, SubscriptionScope>();
  /** 已消费 outbox 行（fire-once；fanOut 幂等 I10 兑底重启重放）。shortcut: 全量扫 O(outbox)，事件量级下可接受，量大归 store 接口位点精化。 */
  const consumedOutbox = new Set<string>();
  const ownerEpoch = ctx.ownerEpoch ?? 0;

  /** 票 27 L2 入口（transport 连接回调接线）：SESSION_START 进 L0 队列——drain 是 kernel 方法，唯一写者路径。 */
  const sessionStart = (sessionId: string, scope?: SubscriptionScope): void =>
    doSubmit({ kind: "sessionStart", sessionId, scope });

  /** 活跃 session 消费面（fanOut deps 形状）。 */
  const fanOutSessions = (): { sessionId: string; scope: SubscriptionScope }[] =>
    [...activeSessions].map(([sessionId, scope]) => ({ sessionId, scope }));

  /** 事件 verdict（billboard 条目的 verdict 源；failed 绕行判定）。 */
  const eventVerdictOf = (notificationId: string): Verdict | undefined => {
    const ev = ctx.store.tx((tx) => tx.getEvent(notificationId));
    return ev ? (ev.to as Verdict) : undefined;
  };

  /** 投递铁律第一环的观测不变量：只推「已持久化且在线」的行（pending/accepted；parked 等 SESSION_START drain，终态不推）。 */
  const liveOf = (rows: Iterable<DeliveryRowData>): DeliveryRowData[] =>
    [...rows]
      .map((r) => ctx.store.getDelivery(r.notificationId, r.sessionId))
      .filter((r): r is DeliveryRowData => !!r && (r.state === "pending" || r.state === "accepted") && epochAccepts(r.recordEpoch, ownerEpoch));

  /** 合流行（billboard 条目形态 #31：count + 实体 + verdict；notificationId 随行 = I9 transcript 点查匹配键；eventSeq 序确定性）。 */
  const assembleLine = (rows: readonly DeliveryRowData[]): string => {
    const entries = rows
      .map((r) => ({ row: r, ev: ctx.store.tx((tx) => tx.getEvent(r.notificationId)) }))
      .sort((a, b) => (a.ev?.eventSeq ?? 0) - (b.ev?.eventSeq ?? 0))
      .map(({ row, ev }) => ({
        notificationId: row.notificationId,
        entityRef: ev ? entityRefKeyOf({ type: ev.entityRefType, key: ev.entityRefKey }) : "",
        verdict: (ev?.to ?? "") as Verdict,
      }));
    return JSON.stringify({ count: entries.length, entries });
  };

  /** 推送成功簿记（两段式 ack 段一：pending→accepted 正典边；verified 归 I9/L3，L2 永不写 verified）。 */
  const markPushed = (rows: readonly DeliveryRowData[]): void => {
    const now = ctx.clock.now();
    for (const r of rows) {
      let book = pushBook.get(r.sessionId);
      if (!book) {
        book = new Map();
        pushBook.set(r.sessionId, book);
      }
      const prev = book.get(r.notificationId);
      book.set(r.notificationId, { pushedAt: now, repushed: prev?.repushed ?? false });
      const cur = ctx.store.getDelivery(r.notificationId, r.sessionId);
      if (cur?.state !== "pending") continue;
      const edge = transitionDelivery("pending", "wake-accepted");
      if (!edge.ok) {
        errors.push(new Error(`L2: canonical edge pending+wake-accepted rejected: ${edge.reason}`));
        continue;
      }
      ctx.store.putDelivery({ ...cur, state: edge.to });
    }
  };

  /** E2 退避重试/耗尽：指数 2s→5min，封顶值上 5 次后 pending/accepted → dead-letter（正典边 retry-exhausted）。 */
  const failBatch = (batch: DeliverBatch, sessionId: string): void => {
    batch.fails += 1;
    if (batch.fails >= DELIVER_BACKOFF_PRE_CAP_ATTEMPTS + DELIVER_BACKOFF_CAP_ATTEMPTS) {
      for (const r of liveOf(batch.rows.values())) {
        const cur = ctx.store.getDelivery(r.notificationId, r.sessionId)!;
        const edge = transitionDelivery(cur.state, "retry-exhausted");
        if (edge.ok) ctx.store.putDelivery({ ...cur, state: edge.to });
        else errors.push(new Error(`L2: canonical edge ${cur.state}+retry-exhausted rejected: ${edge.reason}`));
      }
      batches.delete(sessionId);
      return;
    }
    batch.mode = "retry";
    const wait = Math.min(DELIVER_BACKOFF_BASE_MS * 2 ** (batch.fails - 1), DELIVER_BACKOFF_MAX_MS);
    batch.timer = ctx.clock.setTimeout(() => flushBatch(sessionId), wait);
  };

  /** 冲刷一批（窗口到期 / 重试到点 / failed 绕行 / snapshot 直推共用）：成功→ack+余量重开窗；失败→退避重排。 */
  const flushBatch = (sessionId: string): void => {
    if (stopped) return;
    const batch = batches.get(sessionId);
    if (!batch || batch.mode === "inflight" || batch.rows.size === 0) return;
    batch.timer?.cancel();
    batch.timer = null;
    const live = liveOf(batch.rows.values());
    if (live.length === 0) {
      batches.delete(sessionId);
      return;
    }
    batch.mode = "inflight";
    void ctx.pusher.push(assembleLine(live)).then(
      () => {
        if (stopped) return;
        markPushed(live);
        for (const r of live) batch.rows.delete(r.notificationId);
        batch.fails = 0; // 传输恢复：余量行不从旧失败继承退避
        const remaining = liveOf(batch.rows.values()); // 在飞期间新入批的行（wake pending / sessionStart snapshot）结算后冲刷，不丢弃
        if (remaining.length === 0) {
          batches.delete(sessionId);
          return;
        }
        batch.mode = "window";
        batch.timer = ctx.clock.setTimeout(() => flushBatch(sessionId), DELIVER_BATCH_MS);
      },
      () => {
        if (stopped) return;
        failBatch(batch, sessionId);
      },
    );
  };

  /** SESSION_START 消费（L0 内）：登记活跃 + drain（只投 parked，D2a）+ wake snapshot 组装（drained 重投行 ∪ pending）立即冲刷。 */
  const applySessionStart = (sessionId: string, scope: SubscriptionScope): void => {
    activeSessions.set(sessionId, scope);
    const drained = kernel.drain({ sessionId }); // epoch fence 在 kernel 侧（异世代 parked 行不动）
    const snap = new Map<string, DeliveryRowData>();
    for (const d of drained.drained) {
      const row = ctx.store.getDelivery(d.notificationId, d.sessionId);
      if (row && epochAccepts(row.recordEpoch, ownerEpoch)) snap.set(row.notificationId, row);
    }
    for (const row of ctx.store.pendingDeliveries({ sessionId })) {
      if (epochAccepts(row.recordEpoch, ownerEpoch)) snap.set(row.notificationId, row);
    }
    let batch = batches.get(sessionId);
    if (!batch) {
      batch = { rows: new Map(), fails: 0, mode: "window", timer: null };
      batches.set(sessionId, batch);
    }
    batch.timer?.cancel(); // snapshot 一次性推送并冲刷：吞并开窗中同 session 行（避免双线）
    batch.timer = null;
    for (const row of snap.values()) batch.rows.set(row.notificationId, row);
    flushBatch(sessionId);
  };

  /** 唤醒扫描（update_hook 毫秒级主路径 + 1s 兑底扫共用）：outbox 消费编址 + pending 行入批开窗。 */
  const deliverScan = (): void => {
    if (stopped) return;
    // outbox 消费（票 11 落点：投递循环消费 outbox → L0 队列内 fanOut 编址；fire-once，fanOut 幂等兑底重启重放）
    for (const row of ctx.store.outboxBatch(Number.MAX_SAFE_INTEGER)) {
      if (consumedOutbox.has(row.notificationId)) continue;
      consumedOutbox.add(row.notificationId);
      doSubmit({ kind: "fanOut", notificationId: row.notificationId });
    }
    for (const row of ctx.store.pendingDeliveries({})) {
      if (!epochAccepts(row.recordEpoch, ownerEpoch)) continue; // I12：僵尸世代行不投（留给正确 epoch 的 daemon）
      let batch = batches.get(row.sessionId);
      if (!batch) {
        batch = { rows: new Map(), fails: 0, mode: "window", timer: null };
        batches.set(row.sessionId, batch);
      }
      if (batch.rows.has(row.notificationId)) continue;
      batch.rows.set(row.notificationId, row);
      if (batch.mode !== "window") continue; // retry：随下次重试冲刷；inflight：随结算后余量重排
      if (eventVerdictOf(row.notificationId) === "failed") {
        flushBatch(row.sessionId); // failed 绕行（I2）：不等窗口立即冲刷，携带同窗 pending 条目
        continue;
      }
      if (batch.timer === null) batch.timer = ctx.clock.setTimeout(() => flushBatch(row.sessionId), DELIVER_BATCH_MS);
    }
  };

  /** 24h verified-absence 独立通道（D2a）：accepted 行 verified 迟到 24h → 恰一次幂等 re-push（不经 drain、不改状态）。 */
  const repushScan = (): void => {
    const now = ctx.clock.now();
    const due = new Map<string, DeliveryRowData[]>();
    for (const [sessionId, book] of pushBook) {
      for (const [notificationId, entry] of book) {
        const row = ctx.store.getDelivery(notificationId, sessionId);
        if (!row || row.state !== "accepted") {
          book.delete(notificationId); // verified/failed/dead-letter 终态或行消失：出簿记（verified 恒 hold，无复活语义）
          continue;
        }
        // verified 行已在上行出簿记（hold 语义）：窗口与 repushed 棘智由 domain 判定正典持有
        if (repushDecision({ verified: false, repushed: entry.repushed, pushedAt: entry.pushedAt }, now) === "hold") continue;
        entry.repushed = true; // 恰一次置位（attempt-marked：push 失败不复活，#31 无其他复活路径）
        const list = due.get(sessionId) ?? [];
        list.push(row);
        due.set(sessionId, list);
      }
      if (book.size === 0) pushBook.delete(sessionId);
    }
    for (const [sessionId, rows] of due) {
      void ctx.pusher.push(assembleLine(rows)).then(undefined, () => undefined); // 尽力一次：结果不改变幂等置位
    }
  };

  /** 1s 兑底扫（丢唤醒自愈）：启动前已存在的 pending 行（唤醒信号先于循环）也由此补投。 */
  let fallbackTimer: { cancel(): void } | null = null;
  const fallbackTick = (): void => {
    if (stopped) return;
    deliverScan();
    repushScan();
    fallbackTimer = ctx.clock.setTimeout(fallbackTick, DELIVER_FALLBACK_MS);
  };
  fallbackTimer = ctx.clock.setTimeout(fallbackTick, DELIVER_FALLBACK_MS);

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

  return {
    submit: doSubmit,
    ingestProbeResult,
    sessionStart,
    cache: { states },
    errors,
    stop(): void {
      stopped = true;
      scheduleTimer?.cancel();
      scheduleTimer = null;
      fallbackTimer?.cancel();
      fallbackTimer = null;
      for (const batch of batches.values()) batch.timer?.cancel();
      batches.clear();
      activeSessions.clear();
      offWrite(); // 幂等取消订阅（票 25 Finding 2）：重复启停不累积监听器、旧闭包可回收
    },
  };
}
