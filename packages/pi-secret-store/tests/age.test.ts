/**
 * age 加密存储后端单测（#173，走入口，测试内真实执行 age CLI——本机 v1.2.1，纯本地运算无网络）：
 * 遗留明文自动迁移（加密转 .age + shred 原文件，D7=a）+ 身份密钥零交互生成（0600）+
 * 加解密 round-trip（解密装载/注入/脱敏与 plain 一致）+ 错钥/损坏密文/age 缺失显式报错不静默降级 +
 * plain 显式配置回归 + conf 非法值 fail closed。
 */
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createBackend } from "../lib/backend.ts";
import { withStoreLock } from "../lib/store.ts";
import { assertAgeBackend, cleanupEnv, hasRealAge, runExact, runToolCall, setupHarness, toolCtx, toolResultEvent, type Harness } from "./helpers.ts";

const run = promisify(execFile);

// 终审 P2 #3：依赖本机真实 age 的 describe 共 8 个（直调或 shim 包装真实 age——终审报告"其余全走 fake bin"系误判，
// 实测未装 age 机器 16/23 红），统一 hasRealAge 守卫（helpers.ts，探测 ~/.local/bin/age 可执行性）：缺失即 describe 级
// skip（requires local age binary at ~/.local/bin; install per README），自包含 fake bin 测试（超时/输出上限等）不受影响。

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

