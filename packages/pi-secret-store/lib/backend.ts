/**
 * 存储后端接口化（#173）：磁盘正典可插拔。
 * - age（缺省）：密文 secret-store.json.age + 身份密钥 secret-store.key（0600，与密文分离）；解密装载进内存，
 *   写时 `age -r <pub>` 加密 tmp+rename 原子落盘；首次检测到遗留明文 secret-store.json → 自动加密迁移并
 *   shred 原文件（D7=a，全程扩展进程内存，agent 与上下文不经手明文；shred 缺失/失败不兜底删除，
 *   保留原文件并告警交手动处理，r8 #2）。
 * - plain：#170 现行为原样（明文 json 0600），仅显式配置才用——缺省降级明文不存在。
 * 选择：agentDir/secret-store.conf 的 `backend = age|plain`（缺省 age；非法值 fail closed 报错）。
 * age 走真实 CLI（PATH → ~/.local/bin；PI_SECRET_STORE_AGE_BIN 可定向，测试用），纯本地运算无网络；
 * age 缺失/解密失败/错钥/损坏密文一律显式报错（含安装指引），不静默降级、不清数据。
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadStore, parseStoreText, stageTmp, storePaths, validateStore, withStoreLock, type Store } from "./store.ts";

export interface StoreBackend {
	/** 读整店：仅 ENOENT/首次使用视为空；其余错误上抛（fail closed，调用方不得重写任何文件） */
	load(onWarning?: (msg: string) => void): Promise<Store>;
	/** 整店原子持久化（调用方持锁）；onWarning：persist 分支 keygen/加密链路的非致命告警通道（review-high #5） */
	persist(store: Store, onWarning?: (msg: string) => void): Promise<void>;
	/** 锁文件基准路径（跨进程互斥粒度 = 存储正典文件） */
	readonly lockPath: string;
}

const serialize = (store: Store): string => `${JSON.stringify({ secrets: store }, null, 2)}\n`;

// ---------------------------------------------------------------- plain ----

const plainBackend = (storePath: string): StoreBackend => ({
	// r9 #2：基准 = storePath 正典路径（withStoreLock 统一追加 .lock）——旧值 `${storePath}.lock` 会锁成
	// .lock.lock，与 age 口径（r7 #1：锁基准 = 不带 .lock 的正典路径）不一致，跨路径锁不互斥。
	lockPath: storePath,
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

/** spawn 收集（stdout 按二进制收集——age 输出非 armor 的二进制密文，字符串化会损坏）；input 缺省立即关 stdin。
 *  r8 #5：外部工具调用超时（缺省 30s，PI_SECRET_STORE_TIMEOUT_MS 可调，测试缩短用）——age/shred/keygen 挂起
 *  否则 tool_call 永久阻塞且存储锁被持到 stale 抢占。超时 SIGKILL 子进程并 reject（文案含工具名）。 */
const RUN_TIMEOUT_MS = 30_000;
/** r9 #5：单流收集上限（stdout/stderr 各 1MB）——超时 SIGKILL 后 data 监听器仍可能继续哺缓冲，
 *  截断后停止 push；存储密文/报错均远小于此。shortcut：合法输出超 1MB 会被截断，出现时再上调。 */
const MAX_CAPTURE_BYTES = 1 << 20;

function runCapture(bin: string, args: string[], input?: string): Promise<RunResult> {
	const timeoutMs = Number(process.env.PI_SECRET_STORE_TIMEOUT_MS) || RUN_TIMEOUT_MS;
	return new Promise((resolve, reject) => {
		const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
		const chunks: Buffer[] = [];
		let stderr = "";
		let captured = 0; // stdout 累计字节
		let capturedErr = 0; // stderr 累计字节
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill("SIGKILL");
			// r9 #5：超时路径移除 data 监听器——kill 后到 close 之间的残留输出不再累积
			child.stdout.removeAllListeners("data");
			child.stderr.removeAllListeners("data");
			reject(
				new Error(
					`secret-store: 外部工具 ${bin} 执行超时（${timeoutMs}ms），已强制终止子进程。如反复出现，请检查该工具是否挂起（如等待交互输入）；可用 PI_SECRET_STORE_TIMEOUT_MS 调整超时`,
				),
			);
		}, timeoutMs);
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			fn();
		};
		child.stdout.on("data", (d: Buffer) => {
			if (captured >= MAX_CAPTURE_BYTES) return; // r9 #5：达上限后丢弃后续块
			chunks.push(d);
			captured += d.length;
		});
		child.stderr.on("data", (d: Buffer) => {
			if (capturedErr >= MAX_CAPTURE_BYTES) return;
			stderr += d.toString("utf8");
			capturedErr += d.length;
		});
		child.on("error", (err) => finish(() => reject(err)));
		child.on("close", (code) => finish(() => resolve({ code: code ?? -1, stdout: Buffer.concat(chunks), stderr })));
		// review-high #3：子进程提前退出（错钥/坏参数快速失败、timeout SIGKILL）时 stdin 读端已关，
		// 在途写入触发 EPIPE——无监听会成未捕获异常崩掉扩展进程；吞掉，结果以 close/stderr 为准。
		child.stdin.on("error", () => {});
		child.stdin.end(input ?? "");
	});
}

