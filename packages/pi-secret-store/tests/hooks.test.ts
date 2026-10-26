/**
 * 钩子链单测（走入口）：tool_call 选择性注入语义锁（#170：引用什么注入什么 / 没引用不注入 /
 * 未存名不注入）、值特殊字符逐变量 shellQuote、env 文件退役、存储 guard（bash resolved 变体 +
 * read 类文件工具，[7]，#170 后只保护 store json）、顺序（P1 检测在注入前，block 时不注入）、
 * fail closed（[6]）、redactor 累积（[4]）。
 */
import { execFile } from "node:child_process";
import { stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupEnv, runToolCall, setupHarness, toolResultEvent } from "./helpers.ts";

const bashRun = promisify(execFile);

afterEach(cleanupEnv);

describe("tool_call：选择性注入（#170，原地 mutate）", () => {
	it("语义锁①引用什么注入什么：$NAME/${NAME} 拼写、原地 mutate、原命令保持完整在后", async () => {
		const h = await setupHarness({
			A_TOKEN: { value: "a-token-value-1", updatedAt: "t", fingerprint: "fp0000aa11" },
			B_TOKEN: { value: "b-token-value-2", updatedAt: "t", fingerprint: "fp0000bb22" },
			C_TOKEN: { value: "c-token-value-3", updatedAt: "t", fingerprint: "fp0000cc33" },
		});
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const cmd = `printf '%s' "$A_TOKEN \${B_TOKEN}"`;
		const { event, result } = await runToolCall(h, cmd);
		expect(result).toBeUndefined(); // 注入不返回值
		expect(event.input.command).toBe(
			`: __PI_SECRET_STORE__; export A_TOKEN='a-token-value-1' B_TOKEN='b-token-value-2'; ${cmd}`,
		);
		expect(event.input.command).not.toContain("C_TOKEN"); // 未引用的不进环境
	});

	it("非 bash 工具不注入", async () => {
		const h = await setupHarness();
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const { event, result } = await runToolCall(h, "some/path", "read");
		expect(result).toBeUndefined();
		expect(event.input.command).toBe("some/path"); // read 的 input.command 原样（未被注入触碰）
	});

	it("语义锁②没引用不注入：空前缀，命令与无凭证库时逐字节一致（不报错）", async () => {
		const h = await setupHarness({ A_TOKEN: { value: "a-token-value-1", updatedAt: "t", fingerprint: "fp0000aa11" } });
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const { event, result } = await runToolCall(h, "go build ./...");
		expect(result).toBeUndefined();
		expect(event.input.command).toBe("go build ./..."); // 无 marker、无 export、无任何前缀
	});

	it("语义锁③未存名不注入且不影响其他名：静默跳过（P1 白名单语义）", async () => {
		const h = await setupHarness({ A_TOKEN: { value: "a-token-value-1", updatedAt: "t", fingerprint: "fp0000aa11" } });
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const { event, result } = await runToolCall(h, `printf '%s' "$MISSING_TOKEN $A_TOKEN"`);
		expect(result).toBeUndefined(); // 不报错
		expect(event.input.command).toContain("export A_TOKEN='a-token-value-1'");
		expect(event.input.command).not.toContain("MISSING_TOKEN='");
		// 纯未存名引用：命令完全不动
		const { event: e2 } = await runToolCall(h, `printf '%s' "$MISSING_TOKEN"`);
		expect(e2.input.command).toBe(`printf '%s' "$MISSING_TOKEN"`);
	});

	it("值含特殊字符：逐变量 shellQuote 不破坏命令，bash 实取逐字节还原（[4]/[11]）", async () => {
		const values: Record<string, string> = {
			A_CMD: "$(printf changed)",
			B_HOME: "$HOME",
			C_BT: "`id`",
			D_NL: "line1\nline2",
			E_Q: "it's",
		};
		const h = await setupHarness(
			Object.fromEntries(Object.entries(values).map(([n, v]) => [n, { value: v, updatedAt: "t", fingerprint: "f" }])),
		);
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const refs = Object.keys(values).map((n) => `$${n}`).join("|");
		const { event } = await runToolCall(h, `printf '%s' "${refs}" | base64 -w0`);
		const { stdout } = await bashRun("bash", ["-c", event.input.command]);
		const got = Buffer.from(stdout.trim(), "base64").toString("utf8").split("|");
		expect(got).toEqual(Object.values(values));
	});
});

describe("session_start：env 文件退役（#170）", () => {
	it("不再生成 env 文件；遗留 env 文件被物理删除；guard 不再拦 env 路径", async () => {
		const h = await setupHarness({ A_TOKEN: { value: "a-token-value-1", updatedAt: "t", fingerprint: "fp0000aa11" } });
		await writeFile(join(h.agentDir, "secret-store.env"), "A_TOKEN='legacy-value'\n", { mode: 0o600 });
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		await expect(stat(join(h.agentDir, "secret-store.env"))).rejects.toThrow(/ENOENT/);
		const { result, event } = await runToolCall(h, `cat ${h.agentDir}/secret-store.env`);
		expect(result).toBeUndefined(); // guard 只保护 store json
		expect(event.input.command).toBe(`cat ${h.agentDir}/secret-store.env`); // 无 $ 引用 → 无注入
	});
});

