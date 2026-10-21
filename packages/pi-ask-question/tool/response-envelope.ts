import { formatAnswerScalar } from "./format-answer.ts";
import type { QuestionAnswer, QuestionnaireResult, QuestionParams } from "./types.ts";

export const DECLINE_MESSAGE = "User declined to answer questions";
/**
 * Dedicated message for the rephrase-cap cancel (3rd rephrase of the same tab): the user
 * did NOT refuse to engage — they rejected the question's wording three times — so this
 * is deliberately not the canonical decline. Other answers ride `details` only (rpiv
 * invariant: cancelled text never carries answers).
 */
export const REPHRASE_CAP_MESSAGE =
	"用户已连续三次对问题表述不满意，本次问卷已取消。请改用普通文本在 chat 里与用户讨论该决策。";
export const ENVELOPE_PREFIX = "User has answered your questions:";
export const ENVELOPE_SUFFIX = "You can now continue with the user's answers in mind.";

/**
 * Map a `QuestionnaireResult` (or null/cancelled) to the LLM-facing tool envelope.
 * Pure of `(result, params)`; cancelled and "no segments" both fall to `DECLINE_MESSAGE`
 * so the model sees a single canonical "didn't answer" signal regardless of why — except
 * the rephrase-cap cancel, which sends `REPHRASE_CAP_MESSAGE` instead (the dialog was
 * force-closed after the 3rd rephrase of one question, not declined).
 * "No segments" means no answers AND no global note — the `global note:` segment is
 * pushed before the zero-segments check, so a note-bearing submit with zero answers
 * still yields the answered envelope. A partial submit names the questions left blank
 * in an `unanswered:` segment (and `details.unanswered`, their indexes) so the model can
 * tell "not decided yet" from "settled" (#291); it never counts as an answer, and a fully
 * answered result stays byte-identical.
 */
export function buildQuestionnaireResponse(result: QuestionnaireResult | null | undefined, params: QuestionParams) {
	if (!result || result.cancelled) {
		if (result?.cancelReason === "rephrase_cap") {
			return buildToolResult(REPHRASE_CAP_MESSAGE, {
				answers: result.answers,
				cancelled: true,
				cancelReason: result.cancelReason,
				...(result.globalNote && result.globalNote.length > 0 ? { globalNote: result.globalNote } : {}),
			});
		}
		// Decline text stays canonical even when a global note rides the cancelled result;
		// the note survives in `details` (like partial `answers`) for replay consumers.
		return buildToolResult(DECLINE_MESSAGE, {
			answers: result?.answers ?? [],
			cancelled: true,
			...(result?.globalNote && result.globalNote.length > 0 ? { globalNote: result.globalNote } : {}),
		});
	}
	const segments: string[] = [];
	const unanswered: number[] = [];
	for (let i = 0; i < params.questions.length; i++) {
		const a = result.answers.find((x) => x.questionIndex === i);
		if (a) {
			// Each question's authored motivation rides before its answer segment.
			const background = params.questions[i]?.background;
			if (background && background.length > 0) segments.push(`background: ${background}.`);
			segments.push(buildAnswerSegment(a));
			// A rephrase answer is an answered kind (never a decline), but its segment alone
			// doesn't tell the model what to DO — the instruction rides right after it.
			if (a.kind === "rephrase") segments.push(buildRephraseInstruction(a));
		}
		else unanswered.push(i);
	}
	const hasGlobalNote = result.globalNote !== undefined && result.globalNote.length > 0;
	if (segments.length === 0 && !hasGlobalNote) {
		return buildToolResult(DECLINE_MESSAGE, { answers: result.answers, cancelled: true });
	}
	// Recall-panel echo: context leads and recent anchors follow, so the model
	// re-reads why these questions were asked before any answer. The decline
	// paths above stay bare — panel material never echoes there.
	segments.unshift(`context: ${params.context}.`);
	if (params.recent && params.recent.length > 0) {
		segments.splice(1, 0, `recent: ${params.recent.join("; ")}.`);
	}
	if (unanswered.length > 0) segments.push(buildUnansweredSegment(unanswered, params));
	// Global note rides after the per-question segments: raw multiline echo (no
	// reformatting), trailing period mirroring `buildAnswerSegment`'s shape.
	if (hasGlobalNote) segments.push(`global note: ${result.globalNote}.`);
	const details = unanswered.length > 0 ? { ...result, unanswered } : result;
	return buildToolResult(`${ENVELOPE_PREFIX} ${segments.join(" ")} ${ENVELOPE_SUFFIX}`, details);
}

/** `unanswered: "<question>", "<question>".` — the questions shown but left blank on a partial submit. */
export function buildUnansweredSegment(indexes: readonly number[], params: QuestionParams): string {
	return `unanswered: ${indexes.map((i) => `"${params.questions[i]?.question}"`).join(", ")}.`;
}

/**
 * Instruction segment following a rephrase answer's own segment. Pure of `a`. Names the
 * question, the optional reason, and the per-tab rephrase count `N` carried on the
 * answer (dialog state is gone by envelope time). Rephrase is an answered kind — this
 * segment instructs the re-ask, it never declines.
 */
export function buildRephraseInstruction(a: QuestionAnswer): string {
	const reason = a.reason && a.reason.length > 0 ? `（原因：${a.reason}）` : "";
	return `用户对问题 "${a.question}" 不满意${reason}。请在下一轮更新 context 进度（已重问 ${a.rephraseCount ?? 1} 次）后用 ask_user 重新问这一题，展开术语并补全选项；其余已答答案保持有效。不得跳过该决策。`;
}

/**
 * Format a single answer segment for the envelope. Pure of `a`. The `"Q"="A"` shape and
 * the optional `selected preview:` / `user notes:` suffixes are pinned by envelope tests.
 */
export function buildAnswerSegment(a: QuestionAnswer): string {
	const parts: string[] = [`"${a.question}"="${formatAnswerScalar(a, "envelope")}"`];
	if (a.preview && a.preview.length > 0) parts.push(`selected preview: ${a.preview}`);
	if (a.notes && a.notes.length > 0) parts.push(`user notes: ${a.notes}`);
	return `${parts.join(". ")}.`;
}

export function buildToolResult(text: string, details: QuestionnaireResult) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}
