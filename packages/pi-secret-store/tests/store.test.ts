/**
 * 存储链路单测（走入口）：0600 / 唯一 tmp+rename 原子性（无 .tmp/.lock 残留）/ 锁串行化 /
 * 损坏存储容错（[13]：仅 ENOENT 视为空）。#170 后无 env 文件侧；bash 注入 round-trip 见 hooks.test.ts。
 * forget 经 /secret-store 命令（updateStore 锁协议）驱动。
 */
import { readFile, stat, readdir, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { loadStore, updateStore } from "../index.ts";
import { cleanupEnv, runExact, setupHarness, toolCtx } from "./helpers.ts";

afterEach(cleanupEnv);

describe("store：json 保存（/secret-store forget → updateStore）", () => {
	it("forget 后 json 重写为 0600、无 .tmp/.lock 残留（tmp+rename 原子性）", async () => {
		const h = await setupHarness({
			A_TOKEN: { value: "a-value-1234", updatedAt: "2026-10-20T00:00:00.000Z", fingerprint: "aaaa1111" },
			B_TOKEN: { value: "b-value-5678", updatedAt: "2026-10-20T01:00:00.000Z", fingerprint: "bbbb2222" },
		});
		await h.commands.get("secret-store").handler("forget A_TOKEN", toolCtx(h));
		const mode = (await stat(h.storePath)).mode & 0o777;
		expect(mode).toBe(0o600);
		const store = JSON.parse(await readFile(h.storePath, "utf8"));
		expect(Object.keys(store.secrets)).toEqual(["B_TOKEN"]);
		const leftovers = (await readdir(h.agentDir)).filter((f) => f.endsWith(".tmp") || f.endsWith(".lock"));
		expect(leftovers).toEqual([]);
	});

	it("forget 不存在的凭证 → warning 通知，存储不动", async () => {
		const h = await setupHarness({ B_TOKEN: { value: "b-value-5678", updatedAt: "x", fingerprint: "bbbb2222" } });
		await h.commands.get("secret-store").handler("forget NOPE", toolCtx(h));
		expect(h.notifyLog[0]).toContain("NOPE");
		const store = JSON.parse(await readFile(h.storePath, "utf8"));
		expect(Object.keys(store.secrets)).toEqual(["B_TOKEN"]);
	});

	it("updateStore 合并后整店校验：非法条目（坏名/NUL）拒绝且存储不动（[9]）", async () => {
		const h = await setupHarness({ A_TOKEN: { value: "a-value-1234", updatedAt: "t", fingerprint: "aaaa1111" } });
		await expect(
			updateStore(h.agentDir, h.storePath, (s) => ({
				...s,
				"BAD-NAME": { value: "some-long-value", updatedAt: "t", fingerprint: "f" },
			})),
		).rejects.toThrow(/BAD-NAME/);
		await expect(
			updateStore(h.agentDir, h.storePath, (s) => ({
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
	it("坏 json → session_start 通知且不写任何文件，不抛", async () => {
		const h = await setupHarness();
		await writeFile(h.storePath, "{not json", { mode: 0o600 });
		await expect(h.handlers.session_start[0]({ reason: "new" }, toolCtx(h))).resolves.toBeUndefined();
		expect(h.notifyLog.join("\n")).toMatch(/不可读/);
		expect(await readFile(h.storePath, "utf8")).toBe("{not json"); // 未被清空重写
	});

	it("坏 json → secret_query 报错上抛（surface，不静默当空存储）", async () => {
		const h = await setupHarness();
		await writeFile(h.storePath, "{not json", { mode: 0o600 });
		await expect(runExact(h, "secret_query", { name: "ANY" })).rejects.toThrow(/损坏/);
	});

	it("条目形状校验：非法名/非 string value/短值条目跳过并警告（[5]/[7]/[13]）", async () => {
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
		const warned = h.notifyLog.join("\n");
		expect(warned).toContain("BAD-NAME");
		expect(warned).toContain("SHORT_OK");
		expect(warned).toContain("NO_VALUE");
		expect(warned).not.toContain("OK_ONE");
	});

	it("json 缺 secrets 字段 → 视为空存储（null 原型），注入链正常", async () => {
		const h = await setupHarness();
		await writeFile(h.storePath, '{"other":1}\n', { mode: 0o600 });
		await h.handlers.session_start[0]({ reason: "new" }, toolCtx(h));
		const { runToolCall } = await import("./helpers.ts");
		const { event } = await runToolCall(h, "cat /dev/null");
		expect(event.input.command).toBe("cat /dev/null"); // 空存储 + 无引用：直通不报错（#170）
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
			updateStore(h.agentDir, h.storePath, (s) => ({
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
		const warned = h.notifyLog.join("\n");
		expect(warned).toContain("PATH");
		expect(warned).toContain("SHELL_SESSION_ID");
		expect(warned).not.toContain("OK_ONE");
	});
});
