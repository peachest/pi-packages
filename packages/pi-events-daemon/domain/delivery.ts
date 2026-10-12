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
