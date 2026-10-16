/**
 * domain/delivery — 票 07 岛：Delivery 单行根状态机 + Subscription 编址 + Notification 值对象。
 * 零 IO 纯函数层（module spec）：输入数据、输出数据，不碰 store / 时钟 / socket。
 * 与 entity.ts / intent.ts 平行（每票自己的文件，index re-export 由 merge coordinator 统一处理）。
 *
 * 正典：#31 领域模型行（Delivery 状态机 + D2a 终态定义）、CONTEXT.md Delivery/Delivery state 词条、
 * E1/E2 异常路径。Delivery state 是 kernel 定义的固定封闭集簿记态，永不产生事件（只有实体转换发事件）。
 */

/** Delivery state 封闭集（kernel-defined，非 profile）。 */
export const DELIVERY_STATES = [
	"pending",
	"accepted",
	"parked",
	"verified",
	"failed",
	"dead-letter",
] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

const STATE_SET: ReadonlySet<string> = new Set(DELIVERY_STATES);

/** 驱动状态机的领域操作（命名自 #31 事件流/异常路径：WakeAccepted、DeliveryParked、DeliveryVerified、E2 退避、drain）。 */
export const DELIVERY_OPS = [
	"wake-accepted",
	"session-closed",
	"verified",
	"retry-exhausted",
	"delivery-failed",
	"drain-redeliver",
] as const;
export type DeliveryOp = (typeof DELIVERY_OPS)[number];

/**
 * 迁移表 = 合法边全集；不在表内的 (state, op) 格一律非法。
 *
 * - pending→accepted：两段式 ack 段一（wake push 传输确认行，accepted = 在线重试态）
 * - pending→parked：session 已关（E1：不重试不超时，只等 drain）
 * - pending/accepted→dead-letter：重试退避 2s→5min 指数耗尽（E2）
 * - accepted→verified：I9 transcript 点查询命中（发送 ≠ 送达，落盘才是投递）
 * - accepted→failed：非瞬态确定性投递失败（终态出口）
 * - parked→accepted（钉死边）：#31 图的 parked→verified 直连由 drain 重投语义实现为
 *   parked 经 in-flight accepted 两段式 ack 再 verified；不引入第三持久状态。
 * - 终态 verified / failed / dead-letter 无出边；dead-letter 出口仅 reckon 对账 / query 查看 /
 *   24h verified-absence 幂等 re-push 通道，均为通道动作而非状态迁移（D2a）。
 */
export const DELIVERY_TRANSITIONS: ReadonlyArray<{
	from: DeliveryState;
	op: DeliveryOp;
	to: DeliveryState;
}> = [
	{ from: "pending", op: "wake-accepted", to: "accepted" },
	{ from: "pending", op: "session-closed", to: "parked" },
	{ from: "pending", op: "retry-exhausted", to: "dead-letter" },
	{ from: "accepted", op: "verified", to: "verified" },
	{ from: "accepted", op: "retry-exhausted", to: "dead-letter" },
	{ from: "accepted", op: "delivery-failed", to: "failed" },
	{ from: "parked", op: "drain-redeliver", to: "accepted" },
];

export type DeliveryTransition =
	| { ok: true; from: DeliveryState; to: DeliveryState }
	| { ok: false; from: DeliveryState; op: DeliveryOp; reason: string };

function rejectReason(from: DeliveryState, op: DeliveryOp): string {
	if (from === "dead-letter")
		return "dead-letter 无出边（D2a 终态：不再自动重试，不参与 drain；出口仅 reckon 对账 / query 查看 / 24h re-push 通道，非状态迁移）";
	if (from === "verified") return "verified 是终态，无出边";
	if (from === "failed") return "failed 是终态出口，无出边";
	if (from === "parked") return "parked 仅经 drain 回 accepted（不重试不超时）";
	return `非法迁移：${from} 不接受 ${op}`;
}

