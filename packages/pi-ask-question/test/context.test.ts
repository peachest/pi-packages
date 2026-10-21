import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
	buildQuestionnaireResponse,
	DECLINE_MESSAGE,
	ENVELOPE_PREFIX,
	ERROR_CONTEXT_REQUIRED,
	type QuestionAnswer,
	type QuestionnaireResult,
	QuestionParamsSchema,
	type QuestionParams,
	validateQuestionnaire,
} from "../seams.ts";

function makeParams(overrides: Partial<QuestionParams> = {}): QuestionParams {
	return {
		context: "a".repeat(40),
		questions: [
			{
				question: "Which library?",
				header: "Library",
				options: [
					{ label: "Left", description: "Use the left one." },
					{ label: "Right", description: "Use the right one." },
				],
			},
		],
		...overrides,
	};
}

function paramsWithoutContext(): QuestionParams {
	const params = makeParams();
	delete (params as Partial<QuestionParams>).context;
	return params;
}

const ANSWER: QuestionAnswer = { questionIndex: 0, question: "Which library?", kind: "option", answer: "Left" };

function makeResult(overrides: Partial<QuestionnaireResult> = {}): QuestionnaireResult {
	return { answers: [ANSWER], cancelled: false, ...overrides };
}

describe("context/recent schema gate (QuestionParamsSchema)", () => {
	it("rejects a call without context", () => {
		expect(Value.Check(QuestionParamsSchema, paramsWithoutContext())).toBe(false);
	});

	it("rejects context under 40 chars and accepts the 40-char boundary", () => {
		expect(Value.Check(QuestionParamsSchema, makeParams({ context: "a".repeat(39) }))).toBe(false);
		expect(Value.Check(QuestionParamsSchema, makeParams({ context: "a".repeat(40) }))).toBe(true);
	});

	it("rejects context over 400 chars and accepts the 400-char boundary", () => {
		expect(Value.Check(QuestionParamsSchema, makeParams({ context: "a".repeat(401) }))).toBe(false);
		expect(Value.Check(QuestionParamsSchema, makeParams({ context: "a".repeat(400) }))).toBe(true);
	});

	it("rejects a 6th recent anchor but accepts 5", () => {
		const five = ["src/a.ts", "#12", "#13", "#14", "#15"];
		expect(Value.Check(QuestionParamsSchema, makeParams({ recent: five }))).toBe(true);
		expect(Value.Check(QuestionParamsSchema, makeParams({ recent: [...five, "#16"] }))).toBe(false);
	});

	it("rejects a recent anchor over 100 chars but accepts the 100-char boundary", () => {
		expect(Value.Check(QuestionParamsSchema, makeParams({ recent: ["a".repeat(100)] }))).toBe(true);
		expect(Value.Check(QuestionParamsSchema, makeParams({ recent: ["a".repeat(101)] }))).toBe(false);
	});
});

describe("context validator gate (validateQuestionnaire)", () => {
	it("rejects missing context with the teaching message", () => {
		const result = validateQuestionnaire(paramsWithoutContext());
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toBe("context_required");
			expect(result.message).toBe(ERROR_CONTEXT_REQUIRED);
			expect(result.message).toMatch(/three sentences/i);
			expect(result.message).toContain("40");
		}
	});

	it("rejects a 39-char context and passes the 40-char boundary", () => {
		expect(validateQuestionnaire(makeParams({ context: "a".repeat(39) })).ok).toBe(false);
		expect(validateQuestionnaire(makeParams({ context: "a".repeat(40) })).ok).toBe(true);
	});

	it("rejects a 401-char context and passes the 400-char boundary", () => {
		expect(validateQuestionnaire(makeParams({ context: "a".repeat(401) })).ok).toBe(false);
		expect(validateQuestionnaire(makeParams({ context: "a".repeat(400) })).ok).toBe(true);
	});
});

describe("envelope recall-panel echo (buildQuestionnaireResponse)", () => {
	it("echoes context as the first segment, then recent anchors, before the answers", () => {
		const response = buildQuestionnaireResponse(makeResult(), makeParams({ recent: ["src/a.ts", "#12"] }));
		const text = response.content[0].text;
		expect(text.startsWith(`${ENVELOPE_PREFIX} context: ${"a".repeat(40)}.`)).toBe(true);
		const contextAt = text.indexOf("context: ");
		const recentAt = text.indexOf("recent: src/a.ts; #12.");
		const answerAt = text.indexOf('"Which library?"');
		expect(contextAt).toBeGreaterThan(-1);
		expect(recentAt).toBeGreaterThan(contextAt);
		expect(answerAt).toBeGreaterThan(recentAt);
	});

	it("omits the recent segment when recent is absent or empty", () => {
		for (const recent of [undefined, []]) {
			const text = buildQuestionnaireResponse(makeResult(), makeParams({ recent })).content[0].text;
			expect(text).not.toContain("recent:");
			expect(text).toContain("context: ");
		}
	});

	it("echoes each question's background before its answer segment", () => {
		const params = makeParams({
			questions: [
				{
					question: "Which library?",
					header: "Library",
					background: "Two conflicting benchmarks in #31.",
					options: [
						{ label: "Left", description: "Use the left one." },
						{ label: "Right", description: "Use the right one." },
					],
				},
				{
					question: "Ship when?",
					header: "Timing",
					background: "Release train leaves Friday.",
					options: [
						{ label: "Now", description: "Ship now." },
						{ label: "Later", description: "Ship later." },
					],
				},
			],
		});
		const result = makeResult({
			answers: [ANSWER, { questionIndex: 1, question: "Ship when?", kind: "option", answer: "Now" }],
		});
		const text = buildQuestionnaireResponse(result, params).content[0].text;
		const bg1 = text.indexOf("background: Two conflicting benchmarks in #31.");
		const answer1 = text.indexOf('"Which library?"');
		const bg2 = text.indexOf("background: Release train leaves Friday.");
		const answer2 = text.indexOf('"Ship when?"');
		expect(bg1).toBeGreaterThan(-1);
		expect(answer1).toBeGreaterThan(bg1);
		expect(bg2).toBeGreaterThan(answer1);
		expect(answer2).toBeGreaterThan(bg2);
	});

	it("skips the background segment for questions authored without one", () => {
		const text = buildQuestionnaireResponse(makeResult(), makeParams()).content[0].text;
		expect(text).not.toContain("background:");
	});

	it("keeps the cancel path a bare decline message", () => {
		const response = buildQuestionnaireResponse({ answers: [ANSWER], cancelled: true }, makeParams({ recent: ["src/a.ts"] }));
		expect(response.content[0].text).toBe(DECLINE_MESSAGE);
	});
});
