/**
 * 存储后端接口化（#173）：磁盘正典可插拔。
 * - age（缺省）：密文 secret-store.json.age + 身份密钥 secret-store.key（0600，与密文分离）；解密装载进内存，
 *   写时 `age -r <pub>` 加密 tmp+rename 原子落盘；首次检测到遗留明文 secret-store.json → 自动加密迁移并
 *   shred 原文件（D7=a，全程扩展进程内存，agent 与上下文不经手明文）。
 * - plain：#170 现行为原样（明文 json 0600），仅显式配置才用——缺省降级明文不存在。
 * 选择：agentDir/secret-store.conf 的 `backend = age|plain`（缺省 age；非法值 fail closed 报错）。
 * age 走真实 CLI（PATH → ~/.local/bin；PI_SECRET_STORE_AGE_BIN 可定向，测试用），纯本地运算无网络；
 * age 缺失/解密失败/错钥/损坏密文一律显式报错（含安装指引），不静默降级、不清数据。
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadStore, parseStoreText, stageTmp, storePaths, validateStore, withStoreLock, type Store } from "./store.ts";

export interface StoreBackend {
	/** 读整店：仅 ENOENT/首次使用视为空；其余错误上抛（fail closed，调用方不得重写任何文件） */
	load(onWarning?: (msg: string) => void): Promise<Store>;
	/** 整店原子持久化（调用方持锁） */
	persist(store: Store): Promise<void>;
	/** 锁文件基准路径（跨进程互斥粒度 = 存储正典文件） */
	readonly lockPath: string;
}

const serialize = (store: Store): string => `${JSON.stringify({ secrets: store }, null, 2)}\n`;

// ---------------------------------------------------------------- plain ----

const plainBackend = (storePath: string): StoreBackend => ({
	lockPath: `${storePath}.lock`,
	async load(onWarning) {
		return loadStore(storePath, onWarning);
	},
	async persist(store) {
		const tmp = await stageTmp(storePath, serialize(store));
		try {
			await rename(tmp, storePath);
			await chmod(storePath, 0o600).catch(() => {});
		} catch (err) {
			await unlink(tmp).catch(() => {});
			throw err;
		}
	},
});

// ------------------------------------------------------------------ age ----

const AGE_INSTALL_HINT =
	"secret-store: age 加密工具不可用。安装指引：从 https://github.com/FiloSottile/age/releases 下载并将 " +
	"age 与 age-keygen 放入 ~/.local/bin（或用系统包管理器安装），验证命令：~/.local/bin/age --version。" +
	"也可经 PI_SECRET_STORE_AGE_BIN 指定 age 二进制路径。当前无法读写存储，凭证功能停用（不降级明文）。";

// r6 #4：解析成功后进程内固化，整个进程生命周期不再重试——运行期安装 age 不生效，需重启 pi session。
let ageBinCache: string | undefined;

/** age 二进制解析：PI_SECRET_STORE_AGE_BIN 优先（仅定向，不回退）→ PATH → ~/.local/bin。 */
async function resolveAgeBin(): Promise<string> {
	if (process.env.PI_SECRET_STORE_AGE_BIN) return process.env.PI_SECRET_STORE_AGE_BIN;
	if (ageBinCache) return ageBinCache;
	for (const candidate of ["age", join(homedir(), ".local", "bin", "age")]) {
		try {
			const r = await runCapture(candidate, ["--version"]);
			if (r.code === 0) return (ageBinCache = candidate);
		} catch {
			// ENOENT：试下一个候选
		}
	}
	throw new Error(AGE_INSTALL_HINT);
}

const ageKeygenBin = async (): Promise<string> => join(dirname(await resolveAgeBin()), "age-keygen");

interface RunResult {
	code: number;
	stdout: Buffer;
	stderr: string;
}

/** spawn 收集（stdout 按二进制收集——age 输出非 armor 的二进制密文，字符串化会损坏）；input 缺省立即关 stdin。 */
function runCapture(bin: string, args: string[], input?: string): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
		const chunks: Buffer[] = [];
		let stderr = "";
		child.stdout.on("data", (d: Buffer) => chunks.push(d));
		child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
		child.on("error", reject);
		child.on("close", (code) => resolve({ code: code ?? -1, stdout: Buffer.concat(chunks), stderr }));
		child.stdin.end(input ?? "");
	});
}

/** 身份密钥首次不存在 → 零交互 age-keygen 生成（0600，tmp+rename）。空存储首用的生成无锁：
 *  竞态双生成 last-wins 无害（此阶段尚无密文可解）；迁移路径的调用在存储锁内。 */
