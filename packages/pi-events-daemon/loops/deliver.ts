/**
 * loops/deliver — L2 Deliver（票 27）：唤醒双通道 + 投递铁律 + batch 合流 + 退避重试 + drain/snapshot
 * + 24h verified-absence re-push。票 43：自 loops/index.ts L2 段整体迁出（冲突面根治——票 27 系
 * 变更不再触碰 L0/L1 文件）；原样迁移零语义变更，票 27 的 12 findings 修复（epoch fence 双漏/
 * 24h 种子/定向推送 sessionId/退避连坐/outbox 确认序/once 事件/停摆 containment/单飞守卫）全部
 * 在段内，评审修复注释随实现保留（迁移非删除）。
 *
 * createDeliver(ctx, deps) 接口面：
 *  - 票 43 五 seam：sessionStart / sessionEnd（transport 接线）、fanOutSessions（L0 apply fanOut deps
 *    与 once pre-cancel 投影）、onWriteScan（store.onWrite 唤醒主路径）、stopDeliver（startLoops.stop
 *    的 L2 runtime 清理）；
 *  - L0 消费钩（apply switch 的 deliver 域请求分支；kernel 写调用仍留在 L0 串行消费内，经参数注入）：
 *    consumeFanOut / applySessionStart / consumeSessionEnd。
 * submit/drain/errors 经参数注入（L0 队列与 kernel 收窄面不进本文件；类型经 import type 引用
 * loops 入口，无运行时环）。
 */
import { type Verdict, entityRefKeyOf } from "../domain/types.ts";
import { epochAccepts, repushDecision } from "../domain/intent.ts";
import { transitionDelivery, type SubscriptionScope } from "../domain/delivery.ts";
import type { Kernel } from "../kernel/index.ts";
import type { DeliveryRowData } from "../store/index.ts";
import type { LoopsCtx, MutationRequest, SubmitOutcome } from "./index.ts";

/** L2 依赖注入（票 43）：submit = L0 队列提交回调（唯一写路径）；drain = kernel 收窄面（SESSION_START
 *  只读 parked 行）；errors = 逐请求捕获面（containment 落点，LoopsHandle.errors 同一数组）。 */
export interface DeliverDeps {
  submit: (req: MutationRequest) => Promise<SubmitOutcome>;
  drain: Kernel["drain"];
  errors: unknown[];
}

