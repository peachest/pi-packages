import { describe, expect, it } from "vitest";
import { routeKey, type QuestionnaireAction } from "../state/key-router.ts";
import type { QuestionnaireRuntime, QuestionnaireState } from "../state/state.ts";
import { skillSuggestFor } from "../tool/skill-expansion.ts";

const QUESTIONS = [
	{ question: "q1", header: "h", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] },
] as QuestionnaireRuntime["questions"];

const KB = { matches: (data: string, name: string) => (name === "tui.select.confirm" && data === "\r") || (name === "tui.select.up" && data === "\x1b[A") || (name === "tui.select.down" && data === "\x1b[B") };

function makeState(overrides: Partial<QuestionnaireState> = {}): QuestionnaireState {
	return {
		activeSideEditor: null,
		currentTab: 0,
		optionIndex: QUESTIONS[0]!.options.length,
		inputMode: true,
		answers: new Map(),
		multiSelectChecked: new Set(),
		customDraftsByTab: new Map(),
		notesByTab: new Map(),
		reasonByTab: new Map(),
		rephraseCountByTab: new Map(),
		submitChoiceIndex: 0,
		suggestIndex: 0,
		notesDraft: "",
		collapsed: false,
		...overrides,
	};
}

function makeRuntime(inputBuffer: string, skillNames: string[], overrides: Partial<QuestionnaireRuntime> = {}): QuestionnaireRuntime {
	return {
		keybindings: KB,
		inputBuffer,
		skillNames,
		canMoveInputUp: false,
		canMoveInputDown: false,
		questions: QUESTIONS,
		isMulti: false,
		currentItem: undefined,
		items: [],
		collapseKey: "ctrl+]",
		...overrides,
	};
}

describe("skillSuggestFor", () => {
	it("matches the text after the slash as a substring, case-insensitive", () => {
		expect(skillSuggestFor("/way", ["skill:wayfinder", "skill:code-review"], 0)?.candidates).toEqual(["skill:wayfinder"]);
		expect(skillSuggestFor("/SK", ["skill:wayfinder"], 0)?.candidates).toEqual(["skill:wayfinder"]);
		expect(skillSuggestFor("/review", ["skill:code-review"], 0)?.candidates).toEqual(["skill:code-review"]);
	});

	it("is closed for non-fragments and empty matches", () => {
		expect(skillSuggestFor("/skill:x y", ["skill:x"], 0)).toBeNull(); // has whitespace
		expect(skillSuggestFor("plain", ["skill:x"], 0)).toBeNull();
		expect(skillSuggestFor("/nope", ["skill:x"], 0)).toBeNull();
		expect(skillSuggestFor("/", [], 0)).toBeNull();
	});

	it("clamps the selection into range", () => {
		expect(skillSuggestFor("/s", ["skill:a", "skill:b"], 99)?.selected).toBe(1);
	});
});

describe("routeKey inputMode suggestion interception", () => {
	const runtime = makeRuntime("/way", ["skill:wayfinder", "skill:code-review"]);

	it("Tab completes the highlighted candidate with a trailing space", () => {
		const action = routeKey("\t", makeState(), runtime) as Extract<QuestionnaireAction, { kind: "input_replace" }>;
		expect(action.kind).toBe("input_replace");
		expect(action.value).toBe("/skill:wayfinder ");
	});

	it("Tab completes the moved highlight after Down", () => {
		const both = makeRuntime("/sk", ["skill:wayfinder", "skill:code-review"]);
		const down = routeKey("\x1b[B", makeState(), both) as Extract<QuestionnaireAction, { kind: "suggest_nav" }>;
		expect(down).toEqual({ kind: "suggest_nav", nextIndex: 1 });
		const tab = routeKey("\t", makeState({ suggestIndex: 1 }), both) as Extract<QuestionnaireAction, { kind: "input_replace" }>;
		expect(tab.value).toBe("/skill:code-review ");
	});

	it("Up clamps at the top of the list", () => {
		expect(routeKey("\x1b[A", makeState({ suggestIndex: 0 }), runtime)).toEqual({ kind: "suggest_nav", nextIndex: 0 });
	});

	it("falls through to confirm when the buffer is not a bare fragment", () => {
		const typed = makeRuntime("/skill:wayfinder 选 B", ["skill:wayfinder"]);
		const action = routeKey("\r", makeState(), typed);
		expect(action.kind).toBe("confirm");
	});

	it("falls through to row navigation when no skill matches", () => {
		const noMatch = makeRuntime("/nope", ["skill:wayfinder"]);
		const action = routeKey("\x1b[A", makeState({ optionIndex: 1 }), noMatch);
		expect(action.kind).toBe("nav");
	});
});
