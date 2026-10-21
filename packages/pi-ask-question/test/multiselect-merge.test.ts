import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	buildAnswerSegment,
	formatAnswerScalar,
	MultiSelectView,
	NO_INPUT_PLACEHOLDER,
	SubmitTabStrategy,
} from "../seams.ts";

// Identity theme: renders bare text so assertions match visible content, not ANSI.
const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s } as unknown as Theme;

const MULTI_Q = {
	question: "Which features?",
	header: "Features",
	options: [
		{ label: "Option A", description: "" },
		{ label: "Option B", description: "" },
		{ label: "Option C", description: "" },
	],
	multiSelect: true,
};
const SINGLE_Q = {
	question: "Pick one?",
	header: "Pick",
	options: [
		{ label: "Solo", description: "" },
		{ label: "Alt", description: "" },
	],
};

describe("formatAnswerScalar multi branch (merge semantics made explicit)", () => {
	const base = { questionIndex: 0, question: "Which features?" };

	it("selected + custom → 勾选 list + custom suffix, identical across variants", () => {
		const a = { ...base, kind: "multi" as const, answer: "draft", selected: ["A", "B"] };
		expect(formatAnswerScalar(a, "summary")).toBe(`勾选: A, B ＋ 自定义: "draft"`);
		expect(formatAnswerScalar(a, "envelope")).toBe(`勾选: A, B ＋ 自定义: "draft"`);
	});

	it("selected only → 勾选 list, no custom suffix", () => {
		const a = { ...base, kind: "multi" as const, answer: null, selected: ["A", "B"] };
		expect(formatAnswerScalar(a, "summary")).toBe("勾选: A, B");
		expect(formatAnswerScalar(a, "envelope")).toBe("勾选: A, B");
	});

	it("custom only → placeholder checked half + custom suffix", () => {
		const a = { ...base, kind: "multi" as const, answer: "draft", selected: [] };
		expect(formatAnswerScalar(a, "summary")).toBe(`勾选: ${NO_INPUT_PLACEHOLDER} ＋ 自定义: "draft"`);
		expect(formatAnswerScalar(a, "envelope")).toBe(`勾选: ${NO_INPUT_PLACEHOLDER} ＋ 自定义: "draft"`);
	});

	it("all empty → NO_INPUT_PLACEHOLDER (unchanged semantics)", () => {
		const a = { ...base, kind: "multi" as const, answer: null, selected: [] };
		expect(formatAnswerScalar(a, "summary")).toBe(NO_INPUT_PLACEHOLDER);
		expect(formatAnswerScalar(a, "envelope")).toBe(NO_INPUT_PLACEHOLDER);
	});
});

describe("envelope segment shape (rpiv pin, multi updated)", () => {
	it("multi segment pins the 勾选/自定义 shape", () => {
		const a = { questionIndex: 0, question: "Which features?", kind: "multi" as const, answer: "draft", selected: ["A", "B"] };
		expect(buildAnswerSegment(a)).toBe('"Which features?"="勾选: A, B ＋ 自定义: "draft"".');
	});

	it("option segment keeps the rpiv single-line shape", () => {
		const a = { questionIndex: 0, question: "Pick one?", kind: "option" as const, answer: "Solo" };
		expect(buildAnswerSegment(a)).toBe('"Pick one?"="Solo".');
	});
});

