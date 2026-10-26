/**
 * harness 自身清理语义（#126）：PI_CODING_AGENT_DIR 恢复原值（原无则删除）+ mkdtemp 目录递归清理。
 */
import { stat } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { assertAgeBackend, cleanupEnv, setupHarness } from "./helpers.ts";

afterEach(cleanupEnv);

describe("harness 清理（#126）", () => {
	it("cleanupEnv 恢复 setup 前的 PI_CODING_AGENT_DIR 原值", async () => {
		process.env.PI_CODING_AGENT_DIR = "/sentinel/original";
		const h = await setupHarness();
		expect(process.env.PI_CODING_AGENT_DIR).toBe(h.agentDir);
		await cleanupEnv();
		expect(process.env.PI_CODING_AGENT_DIR).toBe("/sentinel/original");
	});

	it("原未设置时 cleanupEnv 删除变量并递归清理 mkdtemp 目录", async () => {
		delete process.env.PI_CODING_AGENT_DIR;
		const h = await setupHarness();
		await cleanupEnv();
		expect(process.env.PI_CODING_AGENT_DIR).toBeUndefined();
		await expect(stat(h.agentDir)).rejects.toThrow(/ENOENT/);
	});
});

describe("assertAgeBackend 防呆（r7 #7）", () => {
	it("age 沙箱通过；plain 沙箱（含缺省）抛错——遗漏显式声明的 age 测试立即红", async () => {
		const ageH = await setupHarness(undefined, undefined, "age");
		expect(ageH.backend).toBe("age");
		await expect(assertAgeBackend(ageH)).resolves.toBeUndefined();
		const plainH = await setupHarness();
		expect(plainH.backend).toBe("plain");
		await expect(assertAgeBackend(plainH)).rejects.toThrow(/非 age/);
	});
});
