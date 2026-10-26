/**
 * pi-secret-store：双层语义扩展——供给正道（secret_ensure 掩码录入 / secret_query 存在性查询 /
 * secret_env 变量名清单）+ 泄漏执法（P1 凭证检测，迁自 bash-guards.sh P1 段）。
 * 外加 bash 选择性注入（解析命令 $NAME/${NAME} 引用，只 export 被引用且已存的变量；per-凭证
 * allowedPrefix 首词限定，#171）与 tool_result/context 双层脱敏。
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
import { detectTokens, p1BlockReason } from "./lib/credentials.ts";
import { Redactor, MIN_REDACT_LENGTH } from "./lib/redact.ts";
import { dialogOptions, SecretInput, type DialogResult } from "./lib/secret-input.ts";
import { loadStore, nameProblem, shellQuote, storePaths, updateStore, type Store } from "./lib/store.ts";
// 测试走入口边界（packages/README.md 四规则）：re-export lib/store 的被测符号
export { loadStore, storePaths, updateStore };

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

/** 命令文本中的 $NAME/${NAME} 引用名（仅裸名与纯 ${NAME} 花括号形态计入；${NAME:-def} 等展开式不计——
 *  命令不消费真实值时不注入真值，缩注入半径，rolling-review-r1 #1。文本级扫描：单引号内的 $NAME 同样
 *  计入——单引号不展开，多注入只是环境多一个未用变量，无行为影响）。 */
const referencedNames = (cmd: string): Set<string> => {
	const names = new Set<string>();
	for (const m of cmd.matchAll(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g)) names.add(m[1] ?? m[2]);
	return names;
};

const fingerprintOf = (v: string) => createHash("sha256").update(v).digest("hex").slice(0, 10);

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
	const { storePath, legacyEnvFile } = storePaths(getAgentDir());
	const redactor = new Redactor();

	async function reload(onWarning?: (msg: string) => void): Promise<Store> {
		const store = await loadStore(storePath, onWarning);
		// [4] 累积不 clear：forget/他 session 轮换后，旧值仍躺在磁盘文件与旧输出里，本 session 生存期内持续脱敏
		for (const e of Object.values(store)) redactor.add(e.value);
		return store;
	}

	// [7] 解析比对：~ 展开 + cwd 归一，~/..、./、引号包裹、--opt=path 等拼写不再绕过字面子串判断
	const isProtectedPath = (cwd: string, raw: string): boolean => {
		const expanded = raw.startsWith("~") ? join(homedir(), raw.slice(1)) : raw;
		return resolve(cwd, expanded) === storePath; // #170：guard 只保护 store json（env 文件已退役）
	};

	/** 命令串 → 路径 token（空白/引号/shell 结构符切分，--opt= 前缀剥离）逐个解析比对；含空格路径的规范拼写字面命中兜底。 */
	const touchesStore = (s: string, cwd: string): boolean => {
		if (s.includes(storePath)) return true;
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
		// 注入与 source 的非同一事务竞态（原已知边界 #1）整类消失，store guard 只剩保护 json 本身。
		// 非 ENOENT 失败（EACCES/EPERM）不静默：明文副本滞留须提示（rolling-review-r1 #2）。
		try {
			await unlink(legacyEnvFile);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT")
				warn(`secret-store: 遗留 env 文件 ${legacyEnvFile} 删除失败（${(err as Error).message}），明文副本滞留，请手动删除`);
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

	// bash 命令：①P1 检测（先，见原始命令）②存储 guard（[7] resolved 比对）③选择性注入（后，#170）。
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
		const cmd = String(input.command ?? "");
		const finding = detectTokens(cmd);
		if (finding) return { block: true, reason: p1BlockReason(finding) };
		if (touchesStore(cmd, cwd)) return { block: true, reason: GUARD_REASON };
		if (cmd.includes(MARKER)) return undefined; // 已带前缀（嵌套/重放），不重复注入
		// #170 选择性注入：先解析引用集，为空则零 I/O 直通（命令与无凭证库时逐字节一致，agent 无感）
		const refs = referencedNames(cmd);
		if (refs.size === 0) return undefined;
		// [8] 跨 session 一致：注入前重读 store，把即将注入的值同步注册进 redactor（累积不 clear）
		let store: Store;
		try {
			store = await reload();
		} catch {
			// [6] fail closed：存储不可读时引用的变量值未知（redactor 无法覆盖），跳过注入并拦截
			return { block: true, reason: `secret-store: 存储不可读，凭证注入已停用，修复 ${storePath} 后重试` };
		}
		// 注入集 = 引用 ∩ store 已存名；只缩半径不防外显（echo $NAME 照常注入）；未存名静默跳过（P1 白名单语义）
		const names = [...refs].filter((n) => Object.hasOwn(store, n));
		if (names.length === 0) return undefined;
		// #171 allowedPrefix：命令首词命中任一前缀才注入该凭证；不命中 → 不注入并 block 报错（fail closed：
		// 否则命令带着空变量照常执行）。三要素：凭证名/限定前缀/secret_ensure 重设指引。无限定的凭证不受影响。
		const firstWord = cmd.split(/[\s'"|&;()]+/).filter(Boolean)[0] ?? "";
		const mismatched = names.filter((n) => {
			const prefixes = store[n].allowedPrefix ?? [];
			return prefixes.length > 0 && !prefixes.some((p) => firstWord.startsWith(p));
		});
		if (mismatched.length > 0) {
			const detail = mismatched
				.map(
					(n) =>
						`凭证 ${n} 限定仅用于首词命中 [${(store[n].allowedPrefix ?? []).join(",")}] 的命令，当前命令首词 "${firstWord}" 不命中，未注入（如需变更限定请调用 secret_ensure 重设该凭证）`,
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
			const store = await loadStore(storePath);
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
			const store = await loadStore(storePath);
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
			const store = await loadStore(storePath);
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
								["保存到", "~/.pi/agent/secret-store.json（0600），bash 中可用 $NAME"],
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
			// 锁内 reload → 只 merge 本条 → 原子写回 json，避免旧快照整体覆盖。
			await updateStore(getAgentDir(), storePath, (current) => {
				current[params.name] = { value, updatedAt: new Date().toISOString(), fingerprint: fingerprintOf(value) };
				return current;
			});
			redactor.add(value);
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
					// [12] forget 同 ensure 协议：锁内 reload → 删单条 → 原子写回（不复活他 session 变更）
					let deleted = false;
					await updateStore(getAgentDir(), storePath, (store) => {
						if (!Object.hasOwn(store, name)) return undefined;
						deleted = true;
						const next = { ...store };
						delete next[name];
						return next;
					});
					ctx.ui.notify(deleted ? `已删除 ${name}` : `凭证 ${name} 不存在`, deleted ? "info" : "warning");
					return;
				}
				const store = await loadStore(storePath);
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
