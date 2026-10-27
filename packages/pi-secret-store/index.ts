/**
 * pi-secret-store：双层语义扩展——供给正道（secret_ensure 掩码录入 / secret_query 存在性查询 /
 * secret_env 变量名清单）+ 泄漏执法（P1 凭证检测，迁自 bash-guards.sh P1 段）。
 * 外加 bash 选择性注入（解析命令 $NAME/${NAME} 引用，只 export 被引用且已存的变量；per-凭证
 * allowedPrefix 首词限定，#171）与 tool_result/context 双层脱敏。
 * 注入规划为深模块（#179）：命令文本分析（引用集/展开式/单引号/wrapper 词法/回填/上下文位）收在
 * lib/injection.ts（纯文本分析，零 I/O 零 pi 依赖），本入口只剩 hook 六步流水线薄 adapter 与 I/O 面文案。
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
import { hasInjectableRef, planInjection } from "./lib/injection.ts";
import { Redactor, MIN_REDACT_LENGTH } from "./lib/redact.ts";
import { dialogOptions, SecretInput, type DialogResult } from "./lib/secret-input.ts";
import { nameProblem, storePaths, type Store } from "./lib/store.ts";
// 测试走入口边界（packages/README.md 四规则）：re-export lib 的被测符号
export { loadStore, storePaths, type Store } from "./lib/store.ts";
export { updateStore } from "./lib/backend.ts";
// 注入规划模块公共面（#179）：规则测试直调走入口
export { planInjection, hasInjectableRef, commandContext, IN_SINGLE, IN_HEREDOC, IN_SUBST, DATA_MASK } from "./lib/injection.ts";

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

const fingerprintOf = (v: string) => createHash("sha256").update(v).digest("hex").slice(0, 10);

/** 遗留 env 删除失败状态（r3 #2 引入，r4 #6 提升到模块级）：同进程多 extension 实例共享——
 *  实例 B 须感知实例 A 的删除失败（fail closed 不因实例切换漏拦），持续到任一实例下次删除成功。 */
