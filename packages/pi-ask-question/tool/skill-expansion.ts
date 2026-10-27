import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import type { QuestionAnswer, QuestionnaireResult } from "./types.ts";

/**
 * Submit-time `/skill:` injection: a user-typed free-text answer that starts with
 * `/skill:<name> args` is expanded into the full `<skill>` block (SKILL.md body,
 * frontmatter stripped) before it reaches the LLM-facing envelope — the same
 * expansion the host applies to `/skill:` in its own input (agent-session
 * `_expandSkillCommand`). Unknown commands pass through untouched.
 */

const SKILL_PREFIX = "/skill:";
const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;
export interface SkillRef {
	/** Full command name as returned by `pi.getCommands()` — `skill:<name>`. */
	name: string;
	/** Absolute path of the skill's SKILL.md. */
	path: string;
}

/** Skill entries from the host's command list; anything without a resolvable path is dropped. */
export function collectSkillRefs(commands: readonly SlashCommandInfo[]): SkillRef[] {
	return commands
		.filter((c) => c.source === "skill" && c.sourceInfo?.path)
		.map((c) => ({ name: c.name, path: c.sourceInfo.path }));
}

function stripFrontmatter(content: string): string {
	return FRONTMATTER_RE.test(content) ? content.replace(FRONTMATTER_RE, "") : content;
}

/** Expand one typed text. Mirrors the host's `_expandSkillCommand` byte for byte. */
export function expandSkillInjection(text: string, skills: readonly SkillRef[]): string {
	if (!text.startsWith(SKILL_PREFIX) || skills.length === 0) return text;
	const spaceIndex = text.indexOf(" ");
	const command = spaceIndex === -1 ? text : text.slice(0, spaceIndex);
	const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();
	const skill = skills.find((s) => s.name === command.slice(1));
	if (!skill) return text; // Unknown skill — pass through, same as the host.
	try {
		const body = stripFrontmatter(readFileSync(skill.path, "utf-8")).trim();
		const skillName = command.slice(SKILL_PREFIX.length);
		// `sourceInfo.baseDir` is the skills scan root in some host versions, not the
		// skill dir — derive the reference base from the file location, as the host does.
		const baseDir = dirname(skill.path);
		const block = `<skill name="${skillName}" location="${skill.path}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`;
		return args ? `${block}\n\n${args}` : block;
	} catch {
		return text; // Unreadable file — pass through rather than fail the submit.
	}
}

const USER_TYPED_ANSWER_KINDS: ReadonlySet<QuestionAnswer["kind"]> = new Set(["custom", "multi"]);

/** Inline-input suggestion state: candidates are full command names (`skill:<name>`). */
export interface SkillSuggest {
	candidates: string[];
	/** Index into `candidates`, clamped to range. */
	selected: number;
}

/**
 * Suggest state for a typed buffer: open only while the buffer is a bare `/`-command
 * fragment (starts with `/`, no whitespace yet) and at least one skill name contains
 * the text after `/` (substring, case-insensitive — `/way` finds `skill:wayfinder`).
 */
export function skillSuggestFor(buffer: string, skillNames: readonly string[], selectedIndex: number): SkillSuggest | null {
	if (!buffer.startsWith("/") || /\s/.test(buffer) || skillNames.length === 0) return null;
	const typed = buffer.slice(1).toLowerCase();
	const candidates = skillNames.filter((n) => n.toLowerCase().includes(typed));
	if (candidates.length === 0) return null;
	const selected = Math.max(0, Math.min(selectedIndex, candidates.length - 1));
	return { candidates, selected };
}

/** Expand every user-typed free-text field of a result (custom/multi answer, per-question notes, global note). */
export function expandResultInjection(
	result: QuestionnaireResult | null | undefined,
	skills: readonly SkillRef[],
): QuestionnaireResult | null | undefined {
	if (!result || skills.length === 0) return result;
	let changed = false;
	const answers = result.answers.map((a) => {
		const answerExpanded =
			a.answer !== null && USER_TYPED_ANSWER_KINDS.has(a.kind) && a.answer.startsWith(SKILL_PREFIX)
				? expandSkillInjection(a.answer, skills)
				: a.answer;
		const notesExpanded = a.notes?.startsWith(SKILL_PREFIX) ? expandSkillInjection(a.notes, skills) : a.notes;
		if (answerExpanded !== a.answer || notesExpanded !== a.notes) {
			changed = true;
			return { ...a, ...(answerExpanded !== a.answer ? { answer: answerExpanded } : {}), ...(notesExpanded !== a.notes ? { notes: notesExpanded } : {}) };
		}
		return a;
	});
	const globalNote =
		result.globalNote !== undefined && result.globalNote.startsWith(SKILL_PREFIX)
			? expandSkillInjection(result.globalNote, skills)
			: result.globalNote;
	if (globalNote !== result.globalNote) changed = true;
	// `globalNote` rides a conditional-spread contract — only spread it back when it actually changed.
	return changed ? { ...result, answers, ...(globalNote !== result.globalNote ? { globalNote } : {}) } : result;
}
