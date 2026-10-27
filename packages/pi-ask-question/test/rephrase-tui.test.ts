import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	buildAnswerSegment,
	buildQuestionnaireResponse,
	MultiSelectView,
	OTHER_LABEL_MULTI,
	otherDisplayLabel,
	RESERVED_LABELS,
	ROW_INTENT_META,
	routeKey,
	SENTINEL_KINDS,
	SENTINEL_LABELS,
	SubmitTabStrategy,
	validateQuestionnaire,
	type ApplyContext,
	type QuestionData,
	type QuestionnaireRuntime,
	type QuestionnaireState,
	type WrappingSelectItem,
	reduce,
} from "../seams.ts";

// Identity theme: renders bare text so assertions match visible content, not ANSI.
const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s } as unknown as Theme;

const MULTI_Q: QuestionData = {
	question: "Which features?",
	header: "Features",
	options: [
		{ label: "Option A", description: "" },
		{ label: "Option B", description: "" },
	],
	multiSelect: true,
};
const SINGLE_Q: QuestionData = {
	question: "Pick one?",
	header: "Pick",
	options: [
		{ label: "Solo", description: "" },
		{ label: "Alt", description: "" },
	],
};
const QUESTIONS = [MULTI_Q, SINGLE_Q];

const REPHRASE_LABEL = "↻ 没说清，重新问";

/** items per tab mirroring `buildItemsForQuestion` + `SENTINEL_KINDS` order (kept local to avoid the config graph). */
function itemsFor(q: QuestionData): WrappingSelectItem[] {
	const items: WrappingSelectItem[] = q.options.map((o) => ({ kind: "option" as const, label: o.label }));
	items.push({ kind: "other" as const, label: otherDisplayLabel(q.multiSelect === true) });
	if (q.multiSelect === true) {
		items.push({ kind: "rephrase" as const, label: REPHRASE_LABEL });
		items.push({ kind: "next" as const, label: "Submit" });
	} else {
		items.push({ kind: "rephrase" as const, label: REPHRASE_LABEL });
	}
	return items;
}

function makeState(overrides: Partial<QuestionnaireState> = {}): QuestionnaireState {
	return {
		currentTab: 0,
		optionIndex: 0,
		inputMode: false,
		activeSideEditor: null,
		answers: new Map(),
		multiSelectChecked: new Set(),
		customDraftsByTab: new Map(),
		notesByTab: new Map(),
		reasonByTab: new Map(),
		rephraseCountByTab: new Map(),
		submitChoiceIndex: 0,
		notesDraft: "",
		collapsed: false,
		suggestIndex: 0,
		...overrides,
	};
}

function makeRuntime(overrides: Partial<QuestionnaireRuntime> = {}): QuestionnaireRuntime {
	return {
		keybindings: {
			// Defaults covering the routes these tests drive: Enter confirms, Esc cancels.
			matches: (data: string, name: string) =>
				(name === "tui.select.confirm" || name === "tui.input.submit") && data === "\r"
					? true
					: name === "tui.select.cancel" && data === "\x1b",
		},
		inputBuffer: "",
		skillNames: [],
		canMoveInputUp: false,
		canMoveInputDown: false,
		questions: QUESTIONS,
		isMulti: true,
		currentItem: undefined,
		items: [],
		collapseKey: "off",
		...overrides,
	};
}

function makeCtx(): ApplyContext {
	return { questions: QUESTIONS, itemsByTab: QUESTIONS.map(itemsFor) };
}