async function ensureIdentity(keyPath: string): Promise<void> {
	try {
		await stat(keyPath);
		return;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	try {
		const keygen = await ageKeygenBin();
		const tmp = `${keyPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
		const r = await runCapture(keygen, ["-o", tmp]);
		if (r.code !== 0) throw new Error(`age-keygen exit ${r.code}：${r.stderr.trim()}`);
		await chmod(tmp, 0o600).catch(() => {});
		await rename(tmp, keyPath);
	} catch (err) {
		throw new Error(`secret-store: 身份密钥生成失败（${keyPath}）：${(err as Error).message}。${AGE_INSTALL_HINT}`, { cause: err });
	}
}

/** 加密接收方：优先读 keygen 写入的 `# public key:` 注释行；缺失则 `age-keygen -y` 反推。 */
async function recipientOf(keyPath: string): Promise<string> {
	const text = await readFile(keyPath, "utf8");
	const m = /^# public key: (\S+)$/m.exec(text);
	if (m) return m[1];
	const r = await runCapture(await ageKeygenBin(), ["-y", keyPath]);
	if (r.code !== 0) throw new Error(`secret-store: 无法从身份密钥推导公钥（${r.stderr.trim()}）`);
	return r.stdout.toString("utf8").trim();
}

async function decryptStoreText(cipherPath: string, keyPath: string): Promise<string> {
	const r = await runCapture(await resolveAgeBin(), ["-d", "-i", keyPath, cipherPath]);
	if (r.code !== 0) {
		const detail = r.stderr.trim().split("\n").filter(Boolean).pop() ?? `exit ${r.code}`;
		throw new Error(
			`secret-store: age 解密失败（${detail}）。密文 ${cipherPath} 与身份密钥 ${keyPath} 可能不匹配或已损坏；` +
				"凭证在恢复前并未丢失，请勿删除两者（确认放弃后同时删除密文与密钥可重置存储）。",
		);
	}
	return r.stdout.toString("utf8");
}

async function encryptToFile(plain: string, outPath: string, keyPath: string): Promise<void> {
	const r = await runCapture(await resolveAgeBin(), ["-r", await recipientOf(keyPath)], plain);
	if (r.code !== 0) throw new Error(`secret-store: age 加密失败（${r.stderr.trim().split("\n").pop() ?? `exit ${r.code}`}）`);
	const tmp = `${outPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	try {
		await writeFile(tmp, r.stdout, { mode: 0o600, flag: "wx" });
		await rename(tmp, outPath);
		await chmod(outPath, 0o600).catch(() => {});
	} catch (err) {
		await unlink(tmp).catch(() => {});
		throw err;
	}
}

/** shred -u 原文件（D7=a）；shred 缺失（非 GNU 环境）→ 覆写后删除兜底；shred 存在但执行失败（r5 #3）→
 *  兜底删除照常，但实际销毁强度降为单次覆写，经 onWarning 告知；覆写兜底自身失败仍上抛（r4 #2）；
 *  目标已消失（并发迁移）视为成功。 */
async function shredFile(path: string, onWarning?: (msg: string) => void): Promise<void> {
	try {
		await stat(path);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
		throw err;
	}
	try {
		const r = await runCapture("shred", ["-u", path]);
		if (r.code === 0) return;
		const detail = r.stderr.trim();
		onWarning?.(
			`secret-store: shred 执行失败（exit ${r.code}${detail ? `：${detail}` : ""}），原文件 ${path} 以单次随机覆写+删除兜底销毁（弱于 shred 多遍覆写），如需确保销毁强度请手动处理`,
		);
	} catch {
		// shred 不在 PATH（command not found）：静默走覆写兜底
	}
	// 覆写失败上抛（r4 #2）：不允许"未覆写即删除"的静默降级——保留原文件交手动处理。
	// r6 #3：shred 失败到兑底之间目标可能已被并发删除——stat 包 try/catch，ENOENT 按"已消失视为成功"返回
	// （与顶部 stat 语义一致），其他错误照旧上抛；writeFile 为 'w' 截断重写（非原地覆写），
	// 随机串长度 = max(64, 原大小) ≥ 原文件，全文件单次随机覆写后删除。
	let size = 64;
	try {
		size = Math.max(64, (await stat(path)).size);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
		throw err;
	}
	await writeFile(path, randomBytes(size));
	await unlink(path);
}

const ageBackend = (plainPath: string, cipherPath: string, keyPath: string): StoreBackend => ({
	lockPath: `${cipherPath}.lock`,
	async load(onWarning) {
		let hasCipher: boolean;
		try {
			await stat(cipherPath);
			hasCipher = true;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			hasCipher = false;
		}
		if (hasCipher) {
			// 密文与遗留明文并存（迁移时 shred 失败的残留）→ 密文为准，提示手动清理
			await stat(plainPath)
				.then(() => onWarning?.(`secret-store: 检测到密文与遗留明文并存（${plainPath}），以密文为准，请手动删除明文文件`))
				.catch(() => {});
			return parseStoreText(await decryptStoreText(cipherPath, keyPath), cipherPath, onWarning);
		}
		let legacyRaw: string | undefined;
		try {
			legacyRaw = await readFile(plainPath, "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}
		if (legacyRaw === undefined) {
			await ensureIdentity(keyPath); // 首次使用：零交互生成身份密钥（0600）
			return Object.create(null) as Store;
		}
		return migrateLegacy(legacyRaw, plainPath, cipherPath, keyPath, onWarning);
	},
	async persist(store) {
		// 防覆盖（r4 #1）：密文已存在但解不开（身份密钥丢失/被换）→ 显式拒绝写入——否则 ensureIdentity 会
		// 生成新钥覆盖出与旧密文无关的新密文，旧凭证不可恢复丢失且无感知。报错文案与 load 恢复指引一致。
		let hasCipher = false;
		try {
			await stat(cipherPath);
			hasCipher = true;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}
		if (hasCipher) await decryptStoreText(cipherPath, keyPath);
		await ensureIdentity(keyPath);
		await encryptToFile(serialize(store), cipherPath, keyPath);
	},
});

/** 遗留明文迁移（D7=a）：内存解析校验（损坏即中止，原文件不动）→ 存储锁内加密落盘 → shred 原文件。
 *  明文只在扩展进程内存与 age 的 stdin 管道中经过，不进上下文/日志/agent 可见面。 */
async function migrateLegacy(
	raw: string,
	plainPath: string,
	cipherPath: string,
	keyPath: string,
	onWarning?: (msg: string) => void,
): Promise<Store> {
	const store = parseStoreText(raw, plainPath, onWarning);
	await withStoreLock(cipherPath, async () => {
		await ensureIdentity(keyPath);
		await encryptToFile(serialize(store), cipherPath, keyPath);
		await shredFile(plainPath, onWarning);
	});
	return store;
}

// -------------------------------------------------------------- 选择/写协议 ----

async function readBackendChoice(confPath: string): Promise<"age" | "plain" | undefined> {
	let raw: string;
	try {
		raw = await readFile(confPath, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined; // 缺省 age（#173）
		throw err;
	}
	for (const line of raw.split("\n")) {
		const t = line.trim();
		if (!t || t.startsWith("#")) continue;
		const m = /^backend\s*=\s*(\S+)\s*$/.exec(t);
		if (!m) continue;
		if (m[1] !== "age" && m[1] !== "plain") throw new Error(`secret-store: ${confPath} 的 backend 值非法（"${m[1]}"，仅支持 age | plain）`);
		return m[1];
	}
	return undefined;
}

export async function createBackend(agentDir: string): Promise<StoreBackend> {
	const { storePath, storePathAge, keyPath, confPath } = storePaths(agentDir);
	const choice = await readBackendChoice(confPath);
	if (choice === "plain") return plainBackend(storePath);
	return ageBackend(storePath, storePathAge, keyPath);
}

/**
 * [11]/[12] 跨进程互斥的读-改-写（经后端）：锁内 reload → merge → 后端原子提交。
 * mutator 返回 undefined 表示无需变更（不重写文件）。lockfile 无 fencing：持锁进程若停顿
 * 超过 LOCK_TIMEOUT_MS 可能被按 stale 抢占——mutator 窗口为毫秒级，实际风险可忽略。
 */
export async function updateStore(
	agentDir: string,
	storePath: string,
	mutate: (store: Store) => Store | undefined,
	backend?: Promise<StoreBackend>, // r4 #3：调用方传入 factory 缓存的实例——缺省每次新建会重读 conf，运行期 age↔plain 翻转会让同一存储被两套正典交叉写
): Promise<Store> {
	await mkdir(agentDir, { recursive: true });
	const b = await (backend ?? createBackend(agentDir));
	return withStoreLock(b.lockPath, async () => {
		const store = await b.load();
		const next = mutate(store);
		if (next === undefined) return store;
		validateStore(next); // [9] 任一条目非法 → 整体拒绝，零文件落地
		await b.persist(next);
		return next;
	});
}
