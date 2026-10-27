import { describe, expect, it } from "vitest";
import { reduce } from "../seams.ts";
import type { ApplyContext } from "../state/state-reducer.ts";
import type { QuestionnaireState, SideEditorSlot } from "../state/state.ts";
import type { QuestionData } from "../tool/types.ts";

/**
 * C2 side-editor unification (was #132's notesVisible/reasonVisible twin flags).
 * The union type IS the mutual-exclusion guarantee — these tests pin the runtime
 * behavior that previously relied on a dispatch-order convention.
 */
const QUESTIONS: QuestionData[] = [
	{ question: "部署形态选哪种？", header: "Deploy", options: [{ label: "A", description: "选项 A" }, { label: "B", description: "选项 B" }] },
	{ question: "第二个问题？", header: "Q2", options: [{ label: "C", description: "选项 C" }, { label: "D", description: "选项 D" }] },
];

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

function makeCtx(): ApplyContext {
	return { questions: QUESTIONS, itemsByTab: QUESTIONS.map(() => []) };
}

describe("side editor unification (C2)", () => {
	it("opening one slot reports exactly that slot; the single union value closes the other", () => {
		const ctx = makeCtx();
		const opened = reduce(makeState(), { kind: "side_editor_enter", slot: "reason" }, ctx);
		expect(opened.state.activeSideEditor).toBe<SideEditorSlot>("reason");
		const reOpened = reduce(opened.state, { kind: "side_editor_enter", slot: "notes" }, ctx);
		expect(reOpened.state.activeSideEditor).toBe<SideEditorSlot>("notes");
	});

	it("commit clears the slot; the draft mirror is shared but slot state is exclusive", () => {
		const ctx = makeCtx();
		const opened = reduce(makeState(), { kind: "side_editor_enter", slot: "reason" }, ctx);
		const exited = reduce({ ...opened.state, notesDraft: "术语没展开" }, { kind: "side_editor_exit", slot: "reason" }, ctx);
		expect(exited.state.activeSideEditor).toBe<SideEditorSlot>(null);
		expect(exited.state.reasonByTab.get(0)).toBe("术语没展开");
	});

	it("tab switch closes any open side editor (slot-agnostic)", () => {
		const ctx = makeCtx();
		const opened = reduce(makeState(), { kind: "side_editor_enter", slot: "reason" }, ctx);
		const switched = reduce(opened.state, { kind: "tab_switch", nextTab: 1 }, ctx);
		expect(switched.state.activeSideEditor).toBe<SideEditorSlot>(null);
	});
});
