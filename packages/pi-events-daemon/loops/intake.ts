/**
 * loops/intake — L0 verdict-intake（票 124，候选3）：Runner slot 的 verdict 应用链（阈值步进 →
 * 翻转沿 → transition → 生命周期 close-flip）自 loops/index.ts L0 段迁出（票 43 deliver 迁出的
 * 同构做法——票 26 系变更不再触碰 L0/L1 调度文件）；原样迁移零语义变更，评审修复注释
 * （F6/F7/F11/C7/H7/L12/B4/B5）随实现保留（迁移非删除）。
 *
 * createIntake(ctx, deps) 接口面：
 *  - thresholdStates：槽阈值 runtime（内存权威，A5；intake 持有——verdict 应用与计数同生死）；
 *  - applyProbeVerdict：L0 消费钩（apply switch 的 probeVerdict 分支体）；
 *  - lastEventIdFor：同态重放补物化点查（票 123 已下推 store，intake 仅供 applyProbeVerdict 链内使用）。
 *
 * kernel 写调用（transition/cancel/flipSubscription/fanOut）仍留在 L0 串行消费内，经参数注入
 * （deps.kernel，票 43 同构）；import type 引 loops 入口无运行时环。
 */
import type { ThresholdState } from "../domain/intent.ts";
import { INITIAL_THRESHOLD_STATE, observeVerdict, onVerdict, restoreSlotThresholds, runnerSlotKey, type VerdictAction } from "../domain/intent.ts";
import { type EntityRef, type Verdict } from "../domain/types.ts";
import type { Kernel } from "../kernel/index.ts";
import type { SubscriptionRow } from "../store/index.ts";
import type { LoopsCtx, MutationRequest } from "./index.ts";

/** intake 依赖注入（票 43 同构）：kernel = L0 串行内唯一写者面；orchestrateOnTransition = C2 编排钩
 * （transition 消费成功后的 on-transition 规则评估，属 kernel 域编排——钩注入避免 intake 反向依赖
 * 编排闭包）；fanOutSessions = 投递活跃 session 投影（deliver 五 seam 之一，pre-cancel fanOut 用）。 */
export interface IntakeDeps {
  kernel: Kernel;
  orchestrateOnTransition: (ref: EntityRef, from: string | null, to: string) => void;
  fanOutSessions: () => Parameters<Kernel["fanOut"]>[1]["activeSessions"];
}

export interface VerdictIntake {
  /** 槽阈值 runtime（内存权威 A5；intake 持有——verdict 应用与计数同生死）。 */
  thresholdStates: Map<string, { generation: number; state: ThresholdState }>;
  /** L0 消费钩：apply switch 的 probeVerdict 分支体（原 applyProbeVerdict 逐字迁出）。 */
  applyProbeVerdict: (req: Extract<MutationRequest, { kind: "probeVerdict" }>) => void;
  /** 同态重放补物化点查（票 123 下推 store；仅 intake 链内使用，导出为 applyProbeVerdict 闭包依赖）。 */
  lastEventIdFor: (ref: EntityRef, to: string) => string | undefined;
}

export function createIntake(ctx: LoopsCtx, deps: IntakeDeps): VerdictIntake {
  const { kernel } = deps;
  // 票 26：verdict 计数评估（domain observeVerdict）在 L0 消费时调用——计数状态是槽 runtime
  // （内存权威，重启归零重探 R1 A5：持久层不承载翻转态，重启后首个 fresh verdict 视为到达）。
  // 评审 B 组：值携带槽 generation——generation 变化（槽重建/换参）时评估状态归零，不继承旧计数。
  const thresholdStates = new Map<string, { generation: number; state: ThresholdState }>();

  // 票 123（候选2）：N+1 裸扫下推 store.latestEventIdFor（SQL 索引查）
  const lastEventIdFor = (ref: EntityRef, to: string): string | undefined =>
    ctx.store.latestEventIdFor({ type: ref.type, key: ref.key }, to);

  const applyProbeVerdict = (req: Extract<MutationRequest, { kind: "probeVerdict" }>): void => {
    // ===== 以下自 loops/index.ts 逐字迁出（票 124）=====
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
    if (result) deps.orchestrateOnTransition(ref, result.from, result.to); // C2：probe 翻转沿转换同链编排
    const actions: Array<{ sub: SubscriptionRow; action: VerdictAction }> = slotSubs.map((s) => ({
      sub: s,
      action: onVerdict({ once: s.once ?? false, twoStage: s.flip ?? false }, s.phase ?? "startup", req.verdict),
    }));
    if (actions.some((a) => a.action.action === "close")) {
      // 评审 F11/C7：关闭前物化该事件投递目标（事件→fanOut→cancel 各自事务；fanOut/cancel 幂等，
      // 崩溃重放安全）。transition null = 同态重放（崩溃重启后归零重评，事件已在 outbox）——
      // 按实体+verdict 扫尾补 eventId。评审 H7/L12：pre-cancel fanOut 同用活跃 session 投影
      // （fanOutSessions）——once 达标即推终端事件不等重连 drain；消灭内联重复投影。
      const eventId = result ? result.eventId : lastEventIdFor(ref, req.verdict);
      if (eventId) kernel.fanOut(eventId, { activeSessions: deps.fanOutSessions() });
    }
    thresholdStates.set(req.slotKey, { generation, state: step.state });
    mirrorLedger(); // 镜像先于生命周期：cancel 的 refcount 重算会读本行并保留/清零计数
    // 订阅生命周期（I7 收窄真值表，domain onVerdict）：仅达标翻转沿消费——once 首 passed 转换后关订阅；两阶段 startup passed 切 flip
    for (const { sub, action } of actions) {
      if (action.action === "close") kernel.cancel({ subscriptionId: sub.subscriptionId, reason: action.reason, now: ctx.clock.now() });
      else if (action.action === "advance") kernel.flipSubscription(sub.subscriptionId);
    }
  };

  return { thresholdStates, applyProbeVerdict, lastEventIdFor };
}
