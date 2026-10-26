import type { QuestionAnswer, QuestionData, QuestionnaireResult } from "../tool/types.ts";
import type { WrappingSelectItem } from "../view/components/wrapping-select.ts";
import type { QuestionnaireAction } from "./key-router.ts";
import { ROW_INTENT_META } from "./row-intent.ts";
import type { QuestionnaireState } from "./state.ts";

/** Session-lifetime constants. No live-component reads — peripheral values live on canonical state. */
export interface ApplyContext {
	questions: readonly QuestionData[];
	itemsByTab: ReadonlyArray<readonly WrappingSelectItem[]>;
}

/**
 * Declarative side-effects emitted by `reduce`. The runtime executes them after
 * committing the new state, then asks the props-adapter to re-project. Closed set —
 * adding an effect requires updating both the union AND the runtime's `runEffect` switch
 * (compiler-enforced exhaustive). No string-keyed escape hatch.
 */
export type Effect =
	| { kind: "set_input_buffer"; value: string }
	| { kind: "clear_input_buffer" }
	| { kind: "open_input_editor"; value: string }
	| { kind: "set_notes_value"; value: string }
	| { kind: "set_notes_focused"; focused: boolean }
	| { kind: "forward_notes_keystroke"; data: string }
	/**
	 * Tell the session to hide or show its underlying overlay. Emitted by the
	 * `toggle_collapsed` action so the runtime can call `OverlayHandle.setHidden(...)`,
	 * which lets other overlay-aware consumers (e.g. `pi-station`) see the questionnaire
	 * as truly hidden and resume normal chat scroll while the user reads the transcript
	 * behind the modal.
	 */
	| { kind: "set_overlay_hidden"; hidden: boolean }
	| { kind: "done"; result: QuestionnaireResult };

export interface ApplyResult {
	state: QuestionnaireState;
	effects: readonly Effect[];
}

function orderedAnswers(state: QuestionnaireState, questions: readonly QuestionData[]): QuestionAnswer[] {
	const out: QuestionAnswer[] = [];
	for (let i = 0; i < questions.length; i++) {
		const a = state.answers.get(i);
		if (a) out.push(a);
	}
	return out;
}

function syncMultiSelectFromAnswers(
	answers: ReadonlyMap<number, QuestionAnswer>,
	questions: readonly QuestionData[],
	tab: number,
): ReadonlySet<number> {
	const q = questions[tab];
	if (!q?.multiSelect) return new Set();
	const saved = answers.get(tab);
	const labels = saved?.selected ?? [];
	const indices = new Set<number>();
	for (let i = 0; i < q.options.length; i++) {
		if (labels.includes(q.options[i]!.label)) indices.add(i);
	}
	return indices;
}

function selectedLabels(state: QuestionnaireState, question: QuestionData): string[] {
	const selected: string[] = [];
	for (let i = 0; i < question.options.length; i++) {
		if (state.multiSelectChecked.has(i)) selected.push(question.options[i]!.label);
	}
	return selected;
}

/**
 * Answer fields shared by every hand-built QuestionAnswer: identity (tab,
 * question text) plus the conditional `notes` tail (absent when empty, so
 * note-free results stay byte-identical). Callers spread this then add their
 * kind-specific fields.
 */
function answerBase(
	state: QuestionnaireState,
	tab: number,
	question: QuestionData,
): { questionIndex: number; question: string } {
	const pendingNotes = state.notesByTab.get(tab);
	return {
		questionIndex: tab,
		question: question.question,
		...(pendingNotes && pendingNotes.length > 0 ? { notes: pendingNotes } : {}),
	};
}

function persistMultiSelectAnswer(state: QuestionnaireState, ctx: ApplyContext): ReadonlyMap<number, QuestionAnswer> {
	const q = ctx.questions[state.currentTab];
	if (!q?.multiSelect) return state.answers;
	const selected = selectedLabels(state, q);
	const custom = customDraftValueFor(state, state.currentTab);
	const hasCustom = custom.trim().length > 0;
	const out = new Map(state.answers);
	if (selected.length === 0 && !hasCustom) {
		out.delete(state.currentTab);
		return out;
	}
	out.set(state.currentTab, {
		...answerBase(state, state.currentTab, q),
		kind: "multi",
		answer: hasCustom ? custom : null,
		selected,
	});
	return out;
}