/** 查一格 (state, op)；未知状态同步拒绝（封闭集执法）。纯函数，kernel 据此写回行状态。 */
export function transitionDelivery(from: DeliveryState, op: DeliveryOp): DeliveryTransition {
	if (!STATE_SET.has(from))
		return { ok: false, from, op, reason: `未知 Delivery state：${String(from)}` };
	const edge = DELIVERY_TRANSITIONS.find((t) => t.from === from && t.op === op);
	if (!edge) return { ok: false, from, op, reason: rejectReason(from, op) };
	return { ok: true, from, to: edge.to };
}

// --- 共享类型（2026-10-12 统一：正典在 types.ts，re-export 保持消费面）---
import type { EntityRef, Verdict } from "./types.ts";
export type { EntityRef, Verdict };

// --- Notification 值对象（#31：notificationId/eventSeq/billboard 视图；一个 notification 扇出多行 Delivery）---

/** evidence >2KB 截断 + evidenceRef 指针（#31 通知条目行）。上限单位 = UTF-8 字节（>2KB 即 >2048 bytes）。 */
export const EVIDENCE_INLINE_LIMIT = 2048;

/** 按 UTF-8 字节截断：回退到字符首字节边界，保证结果重编码 ≤ limit 字节（字符数口径会漏截多字节字符）。 */
function clampToUtf8Bytes(s: string, limit: number): string {
	const buf = Buffer.from(s, "utf8");
	if (buf.length <= limit) return s;
	let end = limit;
	while ((buf[end] & 0xc0) === 0x80) end--; // 回退 UTF-8 续字节（10xxxxxx）至首字节
	return buf.subarray(0, end).toString("utf8");
}

/** 通知条目 billboard：count + 实体 + verdict，无 payload 内联。 */
export interface BillboardView {
	entityRef: EntityRef;
	verdict: Verdict;
	/** 合流进本条通知的事件数（batch 合流由调用方给出，单事件 = 1）。 */
	count: number;
	evidence: string;
	/** 仅截断时存在；= notificationId（evidence op 据此解引用）。 */
	evidenceRef?: string;
}

export function makeBillboard(
	notificationId: string,
	b: { entityRef: EntityRef; verdict: Verdict; evidence: string; count?: number },
): BillboardView {
	const truncated = Buffer.byteLength(b.evidence, "utf8") > EVIDENCE_INLINE_LIMIT;
	return {
		entityRef: b.entityRef,
		verdict: b.verdict,
		count: b.count ?? 1,
		evidence: truncated ? clampToUtf8Bytes(b.evidence, EVIDENCE_INLINE_LIMIT) : b.evidence,
		...(truncated ? { evidenceRef: notificationId } : {}),
	};
}

/** Notification：一次命中事件的推送内容；notificationId 与 Transitioned 事件同事务预分配（I1），是 I9 transcript 点查询键。 */
export interface Notification {
	notificationId: string;
	/** 来源 Transitioned 事件的写入序（eventSeq 全局单调）。 */
	eventSeq: number;
	billboard: BillboardView;
}

// --- Delivery 单行根：DeliveryRow 正典在 types.ts（A1 收敛），DeliveryState 迁移语义归本文件 ---
import type { DeliveryRow } from "./types.ts";
export type { DeliveryRow };

// --- Subscription 聚合（#31：probe 资产 + 意图 opts + 编址 scope/origin/sourceSessionId）---

export type SubscriptionScope = "project" | "user";
export type SubscriptionOrigin = "session" | "auto";

/** Schedule（CONTEXT.md 正典）：模板资产的时间维，agent 不在 subscribe opts 里设置（B1）。 */
export type Schedule =
	| { type: "interval"; every: string }
	| { type: "cron"; expr: string; tz?: string };

/** ProbeSpec：完整描述对一个实体如何评估一个条件；值相等 ⇒ 共享同一 runner（I5）。source 三源（#31 L111：poll | fs-watch | k8s-watch；store ProbeSpecRow.source 同清单）。thresholds 默认 1/1（R2 裁定）。 */
export interface ProbeSpec {
	check: string;
	/** 探测源三选一（#31 L111；k8s-watch 一等构造块已裁定，MVP 实现待票）。 */
	source: "poll" | "fs-watch" | "k8s-watch";
	schedule: Schedule;
	failureThreshold: number;
	successThreshold: number;
}

