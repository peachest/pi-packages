import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectSkillRefs, expandResultInjection, expandSkillInjection } from "../tool/skill-expansion.ts";
import type { QuestionnaireResult } from "../tool/types.ts";

function makeSkillDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "skill-expansion-"));
	writeFileSync(
		join(dir, "SKILL.md"),
		`---\nname: my-skill\ndescription: demo\n---\n\n# Body line\nUse this when ${"x"} happens.\n`,
	);
	return dir;
}

const SKILL_DIR = makeSkillDir();
const SKILLS = [{ name: "skill:my-skill", path: join(SKILL_DIR, "SKILL.md"), baseDir: SKILL_DIR }];

describe("expandSkillInjection", () => {
	it("expands /skill:name into the full skill block", () => {
		const out = expandSkillInjection("/skill:my-skill", SKILLS);
		expect(out).toContain('<skill name="my-skill"');
		expect(out).toContain(`location="${join(SKILL_DIR, "SKILL.md")}"`);
		expect(out).toContain("References are relative to");
		expect(out).toContain("# Body line");
		expect(out).not.toContain("description: demo"); // frontmatter stripped
	});

	it("appends args after the block", () => {
		const out = expandSkillInjection("/skill:my-skill  选 B，理由：快", SKILLS);
		const blockEnd = out.indexOf("</skill>");
		expect(out.slice(blockEnd)).toBe(`</skill>\n\n选 B，理由：快`);
	});

	it("passes through unknown skills and non-skill text", () => {
		expect(expandSkillInjection("/skill:nope", SKILLS)).toBe("/skill:nope");
		expect(expandSkillInjection("请用 /skill:my-skill", SKILLS)).toBe("请用 /skill:my-skill");
		expect(expandSkillInjection("/skill:my-skill", [])).toBe("/skill:my-skill");
	});

	it("passes through when the file is unreadable", () => {
		const broken = [{ name: "skill:my-skill", path: join(SKILL_DIR, "missing.md") }];
		expect(expandSkillInjection("/skill:my-skill", broken)).toBe("/skill:my-skill");
	});
});

describe("collectSkillRefs", () => {
	it("keeps only skill-sourced commands with a path", () => {
		const refs = collectSkillRefs([
			{ name: "skill:my-skill", source: "skill", sourceInfo: { path: "/a/SKILL.md", source: "local", scope: "user", origin: "top-level", baseDir: "/a" } },
			{ name: "review", source: "extension", sourceInfo: { path: "/ext.ts", source: "local", scope: "project", origin: "top-level" } },
			{ name: "skill:ghost", source: "skill", sourceInfo: { source: "local", scope: "user", origin: "top-level" } },
		] as never);
		expect(refs).toEqual([{ name: "skill:my-skill", path: "/a/SKILL.md" }]);
	});
});

describe("expandResultInjection", () => {
	const base: QuestionnaireResult = { answers: [], cancelled: false };

	it("expands custom, multi and notes fields, leaves option/rephrase alone", () => {
		const result: QuestionnaireResult = {
			...base,
			answers: [
				{ questionIndex: 0, question: "q1", kind: "custom", answer: "/skill:my-skill" },
				{ questionIndex: 1, question: "q2", kind: "multi", selected: ["A"], answer: "/skill:my-skill 补充" },
				{ questionIndex: 2, question: "q3", kind: "option", answer: "/skill:my-skill", notes: "/skill:my-skill" },
				{ questionIndex: 3, question: "q4", kind: "rephrase", answer: null, reason: "/skill:my-skill" },
			],
			globalNote: "/skill:my-skill 备注",
		};
		const out = expandResultInjection(result, SKILLS)!;
		expect(out.answers[0]?.answer).toContain("<skill");
		expect(out.answers[1]?.answer).toContain("</skill>\n\n补充");
		expect(out.answers[2]?.answer).toBe("/skill:my-skill"); // option label untouched
		expect(out.answers[2]?.notes).toContain("<skill");
		expect(out.answers[3]?.reason).toBe("/skill:my-skill"); // rephrase reason untouched
		expect(out.globalNote).toContain("<skill");
	});

	it("keeps globalNote absent when the input had none", () => {
		const out = expandResultInjection({ ...base, answers: [{ questionIndex: 0, question: "q", kind: "custom", answer: "plain" }] }, SKILLS)!;
		expect("globalNote" in out).toBe(false);
	});

	it("returns the input untouched when no expansion happened", () => {
		expect(expandResultInjection(base, SKILLS)).toBe(base);
		expect(expandResultInjection(undefined, SKILLS)).toBeUndefined();
	});
});