/**
 * Note text to seed the editor/draft with for a tab. The in-flight side-band store
 * (`notesByTab`) is authoritative — before an option is confirmed the note lives ONLY
 * there; `answer.notes` is a mirror written on exit/confirm.
 */
function notesValueFor(state: QuestionnaireState, tab: number): string {
	return state.notesByTab.get(tab) ?? state.answers.get(tab)?.notes ?? "";
}

function customDraftValueFor(state: QuestionnaireState, tab: number): string {
	const draft = state.customDraftsByTab.get(tab);
	if (draft !== undefined) return draft;
	const answer = state.answers.get(tab);
	if (answer?.kind !== "custom" && answer?.kind !== "multi") return "";
	return typeof answer.answer === "string" ? answer.answer : "";
}

function setCustomDraft(state: QuestionnaireState, tab: number, value: string): ReadonlyMap<number, string> {
	const drafts = new Map(state.customDraftsByTab);
	drafts.set(tab, value);
	return drafts;
}

function withoutCustomDraft(state: QuestionnaireState, tab: number): ReadonlyMap<number, string> {
	if (!state.customDraftsByTab.has(tab)) return state.customDraftsByTab;
	const drafts = new Map(state.customDraftsByTab);
	drafts.delete(tab);
	return drafts;
}

function switchTabResult(state: QuestionnaireState, nextTab: number, ctx: ApplyContext): ApplyResult {
	const notesValue = notesValueFor(state, nextTab);
	const transitioned: QuestionnaireState = {
		...state,
		currentTab: nextTab,
		optionIndex: 0,
		inputMode: false,
		activeSideEditor: null,
		submitChoiceIndex: 0,
		multiSelectChecked: syncMultiSelectFromAnswers(state.answers, ctx.questions, nextTab),
		notesDraft: notesValue,
	};
	return {
		state: transitioned,
		effects: [
			{ kind: "set_notes_focused", focused: false },
			{ kind: "set_notes_value", value: notesValue },
			{ kind: "set_input_buffer", value: customDraftValueFor(state, nextTab) },
		],
	};
}

function doneFor(
	state: QuestionnaireState,
	ctx: ApplyContext,
	cancelled: boolean,
	cancelReason?: "rephrase_cap",
): ApplyResult {
	// Global note lift: the Submit-tab note lives at the `questions.length` pseudo-index
	// in `notesByTab` — question tabs only occupy 0..questions.length-1, so this can never
	// cross-contaminate a per-question note. Attached regardless of `cancelled` (the
	// reducer is truth; the envelope owns decline presentation), with cancel/submit/confirm
	// sharing this single lift. Conditional spread keeps note-free results byte-identical.
	const globalNote = state.notesByTab.get(ctx.questions.length);
	const result: QuestionnaireResult = {
		answers: orderedAnswers(state, ctx.questions),
		cancelled,
		...(globalNote && globalNote.length > 0 ? { globalNote } : {}),
		...(cancelReason ? { cancelReason } : {}),
	};
	return { state, effects: [{ kind: "done", result }] };
}

/**
 * Per-kind handler signature: action payload narrows to the matching union member
 * via `Extract`, so handlers consume fully-typed actions without `as` casts.
 */
type Handler<K extends QuestionnaireAction["kind"]> = (
	state: QuestionnaireState,
	action: Extract<QuestionnaireAction, { kind: K }>,
	ctx: ApplyContext,
) => ApplyResult;

