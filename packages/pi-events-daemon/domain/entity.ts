/**
 * domain/entity — Entity 富聚合的身份与转换决策（票 06；零 IO 纯函数，测试零 fake）。
 *
 * 共享类型归属（domain 三票协调约定）：EntityRef / Entity / Transitioned / TransitionIntent
 * 定义在 entity.ts 的先到者拥有（本票），票 07/08 import 本文件；
 * domain/index.ts 的 re-export 由 merger 统一处理（本票不改 index.ts）。
 */

// --- EntityRef：源系统原生标识 + 封闭前缀集（ADR 0002：agent 不铸造不解析，key generator 归 profile 层）---
export const ENTITY_REF_PREFIXES = ["external", "project", "user"] as const;
export type EntityRef = `${(typeof ENTITY_REF_PREFIXES)[number]}/${string}`;

/**
 * 边界校验：只认 `<prefix>/<native-key>` 形状，key 内容原样通过——
 * URL/路径的理解与规范化归 profile key generator，daemon 侧零身份铸造（ADR 0002）。
 */
export function parseEntityRef(raw: string): EntityRef {
	const slash = raw.indexOf("/");
	const prefix = slash === -1 ? "" : raw.slice(0, slash);
	const key = slash === -1 ? "" : raw.slice(slash + 1);
	if (!(ENTITY_REF_PREFIXES as readonly string[]).includes(prefix) || key === "") {
		throw new Error(
			`invalid EntityRef "${raw}": expected external/<native-key> | project/<native-key> | user/<native-key> — agents never mint or parse keys (ADR 0002)`,
		);
	}
	return raw as EntityRef;
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

/**
 * Transitioned — 单一事件族（#31 事件模型：字段清单定死，票 08/09 依赖；只有实体转换产生事件）。
 * 自转换同族：无 per-state 事件类型，(state, contentIdentity) 是真实对（ADR 0003）。
 */
export type Transitioned = {
	/** 写入序：全局单调（R1 双轨之写入轨），kernel/store 分配 */
	eventSeq: number;
	entityRef: EntityRef;
	/** 首转换为 null（无 unprobed 前置态） */
	from: string | null;
	to: string;
	contentIdentity: string | null;
	/** ISO 8601；调用方注入，domain 不碰时钟 */
	occurredAt: string;
	/** probe 路径的 evidence 指针；publish 路径无 evidence，可缺省 */
	evidenceRef?: string;
};

/**
 * TransitionIntent — 决策序载体（R1 双轨：决策序与写入序互不替代、各自单调）。
 * 预分配确定性 event id（内容子集派生、不含 payload——消费侧 appendIfMissing 同 id 跳过、
 * 异内容 = corruption）；eventSeq 同为预分配值，满足 #31 publish 响应 {eventSeq, from, to}。
 */
export type TransitionIntent = Transitioned & {
	eventId: string;
	payload: unknown;
};

export type PublishCommand = { to: string; contentIdentity?: string; payload?: unknown };

export type PublishContext = {
	/** I-01：封闭集是 profile 注册表注入的值（数据），domain 不 import profiles */
	states: ReadonlySet<string>;
	/** ISO 8601，调用方注入 */
	occurredAt: string;
	/** eventSeq 预分配值（全局单调计数归 kernel/store） */
	eventSeq: number;
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
		eventId: transitionEventId(entity.ref, entity.state, cmd.to, contentIdentity, ctx.occurredAt),
		eventSeq: ctx.eventSeq,
		entityRef: entity.ref,
		from: entity.state,
		to: cmd.to,
		contentIdentity,
		occurredAt: ctx.occurredAt,
		payload: cmd.payload ?? null,
	};
}

/** 预分配确定性 event id：意图内容子集（不含 payload）拼接，崩溃重放可重推导同一 id。 */
function transitionEventId(
	ref: EntityRef,
	from: string | null,
	to: string,
	contentIdentity: string | null,
	occurredAt: string,
): string {
	return `transition:${JSON.stringify([ref, from, to, contentIdentity, occurredAt])}`;
}
