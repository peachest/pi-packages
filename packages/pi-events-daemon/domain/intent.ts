/**
 * domain/intent.ts — ticket 08: TransitionIntent 双轨（R1）+ appendIfMissing + 封闭集执法.
 *
 * 零 IO 纯函数：输入数据、输出数据，不碰 store、不碰时钟、不碰 socket。
 * 依赖方向：本文件不 import 任何其他模块（eda-leaf-zero-dep-domain）。
 *
 * types: provisional, merge coordinator will unify
 * —— EntityRef / TransitionIntent / Transitioned / Verdict 的正典归属是 domain/entity.ts
 *    （票 06 先到者拥有）；本分支尚无该文件，故在此定义最小版本，合并时以 entity.ts 为准。
 *
 * 术语正典：packages/prototype-events-daemon/CONTEXT.md；契约：#31 spec（spec31-body.md）。
 */

// --- provisional shared types（entity.ts 到位后由 merge coordinator 统一）---

/** 实体标识：type + 源系统原生 key（前缀 external/ project/ user/，agent 不铸造不解析——ADR 0002）。 */
export interface EntityRef {
  type: string;
  key: string;
}

/** 判定三态：agent 可见面一律语义名，退出码不外泄（0=passed / 2=failed / 其他=waiting）。 */
export type Verdict = "passed" | "failed" | "waiting";

/**
 * TransitionIntent —— 决策产物（publish/转换校验的输出，票 06）。
 * 双轨（R1）：decisionOrder = 决策序（mutation line，"哪个转换先决定"）；
 * eventSeq = 写入序（落盘序，"哪条先落盘"）。两轨互不替代、各自单调，
 * eventSeq 由单写者顺序预分配在 Intent 上（#31 publish 响应 {eventSeq, from, to} 的来源）。
 */
export interface TransitionIntent {
  /** 确定性预分配 event id = f(entityRef, decisionOrder)，崩溃重放可复得（appendIfMissing 匹配键）。 */
  eventId: string;
  decisionOrder: number;
  eventSeq: number;
  entityRef: EntityRef;
  from: string | null;
  to: string;
  contentIdentity?: string;
  occurredAt: string;
  evidenceRef?: string;
}

/**
 * Transitioned —— 单一事件族（#31 事件模型，无 per-state 事件类型；自转换同族）。
 * 字段清单正典（票 08 定死，票 09 corruption "异内容"判定依赖）：eventSeq / EntityRef /
 * from / to / contentIdentity / occurredAt / evidenceRef；eventId 为去重匹配键。
 */
export interface Transitioned {
  eventId: string;
  eventSeq: number;
  entityRef: EntityRef;
  from: string | null;
  to: string;
  contentIdentity?: string;
  occurredAt: string;
  evidenceRef?: string;
}

/** Transitioned 字段清单（含匹配键 eventId）；sameEventContent 只比较正典内容七字段。 */
export const TRANSITIONED_FIELDS = [
  "eventId",
  "eventSeq",
  "entityRef",
  "from",
  "to",
  "contentIdentity",
  "occurredAt",
  "evidenceRef",
] as const;

/** appendIfMissing 的内容比较域：#31 事件模型清单（不含匹配键 eventId）。 */
const CONTENT_FIELDS = ["eventSeq", "entityRef", "from", "to", "contentIdentity", "occurredAt", "evidenceRef"] as const;

// --- R1 双轨 ---

/** 双轨游标：各自单调，恢复时各从自己的真相源重算（决策序 ← mutation line；eventSeq ← 事件流）。 */
export interface IntentSequences {
  decisionOrder: number;
  eventSeq: number;
}

export const FIRST_SEQUENCE: IntentSequences = { decisionOrder: 0, eventSeq: 0 };

/** 确定性 event id：同 (entityRef, decisionOrder) 恒同 id——异内容因此可被检出为 corruption。 */
export function deterministicEventId(ref: EntityRef, decisionOrder: number): string {
  return `evt:${ref.type}:${ref.key}#${decisionOrder}`;
}

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
  return CONTENT_FIELDS.every((f) => {
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
