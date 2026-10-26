/**
 * [8] 两阶段提交：json+env 都 stage 成 tmp 后依序 rename（json 先 env 后）；env rename 失败 →
 * json 回滚旧原文，杜绝"json 已更新 env 未更新"的半提交。
 * 独立文件原因：node:fs/promises 的 ESM namespace 不可 spyOn（non-configurable），此处用
 * vi.mock 工厂注入 rename 失败；其余测试文件仍走真实 fs，互不影响。
 */
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadStore, updateStore } from "../index.ts";

let failEnvRename = false;
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		rename: async (...args: Parameters<typeof actual.rename>) => {
			if (failEnvRename && String(args[1]).endsWith(".env")) throw new Error("mock: env rename 失败");
			return actual.rename(...args);
		},
	};
});

afterEach(() => {
	failEnvRename = false;
});

const SEED = { A_TOKEN: { value: "a-value-1234", updatedAt: "t", fingerprint: "aaaa1111" } };

async function sandbox(withStore = true) {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-secret-store-2p-"));
	if (withStore) {
		await writeFile(join(agentDir, "secret-store.json"), JSON.stringify({ secrets: SEED }, null, 2) + "\n", { mode: 0o600 });
		await writeFile(join(agentDir, "secret-store.env"), "A_TOKEN='a-value-1234'\n", { mode: 0o600 });
	}
	return { agentDir, storePath: join(agentDir, "secret-store.json"), envFile: join(agentDir, "secret-store.env") };
}

describe("updateStore 两阶段提交（[8]）", () => {
	it("env rename 失败 → json 回滚旧原文，查询与 env 一致，无 tmp/lock 残留", async () => {
		const h = await sandbox();
		failEnvRename = true;
		await expect(
			updateStore(h.agentDir, h.storePath, h.envFile, (s) => {
				const next = { ...s };
				delete next.A_TOKEN; // 模拟 forget
				return next;
			}),
		).rejects.toThrow(/mock: env rename 失败/);
		// json 回滚：删除未生效
		const store = JSON.parse(await readFile(h.storePath, "utf8"));
		expect(Object.keys(store.secrets)).toEqual(["A_TOKEN"]);
		// 查询一致：loadStore 与 env 同步
		expect(Object.keys(await loadStore(h.storePath))).toEqual(["A_TOKEN"]);
		expect(await readFile(h.envFile, "utf8")).toBe("A_TOKEN='a-value-1234'\n");
		const leftovers = (await readdir(h.agentDir)).filter((f) => f.endsWith(".tmp") || f.endsWith(".lock"));
		expect(leftovers).toEqual([]);
	});

	it("全新存储首次保存遇 env rename 失败 → json 不残留半提交", async () => {
		const h = await sandbox(false); // json/env 均不存在
		failEnvRename = true;
		await expect(
			updateStore(h.agentDir, h.storePath, h.envFile, () => ({
				B_NEW: { value: "b-new-value-999", updatedAt: "t", fingerprint: "bbbb2222" },
			})),
		).rejects.toThrow(/mock: env rename 失败/);
		await expect(readFile(h.storePath, "utf8")).rejects.toThrow(/ENOENT/);
		const leftovers = (await readdir(h.agentDir)).filter((f) => f.endsWith(".tmp") || f.endsWith(".lock"));
		expect(leftovers).toEqual([]);
	});
});
