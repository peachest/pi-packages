/**
 * age 加密存储后端单测（#173，走入口，测试内真实执行 age CLI——本机 v1.2.1，纯本地运算无网络）：
 * 遗留明文自动迁移（加密转 .age + shred 原文件，D7=a）+ 身份密钥零交互生成（0600）+
 * 加解密 round-trip（解密装载/注入/脱敏与 plain 一致）+ 错钥/损坏密文/age 缺失显式报错不静默降级 +
 * plain 显式配置回归 + conf 非法值 fail closed。
 */
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createBackend } from "../lib/backend.ts";
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

	it("r5 #3：shred 存在但执行失败 → 兕底覆写删除照常完成，onWarning 告知实际销毁强度", async () => {
		const h = await setupHarness(SEED, undefined, "age");
		// fake shred：PATH 最前放置 exit 1 同名脚本——shred 可执行但失败（非 command not found）
		const fakeBin = await mkdtemp(join(tmpdir(), "fake-shred-"));
		await writeFile(join(fakeBin, "shred"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
		const savedPath = process.env.PATH;
		process.env.PATH = `${fakeBin}:${savedPath}`;
		try {
			await start(h); // 迁移：shred exit 1 → 单次覆写+删除兜底完成 + 销毁强度告警
		} finally {
			process.env.PATH = savedPath;
			await rm(fakeBin, { recursive: true, force: true });
		}
		await expect(stat(h.storePath)).rejects.toThrow(/ENOENT/); // 兑底删除完成（迁移未中断）
		expect(h.notifyLog.join("\n")).toMatch(/shred 执行失败/);
		expect(h.notifyLog.join("\n")).not.toContain("harbor-secret-value"); // 明文不进通知面
	});

	it("r6 #3：shred 失败后目标已被并发删除（兜底 stat ENOENT）→ 按已消失视为成功，迁移照常完成", async () => {
		// fake shred：先删除目标再 exit 1——复现 shred 失败 + 兕底 stat 前目标已消失的竞态（stat 抛错路径）
		const h = await setupHarness(SEED, undefined, "age");
		const fakeBin = await mkdtemp(join(tmpdir(), "fake-shred-"));
		await writeFile(join(fakeBin, "shred"), '#!/bin/sh\nrm -f "$2"\nexit 1\n', { mode: 0o755 });
		const savedPath = process.env.PATH;
		process.env.PATH = `${fakeBin}:${savedPath}`;
		try {
			await start(h);
		} finally {
			process.env.PATH = savedPath;
			await rm(fakeBin, { recursive: true, force: true });
		}
		expect(h.notifyLog.join("\n")).toMatch(/1 个凭证已就绪/); // 迁移未因竞态中断
		expect(h.notifyLog.join("\n")).toMatch(/shred 执行失败/); // 销毁强度降级照常告知
		await expect(stat(h.storePath)).rejects.toThrow(/ENOENT/); // 目标保持已删除
		await expect(stat(ageFile(h))).resolves.toBeDefined(); // 密文已落盘
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

describe("age 后端：r4 findings 收口", () => {
	it("r4 #1：密文存在但身份密钥丢失 → persist 显式拒绝（不生成新钥覆盖旧密文），文案含恢复指引", async () => {
		const h = await setupHarness(SEED, undefined, "age");
		await start(h);
		const cipherBefore = await readFile(ageFile(h), "utf8");
		await rm(keyFile(h));
		const backend = await createBackend(h.agentDir);
		await expect(backend.persist(SEED)).rejects.toThrow(/请勿删除两者/);
		// 旧密文逐字节保留、新钥未被生成
		await expect(readFile(ageFile(h), "utf8")).resolves.toBe(cipherBefore);
		await expect(stat(keyFile(h))).rejects.toThrow(/ENOENT/);
	});

	it("r4 #7：删 keyFile 后触发命令写路径（forget）→ 拒绝写入且旧密文原样保留", async () => {
		const h = await setupHarness(SEED, undefined, "age");
		await start(h);
		const cipherBefore = await readFile(ageFile(h), "utf8");
		await rm(keyFile(h));
		await h.commands.get("secret-store").handler("forget HARBOR_PASSWORD", toolCtx(h));
		expect(h.notifyLog.join("\n")).toMatch(/解密失败/);
		expect(h.notifyLog.join("\n")).toContain("请勿删除两者");
		await expect(readFile(ageFile(h), "utf8")).resolves.toBe(cipherBefore);
		await expect(stat(keyFile(h))).rejects.toThrow(/ENOENT/);
	});

	it("r4 #2：shred 兜底覆写失败 → 上抛保留原文件（不允许未覆写即删除的静默降级）", async () => {
		if (typeof process.getuid === "function" && process.getuid() === 0) return; // root 无视权限位，无法构造覆写失败
		const h = await setupHarness(SEED, undefined, "age");
		const raw = await readFile(h.storePath, "utf8");
		await chmod(h.storePath, 0o400); // 原明文只读 → shred 与覆写兜底都 EACCES
		await start(h);
		expect(h.notifyLog.join("\n")).toMatch(/存储不可读/); // 迁移失败显式报错，不呈现成功
		await expect(readFile(h.storePath, "utf8")).resolves.toBe(raw); // 原文件保留
	});

	it("r4 #3：conf 运行期翻转 age→plain → 写路径仍走已缓存后端（无双正典交叉写）", async () => {
		const h = await setupHarness(SEED_TWO, undefined, "age");
		await start(h); // 首次读 conf=age 并缓存
		await writeFile(join(h.agentDir, "secret-store.conf"), "backend = plain\n", { mode: 0o600 });
		await h.commands.get("secret-store").handler("forget B_TOKEN", toolCtx(h));
		const q = await runExact(h, "secret_query", { name: "B_TOKEN" });
		expect(q.content[0].text).toContain("不存在"); // 写入须落在同一正典：密文里 B 已删
		await expect(stat(h.storePath)).rejects.toThrow(/ENOENT/); // 明文正典不被创建
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
