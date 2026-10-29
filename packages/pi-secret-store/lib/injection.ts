/**
 * 注入规划（#179 深模块抽取）：bash 命令文本的纯分析——引用集解析、展开式/单引号判定、
 * allowedPrefix 段比对、明文回填（裸 token 替换 + 数据位命中）、命令上下文位扫描。
 * 零 I/O、零 pi 依赖：planInjection 输入命令文本 + 凭证快照 + 回填索引，输出拦截文案或注入赋值序列；
 * 最终命令拼装（防重标记前缀 + export 前缀 + 原地 mutate）与存储读取归入口（index.ts 六步流水线）。
 * 本模块是命令上下文位扫描的唯一消费方——「位定义变更须同步检查」的注释契约由模块边界取代。
 */
import { MIN_REDACT_LENGTH } from "./redact.ts";
import { shellQuote, type Store } from "./store.ts";

/** 命令文本逐字符上下文位（回填数据位判定）：1 = 引号字符串内（含定界符），2 = heredoc 体，
 *  4 = 单引号字符串内（单引号不展开，$NAME 引用拦截判定用，与回填的“任意引号=数据位”区分），
 *  8 = 命令替换体内（反引号与 $()，替换结果参与内层命令展开/再求值，属数据语义）。 */
const IN_QUOTE = 1;
export const IN_HEREDOC = 2;
export const IN_SUBST = 8;
export const IN_SINGLE = 4;
/** 段切分"数据位"掩码（本模块 commandSegments 用）——引号字符串/heredoc 体/命令替换体内的
 *  |&&; 不是命令段边界。与 commandContext 同源（位语义变更须同步检查）。 */
export const DATA_MASK = IN_QUOTE | IN_HEREDOC | IN_SUBST;

/** bash 命令文本的引号/heredoc/命令替换上下文扫描：单引号无转义、双引号支持 \ 转义；
 *  `<<`/`<<-`（定界符可带引号）开启 heredoc 体至独占终止行，`<<<`（here-string）不视为 heredoc；
 *  反引号与 $() 命令替换体标记 IN_SUBST（单引号内不展开属字面量，不跟踪）。
 *  守卫级近似：够判定“明文是否处在数据位”，不追求完整 shell 解析。
 *  已知不支持/近似形态清单（行为由 injection.test.ts 锁定防漂移）：
 *  - heredoc 体与命令替换交叠（$(cat <<EOF … EOF …)）：体内容仅标 IN_HEREDOC，$() 深度不跨 heredoc 跟踪，
 *    终止行与收尾 ) 落裸位；
 *  - 替换体内 case：`case x in a)` 的 pattern ) 会提前闭合 substDepth，其后替换体落裸位；
 *    `$(echo "a)b")` 的内层引号翻转（引号单层非嵌套）后同款提前闭合——仅保住双引号仍开启位置的 )；
 *  - process substitution <( )> 不跟踪：体内 | ; 被当命令段边界（commandSegments 切分漂移）；
 *  - 算术 $(( ))：内层 ( 不加深度，收尾 )) 落裸位。
 *  漂移双向影响三个消费方（backfill 数据位判定 / singleQuotedStoredName / commandSegments 切分）：
 *  漏标会致回填改写数据语义，多标会让该拦的不拦。 */