/** 身份密钥首次不存在 → 零交互 age-keygen 生成（0600，tmp+rename）。空存储首用的生成无锁：
 *  竞态双生成 last-wins 无害（此阶段尚无密文可解）；迁移路径的调用在存储锁内。 */
/** r9 #3：身份密钥 0600 收紧失败不再静默吞——能读到密钥的进程即等同绕过全部加密，非 ENOENT 失败显式告警。 */
async function ensureIdentity(keyPath: string, onWarning?: (msg: string) => void): Promise<void> {
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
		await chmod(tmp, 0o600).catch((err) => {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT")
				onWarning?.(
					`secret-store: 身份密钥 ${keyPath} 收紧 0600 失败（${(err as Error).message}）：密钥可能以宽权限落盘，任何能读到该文件的进程都可解密全部存储，请手动 chmod 600 ${keyPath}`,
				);
		});
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

/** shred -u 原文件（D7=a）。r8 #2：shred 缺失/失败不再“覆写+删除”兜底——writeFile 'w' 是截断重写，
 *  日志式/CoW 文件系统上通常分配新块，旧块未覆写，实际销毁强度≈直接删除，弱于承诺；改为告警“销毁未达成”
 *  并保留原文件交手动处理（宁留明文待手动 shred，不假造销毁）。失败后目标已消失（并发删除，r6 #3）→
 *  无从保留，视为已处理；覆写兜底自身失败上抛（r4 #2）的路径随兜底删除一并移除。 */
async function shredFile(path: string, onWarning?: (msg: string) => void): Promise<void> {
	try {
		await stat(path);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
		throw err;
	}
	let shredFailure: string;
	try {
		const r = await runCapture("shred", ["-u", path]);
		if (r.code === 0) return;
		const detail = r.stderr.trim();
		shredFailure = `shred 执行失败（exit ${r.code}${detail ? `：${detail}` : ""}）`;
	} catch {
		// shred 不在 PATH（command not found）：同样不删除，走下方保留+告警
		shredFailure = "shred 不可用（未安装或不在 PATH）";
	}
	try {
		await stat(path);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			onWarning?.(`secret-store: ${shredFailure}，原文件 ${path} 已消失（并发删除），视为已处理`);
			return;
		}
		throw err;
	}
	onWarning?.(
		`secret-store: ${shredFailure}，原文件 ${path} 销毁未达成，未删除、保留交手动处理（请手动 shred -u ${path}；日志式/CoW 文件系统上直接删除或覆写重写不保证销毁旧块，确认接受较弱销毁强度后可自行删除）`,
	);
}