describe("row-intent rephrase sentinel (ticket #132)", () => {
	it("registers the rephrase kind in SENTINEL_KINDS order other → rephrase → next", () => {
		expect(SENTINEL_KINDS).toEqual(["other", "rephrase", "next"]);
		expect(SENTINEL_LABELS.rephrase).toBe(REPHRASE_LABEL);
	});

	it("rephrase meta: reserved, in the main list, never an input/toggle/submit row", () => {
		const meta = ROW_INTENT_META.rephrase;
		expect(meta).toEqual({
			label: REPHRASE_LABEL,
			reserved: true,
			livesInMainList: true,
			numbered: true,
			activatesInputMode: false,
			blocksMultiToggle: true,
			autoSubmitsInMulti: false,
			autoAppendOnSingleSelect: true,
			autoAppendOnMultiSelect: true,
		});
	});

	it("new labels are reserved: authoring an option wearing them is rejected", () => {
		expect(RESERVED_LABELS).toContain(REPHRASE_LABEL);
		expect(RESERVED_LABELS).toContain(OTHER_LABEL_MULTI);
		for (const label of [REPHRASE_LABEL, OTHER_LABEL_MULTI]) {
			const result = validateQuestionnaire({
				context: "a".repeat(40),
				questions: [
					{
						question: "Which?",
						header: "H",
						options: [
							{ label, description: "d" },
							{ label: "B", description: "d" },
						],
					},
				],
			});
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error).toBe("reserved_label");
		}
	});

	it("per-mode other label: single-select keeps the neutral rpiv string, multi spells out merge semantics", () => {
		expect(otherDisplayLabel(false)).toBe("Type something.");
		expect(otherDisplayLabel(true)).toBe(OTHER_LABEL_MULTI);
		expect(OTHER_LABEL_MULTI).toBe("＋ 补充自定义输入（与以上勾选项同时生效）");
	});
});

describe("key-router rephrase wiring (ticket #132)", () => {
	const multiItems = itemsFor(MULTI_Q);

	it("Enter on the rephrase row dispatches rephrase_request with the tab's pending reason", () => {
		const state = makeState({ optionIndex: 3, reasonByTab: new Map([[0, "术语太简写"]]) });
		const action = routeKey("\r", state, makeRuntime({ currentItem: multiItems[3], items: multiItems }));
		expect(action).toEqual({ kind: "rephrase_request", reason: "术语太简写" });
	});

	it("Enter on the rephrase row without a reason passes undefined (no forced editor path)", () => {
		const state = makeState({ optionIndex: 3 });
		const action = routeKey("\r", state, makeRuntime({ currentItem: multiItems[3], items: multiItems }));
		expect(action).toEqual({ kind: "rephrase_request", reason: undefined });
	});

	it("Enter on the rephrase row works in single-select too (was: consumed as an option answer)", () => {
		const singleItems = itemsFor(SINGLE_Q);
		const state = makeState({ currentTab: 1, optionIndex: 3 });
		const action = routeKey("\r", state, makeRuntime({ currentItem: singleItems[3], items: singleItems }));
		expect(action.kind).toBe("rephrase_request");
	});

	it("Space on the rephrase row does not toggle a checkbox (multi)", () => {
		const kb = { matches: (_d: string, _n: string) => false };
		const state = makeState({ optionIndex: 3 });
		const action = routeKey(" ", state, makeRuntime({ keybindings: kb, currentItem: multiItems[3], items: multiItems }));
		expect(action.kind).toBe("ignore");
	});

	it("`n` on the rephrase row opens the reason editor; on an option row it stays the notes key", () => {
		const onRephrase = routeKey("n", makeState({ optionIndex: 3 }), makeRuntime({ currentItem: multiItems[3], items: multiItems }));
		expect(onRephrase).toEqual({ kind: "side_editor_enter", slot: "reason" });
		const onOption = routeKey("n", makeState({ optionIndex: 0 }), makeRuntime({ currentItem: multiItems[0], items: multiItems }));
		expect(onOption).toEqual({ kind: "side_editor_enter", slot: "notes" });
	});

	it("reason-mode routes like notes-mode: Esc/Enter commit, other keys forward to the shared editor", () => {
		const base = makeState({ activeSideEditor: "reason", notesDraft: "partial" });
		expect(routeKey("\x1b", base, makeRuntime())).toEqual({ kind: "side_editor_exit", slot: "reason" });
		expect(routeKey("\r", base, makeRuntime())).toEqual({ kind: "side_editor_exit", slot: "reason" });
		expect(routeKey("x", base, makeRuntime())).toEqual({ kind: "notes_forward", data: "x" });
	});
});