export function commandContext(cmd: string): Uint8Array {
	const flags = new Uint8Array(cmd.length);
	let inSingle = false;
	let inDouble = false;
	let heredocDelim: string | null = null;
	let heredocTabs = false;
	let substDepth = 0; // $( 计深度
	let backtickDepth = 0; // 反引号成对开合
	let i = 0;
	while (i < cmd.length) {
		const ch = cmd[i];
		if (heredocDelim !== null) {
			const nl = cmd.indexOf("\n", i);
			const end = nl === -1 ? cmd.length : nl;
			const line = cmd.slice(i, end);
			const body = heredocTabs ? line.replace(/^\t*/, "") : line;
			if (body === heredocDelim) {
				heredocDelim = null; // 终止行不计入 body
				i = end + 1;
				continue;
			}
			flags.fill(IN_HEREDOC, i, end);
			i = end + 1;
			continue;
		}
		if (!inSingle && !inDouble && ch === "<" && cmd[i + 1] === "<") {
			if (cmd[i + 2] === "<") {
				i += 3; // <<< here-string：操作符非 heredoc
				continue;
			}
			let j = i + 2;
			if (cmd[j] === "-") {
				heredocTabs = true;
				j++;
			} else {
				heredocTabs = false;
			}
			let delim = "";
			let sq = false;
			let dq = false;
			for (; j < cmd.length; j++) {
				const c = cmd[j];
				if (!sq && !dq && /[\s|&;()<>]/.test(c)) break;
				if (!sq && c === '"') {
					dq = !dq;
					continue;
				}
				if (!dq && c === "'") {
					sq = !sq;
					continue;
				}
				delim += c;
			}
			if (delim) {
				heredocDelim = delim;
				i = j;
				continue;
			}
			i = j; // 畸形 `<<` 无定界符：当普通文本扫过
			continue;
		}
		if (!inDouble && ch === "'") {
			inSingle = !inSingle;
			flags[i] |= IN_QUOTE | IN_SINGLE;
			i++;
			continue;
		}
		if (!inSingle && ch === '"') {
			inDouble = !inDouble;
			flags[i] |= IN_QUOTE;
			i++;
			continue;
		}
		if (!inSingle && ch === "\\" && i + 1 < cmd.length) {
			// 反斜杠转义下一字符（双引号内取字面；单引号内 \ 是普通字符，由上方分支兜住）
			flags[i] |= IN_QUOTE;
			if (inDouble) flags[i + 1] |= IN_QUOTE;
			i += 2;
			continue;
		}
		if (!inSingle && ch === "$" && cmd[i + 1] === "(") substDepth++;
		// 双引号内的 ) 是字面量——递减与入栈同不看引号态会把 $(echo "a)b") 提前闭合，其后替换体漏标 IN_SUBST
		else if (!inSingle && !inDouble && ch === ")" && substDepth > 0) substDepth--;
		else if (!inSingle && ch === "`") backtickDepth = backtickDepth === 0 ? 1 : backtickDepth - 1;
		if (inSingle || inDouble) flags[i] |= inSingle ? IN_QUOTE | IN_SINGLE : IN_QUOTE;
		if (substDepth > 0 || backtickDepth > 0) flags[i] |= IN_SUBST;
		i++;
	}
	return flags;
}

/** $NAME/${NAME} 引用名正则（referencedNames 与 singleQuotedStoredName 共用，防两处漂移；
 *  两处调用方均用 matchAll（内部克隆正则迭代），共享 /g 常量无 lastIndex 污染） */
const VAR_REF_RE = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;

/** 命令文本中的 $NAME/${NAME} 引用名（仅裸名与纯 ${NAME} 花括号形态计入；${NAME:-def} 等展开式不计——
 *  命令不消费真实值时不注入真值，缩注入半径。文本级扫描：单引号内的 $NAME 同样
 *  计入——不展开，但已存名的单引号引用会被拦截（见 singleQuotedStoredName）。
 *  展开式形态由 expandedRefNames 单列——命中已存名时 block，未存名不拦。 */
const referencedNames = (cmd: string): Set<string> => {
	const names = new Set<string>();
	for (const m of cmd.matchAll(VAR_REF_RE)) names.add(m[1] ?? m[2]);
	return names;
};

/** 展开式引用名（收紧判定）：${NAME:-def}/${NAME:=d}/${NAME:+a}/${NAME:?msg}/${NAME-d}/${NAME=x}/
 *  ${NAME+a}/${NAME?m}/${NAME#pat}/${NAME%pat}/${NAME/pat/rep} 等【明确的参数展开操作符】形态——${NAME} 后
 *  紧跟 :-/:=/:+/:? 或 - = + ? # % / 之一才算。展开式形态不注入真值，但命中已存名时命令会以空值/默认值
 *  照常执行（sudo（无 -E）/env -i 等清环境内层同样取不到），与单引号引用同类缺口 → fail closed block。
 *  旧正则 [^}] 会回溯截断名字（${TOKEN} → m[1]=TOKE 命中截断前缀存名 → 纯花括号误 block；
 *  ${TOKEN}/config 等纯展开+字面后缀同样被波及）——收紧后纯 ${NAME} 花括号与字面后缀均不匹配（正常注入路径）。
 *  操作符锚定在 } 之内（[^}]*\} 收尾）——操作符后必须到达 } 才算展开式，未闭合花括号
 *  （${NAME-suffix，bash bad substitution 本不执行）不再误判展开式误 block。
 *  未存名不拦（白名单语义）。shortcut：${NAME:0:3} 子串展开（冒号后接数字）不在此列，与字面后缀同视为放行。 */
