import { describe, it, expect } from "vitest";
import {
	DELIVERY_STATES,
	DELIVERY_OPS,
	transitionDelivery,
	EVIDENCE_INLINE_LIMIT,
	validateAddressing,
	deliveryTargets,
	makeBillboard,
	type DeliveryState,
	type DeliveryOp,
	type Subscription,
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

describe("Subscription origin 两分支数据形状（票 07 断言 4）", () => {
	it("origin=session → sourceSessionId 精确：有且仅有该 session，不依赖活跃清单", () => {
		const a = validateAddressing({ origin: "session", scope: "project", sourceSessionId: "sess-A" });
		if (!a.ok || a.addressing.origin !== "session")
			throw new Error("session 编址应通过校验且落在 session 分支");
		expect(a.addressing.sourceSessionId).toBe("sess-A");
		expect(deliveryTargets(a.addressing, [])).toEqual(["sess-A"]);
		expect(deliveryTargets(a.addressing, [{ sessionId: "other", scope: "project" }])).toEqual(["sess-A"]);
		// sourceSessionId 缺失 / 空 → 拒绝（编址必须精确到 session）
		expect(validateAddressing({ origin: "session", scope: "project" }).ok).toBe(false);
		expect(validateAddressing({ origin: "session", scope: "project", sourceSessionId: "" }).ok).toBe(false);
	});

	it("origin=auto → scope 活跃：project scope 内全部活跃 session，不留 pending 行；sourceSessionId 字段不存在", () => {
		const a = validateAddressing({ origin: "auto", scope: "project" });
		expect(a.ok).toBe(true);
		if (a.ok) {
			expect(a.addressing).toEqual({ origin: "auto", scope: "project" });
			expect("sourceSessionId" in a.addressing).toBe(false);
			const active = [
				{ sessionId: "p1", scope: "project" as const },
				{ sessionId: "u1", scope: "user" as const },
				{ sessionId: "p2", scope: "project" as const },
			];
			expect(deliveryTargets(a.addressing, active)).toEqual(["p1", "p2"]);
			expect(deliveryTargets(a.addressing, [])).toEqual([]);
		}
	});

	it("user-scope auto = post-MVP → 拒绝；auto 携带 sourceSessionId → 拒绝（仅 origin=session 时存在）", () => {
		expect(validateAddressing({ origin: "auto", scope: "user" }).ok).toBe(false);
		expect(
			validateAddressing({ origin: "auto", scope: "project", sourceSessionId: "sess-A" }).ok,
		).toBe(false);
		expect(validateAddressing({ origin: "cron" }).ok).toBe(false);
	});
});

describe("Notification 值对象（billboard 视图）", () => {
	it("evidence ≤2KB 内联无指针；>2KB 截断 + evidenceRef 指针（= notificationId）", () => {
		expect(EVIDENCE_INLINE_LIMIT).toBe(2048);
		const small = makeBillboard("n:1", {
			entityRef: { type: "gitlab:mr", key: "external/https://gitlab.example/api/v4/projects/1/merge_requests/42" },
			verdict: "passed",
			evidence: "ok",
		});
		expect(small).toEqual({
			entityRef: { type: "gitlab:mr", key: "external/https://gitlab.example/api/v4/projects/1/merge_requests/42" },
			verdict: "passed",
			count: 1,
			evidence: "ok",
		});
		const big = makeBillboard("n:2", {
			entityRef: { type: "gitlab:mr", key: "external/https://x" },
			verdict: "failed",
			evidence: "x".repeat(EVIDENCE_INLINE_LIMIT + 1),
		});
		expect(big.evidence.length).toBe(EVIDENCE_INLINE_LIMIT);
		expect(big.evidenceRef).toBe("n:2");
	});

	it("2KB 按 UTF-8 字节计（#31 >2KB 口径）：多字节字符按字节数截断，恰好 2048 字节不截断", () => {
		const ref = { type: "gitlab:mr", key: "external/https://x" } as const;
		// 1024 个字符 = 3072 字节 > 2048；字符数口径会漏截
		const multibyte = "你".repeat(1024);
		const bb = makeBillboard("n:3", { entityRef: ref, verdict: "failed", evidence: multibyte });
		expect(Buffer.byteLength(bb.evidence, "utf8")).toBeLessThanOrEqual(2048);
		expect(bb.evidenceRef).toBe("n:3");
		// 682×3 + 2 = 2048 字节整 → 不截断
		const exact = "你".repeat(682) + "xx";
		const ok = makeBillboard("n:4", { entityRef: ref, verdict: "passed", evidence: exact });
		expect(ok.evidence).toBe(exact);
		expect(ok.evidenceRef).toBeUndefined();
	});

	it("Subscription 聚合形状：probe 资产 + opts + 编址（tsc 形状回归）", () => {
		const sub: Subscription = {
			subscriptionId: "sub-1",
			entityRef: { type: "gitlab:mr", key: "external/https://gitlab.example/api/v4/projects/1/merge_requests/42" },
			spec: {
				check: "glab api projects/1/merge_requests/42",
				schedule: { type: "interval", every: "60s" },
				failureThreshold: 1,
				successThreshold: 1,
			},
			opts: { on: "merged", once: true },
			addressing: { origin: "session", scope: "project", sourceSessionId: "sess-A" },
		};
		expect(sub.addressing.origin).toBe("session");
	});
});
