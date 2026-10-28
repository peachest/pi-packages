/**
 * pi-bash-guards — golden verdict regression (spec #142 steps 1/3).
 *
 * Re-runs the capture harness (tests/golden/capture.sh) against the packaged
 * engine and diffs it against the committed archive (tests/golden/
 * verdicts.jsonl, captured from the pre-migration engine). A non-empty diff
 * is a semantic drift and fails CI — the zero-drift gate stays enforceable
 * after the one-time migration.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const PKG = resolve(__dirname, "..");
const GUARD = join(PKG, "scripts", "bash-guards.py");
const GOLDEN = join(PKG, "tests", "golden", "verdicts.jsonl");

describe("bash-guards golden verdict archive (zero semantic drift)", () => {
	let work: string;
	afterAll(() => rmSync(work, { recursive: true, force: true }));

	it("fresh capture matches the committed archive byte-for-byte", () => {
		// explicit timeout: the package vitest.config.ts sets 300s, but root-level
		// vitest runs bypass it — capture takes ~30s (fixture suites + git init).
		work = mkdtempSync(join(tmpdir(), "pi-bash-guards-golden-"));
		const fresh = join(work, "verdicts-fresh.jsonl");
		execFileSync("bash", [join(PKG, "tests", "golden", "capture.sh"), GUARD, fresh], {
			cwd: PKG,
			encoding: "utf8",
			timeout: 300_000,
		});
		const expected = readFileSync(GOLDEN, "utf8");
		const actual = readFileSync(fresh, "utf8");
		expect(actual, "golden verdict drift — diff tests/golden/verdicts.jsonl against a fresh capture").toBe(expected);
	}, 300_000);
});
