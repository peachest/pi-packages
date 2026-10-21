/**
 * 钩子链单测（走入口）：tool_call 原地 mutate 断言（防退化回 { input } 返回——已实证失效模式）、
 * 存储 guard（bash resolved 变体 + read 类文件工具，[7]）、注入前缀形状（单引号字面量，[11]）、
 * 顺序（P1 检测在注入前，block 时不注入）、fail closed（[6]）、redactor 累积（[4]）、锁内 env 生成（[5]）。
 */
import { execFile } from "node:child_process";
import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupEnv, runToolCall, setupHarness, toolCtx, toolResultEvent } from "./helpers.ts";

const bashRun = promisify(execFile);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

afterEach(cleanupEnv);

describe("tool_call：env 注入（原地 mutate）", () => {
	it("mutate 后 event.input.command 已含前缀（关键契约：返回 { input } 无效，必须原地改）", async () => {
		const h = await setupHarness();
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const { event, result } = await runToolCall(h, "go build ./...");
		expect(result).toBeUndefined(); // 注入不返回值
		expect(event.input.command).toContain("__PI_SECRET_STORE__");
		expect(event.input.command).toMatch(/^: __PI_SECRET_STORE__; if \[ -f '.*secret-store\.env' \]; then set -a; \. '.*secret-store\.env' 2>\/dev\/null; set \+a; fi; go build \.\/\.\.\.$/);
		// 原命令保持完整在后
		expect(event.input.command.endsWith("go build ./...")).toBe(true);
	});

	it("非 bash 工具不注入", async () => {
		const h = await setupHarness();
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const { event, result } = await runToolCall(h, "some/path", "read");
		expect(result).toBeUndefined();
		expect(event.input.command).toBe("some/path"); // read 的 input.command 原样（未被注入触碰）
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

	it("读 secret-store.env → block；写入 env 文件（重定向目标）→ block", async () => {
		const h = await setupHarness();
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const { result } = await runToolCall(h, `source ${h.agentDir}/secret-store.env`);
		expect(result?.block).toBe(true);
		const w = await runToolCall(h, `echo "X=1" > ${h.agentDir}/secret-store.env`);
		expect(w.result?.block).toBe(true);
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
		const g = await runToolCall(h, { pattern: "x", path: `${h.agentDir}/secret-store.env` }, "grep");
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
		// 模拟另一 session 的完整保存（json+env 同步更新，本实例未重跑 session_start）
		await writeFile(
			h.storePath,
			JSON.stringify({ secrets: { LATER_SECRET: { value: "later-secret-value", updatedAt: "t", fingerprint: "fp11112222" } } }),
			{ mode: 0o600 },
		);
		await writeFile(h.envFile, "LATER_SECRET='later-secret-value'\n", { mode: 0o600 });
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
	it("损坏 json + 旧 env 文件在盘 → bash 调用被 block，不注入不 source", async () => {
		const h = await setupHarness();
		await writeFile(h.storePath, "{ corrupt", { mode: 0o600 });
		await writeFile(h.envFile, "TOKEN='leaked-value'\n", { mode: 0o600 });
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const { event, result } = await runToolCall(h, "env");
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("凭证注入已停用");
		expect(event.input.command).toBe("env"); // 未注入前缀
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

describe("session_start：锁内 load+env 生成（[5]）", () => {
	it("他进程持锁时 session_start 等待，锁释放后才完成 env 生成", async () => {
		const h = await setupHarness({ S_TOKEN: { value: "s-token-value-1", updatedAt: "t", fingerprint: "fp00001111" } });
		const lock = await open(`${h.storePath}.lock`, "wx", 0o600);
		let finished = false;
		const p = h.handlers.session_start[0]({ reason: "new" }, { hasUI: false }).then(() => {
			finished = true;
		});
		await sleep(200);
		expect(finished).toBe(false); // 锁被占：不绕锁写 env
		await lock.close();
		await unlink(`${h.storePath}.lock`);
		await p;
		expect(await readFile(h.envFile, "utf8")).toContain("S_TOKEN='s-token-value-1'");
	});
});

describe("tool_call：注入前缀单引号转义（[11]）", () => {
	it("agent 目录含 shell 特殊字符：路径单引号字面量包裹，bash 实取到值", async () => {
		const base = await setupHarness();
		const weird = join(base.agentDir, "a'b`c$d");
		await mkdir(weird, { recursive: true });
		const h = await setupHarness({ FOO: { value: "foo-bar-baz-99", updatedAt: "t", fingerprint: "fp00002222" } }, weird);
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const { event } = await runToolCall(h, 'printf \'%s\' "$FOO"');
		expect(event.input.command).toMatch(/^: __PI_SECRET_STORE__; if \[ -f '.+' \]; then set -a; \. '.+' 2>\/dev\/null; set \+a; fi; /);
		const { stdout } = await bashRun("bash", ["-c", event.input.command]);
		expect(stdout).toBe("foo-bar-baz-99"); // 双引号前缀会被 `/$() 求值 → 路径破損 → 空输出
	});
});
