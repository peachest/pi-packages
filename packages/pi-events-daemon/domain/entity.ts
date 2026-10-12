/**
 * domain/entity — Entity 富聚合的身份与转换决策（票 06；零 IO 纯函数，测试零 fake）。
 *
 * 共享类型归属（domain 三票协调约定）：EntityRef / Entity / Transitioned / TransitionIntent
 * 定义在 entity.ts 的先到者拥有（本票），票 07/08 import 本文件；
 * domain/index.ts 的 re-export 由 merger 统一处理（本票不改 index.ts）。
 */

// --- EntityRef：源系统原生标识 + 封闭前缀集（ADR 0002：agent 不铸造不解析，key generator 归 profile 层）---
export const ENTITY_REF_PREFIXES = ["external", "project", "user"] as const;
export type EntityRef = `${(typeof ENTITY_REF_PREFIXES)[number]}/${string}`;

/**
 * 边界校验：只认 `<prefix>/<native-key>` 形状，key 内容原样通过——
 * URL/路径的理解与规范化归 profile key generator，daemon 侧零身份铸造（ADR 0002）。
 */
export function parseEntityRef(raw: string): EntityRef {
	const slash = raw.indexOf("/");
	const prefix = slash === -1 ? "" : raw.slice(0, slash);
	const key = slash === -1 ? "" : raw.slice(slash + 1);
	if (!(ENTITY_REF_PREFIXES as readonly string[]).includes(prefix) || key === "") {
		throw new Error(
			`invalid EntityRef "${raw}": expected external/<native-key> | project/<native-key> | user/<native-key> — agents never mint or parse keys (ADR 0002)`,
		);
	}
	return raw as EntityRef;
}