describe.skipIf(!hasRealAge)("age 后端：遗留明文自动迁移（D7=a）", () => {
	it("首次运行：明文 store 加密转为 .age、shred 删除原文件、身份密钥自动生成 0600，明文不进上下文", async () => {
		const h = await setupHarness(SEED, undefined, "age");
		await assertAgeBackend(h); // r7 #7 防呆：确保跑在声明的 age 后端下
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

	it("r8 #2：shred 存在但执行失败 → 不再“覆写+删除”兜底：原文件保留交手动处理，告警销毁未达成", async () => {
		const h = await setupHarness(SEED, undefined, "age");
		// fake shred：PATH 最前放置 exit 1 同名脚本——shred 可执行但失败（非 command not found）
		const fakeBin = await mkdtemp(join(tmpdir(), "fake-shred-"));
		await writeFile(join(fakeBin, "shred"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
		const savedPath = process.env.PATH;
		process.env.PATH = `${fakeBin}:${savedPath}`;
		try {
			await start(h); // 迁移：shred exit 1 → 保留原文件 + 销毁未达成告警（r8 #2 不做删除兜底）
		} finally {
			process.env.PATH = savedPath;
			await rm(fakeBin, { recursive: true, force: true });
		}
		expect(h.notifyLog.join("\n")).toMatch(/1 个凭证已就绪/); // 迁移照常完成（密文为正典）
		expect(h.notifyLog.join("\n")).toMatch(/shred 执行失败/);
		expect(h.notifyLog.join("\n")).toMatch(/销毁未达成/);
		await expect(readFile(h.storePath, "utf8")).resolves.toContain("harbor-secret-value"); // 原文件保留未动
		await expect(stat(ageFile(h))).resolves.toBeDefined(); // 密文照常落盘
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
		expect(h.notifyLog.join("\n")).toMatch(/视为已处理/); // r8 #2：失败后目标已不在 → 无从保留，视为已处理
		await expect(stat(h.storePath)).rejects.toThrow(/ENOENT/); // 目标保持已删除
		await expect(stat(ageFile(h))).resolves.toBeDefined(); // 密文已落盘
	});

	it("review-high #2：遗留明文含非法条目 → 迁移抛错中止，原文件保留、无密文无密钥落盘（条目级损坏不再静默丢弃+shred 销毁）", async () => {
		const h = await setupHarness(undefined, undefined, "age");
		await assertAgeBackend(h);
		// 一好一坏：GOOD_TOKEN 可迁移，bad-name 违反变量名规则（entryProblem 命中）
		const raw = `${JSON.stringify(
			{
				secrets: {
					GOOD_TOKEN: { value: "good-token-value-1", updatedAt: "t", fingerprint: "fp0000gg11" },
					"bad-name": { value: "bad-name-value-12", updatedAt: "t", fingerprint: "fp0000bb11" },
				},
			},
			null,
			2,
		)}\n`;
		await writeFile(h.storePath, raw, { mode: 0o600 });
		await start(h); // session_start 捕获 load 错误转通知（[13]：文件不动）
		const log = h.notifyLog.join("\n");
		expect(log).toContain("bad-name");
		expect(log).toContain("迁移中止");
		expect(await readFile(h.storePath, "utf8")).toBe(raw); // 原明文逐字节保留（不 shred）
		await expect(stat(ageFile(h))).rejects.toThrow(/ENOENT/); // 无密文落盘（非法条目不被静默丢弃后加密）
		await expect(stat(keyFile(h))).rejects.toThrow(/ENOENT/); // 无密钥生成（严格解析先于 ensureIdentity）
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

describe.skipIf(!hasRealAge)("age 后端：解密装载 round-trip（行为与 plain 一致）", () => {
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

describe.skipIf(!hasRealAge)("age 后端：错误路径显式报错（不静默降级）", () => {
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

describe.skipIf(!hasRealAge)("age 后端：配置选择（conf 文件）", () => {
	it("空存储首次使用 → 身份密钥零交互生成（0600），不创建密文", async () => {
		const h = await setupHarness(undefined, undefined, "age");
		await assertAgeBackend(h); // r7 #7 防呆
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

describe.skipIf(!hasRealAge)("age 后端：r4 findings 收口", () => {
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

	it("r8 #2：shred 不可用（不在 PATH）→ 同样保留原文件交手动处理 + 告警（不再覆写+删除兜底，无静默降级）", async () => {
		const h = await setupHarness(SEED, undefined, "age");
		// PATH 只含 age shim 目录（无 shred）：command not found → 不做删除兜底（r8 #2）
		const fakeBin = await mkdtemp(join(tmpdir(), "no-shred-"));
		const realBin = join(process.env.HOME ?? "/nonexistent", ".local", "bin");
		await writeFile(join(fakeBin, "age"), `#!/bin/sh\nexec ${realBin}/age "$@"\n`, { mode: 0o755 });
		await copyFile(join(realBin, "age-keygen"), join(fakeBin, "age-keygen"));
		const savedPath = process.env.PATH;
		process.env.PATH = fakeBin;
		try {
			await start(h);
		} finally {
			process.env.PATH = savedPath;
			await rm(fakeBin, { recursive: true, force: true });
		}
		expect(h.notifyLog.join("\n")).toMatch(/shred 不可用/);
		expect(h.notifyLog.join("\n")).toMatch(/销毁未达成/);
		await expect(readFile(h.storePath, "utf8")).resolves.toContain("harbor-secret-value"); // 原文件保留
		await expect(stat(ageFile(h))).resolves.toBeDefined(); // 迁移照常完成
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

describe.skipIf(!hasRealAge)("age 后端：首次使用路径持锁（r7 #1 跨 session 密钥竞态）", () => {
	const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

	it("并发 session 持锁期间，首次使用 load 阻塞等待：不锁外生成密钥（与 persist 临界区串行）", async () => {
		const h = await setupHarness(undefined, undefined, "age");
		const backend = await createBackend(h.agentDir);
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const holder = withStoreLock(ageFile(h), () => gate); // 模拟 session A 在 persist 临界区（ensureIdentity→encrypt 窗口）持锁
		const bLoad = backend.load(); // session B 首次使用：无密文/明文/密钥
		await sleep(300);
		await expect(stat(keyFile(h))).rejects.toThrow(/ENOENT/); // 旧实现：锁外 keygen 已落盘（红）
		release();
		await bLoad;
		await expect(stat(keyFile(h))).resolves.toBeDefined(); // 锁释放后才生成
		await holder;
	});

	it("持锁期间已落盘的密钥不被并发首次使用 load 覆盖（覆盖即已加密文永久不可解）", async () => {
		const h = await setupHarness(undefined, undefined, "age");
		const backend = await createBackend(h.agentDir);
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const holder = withStoreLock(ageFile(h), () => gate);
		const KEY_A = "# public key: age1fake0000000000000000000000000000000000000000000000000000000000\n";
		await writeFile(keyFile(h), KEY_A, { mode: 0o600 }); // 模拟 A 的 ensureIdentity 已完成
		const bLoad = backend.load();
		// 旧实现：锁外 stat 命中即返回（红）；新实现：首次使用纳锁，持锁期间阻塞
		await expect(Promise.race([bLoad.then(() => "resolved"), sleep(300).then(() => "pending")])).resolves.toBe("pending");
		release();
		await bLoad;
		await expect(readFile(keyFile(h), "utf8")).resolves.toBe(KEY_A); // K_A 未被覆盖
		await holder;
	});

	it("updateStore 锁内 reload 走首次使用分支 → 同链锁重入直通，不自旋到锁超时（r7 #1 配套回归）", async () => {
		const h = await setupHarness(undefined, undefined, "age");
		await h.commands.get("secret-store").handler("forget NOPE", toolCtx(h));
		expect(h.notifyLog.join("\n")).toContain("不存在"); // 无 ALS 重入时此处会是“等待存储锁超时”
		expect((await stat(keyFile(h))).mode & 0o777).toBe(0o600); // 首次使用密钥生成照常在锁内完成
	});
});

describe("age 后端：外部工具调用超时（r8 #5）", () => {
	it("挂起的 age → runCapture 超时 kill 并 reject（文案含工具名），load 显式失败不静默、无密文落盘", async () => {
		const fakeBin = await mkdtemp(join(tmpdir(), "age-hang-"));
		// age 与 age-keygen 都挂起：迁移路径首调的是 age-keygen（ensureIdentity），其二进制须存在才走得进挂起
		await writeFile(join(fakeBin, "age"), "#!/bin/sh\nexec sleep 60\n", { mode: 0o755 });
		await writeFile(join(fakeBin, "age-keygen"), "#!/bin/sh\nexec sleep 60\n", { mode: 0o755 });
		process.env.PI_SECRET_STORE_AGE_BIN = join(fakeBin, "age");
		process.env.PI_SECRET_STORE_TIMEOUT_MS = "300";
		try {
			const h = await setupHarness(SEED, undefined, "age");
			await start(h); // 迁移路径第一个 age 调用（resolveAgeBin --version）即挂起 → 超时
			expect(h.notifyLog.join("\n")).toMatch(/执行超时/);
			expect(h.notifyLog.join("\n")).toContain("age");
			await expect(stat(ageFile(h))).rejects.toThrow(/ENOENT/); // 不静默降级：无密文落盘
		} finally {
			delete process.env.PI_SECRET_STORE_AGE_BIN;
			delete process.env.PI_SECRET_STORE_TIMEOUT_MS;
			await rm(fakeBin, { recursive: true, force: true });
		}
	}, 10_000);
});

describe.skipIf(!hasRealAge)("age 后端：persist 防覆盖校验复用 load 解密结果（r7 #6；r8 #1 改密文内容指纹）", () => {
	it("密文未变时 persist 不重跑 age -d；同精度窗口内同 size 重写密文（mtime 复位）后仍触发重验并拒绝写入", async () => {
		const realBin = join(process.env.HOME ?? "/nonexistent", ".local", "bin");
		const fakeBin = await mkdtemp(join(tmpdir(), "age-log-"));
		const logFile = join(fakeBin, "age-calls.log");
		await writeFile(join(fakeBin, "age"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${logFile}\nexec ${realBin}/age "$@"\n`, {
			mode: 0o755,
		});
		await copyFile(join(realBin, "age-keygen"), join(fakeBin, "age-keygen"));
		process.env.PI_SECRET_STORE_AGE_BIN = join(fakeBin, "age");
		const dCount = async () => (await readFile(logFile, "utf8")).split("\n").filter((l) => l.startsWith("-d ")).length;
		try {
			const h = await setupHarness(SEED, undefined, "age");
			await assertAgeBackend(h);
			const backend = await createBackend(h.agentDir);
			await backend.load(); // 迁移：明文 → 密文（仅加密，无 -d）
			await backend.load(); // 解密装载：-d ×1，记录密文内容指纹
			expect(await dCount()).toBe(1);
			await backend.persist(SEED_TWO); // 锁内刚 load 过 → 复用校验不再 -d（旧实现再 -d 一次，红）
			expect(await dCount()).toBe(1);
			// r8 #1：同精度窗口内同 size 重写密文 + mtime 复位伪装未变 → 内容指纹不一致仍触发重验；
			// 旧 mtime+size 缓存会误跳重验直接覆写（红）——错钥/被换密文下 ensureIdentity 不再可能覆盖密文。
			// 先把 mtime 固定到整秒（utimes 往返精确），load #2 缓存的就是这个值：复位后旧缓存必然命中。
			const cipherPath = ageFile(h);
			const epoch = new Date(1_700_000_000_000);
			await utimes(cipherPath, epoch, epoch);
			await backend.load();
			expect(await dCount()).toBe(2); // epoch 固定后的重载：-d ×2，缓存内容指纹
			const tampered = Buffer.from(await readFile(cipherPath));
			tampered[Math.floor(tampered.length / 2)] ^= 0xff; // 翻转密文体字节：长度不变、内容变化
			await writeFile(cipherPath, tampered, { mode: 0o600 });
			await utimes(cipherPath, epoch, epoch); // mtime/size 双复位：旧缓存判定面
			await expect(backend.persist(SEED_TWO)).rejects.toThrow(/解密失败/); // 重验 → 防覆盖拒绝
			expect(await dCount()).toBe(3);
			expect((await readFile(cipherPath)).equals(tampered)).toBe(true); // 被篡改密文未被覆盖
		} finally {
			delete process.env.PI_SECRET_STORE_AGE_BIN;
			await rm(fakeBin, { recursive: true, force: true });
		}
	});
});

describe.skipIf(!hasRealAge)("age 后端：真实加解密原语 round-trip（锦上添花的独立验证）", () => {
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

describe("age 后端：外部工具输出上限（r9 #5）", () => {
	it("超大 stdout 截断（1MB 上限）：迁移密文 ≤ 上限+一个 chunk，不再无界累积", async () => {
		const fakeBin = await mkdtemp(join(tmpdir(), "age-spew-"));
		// age --version exit 0（resolveAgeBin）；-r 忽略 stdin 吐 3MB；age-keygen 按 -o 落密钥文件（含 public key 注释行）
		await writeFile(
			join(fakeBin, "age"),
			'#!/bin/sh\ncase "$1" in\n  --version) exit 0;;\n  -r) head -c 3000000 /dev/zero;;\n  *) exit 3;;\nesac\n',
			{ mode: 0o755 },
		);
		await writeFile(
			join(fakeBin, "age-keygen"),
			'#!/bin/sh\nout=""\n[ "$1" = "-o" ] && out="$2"\nprintf "# public key: age1fake\\nAGE-SECRET-KEY-1FAKE0000\\n" > "$out"\n',
			{ mode: 0o755 },
		);
		process.env.PI_SECRET_STORE_AGE_BIN = join(fakeBin, "age");
		try {
			const h = await setupHarness(SEED, undefined, "age");
			await start(h); // 迁移：ensureIdentity → encryptToFile（age -r）→ 密文 = 截断后的 stdout
			const cipher = await readFile(ageFile(h));
			expect(cipher.length).toBeGreaterThan(0);
			expect(cipher.length).toBeLessThan(2_000_000); // 无上限时为 3MB（红）
		} finally {
			delete process.env.PI_SECRET_STORE_AGE_BIN;
			await rm(fakeBin, { recursive: true, force: true });
		}
	}, 10_000);
});
