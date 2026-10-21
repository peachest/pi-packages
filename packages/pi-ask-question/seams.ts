// Seam re-exports for tests: the repo boundary rule (packages/README.md) lets
// tests import only package root files, so every symbol later tickets exercise
// is re-exported here from its private source module. No logic lives here.
// validator
export {
	ERROR_CONTEXT_REQUIRED,
	ERROR_NO_QUESTIONS,
	ERROR_TOO_MANY_QUESTIONS,
	ERROR_DUPLICATE_QUESTION,
	ERROR_TOO_FEW_OPTIONS,
	ERROR_RESERVED_LABEL,
	ERROR_DUPLICATE_OPTION_LABEL,
	validateQuestionnaire,
} from "./tool/validate-questionnaire.ts";
export type { ValidationResult } from "./tool/validate-questionnaire.ts";
// params schema + types
export { QuestionParamsSchema } from "./tool/types.ts";
export type { QuestionAnswer, QuestionData, QuestionParams, QuestionnaireResult } from "./tool/types.ts";
// reducer
export { reduce, REPHRASE_CAP } from "./state/state-reducer.ts";
export type { QuestionnaireAction } from "./state/key-router.ts";
export type { Effect, ApplyContext } from "./state/state-reducer.ts";
export type { QuestionnaireState } from "./state/state.ts";
// formatters + response envelope
export { formatAnswerScalar, NO_INPUT_PLACEHOLDER } from "./tool/format-answer.ts";
export {
	buildQuestionnaireResponse,
	buildAnswerSegment,
	buildUnansweredSegment,
	buildRephraseInstruction,
	DECLINE_MESSAGE,
	ENVELOPE_PREFIX,
	REPHRASE_CAP_MESSAGE,
} from "./tool/response-envelope.ts";
// views
export { MultiSelectView } from "./view/components/multi-select-view.ts";
export { SubmitTabStrategy } from "./view/tab-content-strategy.ts";
