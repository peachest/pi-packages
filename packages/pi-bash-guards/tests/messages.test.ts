/**
 * pi-bash-guards — three-element message assertions (spec #142 step 4).
 *
 * Every block message must carry the three elements (reason + correct
 * replacement command + example) — "the model must not have to guess"
 * upgraded from convention to CI invariant. Each of the 15 verdict messages
 * (12 table entries; no-verify/G1/P6 hold two templates each) is rendered
 * through the engine's own render_message and asserted to contain its
 * recommended-command token.
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const GUARD = resolve(__dirname, "..", "scripts", "bash-guards.py");

const RENDERER = `
import importlib.util, json, sys
sys.dont_write_bytecode = True  # importing the engine must not leave __pycache__ in scripts/
spec = importlib.util.spec_from_file_location("bg", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
out = [mod.render_message(mod.MESSAGES[e["msg"]], e["params"]) for e in json.loads(sys.argv[2])]
print(json.dumps(out, ensure_ascii=False))
`;

// [message key, params, required recommended-command token]
const CASES: Array<[string, Record<string, unknown>, string]> = [
	["bare-cd", {}, "(cd <dir> && <command>)"],
	["docker", { args: "ps" }, "sudo nerdctl ps"],
	["worktree-add", {}, "wt switch -c <branch>"],
	["R1", {}, "wt remove <branch>"],
	["R2", {}, "git pull --ff-only"],
	["R3", {}, "wt switch <branch>"],
	["R4", {}, "wt merge"],
	["no-verify", { sub: "commit" }, "bash .git/hooks/pre-commit"],
	["no-verify", { sub: "push" }, "gitleaks git --log-opts"],
	["G1", { kind: "var", dest: "$X/y" }, "rerun with a literal path"],
	["G1", { kind: "dest" }, "pi install npm:<name>"],
	["P2", {}, "git add <file1> <file2>"],
	["P3", { spec: "2h", seconds: 7200 }, "subscribe"],
	["P6", { kind: "inline", inline: "stranger@x.y", platform: "github", expected: "dev@personal.example" }, "Commit with the matching identity"],
	["P6", { kind: "email", email: "stranger@x.y", platform: "github", expected: "dev@personal.example", suggest: "dev@personal.example" }, "git config user.email dev@personal.example"],
];

const PYENV = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }; // no __pycache__ in scripts/

describe("bash-guards message three-element contract (spec #142)", () => {
	it("renders all 15 verdict messages with their recommended-command token", () => {
		const out = execFileSync(
			"python3",
			["-c", RENDERER, GUARD, JSON.stringify(CASES.map(([msg, params]) => ({ msg, params })))],
			{ encoding: "utf8", env: PYENV },
		);
		const rendered: string[] = JSON.parse(out);
		expect(rendered).toHaveLength(CASES.length);
		CASES.forEach(([, , token], i) => {
			expect(rendered[i], `message case #${i} (${JSON.stringify(CASES[i][2])})`).toContain(token);
		});
	});

	it("every rule table entry is well-formed and its message template exists", () => {
		const out = execFileSync(
			"python3",
			["-c", `import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("bg", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
print(json.dumps([{ "id": r["id"], "scope": r["scope"], "hasMatcher": callable(r["matcher"]) or isinstance(r["matcher"], str), "msg": r["message"] in mod.MESSAGES} for r in mod.RULES]))`, GUARD],
			{ encoding: "utf8", env: PYENV },
		);
		const rules: Array<{ id: string; scope: string; hasMatcher: boolean; msg: boolean }> = JSON.parse(out);
		expect(rules).toHaveLength(12);
		for (const r of rules) {
			expect(r.scope === "global" || r.scope === "projects", `${r.id} scope`).toBe(true);
			expect(r.hasMatcher, `${r.id} matcher`).toBe(true);
			expect(r.msg, `${r.id} message template`).toBe(true);
		}
		expect(rules.filter((r) => r.scope === "projects").map((r) => r.id)).toEqual(["P2", "P3", "P6"]);
	});
});
