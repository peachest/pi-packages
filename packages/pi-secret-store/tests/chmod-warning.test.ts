/**
 * r9 #3：身份密钥 0600 收紧失败不再静默吞错——chmod 失败（非 ENOENT）经 onWarning 显式告警（文案含实际
 * 风险与手动修复指引）。独立文件：vi.mock node:fs/promises（spread actual + chmod spy）隔离注入失败，
 * 不影响其余测试文件的 fs 行为。走入口（session_start 迁移路径驱动 ensureIdentity）。
 */
import { chmod, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBackend } from "../lib/backend.ts";
import { assertAgeBackend, cleanupEnv, hasRealAge, setupHarness, toolCtx, type Harness } from "./helpers.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return { ...actual, chmod: vi.fn(actual.chmod) };
});

afterEach(() => {
	vi.mocked(chmod).mockClear();
	return cleanupEnv();
});

const SEED = {
	HARBOR_PASSWORD: { value: "harbor-secret-value", updatedAt: "t", fingerprint: "fp0000hh11" },
};
const keyFile = (h: Harness) => join(h.agentDir, "secret-store.key");
const ageFile = (h: Harness) => join(h.agentDir, "secret-store.json.age");

// 迁移流程中首个 chmod 调用 = ensureIdentity 的身份密钥 tmp 收紧（锁/tig tmp 均不用 chmod）
const failNextChmod = (code: string) =>
	vi.mocked(chmod).mockRejectedValueOnce(Object.assign(new Error(`${code}: injected`), { code }));

// 终审 P2 #3：本文件走 age 迁移路径（真实 age via resolveAgeBin 回退），同 age.test.ts 统一守卫：
// 本机无 age 时 skip（requires local age binary at ~/.local/bin; install per README），不红。
describe.skipIf(!hasRealAge)("身份密钥 chmod 收紧失败告警（r9 #3，age 迁移路径）", () => {
	it("chmod 失败（EACCES，非 ENOENT）→ onWarning 显式告警（含风险与 chmod 600 指引），迁移不中断、密钥仍生成", async () => {
		failNextChmod("EACCES");
		const h = await setupHarness(SEED, undefined, "age");
		await h.handlers.session_start[0]({ reason: "new" }, toolCtx(h)); // 遗留明文 → 迁移 → ensureIdentity
		const log = h.notifyLog.join("\n");
		expect(log).toContain("0600"); // 旧实现 .catch(() => {}) 静默（红）
		expect(log).toContain("chmod 600");
		expect(log).toContain("secret-store.key"); // 指向实际文件
		// 静默吞错改为告警后，迁移链路照常完成：密钥/密文均落盘
		expect((await stat(keyFile(h))).isFile()).toBe(true);
		expect(await readFile(ageFile(h), "utf8")).toContain("age-encryption.org/v1");
	}, 15_000);

	it("chmod ENOENT → 不告警（无文件无风险，保持既有静默语义）", async () => {
		failNextChmod("ENOENT");
		const h = await setupHarness(SEED, undefined, "age");
		await h.handlers.session_start[0]({ reason: "new" }, toolCtx(h));
		expect(h.notifyLog.join("\n")).not.toContain("0600");
	}, 15_000);

	// review-high #5：r9 #3 的告警语义在 persist 分支断了（ensureIdentity(keyPath) 漏传 onWarning）——
	// 直接驱动 persist（persist 触发 keygen 的现实场景：密文不存在 + conf 后写），断言告警可达。
	it("persist 路径 keygen chmod 失败 → onWarning 可达（review-high #5），persist 链路照常完成", async () => {
		failNextChmod("EACCES");
		const h = await setupHarness(undefined, undefined, "age");
		await assertAgeBackend(h);
		const warnings: string[] = [];
		const backend = await createBackend(h.agentDir);
		await backend.persist(SEED, (msg) => warnings.push(msg));
		expect(warnings.join("\n")).toContain("0600");
		expect(warnings.join("\n")).toContain("chmod 600");
		expect(warnings.join("\n")).toContain("secret-store.key");
		// 告警不中断 persist：密钥与密文均落盘
		expect((await stat(keyFile(h))).isFile()).toBe(true);
		expect(await readFile(ageFile(h), "utf8")).toContain("age-encryption.org/v1");
	}, 15_000);
});
