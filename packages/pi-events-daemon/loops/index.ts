/**
 * loops — 五控制循环的调度与触发（模块 spec loops.md）。票 25：L0 Mutation 唯一写者 + startLoops 骨架；
 * 票 26：L1 Probe（completion 回流消费 + cron/interval 到点排 probe + catch_up_one + once/readyCheck 调度）。
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
  observeVerdict,
  onVerdict,
  restoreSlotThresholds,
  runnerSlotKey,
  type ThresholdState,
} from "../domain/intent.ts";

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
import type { ProbeSpecRow, Store, SubscriptionRow } from "../store/index.ts";
import type { SessionRef, TranscriptAdapter } from "../transcript-adapter/index.ts";

/** L0 变更请求——kernel 变更方法（票 10 消费终点 transition/consumeIntent + 票 24/26 subscribe/cancel）的队列载体；
 *  probeVerdict 是 L1 回流（prober completion queue）进 L0 的串行链入口（D4：L1 消费回流，L0 唯一写者）。 */
export type MutationRequest =
  | { kind: "transition"; ref: EntityRef; verdict: Verdict; occurredAt: string }
  | { kind: "consumeIntent"; intent: TransitionIntent }
  | { kind: "subscribe"; req: SubscribeRequest; deps?: SubscribeDeps }
  | { kind: "cancel"; req: CancelRequest }
  | { kind: "probeVerdict"; slotKey: string; verdict: Verdict; occurredAt: string;
      /** 评审 B 组：dispatch 时刻的槽 generation——旧代 completion 拒应用；缺省（watch 回流等无 dispatch 来源）不判代。 */
      generation?: number }
  // 票 28：L3 verify 收口（I9 点查命中后经唯一写路径落账）+ drain 触发载体（L2/transport 接线前的队列面）
  | { kind: "verify"; notificationId: string; sessionId: string }
  | { kind: "drain"; sessionId?: string };


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
  /** 票 28 L3：I9 唯一权威点接线（adapter + session→transcript 解析，transport 注册面在组合根接入）。
   *  缺省 = L3 关闭（零扫描零定时器）。 */
  transcript?: {
    adapter: TranscriptAdapter;
    /** sessionId → SessionRef；未注册 session 的投递保持 accepted 待扫（level-trigger 自愈）。 */
    sessionRefOf(sessionId: string): SessionRef | undefined;
  };
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
    if (stopped || !tables.includes("entities")) return;
    reproject();
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
      case "verify":
        // 出参 outcome 由 store 真相承载（level-trigger 下一扫自愈）；reason 面契约已由 kernel.verify 钉死
        kernel.verify(req.notificationId, req.sessionId);
        return;
      case "drain":
        kernel.drain({
          ...(req.sessionId !== undefined ? { sessionId: req.sessionId } : {}),
          now: ctx.clock.now(),
        });
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
        verifyScan();
        scheduleVerifyScan();
      },
      scannedOnce ? L3_SCAN_INTERVAL_MS : 0, // 启动首扫不等首周期
    );
  };
  scheduleVerifyScan();

  return {
    submit: doSubmit,
    ingestProbeResult,
    cache: { states },
    errors,
    stop(): void {
      stopped = true;
      scheduleTimer?.cancel();
      scheduleTimer = null;
      scanTimer?.cancel(); // 票 28 L3 扫描定时器（未接线时为 null）
      scanTimer = null;
      offWrite(); // 幂等取消订阅（票 25 Finding 2）：重复启停不累积监听器、旧闭包可回收
    },
  };
}
