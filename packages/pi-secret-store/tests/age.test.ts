/**
 * age 加密存储后端单测（#173，走入口，测试内真实执行 age CLI——本机 v1.2.1，纯本地运算无网络）：
 * 遗留明文自动迁移（加密转 .age + shred 原文件，D7=a）+ 身份密钥零交互生成（0600）+
 * 加解密 round-trip（解密装载/注入/脱敏与 plain 一致）+ 错钥/损坏密文/age 缺失显式报错不静默降级 +
 * plain 显式配置回归 + conf 非法值 fail closed。
 */
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupEnv, runExact, runToolCall, setupHarness, toolCtx, toolResultEvent, type Harness } from "./helpers.ts";

const run = promisify(execFile);

afterEach(cleanupEnv);

const SEED = {
	HARBOR_PASSWORD: { value: "harbor-secret-value", updatedAt: "2026-10-26T00:00:00.000Z", fingerprint: "fp0000hh11" },
};
const SEED_TWO = {
	...SEED,
	B_TOKEN: { value: "b-token-value-5678", updatedAt: "2026-10-26T01:00:00.000Z", fingerprint: "fp0000bb22" },
};
const ageFile = (h: Harness) => join(h.agentDir, "secret-store.json.age");
const keyFile = (h: Harness) => join(h.agentDir, "secret-store.key");

const start = async (h: Harness) => h.handlers.session_start[0]({ reason: "new" }, toolCtx(h));

describe("age 后端：遗留明文自动迁移（D7=a）", () => {
	it("首次运行：明文 store 加密转为 .age、shred 删除原文件、身份密钥自动生成 0600，明文不进上下文", async () => {
		const h = await setupHarness(SEED, undefined, "age");
		await start(h);
		// 密文落盘（age 二进制格式头，磁盘无明文 json）
		const cipher = await readFile(ageFile(h), "utf8");
		expect(cipher).toContain("age-encryption.org/v1");
		await expect(stat(h.storePath)).rejects.toThrow(/ENOENT/); // shred -u：原明文已物理删除
		// 身份密钥分离落盘且 0600
		expect(await readFile(keyFile(h), "utf8")).toContain("# public key: age1");
		expect((await stat(keyFile(h))).mode & 0o777).toBe(0o600);
		// 迁移过程不向上下文返回明文：通知面只有计数
		expect(h.notifyLog.join("\n")).toContain("1 个凭证已就绪");
		expect(h.notifyLog.join("\n")).not.toContain("harbor-secret-value");
		// agent 读密文/密钥本身 → guard 拦截
		const guard = await runToolCall(h, `cat ${ageFile(h)}`);
		expect(guard.result?.block).toBe(true);
		const guardKey = await runToolCall(h, `cat ${keyFile(h)}`);
		expect(guardKey.result?.block).toBe(true);
	});

	it("损坏的遗留明文 → 显式报错，原文件不动、不产生密文（防覆盖语义与 [13] 一致）", async () => {
		const h = await setupHarness(SEED, undefined, "age");
		await writeFile(h.storePath, "{not json", { mode: 0o600 });
		await start(h);
		expect(h.notifyLog.join("\n")).toMatch(/损坏|不可读/);
		await expect(stat(ageFile(h))).rejects.toThrow(/ENOENT/);
		await expect(readFile(h.storePath, "utf8")).resolves.toBe("{not json");
	});
});

describe("age 后端：解密装载 round-trip（行为与 plain 一致）", () => {
	it("迁移后 secret_query/注入/脱敏全走解密内存快照", async () => {
		const h = await setupHarness(SEED, undefined, "age");
		await start(h);
		const q = await runExact(h, "secret_query", { name: "HARBOR_PASSWORD" });
		expect(q.content[0].text).toContain("存在");
		expect(q.content[0].text).toContain("fp0000hh11");
		expect(q.content[0].text).not.toContain("harbor-secret-value");
		const { event, result } = await runToolCall(h, "echo $HARBOR_PASSWORD");
		expect(result).toBeUndefined();
		expect(event.input.command).toBe(
			": __PI_SECRET_STORE__; export HARBOR_PASSWORD='harbor-secret-value'; echo $HARBOR_PASSWORD",
		);
		const out = await h.handlers.tool_result[0](toolResultEvent("leak harbor-secret-value"), {});
		expect(JSON.stringify(out)).toContain("[REDACTED]");
	});

	it("写路径：forget 后密文原子重写、仍无明文 json、无 .tmp/.lock 残留", async () => {
		const h = await setupHarness(SEED_TWO, undefined, "age");
		await start(h);
		await h.commands.get("secret-store").handler("forget B_TOKEN", toolCtx(h));
		const q = await runExact(h, "secret_query", { name: "B_TOKEN" });
		expect(q.content[0].text).toContain("不存在");
		const keep = await runExact(h, "secret_query", { name: "HARBOR_PASSWORD" });
		expect(keep.content[0].text).toContain("存在"); // 密文可继续解密
		await expect(stat(h.storePath)).rejects.toThrow(/ENOENT/);
		expect(await stat(ageFile(h))).toBeTruthy();
		const leftovers = (await readdir(h.agentDir)).filter((f) => f.endsWith(".tmp") || f.endsWith(".lock"));
		expect(leftovers).toEqual([]);
	});
});

