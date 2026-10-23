/**
 * pi-bash-guards — fixture-suite wrapper tests.
 *
 * The two canonical sh fixture suites (mined 2026-10-20, ~/tmp/hook-mining/)
 * are kept verbatim under tests/fixtures/ and executed here via spawn bash.
 * Each suite self-reports PASS/FAIL counts; we assert zero failures and the
 * expected minimum case counts so silent fixture loss fails CI.
 *
 * Suite A (test-bash-guards.sh): global regression, 46 cases — bare-cd,
 * docker→nerdctl, worktree→wt, commit/push --no-verify, G1 agent-dir
 * hand-copy, P2 git add -A, P3 long sleep. P1 (secrets) cases were
 * re-judged to allow after the P1 migration to pi-secret-store (#124).
 *
 * Suite B (test-p6-multiremote.sh): P6 commit-identity matrix, 29 cases —
 * multi-remote any-match semantics (github fork vs transwarp internal),
 * rtk wrapping, secret-store injection interplay, degrade paths.
 *
 * Suite C (test-wt-lifecycle.sh): worktree lifecycle guards R1-R4 (#138,
 * spec #137) — raw `git worktree remove/prune` -> wt remove, raw `git merge`
 * -> wt merge / pull --ff-only, cross-branch checkout/switch in a wt-layout
 * linked worktree (.git is a file, ~/projects/<repo>-<slug>) -> wt switch,
 * full-sha materialization and non-wt-layout trees exempt (#153),
 * `wt merge -y` approval flag, rtk prefix, main vs linked worktree boundary,
 * heredoc-body literal false-positive regression.
 *
 * GUARD env override points the fixtures at any guard script; default is the
 * packaged source (scripts/bash-guards.py), NOT the live synced copy — the
 * package tests its own source, `npm run sync` is responsible for parity.
 * Fixtures invoke `bash "$GUARD"`: the engine's exec-polyglot line makes the
 * pure-python file bash-executable (spec #142), so fixtures stay untouched.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PKG = resolve(__dirname, "..");
const GUARD = join(PKG, "scripts", "bash-guards.py");

interface SuiteResult {
	output: string;
	pass: number;
	fail: number;
}

function runSuite(fixture: string, env: Record<string, string>): SuiteResult {
	const out = execFileSync("bash", [join(PKG, "tests", "fixtures", fixture)], {
		env: { ...process.env, GUARD, ...env },
		encoding: "utf8",
		timeout: 120_000,
	});
	const pass = Number(/PASS=(\d+)/.exec(out)?.[1] ?? NaN);
	const fail = Number(/FAIL=(\d+)/.exec(out)?.[1] ?? NaN);
	if (Number.isNaN(pass) || Number.isNaN(fail)) {
		throw new Error(`fixture ${fixture} did not report PASS=/FAIL= summary:\n${out.slice(-2000)}`);
	}
	return { output: out, pass, fail };
}


function writeIdentityConf(home: string): void {
	const dir = join(home, ".pi", "agent");
	mkdirSync(dir, { recursive: true });
	const conf = [
		"gitblue.example=dev@corp.example",
		"gitlab.example=dev@corp.example",
		"github=dev@personal.example",
		"DEFAULT_EMAIL=dev@corp.example",
		"",
	].join("\n");
	writeFileSync(join(dir, "bash-guards-identity.conf"), conf);
}

describe("bash-guards fixture suite A (global regression)", () => {
	let sandbox: string;
	beforeAll(() => {
		// Suite A writes probe dirs under $HOME/tmp — point HOME at a sandbox
		// so the run never touches the real ~/.pi or ~/tmp.
		sandbox = mkdtempSync(join(tmpdir(), "pi-bash-guards-a-"));
		writeIdentityConf(sandbox);
		mkdirSync(join(sandbox, "tmp"), { recursive: true });
		mkdirSync(join(sandbox, ".pi", "agent", "sessions", "--mnt-disk1-hyx-projects--"), { recursive: true });
	});
	afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

	it("46 cases, zero failures", () => {
		const r = runSuite("test-bash-guards.sh", {
			HOME: sandbox,
			// fixtures reference $HOME/tmp/p6-fixtures and session slug dirs
		});
		console.log(r.output.split("\n").filter((l) => l.startsWith("FAIL")).join("\n"));
		expect(r.fail, `suite A failures:\n${r.output.split("\n").filter((l) => l.includes("FAIL")).join("\n")}`).toBe(0);
		expect(r.pass).toBeGreaterThanOrEqual(46);
	});
});

describe("bash-guards fixture suite B (P6 multi-remote matrix)", () => {
	let sandbox: string;
	beforeAll(() => {
		// Suite B git-inits real fixture repos under $HOME/tmp/p6-fixtures and
		// needs a git identity (commit -m x with inline -c user.email mostly,
		// but global default is consulted too).
		sandbox = mkdtempSync(join(tmpdir(), "pi-bash-guards-b-"));
		writeIdentityConf(sandbox);
		mkdirSync(join(sandbox, "tmp"), { recursive: true });
		execFileSync("git", ["config", "--global", "user.email", "dev@corp.example"], {
			env: { ...process.env, HOME: sandbox },
		});
		execFileSync("git", ["config", "--global", "user.name", "test"], {
			env: { ...process.env, HOME: sandbox },
		});
		execFileSync("git", ["config", "--global", "--add", "safe.directory", "*"], {
			env: { ...process.env, HOME: sandbox },
		});
	});
	afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

	it("27 counted cases (29 t-calls, 1 pair re-judged), zero failures", () => {
		const r = runSuite("test-p6-multiremote.sh", { HOME: sandbox });
		console.log(r.output.split("\n").filter((l) => l.startsWith("FAIL")).join("\n"));
		expect(r.fail, `suite B failures:\n${r.output.split("\n").filter((l) => l.includes("FAIL")).join("\n")}`).toBe(0);
		// Fixture self-count: 29 t-calls minus 1 re-judged pair (PASS-1/FAIL-1
		// in the pushDefault section documents the any-match semantic) = 27.
		expect(r.pass).toBeGreaterThanOrEqual(27);
	});
});

describe("bash-guards fixture suite C (worktree lifecycle R1-R4)", () => {
	let sandbox: string;
	beforeAll(() => {
		// Suite C git-inits a main checkout + a linked worktree under
		// $HOME/tmp/guardc-fixtures; point HOME at a sandbox like suite A.
		sandbox = mkdtempSync(join(tmpdir(), "pi-bash-guards-c-"));
		writeIdentityConf(sandbox);
		mkdirSync(join(sandbox, "tmp"), { recursive: true });
	});
	afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

	it("95 cases, zero failures", () => {
		const r = runSuite("test-wt-lifecycle.sh", { HOME: sandbox });
		console.log(r.output.split("\n").filter((l) => l.startsWith("FAIL")).join("\n"));
		expect(r.fail, `suite C failures:\n${r.output.split("\n").filter((l) => l.includes("FAIL")).join("\n")}`).toBe(0);
		expect(r.pass).toBeGreaterThanOrEqual(95);
	});
});

describe("bash-guards fixture suite D (subagent SA1-SA4)", () => {
	let sandbox: string;
	beforeAll(() => {
		sandbox = mkdtempSync(join(tmpdir(), "pi-bash-guards-d-"));
	});
	afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

	it("19 cases, zero failures", () => {
		const r = runSuite("test-subagent-guards.sh", { HOME: sandbox });
		console.log(r.output.split("\n").filter((l) => l.startsWith("FAIL")).join("\n"));
		expect(r.fail, `suite D failures:\n${r.output.split("\n").filter((l) => l.includes("FAIL")).join("\n")}`).toBe(0);
		expect(r.pass).toBeGreaterThanOrEqual(19);
	});
});

describe("packaged guard sanity (direct payload probes)", () => {
	it("blocks docker in command position (global guard, any cwd)", () => {
		let blocked = false;
		try {
			execFileSync("python3", [GUARD], {
				input: JSON.stringify({
					tool_input: { command: "docker ps" },
					transcript_path: "/tmp/anywhere/x.jsonl",
					session_id: "t",
				}),
				encoding: "utf8",
			});
		} catch (e) {
			blocked = (e as { status?: number }).status === 2;
		}
		expect(blocked).toBe(true);
	});

	it("allows plain ls (exit 0)", () => {
		const out = execFileSync("python3", [GUARD], {
			input: JSON.stringify({
				tool_input: { command: "ls -la" },
				transcript_path: "/tmp/anywhere/x.jsonl",
				session_id: "t",
			}),
			encoding: "utf8",
		});
		expect(out).toBeDefined();
	});
});