let legacyEnvStale = false;

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
	// 回填索引（#172/#179 显式化）：name → value，与 redactor.add 同批同源累积（[4] 累积不 clear：
	// forget 后旧值仍回填是 deliberate fail-closed，数据源不变）；planInjection 从它派生回填变体表
	const backfillIndex: Record<string, string> = {};
	// 后端选择（#173）：conf 文件读一次缓存（每 factory 实例一份，测试沙箱隔离）；首次使用惰性创建
	let backendPromise: Promise<StoreBackend> | undefined;
	const getBackend = () => (backendPromise ??= createBackend(agentDir));

	async function reload(onWarning?: (msg: string) => void): Promise<Store> {
		const store = await (await getBackend()).load(onWarning);
		// [4] 累积不 clear：forget/他 session 轮换后，旧值仍躺在磁盘文件与旧输出里，本 session 生存期内持续脱敏；
		// 名随值注册（#172 回填反查），回填索引同步累积（#179：planInjection 的显式回填数据源）
		for (const [n, e] of Object.entries(store)) {
			redactor.add(e.value, n);
			backfillIndex[n] = e.value;
		}
		return store;
	}

	// [7] 解析比对：~ 展开 + cwd 归一，~/..、./、引号包裹、--opt=path 等拼写不再绕过字面子串判断。
	// #173 后保护面 = plain 正典 json + age 密文 + 身份密钥（读密钥 = 绕过全部加密）+ conf（r6 #1：改写 conf
	// 可把后端切到 plain 写回明文正典，绕过“缺省不落明文”边界）；
	// r3 #2：遗留 env 删除失败期间 fail-closed 纳入保护（滞留明文副本），成功删除即解除（状态模块级共享，r4 #6）。
	// 受保护清单单一来源（#179 B 节）：新增保护面在此加一行，下方两个比对面（路径解析面 / 子串兜底面）自动同时覆盖；
	// 条件项「遗留 env」以谓词形态内聚——仅 legacyEnvStale（session_start 维护）期间在列。
	const protectedPaths = (): readonly string[] => [
		storePath,
		storePathAge, // r7 #4：显式单列，不依赖 storePathAge 恒含 storePath 子串的隐式包含
		keyPath,
		confPath, // r6 #1：conf 改写可切回 plain 后端
		...(legacyEnvStale ? [legacyEnvFile] : []),
	];

	const isProtectedPath = (cwd: string, raw: string): boolean => {
		const expanded = raw.startsWith("~") ? join(homedir(), raw.slice(1)) : raw;
		const resolved = resolve(cwd, expanded);
		return protectedPaths().includes(resolved);
	};

	/** 命令串 → 路径 token（空白/引号/shell 结构符切分，--opt= 前缀剥离）逐个解析比对；含空格/引号/$变量拼写的路径
	 *  token 化会切碎、逐 token resolve 不中——受保护路径全量字面子串兜底（r5 #1），子串面遍历同一清单。 */
	const touchesStore = (s: string, cwd: string): boolean => {
		if (protectedPaths().some((p) => s.includes(p))) return true;
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
				ctx.ui.notify(`secret-store: ${Object.keys(store).length} 个凭证已就绪（bash 内直接引用 $NAME；脚本内部读环境变量时显式传递：NAME=$NAME python3 x.py）`, "info");
		} catch (err) {
			// [13] 仅 ENOENT 视为空存储；损坏/权限不重写任何文件，通知后跳过
			warn(`secret-store 存储不可读：${(err as Error).message}`);
		}
	});

	// bash 命令六步流水线（#179 薄 adapter）：①P1 检测（先，见原始命令）②存储 guard（[7]，清单单一来源）
	// ③防重标记 ④回填与数据位拦截（planInjection 回填路径）⑤预判谓词直通（零 I/O）⑥有引用 reload → planInjection → 拼装。
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
		// 六步流水线（#179 薄 adapter，顺序与语义零变化）：判定本体在 lib/injection.ts，文案除 I/O 面外随模块。
		// ① P1 凭证检测（先于一切，见原始命令——已知格式 token 不因回填放行）
		const finding = detectTokens(cmd);
		if (finding) return { block: true, reason: p1BlockReason(finding) };
		// ② 存储文件 guard（工具路径面）
		if (touchesStore(cmd, cwd)) return { block: true, reason: GUARD_REASON };
		// ③ 防重标记检查（嵌套/重放不重复注入）
		if (cmd.includes(MARKER)) return undefined;
		// ④ 回填与数据位拦截（#172：planInjection 回填路径，store 空快照 = 未读存储；dataHits → block 文案随模块；
		// backfill 改写可能创造引用，先于直通——D6）。
		const pre = planInjection(cmd, {}, backfillIndex);
		if (pre.text !== undefined) event.input.command = cmd = pre.text;
		if (pre.block) return { block: true, reason: pre.block };
		// ⑤ 预判谓词直通（零 I/O）：无引用命令与无凭证库时逐字节一致，agent 无感（#170）
		if (!hasInjectableRef(cmd)) return undefined;
		// ⑥ 有引用：reload 快照 → planInjection → 入口拼装前缀
		// [8] 跨 session 一致：注入前重读 store，把即将注入的值同步注册进 redactor（累积不 clear）
		let store: Store;
		try {
			store = await reload();
		} catch {
			// [6] fail closed：存储不可读时引用的变量值未知（redactor 无法覆盖），跳过注入并拦截（I/O 层文案留入口）
			return { block: true, reason: `secret-store: 存储不可读，凭证注入已停用（检查 ${agentDir} 下的存储/密钥/age 安装后重试）` };
		}
		const plan = planInjection(cmd, store, backfillIndex);
		if (plan.text !== undefined) event.input.command = cmd = plan.text;
		if (plan.block) return { block: true, reason: plan.block };
		if (plan.assignments?.length) event.input.command = `: ${MARKER}; export ${plan.assignments.join(" ")}; ${cmd}`;
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
			"查询持久化凭证：给 name 精确命中返回存在性详情（指纹+更新时间，永不含明文）；未命中则按子序列模糊匹配返回候选名单；name 留空返回全部清单。如需在 bash 中使用已存在的凭证，直接引用 $变量名（与凭证名一致），无需本工具返回值；脚本内部读环境变量时显式传递：NAME=$NAME python3 x.py。",
		promptSnippet: "需要密码/API key/登录凭证/token 时先查这里再考虑问用户（existence only, never the value）；bash 用法：命令文本含 $NAME 字面量即自动注入，脚本消费时显式传参 NAME=$NAME python3 x.py",
		parameters: Type.Object({
			name: Type.String({ description: "凭证名/环境变量名，如 HARBOR_PASSWORD、GITBLUE_TOKEN；留空列出全部" }),
		}),
		async execute(_id, params) {
			const store = await (await getBackend()).load();
			const query = params.name?.trim() ?? "";
			// null 原型存储 + hasOwn 判存在（#126）：继承属性（toString 等）不得误报为凭证
			const e = Object.hasOwn(store, query) ? store[query] : undefined;
			if (e) {
				return say(`凭证 ${query} 存在（指纹 ${e.fingerprint}，更新于 ${e.updatedAt}${prefixTag(e)}）。在 bash 中直接引用 $${query} 即可；脚本内部读环境变量时显式传递：${query}=$${query} python3 x.py。不要尝试读取明文。`);
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
			"列出全部已存凭证的变量名清单（名称+指纹+更新时间，不含值）。使用时在 bash 中直接引用 $NAME，勿写明文——明文写入命令会被 P1 凭证检测拦截。脚本内部读环境变量时显式传递：NAME=$NAME python3 x.py。",
		promptSnippet: "需要凭证时先列这里有哪些已存凭证再决定问用户；列出后 bash 中直接 $NAME 引用（names only, never the values），脚本消费时显式传参 NAME=$NAME python3 x.py",
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
				(msg) => ctx.ui.notify(msg, "warning"), // review-high #5：persist 分支 keygen chmod 失败告警直达 UI
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
						(msg) => ctx.ui.notify(msg, "warning"), // review-high #5：persist 分支 keygen chmod 失败告警直达 UI
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
