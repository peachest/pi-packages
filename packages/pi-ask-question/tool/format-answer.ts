import type { QuestionAnswer } from "./types.ts";

/**
 * Placeholder for empty / null answer text. Used uniformly across both variants — the
 * earlier `(no answer)` fallback in the dialog summary was accidental drift; tests pin
 * `(no input)` only.
 */
export const NO_INPUT_PLACEHOLDER = "(no input)";

export type FormatAnswerVariant = "summary" | "envelope";

/**
 * Format a `QuestionAnswer` to its scalar string form. `variant` is currently unused
 * across all branches (the chat branch that once distinguished `envelope` from
 * `summary` has been removed); it is retained on the signature for stability.
 * The `kind: "custom"` empty-string handling and the option fallback both unify on
 * `NO_INPUT_PLACEHOLDER`; the `multi` branch names its two halves (`勾选:` / `＋ 自定义:`)
 * so checked+custom coexistence is visible to the model, not just a flat join.
 * Switch is exhaustive — non-`void` return enforces every variant is handled.
 */
/** Shared multi-select merge copy — the Submit preview and the envelope must label the halves identically (#133). */
const MULTI_CHECKED_PREFIX = "勾选: ";
const MULTI_CUSTOM_PREFIX = "＋ 自定义: ";

/** `勾选: A, B` — the checked half of a multi answer; placeholder when nothing is checked. */
export function formatMultiCheckedLine(a: QuestionAnswer): string {
	const selected = a.selected ?? [];
	return `${MULTI_CHECKED_PREFIX}${selected.length > 0 ? selected.join(", ") : NO_INPUT_PLACEHOLDER}`;
}

/** `＋ 自定义: "text"` — the custom half of a multi answer; undefined when no custom text was typed. */
export function formatMultiCustomLine(a: QuestionAnswer): string | undefined {
	return a.answer && a.answer.length > 0 ? `${MULTI_CUSTOM_PREFIX}"${a.answer}"` : undefined;
}

export function formatAnswerScalar(a: QuestionAnswer, _variant: FormatAnswerVariant): string {
	switch (a.kind) {
		case "multi": {
			const customLine = formatMultiCustomLine(a);
			// All-empty keeps the bare NO_INPUT_PLACEHOLDER semantics (rpiv parity).
			if ((a.selected ?? []).length === 0 && !customLine) return NO_INPUT_PLACEHOLDER;
			const checkedLine = formatMultiCheckedLine(a);
			return customLine ? `${checkedLine} ${customLine}` : checkedLine;
		}
		case "custom":
			return a.answer && a.answer.length > 0 ? a.answer : NO_INPUT_PLACEHOLDER;
		case "option":
			return a.answer ?? NO_INPUT_PLACEHOLDER;
		case "rephrase":
			return a.reason && a.reason.length > 0 ? `↻ 要求重问（原因：${a.reason}）` : "↻ 要求重问";
	}
}
