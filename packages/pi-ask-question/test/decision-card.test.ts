import type { Theme } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
	ASK_USER_WIDGET_KEY,
	buildCallSummaryLine,
	buildDecisionCardLines,
	buildItemsForQuestion,
	buildWidgetLine,
	DECLINE_MESSAGE,
	QuestionnaireSession,
	REPHRASE_CAP_MESSAGE,
} from "../seams.ts";

// Identity theme: renders bare text so assertions match visible content, not ANSI.
const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s } as unknown as Theme;

const CTX = "总体目标：选数据库。当前进度：候选两个。本批问题解决：部署形态。";
const PARAMS = {
	context: CTX,
	recent: ["src/db.ts", "#12"],
	questions: [
		{
			question: "用哪个数据库？",
			header: "数据库",
			options: [
				{ label: "Postgres", description: "" },
				{ label: "SQLite", description: "" },
			],
		},
		{
			question: "启用哪些特性？",
			header: "特性",
			options: [
				{ label: "A", description: "" },
				{ label: "B", description: "" },
			],
			multiSelect: true,
		},
	],
};

const ANSWERED = {
	cancelled: false,
	answers: [
		{ questionIndex: 0, question: "用哪个数据库？", kind: "option" as const, answer: "Postgres" },
		{
			questionIndex: 1,
			question: "启用哪些特性？",
			kind: "multi" as const,
			answer: "draft",
			selected: ["A", "B"],
		},
	],
};

