import { describe, expect, it } from "vitest";
import {
	buildQuestionnaireResponse,
	buildRephraseInstruction,
	DECLINE_MESSAGE,
	reduce,
	REPHRASE_CAP,
	REPHRASE_CAP_MESSAGE,
	type ApplyContext,
	type QuestionAnswer,
	type QuestionData,
	type QuestionParams,
	type QuestionnaireState,
} from "../seams.ts";

const QUESTIONS: QuestionData[] = [
	{
		question: "Which database?",
		header: "DB",
		options: [
			{ label: "Postgres", description: "relational" },
			{ label: "SQLite", description: "embedded" },
		],
	},
	{
		question: "Which language?",
		header: "Lang",
		options: [
			{ label: "TypeScript", description: "typed" },
			{ label: "Python", description: "dynamic" },
		],
	},
	{
		question: "Deploy where?",
		header: "Deploy",
		options: [
			{ label: "Cloud", description: "managed" },
			{ label: "Bare metal", description: "self-hosted" },
		],
	},
];

/**
 * Required by the T2 schema (context gate); on a branch without T2 the extra property
 * is tolerated through the assertion. One shape, green in both merge orders.
 */
const CONTEXT = "总体目标：为迁移挑选数据库。当前进度：候选已筛到两个。本批问题解决：部署形态的取舍。";
const ENVELOPE_PARAMS = { context: CONTEXT, questions: QUESTIONS } as QuestionParams;

function makeState(overrides: Partial<QuestionnaireState> = {}): QuestionnaireState {
	return {
		currentTab: 0,
		optionIndex: 0,
		inputMode: false,
		notesVisible: false,
		answers: new Map(),
		multiSelectChecked: new Set(),
		customDraftsByTab: new Map(),
		notesByTab: new Map(),
		reasonByTab: new Map(),
		rephraseCountByTab: new Map(),
		submitChoiceIndex: 0,
		notesDraft: "",
		reasonVisible: false,
		collapsed: false,
		...overrides,
	};
}

function makeCtx(questions: readonly QuestionData[] = QUESTIONS): ApplyContext {
	return { questions, itemsByTab: questions.map(() => []) };
}

function confirmTab0(state: QuestionnaireState, ctx: ApplyContext): QuestionnaireState {
	const out = reduce(state, {
		kind: "confirm",
		answer: { questionIndex: 0, question: QUESTIONS[0]!.question, kind: "option", answer: "Postgres" },
		autoAdvanceTab: 1,
	}, ctx);
	return out.state;
}

