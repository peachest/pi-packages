/**
 * Replace known secret values anywhere in tool output or conversation messages.
 */

export const REDACTED = "[REDACTED]";
/** Shorter values would redact ordinary text. */
export const MIN_REDACT_LENGTH = 4;
/** Lines of a multi-line secret this long are redacted on their own too. */
const MIN_LINE_LENGTH = 16;

/** 命令文本逐字符上下文位（r3 #1 回填数据位判定）：1 = 引号字符串内（含定界符），2 = heredoc 体。 */
const IN_QUOTE = 1;
const IN_HEREDOC = 2;

/** bash 命令文本的引号/heredoc 上下文扫描（r3 #1）：单引号无转义、双引号支持 \ 转义；
 *  `<<`/`<<-`（定界符可带引号）开启 heredoc 体至独占终止行，`<<<`（here-string）不视为 heredoc。
 *  守卫级近似：够判定"明文是否处在数据位"，不追求完整 shell 解析。 */
function commandContext(cmd: string): Uint8Array {
	const flags = new Uint8Array(cmd.length);
	let inSingle = false;
	let inDouble = false;
	let heredocDelim: string | null = null;
	let heredocTabs = false;
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
			flags[i] |= IN_QUOTE;
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
		if (inSingle || inDouble) flags[i] |= IN_QUOTE;
		i++;
	}
	return flags;
}

export class Redactor {
	private values = new Set<string>();
	/** 值变体 → 凭证名（#172 回填反查）：与 values 同套变体注册；同值多名取最长名（值唯一性由 store 保证，防御性处理）。 */
	private names = new Map<string, string>();
	/** 已注册值的单遍交替正则缓存（r3 #4）：热路径不再逐次排序+转义+join+编译，add/clear 时脏标记失效。 */
	private alternationCache: RegExp | null = null;

	add(secret: string, name?: string): void {
		this.alternationCache = null;
		const normalized = secret.replace(/\r\n/g, "\n");
		// JSON 转义变体覆盖原始值/normalized/trimmed 三形态：CRLF 值的 \r\n 转义序列只在原始值形态出现（#126）
		for (const base of new Set([secret, normalized, normalized.trim()])) {
			if (base.length >= MIN_REDACT_LENGTH) {
				this.values.add(base);
				this.rememberName(base, name);
			}
			const jsonEscaped = JSON.stringify(base).slice(1, -1);
			if (jsonEscaped !== base && jsonEscaped.length >= MIN_REDACT_LENGTH) {
				this.values.add(jsonEscaped);
				this.rememberName(jsonEscaped, name);
			}
		}
		if (normalized.includes("\n")) {
			for (const line of normalized.split("\n")) {
				const trimmed = line.trim();
				if (trimmed.length >= MIN_LINE_LENGTH) {
					this.values.add(trimmed);
					this.rememberName(trimmed, name);
				}
			}
		}
	}

	get size(): number {
		return this.values.size;
	}

	clear(): void {
		this.values.clear();
		this.names.clear();
		this.alternationCache = null;
	}

	private rememberName(variant: string, name?: string): void {
		if (name === undefined) return;
		const prev = this.names.get(variant);
		if (prev === undefined || name.length > prev.length) this.names.set(variant, name);
	}

	/** 值→名反查（#172 回填）：单值精确命中才返回名；同一明文对应多凭证名时取最长名（防御性，store 值唯一性理论保证）。 */
	nameOf(value: string): string | undefined {
		return this.names.get(value);
	}

	/** #172 回填（r3 #1 收紧）：已注册值明文仅在其为「裸 token」（前后均为非词字符、不在引号字符串/heredoc 体等
	 *  数据位）时机械替换为 `$凭证名`；数据位命中不改写，经 dataHits 交调用方 block（静默改写会篡改 JSON
	 *  payload/heredoc 等数据语义）。无名值命中原样保留。 */
	backfill(text: string): { text: string; dataHits: string[] } {
		const dataHits: string[] = [];
		if (this.names.size === 0) return { text, dataHits };
		const ctx = commandContext(text);
		const re = this.alternation();
		let out = "";
		let last = 0;
		for (let m = re.exec(text); m !== null; m = re.exec(text)) {
			const name = this.nameOf(m[0]);
			if (name === undefined) continue; // 无名值：不替换不拦截
			const start = m.index;
			const end = start + m[0].length;
			const inData = (ctx[start] & (IN_QUOTE | IN_HEREDOC)) !== 0;
			const bare =
				!inData &&
				!/[A-Za-z0-9_]/.test(start > 0 ? text[start - 1] : "") &&
				!/[A-Za-z0-9_]/.test(end < text.length ? text[end] : "");
			if (!bare) {
				if (inData && !dataHits.includes(name)) dataHits.push(name);
				continue; // 非裸 token：原样保留在尾部切片
			}
			out += text.slice(last, start) + `$${name}`;
			last = end;
		}
		out += text.slice(last);
		return { text: out, dataHits };
	}

	/** 已注册值的单遍交替正则（长短同序：整值优先于单行，#124）；redactText 与 backfill 共用，编译缓存（r3 #4）。 */
	private alternation(): RegExp {
		if (this.alternationCache === null) {
			this.alternationCache = new RegExp(
				[...this.values]
					.sort((a, b) => b.length - a.length)
					.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
					.join("|"),
				"g",
			);
		}
		return this.alternationCache;
	}

	redactText(text: string): string {
		if (this.values.size === 0) return text;
		return text.replace(this.alternation(), REDACTED);
	}

	/** Deep-copy `input`, redacting every string. Returns the same reference when nothing changed. */
	redactDeep<T>(input: T): T {
		if (this.values.size === 0) return input;
		return this.walk(input) as T;
	}

	private walk(node: unknown): unknown {
		if (typeof node === "string") return this.redactText(node);
		if (Array.isArray(node)) {
			let changed = false;
			const next = node.map((item) => {
				const out = this.walk(item);
				if (out !== item) changed = true;
				return out;
			});
			return changed ? next : node;
		}
		if (node !== null && typeof node === "object") {
			const proto = Object.getPrototypeOf(node);
			if (proto !== Object.prototype && proto !== null) return node;
			let changed = false;
			const next: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(node)) {
				const newKey = this.redactText(key); // 键名同样脱敏；多键同命中冲突时后者覆盖（安全侧：无明文残留）
				if (newKey !== key) changed = true;
				const out = this.walk(value);
				if (out !== value) changed = true;
				next[newKey] = out;
			}
			return changed ? next : node;
		}
		return node;
	}
}