const ageBackend = (plainPath: string, cipherPath: string, keyPath: string): StoreBackend => {
	// r7 #6 引入、r8 #1 改造：防覆盖校验缓存 = 密文内容指纹（sha256 整文件——密文为 JSON 规模小文件）。
	// 旧 mtimeMs+size 在同精度窗口内同 size 重写会误跳重验（错钥下 ensureIdentity 仍覆盖密文），mtime 缓存删除。
	let lastVerifiedFingerprint: string | undefined;
	const cipherFingerprint = async (): Promise<string | undefined> => {
		try {
			return createHash("sha256").update(await readFile(cipherPath)).digest("hex");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw err;
		}
	};
	return {
		// r7 #1：基准 = cipherPath（withStoreLock 统一加 .lock 后缀）——旧值 ${cipherPath}.lock 会让 updateStore
		// 实际锁在 .lock.lock，与 load 侧首次使用/迁移分支的 .lock 锁互不互斥，persist 与 keygen 无法串行。
		lockPath: cipherPath,
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
				const text = await decryptStoreText(cipherPath, keyPath);
				lastVerifiedFingerprint = await cipherFingerprint();
				return parseStoreText(text, cipherPath, onWarning);
			}
			let legacyRaw: string | undefined;
			try {
				legacyRaw = await readFile(plainPath, "utf8");
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			}
			if (legacyRaw === undefined) {
				// r7 #1：首次使用同样持锁（与 migrateLegacy 一致）——锁外 keygen 的 rename 与并发 persist 的
				// ensureIdentity→encryptToFile 交错时覆盖密钥，已落盘密文永久不可解；updateStore 锁内 reload
				// 到此分支由 withStoreLock 同链重入直通，不二次取锁。
				await withStoreLock(cipherPath, () => ensureIdentity(keyPath, onWarning));
				return Object.create(null) as Store;
			}
			return migrateLegacy(legacyRaw, plainPath, cipherPath, keyPath, onWarning);
		},
		async persist(store, onWarning) {
			// 防覆盖（r4 #1）：密文已存在但解不开（身份密钥丢失/被换）→ 显式拒绝写入——否则 ensureIdentity 会
			// 生成新钥覆盖出与旧密文无关的新密文，旧凭证不可恢复丢失且无感知。报错文案与 load 恢复指引一致。
			// r8 #1：复用判定 = 密文内容指纹——无缓存或指纹不一致（含同精度窗口同 size 重写）→ 重跑 age -d
			// 验证后更新缓存；一致 → 跳过（锁内刚 load/刚 persist 过，省一次 spawn）。无密文 → 无需防覆盖。
			const currentFingerprint = await cipherFingerprint();
			if (currentFingerprint !== undefined && currentFingerprint !== lastVerifiedFingerprint) {
				await decryptStoreText(cipherPath, keyPath);
				lastVerifiedFingerprint = currentFingerprint;
			}
			// review-high #5：r9 #3 的 0600 收紧失败告警语义在 persist 分支不再断——首次由 persist 触发
			// keygen（密文不存在 + conf 后写场景）时 chmod 失败同样可达告警面。
			await ensureIdentity(keyPath, onWarning);
			await encryptToFile(serialize(store), cipherPath, keyPath);
			lastVerifiedFingerprint = await cipherFingerprint();
		},
	};
};

/** 遗留明文迁移（D7=a）：内存解析校验（损坏即中止，原文件不动）→ 存储锁内加密落盘 → shred 原文件。
 *  review-high #2：解析走 strict——条目级/结构级损坏抛错保原件；宽松跳过会让损坏条目被静默丢弃后 shred 销毁原明文。
 *  明文只在扩展进程内存与 age 的 stdin 管道中经过，不进上下文/日志/agent 可见面。 */
async function migrateLegacy(
	raw: string,
	plainPath: string,
	cipherPath: string,
	keyPath: string,
	onWarning?: (msg: string) => void,
): Promise<Store> {
	const store = parseStoreText(raw, plainPath, onWarning, true);
	await withStoreLock(cipherPath, async () => {
		await ensureIdentity(keyPath, onWarning);
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
	mutate: (store: Store) => Store | undefined,
	backend?: Promise<StoreBackend>, // r4 #3：调用方传入 factory 缓存的实例——缺省每次新建会重读 conf，运行期 age↔plain 翻转会让同一存储被两套正典交叉写
	onWarning?: (msg: string) => void, // review-high #5：透传 persist 分支 keygen chmod 告警
): Promise<Store> {
	await mkdir(agentDir, { recursive: true });
	const b = await (backend ?? createBackend(agentDir));
	return withStoreLock(b.lockPath, async () => {
		const store = await b.load();
		const next = mutate(store);
		if (next === undefined) return store;
		validateStore(next); // [9] 任一条目非法 → 整体拒绝，零文件落地
		// 已知缝（review-high #2 登记，本票不修）：load 时被宽松跳过的条目（parseStoreText 非严格路径的 onWarning
		// 分支）不在内存 store 中，本次 persist 的 serialize 亦不含——磁盘上的非法条目会在下次成功写回时静默
		// 消失（无 shred，但属无提示丢失）。现网宽松语义维持；收口需 load 返回被跳过清单并在 serialize 前显式裁决。
		await b.persist(next, onWarning);
		return next;
	});
}