export function createDeliver(ctx: LoopsCtx, deps: DeliverDeps) {
  let stopped = false;
  const { submit, drain, errors } = deps;


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
  /** per-session 推送单飞守卫（评审 M3）：常规批与 24h re-push 共享——一 session 至多一未结算 push。
   *  batch.mode=inflight 是批内三态；本守卫跨通道：re-push 见批在飞让路，批见 re-push 在飞同样让路。 */
  const sessionPushInflight = new Set<string>();
  /** I9 在等 verified 的已推行簿记（24h repush 扫描输入）：sessionId → notificationId → {pushedAt, repushed}。
   *  shortcut: 推送簿记是 L2 runtime（store 行 4 字段冻结，票 09 裁定）；repushed/pushedAt 持久载体归 store 行形状扩展票。
   *  重启清零 = 24h 窗口重新计时（R1 A5 归零重探同精神）；窗口内恰一次由 repushed 置位保证。 */
  const pushBook = new Map<string, Map<string, { pushedAt: number; repushed: boolean }>>();
  /** 簿记行桶（缺省建桶）。 */
  const bookOf = (sessionId: string): Map<string, { pushedAt: number; repushed: boolean }> => {
    let book = pushBook.get(sessionId);
    if (!book) {
      book = new Map();
      pushBook.set(sessionId, book);
    }
    return book;
  };
  /** 活跃 session 运行时（sessionStart 登记；断连注销归 transport 票 29 接线）——fanOut auto 编址消费面。 */
  const activeSessions = new Map<string, SubscriptionScope>();
  /** 已消费 outbox 行（fire-once；fanOut 幂等 I10 兑底重启重放）。shortcut: 全量扫 O(outbox)，事件量级下可接受，量大归 store 接口位点精化。 */
  const consumedOutbox = new Set<string>();
  /** outbox 未决标记（评审 H6）：fanOut 消费中防 onWrite 重入 deliverScan 双发；成功转 consumed、失败清除待重试。 */
  const inProgressOutbox = new Set<string>();
  const ownerEpoch = ctx.ownerEpoch ?? 0;
  // 评审 H3：重启种子——簿记是 L2 runtime（重启清零 = 24h 窗口重新计时，R1 A5 归零重探同精神），
  // 但 accepted 行既不在 pendingDeliveries（只含 pending）也不经 drain（只读 parked）：不播种则
  // 24h 恢复通道对重启前 accepted 行消失。种子 pushedAt=本进程起点 → 窗口自重启重新计时。
  for (const row of ctx.store.acceptedDeliveries({})) {
    if (!epochAccepts(row.recordEpoch, ownerEpoch)) continue; // I12：僵尸世代行不纳管
    bookOf(row.sessionId).set(row.notificationId, { pushedAt: ctx.clock.now(), repushed: false });
  }

  /** 票 27 L2 入口（transport 连接回调接线）：SESSION_START 进 L0 队列——drain 是 kernel 方法，唯一写者路径。 */
  const sessionStart = (sessionId: string, scope?: SubscriptionScope): void => {
    void submit({ kind: "sessionStart", sessionId, scope });
  };

  /** 票 38 评审 M：断连注销（transport onSessionEnd 接线）——从活跃面删除，fanOut 编址不再含它。 */
  const sessionEnd = (sessionId: string): void => {
    void submit({ kind: "sessionEnd", sessionId });
  };

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

  /** 合流行（billboard 条目形态 #31：count + 实体 + verdict；notificationId 随行 = I9 transcript 点查匹配键；eventSeq 序确定性）。
   *  评审 H4：envelope 携带目标 sessionId——SocketPusher 逐行广播，接收端据 sessionId 过滤（编址不丢）。 */
  const assembleLine = (sessionId: string, rows: readonly DeliveryRowData[]): string => {
    const entries = rows
      .map((r) => ({ row: r, ev: ctx.store.tx((tx) => tx.getEvent(r.notificationId)) }))
      .sort((a, b) => (a.ev?.eventSeq ?? 0) - (b.ev?.eventSeq ?? 0))
      .map(({ row, ev }) => ({
        notificationId: row.notificationId,
        entityRef: ev ? entityRefKeyOf({ type: ev.entityRefType, key: ev.entityRefKey }) : "",
        verdict: (ev?.to ?? "") as Verdict,
      }));
    return JSON.stringify({ sessionId, count: entries.length, entries });
  };

  /** 推送成功簿记（两段式 ack 段一：pending→accepted 正典边；verified 归 I9/L3，L2 永不写 verified）。
   *  评审 H1：结算前重读行并复核 I12 epoch fence——在飞期间被换代的行是他人所有，行与簿记都不 ack。 */
  const markPushed = (rows: readonly DeliveryRowData[]): void => {
    const now = ctx.clock.now();
    for (const r of rows) {
      const cur = ctx.store.getDelivery(r.notificationId, r.sessionId);
      if (!cur || !epochAccepts(cur.recordEpoch, ownerEpoch)) continue;
      const book = bookOf(r.sessionId);
      const prev = book.get(r.notificationId);
      book.set(r.notificationId, { pushedAt: now, repushed: prev?.repushed ?? false });
      if (cur.state !== "pending") continue;
      const edge = transitionDelivery("pending", "wake-accepted");
      if (!edge.ok) {
        errors.push(new Error(`L2: canonical edge pending+wake-accepted rejected: ${edge.reason}`));
        continue;
      }
      ctx.store.putDelivery({ ...cur, state: edge.to });
    }
  };

  /** E2 退避重试/耗尽：指数 2s→5min，封顶值上 5 次后 pending/accepted → dead-letter（正典边 retry-exhausted）。
   *  评审 H5：耗尽只结算本次推送尝试快照（attempted）——在飞期间新入批行未参与失败推送，不连带
   *  dead-letter；清出后重开窗获得自己的投递机会（fails 一并归零，不背旧账）。 */
  const failBatch = (batch: DeliverBatch, sessionId: string, attempted: readonly DeliveryRowData[]): void => {
    batch.fails += 1;
    if (batch.fails < DELIVER_BACKOFF_PRE_CAP_ATTEMPTS + DELIVER_BACKOFF_CAP_ATTEMPTS) {
      batch.mode = "retry";
      const wait = Math.min(DELIVER_BACKOFF_BASE_MS * 2 ** (batch.fails - 1), DELIVER_BACKOFF_MAX_MS);
      batch.timer = ctx.clock.setTimeout(() => flushBatch(sessionId), wait);
      return;
    }
    batch.mode = "window";
    try {
      for (const r of liveOf(attempted)) {
        const cur = ctx.store.getDelivery(r.notificationId, r.sessionId);
        if (!cur) continue;
        const edge = transitionDelivery(cur.state, "retry-exhausted");
        if (!edge.ok) {
          errors.push(new Error(`L2: canonical edge ${cur.state}+retry-exhausted rejected: ${edge.reason}`));
          continue;
        }
        ctx.store.putDelivery({ ...cur, state: edge.to });
      }
    } catch (err) {
      errors.push(err); // 评审 H8：耗尽结算写失败 containment——行留批内随 level-trigger 自愈
    }
    for (const r of attempted) batch.rows.delete(r.notificationId);
    batch.fails = 0;
    if (liveOf(batch.rows.values()).length === 0) {
      batches.delete(sessionId);
      return;
    }
    batch.timer = ctx.clock.setTimeout(() => flushBatch(sessionId), DELIVER_BATCH_MS);
  };

  /** 冲刷一批（窗口到期 / 重试到点 / failed 绕行 / snapshot 直推共用）：成功→ack+余量重开窗；失败→退避重排。
   *  评审 H8：组装与结算全程 containment——Store 读/写异常记 errors 并转退避态，不自困 inflight、
   *  不产生未处理 rejection；评审 M1：结算时余量行含 failed 事件 → 立即冲刷（在飞期到达的绕行不再被开窗吞掉）。 */
  const flushBatch = (sessionId: string): void => {
    if (stopped) return;
    const batch = batches.get(sessionId);
    if (!batch || batch.mode === "inflight" || sessionPushInflight.has(sessionId) || batch.rows.size === 0) return;
    batch.timer?.cancel();
    batch.timer = null;
    let live: DeliveryRowData[];
    let line: string;
    try {
      live = liveOf(batch.rows.values());
      if (live.length === 0) {
        batches.delete(sessionId);
        return;
      }
      batch.mode = "inflight";
      sessionPushInflight.add(sessionId);
      line = assembleLine(sessionId, live);
    } catch (err) {
      sessionPushInflight.delete(sessionId);
      errors.push(err);
      failBatch(batch, sessionId, []);
      return;
    }
    void ctx.pusher.push(line).then(
      (delivered: number) => {
        sessionPushInflight.delete(sessionId);
        if (stopped) return;
        if (delivered <= 0) {
          // 票 38 评审 H：0 送达（零客户端/写全败）= 无人收到，不迁移——行留批内重开窗，
          // 下个窗口/兑底 tick 重试（尽力唤醒：不进退避，客户端随时可连 snapshot 即达）
          batch.mode = "window";
          batch.timer = ctx.clock.setTimeout(() => flushBatch(sessionId), DELIVER_BATCH_MS);
          return;
        }
        try {
          markPushed(live);
          for (const r of live) batch.rows.delete(r.notificationId);
          batch.fails = 0; // 传输恢复：余量行不从旧失败继承退避
          const remaining = liveOf(batch.rows.values()); // 在飞期间新入批的行（wake pending / sessionStart snapshot）结算后冲刷，不丢弃
          if (remaining.length === 0) {
            batches.delete(sessionId);
            return;
          }
          batch.mode = "window";
          batch.timer = null;
          if (remaining.some((r) => eventVerdictOf(r.notificationId) === "failed")) {
            flushBatch(sessionId); // 评审 M1：failed 绕行在飞期到达 → 结算即冲刷，不再吃整窗
            return;
          }
          batch.timer = ctx.clock.setTimeout(() => flushBatch(sessionId), DELIVER_BATCH_MS);
        } catch (err) {
          errors.push(err); // 评审 H8：结算异常 containment——批转退避（行留在批内，恢复后重试）
          failBatch(batch, sessionId, live);
        }
      },
      () => {
        sessionPushInflight.delete(sessionId);
        if (stopped) return;
        failBatch(batch, sessionId, live);
      },
    );
  };

  /** SESSION_START 消费（L0 内）：登记活跃 + drain（只投 parked，D2a）+ wake snapshot 组装（drained 重投行 ∪ pending）立即冲刷。 */
  const applySessionStart = (sessionId: string, scope: SubscriptionScope): void => {
    activeSessions.set(sessionId, scope);
    const drained = drain({ sessionId }); // epoch fence 在 kernel 侧（异世代 parked 行不动）
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
    // outbox 消费（票 11 落点：投递循环消费 outbox → L0 队列内 fanOut 编址；fire-once，fanOut 幂等兑底重启重放）。
    // 评审 H6：in-progress 防重入（fanOut 提交回调 onWrite 同 tick 重入）+ 成功才消费（apply fanOut 分支）——
    // withRetry 耗尽（临时 Store 故障）只进 errors，未决标记清除后由下个兜底 tick 重试，投递不丢。
    for (const row of ctx.store.outboxBatch(Number.MAX_SAFE_INTEGER)) {
      if (consumedOutbox.has(row.notificationId) || inProgressOutbox.has(row.notificationId)) continue;
      inProgressOutbox.add(row.notificationId);
      submit({ kind: "fanOut", notificationId: row.notificationId });
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

  /** 24h verified-absence 独立通道（D2a）：accepted 行 verified 迟到 24h → 恰一次幂等 re-push（不经 drain、不改状态）。
   *  评审 H2：I12 epoch fence——换代行出簿记不 re-push；评审 M3：与常规批共享 per-session 单飞守卫，
   *  busy 让路（恰一次置位延后到获得守卫，不提前），retain 一次/不经 drain 语义。 */
  const repushScan = (): void => {
    const now = ctx.clock.now();
    const due = new Map<string, DeliveryRowData[]>();
    for (const [sessionId, book] of pushBook) {
      for (const [notificationId, entry] of book) {
        const row = ctx.store.getDelivery(notificationId, sessionId);
        if (!row || row.state !== "accepted" || !epochAccepts(row.recordEpoch, ownerEpoch)) {
          book.delete(notificationId); // verified/failed/dead-letter 终态、行消失或换代（I12）：出簿记（verified 恒 hold，无复活语义）
          continue;
        }
        // verified 行已在上行出簿记（hold 语义）：窗口与 repushed 棘智由 domain 判定正典持有
        if (repushDecision({ verified: false, repushed: entry.repushed, pushedAt: entry.pushedAt }, now) === "hold") continue;
        const list = due.get(sessionId) ?? [];
        list.push(row);
        due.set(sessionId, list);
      }
      if (book.size === 0) pushBook.delete(sessionId);
    }
    for (const [sessionId, rows] of due) {
      if (sessionPushInflight.has(sessionId)) continue; // 评审 M3：批在飞让路——本 tick 跳过，下个兜底 tick 重判（未置位不违恰一次）
      for (const r of rows) {
        const entry = pushBook.get(sessionId)?.get(r.notificationId);
        if (entry) entry.repushed = true; // 恰一次置位（attempt-marked：push 失败不复活，#31 无其他复活路径）
      }
      sessionPushInflight.add(sessionId);
      void ctx.pusher.push(assembleLine(sessionId, rows)).then(
        () => sessionPushInflight.delete(sessionId),
        () => sessionPushInflight.delete(sessionId),
      ); // 尽力一次：结果不改变幂等置位
    }
  };

  /** 1s 兑底扫（丢唤醒自愈）：启动前已存在的 pending 行（唤醒信号先于循环）也由此补投。 */
  let fallbackTimer: { cancel(): void } | null = null;
  const fallbackTick = (): void => {
    if (stopped) return;
    // 评审 M2：单次扫异常 containment——两通道各自隔离，异常记 errors 后照常重排兜底定时器
    //（否则一次 Store 读抖动永久禁用丢唤醒自愈与 24h 恢复通道）
    try {
      deliverScan();
    } catch (err) {
      errors.push(err);
    }
    try {
      repushScan();
    } catch (err) {
      errors.push(err);
    }
    if (!stopped) fallbackTimer = ctx.clock.setTimeout(fallbackTick, DELIVER_FALLBACK_MS);
  };
  fallbackTimer = ctx.clock.setTimeout(fallbackTick, DELIVER_FALLBACK_MS);

  /** L0 apply fanOut 分支体（kernel.fanOut 写调用经参数注入，仍在 L0 串行消费内）。
   *  评审 H6：in-progress 标记防重入（fanOut 提交回调 onWrite 会重入 deliverScan）+ 成功才消费——
   *  withRetry 耗尽（临时 Store 故障）不丢投递：finally 清未决标记，下个兜底 tick 重试（I10 幂等兑底） */
  const consumeFanOut = (notificationId: string, fanOut: Kernel["fanOut"]): unknown => {
    try {
      const result = fanOut(notificationId, { activeSessions: fanOutSessions() });
      consumedOutbox.add(notificationId);
      return result;
    } finally {
      inProgressOutbox.delete(notificationId);
    }
  };

  /** L0 apply sessionEnd 分支体。票 38 评审 M：断连注销——fanOut 编址不再含它，pending 行留待重连 drain（不丢） */
  const consumeSessionEnd = (sessionId: string): void => {
    activeSessions.delete(sessionId);
  };

  /** 停机（startLoops.stop 消费）：兜底定时器 + 批定时器/活跃面/单飞守卫清理（与 L0 队列关闭同块执行）。 */
  const stopDeliver = (): void => {
    stopped = true;
    fallbackTimer?.cancel();
    fallbackTimer = null;
    for (const batch of batches.values()) batch.timer?.cancel();
    batches.clear();
    activeSessions.clear();
    sessionPushInflight.clear();
  };

  return {
    // 票 43 五 seam
    sessionStart,
    sessionEnd,
    fanOutSessions,
    onWriteScan: deliverScan, // store.onWrite 唤醒主路径（deliveries/outbox 写）
    stopDeliver,
    // L0 消费钩（apply switch 的 deliver 域请求分支）
    consumeFanOut,
    applySessionStart,
    consumeSessionEnd,
  };
}
