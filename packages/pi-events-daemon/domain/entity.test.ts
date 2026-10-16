import { describe, it, expect } from "vitest";
import {
	retiredCleanupDue,
	parseEntityRefKey,
	publish,
	type Entity,
	type PublishCommand,
	type PublishContext,
	type EntityRef,
} from "./entity.ts";

const REF: EntityRef = { type: "gitlab:mr", key: "project/https://gitlab.example/group/pipe/-/merge_requests/42" };

const entity = (over: Partial<Entity> = {}): Entity => ({
	ref: REF,
	profileId: "gitlab-mr",
	state: null,
	contentIdentity: null,
	payload: null,
	parent: null,
	retired: false,
	...over,
});

const ctx = (over: Partial<PublishContext> = {}): PublishContext => ({
	states: new Set(["draft", "ready", "merged", "closed"]),
	occurredAt: "2026-10-12T08:00:00.000Z",
	eventSeq: 7,
	decisionOrder: 11,
	...over,
});

describe("EntityRef key 前缀规范（ADR 0002：agent 不铸造不解析）", () => {
	it("接受三个正典前缀，key 原样通过——不规范化、不铸造（identity 解析归 profile key generator）", () => {
		const keys = [
			"external/docker://registry.example/img@sha256:aa92",
			"project/https://gitlab.example/group/pipe/-/merge_requests/42",
			"user//mnt/disk1/hyx/projects/pi-mypackage",
		];
		for (const key of keys) expect(parseEntityRefKey(key)).toBe(key);
	});

	it("拒绝未知前缀、无前缀、空 key，错误信息列封闭前缀集", () => {
		for (const bad of ["gitlab/mr!1", "mr-24248", "external/", ""]) {
			expect(() => parseEntityRefKey(bad)).toThrow(/EntityRef key/);
		}
		expect(() => parseEntityRefKey("gitlab/mr!1")).toThrow(/project/);
	});
});

describe("publish 全矩阵（合法首转换/自转换/非法 to/retired）", () => {
	const legal: Array<{
		name: string;
		entity: Entity;
		cmd: PublishCommand;
		want: { from: string | null; to: string; contentIdentity: string | null };
	}> = [
		{
			name: "首转换：state=null → to，from=null 合法（SetState 首次设置 = 注册 + 首转换）",
			entity: entity(),
			cmd: { to: "ready" },
			want: { from: null, to: "ready", contentIdentity: null },
		},
		{
			name: "状态转换 ready → merged",
			entity: entity({ state: "ready" }),
			cmd: { to: "merged" },
			want: { from: "ready", to: "merged", contentIdentity: null },
		},
		{
			name: "自转换：state 不变、contentIdentity 变——(state, contentIdentity) 是真实对（ADR 0003）",
			entity: entity({ state: "ready", contentIdentity: "sha256:aaa" }),
			cmd: { to: "ready", contentIdentity: "sha256:bbb" },
			want: { from: "ready", to: "ready", contentIdentity: "sha256:bbb" },
		},
	];
	for (const c of legal) {
		it(c.name, () => {
			const intent = publish(c.entity, c.cmd, ctx());
			expect(intent).not.toBeNull();
			expect(intent!.from).toBe(c.want.from);
			expect(intent!.to).toBe(c.want.to);
			expect(intent!.contentIdentity).toBe(c.want.contentIdentity);
			expect(intent!.entityRef).toBe(REF);
			expect(intent!.eventSeq).toBe(7);
			expect(intent!.occurredAt).toBe("2026-10-12T08:00:00.000Z");
		});
	}

	it("payload 随 intent 携带（聚合快照由消费侧写回，不进 Transitioned 事件族）", () => {
		const intent = publish(entity(), { to: "ready", payload: { headSha: "abc" } }, ctx());
		expect(intent!.payload).toEqual({ headSha: "abc" });
	});

	it("edge-trigger：(state, contentIdentity) 对未变 → 无转换无事件（null）", () => {
		const same = entity({ state: "ready", contentIdentity: "sha256:aaa" });
		expect(publish(same, { to: "ready", contentIdentity: "sha256:aaa" }, ctx())).toBeNull();
		expect(publish(entity({ state: "ready" }), { to: "ready" }, ctx())).toBeNull();
	});

	it("纯函数：不 mutate 输入聚合", () => {
		const e = entity({ state: "ready" });
		publish(e, { to: "merged" }, ctx());
		expect(e.state).toBe("ready");
	});

	it("非法 to：同步拒绝（明确错误，非 waiting），错误列封闭集可用状态", () => {
		try {
			publish(entity({ state: "ready" }), { to: "readyy" }, ctx());
			expect.unreachable("publish must throw synchronously on unknown state");
		} catch (err) {
			const msg = (err as Error).message;
			expect(msg).toContain("readyy");
			for (const s of ["draft", "ready", "merged", "closed"]) expect(msg).toContain(s);
		}
	});

	it("I-01：封闭集是传入的注册表值——同一 to 换一组 states 即拒（domain 无内置状态字面量）", () => {
		expect(() =>
			publish(entity({ state: "green" }), { to: "ready" }, ctx({ states: new Set(["green", "red"]) })),
		).toThrow(/ready/);
	});

	it("retired 拒绝 publish（不复活），即使 to 在封闭集内", () => {
		expect(() => publish(entity({ retired: true }), { to: "ready" }, ctx())).toThrow(/retired/);
	});
});

