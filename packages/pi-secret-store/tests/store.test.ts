/**
 * 存储链路单测（走入口）：0600 / 唯一 tmp+rename 原子性（无 .tmp/.lock 残留）/ bash source round-trip /
 * 锁串行化 / 损坏存储容错（[13]：仅 ENOENT 视为空）。
 * saveStore 经 /secret-store forget（updateStore 锁协议）驱动；writeEnvFile 经 session_start 驱动。
 */
import { execFile } from "node:child_process";
import { readFile, stat, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { loadStore, writeEnvFile, updateStore } from "../index.ts";
import { cleanupEnv, runExact, setupHarness, toolCtx } from "./helpers.ts";

const bashRun = promisify(execFile);

afterEach(cleanupEnv);

describe("store：env 文件生成（session_start）", () => {
	it("session_start 写出 env 文件，0600，行格式 NAME='value'（bash 单引号字面量）", async () => {
		const h = await setupHarness({
			HARBOR_PASSWORD: { value: " harbor-pw-9 ", updatedAt: "2026-10-20T00:00:00.000Z", fingerprint: "fp1234" },
		});
		await h.handlers.session_start[0]({ reason: "new" }, toolCtx(h));
		const mode = (await stat(h.envFile)).mode & 0o777;
		expect(mode).toBe(0o600);
		const content = await readFile(h.envFile, "utf8");
		expect(content).toBe("HARBOR_PASSWORD=' harbor-pw-9 '\n"); // 单引号字面量：source 后逐字节还原
	});

	it("bash source round-trip：$()/ $HOME/ 反引号/真实换行/单引号 值逐字节还原（[4]）", async () => {
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
		await h.handlers.session_start[0]({ reason: "new" }, toolCtx(h));
		const { stdout } = await bashRun("bash", [
			"-c",
			`set -a; . '${h.envFile}'; set +a; for v in ${Object.keys(values).join(" ")}; do printf '%s' "\${!v}" | base64 -w0; echo; done`,
		]);
		const got = stdout.trim().split("\n").map((b64) => Buffer.from(b64, "base64").toString("utf8"));
		expect(got).toEqual(Object.values(values));
	});

	it("writeEnvFile 拒绝含 NUL 的值（[4]，bash 变量无法承载）", async () => {
		const h = await setupHarness();
		await expect(
			writeEnvFile(join(h.agentDir, "x.env"), { X_OKAY: { value: "a\0b", updatedAt: "t", fingerprint: "f" } }),
		).rejects.toThrow(/NUL/);
	});

	it("空存储也写 env 文件（空内容）", async () => {
		const h = await setupHarness();
		await h.handlers.session_start[0]({ reason: "new" }, toolCtx(h));
		expect(await readFile(h.envFile, "utf8")).toBe("\n"); // 空清单 join+\n（原型行为不变）
	});
});

describe("store：json 保存（/secret-store forget → saveStore）", () => {
	it("forget 后 json 重写为 0600、env 同步重写、无 .tmp 残留（tmp+rename 原子性）", async () => {
		const h = await setupHarness({
			A_TOKEN: { value: "a-value-1234", updatedAt: "2026-10-20T00:00:00.000Z", fingerprint: "aaaa1111" },
			B_TOKEN: { value: "b-value-5678", updatedAt: "2026-10-20T01:00:00.000Z", fingerprint: "bbbb2222" },
		});
		await h.commands.get("secret-store").handler("forget A_TOKEN", toolCtx(h));
		const mode = (await stat(h.storePath)).mode & 0o777;
		expect(mode).toBe(0o600);
		const store = JSON.parse(await readFile(h.storePath, "utf8"));
		expect(Object.keys(store.secrets)).toEqual(["B_TOKEN"]);
		const env = await readFile(h.envFile, "utf8");
		expect(env).not.toContain("A_TOKEN");
		expect(env).toContain("B_TOKEN");
		const leftovers = (await readdir(h.agentDir)).filter((f) => f.endsWith(".tmp"));
		expect(leftovers).toEqual([]);
	});

	it("forget 不存在的凭证 → warning 通知，存储不动", async () => {
		const h = await setupHarness({ B_TOKEN: { value: "b-value-5678", updatedAt: "x", fingerprint: "bbbb2222" } });
		await h.commands.get("secret-store").handler("forget NOPE", toolCtx(h));
		expect(h.notifyLog[0]).toContain("NOPE");
		const store = JSON.parse(await readFile(h.storePath, "utf8"));
		expect(Object.keys(store.secrets)).toEqual(["B_TOKEN"]);
	});

	it("updateStore 合并后整店校验：非法条目（坏名/NUL）拒绝且两文件不动（[9]）", async () => {
		const h = await setupHarness({ A_TOKEN: { value: "a-value-1234", updatedAt: "t", fingerprint: "aaaa1111" } });
		await expect(
			updateStore(h.agentDir, h.storePath, h.envFile, (s) => ({
				...s,
				"BAD-NAME": { value: "some-long-value", updatedAt: "t", fingerprint: "f" },
			})),
		).rejects.toThrow(/BAD-NAME/);
		await expect(
			updateStore(h.agentDir, h.storePath, h.envFile, (s) => ({
				...s,
				B_TOKEN: { value: "x\0y-long-value", updatedAt: "t", fingerprint: "f" },
			})),
		).rejects.toThrow(/NUL/);
		const store = JSON.parse(await readFile(h.storePath, "utf8"));
		expect(Object.keys(store.secrets)).toEqual(["A_TOKEN"]); // 零文件落地
	});

	it("并发 forget 串行化：三个并行删除全部生效，无 .tmp/.lock 残留（[11]/[12]）", async () => {
		const h = await setupHarness({
			A_TOKEN: { value: "a-value-1234", updatedAt: "t", fingerprint: "aaaa1111" },
			B_TOKEN: { value: "b-value-5678", updatedAt: "t", fingerprint: "bbbb2222" },
			C_TOKEN: { value: "c-value-9012", updatedAt: "t", fingerprint: "cccc3333" },
		});
		await Promise.all([
			h.commands.get("secret-store").handler("forget A_TOKEN", toolCtx(h)),
			h.commands.get("secret-store").handler("forget B_TOKEN", toolCtx(h)),
			h.commands.get("secret-store").handler("forget C_TOKEN", toolCtx(h)),
		]);
		const store = JSON.parse(await readFile(h.storePath, "utf8"));
		expect(Object.keys(store.secrets)).toEqual([]); // 锁内 reload：无删除丢失/复活
		const leftovers = (await readdir(h.agentDir)).filter((f) => f.endsWith(".tmp") || f.endsWith(".lock"));
		expect(leftovers).toEqual([]);
	});
});

describe("store：损坏存储容错（[13]：仅 ENOENT 视为空存储）", () => {
	it("坏 json → session_start 通知且不重写 env 文件，不抛", async () => {
		const h = await setupHarness();
		await writeFile(h.storePath, "{not json", { mode: 0o600 });
		await writeFile(h.envFile, "PREVIOUS=1\n", { mode: 0o600 });
		await expect(h.handlers.session_start[0]({ reason: "new" }, toolCtx(h))).resolves.toBeUndefined();
		expect(h.notifyLog.join("\n")).toMatch(/不可读/);
		expect(await readFile(h.envFile, "utf8")).toBe("PREVIOUS=1\n"); // 未被清空重写
	});

	it("坏 json → secret_query 报错上抛（surface，不静默当空存储）", async () => {
		const h = await setupHarness();
		await writeFile(h.storePath, "{not json", { mode: 0o600 });
		await expect(runExact(h, "secret_query", { name: "ANY" })).rejects.toThrow(/损坏/);
	});

	it("条目形状校验：非法名/非 string value/短值条目跳过并警告，合法条目不受影响（[5]/[7]/[13]）", async () => {
		const h = await setupHarness();
		await writeFile(
			h.storePath,
			JSON.stringify({
				secrets: {
					OK_ONE: { value: "good-value-ok", updatedAt: "t", fingerprint: "f1" },
					"BAD-NAME": { value: "some-long-value", updatedAt: "t", fingerprint: "f2" },
					SHORT_OK: { value: "abc", updatedAt: "t", fingerprint: "f3" },
					NO_VALUE: { updatedAt: "t", fingerprint: "f4" },
				},
			}),
			{ mode: 0o600 },
		);
		await h.handlers.session_start[0]({ reason: "new" }, toolCtx(h));
		const env = await readFile(h.envFile, "utf8");
		expect(env).toContain("OK_ONE='good-value-ok'");
		expect(env).not.toContain("BAD-NAME");
		expect(env).not.toContain("SHORT_OK");
		expect(env).not.toContain("NO_VALUE");
		const warned = h.notifyLog.join("\n");
		expect(warned).toContain("BAD-NAME");
		expect(warned).toContain("SHORT_OK");
		expect(warned).toContain("NO_VALUE");
	});

	it("json 缺 secrets 字段 → 视为空存储（null 原型），注入链正常", async () => {
		const h = await setupHarness();
		await writeFile(h.storePath, '{"other":1}\n', { mode: 0o600 });
		await h.handlers.session_start[0]({ reason: "new" }, toolCtx(h));
		const { runToolCall } = await import("./helpers.ts");
		const { event } = await runToolCall(h, "cat /dev/null");
		expect(event.input.command).toContain("__PI_SECRET_STORE__");
	});
});

describe("保留名黑名单与空存储形态（#126）", () => {
	it("ENOENT 空存储返回 null 原型对象（与填充路径一致）", async () => {
		const h = await setupHarness();
		expect(Object.getPrototypeOf(await loadStore(h.storePath))).toBeNull();
	});

	it("updateStore 拒绝保留 shell 变量名（PATH），零文件落地", async () => {
		const h = await setupHarness({ A_TOKEN: { value: "a-value-1234", updatedAt: "t", fingerprint: "aaaa1111" } });
		await expect(
			updateStore(h.agentDir, h.storePath, h.envFile, (s) => ({
				...s,
				PATH: { value: "some-long-value", updatedAt: "t", fingerprint: "f" },
			})),
		).rejects.toThrow(/保留 shell 变量名/);
		const store = JSON.parse(await readFile(h.storePath, "utf8"));
		expect(Object.keys(store.secrets)).toEqual(["A_TOKEN"]); // 零文件落地
	});

	it("loadStore 跳过保留名条目（SHELL* 前缀同拦）并告警", async () => {
		const h = await setupHarness();
		await writeFile(
			h.storePath,
			JSON.stringify({
				secrets: {
					OK_ONE: { value: "good-value-ok", updatedAt: "t", fingerprint: "f1" },
					PATH: { value: "/evil/bin-path", updatedAt: "t", fingerprint: "f2" },
					SHELL_SESSION_ID: { value: "session-id-value", updatedAt: "t", fingerprint: "f3" },
				},
			}),
			{ mode: 0o600 },
		);
		await h.handlers.session_start[0]({ reason: "new" }, toolCtx(h));
		const env = await readFile(h.envFile, "utf8");
		expect(env).toContain("OK_ONE='good-value-ok'");
		expect(env).not.toContain("PATH=");
		expect(env).not.toContain("SHELL_SESSION_ID=");
		const warned = h.notifyLog.join("\n");
		expect(warned).toContain("PATH");
		expect(warned).toContain("SHELL_SESSION_ID");
	});
});
