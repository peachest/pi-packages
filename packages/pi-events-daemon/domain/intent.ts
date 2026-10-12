/**
 * domain/intent.ts — ticket 08: TransitionIntent 双轨（R1）+ appendIfMissing + 封闭集执法.
 *
 * 零 IO 纯函数：输入数据、输出数据，不碰 store、不碰时钟、不碰 socket。
 * 依赖方向：本文件只 import ./types.ts（domain 内共享类型正典，2026-10-12 统一）。
 *
 * 术语正典：packages/prototype-events-daemon/CONTEXT.md；契约：#31 spec（spec31-body.md）。
 */
import {
  type EntityRef,
  type Verdict,
  type Transitioned,
  type TransitionIntent,
  deterministicEventId,
  TRANSITIONED_CONTENT_FIELDS,
  TRANSITIONED_FIELDS,
} from "./types.ts";

// re-export（消费方零改动；intent.test.ts 从本文件 import 这些名字）
export type { EntityRef, Verdict, Transitioned, TransitionIntent };
export { deterministicEventId, TRANSITIONED_CONTENT_FIELDS, TRANSITIONED_FIELDS };

/** appendIfMissing 的内容比较域：#31 事件模型清单（不含匹配键 eventId）。 */
// 内容比较域正典在 types.ts（TRANSITIONED_CONTENT_FIELDS）

// --- R1 双轨 ---

/** 双轨游标：各自单调，恢复时各从自己的真相源重算（决策序 ← mutation line；eventSeq ← 事件流）。 */
export interface IntentSequences {
  decisionOrder: number;
  eventSeq: number;
}

export const FIRST_SEQUENCE: IntentSequences = { decisionOrder: 0, eventSeq: 0 };

export function planTransition(
  seq: IntentSequences,
  t: Omit<TransitionIntent, "eventId" | "decisionOrder" | "eventSeq">,
): { intent: TransitionIntent; sequences: IntentSequences } {
  const decisionOrder = seq.decisionOrder + 1;
  const eventSeq = seq.eventSeq + 1;
  return {
    intent: { ...t, eventId: deterministicEventId(t.entityRef, decisionOrder), decisionOrder, eventSeq },
    sequences: { decisionOrder, eventSeq },
  };
}

export function intentToEvent(intent: TransitionIntent): Transitioned {
  const { eventId, eventSeq, entityRef, from, to, contentIdentity, occurredAt, evidenceRef } = intent;
  return { eventId, eventSeq, entityRef, from, to, contentIdentity, occurredAt, evidenceRef };
}

/** 清单内容逐字段相等（undefined 与缺失视为同值）。 */
export function sameEventContent(a: Transitioned, b: Transitioned): boolean {
  return TRANSITIONED_CONTENT_FIELDS.every((f) => {
    const av = a[f];
    const bv = b[f];
    return (av === undefined && bv === undefined) || av === bv;
  });
}

// --- 跨聚合一致性：appendIfMissing（同 id 跳过、异内容 = corruption）---

export type AppendOutcome =
  | { kind: "appended"; event: Transitioned }
  | { kind: "skipped" }
  | { kind: "corruption"; stored: Transitioned; incoming: Transitioned };

/** I3 封闭集执法：查值不 import profiles（I-01）；null from 合法（首转换 / SetState 首态）。 */
export function requireStateIn(states: ReadonlySet<string>, state: string | null): void {
  if (state === null) return;
  if (!states.has(state)) {
    throw new Error(`state "${state}" outside profile closed set`);
  }
}

/**
 * 顺序消费一个 TransitionIntent：
 * - 无同 id 事件 → appended（transition + Transitioned 同事务原子的纯层形态：事件入流，状态随之归约，不可拆分，I1）
 * - 同 id 同内容 → skipped（幂等重放）
 * - 同 id 异内容 → corruption（确定性重放被破坏 / 多写者，票 09 据此判定）
 * opts.states 提供时对 to / from 做 I3 封闭集同步拒绝。
 */
export function appendIfMissing(
  log: readonly Transitioned[],
  intent: TransitionIntent,
  opts?: { states?: ReadonlySet<string> },
): { log: Transitioned[]; outcome: AppendOutcome } {
  if (opts?.states) {
    requireStateIn(opts.states, intent.to);
    requireStateIn(opts.states, intent.from);
  }
  const existing = log.find((e) => e.eventId === intent.eventId);
  if (existing) {
    if (sameEventContent(existing, intentToEvent(intent))) {
      return { log: [...log], outcome: { kind: "skipped" } };
    }
    return { log: [...log], outcome: { kind: "corruption", stored: existing, incoming: intentToEvent(intent) } };
  }
  const event = intentToEvent(intent);
  return { log: [...log, event], outcome: { kind: "appended", event } };
}

// --- verdict 计数（k8s probe 阈值语义，#31 R2 裁定）---