describe("rephrase state layer (ticket #131)", () => {
	it("marks the current tab as rephrase, keeps other tabs' answers intact, increments the per-tab counter, and jumps focus to the next question", () => {
		const ctx = makeCtx();
		const answered = confirmTab0(makeState(), ctx);
		const out = reduce(answered, { kind: "rephrase_request", reason: " 术语太简写" }, ctx);

		expect(out.state.currentTab).toBe(2); // focus moved 1 -> 2, untouched tab 0 answer
		const rephrase = out.state.answers.get(1);
		expect(rephrase).toEqual({
			questionIndex: 1,
			question: "Which language?",
			kind: "rephrase",
			answer: null,
			reason: "术语太简写",
			rephraseCount: 1,
		});
		expect(out.state.answers.get(0)).toEqual(answered.answers.get(0)); // 他题 answers 原样保留
		expect(out.state.rephraseCountByTab.get(1)).toBe(1);
		expect(out.state.reasonByTab.get(1)).toBe("术语太简写");
		expect(out.effects.every((e) => e.kind !== "done")).toBe(true); // dialog continues
	});

	it("accepts a second reason-less rephrase (no forced editor path) and drops the stale reason slot", () => {
		const ctx = makeCtx();
		const first = reduce(makeState(), { kind: "rephrase_request", reason: "太模糊" }, ctx);
		// navigate back to the rephrased tab, then rephrase again without a reason
		const back = reduce(first.state, { kind: "tab_switch", nextTab: 0 }, ctx);
		const second = reduce(back.state, { kind: "rephrase_request" }, ctx);

		expect(second.state.currentTab).toBe(1); // focus jumped 0 -> 1, dialog continues
		expect(second.state.rephraseCountByTab.get(0)).toBe(2);
		const answer = second.state.answers.get(0);
		expect(answer?.kind).toBe("rephrase");
		expect(answer?.rephraseCount).toBe(2);
		expect("reason" in (answer as QuestionAnswer)).toBe(false); // reason optional, absent when unprovided
		expect(second.state.reasonByTab.has(0)).toBe(false);
		expect(second.effects.every((e) => e.kind !== "done")).toBe(true);
	});

	it(`caps at rephrase ${REPHRASE_CAP}: cancelled result carries the other answers and the dedicated message, not DECLINE_MESSAGE`, () => {
		const ctx = makeCtx();
		const answered = confirmTab0(makeState(), ctx); // tab 0 answered, focus on tab 1
		let state = answered;
		for (let i = 0; i < REPHRASE_CAP; i++) {
			const out = reduce(state, { kind: "rephrase_request", reason: `理由 ${i + 1}` }, ctx);
			state = out.state;
			if (i < REPHRASE_CAP - 1) {
				// navigate back to the rephrased tab for the next attempt
				state = reduce(state, { kind: "tab_switch", nextTab: 1 }, ctx).state;
			} else {
				const done = out.effects.find((e) => e.kind === "done");
				expect(done).toBeDefined();
				if (done?.kind !== "done") return;
				const result = done.result;
				expect(result.cancelled).toBe(true);
				expect(result.cancelReason).toBe("rephrase_cap");
				expect(result.answers).toEqual([answered.answers.get(0)]); // capped tab ships no answer
				const response = buildQuestionnaireResponse(result, ENVELOPE_PARAMS);
				expect(response.details).toMatchObject({ cancelled: true, cancelReason: "rephrase_cap" });
				expect(response.details.answers).toHaveLength(1); // 其余 answers 只在 details
				expect(response.content[0]?.type).toBe("text");
				const text = response.content[0]?.type === "text" ? response.content[0].text : "";
				expect(text).not.toBe(DECLINE_MESSAGE);
				expect(text).toBe(REPHRASE_CAP_MESSAGE);
				expect(text).toContain("三次");
			}
		}
	});

	it("keeps the plain Esc cancel pinned to DECLINE_MESSAGE with no cancelReason", () => {
		const ctx = makeCtx();
		const out = reduce(makeState(), { kind: "cancel" }, ctx);
		const done = out.effects.find((e) => e.kind === "done");
		expect(done).toBeDefined();
		if (done?.kind !== "done") return;
		expect(done.result.cancelled).toBe(true);
		expect("cancelReason" in done.result).toBe(false);
		const response = buildQuestionnaireResponse(done.result, ENVELOPE_PARAMS);
		expect(response.content[0]?.type === "text" && response.content[0].text).toBe(DECLINE_MESSAGE);
	});

	it("renders the rephrase envelope segment with question text, reason, and the re-ask instruction; rephrase never declines", () => {
		const option: QuestionAnswer = {
			questionIndex: 0,
			question: "Which database?",
			kind: "option",
			answer: "Postgres",
		};
		const rephrase: QuestionAnswer = {
			questionIndex: 1,
			question: "Which language?",
			kind: "rephrase",
			answer: null,
			reason: "术语太简写",
			rephraseCount: 2,
		};
		const response = buildQuestionnaireResponse(
			{ answers: [option, rephrase], cancelled: false },
			ENVELOPE_PARAMS,
		);
		const text = response.content[0]?.type === "text" ? response.content[0].text : "";
		expect(text).toContain('"Which database?"="Postgres"');
		expect(text).toContain('"Which language?"="↻ 要求重问（原因：术语太简写）"');
		expect(text).toContain(
			'用户对问题 "Which language?" 不满意（原因：术语太简写）。请在下一轮更新 context 进度（已重问 2 次）后用 ask_user 重新问这一题，展开术语并补全选项；其余已答答案保持有效。不得跳过该决策。',
		);
		expect(text).not.toBe(DECLINE_MESSAGE);

		// reason-less pin + count fallback
		expect(buildRephraseInstruction({ questionIndex: 0, question: "Q?", kind: "rephrase", answer: null })).toBe(
			'用户对问题 "Q?" 不满意。请在下一轮更新 context 进度（已重问 1 次）后用 ask_user 重新问这一题，展开术语并补全选项；其余已答答案保持有效。不得跳过该决策。',
		);

		// rephrase-only submit is still an answered envelope (never a decline)
		const rephraseOnly = buildQuestionnaireResponse(
			{ answers: [{ questionIndex: 0, question: "Which database?", kind: "rephrase", answer: null, rephraseCount: 1 }], cancelled: false },
			ENVELOPE_PARAMS,
		);
		const onlyText = rephraseOnly.content[0]?.type === "text" ? rephraseOnly.content[0].text : "";
		expect(onlyText.startsWith("User has answered your questions:")).toBe(true);
		expect(onlyText).not.toBe(DECLINE_MESSAGE);
	});

	it("keeps notes and reason in independent slots on the same tab — neither overwrites the other", () => {
		const ctx = makeCtx();
		const seeded = makeState({ notesDraft: "偏好 Postgres 但可谈" });
		const noted = reduce(seeded, { kind: "notes_exit" }, ctx);
		expect(noted.state.notesByTab.get(0)).toBe("偏好 Postgres 但可谈");

		const out = reduce(noted.state, { kind: "rephrase_request", reason: "选项覆盖不全" }, ctx);
		// slots coexist
		expect(out.state.notesByTab.get(0)).toBe("偏好 Postgres 但可谈");
		expect(out.state.reasonByTab.get(0)).toBe("选项覆盖不全");
		// and the rephrase answer mirrors both without collision
		const answer = out.state.answers.get(0);
		expect(answer?.kind).toBe("rephrase");
		expect(answer?.reason).toBe("选项覆盖不全");
		expect(answer?.notes).toBe("偏好 Postgres 但可谈");
	});

	it("stays on the last question when rephrasing it (no next tab), per the existing doneFor semantics", () => {
		const lastTab = QUESTIONS.length - 1;
		const ctx = makeCtx();
		const out = reduce(makeState({ currentTab: lastTab }), { kind: "rephrase_request", reason: "再问一次" }, ctx);
		expect(out.state.currentTab).toBe(lastTab);
		expect(out.state.rephraseCountByTab.get(lastTab)).toBe(1);
		expect(out.effects.every((e) => e.kind !== "done")).toBe(true);
	});
});
