/**
 * pi-secret-store：双层语义扩展——供给正道（secret_ensure 掩码录入 / secret_query 存在性查询 /
 * secret_env 变量名清单）+ 泄漏执法（P1 凭证检测，迁自 bash-guards.sh P1 段）。
 * 外加 bash 选择性注入（解析命令 $NAME/${NAME} 引用，只 export 被引用且已存的变量；per-凭证
 * allowedPrefix 首词限定，#171）与 tool_result/context 双层脱敏。
 * 存储后端接口化（#173）：age 密文为缺省正典（.age + 0600 身份密钥分离，遗留明文自动迁移+shred），
 * plain 显式配置兜底；读写全走内存快照，链路与 plain 时代一致。
 * 明文边界：明文不进 session log 与上下文——session log 落盘的是 mutate 前原始 command（已实跑验证），
 * mutate 后含明文的 command 文本仅存在于单次执行进程内；存储 0600、agent 只见存在性/指纹、输出经 Redactor。
 * 窄缝：bash 工具若未来在报错时回显完整命令，注入前缀可能进 tool_result（当前不回显，理论路径）。
 */
import { createHash } from "node:crypto";
import { unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import { getAgentDir, type ExtensionAPI, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { createBackend, updateStore, type StoreBackend } from "./lib/backend.ts";
import { detectTokens, p1BlockReason } from "./lib/credentials.ts";
import { Redactor, MIN_REDACT_LENGTH, commandContext, DATA_MASK, IN_SINGLE } from "./lib/redact.ts";
import { dialogOptions, SecretInput, type DialogResult } from "./lib/secret-input.ts";
import { nameProblem, shellQuote, storePaths, type Store } from "./lib/store.ts";
// 测试走入口边界（packages/README.md 四规则）：re-export lib 的被测符号
export { loadStore, storePaths, type Store } from "./lib/store.ts";
export { updateStore } from "./lib/backend.ts";

const MARKER = "__PI_SECRET_STORE__";

const GUARD_REASON = "secret-store: 禁止读取存储文件本身（内容含明文）。如需检查凭证请用 secret_query。";

/** 子序列模糊匹配（大小写不敏感由调用方预处理；零依赖，禁 fzf 子进程——#125 终稿拍板）。 */
const isSubsequence = (needle: string, haystack: string): boolean => {
	let i = 0;
	for (const ch of haystack) {
		if (ch === needle[i]) i++;
		if (i === needle.length) return true;
	}
	return i === needle.length;
};

/** $NAME/${NAME} 引用名正则（r10 #2：referencedNames 与 singleQuotedStoredName 共用——此前两处独立维护同款正则有漂移风险；
 *  两处调用方均用 matchAll（内部克隆正则迭代），共享 /g 常量无 lastIndex 污染） */
const VAR_REF_RE = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;

/** 命令文本中的 $NAME/${NAME} 引用名（仅裸名与纯 ${NAME} 花括号形态计入；${NAME:-def} 等展开式不计——
 *  命令不消费真实值时不注入真值，缩注入半径，rolling-review-r1 #1。文本级扫描：单引号内的 $NAME 同样
 *  计入——不展开，但已存名的单引号引用会被拦截（r5 #2，见 singleQuotedStoredName）。
 *  r8 #3：展开式形态由 expandedRefNames 单列——命中已存名时 block，未存名不拦。 */
const referencedNames = (cmd: string): Set<string> => {
	const names = new Set<string>();
	for (const m of cmd.matchAll(VAR_REF_RE)) names.add(m[1] ?? m[2]);
	return names;
};

/** 单引号内的已存名引用（r5 #2）：与 redact commandContext 同源逐字符扫描（r6 #5，近似 split 删除——
 *  '\'' 拼接段（5 引号 6 段）在奇数段切分下落偶数段被漏拦，双引号内撇号则被误拦）。单引号不展开，
 *  注入值只存在于 bash 工具进程环境——sudo（无 -E）/env -i 等清环境 wrapper 的内层 shell 展开时取到空值，
 *  命令带空变量照常执行。命中返回第一个名。 */
const singleQuotedStoredName = (cmd: string, stored: readonly string[]): string | undefined => {
	const ctx = commandContext(cmd);
	for (const m of cmd.matchAll(VAR_REF_RE)) {
		const n = m[1] ?? m[2];
		if (stored.includes(n) && (ctx[m.index] & IN_SINGLE) !== 0) return n;
	}
	return undefined;
};

/** 展开式引用名（r8 #3，r9 #1 收紧判定）：${NAME:-def}/${NAME:=d}/${NAME:+a}/${NAME:?msg}/${NAME-d}/${NAME=x}/
 *  ${NAME+a}/${NAME?m}/${NAME#pat}/${NAME%pat}/${NAME/pat/rep} 等【明确的参数展开操作符】形态——${NAME} 后
 *  紧跟 :-/:=/:+/:? 或 - = + ? # % / 之一才算。r1 #1 语义下不注入真值，但命中已存名时命令会以空值/默认值
 *  照常执行（sudo（无 -E）/env -i 等清环境内层同样取不到），与单引号 r5 #2 同类缺口 → fail closed block。
 *  r9 #1：旧正则 [^}] 会回溯截断名字（${TOKEN} → m[1]=TOKE 命中截断前缀存名 → 纯花括号误 block；
 *  ${TOKEN}/config 等纯展开+字面后缀同样被波及）——收紧后纯 ${NAME} 花括号与字面后缀均不匹配（正常注入路径）。
 *  r10 #1：操作符锚定在 } 之内（[^}]*\} 收尾）——操作符后必须到达 } 才算展开式，未闭合花括号
 *  （${NAME-suffix，bash bad substitution 本不执行）不再误判展开式误 block。
 *  未存名不拦（r1 #1 白名单语义）。shortcut：${NAME:0:3} 子串展开（冒号后接数字）不在此列，与字面后缀同视为放行。 */
const expandedRefNames = (cmd: string): Set<string> => {
	const names = new Set<string>();
	for (const m of cmd.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?[-+=?#%/])[^}]*\}/g)) names.add(m[1]);
	return names;
};

const fingerprintOf = (v: string) => createHash("sha256").update(v).digest("hex").slice(0, 10);

/** 遗留 env 删除失败状态（r3 #2 引入，r4 #6 提升到模块级）：同进程多 extension 实例共享——
 *  实例 B 须感知实例 A 的删除失败（fail closed 不因实例切换漏拦），持续到任一实例下次删除成功。 */
let legacyEnvStale = false;

/** 前缀比对用命令词（r2 #2 / r3 #3）：剥掉 sudo/env/nohup、VAR=value 赋值 token（括号已在切分正则里作废）后取第一个真命令词——
 *  `sudo nerdctl`/`env nerdctl`/`VAR=x nerdctl` 的首词不是命令本身，不剥离则限定凭证被误 block（fail closed 伤可用性）。
 *  sh/bash 族 wrapper 的 -c/-lc 载荷递归向后取词：`sh -c "nerdctl …"` 的真命令词是 nerdctl 不是 sh（r3 #3）；
 *  无 -c 的脚本路径场景（bash deploy.sh）比对词就是 shell 名，保持 r2 行为。 */
const SHELL_WRAPPERS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
// r4 #4：wrapper 已知选项 token 不是命令词——此前 `sudo -E nerdctl` 的比对词是 "-E"，allowedPrefix 合法命令被 fail-closed 误 block。
// r7 #3：选项表按 wrapper 区分（GNU/sudo 手册语义）——sudo 的 -s（shell）/ -k（invalidate ticket）无参，既非命令词也不吞参
// （旧全局带参表把它们当带参 i++，吞掉真命令词 sudo -s nerdctl … 命令词错位误 block）；带参者：sudo -u/-g、env -u、timeout -k/-s。
// shortcut：仅覆盖常见形态，`sudo -u1000` 等紧贴拼写仍误判，出现时再扩表。
const WRAPPER_OPTIONS = new Set(["-E", "--preserve-env", "-i", "--ignore-environment", "--preserve-status"]);
const WRAPPER_FLAG_OPTIONS: Record<string, ReadonlySet<string>> = {
	sudo: new Set(["-s", "-k"]), // 无参选项
};
const WRAPPER_OPTIONS_WITH_ARG: Record<string, ReadonlySet<string>> = {
	sudo: new Set(["-u", "-g"]),
	env: new Set(["-u"]),
	timeout: new Set(["-k", "-s"]),
};
const isWrapperDuration = (t: string): boolean => /^\d+(?:\.\d+)?[smhd]?$/.test(t); // timeout 的时长参数（10 / 10s / 1.5m）
const commandWord = (cmd: string): string => {
	const toks = cmd.split(/[\s'"|&;()]+/);
	let afterTimeout = false; // r5 #4：裸数字时长仅在 timeout 之后紧邻位置剥离——任意位置的纯数字 token 过宽（数字开头命令首词被误跳）
	let wrapper: string | undefined; // r7 #3：最近的 wrapper（sudo/env/timeout），查各自的带参选项表
	for (let i = 0; i < toks.length; i++) {
		const tok = toks[i];
		if (!tok || tok === "nohup" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) continue;
		if (tok === "sudo" || tok === "env") {
			wrapper = tok;
			continue;
		}
		if (tok === "timeout") {
			wrapper = "timeout";
			afterTimeout = true;
			continue;
		}
		if (WRAPPER_OPTIONS.has(tok) || tok.startsWith("--preserve-env=") || tok.startsWith("--kill-after=")) continue;
		if (wrapper && WRAPPER_FLAG_OPTIONS[wrapper]?.has(tok)) continue; // r7 #3：sudo -s/-k 无参，不吞真命令词
		if (afterTimeout && isWrapperDuration(tok)) {
			afterTimeout = false; // timeout 只接受一个时长参数，剥掉即复位
			continue;
		}
		if (wrapper && WRAPPER_OPTIONS_WITH_ARG[wrapper]?.has(tok)) {
			i++; // 选项的独立参数（sudo -u alice / env -u NAME / timeout -k 5）同样不是命令词
			continue;
		}
		if (SHELL_WRAPPERS.has(tok)) {
			if (/^-[A-Za-z]*c/.test(toks[i + 1] ?? "")) {
				i++; // -c/-lc 载荷：继续向后取真命令词
				continue;
			}
			return tok;
		}
		return tok;
	}
	return "";
};

/** r8 #4：按 |、||、&&、;、;; 切命令段——引号字符串/heredoc 体/命令替换内的这些字符不是段边界
 *  （commandContext DATA_MASK 同源判定，r6 #5 先例）。&&/||/;; 在逐字符切分下产生空段，交由
 *  commandWord（空串）+ 下游 filter 自然剔除。返回各段原文（交 commandWord 归一）。 */
const commandSegments = (cmd: string): string[] => {
	const ctx = commandContext(cmd);
	const segs: string[] = [];
	let start = 0;
	for (let i = 0; i < cmd.length; i++) {
		if ((ctx[i] & DATA_MASK) !== 0) continue;
		if (cmd[i] === "|" || cmd[i] === ";" || cmd[i] === "&") {
			segs.push(cmd.slice(start, i));
			start = i + 1;
		}
	}
	segs.push(cmd.slice(start));
	return segs;
};

/** 凭证限定呈现（#171，存在性层面，永不含值）：`allowedPrefix: a,b`，无限定时空串。 */
const prefixTag = (e: { allowedPrefix?: string[] }): string =>
	e.allowedPrefix?.length ? ` · allowedPrefix: ${e.allowedPrefix.join(",")}` : "";

// AgentToolResult.details 为必填（类型面）；工具返回都是纯文本，details 恒 undefined。
const say = (text: string): AgentToolResult<undefined> => ({ content: [{ type: "text", text }], details: undefined });

/** [7] secret_ensure 值校验：空值/NUL 拒绝（[9]，env 文件与 bash 变量无法承载）；短于 MIN_REDACT_LENGTH 的值 Redactor 会静默忽略（明文裸奔进会话日志），一并拒绝。 */
export const valueProblem = (v: string): string | undefined =>
	v.length === 0
		? "值不能为空"
		: v.includes("\0")
			? "值含 NUL 字符，无法保存"
			: v.length < MIN_REDACT_LENGTH
				? `值过短（少于 ${MIN_REDACT_LENGTH} 字符）：脱敏器无法遮蔽短值，明文会泄漏到会话日志；请输入完整凭证值`
				: undefined;

export default function secretStore(pi: ExtensionAPI) {
	// 工厂调用时读 env（测试沙箱靠 PI_CODING_AGENT_DIR 定向）
	const agentDir = getAgentDir();
	const { storePath, storePathAge, keyPath, confPath, legacyEnvFile } = storePaths(agentDir);
	const redactor = new Redactor();
	// 后端选择（#173）：conf 文件读一次缓存（每 factory 实例一份，测试沙箱隔离）；首次使用惰性创建
	let backendPromise: Promise<StoreBackend> | undefined;
	const getBackend = () => (backendPromise ??= createBackend(agentDir));

	async function reload(onWarning?: (msg: string) => void): Promise<Store> {
		const store = await (await getBackend()).load(onWarning);
		// [4] 累积不 clear：forget/他 session 轮换后，旧值仍躺在磁盘文件与旧输出里，本 session 生存期内持续脱敏；
		// 名随值注册（#172 回填反查 nameOf 用）
		for (const [n, e] of Object.entries(store)) redactor.add(e.value, n);
		return store;
	}

	// [7] 解析比对：~ 展开 + cwd 归一，~/..、./、引号包裹、--opt=path 等拼写不再绕过字面子串判断。
	// #173 后保护面 = plain 正典 json + age 密文 + 身份密钥（读密钥 = 绕过全部加密）+ conf（r6 #1：改写 conf
	// 可把后端切到 plain 写回明文正典，绕过“缺省不落明文”边界）；
	// r3 #2：遗留 env 删除失败期间 fail-closed 纳入保护（滞留明文副本），成功删除即解除（状态模块级共享，r4 #6）。
	const isProtectedPath = (cwd: string, raw: string): boolean => {
		const expanded = raw.startsWith("~") ? join(homedir(), raw.slice(1)) : raw;
		const resolved = resolve(cwd, expanded);
		return (
			resolved === storePath ||
			resolved === storePathAge ||
			resolved === keyPath ||
			resolved === confPath ||
			(legacyEnvStale && resolved === legacyEnvFile)
		);
	};

	/** 命令串 → 路径 token（空白/引号/shell 结构符切分，--opt= 前缀剥离）逐个解析比对；含空格/引号/$变量拼写的路径
	 *  token 化会切碎、逐 token resolve 不中——受保护路径全量字面子串兜底（r5 #1；r7 #4：storePathAge 显式单列，
	 *  不依赖恒含 storePath 子串的隐式包含；confPath 与 storePath 无包含关系，须单列——r6 #1）。 */
	const touchesStore = (s: string, cwd: string): boolean => {
		if (
			s.includes(storePath) ||
			s.includes(storePathAge) || // r7 #4：显式单列，不依赖 storePathAge 恒含 storePath 子串的隐式包含
			s.includes(keyPath) ||
			s.includes(confPath) ||
			(legacyEnvStale && s.includes(legacyEnvFile))
		)
			return true;
		return s
			.split(/[\s'"|&;()]+/)
			.map((tok) => tok.replace(/^--[A-Za-z0-9][A-Za-z0-9-]*=/, ""))
			.filter(Boolean)
			.some((tok) => isProtectedPath(cwd, tok));
	};

	pi.on("session_start", async (_event, ctx) => {
		const warn = (msg: string) => {
			if (ctx.hasUI) ctx.ui.notify(msg, "warning");
		};
		// #170 env 文件退役：v1 遗留文件删除（派生数据，可安全移除），此后不再生成——
		// 注入与 source 的非同一事务竞态（原已知边界 #1）整类消失；#173 后 guard 保护 plain json + age 密文 + 身份密钥。
		// 非 ENOENT 失败（EACCES/EPERM）不静默：明文副本滞留须提示，且 r3 #2 起临时纳入 guard 保护
		//（fail closed 直到成功删除——下个 session 重试成功后解除）。
		try {
			await unlink(legacyEnvFile);
			legacyEnvStale = false;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
				legacyEnvStale = true;
				warn(`secret-store: 遗留 env 文件 ${legacyEnvFile} 删除失败（${(err as Error).message}），明文副本滞留，已纳入读取保护，请手动删除`);
			}
		}
		try {
			const store = await reload(warn);
			if (ctx.hasUI && Object.keys(store).length > 0)
				ctx.ui.notify(`secret-store: ${Object.keys(store).length} 个凭证已就绪（bash 内直接引用 $NAME）`, "info");
		} catch (err) {
			// [13] 仅 ENOENT 视为空存储；损坏/权限不重写任何文件，通知后跳过
			warn(`secret-store 存储不可读：${(err as Error).message}`);
		}
	});

	// bash 命令：①P1 检测（先，见原始命令——已知格式 token 不因回填放行）②存储 guard（[7] resolved 比对）
	// ③明文回填（#172）④选择性注入（#170）+ allowedPrefix（#171）。
	// 非 bash 文件类工具（read/grep/ls/edit/write…）：input.path 指向存储文件同样拦截（[7]）。
	// 修改参数必须原地 mutate event.input —— 返回 { input } 无效（pi ToolCallEventResult 文档明示）。
	pi.on("tool_call", async (event, ctx) => {
		const cwd = ctx?.cwd ?? process.cwd();
		const input = event.input as { command?: unknown; path?: unknown; args?: unknown };
		if (event.toolName !== "bash") {
			// [7] read/grep/ls 类文件工具：path/args 指向存储文件 → block（文案同）
			if (typeof input.path === "string" && isProtectedPath(cwd, input.path)) return { block: true, reason: GUARD_REASON };
			if (Array.isArray(input.args) && input.args.some((a) => typeof a === "string" && touchesStore(a, cwd))) {
				return { block: true, reason: GUARD_REASON };
			}
			return undefined;
		}
		let cmd = String(input.command ?? "");
		const finding = detectTokens(cmd);
		if (finding) return { block: true, reason: p1BlockReason(finding) };
		if (touchesStore(cmd, cwd)) return { block: true, reason: GUARD_REASON };
		if (cmd.includes(MARKER)) return undefined; // 已带前缀（嵌套/重放），不重复注入
		// #172 明文回填（链路定型：P1 检测 → 回填 → prefix/注入）：已存值明文误写进命令 → 机械替换回 $NAME。
		// r3 #1：替换仅限裸 token；引号字符串/heredoc 数据位命中不改写 → block（三要素文案），防静默篡改数据语义。
		// 反查源 = redactor 累积值（[4]：forget 后旧值仍回填）；替换出的 $NAME 交由下方注入路径重新验证（未存名静默跳过）。
		const filled = redactor.backfill(cmd);
		if (filled.dataHits.length > 0)
			return {
				block: true,
				reason: `secret-store: 已存凭证明文出现在引号字符串、heredoc 或命令替换数据位置（r7 #2；凭证：${filled.dataHits.join("、")}）。该位置属数据语义（JSON/heredoc/命令替换等），自动回填会篡改命令数据，已拦截不改写。请改用 ${filled.dataHits.map((n) => `$${n}`).join("、")} 形式引用（bash 展开为值），或调用 secret_env 核对凭证名后调整命令结构。`,
			};
		if (filled.text !== cmd) event.input.command = cmd = filled.text;
		// #170 选择性注入：先解析引用集；无 $ 引用（裸/花括号/展开式皆无）才零 I/O 直通（命令与无凭证库时逐字节一致，agent 无感）
		const refs = referencedNames(cmd);
		const expanded = expandedRefNames(cmd);
		if (refs.size === 0 && expanded.size === 0) return undefined;
		// [8] 跨 session 一致：注入前重读 store，把即将注入的值同步注册进 redactor（累积不 clear）
		let store: Store;
		try {
			store = await reload();
		} catch {
			// [6] fail closed：存储不可读时引用的变量值未知（redactor 无法覆盖），跳过注入并拦截
			return { block: true, reason: `secret-store: 存储不可读，凭证注入已停用（检查 ${agentDir} 下的存储/密钥/age 安装后重试）` };
		}
		// r8 #3：展开式引用命中已存名 → block（不注入真值 r1 #1，命令带空/默认值照常执行，与 r5 #2 同文案族）
		const expHit = [...expanded].find((n) => Object.hasOwn(store, n));
		if (expHit)
			return {
				block: true,
				reason: `secret-store: 凭证 ${expHit} 以 \${${expHit}...} 展开式形态（如 \${${expHit}:-def}/\${${expHit}:?msg}）出现在命令中：展开式引用不注入真实值（rolling-review-r1 #1），命令会以空值/默认值照常执行（sudo（无 -E）/env -i 等清环境内层同样取不到）。请改写为 "$${expHit}"（外层展开后传入）或直接引用 $${expHit}。`,
			};
		// 注入集 = 引用 ∩ store 已存名；只缩半径不防外显（echo $NAME 照常注入）；未存名静默跳过（P1 白名单语义）
		const names = [...refs].filter((n) => Object.hasOwn(store, n));
		if (names.length === 0) return undefined;
		// r5 #2：已注入名出现在单引号内 → 延迟展开遇清环境 wrapper（sudo 无 -E/env -i）取空值照常执行，fail closed。
		// 契约（r8 #6）：下方判定依赖 redact.ts commandContext 的 IN_SINGLE 位（第 3 位）逐字符扫描语义，
		// 含 r6 #5 的 '\'' 拼接近似切分（奇数段切分下拼接段落在单引号内）——commandContext 位定义或
		// 单引号判定变更时，须同步检查 singleQuotedStoredName 与本调用处的拦截面是否一致。
		const quoted = singleQuotedStoredName(cmd, names);
		if (quoted)
			return {
				block: true,
				reason: `secret-store: 凭证 ${quoted} 以 $${quoted} 形式出现在命令的单引号内：单引号不展开，sudo（无 -E）/env -i 等清环境的内层 shell 会取到空值照常执行。请改写为双引号 "$${quoted}"（外层展开后传入），或调整命令结构后直接引用 $${quoted}。`,
			};
		// #171 allowedPrefix（r8 #4 改分段比对）：逐段取命令词（r2 #2 剥 sudo/env/赋值 token），任一段命中任一前缀
		// → 该凭证放行（真消费凭证的段参与比对）；被引用且已存的限定凭证在所有段均不命中 → 不注入并 block 报错
		// （fail closed：否则命令带着空变量照常执行）。三要素：凭证名/限定前缀/forget+重录指引 + 实际参与比对的命令词。
		const segWords = commandSegments(cmd).map(commandWord).filter(Boolean);
		const mismatched = names.filter((n) => {
			const prefixes = store[n].allowedPrefix ?? [];
			return prefixes.length > 0 && !segWords.some((w) => prefixes.some((p) => w.startsWith(p)));
		});
		if (mismatched.length > 0) {
			const detail = mismatched
				.map((n) =>
					// r6 #2：命令词解析不出（重定向/管道/纯赋值等形态）时 fail-closed 拦截不变，但单独文案指明
					// 是“解析不出”而非“不命中”，避免空命令词引号排障误导
					segWords.length === 0
						? `凭证 ${n} 限定仅用于命令词命中 [${(store[n].allowedPrefix ?? []).join(",")}] 的命令，但无法从命令解析命令词，为避免空变量照常执行未注入。请调整命令结构使首词明确；如需变更限定请先 /secret-store forget ${n} 删除后重新录入（需重输明文）`
						: `凭证 ${n} 限定仅用于命令词命中 [${(store[n].allowedPrefix ?? []).join(",")}] 的命令，当前命令词 "${segWords.join("、")}" 不命中，未注入。如需变更限定请先 /secret-store forget ${n} 删除后重新录入（需重输明文）`,
				)
				.join("；");
			return { block: true, reason: `secret-store: ${detail}` };
		}
		// [11] 逐变量单引号字面量：值含 $/反引号/引号/换行等特殊字符时 bash 仍逐字节还原，不构成注入面
		const assignments = names.map((n) => `${n}=${shellQuote(store[n].value)}`).join(" ");
		event.input.command = `: ${MARKER}; export ${assignments}; ${cmd}`;
		return undefined;
	});

	// 工具输出与上下文消息全链路脱敏（details 与 content 同源持久化到 session，一并脱敏）
	pi.on("tool_result", async (event) => {
		const content = redactor.redactDeep(event.content);
		const details = redactor.redactDeep(event.details);
		return content === event.content && details === event.details ? undefined : { content, details };
	});
	pi.on("context", async (event) => {
		const messages = redactor.redactDeep(event.messages);
		return messages === event.messages ? undefined : { messages };
	});

	pi.registerTool({
		name: "secret_query",
		label: "Secret Query",
		description:
			"查询持久化凭证：给 name 精确命中返回存在性详情（指纹+更新时间，永不含明文）；未命中则按子序列模糊匹配返回候选名单；name 留空返回全部清单。如需在 bash 中使用已存在的凭证，直接引用 $变量名（与凭证名一致），无需本工具返回值。",
		promptSnippet: "需要密码/API key/登录凭证/token 时先查这里再考虑问用户（existence only, never the value）",
		parameters: Type.Object({
			name: Type.String({ description: "凭证名/环境变量名，如 HARBOR_PASSWORD、GITBLUE_TOKEN；留空列出全部" }),
		}),
		async execute(_id, params) {
			const store = await (await getBackend()).load();
			const query = params.name?.trim() ?? "";
			// null 原型存储 + hasOwn 判存在（#126）：继承属性（toString 等）不得误报为凭证
			const e = Object.hasOwn(store, query) ? store[query] : undefined;
			if (e) {
				return say(`凭证 ${query} 存在（指纹 ${e.fingerprint}，更新于 ${e.updatedAt}${prefixTag(e)}）。在 bash 中直接引用 $${query} 即可，不要尝试读取明文。`);
			}
			// 模糊匹配：查询串为名字的子序列（大小写不敏感）；空查询 = 全量清单
			const q = query.toLowerCase();
			const hits = query === "" ? Object.keys(store) : Object.keys(store).filter((n) => isSubsequence(q, n.toLowerCase()));
			if (hits.length === 0) {
				const known = Object.keys(store).join(", ") || "（空）";
				return say(`凭证 ${query || "（未指定）"} 不存在（含模糊匹配）。已存储的凭证名：${known}。缺失时可调用 secret_ensure 请用户录入。`);
			}
			const list = hits.map((n) => `${n} — ${store[n].fingerprint} (${store[n].updatedAt})${prefixTag(store[n])}`).join("\n");
			return say(`匹配到 ${hits.length} 个凭证（仅名称+指纹+更新时间，不含值；bash 中引用 $NAME 勿写明文）：\n${list}`);
		},
	});

	pi.registerTool({
		name: "secret_env",
		label: "Secret Env",
		description:
			"列出全部已存凭证的变量名清单（名称+指纹+更新时间，不含值）。使用时在 bash 中直接引用 $NAME，勿写明文——明文写入命令会被 P1 凭证检测拦截。",
		promptSnippet: "需要凭证时先列这里有哪些已存凭证再决定问用户；列出后 bash 中直接 $NAME 引用（names only, never the values）",
		parameters: Type.Object({}),
		async execute() {
			const store = await (await getBackend()).load();
			const entries = Object.entries(store);
			if (entries.length === 0) {
				return say("存储为空。缺失的凭证可调用 secret_ensure 请用户录入。");
			}
			const list = entries.map(([n, e]) => `${n} — ${e.fingerprint} (${e.updatedAt})`).join("\n");
			return say(`已存 ${entries.length} 个凭证（变量名清单，不含值；bash 中引用 $NAME 勿写明文）：\n${list}`);
		},
	});

	pi.registerTool({
		name: "secret_ensure",
		label: "Secret Ensure",
		description:
			"确保某凭证已持久化：已存在则直接返回存在性；缺失则弹出掩码对话框让用户输入（agent 提供 label 与获取步骤指引），输入后持久化并可在 bash 中以 $NAME 引用。用户按 Tab 可反问 agent。全程 agent 与 session log 均无明文。",
		promptSnippet: "缺凭证时先 ensure 录入再继续任务，不要明文问用户要密码（masked dialog，session log 无明文）",
		promptGuidelines: [
			"用户语言写 label 与 instructions：精确到页面/菜单/字段，让用户无需追问即可输入。",
			"工具返回 question 时先回答用户的问题，再重新调用。",
		],
		parameters: Type.Object({
			name: Type.String({ description: "凭证名/环境变量名，如 HARBOR_PASSWORD" }),
			label: Type.String({ description: "给用户看的录入项说明，用户语言" }),
			instructions: Type.Array(Type.String(), { description: "获取该凭证的步骤（去哪、点什么、复制什么），用户语言" }),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			// [5] prompt 前校验名：名会原样进入 source 的 shell 赋值与 UI 文案，放宽即命令注入；保留名可劫持 shell 行为（#126）
			const nameErr = nameProblem(params.name);
			if (nameErr) return say(`非法凭证名 "${params.name}"：${nameErr}，未保存。`);
			const store = await (await getBackend()).load();
			const e = Object.hasOwn(store, params.name) ? store[params.name] : undefined;
			if (e) return say(`凭证 ${params.name} 已存在（指纹 ${e.fingerprint}，更新于 ${e.updatedAt}），未重复录入。bash 中引用 $${params.name}。`);
			if (ctx.mode !== "tui") throw new Error("secret_ensure 需要交互式 TUI 弹窗录入；非交互环境下请用户手动写入或改在 TUI 中运行。");

			onUpdate?.(say("等待用户在掩码对话框中输入凭证..."));
			const choice = await ctx.ui.custom<DialogResult | null>(
				(tui, theme, _kb, done) => {
					const input = new SecretInput(
						{
							title: "Secret Store",
							label: `${params.label}（将保存为 ${params.name}）`,
							steps: params.instructions,
							rows: [
								["保存到", "pi 凭证存储（0600，缺省 age 密文+独立身份密钥），bash 中可用 $NAME"],
								["明文边界", "agent 与 session log 不会出现明文"],
							],
							footer: "Enter 确认保存 · Tab 反问 agent · Esc 取消",
							check: valueProblem,
						},
						theme,
						() => tui.requestRender(),
						done,
					);
					if (signal?.aborted) input.cancel();
					else signal?.addEventListener("abort", () => input.cancel(), { once: true });
					return input;
				},
				dialogOptions(),
			);
			if (choice === null || choice === undefined)
				return say("用户取消了录入，凭证未保存。");
			if (choice.kind === "question")
				return say(`用户没有输入凭证，而是提问：\"${choice.text}\"。请先回答，然后再次调用 secret_ensure。`);

			const value = choice.value;
			// [12] 开始时加载的快照可能已过期（对话框打开期间他 session 增删过凭证）：
			// 锁内 reload → 只 merge 本条 → 后端原子写回，避免旧快照整体覆盖。
			await updateStore(
				agentDir,
				(current) => {
					current[params.name] = { value, updatedAt: new Date().toISOString(), fingerprint: fingerprintOf(value) };
					return current;
				},
				getBackend(), // r4 #3：与读路径同源缓存，conf 运行期翻转不产生双正典交叉写
			);
			redactor.add(value, params.name);
			return say(`凭证 ${params.name} 已保存（指纹 ${fingerprintOf(value)}）。此后 bash 中直接引用 $${params.name}；明文不可见、不可读。`);
		},
	});

	pi.registerCommand("secret-store", {
		description: "列出已存凭证（仅名称+指纹）；`forget <name>` 删除",
		handler: async (args, ctx) => {
			const [action, name] = args.trim().split(/\s+/).filter(Boolean);
			try {
				if (action === "forget") {
					if (!name) {
						ctx.ui.notify("凭证 (未指定) 不存在", "warning");
						return;
					}
					// [12] forget 同 ensure 协议：锁内 reload → 删单条 → 后端原子写回（不复活他 session 变更）
					let deleted = false;
					await updateStore(
						agentDir,
						(store) => {
							if (!Object.hasOwn(store, name)) return undefined;
							deleted = true;
							const next = { ...store };
							delete next[name];
							return next;
						},
						getBackend(), // r4 #3：与读路径同源缓存，conf 运行期翻转不产生双正典交叉写
					);
					ctx.ui.notify(deleted ? `已删除 ${name}` : `凭证 ${name} 不存在`, deleted ? "info" : "warning");
					return;
				}
				const store = await (await getBackend()).load();
				const entries = Object.entries(store);
				ctx.ui.notify(
					entries.length === 0
						? "存储为空"
						: entries.map(([n, e]) => `${n} — ${e.fingerprint} (${e.updatedAt})${prefixTag(e)}`).join("\n"),
					"info",
				);
			} catch (err) {
				// [13] 读失败（损坏/权限）：文件一律不动，命令面呈现
				ctx.ui.notify(`secret-store 存储不可读，未做任何修改：${(err as Error).message}`, "warning");
			}
		},
	});
}
