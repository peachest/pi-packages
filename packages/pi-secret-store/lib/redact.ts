/**
 * Replace known secret values anywhere in tool output or conversation messages.
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

	add(secret: string, name?: string): void {
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

	/** #172 回填：文本中已注册值明文 → `$凭证名`（无感修正非拦截）；未命中的文本原样，无名值不替换。 */
	backfill(text: string): string {
		if (this.names.size === 0) return text;
		return text.replace(this.alternation(), (m) => {
			const name = this.nameOf(m);
			return name === undefined ? m : `$${name}`;
		});
	}

	/** 已注册值的单遍交替正则（长短同序：整值优先于单行，#124）；redactText 与 backfill 共用。 */
	private alternation(): RegExp {
		return new RegExp(
			[...this.values]
				.sort((a, b) => b.length - a.length)
				.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
				.join("|"),
			"g",
		);
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