const navHandler: Handler<"nav"> = (state, action, ctx) => {
	const items = ctx.itemsByTab[state.currentTab] ?? [];
	const item = items[action.nextIndex];
	const inputMode = item ? ROW_INTENT_META[item.kind].activatesInputMode : false;
	const customDraftsByTab = state.inputMode
		? setCustomDraft(state, state.currentTab, action.inputValue)
		: state.customDraftsByTab;
	let next: QuestionnaireState = { ...state, optionIndex: action.nextIndex, inputMode, customDraftsByTab };
	if (state.inputMode && !inputMode && ctx.questions[state.currentTab]?.multiSelect) {
		next = { ...next, answers: persistMultiSelectAnswer(next, ctx) };
	}
	if (!inputMode) return { state: next, effects: [] };
	return {
		state: next,
		effects: [{ kind: "set_input_buffer", value: customDraftValueFor(next, state.currentTab) }],
	};
};

const inputClearHandler: Handler<"input_clear"> = (state, _action, _ctx) => ({
	state: { ...state, customDraftsByTab: setCustomDraft(state, state.currentTab, "") },
	effects: [{ kind: "clear_input_buffer" }],
});
const inputEditHandler: Handler<"input_edit"> = (state, action, _ctx) => ({
	state,
	effects: [{ kind: "open_input_editor", value: action.value }],
});
const inputReplaceHandler: Handler<"input_replace"> = (state, action, _ctx) => ({
	state: { ...state, customDraftsByTab: setCustomDraft(state, state.currentTab, action.value) },
	effects: [{ kind: "set_input_buffer", value: action.value }],
});

const tabSwitchHandler: Handler<"tab_switch"> = (state, action, ctx) => switchTabResult(state, action.nextTab, ctx);

const confirmHandler: Handler<"confirm"> = (state, action, ctx) => {
	let answer = action.answer;
	const q = ctx.questions[answer.questionIndex];
	if (answer.kind === "custom" && q?.multiSelect) {
		answer = { ...answer, kind: "multi", selected: selectedLabels(state, q) };
	} else if (answer.kind === "option" && answer.answer) {
		const matched = q?.options.find((o) => o.label === answer.answer);
		if (matched?.preview && matched.preview.length > 0) {
			answer = { ...answer, preview: matched.preview };
		}
	}
	const pendingNotes = state.notesByTab.get(answer.questionIndex);
	if (pendingNotes && pendingNotes.length > 0) {
		answer = { ...answer, notes: pendingNotes };
	}
	const answers = new Map(state.answers);
	answers.set(answer.questionIndex, answer);
	const hasCustomAnswer = answer.kind === "custom" || (answer.kind === "multi" && answer.answer !== null);
	const customDraftsByTab = hasCustomAnswer
		? withoutCustomDraft(state, answer.questionIndex)
		: state.customDraftsByTab;
	const next: QuestionnaireState = {
		...state,
		answers,
		customDraftsByTab,
	};
	if (action.autoAdvanceTab !== undefined) return switchTabResult(next, action.autoAdvanceTab, ctx);
	return doneFor(next, ctx, false);
};

const toggleHandler: Handler<"toggle"> = (state, action, ctx) => {
	const checked = new Set(state.multiSelectChecked);
	if (checked.has(action.index)) checked.delete(action.index);
	else checked.add(action.index);
	const intermediate: QuestionnaireState = { ...state, multiSelectChecked: checked };
	const answers = persistMultiSelectAnswer(intermediate, ctx);
	return { state: { ...intermediate, answers }, effects: [] };
};

const multiConfirmHandler: Handler<"multi_confirm"> = (state, action, ctx) => {
	const q = ctx.questions[state.currentTab];
	if (!q) return { state, effects: [] };
	const answers = new Map(state.answers);
	answers.set(state.currentTab, {
		...answerBase(state, state.currentTab, q),
		kind: "multi",
		answer: action.answer,
		selected: action.selected,
	});
	const synced: QuestionnaireState = {
		...state,
		answers,
		customDraftsByTab: withoutCustomDraft(state, state.currentTab),
		multiSelectChecked: syncMultiSelectFromAnswers(answers, ctx.questions, state.currentTab),
	};
	if (action.autoAdvanceTab !== undefined) return switchTabResult(synced, action.autoAdvanceTab, ctx);
	return doneFor(synced, ctx, false);
};

