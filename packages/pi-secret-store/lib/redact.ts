/**
 * Replace known secret values anywhere in tool output or conversation messages.
 * 命令文本上下文位扫描与回填判定本体已迁至 lib/injection.ts（#179）：脱敏器不再消费命令文本上下文位。
 */

export const REDACTED = "[REDACTED]";
/** Shorter values would redact ordinary text. */
export const MIN_REDACT_LENGTH = 4;
/** Lines of a multi-line secret this long are redacted on their own too. */
const MIN_LINE_LENGTH = 16;

export class Redactor {
	private values = new Set<string>();
	/** 值变体 → 凭证名（#172 回填反查）：与 values 同套变体注册；同值多名取最长名（值唯一性由 store 保证，防御性处理）。 */
	private names = new Map<string, string>();
	/** JSON 转义变体集：与原始值形态区分——裸位命中不回填（字面 \n 等非原值形态，替换会篡改字面数据）。 */
	private escapedVariants = new Set<string>();
	/** 已注册值的单遍交替正则缓存：热路径不再逐次排序+转义+join+编译，add/clear 时脏标记失效。 */
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
				this.escapedVariants.add(jsonEscaped);
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
		this.escapedVariants.clear();
		this.alternationCache = null;
	}

	private rememberName(variant: string, name?: string): void {
		if (name === undefined) return;
		const prev = this.names.get(variant);
		if (prev === undefined || name.length > prev.length) this.names.set(variant, name);
	}

	/** 已注册值的单遍交替正则（长短同序：整值优先于单行，#124）；redactText 用，编译缓存。 */
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
