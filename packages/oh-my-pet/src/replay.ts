import type { BinlogEntry, AttrPolicies } from "./types";

export function replay(
  entries: BinlogEntry[],
  policies: AttrPolicies
): Record<string, number> {
  const attrs: Record<string, number> = {};

  // 初始化所有已注册属性为零
  for (const name of Object.keys(policies)) {
    attrs[name] = 0;
  }

  for (const entry of entries) {
    for (const [name, delta] of Object.entries(entry.attributes)) {
      attrs[name] = (attrs[name] ?? 0) + delta;

      // 钳制到策略边界
      const policy = policies[name];
      if (policy) {
        if (attrs[name] < policy.min) attrs[name] = policy.min;
        if (attrs[name] > policy.max) attrs[name] = policy.max;
      }
    }
  }

  return attrs;
}
