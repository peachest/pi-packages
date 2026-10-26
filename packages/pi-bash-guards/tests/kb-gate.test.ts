/**
 * pi-bash-guards — KB gate tests (ticket #166, reflowed from the kendex
 * deployed copy 2026-10-26).
 *
 * The gate blocks cluster/service probing (kubectl/crictl/journalctl/dmesg/
 * nvidia-smi) once per session until ANY command touches the diagnosis vault
 * (~/ops or llmops-wiki). Design invariants under test:
 *
 * - narrow trigger surface: only cluster-runtime probes gate; helm/nerdctl
 *   and every other command stay ungated
 * - touch = satisfy: a vault command opens the gate for the whole session
 *   (flag file model), so writing a diagnosis is itself the satisfying action
 * - fail-open: no transcript, unwritable state dirs — never block
 * - state isolation: each session's flag is keyed by transcript path
 * - verdict shape: first probe is a block (exit 2, message routes to the
 *   vault search); post-touch probe passes (exit 0) and appends to the
 *   monthly read log
 *
 * State dir override: the engine hardcodes ~/.pi/agent/kendex/state/kb, so
 * tests run the engine under a HOME sandbox (see probe helper) instead of
 * patching the source.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const GUARD = resolve(__dirname, "..", "scripts", "bash-guards.py");

/** Sandbox HOME: the engine expands ~ for its flag/log state, so a fake HOME
 * isolates every test's gate state. transcript must live under the fake home
 * too (session key = transcript path hash). */
function probe(home: string, cmd: string, transcript: string): { status: number; out: string } {
	try {
		const out = execFileSync("python3", [GUARD], {
			input: JSON.stringify({
				tool_input: { command: cmd },
				transcript_path: transcript,
				session_id: "t",
			}),
			encoding: "utf8",
			env: { ...process.env, HOME: home },
		});
		return { status: 0, out };
	} catch (e) {
		const err = e as { status?: number; stdout?: string; stderr?: string };
		return { status: err.status ?? -1, out: String(err.stdout ?? "") + String(err.stderr ?? "") };
	}
}

describe("KB gate (#166)", () => {
	let home: string;
	let transcript: string;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "kb-gate-"));
		// transcript under a sessions-ish path whose slug encodes a projects cwd
		// (the engine's in_projects gate reads the slug dir name); content is
		// irrelevant (session key = transcript path hash)
		transcript = join(home, "sessions", "--mnt-disk1-hyx-projects-proj--", "s1.jsonl");
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	it("blocks first cluster probe, message routes to the vault search (three elements)", () => {
		const r = probe(home, "kubectl get pods -n prod", transcript);
		expect(r.status).toBe(2);
		// three elements: reason (gate/audit), replacement (rg on ~/ops), example (quoted command form)
		expect(r.out).toMatch(/KB gate/);
		expect(r.out).toMatch(/rg -l/);
		expect(r.out).toMatch(/~/); // example carries the ~/ops path form
	});

	it("touch opens the gate for the rest of the session (flag file model)", () => {
		expect(probe(home, "kubectl get pods", transcript).status).toBe(2);
		// touching the vault satisfies: any form (read/search/write) counts.
		// Use literal ~/ops (the KB_TOUCH pattern matches the ~/ form, not an
		// absolute tmpdir path) — the gate reads command text only, never executes.
		expect(probe(home, "rg -il 'oom' ~/ops/*.md", transcript).status).toBe(0);
		// now the same probe passes
		expect(probe(home, "kubectl get pods", transcript).status).toBe(0);
		// llmops-wiki mention also satisfies
		const t2 = join(home, "sessions", "--mnt-disk1-hyx-projects-proj--", "s2.jsonl");
		expect(probe(home, "kubectl top nodes", t2).status).toBe(2);
		expect(probe(home, "cat ~/projects/llmops-wiki/GLOSSARY-MAP.md", t2).status).toBe(0);
		expect(probe(home, "kubectl top nodes", t2).status).toBe(0);
	});

	it("narrow trigger: non-cluster commands never gate", () => {
		expect(probe(home, "helm list", transcript).status).toBe(0);
		expect(probe(home, "sudo nerdctl ps", transcript).status).toBe(0);
		expect(probe(home, "kubectl describe node n1", transcript).status).toBe(2); // control: gate works
	});

	it("fail-open: no transcript → never blocks", () => {
		expect(probe(home, "kubectl get pods", "").status).toBe(0);
	});

	it("state isolation: different transcripts gate independently", () => {
		const t1 = join(home, "sessions", "--mnt-disk1-hyx-projects-a--", "a.jsonl");
		const t2 = join(home, "sessions", "--mnt-disk1-hyx-projects-b--", "b.jsonl");
		expect(probe(home, "dmesg | tail", t1).status).toBe(2);
		// session 1 satisfied; session 2 still gated
		expect(probe(home, "cat ~/ops/index.md", t1).status).toBe(0);
		expect(probe(home, "dmesg | tail", t2).status).toBe(2);
	});

	it("appends gate decisions to the monthly read log", () => {
		probe(home, "kubectl get pods", transcript); // block
		probe(home, "cat ~/ops/index.md", transcript); // satisfy
		probe(home, "kubectl get pods", transcript); // pass
		const kbDir = join(home, ".pi", "agent", "kendex", "state", "kb");
		expect(existsSync(kbDir)).toBe(true);
		const log = readFileSync(join(kbDir, "readlog-" + new Date().toISOString().slice(0, 7).replace("-", "") + ".jsonl"), "utf8");
		const kinds = log.trim().split("\n").map((l) => (JSON.parse(l) as { kind: string }).kind);
		expect(kinds).toEqual(["block", "satisfy", "pass"]);
	});
});