export interface ThresholdConfig {
  failureThreshold: number;
  successThreshold: number;
}

export const DEFAULT_THRESHOLDS: ThresholdConfig = { failureThreshold: 1, successThreshold: 1 };

/** 阈值评估状态：settled = 已到达的判定（null = 尚无翻转）；计数期内不翻转不发事件。 */
export interface ThresholdState {
  consecutiveFails: number;
  consecutivePasses: number;
  settled: Verdict | null;
}

export const INITIAL_THRESHOLD_STATE: ThresholdState = { consecutiveFails: 0, consecutivePasses: 0, settled: null };

/**
 * 单次 verdict 观测：
 * - failed：连续失败 +1（清成功计数），计满 failureThreshold 且 settled≠failed → 翻转沿（flipped=true，到达事件）
 * - passed：对称，计满 successThreshold 且 settled≠passed → 恢复翻转
 * - waiting：中性断连——清两侧连续计数，永不翻转（"连续"字面语义）
 * 翻转沿才发事件；持续同态不重复发。
 */
export function observeVerdict(
  state: ThresholdState,
  verdict: Verdict,
  cfg: ThresholdConfig = DEFAULT_THRESHOLDS,
): { state: ThresholdState; flipped: boolean } {
  if (verdict === "waiting") {
    return { state: { consecutiveFails: 0, consecutivePasses: 0, settled: state.settled }, flipped: false };
  }
  if (verdict === "failed") {
    const consecutiveFails = state.consecutiveFails + 1;
    const flip = consecutiveFails >= cfg.failureThreshold && state.settled !== "failed";
    return {
      state: { consecutiveFails, consecutivePasses: 0, settled: flip ? "failed" : state.settled },
      flipped: flip,
    };
  }
  const consecutivePasses = state.consecutivePasses + 1;
  const flip = consecutivePasses >= cfg.successThreshold && state.settled !== "passed";
  return {
    state: { consecutiveFails: 0, consecutivePasses, settled: flip ? "passed" : state.settled },
    flipped: flip,
  };
}

// --- 订阅判定：once / readyCheck / I7 终态关闭收窄 ---

export type SubPhase = "startup" | "flip";

/** 订阅形态：once = 单发等待（wait 形态）；twoStage = readyCheck 两阶段（startup → flip）。 */
export interface SubShape {
  once: boolean;
  twoStage: boolean;
}

export type VerdictAction =
  | { action: "stay-open" }
  | { action: "advance"; phase: "flip" }
  | { action: "close"; reason: "once-passed" | "failed-terminal" };

/**
 * verdict 到达时的订阅判定真值表（I7 收窄）。
 * wait 形态 = once 订阅 或 twoStage 的 startup 阶段（含 ad-hoc 一次性等待）：failed 到达即终态关闭
 * （等待的事实已定局，agent 自行重订）；flip 监视形态 failed = not-ready 翻转沿发事件，不关闭，
 * 只经 ttl/cancel 退出。startup passed → 推进 flip（readyCheck 接管判定）；once 首 passed 关闭。
 */
export function onVerdict(shape: SubShape, phase: SubPhase, verdict: Verdict): VerdictAction {
  if (verdict === "waiting") return { action: "stay-open" };
  if (verdict === "failed") {
    const waitForm = shape.once || (shape.twoStage && phase === "startup");
    return waitForm ? { action: "close", reason: "failed-terminal" } : { action: "stay-open" };
  }
  if (shape.twoStage && phase === "startup") return { action: "advance", phase: "flip" };
  return shape.once ? { action: "close", reason: "once-passed" } : { action: "stay-open" };
}

/** readyCheck：flip 阶段的第二判定 check；缺省沿用 startup check（两阶段订阅，US-8）。 */
export function checkForPhase(spec: { check: string; readyCheck?: string }, phase: SubPhase): string {
  return phase === "flip" ? (spec.readyCheck ?? spec.check) : spec.check;
}

// --- 槽级纯计算：阈值先建者定 / I5 谓词不进槽键 / RunLedger 归零重探 ---

/**
 * 订阅加入槽时的阈值归属：空槽采纳（先建者定）；同值沿用；异值 → warning + 沿用槽现值
 * （一个实体一个状态机，不因敏感度不同分裂，#31 R2 裁定）。
 */
export function adoptThresholds(
  slot: ThresholdConfig | null,
  incoming: ThresholdConfig,
): { thresholds: ThresholdConfig; warning: string | null } {
  if (!slot) return { thresholds: incoming, warning: null };
  if (slot.failureThreshold === incoming.failureThreshold && slot.successThreshold === incoming.successThreshold) {
    return { thresholds: slot, warning: null };
  }
  return { thresholds: slot, warning: "thresholds differ from slot — keeping slot's existing values (first-creator-wins)" };
}

