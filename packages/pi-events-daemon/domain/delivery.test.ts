import { describe, it, expect } from "vitest";
import {
	DELIVERY_STATES,
	DELIVERY_OPS,
	transitionDelivery,
	type DeliveryState,
	type DeliveryOp,
} from "./delivery.ts";

// 期望表独立编码自 #31 正文（Delivery 状态机句 + D2a）与票 07 断言 2/3，不读实现表。
const EXPECTED_LEGAL: Array<[DeliveryState, DeliveryOp, DeliveryState]> = [
	// 两段式 ack 段一：wake push 传输确认（accepted = 在线重试态）
	["pending", "wake-accepted", "accepted"],
	// E1：目标 session 已关 → parked（不重试不超时，等 SESSION_START drain）
	["pending", "session-closed", "parked"],
	// E2：push 重试退避（2s→5min 指数）耗尽 → dead-letter
	["pending", "retry-exhausted", "dead-letter"],
	// 两段式 ack 段二：I9 transcript 点查询命中（ack-by-verification）
	["accepted", "verified", "verified"],
	// E2：accepted 在线重推退避耗尽 → dead-letter
	["accepted", "retry-exhausted", "dead-letter"],
	// 非瞬态确定性投递失败 → failed（终态出口）
	["accepted", "delivery-failed", "failed"],
	// 票 07 断言 2 钉死边：drain 重投 = parked 行经 in-flight accepted 两段式 ack（不引入第三持久状态）
	["parked", "drain-redeliver", "accepted"],
];

const ALL_STATES: DeliveryState[] = [
	"pending",
	"accepted",
	"parked",
	"verified",
	"failed",
	"dead-letter",
];

const ALL_OPS: DeliveryOp[] = [
	"wake-accepted",
	"session-closed",
	"verified",
	"retry-exhausted",
	"delivery-failed",
	"drain-redeliver",
];

describe("Delivery 状态机全路径表驱动（票 07 断言 1）", () => {
	it("状态封闭集恰为 6 态（不引入第三持久状态）", () => {
		expect([...DELIVERY_STATES].sort()).toEqual([...ALL_STATES].sort());
	});

	it("合法格逐格断言", () => {
		for (const [from, op, to] of EXPECTED_LEGAL) {
			const r = transitionDelivery(from, op);
			expect(r, `${from} --${op}--> ${to}`).toEqual({ ok: true, from, to });
		}
	});

	it("非法格逐格断言（全 6×6 网格减 7 个合法格，其余一律拒绝）", () => {
		const legal = new Set(EXPECTED_LEGAL.map(([f, o]) => `${f}|${o}`));
		for (const from of ALL_STATES) {
			for (const op of ALL_OPS) {
				if (legal.has(`${from}|${op}`)) continue;
				const r = transitionDelivery(from, op);
				expect(r.ok, `${from} must reject ${op}`).toBe(false);
			}
		}
	});

	it("未知状态同步拒绝（封闭集执法）", () => {
		const r = transitionDelivery("unprobed" as DeliveryState, "verified");
		expect(r.ok).toBe(false);
	});
});

describe("parked→accepted 钉死边与 drain 两段式（票 07 断言 2）", () => {
	it("#31 图的 parked→verified 直连不存在为边：经 in-flight accepted 两段式实现", () => {
		// 直连格非法——表的 parked 出边只有 drain-redeliver
		expect(transitionDelivery("parked", "verified").ok).toBe(false);
		// 两段式：parked --drain 重投--> accepted（既有持久态，非新状态）--I9--> verified
		const step1 = transitionDelivery("parked", "drain-redeliver");
		expect(step1).toEqual({ ok: true, from: "parked", to: "accepted" });
		const step2 = transitionDelivery("accepted", "verified");
		expect(step2).toEqual({ ok: true, from: "accepted", to: "verified" });
	});
});

describe("终态语义（票 07 断言 3）", () => {
	it("dead-letter 无出边（D2a：不再自动重试，不参与 drain）", () => {
		for (const op of ALL_OPS) {
			const r = transitionDelivery("dead-letter", op);
			expect(r.ok, `dead-letter must reject ${op}`).toBe(false);
			if (!r.ok) expect(r.reason).toContain("D2a");
		}
	});

	it("parked 仅经 drain 回 accepted（不重试不超时：无其他出边）", () => {
		for (const op of ALL_OPS) {
			const r = transitionDelivery("parked", op);
			if (op === "drain-redeliver") {
				expect(r).toEqual({ ok: true, from: "parked", to: "accepted" });
			} else {
				expect(r.ok, `parked must reject ${op}`).toBe(false);
				if (!r.ok) expect(r.reason).toContain("drain");
			}
		}
	});

	it("verified / failed 同为终态，无出边", () => {
		for (const op of ALL_OPS) {
			expect(transitionDelivery("verified", op).ok, `verified must reject ${op}`).toBe(false);
			expect(transitionDelivery("failed", op).ok, `failed must reject ${op}`).toBe(false);
		}
	});
});
