import { describe, expect, it } from "vitest";
import {
	buildAnswerSegment,
	buildQuestionnaireResponse,
	buildUnansweredSegment,
	ERROR_DUPLICATE_OPTION_LABEL,
	ERROR_DUPLICATE_QUESTION,
	ERROR_NO_QUESTIONS,
	ERROR_RESERVED_LABEL,
	ERROR_TOO_FEW_OPTIONS,
	ERROR_TOO_MANY_QUESTIONS,
	formatAnswerScalar,
	MultiSelectView,
	reduce,
	SubmitTabStrategy,
	validateQuestionnaire,
	type QuestionnaireAction,
	type ValidationResult,
} from "../seams.ts";

// Compile-time seam proof: these assignments only pass tsc when the type
// re-exports resolve to the real source types.
const _validationResult: ValidationResult = { ok: true };
const _actions: QuestionnaireAction[] = [];
void _validationResult;
void _actions;

const VALIDATOR_ERROR_CONSTANTS = [
	ERROR_NO_QUESTIONS,
	ERROR_TOO_MANY_QUESTIONS,
	ERROR_DUPLICATE_QUESTION,
	ERROR_TOO_FEW_OPTIONS,
	ERROR_RESERVED_LABEL,
	ERROR_DUPLICATE_OPTION_LABEL,
];

describe("pi-ask-question seams (package root re-exports)", () => {
	it("re-exports the validator seam: validateQuestionnaire + error constants", () => {
		expect(typeof validateQuestionnaire).toBe("function");
		for (const constant of VALIDATOR_ERROR_CONSTANTS) {
			expect(constant).toBeTypeOf("string");
		}
	});

	it("re-exports the reducer seam: reduce + QuestionnaireAction", () => {
		expect(typeof reduce).toBe("function");
	});

	it("re-exports the formatter seam: formatAnswerScalar", () => {
		expect(typeof formatAnswerScalar).toBe("function");
	});

	it("re-exports the response envelope seam: builder + answer segments", () => {
		expect(typeof buildQuestionnaireResponse).toBe("function");
		expect(typeof buildAnswerSegment).toBe("function");
		expect(typeof buildUnansweredSegment).toBe("function");
	});

	it("re-exports the view seams: MultiSelectView + SubmitTabStrategy", () => {
		expect(typeof MultiSelectView).toBe("function");
		expect(typeof SubmitTabStrategy).toBe("function");
	});
});
