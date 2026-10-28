/**
 * 只读 CLI 出口（#191）：编译产物 dist/cli.js 的进程级行为测试。
 * beforeAll 真跑 tsc（tsconfig.cli.json）编译，spawn node 直跑产物——测生产形态，不做 in-process import。
 * 协议契约：凭据值走 stdout 单行，一切诊断走 stderr + 非零退出（fail-closed，绝不输出空串当凭据）。
 */
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { updateStore, type Store } from "../index.ts";
import { hasRealAge } from "./helpers.ts";

const exec = promisify(execFile);
const pkgRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = join(pkgRoot, "..", "..");
const cliJs = join(pkgRoot, "dist", "cli.js");

interface CliResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** spawn node 直跑编译产物；envOverrides 值为 undefined 的键从子进程环境剥除（不让外层进程环境漏进来）。 */
const runCli = (args: string[], envOverrides: Record<string, string | undefined>): Promise<CliResult> =>
	new Promise((resolve, reject) => {
		const env: Record<string, string> = {};
		for (const [k, v] of Object.entries({ ...process.env, ...envOverrides })) if (v !== undefined) env[k] = v;
		const child = spawn(process.execPath, [cliJs, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
		child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
		child.on("error", reject);
		child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
	});

const createdDirs: string[] = [];
afterAll(async () => {
	await Promise.all(createdDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** CLI 沙箱：独立 agentDir + conf 定向后端；store 走明文 json 预置（age 形态经 updateStore 真加密）。 */
const sandbox = async (backend: "age" | "plain", store?: Store): Promise<string> => {
	const dir = await mkdtemp(join(tmpdir(), "pi-secret-store-cli-test-"));
	createdDirs.push(dir);
	await writeFile(join(dir, "secret-store.conf"), `backend = ${backend}\n`, { mode: 0o600 });
	if (store)
		await writeFile(join(dir, "secret-store.json"), `${JSON.stringify({ secrets: store }, null, 2)}\n`, { mode: 0o600 });
	return dir;
};

const fixture = (value: string): Store => ({
	TF_PASSWORD: { value, updatedAt: "2026-01-01T00:00:00.000Z", fingerprint: "fp-test" },
});

beforeAll(async () => {
	// 编译产物 gitignored：测试自产自销，不依赖仓库预先 build（与 age.test.ts 探测本机 age 同款前置思路）
	await exec(
		process.execPath,
		[join(repoRoot, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.cli.json"],
		{ cwd: pkgRoot },
	);
});

describe("pi-secret-store get CLI（#191）", () => {
	it("成功：plain 后端输出单行凭据值（stdout 纯净，stderr 空）", async () => {
		const dir = await sandbox("plain", fixture("s3cr3t-value"));
		const r = await runCli(["get", "TF_PASSWORD"], { PI_CODING_AGENT_DIR: dir });
		expect(r.code).toBe(0);
		expect(r.stdout).toBe("s3cr3t-value\n"); // 单行 + 尾随换行（上游 resolveCommandSecret 会 trim）
		expect(r.stderr).toBe("");
	});

	it.skipIf(!hasRealAge)(
		"成功：age 后端复用扩展同款解密链（updateStore 真加密 → CLI 读回单行值）",
		async () => {
			const dir = await sandbox("age");
			const ageBin = join(process.env.HOME ?? "/nonexistent", ".local", "bin", "age");
			const saved = process.env.PI_SECRET_STORE_AGE_BIN;
			process.env.PI_SECRET_STORE_AGE_BIN = ageBin;
			try {
				await updateStore(dir, () => fixture("age-encrypted-value"));
			} finally {
				if (saved === undefined) delete process.env.PI_SECRET_STORE_AGE_BIN;
				else process.env.PI_SECRET_STORE_AGE_BIN = saved;
			}
			const r = await runCli(["get", "TF_PASSWORD"], { PI_CODING_AGENT_DIR: dir });
			expect(r.code).toBe(0);
			expect(r.stdout).toBe("age-encrypted-value\n");
			expect(r.stderr).toBe("");
		},
	);

	it("不存在名：非零退出 + stdout 严格为空（fail-closed，绝不输出空串当凭据）", async () => {
		const dir = await sandbox("plain", fixture("s3cr3t-value"));
		const r = await runCli(["get", "NO_SUCH_NAME"], { PI_CODING_AGENT_DIR: dir });
		expect(r.code).not.toBe(0);
		expect(r.stdout).toBe("");
		expect(r.stderr).toContain("NO_SUCH_NAME");
	});

	it("后端不可用：age 二进制缺失 → 非零退出 + stdout 空 + stderr 含指引", async () => {
		const dir = await sandbox("age");
		const r = await runCli(["get", "TF_PASSWORD"], {
			PI_CODING_AGENT_DIR: dir,
			PI_SECRET_STORE_AGE_BIN: "/nonexistent/age",
		});
		expect(r.code).not.toBe(0);
		expect(r.stdout).toBe("");
		expect(r.stderr).toContain("age");
	});

	it("解密失败：假 age（exit 1）→ 非零退出 + stdout 空 + stderr 明确报错", async () => {
		const dir = await sandbox("age");
		await writeFile(join(dir, "secret-store.json.age"), "not-a-ciphertext", { mode: 0o600 });
		const r = await runCli(["get", "TF_PASSWORD"], {
			PI_CODING_AGENT_DIR: dir,
			PI_SECRET_STORE_AGE_BIN: "/bin/false",
		});
		expect(r.code).not.toBe(0);
		expect(r.stdout).toBe("");
		expect(r.stderr).toContain("解密失败");
	});

	it("stdout 纯净性：load 告警（非法条目跳过）走 stderr，凭据值不受诊断污染", async () => {
		const dir = await sandbox("plain", {
			TF_PASSWORD: { value: "good-value-1", updatedAt: "2026-01-01T00:00:00.000Z", fingerprint: "fp" },
			// 短于 MIN_REDACT_LENGTH=4 → load 宽松跳过并 onWarning：诊断必须只出现在 stderr
			BAD_ENTRY: { value: "ab", updatedAt: "2026-01-01T00:00:00.000Z", fingerprint: "fp" },
		});
		const r = await runCli(["get", "TF_PASSWORD"], { PI_CODING_AGENT_DIR: dir });
		expect(r.code).toBe(0);
		expect(r.stdout).toBe("good-value-1\n");
		expect(r.stderr).toContain("BAD_ENTRY"); // 告警确实发生，且只在 stderr
	});

	it("用法错误与写面拒绝：缺参数/未知子命令 → 非零退出 + stdout 空；set 子命令不存在（写面保持扩展独占）", async () => {
		const dir = await sandbox("plain");
		const noArgs = await runCli([], { PI_CODING_AGENT_DIR: dir });
		expect(noArgs.code).not.toBe(0);
		expect(noArgs.stdout).toBe("");
		const wrongCmd = await runCli(["set", "X", "y"], { PI_CODING_AGENT_DIR: dir });
		expect(wrongCmd.code).not.toBe(0);
		expect(wrongCmd.stdout).toBe("");
	});
});