describe("reason editor reducer wiring (ticket #132)", () => {
	it("reason_enter seeds the shared editor draft from the reasonByTab slot; reason_exit commits the trimmed draft", () => {
		const ctx = makeCtx();
		const seeded = makeState({ reasonByTab: new Map([[0, "  选项太窄  "]]) });
		const opened = reduce(seeded, { kind: "side_editor_enter", slot: "reason" }, ctx);
		expect(opened.state.activeSideEditor).toBe("reason");
		expect(opened.state.notesDraft).toBe("  选项太窄  ");
		expect(opened.effects).toContainEqual({ kind: "set_notes_value", value: "  选项太窄  " });
		expect(opened.effects).toContainEqual({ kind: "set_notes_focused", focused: true });

		const exited = reduce({ ...opened.state, notesDraft: "选项太窄" }, { kind: "side_editor_exit", slot: "reason" }, ctx);
		expect(exited.state.activeSideEditor).toBe(null);
		expect(exited.state.reasonByTab.get(0)).toBe("选项太窄");
		expect(exited.state.notesByTab.size).toBe(0); // independent slot — never touches notes
	});

	it("empty commit clears the slot and strips a stale reason mirror from the rephrase answer", () => {
		const ctx = makeCtx();
		const rephrased = reduce(makeState(), { kind: "rephrase_request", reason: "太模糊" }, ctx);
		const cleared = reduce({ ...rephrased.state, currentTab: 0, notesDraft: "" }, { kind: "side_editor_exit", slot: "reason" }, ctx);
		expect(cleared.state.reasonByTab.has(0)).toBe(false);
		const answer = cleared.state.answers.get(0);
		expect(answer?.kind).toBe("rephrase");
		expect("reason" in (answer ?? {})).toBe(false);
	});

	it("a note and a reason coexist on the same tab and reach the envelope in their own segments", () => {
		const ctx = makeCtx();
		let state = reduce(makeState({ notesDraft: "偏好 Postgres 但可谈" }), { kind: "side_editor_exit", slot: "notes" }, ctx).state;
		state = reduce({ ...state, notesDraft: "" }, { kind: "side_editor_enter", slot: "reason" }, ctx).state;
		state = reduce({ ...state, notesDraft: "选项覆盖不全" }, { kind: "side_editor_exit", slot: "reason" }, ctx).state;
		const done = reduce(state, { kind: "rephrase_request", reason: state.reasonByTab.get(0) }, ctx);
		const rephrase = done.state.answers.get(0);
		expect(rephrase).toMatchObject({ kind: "rephrase", reason: "选项覆盖不全", notes: "偏好 Postgres 但可谈" });

		const response = buildQuestionnaireResponse({ answers: [rephrase!], cancelled: false }, {
			context: "总体目标：选数据库。当前进度：候选两个。本批问题解决：部署形态。",
			questions: [MULTI_Q],
		});
		const text = response.content[0]?.type === "text" ? response.content[0].text : "";
		expect(text).toContain(`"${MULTI_Q.question}"="↻ 要求重问（原因：选项覆盖不全）"`);
		expect(text).toContain("user notes: 偏好 Postgres 但可谈");
	});
});