const expandedRefNames = (cmd: string): Set<string> => {
	const names = new Set<string>();
	for (const m of cmd.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?[-+=?#%/])[^}]*\}/g)) names.add(m[1]);
	return names;
};

/** 单引号内的已存名引用：与 commandContext 同源逐字符扫描（同模块；split 近似切分不可用——
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

/** 前缀比对用命令词：剥掉 sudo/env/nohup、VAR=value 赋值 token（括号已在切分正则里作废）后取第一个真命令词——
 *  `sudo nerdctl`/`env nerdctl`/`VAR=x nerdctl` 的首词不是命令本身，不剥离则限定凭证被误 block（fail closed 伤可用性）。
 *  sh/bash 族 wrapper 的 -c/-lc 载荷递归向后取词：`sh -c "nerdctl …"` 的真命令词是 nerdctl 不是 sh；
 *  无 -c 的脚本路径场景（bash deploy.sh）比对词就是 shell 名，保持既有行为。 */
const SHELL_WRAPPERS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
// wrapper 已知选项 token 不是命令词——此前 `sudo -E nerdctl` 的比对词是 "-E"，allowedPrefix 合法命令被 fail-closed 误 block。
// 选项表按 wrapper 区分（GNU/sudo 手册语义）——sudo 的 -s（shell）/ -k（invalidate ticket）无参，既非命令词也不吞参
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
	let afterTimeout = false; // 裸数字时长仅在 timeout 之后紧邻位置剥离——任意位置的纯数字 token 过宽（数字开头命令首词被误跳）
	let wrapper: string | undefined; // 最近的 wrapper（sudo/env/timeout），查各自的带参选项表
	for (let i = 0; i < toks.length; i++) {
		const tok = toks[i];
		if (!tok || tok === "nohup" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) continue;
		// 2>&1 被 |&;() 切分后的孤立纯数字残段不是命令词，不参与比对/不进报错文案；
		// 非尾位裸数字首词仍按命令词比对（`10 serve` 的命令词是 10）
		if (/^\d+$/.test(tok) && !toks.slice(i + 1).some(Boolean)) continue;
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
		if (wrapper && WRAPPER_FLAG_OPTIONS[wrapper]?.has(tok)) continue; // sudo -s/-k 无参，不吞真命令词
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

/** 按 |、||、&&、;、;; 切命令段——引号字符串/heredoc 体/命令替换内的这些字符不是段边界
 *  （commandContext DATA_MASK 同源判定）。&&/||/;; 在逐字符切分下产生空段，交由
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

/** 多行值的行级变体门槛（与脱敏器 Redactor.add 同值：短于此的行不注册）。 */
const MIN_LINE_LENGTH = 16;

/** 回填索引变体派生（#179 显式化）：与脱敏器 Redactor.add 的值注册同构（原始值 / CRLF 归一 / trim /
 *  JSON 转义变体 / 多行行级；门槛 MIN_REDACT_LENGTH 与行级 MIN_LINE_LENGTH 同值）——回填侧与脱敏侧
 *  的等价性分别由 injection.test.ts 与 redact.test.ts 行为锁定。同值多名取最长名（值唯一性由 store 保证，防御性处理）。 */
const deriveBackfillTables = (index: Record<string, string>) => {
	const values = new Set<string>();
	const names = new Map<string, string>();
	/** JSON 转义变体集：与原始值形态区分——裸位命中不回填（字面 \n 等非原值形态，替换会篡改字面数据）。 */
	const escapedVariants = new Set<string>();
	const remember = (variant: string, name: string): void => {
		const prev = names.get(variant);
		if (prev === undefined || name.length > prev.length) names.set(variant, name);
	};
	for (const [name, secret] of Object.entries(index)) {
		const normalized = secret.replace(/\r\n/g, "\n");
		// JSON 转义变体覆盖原始值/normalized/trimmed 三形态：CRLF 值的 \r\n 转义序列只在原始值形态出现（#126）
		for (const base of new Set([secret, normalized, normalized.trim()])) {
			if (base.length >= MIN_REDACT_LENGTH) {
				values.add(base);
				remember(base, name);
			}
			const jsonEscaped = JSON.stringify(base).slice(1, -1);
			if (jsonEscaped !== base && jsonEscaped.length >= MIN_REDACT_LENGTH) {
				values.add(jsonEscaped);
				remember(jsonEscaped, name);
				escapedVariants.add(jsonEscaped);
			}
		}
		if (normalized.includes("\n")) {
			for (const line of normalized.split("\n")) {
				const trimmed = line.trim();
				if (trimmed.length >= MIN_LINE_LENGTH) {
					values.add(trimmed);
					remember(trimmed, name);
				}
			}
		}
	}
	return { values, names, escapedVariants };
};

/** #172 回填判定本体（自 Redactor.backfill 迁入，#179）：回填索引已存值明文仅在其为「裸 token」
 *  （前后均为非词字符、不在引号字符串/heredoc/命令替换体等数据位）时机械替换为 `$凭证名`；数据位命中不改写，
 *  经 dataHits 交调用方 block（静默改写会篡改 JSON payload/heredoc/命令替换等数据语义）。无名值命中原样
 *  保留；JSON 转义变体命中仅数据位走阻断，裸位原样保留，且跳过时回退 lastIndex 继续扫（更短
 *  已注册值在重叠起点的命中不被吞）。 */
const backfill = (text: string, index: Record<string, string>): { text: string; dataHits: string[] } => {
	const dataHits: string[] = [];
	const { values, names, escapedVariants } = deriveBackfillTables(index);
	if (names.size === 0) return { text, dataHits };
	const ctx = commandContext(text);
	// 已注册值的单遍交替正则（长短同序：整值优先于单行，#124）；每次调用现编译（回填每命令一次，非脱敏热路径）
	const re = new RegExp(
		[...values].sort((a, b) => b.length - a.length).map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
		"g",
	);
	let out = "";
	let last = 0;
	for (let m = re.exec(text); m !== null; m = re.exec(text)) {
		const name = names.get(m[0]);
		if (name === undefined) {
			re.lastIndex = m.index + 1; // 回退一格——更短已注册值在重叠起点的命中不被 g 正则消费吞掉
			continue; // 无名值：不替换不拦截
		}
		const start = m.index;
		const end = start + m[0].length;
		const inData = (ctx[start] & (IN_QUOTE | IN_HEREDOC | IN_SUBST)) !== 0;
		const bare =
			!inData &&
			!/[A-Za-z0-9_]/.test(start > 0 ? text[start - 1] : "") &&
			!/[A-Za-z0-9_]/.test(end < text.length ? text[end] : "");
		if (!bare) {
			if (inData && !dataHits.includes(name)) dataHits.push(name);
			continue; // 非裸 token：原样保留在尾部切片
		}
		if (escapedVariants.has(m[0])) {
			re.lastIndex = m.index + 1; // 同上，重叠起点的短值命中不吞
			continue; // 转义变体裸位原样保留（字面 \n 非原值形态，回填会篡改字面数据）
		}
		out += text.slice(last, start) + `$${name}`;
		last = end;
	}
	out += text.slice(last);
	return { text: out, dataHits };
};

export type InjectionPlan = { block?: string; text?: string; assignments?: string[] };

/** 注入规划（#179 单一接口）：输入命令文本、凭证快照与回填索引（`name → value` 映射，入口从脱敏器
 *  同批累积值构造——forget 后旧值仍回填的 deliberate fail-closed 语义，数据源不变只是显式化），
 *  输出 `{ block?, text?, assignments? }`：block 为完整拦截文案；text 为回填改写后的命令文本（无改写缺省，
 *  入口据此原地 mutate——现状语义：回填改写先于三族拦截判定，block 与 text 并存时 mutate 已发生）；
 *  assignments 为逐凭证 `NAME='value'` 单引号字面量，入口拼装 `: MARKER; export …; cmd`。
 *  store 传空快照（{}）即「仅回填路径」（入口 hook 第④步用法：回填先于零 I/O 直通——回填改写可能创造引用）。 */
export const planInjection = (cmd: string, store: Store, backfillIndex: Record<string, string>): InjectionPlan => {
	const filled = backfill(cmd, backfillIndex);
	if (filled.dataHits.length > 0)
		return {
			block: `secret-store: 已存凭证明文出现在引号字符串、heredoc 或命令替换数据位置（凭证：${filled.dataHits.join("、")}）。该位置属数据语义（JSON/heredoc/命令替换等），自动回填会篡改命令数据，已拦截不改写。请改用 ${filled.dataHits.map((n) => `$${n}`).join("、")} 形式引用（bash 展开为值），或调用 secret_query 核对凭证名后调整命令结构。`,
		};
	const rewritten = filled.text !== cmd ? filled.text : undefined;
	const text = rewritten ?? cmd;
	// #170 选择性注入：先解析引用集（零 I/O 直通由入口预判谓词 hasInjectableRef 保证，与无凭证库时逐字节一致）
	const refs = referencedNames(text);
	const expanded = expandedRefNames(text);
	if (refs.size === 0 && expanded.size === 0) return rewritten !== undefined ? { text } : {};
	// 展开式引用命中已存名 → block（不注入真值，命令带空/默认值照常执行，与单引号拦截同文案族）
	const expHit = [...expanded].find((n) => Object.hasOwn(store, n));
	if (expHit)
		return {
			block: `secret-store: 凭证 ${expHit} 以 \${${expHit}...} 展开式形态（如 \${${expHit}:-def}/\${${expHit}:?msg}）出现在命令中：展开式引用不注入真实值，命令会以空值/默认值照常执行（sudo（无 -E）/env -i 等清环境内层同样取不到）。请改写为 "$${expHit}"（外层展开后传入）或直接引用 $${expHit}。`,
			...(rewritten !== undefined ? { text: rewritten } : {}),
		};
	// 注入集 = 引用 ∩ store 已存名；只缩半径不防外显（echo $NAME 照常注入）；未存名静默跳过（P1 白名单语义）
	const names = [...refs].filter((n) => Object.hasOwn(store, n));
	if (names.length === 0) return rewritten !== undefined ? { text: rewritten } : {};
	// 已注入名出现在单引号内 → 延迟展开遇清环境 wrapper（sudo 无 -E/env -i）取空值照常执行，fail closed。
	// 判定依赖本模块 commandContext 的 IN_SINGLE 位（第 3 位）逐字符扫描语义，含 '\'' 拼接近似切分
	//（奇数段切分下拼接段落在单引号内）——位定义或单引号判定变更时与 commandSegments 的 DATA_MASK 消费同检。
	const quoted = singleQuotedStoredName(text, names);
	if (quoted)
		return {
			block: `secret-store: 凭证 ${quoted} 以 $${quoted} 形式出现在命令的单引号内：单引号不展开，sudo（无 -E）/env -i 等清环境的内层 shell 会取到空值照常执行。请改写为双引号 "$${quoted}"（外层展开后传入），或调整命令结构后直接引用 $${quoted}。`,
			...(rewritten !== undefined ? { text: rewritten } : {}),
		};
	// #171 allowedPrefix（per-credential 段比对）：凭证只与其 $NAME 引用所在段的命令词比对，
	// 且每个引用段都必须命中（剥 sudo/env/赋值 token；无引用段的段不参与该凭证判定）——
	// `echo $TOKEN | nerdctl ps`、`nerdctl ps; echo $TOKEN` 形态不得借不引用凭证的命中段放行 echo 段的消费；
	// 引用段在管道后（消费段）命中仍放行。报错文案仍列全段命令词。
	const segments = commandSegments(text);
	const segWords = segments.map(commandWord).filter(Boolean);
	const mismatched = names.filter((n) => {
		const prefixes = store[n].allowedPrefix ?? [];
		if (prefixes.length === 0) return false;
		return !segments
			.filter((s) => referencedNames(s).has(n))
			.every((s) => {
				const w = commandWord(s);
				return w !== "" && prefixes.some((p) => w.startsWith(p));
			});
	});
	if (mismatched.length > 0) {
		const detail = mismatched
			.map((n) =>
				// 命令词解析不出（重定向/管道/纯赋值等形态）时 fail-closed 拦截不变，但单独文案指明
				// 是“解析不出”而非“不命中”，避免空命令词引号排障误导
				segWords.length === 0
					? `凭证 ${n} 限定仅用于命令词命中 [${(store[n].allowedPrefix ?? []).join(",")}] 的命令，但无法从命令解析命令词，为避免空变量照常执行未注入。请调整命令结构使首词明确；如需变更限定请先 /secret-store forget ${n} 删除后重新录入（需重输明文）`
					: `凭证 ${n} 限定仅用于命令词命中 [${(store[n].allowedPrefix ?? []).join(",")}] 的命令，当前命令词 "${segWords.join("、")}" 不命中，未注入。如需变更限定请先 /secret-store forget ${n} 删除后重新录入（需重输明文）`,
			)
			.join("；");
		return { block: `secret-store: ${detail}`, ...(rewritten !== undefined ? { text: rewritten } : {}) };
	}
	// 逐变量单引号字面量：值含 $/反引号/引号/换行等特殊字符时 bash 仍逐字节还原，不构成注入面
	return {
		assignments: names.map((n) => `${n}=${shellQuote(store[n].value)}`),
		...(rewritten !== undefined ? { text: rewritten } : {}),
	};
};

/** 预判谓词（#179：零 I/O 直通的公开面）：命令文本存在 $NAME/${NAME} 引用或展开式形态才需要读存储快照——
 *  false 时入口直接放行，与无凭证库时逐字节一致（agent 无感）。 */
export const hasInjectableRef = (cmd: string): boolean => referencedNames(cmd).size > 0 || expandedRefNames(cmd).size > 0;