describe("tool_call：存储 guard（拦读存储文件本身）", () => {
	it("读 secret-store.json → block，文案引导用 secret_query，且不注入前缀", async () => {
		const h = await setupHarness();
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const { event, result } = await runToolCall(h, `cat ${h.agentDir}/secret-store.json`);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("secret_query");
		expect(event.input.command).not.toContain("__PI_SECRET_STORE__"); // guard 拦截 → 无注入
	});

	it("路径变体不再绕过字面子串：~/.. 拼写与 cwd 相对路径同样拦截（[7]）", async () => {
		const h = await setupHarness();
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		// `..` 变体：字面子串不包含 storePath，resolve 归一后命中
		const variant = join(h.agentDir, "..", basename(h.agentDir), "secret-store.json");
		const dot = await runToolCall(h, `cat ${variant}`);
		expect(dot.result?.block).toBe(true);
		// 相对路径 + ctx.cwd=agentDir
		const rel = await runToolCall(h, "cat ./secret-store.json", "bash", { cwd: h.agentDir });
		expect(rel.result?.block).toBe(true);
	});

	it("read/grep 类文件工具的 path 指向存储文件 → block（文案同，[7]）", async () => {
		const h = await setupHarness();
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const r = await runToolCall(h, { path: `${h.agentDir}/secret-store.json` }, "read");
		expect(r.result?.block).toBe(true);
		expect(r.result?.reason).toContain("secret_query");
		const g = await runToolCall(h, { pattern: "x", path: `${h.agentDir}/secret-store.json` }, "grep");
		expect(g.result?.block).toBe(true);
	});

	it("含 secret-store 字样的无关路径不误伤（子串边界）", async () => {
		const h = await setupHarness();
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const { result } = await runToolCall(h, "cat ~/notes/secret-store.md");
		expect(result).toBeUndefined();
	});
});

describe("tool_call：跨 session 脱敏一致（[8]）", () => {
	it("他 session 后写入的凭证：注入前 reload store 并注册进 redactor，输出被脱敏", async () => {
		const h = await setupHarness();
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		// 模拟另一 session 的保存（直接写盘，本实例未重跑 session_start）
		await writeFile(
			h.storePath,
			JSON.stringify({ secrets: { LATER_SECRET: { value: "later-secret-value", updatedAt: "t", fingerprint: "fp11112222" } } }),
			{ mode: 0o600 },
		);
		await runToolCall(h, "printf '%s' \"$LATER_SECRET\""); // 注入链应同步 reload+注册
		const out = await h.handlers.tool_result[0](toolResultEvent("later-secret-value"), {});
		expect(JSON.stringify(out)).toContain("[REDACTED]");
	});
});

describe("tool_call：P1 检测先于注入（block 时命令保持原样）", () => {
	it("明文凭证命令 → block 且 event.input.command 未被注入（检测看到原始命令）", async () => {
		const h = await setupHarness();
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const cmd = "curl -H 'Authorization: Bearer glpat-AbCdEfGhIjKlMnOpQrStUv' https://x";
		const { event, result } = await runToolCall(h, cmd);
		expect(result?.block).toBe(true);
		expect(event.input.command).toBe(cmd); // 无前缀、无改写
	});
});

describe("tool_call：存储不可读 → fail closed（[6]）", () => {
	it("损坏 json + 引用变量 → bash 调用被 block，不注入", async () => {
		const h = await setupHarness();
		await writeFile(h.storePath, "{ corrupt", { mode: 0o600 });
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const { event, result } = await runToolCall(h, `printf '%s' "$A_TOKEN"`);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("凭证注入已停用");
		expect(event.input.command).not.toContain("__PI_SECRET_STORE__"); // 未注入前缀
	});

	it("损坏 json + 无引用命令 → 直通不拦（注入集为空 = 与无凭证库一致，#170）", async () => {
		const h = await setupHarness();
		await writeFile(h.storePath, "{ corrupt", { mode: 0o600 });
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const { event, result } = await runToolCall(h, "go build ./...");
		expect(result).toBeUndefined();
		expect(event.input.command).toBe("go build ./...");
	});
});

describe("tool_call：redactor 累积不 clear（[4]）", () => {
	it("存 TOKEN → 他 session forget → bash 链 reload 后，旧值输出仍 [REDACTED]", async () => {
		const h = await setupHarness({ TOKEN: { value: "tok-secret-value-123", updatedAt: "t", fingerprint: "fp01234567" } });
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		// 他 session forget：直接改盘（本实例不重跑 session_start）
		await writeFile(h.storePath, JSON.stringify({ secrets: {} }), { mode: 0o600 });
		// bash 调用触发注入链 reload（旧实现在此 clear 掉 TOKEN → 明文裸奔）
		await runToolCall(h, "cat /tmp/saved-token");
		const out = await h.handlers.tool_result[0](toolResultEvent("tok-secret-value-123"), {});
		expect(JSON.stringify(out)).toContain("[REDACTED]");
	});
});