describe("view render: rephrase row and per-mode label (ticket #132)", () => {
	function multiViewWith(optionIndex: number) {
		const view = new MultiSelectView(theme, MULTI_Q);
		view.setProps({
			rows: MULTI_Q.options.map((_, i) => ({ checked: false, active: i === optionIndex })),
			other: { active: optionIndex === MULTI_Q.options.length, checked: false, inputMode: false, inputBuffer: "", inputCursorOffset: undefined },
			rephraseActive: optionIndex === MULTI_Q.options.length + 1,
			nextActive: optionIndex === MULTI_Q.options.length + 2,
			nextLabel: "Submit",
		});
		return view;
	}

	it("multi-select renders the rephrase sentinel row between the custom row and Next", () => {
		const lines = multiViewWith(3).render(80);
		const otherIdx = lines.findIndex((l) => l.includes(OTHER_LABEL_MULTI));
		const rephraseIdx = lines.findIndex((l) => l.includes(REPHRASE_LABEL));
		const nextIdx = lines.findIndex((l) => l.includes("Submit"));
		expect(otherIdx).toBeGreaterThan(-1);
		expect(rephraseIdx).toBeGreaterThan(otherIdx);
		expect(nextIdx).toBeGreaterThan(rephraseIdx);
	});

	it("multi-select custom row spells out the merge semantics; focused row is styled", () => {
		const lines = multiViewWith(3).render(80);
		expect(lines.some((l) => l.includes(OTHER_LABEL_MULTI))).toBe(true);
		expect(lines.some((l) => l.includes(`❯ ${REPHRASE_LABEL}`))).toBe(true);
	});

	it("Submit tab: rephrase entry shows 要求重问 with the reason; coexists with the multi two-line preview", () => {
		const strategy = new SubmitTabStrategy({ theme, questions: [MULTI_Q, SINGLE_Q], submitPicker: undefined, notesInput: {} as never });
		const state = {
			answers: new Map<number, object>([
				[0, { questionIndex: 0, question: MULTI_Q.question, kind: "multi", answer: "draft", selected: ["Option A"] }],
				[1, { questionIndex: 1, question: SINGLE_Q.question, kind: "rephrase", answer: null, reason: "选项太窄", rephraseCount: 1 }],
			]),
			notesByTab: new Map(),
			activeSideEditor: null,
			};
		const lines = strategy.bodyComponent(state as never).render(80);
		expect(lines.some((l) => l.includes("→ 勾选: Option A"))).toBe(true);
		expect(lines.some((l) => l.includes(`＋ 自定义: "draft"`))).toBe(true);
		expect(lines.some((l) => l.includes("→ ↻ 要求重问（原因：选项太窄）"))).toBe(true);
	});

	it("envelope segment keeps the pinned rephrase shape (no formatter drift)", () => {
		expect(
			buildAnswerSegment({ questionIndex: 0, question: "Pick one?", kind: "rephrase", answer: null, reason: "选项太窄" }),
		).toBe('"Pick one?"="↻ 要求重问（原因：选项太窄）".');
	});
});

describe("vendored locales (ticket #132)", () => {
	const localesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "locales");
	const NEW_KEYS = ["sentinel.rephrase", "sentinel.other_multi", "notes.reason_header"];
	const TOUCHED = new Set(["en", "zh"]);

	it("en + zh carry the new labels; the 7 other vendored locales stay untouched (t(key, fallback) covers them)", () => {
		for (const file of ["de", "es", "fr", "pt", "pt-BR", "ru", "uk"].map((c) => `${c}.json`)) {
			const locale = JSON.parse(readFileSync(join(localesDir, file), "utf8")) as Record<string, string>;
			for (const key of NEW_KEYS) expect(locale[key], `${file} must not carry ${key}`).toBeUndefined();
			expect(locale["sentinel.other"], `${file} keeps its own translation`).toBeDefined();
		}
		for (const file of [...TOUCHED].map((c) => `${c}.json`)) {
			const locale = JSON.parse(readFileSync(join(localesDir, file), "utf8")) as Record<string, string>;
			for (const key of NEW_KEYS) expect(locale[key], `${file} must carry ${key}`).toBeTypeOf("string");
		}
	});
});