describe("MultiSelectView live merge echo", () => {
	function viewWith(rows: boolean[], other: Partial<{ active: boolean; inputMode: boolean; inputBuffer: string }>) {
		const view = new MultiSelectView(theme, MULTI_Q);
		view.setProps({
			rows: rows.map((checked) => ({ checked, active: false })),
			other: {
				active: other.active ?? false,
				checked: (other.inputBuffer ?? "").length > 0,
				inputMode: other.inputMode ?? false,
				inputBuffer: other.inputBuffer ?? "",
				inputCursorOffset: undefined,
			},
			rephraseActive: false,
			nextActive: false,
			nextLabel: "Submit",
		});
		return view;
	}

	it("non-empty custom input shows the merged echo below the input row", () => {
		const view = viewWith([true, true, false], { inputBuffer: "draft" });
		const lines = view.render(80);
		const echoIdx = lines.findIndex((l) => l.includes("＋ 自定义:"));
		expect(echoIdx).toBeGreaterThan(-1);
		expect(lines[echoIdx]).toContain(`[✔ Option A] [✔ Option B] ＋ 自定义: "draft"`);
		const inputIdx = lines.findIndex((l) => l.includes("draft"));
		expect(echoIdx).toBeGreaterThan(inputIdx);
	});

	it("echo reflects checkbox changes immediately (setProps invalidates the layout cache)", () => {
		const view = viewWith([true, false, false], { inputBuffer: "draft" });
		expect(view.render(80).some((l) => l.includes("[✔ Option A] ＋ 自定义:"))).toBe(true);

		view.setProps({
			rows: [
				{ checked: false, active: false },
				{ checked: false, active: false },
				{ checked: false, active: false },
			],
			other: {
				active: false,
				checked: true,
				inputMode: false,
				inputBuffer: "draft",
				inputCursorOffset: undefined,
			},
			rephraseActive: false,
			nextActive: false,
			nextLabel: "Submit",
		});
		const lines = view.render(80);
		expect(lines.some((l) => l.includes("[✔ Option A]"))).toBe(false);
		expect(lines.some((l) => l.includes(`＋ 自定义: "draft"`))).toBe(true);
	});

	it("empty custom input shows no echo line", () => {
		const view = viewWith([true, false, false], { inputBuffer: "" });
		expect(view.render(80).some((l) => l.includes("＋ 自定义:"))).toBe(false);
	});

	it("echo persists in inline-input mode (below the cursor line)", () => {
		const view = viewWith([true, false, false], { active: true, inputMode: true, inputBuffer: "draft" });
		const lines = view.render(80);
		const echoIdx = lines.findIndex((l) => l.includes("＋ 自定义:"));
		expect(echoIdx).toBeGreaterThan(0);
		expect(lines[echoIdx]).toContain(`[✔ Option A] ＋ 自定义: "draft"`);
	});
});

describe("SubmitTabStrategy multi two-line preview", () => {
	function submitLines(answers: Array<[number, object]>): string[] {
		const strategy = new SubmitTabStrategy({
			theme,
			questions: [MULTI_Q, SINGLE_Q],
			submitPicker: undefined,
			notesInput: {} as never,
		});
		const state = { answers: new Map(answers), notesByTab: new Map(), notesVisible: false };
		return strategy.bodyComponent(state as never).render(80);
	}

	it("multi with custom → two lines: 勾选 + ＋ 自定义 (coexistence note)", () => {
		const lines = submitLines([
			[0, { questionIndex: 0, question: "Which features?", kind: "multi", answer: "draft", selected: ["Option A", "Option B"] }],
		]);
		expect(lines.some((l) => l.includes("→ 勾选: Option A, Option B"))).toBe(true);
		expect(lines.some((l) => l.includes(`＋ 自定义: "draft"（与勾选项同时生效）`))).toBe(true);
	});

	it("multi without custom → single 勾选 line", () => {
		const lines = submitLines([
			[0, { questionIndex: 0, question: "Which features?", kind: "multi", answer: null, selected: ["Option A", "Option B"] }],
		]);
		expect(lines.some((l) => l.includes("→ 勾选: Option A, Option B"))).toBe(true);
		expect(lines.some((l) => l.includes("自定义"))).toBe(false);
	});

	it("multi with empty selection → placeholder checked half", () => {
		const lines = submitLines([
			[0, { questionIndex: 0, question: "Which features?", kind: "multi", answer: "draft", selected: [] }],
		]);
		expect(lines.some((l) => l.includes(`→ 勾选: ${NO_INPUT_PLACEHOLDER}`))).toBe(true);
		expect(lines.some((l) => l.includes(`＋ 自定义: "draft"`))).toBe(true);
	});

	it("single-select rendering unchanged (arrow + scalar, no 勾选 prefix)", () => {
		const lines = submitLines([
			[1, { questionIndex: 1, question: "Pick one?", kind: "option", answer: "Solo" }],
		]);
		expect(lines.some((l) => l.includes("→ Solo"))).toBe(true);
		expect(lines.some((l) => l.includes("勾选"))).toBe(false);
	});
});