describe("transcript decision card (ticket #134)", () => {
	describe("buildCallSummaryLine — one-line renderCall summary", () => {
		it("`ask_user · <first header>（n 题）`", () => {
			expect(buildCallSummaryLine(PARAMS, theme)).toBe("ask_user · 数据库（2 题）");
		});

		it("degrades to the bare tool name on missing/malformed args", () => {
			expect(buildCallSummaryLine(undefined, theme)).toBe("ask_user");
			expect(buildCallSummaryLine({ questions: "not-an-array" }, theme)).toBe("ask_user");
			expect(buildCallSummaryLine({ questions: [] }, theme)).toBe("ask_user");
		});
	});

	describe("buildDecisionCardLines — answered card", () => {
		it("context line + recent anchors + one `● header → answer` row per answer", () => {
			expect(
				buildDecisionCardLines({
					text: "envelope text ignored when the card renders",
					details: ANSWERED,
					params: PARAMS,
					expanded: true,
					theme,
				}),
			).toEqual([
				`context: ${CTX}`,
				`recent: src/db.ts; #12.`,
				"● 数据库 → Postgres",
				`● 特性 → 勾选: A, B ＋ 自定义: "draft"`,
			]);
		});

		it("multi answer text is the T5 envelope shape (formatAnswerScalar source)", () => {
			const lines = buildDecisionCardLines({
				text: "",
				details: { cancelled: false, answers: [ANSWERED.answers[1]] },
				params: PARAMS,
				expanded: true,
				theme,
			});
			expect(lines.at(-1)).toBe(`● 特性 → 勾选: A, B ＋ 自定义: "draft"`);
		});

		it("rephrase entries render the T4 `↻ 要求重问` shape", () => {
			const lines = buildDecisionCardLines({
				text: "",
				details: {
					cancelled: false,
					answers: [
						{
							questionIndex: 0,
							question: "用哪个数据库？",
							kind: "rephrase",
							answer: null,
							reason: "选项太窄",
							rephraseCount: 1,
						},
					],
				},
				params: PARAMS,
				expanded: true,
				theme,
			});
			expect(lines.at(-1)).toBe("● 数据库 → ↻ 要求重问（原因：选项太窄）");
		});

		it("a multi-line context renders one card line per authored line", () => {
			const lines = buildDecisionCardLines({
				text: "",
				details: { cancelled: false, answers: [] },
				params: { ...PARAMS, context: "目标：x\n进度：y\n决策：z", recent: undefined },
				expanded: true,
				theme,
			});
			expect(lines).toEqual(["context: 目标：x", "进度：y", "决策：z"]);
		});

		it("empty header falls back to the Q<n> label (submit-review parity)", () => {
			const lines = buildDecisionCardLines({
				text: "",
				details: { cancelled: false, answers: [{ questionIndex: 0, question: "q?", kind: "option", answer: "x" }] },
				params: { context: CTX, questions: [{ question: "q?", header: "", options: [] }] },
				expanded: true,
				theme,
			});
			expect(lines.at(-1)).toBe("● Q1 → x");
		});
	});

	describe("envelope suffix rendering (ticket #135 P2-1)", () => {
		function cardLines(answers: unknown[], details: Record<string, unknown> = {}) {
			return buildDecisionCardLines({
				text: "",
				details: { cancelled: false, answers, ...details } as never,
				params: PARAMS,
				expanded: true,
				theme,
			});
		}

		it("non-empty notes renders the `user notes:` envelope suffix", () => {
			const lines = cardLines([
				{ questionIndex: 0, question: "用哪个数据库？", kind: "option", answer: "Postgres", notes: "要托管版本" },
			]);
			expect(lines.at(-1)).toBe("● 数据库 → Postgres. user notes: 要托管版本");
		});

		it("non-empty preview renders the `selected preview:` envelope suffix, before notes", () => {
			const lines = cardLines([
				{
					questionIndex: 0,
					question: "用哪个数据库？",
					kind: "option",
					answer: "Postgres",
					preview: "```sql\nselect 1;\n```",
					notes: "要托管版本",
				},
			]);
			expect(lines.at(-1)).toBe("● 数据库 → Postgres. selected preview: ```sql\nselect 1;\n```. user notes: 要托管版本");
		});

		it("empty-string notes/preview render nothing (conditional-spread parity)", () => {
			const lines = cardLines([
				{ questionIndex: 0, question: "用哪个数据库？", kind: "option", answer: "Postgres", notes: "", preview: "" },
			]);
			expect(lines.at(-1)).toBe("● 数据库 → Postgres");
		});

		it("globalNote appends the envelope `global note:` segment after the answer rows", () => {
			const lines = cardLines(
				[{ questionIndex: 0, question: "用哪个数据库？", kind: "option", answer: "Postgres" }],
				{ globalNote: "部署形态已定" },
			);
			expect(lines.at(-1)).toBe("global note: 部署形态已定.");
		});

		it("no globalNote leaves the card without a global note line", () => {
			const lines = cardLines([{ questionIndex: 0, question: "用哪个数据库？", kind: "option", answer: "Postgres" }]);
			expect(lines.some((l) => l.startsWith("global note:"))).toBe(false);
		});
	});

	describe("buildDecisionCardLines — collapse/expand", () => {
		const fourQuestions = PARAMS.questions.flatMap((q) => [q, q]);
		const bigParams = { context: CTX, recent: ["a"], questions: fourQuestions };
		const bigDetails = {
			cancelled: false,
			answers: fourQuestions.map((q, i) => ({
				questionIndex: i,
				question: q.question,
				kind: "option" as const,
				answer: "x",
			})),
		};
		const input = { text: "", details: bigDetails, params: bigParams, theme };

		it("collapsed shows a 5-line preview plus a `… +N 行` hint", () => {
			const lines = buildDecisionCardLines({ ...input, expanded: false });
			expect(lines).toHaveLength(6);
			expect(lines[5]).toBe("… +1 行");
		});

		it("expanded shows every line, no hint", () => {
			const lines = buildDecisionCardLines({ ...input, expanded: true });
			expect(lines).toHaveLength(6);
			expect(lines.some((l) => l.includes("行"))).toBe(false);
		});
	});

	describe("buildDecisionCardLines — cancelled results stay one line", () => {
		it("decline renders the envelope text, no card, expanded or not", () => {
			const input = {
				text: DECLINE_MESSAGE,
				details: { answers: [], cancelled: true },
				params: PARAMS,
				theme,
			};
			expect(buildDecisionCardLines({ ...input, expanded: false })).toEqual([DECLINE_MESSAGE]);
			expect(buildDecisionCardLines({ ...input, expanded: true })).toEqual([DECLINE_MESSAGE]);
		});

		it("rephrase-cap cancel renders its dedicated message, no card", () => {
			expect(
				buildDecisionCardLines({
					text: REPHRASE_CAP_MESSAGE,
					details: { answers: [], cancelled: true, cancelReason: "rephrase_cap" },
					params: PARAMS,
					expanded: false,
					theme,
				}),
			).toEqual([REPHRASE_CAP_MESSAGE]);
		});

		it("missing details or params falls back to the single envelope line", () => {
			const text = "User has answered your questions: …";
			expect(buildDecisionCardLines({ text, details: undefined, params: PARAMS, expanded: true, theme })).toEqual([
				text,
			]);
			expect(buildDecisionCardLines({ text, details: ANSWERED, params: undefined, expanded: true, theme })).toEqual([
				text,
			]);
		});
	});
});