describe("age 后端：错误路径显式报错（不静默降级）", () => {
	it("错钥（身份密钥与密文不匹配）→ session_start 告警 + 注入 fail closed，密文不被销毁", async () => {
		const h = await setupHarness(SEED, undefined, "age");
		await start(h);
		// 换上一把无关身份密钥（age-keygen 另生成）
		const tmpDir = await mkdtemp(join(tmpdir(), "age-wrongkey-"));
		await run(join(process.env.HOME ?? "/nonexistent", ".local/bin/age-keygen"), ["-o", join(tmpDir, "k")]);
		await copyFile(join(tmpDir, "k"), keyFile(h));
		await start(h);
		expect(h.notifyLog.join("\n")).toMatch(/解密失败/);
		expect(await stat(ageFile(h))).toBeTruthy(); // 密文保留，不静默清空
		const { result } = await runToolCall(h, "echo $HARBOR_PASSWORD");
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("凭证注入已停用");
	});

	it("损坏密文 → 显式报错不静默丢凭证；secret_query 上抛", async () => {
		const h = await setupHarness(SEED, undefined, "age");
		await start(h);
		await writeFile(ageFile(h), "definitely-not-age-ciphertext\n", { mode: 0o600 });
		await start(h);
		expect(h.notifyLog.join("\n")).toMatch(/解密失败/);
		await expect(runExact(h, "secret_query", { name: "HARBOR_PASSWORD" })).rejects.toThrow(/解密失败/);
	});

	it("age 二进制缺失（PI_SECRET_STORE_AGE_BIN 定向不存在路径）→ 报错含安装指引，不降级明文", async () => {
		process.env.PI_SECRET_STORE_AGE_BIN = "/nonexistent/age-binary-404";
		try {
			const h = await setupHarness(SEED, undefined, "age");
			await start(h);
			expect(h.notifyLog.join("\n")).toMatch(/安装/);
			const { result } = await runToolCall(h, "echo $HARBOR_PASSWORD");
			expect(result?.block).toBe(true);
			expect(result?.reason).toContain("凭证注入已停用");
		} finally {
			delete process.env.PI_SECRET_STORE_AGE_BIN;
		}
	});
});

describe("age 后端：配置选择（conf 文件）", () => {
	it("空存储首次使用 → 身份密钥零交互生成（0600），不创建密文", async () => {
		const h = await setupHarness(undefined, undefined, "age");
		await start(h);
		expect((await stat(keyFile(h))).mode & 0o777).toBe(0o600);
		await expect(stat(ageFile(h))).rejects.toThrow(/ENOENT/);
	});

	it("plain 显式配置 → 现行为原样：明文 json 仍是正典，不迁移不生成密文（回归锁）", async () => {
		const h = await setupHarness(SEED, undefined, "plain");
		await start(h);
		await expect(stat(ageFile(h))).rejects.toThrow(/ENOENT/);
		await expect(stat(keyFile(h))).rejects.toThrow(/ENOENT/);
		const disk = JSON.parse(await readFile(h.storePath, "utf8"));
		expect(Object.keys(disk.secrets)).toEqual(["HARBOR_PASSWORD"]);
	});

	it("conf 非法 backend 值 → fail closed 显式报错（不静默当 plain/age）", async () => {
		const h = await setupHarness(SEED, undefined, "plain");
		await writeFile(join(h.agentDir, "secret-store.conf"), "backend = plein\n", { mode: 0o600 });
		await start(h);
		expect(h.notifyLog.join("\n")).toMatch(/非法/);
		await expect(stat(ageFile(h))).rejects.toThrow(/ENOENT/);
	});
});

describe("age 后端：真实加解密原语 round-trip（锦上添花的独立验证）", () => {
	it("age -r 加密 → age -d -i 解密逐字节还原；错钥明确报错", async () => {
		const dir = await mkdtemp(join(tmpdir(), "age-rt-"));
		const age = join(process.env.HOME ?? "/nonexistent", ".local/bin/age");
		const keygen = join(process.env.HOME ?? "/nonexistent", ".local/bin/age-keygen");
		await run(keygen, ["-o", join(dir, "k")]);
		const key = join(dir, "k");
		const pub = (await readFile(key, "utf8")).match(/^# public key: (\S+)$/m)?.[1] ?? "";
		await writeFile(join(dir, "in.txt"), "round-trip-payload-1234");
		await run(age, ["-r", pub, "-o", join(dir, "out.age"), join(dir, "in.txt")]);
		await run(age, ["-d", "-i", key, "-o", join(dir, "out.txt"), join(dir, "out.age")]);
		await expect(readFile(join(dir, "out.txt"), "utf8")).resolves.toBe("round-trip-payload-1234");
		const other = await mkdtemp(join(tmpdir(), "age-other-"));
		await run(keygen, ["-o", join(other, "k2")]);
		await expect(run(age, ["-d", "-i", join(other, "k2"), "-o", join(other, "out.txt"), join(dir, "out.age")])).rejects
			.toThrow(/no identity matched/);
	});
});