/**
 * 重启重建：槽阈值随首个重建订阅的创建序恢复（先建者定原则跨重启延续）；
 * 平局取列表先者；空列表回落默认 1/1。
 */
export function restoreSlotThresholds(
  subs: ReadonlyArray<{ createdAt: number; thresholds: ThresholdConfig }>,
): ThresholdConfig {
  let best: { createdAt: number; thresholds: ThresholdConfig } | undefined;
  for (const s of subs) {
    if (!best || s.createdAt < best.createdAt) best = s;
  }
  return best ? best.thresholds : DEFAULT_THRESHOLDS;
}

/**
 * I5：槽键 = (EntityRef, 模板)，谓词（on）不参与——N 个不同 on 谓词共享同一次抓取；
 * 模板/实体不同才拆槽。谓词不在签名里即结构上不可能进键。
 */
export function runnerSlotKey(ref: EntityRef, template: string): string {
  return `slot:${ref.type}:${ref.key}#${template}`;
}

/** RunLedger（槽 runtime 簿记，非聚合、非真相源——A2/A5）。 */
export interface RunLedger {
  inFlight: boolean;
  lastVerdict: Verdict | null;
  nextDueAt: number | null;
  consecutiveFails: number;
  lastEvidenceRef: string | null;
}

/**
 * 归零重探（R1 A5）：重启后全槽立即重探一次（拿最新事实）。任意槽态输入 →
 * 计数归零 + lastVerdict 清空（重启后首个 fresh verdict 视为到达）+ nextDueAt=now 重探标记。
 */
export function rebuildRunLedger(_ledger: RunLedger, now: number): RunLedger {
  return { inFlight: false, lastVerdict: null, nextDueAt: now, consecutiveFails: 0, lastEvidenceRef: null };
}

// --- 不变量执法：I8 ttl / I9 transcript 验证 / I10 单行 / I12 epoch + 幂等 re-push ---

/** I8：ttl 到期（> ttl 即过期，到期点即关）；now 由调用方注入（零时钟）。 */
export function ttlExpired(sub: { createdAt: number; ttlMs: number }, now: number): boolean {
  return now - sub.createdAt > sub.ttlMs;
}

/** I9：verified 判定 = 确定性 notificationId 出现在目标 session transcript（点查询用纯谓词）。 */
export function transcriptVerifies(notificationId: string, transcript: readonly string[]): boolean {
  return transcript.some((line) => line.includes(notificationId));
}

/** I10 单行根：DeliveryRow 正典在 types.ts（A1 收敛，含 state/ownerEpoch/repush 幂等载体）。 */
export type { DeliveryRow } from "./types.ts";
import type { DeliveryRow } from "./types.ts";

/** 同对幂等返回既有行（不产生第二行）；新对追加（初态 pending + 所有权 epoch 由调用方给）。 */
export function upsertDelivery(
  rows: readonly DeliveryRow[],
  notificationId: string,
  sessionId: string,
  ownerEpoch: number,
): { rows: DeliveryRow[]; row: DeliveryRow; created: boolean } {
  const existing = rows.find((r) => r.notificationId === notificationId && r.sessionId === sessionId);
  if (existing) return { rows: [...rows], row: existing, created: false };
  const row: DeliveryRow = { notificationId, sessionId, state: "pending", ownerEpoch };
  return { rows: [...rows, row], row, created: true };
}

/** I12：投递记录带所有权 + epoch——仅当前 epoch 的写者放行，僵尸 daemon 误投被结构性拒绝。 */
export function epochAccepts(recordEpoch: number, currentEpoch: number): boolean {
  return recordEpoch === currentEpoch;
}

/** verified 迟到窗口：verified 迟到 24h → 一次幂等 re-push（dead-letter 的唯一复活通道，D2a）。 */
export const REPUSH_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * 24h verified-absence 幂等 re-push 判定（挂 I10 语义：确定性 notificationId 复用唯一行，
 * re-push 不产生新投递行）。恰一次：repushed 置位后恒 hold；已 verified 恒 hold。
 */
export function repushDecision(
  row: { verified: boolean; repushed: boolean; pushedAt: number },
  now: number,
  windowMs: number = REPUSH_WINDOW_MS,
): "repush" | "hold" {
  if (row.verified || row.repushed) return "hold";
  return now - row.pushedAt >= windowMs ? "repush" : "hold";
}

/** 实体状态 = 其转换事件的纯归约（按 eventSeq 写入序取末次 to；无事件即 null，无 unprobed 前置态）。 */
export function reduceState(log: readonly Transitioned[], ref: EntityRef): string | null {
  let latest: Transitioned | undefined;
  for (const e of log) {
    if (e.entityRef.type === ref.type && e.entityRef.key === ref.key) {
      if (!latest || e.eventSeq > latest.eventSeq) latest = e;
    }
  }
  return latest ? latest.to : null;
}
