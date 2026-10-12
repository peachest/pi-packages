/**
 * domain/types — 三票 provisional 类型的正典统一（2026-10-12，merge coordinator 裁定）。
 *
 * 单一来源：entity.ts / delivery.ts / intent.ts 一律 import 本文件，
 * 本地重复定义删除（P-014：不为现有概念造第二名称）。
 *
 * 裁定记录：
 * - EntityRef = {source, nativeKey} 对象（adopt intent.ts 结构）：source = 源系统判别符
 *   （如 "gitlab:mr"，key generator 归 profile 层——ADR 0002），nativeKey = 前缀编码键
 *   （external/|project/|user/<native-id>）。entity.ts 原 template-literal 版是 nativeKey
 *   的值域描述，parseEntityRef 重定位为 nativeKey 校验器（保留，用于测试与构造边）。
 * - Verdict = "passed" | "failed" | "waiting"（#31 判定三态，agent 可见面一律语义名）。
 * - Transitioned = 8 字段（intent.ts 版）：eventId 是 appendIfMissing 匹配键（I10 幂等基础），
 *   事件清单含它；contentIdentity 为 string | null（发布路径显式 null ≠ undefined）。
 * - TransitionIntent = Transitioned + decisionOrder + payload?（合并 06/08 双必填为可选——
 *   probe 路径的 Intent 无 payload，publish 路径的 Intent 无 decisionOrder 语义？
 *   否：decisionOrder 双轨正典是 kernel 统一消费序，保留必填；payload 可选（probe 路径无）。
 * - 确定性 event id = deterministicEventId(ref, decisionOrder)（intent.ts 版，adopt）：
 *   同 (entityRef, decisionOrder) 恒同 id。entity.ts 的 transitionEventId（内容子集派生）
 *   退役——两者职责重叠，重放场景由 (entityRef, decisionOrder) 从 RunLedger/mutation line 恢复。
 */
export interface EntityRef {
  /** 源系统判别符（gitlab:mr / k8s:pod / fs:path…；profile 层 key generator 的产物面）。字段名 type/keys 沿用票 08 验收形状。 */
  type: string;
  /** 前缀编码键：external/<native> | project/<native> | user/<native>（ADR 0002，daemon 不铸造不解析） */
  key: string;
}

/** ADR 0002 前缀集（EntityRef.nativeKey 的封闭值域）。 */
export const ENTITY_REF_PREFIXES = ["external", "project", "user"] as const;

/** EntityRef.key 前缀校验：`<prefix>/<native-key>` 形状，key 内容原样通过（agent 不铸造不解析）。 */
export function parseEntityRefKey(raw: string): string {
  const slash = raw.indexOf("/");
  const prefix = slash === -1 ? "" : raw.slice(0, slash);
  const key = slash === -1 ? "" : raw.slice(slash + 1);
  if (!(ENTITY_REF_PREFIXES as readonly string[]).includes(prefix) || key === "") {
    throw new Error(
      `invalid nativeKey "${raw}": expected external/<native-key> | project/<native-key> | user/<native-key> — agents never mint or parse keys (ADR 0002)`,
    );
  }
  return raw;
}

/** EntityRef 相等（结构相等；type+key 全对即唯一）。 */
export function sameEntityRef(a: EntityRef, b: EntityRef): boolean {
  return a.type === b.type && a.key === b.key;
}

/** EntityRef 稳定串行化（event id / 槽键 / 日志的规范形态）。 */
export function entityRefKeyOf(ref: EntityRef): string {
  return `${ref.type}:${ref.key}`;
}

/** 判定三态：agent 可见面一律语义名，退出码不外泄（0=passed / 2=failed / 其他=waiting）。 */
export type Verdict = "passed" | "failed" | "waiting";

/**
 * Transitioned — 单一事件族（#31：只有实体转换产生事件；自转换同族 (state, contentIdentity)）。
 * 字段清单正典（票 08 定死）：eventId 匹配键 + 内容七字段（eventSeq/entityRef/from/to/
 * contentIdentity/occurredAt/evidenceRef）。
 */
export interface Transitioned {
  /** 去重匹配键（appendIfMissing）：deterministicEventId(ref, decisionOrder) */
  eventId: string;
  /** 写入序：全局单调（R1 双轨之写入轨），kernel/store 分配 */
  eventSeq: number;
  entityRef: EntityRef;
  /** 首转换为 null（无 unprobed 前置态） */
  from: string | null;
  to: string;
  /** 自转换身份对现值（ADR 0003）；可省略（probe 路径无身份字段），null=显式无身份 */
  contentIdentity?: string | null;
  /** ISO 8601；调用方注入，domain 不碰时钟 */
  occurredAt: string;
  /** probe 路径 evidence 指针；publish 路径可缺省 */
  evidenceRef?: string;
}

/** Transitioned 内容比较域（eventId 为匹配键不参与；sameEventContent 消费）。 */
export const TRANSITIONED_CONTENT_FIELDS = [
  "eventSeq",
  "entityRef",
  "from",
  "to",
  "contentIdentity",
  "occurredAt",
  "evidenceRef",
] as const;

/** Transitioned 完整字段清单（含匹配键 eventId；事件形状 pinning 用——票 08 语义）。 */
export const TRANSITIONED_FIELDS = ["eventId", ...TRANSITIONED_CONTENT_FIELDS] as const;

/**
 * TransitionIntent — 决策序载体（R1 双轨：decisionOrder 与 eventSeq 互不替代、各自单调）。
 * decisionOrder 必填（kernel 统一消费序正典）；payload 可选（probe 路径无 payload；
 * publish 路径的 billboard 快照由消费侧从 Entity 写回，不经事件——#31 L75）。
 */
export interface TransitionIntent extends Omit<Transitioned, "eventId"> {
  eventId: string;
  decisionOrder: number;
  payload?: unknown;
}

/** 确定性 event id：同 (entityRef, decisionOrder) 恒同 id——异内容因此可被检出为 corruption。 */
export function deterministicEventId(ref: EntityRef, decisionOrder: number): string {
  return `evt:${entityRefKeyOf(ref)}#${decisionOrder}`;
}
