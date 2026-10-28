/**
 * pi-bash-guards — matcher command-position semantics.
 *
 * Absorbed from scripts/verify-command-position.py (its one-off, never-wired
 * predecessor). Asserts the anchored matchers block executions and pass
 * string/comment/heredoc literals — the full-text false-block regression
 * spec #137 locked in. Calls the engine's matchers directly (not through the
 * hook payload path), so quoting the guarded literals here is safe.
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const GUARD = resolve(__dirname, "..", "scripts", "bash-guards.py");

// [matcher, command, expectBlocked]
const CASES: Array<["p2" | "p3" | "sleep_chain", string, boolean]> = [
	// P2 git add -A: command position vs literal
	["p2", "git add -A && git commit -m x", true],
	["p2", "git add --all", true],
	["p2", "git add .", true],
	["p2", "cd ~/proj && git add -A && git commit", true],
	["p2", "echo 'run git add -A first'", false],
	["p2", "# comment: git add -A\necho hi", false],
	["p2", "cat > f <<EOF\ngit add -A\nEOF\necho done", false],
	["p2", "echo hello", false],
	["p2", "git add packages/x/y.ts", false], // explicit-path add: legal
	["p2", 'git commit -m "will git add -A later"', false], // string arg mention
	// P3 long sleep: threshold + literal immunity
	["p3", "sleep 90", true],
	["p3", "sleep 30", false],
	["p3", 'echo "sleep 120"', false],
	["p3", "# sleep 300\necho hi", false],
	["p3", "cat > f <<EOF\nsleep 120\nEOF\necho done", false],
	["p3", "cd /x && sleep 5m", true],
	["p3", "sleep 1h", true],
	["p3", "sleep 59", false],
	// sleep-chain: chained sleep blocked, trailing sleep allowed, literal immune
	["sleep_chain", "sleep 5 && curl -sf http://x/health", true],
	["sleep_chain", "sleep 30; kubectl get pods", true],
	["sleep_chain", "sleep 5", false],
	["sleep_chain", "sleep 5m", false],
	["sleep_chain", 'echo "sleep 5 && poll"', false],
];

const RUNNER = `
import importlib.util, json, sys
sys.dont_write_bytecode = True  # importing the engine must not leave __pycache__ in scripts/
spec = importlib.util.spec_from_file_location("bg", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
fns = {"p2": mod._match_p2, "p3": mod._match_p3, "sleep_chain": mod._match_sleep_chain}
out = [fns[e["m"]]({"cmd": e["c"]}) is not None for e in json.loads(sys.argv[2])]
print(json.dumps(out))
`;

describe("bash-guards matcher command-position semantics", () => {
	it("blocks executions, passes literals (P2 / P3 / sleep-chain)", () => {
		const out = execFileSync(
			"python3",
			["-c", RUNNER, GUARD, JSON.stringify(CASES.map(([m, c]) => ({ m, c })))],
			{ encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } },
		);
		const got: boolean[] = JSON.parse(out);
		CASES.forEach(([m, c, want], i) => {
			expect(got[i], `${m}: ${c.slice(0, 60)}`).toBe(want);
		});
	});
});
