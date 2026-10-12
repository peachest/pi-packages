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
import { intentToEvent, planTransition, requireStateIn } from "../domain/intent.ts";
import type { IntentSequences } from "../domain/intent.ts";
import type { EventRow, Store, TxView } from "../store/index.ts";

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

  constructor(
    private readonly store: Store,
    /** I-01：封闭状态集（数据注入）。校验 to 用；from=null 恒合法。 */
    private readonly states: ReadonlySet<string>,
    /** decisionOrder 起点双轨之决策轨：mutation line 尾位点（重放不得重新编号）。 */
    decisionOrder: number,
  ) {
    this.sequences = { decisionOrder, eventSeq: recoverEventSeq(store) };
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