describe("TransitionIntent：预分配确定性 event id + 事件族字段（票 08/09 共享形状）", () => {
	it("#31 publish 响应形状 {eventSeq, from, to} 可从 intent 解构", () => {
		const { eventSeq, from, to } = publish(entity({ state: "ready" }), { to: "merged" }, ctx())!;
		expect({ eventSeq, from, to }).toEqual({ eventSeq: 7, from: "ready", to: "merged" });
	});

	it("intent 形状定死：Transitioned 事件族字段（eventSeq/EntityRef/from/to/contentIdentity/occurredAt；evidenceRef 走 probe 路径）+ eventId + payload", () => {
		const intent = publish(entity({ state: "ready" }), { to: "merged" }, ctx())!;
		// 2026-10-12 统一：decisionOrder 进 Intent（R1 双轨正典，event id 的确定性来源）
		expect(Object.keys(intent).sort()).toEqual([
			"contentIdentity",
			"decisionOrder",
			"entityRef",
			"eventId",
			"eventSeq",
			"from",
			"occurredAt",
			"payload",
			"to",
		]);
	});

	it("确定性：同 (entityRef, decisionOrder) → 同 event id（崩溃重放幂等的基础）；decisionOrder 变 → id 变", () => {
		// 2026-10-12 统一裁定 adopt intent.ts 方案：id = f(entityRef, decisionOrder)，occurredAt 不参与。
		// 理由：appendIfMissing 的幂等重放要求同 decisionOrder 恒同 id——内容派生方案在重放时
		// occurredAt 变化会导致 id 漂移，幂等失效（票 08 的 R1 双轨语义）。
		const a = publish(entity({ state: "ready" }), { to: "merged" }, ctx())!;
		const b = publish(entity({ state: "ready" }), { to: "merged" }, ctx())!;
		const c = publish(entity({ state: "ready" }), { to: "merged" }, ctx({ decisionOrder: 12 }))!;
		expect(b.eventId).toBe(a.eventId);
		expect(c.eventId).not.toBe(a.eventId);
	});

	it("event id 不含 payload：同转换异 payload → 同 id 异内容（消费侧 appendIfMissing 的 corruption 可判定）", () => {
		const a = publish(entity({ state: "ready" }), { to: "merged", payload: { x: 1 } }, ctx())!;
		const b = publish(entity({ state: "ready" }), { to: "merged", payload: { x: 2 } }, ctx())!;
		expect(b.eventId).toBe(a.eventId);
		expect(b.payload).toEqual({ x: 2 });
	});

	it("eventSeq 来自预分配（ctx 传入），domain 不计数", () => {
		const intent = publish(entity(), { to: "ready" }, ctx({ eventSeq: 41 }))!;
		expect(intent.eventSeq).toBe(41);
	});
});

describe("票 28 — retired 7d 到期判定", () => {
	const DAY = 24 * 60 * 60 * 1000;
	it("恰 7d 未到期（> 严格），7d+1ms 到期", () => {
		const now = 100 * DAY;
		expect(retiredCleanupDue(now - 7 * DAY, now)).toBe(false);
		expect(retiredCleanupDue(now - 7 * DAY - 1, now)).toBe(true);
	});
});