/**
 * Side-editor open (#197, #132): one parameterized pair serves both slots — the slot
 * decides which side-band is seeded (`notesByTab` vs `reasonByTab`) and which header
 * the view renders. The draft mirror is shared (`notesDraft`): only one side editor
 * can be open at a time because `activeSideEditor` is a single union value, so the
 * one draft cell is unambiguous (mutual exclusion is now type-level, not dispatch-order).
 */
const sideEditorEnterHandler: Handler<"side_editor_enter"> = (state, action, _ctx) => {
	const slot = action.slot;
	const value = slot === "notes" ? notesValueFor(state, state.currentTab) : state.reasonByTab.get(state.currentTab) ?? "";
	return {
		state: { ...state, activeSideEditor: slot, notesDraft: value },
		effects: [
			{ kind: "set_notes_value", value },
			{ kind: "set_notes_focused", focused: true },
		],
	};
};

/**
 * Side-editor commit: trimmed draft → the slot's side-band (empty clears it). Notes
 * also refresh the answer mirror (merged at confirm time for pre-answer notes);
 * reason refreshes the rephrase answer's `reason` mirror in kind-guarded shape (an
 * empty commit strips it, conditional spread keeps `"reason" in answer` honest), so
 * the Submit review stays truthful when the user edits the reason after a rephrase.
 */
const sideEditorExitHandler: Handler<"side_editor_exit"> = (state, action, _ctx) => {
	const trimmed = state.notesDraft.trim();
	const answers = new Map(state.answers);
	if (action.slot === "notes") {
		const notes = new Map(state.notesByTab);
		if (trimmed.length === 0) {
			notes.delete(state.currentTab);
			const prev = answers.get(state.currentTab);
			if (prev?.notes) {
				const stripped = { ...prev };
				delete (stripped as { notes?: string }).notes;
				answers.set(state.currentTab, stripped);
			}
		} else {
			notes.set(state.currentTab, trimmed);
			const prev = answers.get(state.currentTab);
			if (prev) answers.set(state.currentTab, { ...prev, notes: trimmed });
		}
		return {
			state: { ...state, notesByTab: notes, answers, activeSideEditor: null },
			effects: [{ kind: "set_notes_focused", focused: false }],
		};
	}
	const reasonByTab = new Map(state.reasonByTab);
	if (trimmed.length === 0) reasonByTab.delete(state.currentTab);
	else reasonByTab.set(state.currentTab, trimmed);
	const prev = answers.get(state.currentTab);
	if (prev?.kind === "rephrase") {
		const { reason: _stale, ...rest } = prev;
		answers.set(state.currentTab, trimmed.length === 0 ? rest : { ...rest, reason: trimmed });
	}
	return {
		state: { ...state, reasonByTab, answers, activeSideEditor: null },
		effects: [{ kind: "set_notes_focused", focused: false }],
	};
};


/**
 * Rephrase cap, per tab, per invocation (dialog-lifetime). The 3rd `rephrase_request`
 * on the same tab stops the dialog through the `rephrase_cap` cancel — the user has
 * rejected the question's wording three times, so the agent must switch to plain-chat
 * discussion instead of re-asking.
 */
export const REPHRASE_CAP = 3;

const cancelHandler: Handler<"cancel"> = (s, _a, c) => doneFor(s, c, true);