describe("persistent collapse widget (ticket #134)", () => {
	// Test env has no @juicesharp/rpiv-i18n, so `t` degrades to the canonical-English
	// fallback — the same mode every other t()-based assertion in this suite runs in.
	it("copy (en fallback): `❓ ask_user waiting for answers (n/m answered) · <key> to reopen`", () => {
		expect(buildWidgetLine(1, 2, "Ctrl+]")).toBe(
			"❓ ask_user waiting for answers (1/2 answered) · Ctrl+] to reopen",
		);
	});

	it("en/zh locale entries carry the exact placeholders the template replaces", async () => {
		for (const code of ["en", "zh"]) {
			const raw = await readFile(new URL(`../locales/${code}.json`, import.meta.url), "utf8");
			for (const placeholder of ["{answered}", "{total}", "{key}"]) {
				expect(JSON.parse(raw).widget_line, `${code}.json widget_line`).toContain(placeholder);
			}
		}
	});

	it("widget registers under the stable key `ask_user`", () => {
		expect(ASK_USER_WIDGET_KEY).toBe("ask_user");
	});
});

describe("session collapse observer — widget lifecycle trigger", () => {
	function makeSession(onCollapseChange: (collapsed: boolean) => void): QuestionnaireSession {
		const questions = [PARAMS.questions[0]];
		return new QuestionnaireSession({
			tui: { terminal: { columns: 80, rows: 24 }, requestRender: () => {} } as never,
			theme,
			params: { context: CTX, questions: [...questions] },
			itemsByTab: questions.map((q) => buildItemsForQuestion({ ...q, options: [...q.options] })),
			done: () => {},
			keybindings: { matches: (_data, name) => name === "tui.select.confirm" },
			editInput: async () => undefined,
			collapseKey: "ctrl+]",
			canReopenWhileHidden: true,
			rowBudget: (rows) => rows,
			onCollapseChange,
		});
	}

	it("collapse toggle fires onCollapseChange(true); reopen fires (false) — the widget set/clear exits", () => {
		const seen: boolean[] = [];
		const session = makeSession((collapsed) => seen.push(collapsed));
		session.toggleCollapsedExternal();
		session.toggleCollapsedExternal();
		expect(seen).toEqual([true, false]);
	});

	it("no callback when collapsed never flips", () => {
		const seen: boolean[] = [];
		makeSession((collapsed) => seen.push(collapsed));
		expect(seen).toEqual([]);
	});

	it("answeredCount reads the live answers map; questionCount is the authored total", () => {
		const session = makeSession(() => {});
		expect(session.answeredCount).toBe(0);
		expect(session.questionCount).toBe(1);
		session.dispatch("\r");
		expect(session.answeredCount).toBe(1);
	});
});
