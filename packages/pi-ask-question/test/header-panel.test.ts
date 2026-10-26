import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { buildHeaderPanelLines, buildItemsForQuestion, QuestionnaireSession } from "../seams.ts";

// Identity theme: renders bare text so assertions match visible content, not ANSI.
const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s } as unknown as Theme;

const CTX = "Goal: ship the dialog fixes. Progress: three merged. Decision: where the recall panel lives.";

describe("dialog header recall panel — buildHeaderPanelLines (string level)", () => {
	it("context brief in review language: muted ● label, → body", () => {
		expect(buildHeaderPanelLines(CTX, undefined, theme)).toEqual([" ● context", `   → ${CTX}`]);
	});

	it("multi-line context keeps one row per authored line, continuations under the body column", () => {
		expect(buildHeaderPanelLines("goal line\nprogress line\ndecision line", undefined, theme)).toEqual([
			" ● context",
			"   → goal line",
			"     progress line",
			"     decision line",
		]);
	});

	it("recent anchors join into one → row, decision-card style", () => {
		expect(buildHeaderPanelLines(CTX, ["src/db.ts", "#12"], theme)).toEqual([
			" ● context",
			`   → ${CTX}`,
			" ● recent",
			"   → src/db.ts; #12.",
		]);
	});

	it("skips empty recent entries and a blank context; fully-empty inputs render no panel", () => {
		expect(buildHeaderPanelLines(CTX, ["", "#12"], theme).at(-1)).toBe("   → #12.");
		expect(buildHeaderPanelLines("   ", ["a"], theme)).toEqual([" ● recent", "   → a."]);
		expect(buildHeaderPanelLines("   ", undefined, theme)).toEqual([]);
	});
});

describe("dialog header recall panel — rendered through the mounted session", () => {
	const questions = [
		{
			question: "Pick one?",
			header: "Pick",
			options: [
				{ label: "A", description: "" },
				{ label: "B", description: "" },
			],
		},
		{
			question: "Pick another?",
			header: "Second",
			options: [
				{ label: "C", description: "" },
				{ label: "D", description: "" },
			],
		},
	];

	function makeSession(): QuestionnaireSession {
		return new QuestionnaireSession({
			tui: { terminal: { columns: 100, rows: 40 }, requestRender: () => {} } as never,
			theme,
			params: { context: CTX, recent: ["src/db.ts", "#12"], questions: [...questions] },
			itemsByTab: questions.map((q) => buildItemsForQuestion({ ...q, options: [...q.options] })),
			done: () => {},
			keybindings: { matches: () => false },
			editInput: async () => undefined,
			collapseKey: "ctrl+]",
			canReopenWhileHidden: true,
			rowBudget: (rows) => rows,
		});
	}

	it("panel rows render directly under the top border on a question tab", () => {
		const rows = makeSession().component.render(100).map((r) => r.replace(/\s+$/, ""));
		// Index 0 is the top border row; the recall panel is its immediate successor —
		// the first content of the dialog head, above the tab bar and heading. Rows carry
		// Text's paddingX column plus the review language's own leading space.
		expect(rows.slice(1, 5)).toEqual(["  ● context", `    → ${CTX}`, "  ● recent", "    → src/db.ts; #12."]);
	});

	it("panel stays visible on the second question tab and the submit tab", () => {
		const session = makeSession();
		session.dispatch("\t"); // tab 0 → 1
		expect(session.component.render(100).some((r) => r.includes("● context"))).toBe(true);
		session.dispatch("\t"); // tab 1 → submit
		const submitRows = session.component.render(100);
		expect(submitRows.some((r) => r.includes("● context"))).toBe(true);
		expect(submitRows.some((r) => r.includes("● recent"))).toBe(true);
	});
});