/** subscribe opts（#31 操作面）：{on, once, flip, template, smoke, sessionId, readyCheck, ttl, failureThreshold?, successThreshold?}；永不含 shell/schedule（模板形态）。 */
export interface SubscriptionOpts {
	/** on 谓词：状态值 / 状态集 / 命名转换（如 digest-changed）。 */
	on?: string | string[];
	once?: boolean;
	flip?: boolean;
	template?: string;
	smoke?: boolean;
	sessionId?: string;
	readyCheck?: string;
	/** 到期自动关闭（I8）。 */
	ttl?: number;
	failureThreshold?: number;
	successThreshold?: number;
}

/**
 * 编址（#31：sourceSessionId 仅 origin=session 时存在）。判别联合在类型层钉死两分支：
 * session → sourceSessionId 精确投递；auto = 隐式 project scope（user-scope auto post-MVP），不携带 sourceSessionId。
 */
export type SubscriptionAddressing =
	| { origin: "session"; scope: SubscriptionScope; sourceSessionId: string }
	| { origin: "auto"; scope: "project" };

export interface Subscription {
	subscriptionId: string;
	entityRef: EntityRef;
	/** probe 资产：模板实例化出的 ProbeSpec。 */
	spec: ProbeSpec;
	opts: SubscriptionOpts;
	addressing: SubscriptionAddressing;
}

export type AddressingValidation =
	| { ok: true; addressing: SubscriptionAddressing }
	| { ok: false; reason: string };

/** 运行时（JSON-RPC 侧数据）编址校验：两分支数据形状的运行时门（类型层已由判别联合钉死）。 */
export function validateAddressing(input: unknown): AddressingValidation {
	if (typeof input !== "object" || input === null)
		return { ok: false, reason: "编址必须是对象" };
	const o = input as Record<string, unknown>;
	if (o.origin === "session") {
		const scope = o.scope;
		if (scope !== "project" && scope !== "user")
			return { ok: false, reason: `origin=session 需 scope ∈ {project, user}，得到 ${String(scope)}` };
		if (typeof o.sourceSessionId !== "string" || o.sourceSessionId === "")
			return { ok: false, reason: "origin=session 需非空 sourceSessionId（编址必须精确到 session）" };
		return {
			ok: true,
			addressing: { origin: "session", scope, sourceSessionId: o.sourceSessionId },
		};
	}
	if (o.origin === "auto") {
		if (o.scope !== "project")
			return { ok: false, reason: "origin=auto 仅支持隐式 project scope（user-scope auto post-MVP）" };
		if ("sourceSessionId" in o)
			return { ok: false, reason: "sourceSessionId 仅 origin=session 时存在" };
		return { ok: true, addressing: { origin: "auto", scope: "project" } };
	}
	return { ok: false, reason: `origin ∈ {session, auto}，得到 ${String(o.origin)}` };
}

/**
 * on 谓词 × 事件匹配（票 24+26 评审 F18）：fanOut 创建 delivery 前逐订阅评估。
 * on 形状 = 状态值 / 状态集（SubscriptionOpts.on），按事件终态 to 判定；缺省（未设）收全部事件。
 * shortcut: 命名转换谓词（如 digest-changed）post-MVP——形状落定前仅支持终态匹配，需用时升级。
 */
export function onMatches(ev: { to: string }, on: string | string[] | undefined): boolean {
	if (on === undefined) return true;
	return Array.isArray(on) ? on.includes(ev.to) : on === ev.to;
}

/** 编址推导的投递目标（#31：session → sourceSessionId 精确；auto → scope 内全部活跃 session，不留 pending 行）。 */
export function deliveryTargets(
	addressing: SubscriptionAddressing,
	activeSessions: ReadonlyArray<{ sessionId: string; scope: SubscriptionScope }>,
): string[] {
	if (addressing.origin === "session") return [addressing.sourceSessionId];
	return activeSessions
		.filter((s) => s.scope === addressing.scope)
		.map((s) => s.sessionId);
}
