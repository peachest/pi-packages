/**
 * domain/entity — Entity 富聚合的身份与转换决策（票 06；零 IO 纯函数，测试零 fake）。
 *
 * 共享类型正典（2026-10-12 统一）：EntityRef / Transitioned / TransitionIntent / Verdict
 * 定义在 types.ts，本文件 re-export 保持消费方 import 面不变；Entity 聚合仍归本文件。
 */
import {
	type EntityRef,
	type TransitionIntent,
	deterministicEventId,
	parseEntityRefKey,
	ENTITY_REF_PREFIXES,
} from "./types.ts";
export { ENTITY_REF_PREFIXES, parseEntityRefKey };
export type { EntityRef, Verdict, Transitioned, TransitionIntent } from "./types.ts";

/**
 * 从 raw 字符串构造 EntityRef：只认 `<prefix>/<native-key>` 形状做 key 校验，
 * key 内容原样通过——URL/路径的理解与规范化归 profile key generator，daemon 侧零身份铸造（ADR 0002）。
 * type 判别符不由 raw 推导（raw 只有前缀信息），调用方显式给出。
 */
export function makeEntityRef(type: string, rawKey: string): EntityRef {
	return { type, key: parseEntityRefKey(rawKey) };
}

// --- Entity 富聚合（#31 领域模型：决策只需当前快照；状态 = 转换事件的纯归约，归约缓存 post-MVP）---
export type Entity = {
	ref: EntityRef;
	/** 注册时记录（#31 L115：同 EntityRef 换 profile 拒绝——kernel 注册路径/票 24 消费，domain 不判冲突） */
	profileId: string;
	/** 封闭集成员；首 verdict/转换前为 null——无 unprobed 前置态 */
	state: string | null;
	/** 自转换身份对 (state, contentIdentity) 的现值（ADR 0003）；实体无身份字段时为 null */
	contentIdentity: string | null;
	/** 当前状态属性；随 intent 提交、由消费侧写回聚合，不进 Transitioned 事件（事件是转换，payload 是快照） */
	payload: unknown;
	/** 实体父子树，key opaque（key generator 注册时写，agent 不设）；导航关系无级联生命周期 */
	parent: EntityRef | null;
	/** ephemeral 终态归档；retired 后 publish 拒绝、不复活（#31：ad-hoc terminal → retired） */
	retired: boolean;
};

export type PublishCommand = { to: string; contentIdentity?: string; payload?: unknown };

export type PublishContext = {
	/** I-01：封闭集是 profile 注册表注入的值（数据），domain 不 import profiles */
	states: ReadonlySet<string>;
	/** ISO 8601，调用方注入 */
	occurredAt: string;
	/** eventSeq 预分配值（全局单调计数归 kernel/store） */
	eventSeq: number;
	/** decisionOrder 预分配值（R1 双轨之决策轨，kernel/mutation line 分配——event id 的确定性来源） */
	decisionOrder: number;
};

/**
 * publish 契约（#31 op 表）：`publish(entityRef, {to, contentIdentity?, payload?})` → `{eventSeq, from, to}`。
 * SetState = 同族别名，差异仅在文档表述：首次设置 = 注册 + 首转换，from=null 合法。
 *
 * 同步拒绝：retired（不复活）；to 不在封闭集（明确错误，非 waiting）。
 * (state, contentIdentity) 对未变 → 无转换无事件（edge-trigger，ADR 0003），返回 null；
 * 否则输出含预分配确定性 event id 的 TransitionIntent。纯函数：不 mutate 输入。
 */
export function publish(entity: Entity, cmd: PublishCommand, ctx: PublishContext): TransitionIntent | null {
	if (entity.retired) {
		throw new Error(`publish rejected: entity ${entity.ref} is retired — retired entities never revive`);
	}
	if (!ctx.states.has(cmd.to)) {
		throw new Error(
			`publish rejected: unknown state "${cmd.to}" for ${entity.ref} — closed state set: [${[...ctx.states].sort().join(", ")}]`,
		);
	}
	const contentIdentity = cmd.contentIdentity ?? null;
	if (entity.state === cmd.to && contentIdentity === entity.contentIdentity) return null;
	return {
		eventId: deterministicEventId(entity.ref, ctx.decisionOrder),
		decisionOrder: ctx.decisionOrder,
		eventSeq: ctx.eventSeq,
		entityRef: entity.ref,
		from: entity.state,
		to: cmd.to,
		contentIdentity,
		occurredAt: ctx.occurredAt,
		payload: cmd.payload ?? null,
	};
}



// --- ephemeral retired 到期清理（#31 L114：terminal → retired（7d 清理）；判定纯函数）---

/** retired 残留保留窗（ms）：retired 后 7d 清理（US-33 one-shot facts leave no permanent residue）。 */
export const RETIRED_CLEANUP_MS = 7 * 24 * 60 * 60 * 1000;

/** retired 到期判定（> 严格过期；retiredSince = 终态转换事件 occurredAt 的 ms，调用方注入零时钟）。 */
export function retiredCleanupDue(retiredSinceMs: number, now: number): boolean {
	return now - retiredSinceMs > RETIRED_CLEANUP_MS;
}
