import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatAnswerScalar } from "../tool/format-answer.ts";
import type { QuestionAnswer, QuestionnaireResult } from "../tool/types.ts";

/**
 * Collapsed `renderResult` shows this many card lines before the `… +N 行` hint —
 * same preview budget as the bash tool's `BASH_PREVIEW_LINES`.
 */
export const CARD_PREVIEW_LINES = 5;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * One-line `renderCall` summary: `ask_user · <first header>（n 题）`. `args` is
 * whatever pi recorded for the call (defensively read — replayed or malformed
 * transcripts must degrade to the bare tool name, never throw).
 */
export function buildCallSummaryLine(args: unknown, theme: Theme): string {
	const title = theme.fg("toolTitle", theme.bold("ask_user"));
	const questions = isRecord(args) && Array.isArray(args.questions) ? args.questions : [];
	if (questions.length === 0) return title;
	const first = questions[0];
	const header = isRecord(first) && typeof first.header === "string" && first.header.length > 0 ? first.header : "";
	return `${title}${theme.fg("text", header.length > 0 ? ` · ${header}` : "")}${theme.fg("muted", `（${questions.length} 题）`)}`;
}

/** Submit-review label parity: authored header, or `Q<n>` when the header is empty. */
function questionLabel(questions: readonly unknown[], index: number): string {
	const q = questions[index];
	const header = isRecord(q) && typeof q.header === "string" ? q.header : "";
	return header.length > 0 ? header : `Q${index + 1}`;
}

/** `● <header> → <answer>` — the answer comes from the same `formatAnswerScalar` path as the envelope segment. */
function answerCardLine(a: QuestionAnswer, questions: readonly unknown[], theme: Theme): string {
	const label = questionLabel(questions, a.questionIndex);
	return (
		theme.fg("muted", `● ${label}`) +
		" " +
		theme.fg("muted", "→") +
		" " +
		theme.fg("text", formatAnswerScalar(a, "envelope"))
	);
}

/** Card body: context section (one line per authored line) + recent anchors + per-answer rows. */
function cardBodyLines(details: QuestionnaireResult, params: unknown, theme: Theme): string[] {
	if (!isRecord(params) || typeof params.context !== "string" || !Array.isArray(params.questions)) return [];
	const lines: string[] = [];
	const contextLines = params.context.split("\n");
	lines.push(`context: ${contextLines[0]}`, ...contextLines.slice(1));
	const recent = params.recent;
	if (Array.isArray(recent) && recent.length > 0) {
		lines.push(`recent: ${recent.filter((r) => typeof r === "string").join("; ")}.`);
	}
	for (const a of details.answers) lines.push(answerCardLine(a, params.questions, theme));
	return lines;
}

/**
 * Transcript decision card for a settled ask_user result. Cancelled results (decline,
 * rephrase cap, UI errors) stay a single envelope line — no card. Answered results
 * render the structured body; collapsed (`expanded: false`) trims to
 * `CARD_PREVIEW_LINES` plus a `… +N 行` hint. Degrades to the single envelope line
 * whenever the card's inputs (details/params) are unusable.
 */
export function buildDecisionCardLines(input: {
	text: string;
	details: QuestionnaireResult | undefined;
	params: unknown;
	expanded: boolean;
	theme: Theme;
}): string[] {
	const { text, details, params, expanded, theme } = input;
	const card =
		details && !details.cancelled && Array.isArray(details.answers) ? cardBodyLines(details, params, theme) : [];
	if (card.length === 0) return [text];
	if (!expanded && card.length > CARD_PREVIEW_LINES) {
		return [...card.slice(0, CARD_PREVIEW_LINES), theme.fg("muted", `… +${card.length - CARD_PREVIEW_LINES} 行`)];
	}
	return card;
}
