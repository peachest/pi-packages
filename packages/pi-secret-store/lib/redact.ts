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

	add(secret: string): void {
		const normalized = secret.replace(/\r\n/g, "\n");
		// JSON 转义变体覆盖原始值/normalized/trimmed 三形态：CRLF 值的 \r\n 转义序列只在原始值形态出现（#126）
		for (const base of new Set([secret, normalized, normalized.trim()])) {
			if (base.length >= MIN_REDACT_LENGTH) this.values.add(base);
			const jsonEscaped = JSON.stringify(base).slice(1, -1);
			if (jsonEscaped !== base && jsonEscaped.length >= MIN_REDACT_LENGTH) this.values.add(jsonEscaped);
		}
		if (normalized.includes("\n")) {
			for (const line of normalized.split("\n")) {
				const trimmed = line.trim();
				if (trimmed.length >= MIN_LINE_LENGTH) this.values.add(trimmed);
			}
		}
	}

	get size(): number {
		return this.values.size;
	}

	clear(): void {
		this.values.clear();
	}

	redactText(text: string): string {
		if (this.values.size === 0) return text;
		// 单遍交替正则（#124 实现建议）：一次扫描替代逐条 includes，长短同序保证整值优先于单行。
		const alternation = [...this.values]
			.sort((a, b) => b.length - a.length)
			.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
			.join("|");
		return text.replace(new RegExp(alternation, "g"), REDACTED);
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
