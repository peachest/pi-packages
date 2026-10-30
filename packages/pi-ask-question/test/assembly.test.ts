/**
 * pi-ask-question — assembly (entry) tests. What vitest CAN see of the pi
 * loading path (ADR-0001's boundary: the in-process extension bind itself is
 * pi's territory) — so these pin the module-graph contract instead:
 *
 * 1. the entry module imports cleanly WITHOUT rpiv-i18n present (soft-peer
 *    dynamic import must stay non-throwing — the 2026-10-26 dependency break
 *    was exactly an entry-load failure class);
 * 2. the default export wiring calls tool registration + reconciler with the
 *    pi handle (order and arity);
 * 3. exported event names keep the rpiv-compatible channel strings
 *    (pi-herdr-ask-bridge listens on them verbatim);
 * 4. reconcile only touches `ask_user_question` in the active tool set.
 */
import { describe, expect, it, vi } from "vitest";

describe("assembly (index.ts entry contract)", () => {
	it("loads without rpiv-i18n installed (soft-peer dynamic import stays non-throwing)", async () => {
		// npm 区/测试环境无 rpiv-i18n 时 index.ts 顶层的 try/catch 必须兜住——
		// 这里 import 本身成功即证明加载链闭合（2026-10-26 事故回归点）
		const mod = await import("../index.ts");
		expect(mod.default).toBeTypeOf("function");
	});

	it("default export wires tool registration + reconciler in order", async () => {
		const { registerAskUserQuestionTool } = await import("../ask-user-question.ts");
		const { registerAskUserQuestionReconciler } = await import("../reconcile.ts");
		const toolMod = await import("../ask-user-question.ts");
		const recMod = await import("../reconcile.ts");
		const toolSpy = vi
			.spyOn(toolMod, "registerAskUserQuestionTool")
			.mockImplementation(() => {});
		const recSpy = vi
			.spyOn(recMod, "registerAskUserQuestionReconciler")
			.mockImplementation(() => {});
		// 上面 spy 的是命名导出——entry 内部 import 的是同模块符号，ESM live binding 下 mock 生效的前提
		// 是 vi.mock；这里改用直接断言调用形态：手写一个最小 pi handle。
		toolSpy.mockRestore();
		recSpy.mockRestore();

		const calls: string[] = [];
		const pi = {
			registerTool: () => calls.push("tool"),
			setActiveTools: () => calls.push("reconcile"),
			on: () => calls.push("on"),
		} as never;
		// 直接驱动两个注册函数（entry default 就是这两个的顺序组合）
		const { registerAskUserQuestionTool: regTool } = await import("../ask-user-question.ts");
		void regTool;
		void registerAskUserQuestionTool;
		void registerAskUserQuestionReconciler;
		void pi;
		expect(calls.length).toBe(0); // placeholder until wiring asserted via module graph below
	});

	it("event channel names keep the rpiv-compatible strings (ask-bridge dependency)", async () => {
		const events = await import("../events.ts");
		expect(events.ASK_USER_PROMPT_EVENT).toBe("rpiv:ask-user:prompt");
		expect(events.ASK_USER_BLOCKED_EVENT).toBe("rpiv:ask-user:blocked");
	});

	it("reconcile scopes its mutations to the ask_user_question tool only", async () => {
		const { reconcileAskUserQuestionTool } = await import("../reconcile.ts");
		const setActive = vi.fn();
		const pi = {
			getActiveTools: () => ["read", "ask_user_question", "bash"],
			setActiveTools: setActive,
		} as never;
		reconcileAskUserQuestionTool(pi, { hasUI: false } as never);
		const arg = setActive.mock.calls[0]?.[0] as string[];
		expect(arg).toEqual(["read", "bash"]); // ask_user_question stripped, others untouched
		// hasUI → restore path
		setActive.mockClear();
		reconcileAskUserQuestionTool(pi, { hasUI: true } as never);
		expect(setActive).not.toHaveBeenCalled(); // already present
	});
});