const rephraseRequestHandler: Handler<"rephrase_request"> = (state, action, ctx) => {
	const tab = state.currentTab;
	const q = ctx.questions[tab];
	if (!q) return { state, effects: [] };
	const count = (state.rephraseCountByTab.get(tab) ?? 0) + 1;
	const rephraseCountByTab = new Map(state.rephraseCountByTab);
	rephraseCountByTab.set(tab, count);
	if (count >= REPHRASE_CAP) {
		// Cap hit: force the rephrase_cap cancel. The capped tab ships no answer (its prior
		// answer, if any, is void — the user rejected the question itself); every other
		// answered tab survives in `details.answers` (rpiv cancelled invariant). That tab's
		// pending per-question note (`notesByTab`) drops together with the deleted answer —
		// accepted loss, the user rejected the question the note was about.
		const answers = new Map(state.answers);
		answers.delete(tab);
		return doneFor({ ...state, answers, rephraseCountByTab }, ctx, true, "rephrase_cap");
	}
	const reason = action.reason?.trim();
	const answers = new Map(state.answers);
	answers.set(tab, {
		...answerBase(state, tab, q),
		kind: "rephrase",
		answer: null,
		...(reason && reason.length > 0 ? { reason } : {}),
		rephraseCount: count,
		// Pending note rides the rephrase answer (answerBase notes tail), so a
		// note authored before the rephrase still reaches the agent.
	});
	const reasonByTab = new Map(state.reasonByTab);
	if (reason && reason.length > 0) reasonByTab.set(tab, reason);
	else reasonByTab.delete(tab);
	const next: QuestionnaireState = { ...state, answers, reasonByTab, rephraseCountByTab };
	// Focus follows the existing switchTab semantics to the next question; on the last
	// question there is no next tab — the dialog stays open (state returns unchanged) and
	// the user must reach the Submit tab manually to finish it.
	if (tab < ctx.questions.length - 1) return switchTabResult(next, tab + 1, ctx);
	return { state: next, effects: [] };
};

const submitHandler: Handler<"submit"> = (s, _a, c) => doneFor(s, c, false);
const submitNavHandler: Handler<"submit_nav"> = (s, a, _c) => ({
	state: { ...s, submitChoiceIndex: a.nextIndex },
	effects: [],
});
const notesForwardHandler: Handler<"notes_forward"> = (s, a, _c) => ({
	state: s,
	effects: [{ kind: "forward_notes_keystroke", data: a.data }],
});
const toggleCollapsedHandler: Handler<"toggle_collapsed"> = (s, _a, _c) => ({
	state: { ...s, collapsed: !s.collapsed },
	effects: [{ kind: "set_overlay_hidden", hidden: !s.collapsed }],
});
const ignoreHandler: Handler<"ignore"> = (s, _a, _c) => ({ state: s, effects: [] });

/**
 * Compile-time-exhaustive dispatch table. `{ [K in Kind]: Handler<K> }` requires
 * an entry per union member — adding a new `QuestionnaireAction` variant fails to
 * compile here until a handler is registered, mirroring the `Record<RowKind, …>`
 * pattern used by `ROW_INTENT_META`.
 */
const HANDLERS: { [K in QuestionnaireAction["kind"]]: Handler<K> } = {
	nav: navHandler,
	input_clear: inputClearHandler,
	input_edit: inputEditHandler,
	input_replace: inputReplaceHandler,
	tab_switch: tabSwitchHandler,
	confirm: confirmHandler,
	toggle: toggleHandler,
	multi_confirm: multiConfirmHandler,
	cancel: cancelHandler,
	rephrase_request: rephraseRequestHandler,

	side_editor_enter: sideEditorEnterHandler,
	side_editor_exit: sideEditorExitHandler,
	notes_forward: notesForwardHandler,
	submit: submitHandler,
	submit_nav: submitNavHandler,
	toggle_collapsed: toggleCollapsedHandler,
	ignore: ignoreHandler,
};

/**
 * Pure reducer: (state, action, ctx) → (state, Effect[]). Mirrors `rpiv-todo`'s `applyTaskMutation`.
 * Delegates to `HANDLERS` — per-kind handlers above are pure, named, and individually testable.
 * `ignore` is also handled outside the reducer by `handleIgnoreInline` in the runtime fast path.
 */
export function reduce(state: QuestionnaireState, action: QuestionnaireAction, ctx: ApplyContext): ApplyResult {
	const handler = HANDLERS[action.kind] as Handler<typeof action.kind>;
	return handler(state, action as never, ctx);
}
