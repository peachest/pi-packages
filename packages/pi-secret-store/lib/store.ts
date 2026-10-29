/**
 * 持久化存储：~/.pi/agent/secret-store.json（0600、唯一 tmp+rename 原子写、跨进程更新锁）。
 * env 文件侧已随 #170 选择性注入移除（注入改走内存 store 快照），legacyEnvFile 仅为退役删除而保留路径。
 * 移植自 ~/tmp/secret-store-proto/index.ts 的 loadStore。
 */
import { randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { open, readFile, stat, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { MIN_REDACT_LENGTH } from "./redact.ts";

export interface StoreEntry {
	value: string;
	updatedAt: string;
	fingerprint: string;
	/** 命令首词前缀限定（#171）：非空时首词命中任一前缀才注入；缺省/[] = 任意命令可用。 */
	allowedPrefix?: string[];
}
export type Store = Record<string, StoreEntry>;

export const storePaths = (agentDir: string) => ({
	storePath: join(agentDir, "secret-store.json"),
	storePathAge: join(agentDir, "secret-store.json.age"), // age 后端正典（#173）：密文
	keyPath: join(agentDir, "secret-store.key"), // age 身份密钥（0600，与密文分离）
	confPath: join(agentDir, "secret-store.conf"), // 后端选择配置（缺省 age）
	legacyEnvFile: join(agentDir, "secret-store.env"), // v1 遗留 env 文件，session_start 退役删除
});

/** 合法凭证名 = bash 变量名（[5]）：env 行的赋值目标，放宽即命令注入/语法错误。 */
export const STORE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 保留名黑名单：source 后直接控制 shell 行为的变量，禁止用作凭证名（#126）。 */
const RESERVED_NAMES = new Set(["PATH", "IFS", "BASH_ENV", "SHELLOPTS", "BASHOPTS", "PS1", "HOME", "UID", "EUID"]);

/** 凭证名完整校验：bash 变量名 RE（[5]）+ 保留名黑名单（PATH/IFS 等可劫持 shell 行为，SHELL* 前缀同理）。 */
export function nameProblem(name: string): string | undefined {
	if (!STORE_NAME_RE.test(name)) return "变量名不合法（须匹配 ^[A-Za-z_][A-Za-z0-9_]*$）";
	if (RESERVED_NAMES.has(name) || name.startsWith("SHELL")) return "保留 shell 变量名，禁止用作凭证名";
	return undefined;
}

/** [5]/[7]/[13] 条目形状校验：名字合法、value 是字符串、不含 NUL、达到脱敏阈值（Redactor 短于 4 字符会静默忽略）、
 *  allowedPrefix（若给出）是字符串数组且元素非空串/无首尾空白（#171；空串元素 startsWith 恒真 = 完全取消限定）。
 *  读（手改 JSON）与写共用本入口，两路都拦。 */
function entryProblem(name: string, entry: unknown): string | undefined {
	const nameErr = nameProblem(name);
	if (nameErr) return nameErr;
	if (typeof entry !== "object" || entry === null || typeof (entry as StoreEntry).value !== "string") return "value 非字符串";
	const { value, allowedPrefix } = entry as StoreEntry;
	if (value.includes("\0")) return "value 含 NUL 字符";
	if (value.length < MIN_REDACT_LENGTH) return `value 短于 ${MIN_REDACT_LENGTH} 字符，无法可靠脱敏`;
	if (allowedPrefix !== undefined) {
		if (!Array.isArray(allowedPrefix) || allowedPrefix.some((p) => typeof p !== "string"))
			return "allowedPrefix 必须是字符串数组";
		if (allowedPrefix.some((p) => p.length === 0 || p.trim() !== p))
			return "allowedPrefix 元素不能为空串或含首尾空白";
	}
	return undefined;
}

/** [9] 整店校验：任一条目非法 → 抛错（调用方在任何文件落地前拒绝）。 */
export function validateStore(store: Store): void {
	for (const [name, entry] of Object.entries(store)) {
		const problem = entryProblem(name, entry);
		if (problem) throw new Error(`secret-store: 拒绝写入，条目 ${name} 校验失败：${problem}`);
	}
}

/**
 * 读存储（[13]）：仅 ENOENT 视为空存储；JSON 损坏/顶层非对象/权限等错误上抛（调用方不得重写任何文件）。
 * 解析后逐条校验形状，非法条目跳过并经 onWarning 告知。
 */
export async function loadStore(storePath: string, onWarning?: (msg: string) => void): Promise<Store> {
	let raw: string;
	try {
		raw = await readFile(storePath, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return Object.create(null) as Store; // 与填充路径一致：null 原型，原型继承属性不可误判为条目（#126）
		throw err;
	}
	return parseStoreText(raw, storePath, onWarning);
}

/** 已读文本 → Store（age 后端解密产物共用同一解析/校验路径，#173）。
 *  strict（迁移路径专用）= 结构/条目级 problem 即抛错而非跳过——migrateLegacy 随后 shred 原明文，
 *  宽松跳过会变成"静默丢弃+销毁原件"（不可恢复）；strict 抛错使原文件保留。读路径（loadStore/age 解密装载）
 *  维持宽松跳过（现网行为）。 */
export function parseStoreText(raw: string, storePath: string, onWarning?: (msg: string) => void, strict = false): Store {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (cause) {
		throw new Error(`secret-store: 存储文件 JSON 损坏（${storePath}），拒绝按空存储处理以防覆盖`, { cause });
	}
	if (typeof parsed !== "object" || parsed === null) throw new Error(`secret-store: 存储文件顶层必须是对象（${storePath}）`);
	const secrets = (parsed as { secrets?: unknown }).secrets;
	if (secrets === undefined) return Object.create(null) as Store;
	if (typeof secrets !== "object" || secrets === null) {
		if (strict) throw new Error(`secret-store: 存储文件 ${storePath} secrets 字段非对象，迁移中止（原文件保留未动）`);
		onWarning?.("secret-store: secrets 字段非对象，按空存储处理");
		return Object.create(null) as Store;
	}
	const out = Object.create(null) as Store; // null 原型：磁盘条目名不可信（__proto__ 键不得触发原型链写）
	for (const [name, entry] of Object.entries(secrets)) {
		const problem = entryProblem(name, entry);
		if (problem) {
			if (strict)
				throw new Error(
					`secret-store: 存储文件 ${storePath} 条目 ${name} 校验失败（${problem}），迁移中止：原文件保留未动、未写任何密文；请修复或移除该条目后重试`,
				);
			onWarning?.(`secret-store: 忽略条目 ${name}：${problem}`);
		} else {
			const e = entry as StoreEntry;
			// 显式构造新条目对象（allowedPrefix schema 迁移补全，#171），不共享解析中间对象引用
			out[name] = { ...e, allowedPrefix: e.allowedPrefix ?? [] };
		}
	}
	return out;
}

const LOCK_TIMEOUT_MS = 10_000;
const LOCK_POLL_MS = 50;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function acquireLock(lockPath: string, deadline: number): Promise<FileHandle> {
	for (;;) {
		try {
			return await open(lockPath, "wx", 0o600); // O_EXCL：跨进程独占创建
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			// stale 抢占先于超时判定：持锁者崩溃遗留的锁到龄即接管
			try {
				if (Date.now() - (await stat(lockPath)).mtimeMs > LOCK_TIMEOUT_MS) await unlink(lockPath).catch(() => {});
			} catch {
				// 锁已消失，下轮直接尝试获取
			}
			if (Date.now() >= deadline) throw new Error(`secret-store: 等待存储锁超时（${LOCK_TIMEOUT_MS}ms，疑似持锁进程挂死）`);
			await sleep(LOCK_POLL_MS);
		}
	}
}

/** 同一异步链内的锁重入跟踪：updateStore 持锁后调 backend.load，其首次使用/迁移分支会再进
 *  withStoreLock——同一锁文件自取会自旋到超时。ALS 只沿 await 链传播：并发 session 的兄弟调用各自
 *  取锁，互斥语义不变。 */
const heldLock = new AsyncLocalStorage<string>();

/** [5] 跨进程互斥锁原语：updateStore 读-改-写共用。 */
export async function withStoreLock<T>(storePath: string, fn: () => Promise<T>): Promise<T> {
	const lockPath = `${storePath}.lock`;
	if (heldLock.getStore() === lockPath) return fn(); // 同链重入直通
	return heldLock.run(lockPath, async () => {
		const fd = await acquireLock(lockPath, Date.now() + LOCK_TIMEOUT_MS);
		try {
			await fd.writeFile(String(process.pid)); // 记录持锁者，便于诊断遗留锁
			return await fn();
		} finally {
			await fd.close();
			await unlink(lockPath).catch(() => {});
		}
	});
}

/** [8] 唯一 tmp（pid+随机）+ wx 独占创建，0600；写失败清理 tmp，rename 由调用方负责。 */
export async function stageTmp(path: string, content: string): Promise<string> {
	const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	try {
		await writeFile(tmp, content, { mode: 0o600, flag: "wx" });
		return tmp;
	} catch (err) {
		await unlink(tmp).catch(() => {});
		throw err;
	}
}

/** bash 单引号字面量：'…' 内一切字符（含 $、反引号、真实换行）皆字面；' 自身以 '\'' 表达（[4]）。[11] 注入前缀逐变量引用同款。 */
export const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
