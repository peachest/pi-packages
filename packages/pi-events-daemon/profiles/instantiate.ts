/**
 * profiles — instantiate（票 33）：Profile 定义 + 模板 + 参数 → 实体创建参数。
 *
 * 产出（链 B 复用面）：EntityRef（keyGenerator 产出，agent 不铸造不解析——ADR 0002）、
 * 代入后的 check、kernel probe spec 形 schedule。调用方持产出走 kernel.register/subscribe。
 * 实体创建调用归 kernel（out of scope，模块 spec）。
 */
import type { EntityRef } from "../kernel/index.ts";
import type { ProfileDefinition } from "./types.ts";
import { scheduleToProbeSpec, type ProbeSchedule } from "./routing.ts";

export type InstantiateResult =
  | {
      ok: true;
      entityRef: EntityRef;
      profileId: string;
      template: string;
      /** check 命令文本（模板 check 经 {param} 代入，值 shell 单引号包裹——模板作者勿把占位符写进引号串；tri-state 判定器原语）。 */
      check: string;
      /** 模板级 schedule 覆盖（缺省顶层），已换算 kernel probe spec 形。 */
      schedule: ProbeSchedule;
    }
  | { ok: false; error: "profile-not-found" | "template-not-found" | "invalid-params"; reason: string };

/** POSIX 单引号包裹（值内 ' 转义为 '\''）：代入值恒作单个 shell 词，$()/分号/空格不逃逸不裂参（ocr F1）。 */
function shellQuote(v: string): string {
  return `'${v.replaceAll("'", `'\\''`)}'`;
}

export function instantiateProfile(
  defs: readonly ProfileDefinition[],
  profileId: string,
  templateName: string,
  params: Record<string, unknown>,
): InstantiateResult {
  const def = defs.find((d) => d.id === profileId);
  if (!def) {
    return {
      ok: false,
      error: "profile-not-found",
      reason: `profile "${profileId}" 未找到 — 可用: [${defs.map((d) => d.id).sort().join(", ")}]`,
    };
  }
  const tpl = def.templates.find((t) => t.name === templateName);
  if (!tpl) {
    return {
      ok: false,
      error: "template-not-found",
      reason: `template "${templateName}" 未找到 — 可用: [${def.templates.map((t) => t.name).join(", ")}]`,
    };
  }
  // own-property 判定（kernel validate 同法）：不吃原型链；显式 undefined 仍算缺失
  const missing = Object.keys(tpl.params).filter(
    (k) => !Object.prototype.hasOwnProperty.call(params, k) || params[k] === undefined,
  );
  if (missing.length > 0) {
    return { ok: false, error: "invalid-params", reason: `缺少必填参数: ${missing.join(", ")}` };
  }
  let entityRef: EntityRef;
  try {
    entityRef = keyFromGenerator(def, tpl.entityType ?? def.entityType, params);
  } catch (err) {
    return { ok: false, error: "invalid-params", reason: err instanceof Error ? err.message : String(err) };
  }
  return {
    ok: true,
    entityRef,
    profileId: def.id,
    template: tpl.name,
    // 仅代入模板声明参数（ocr F3：caller 多余键不触碰字面花括号，awk '{print}' 安全），
    // 值经 shellQuote 保持单词边界（ocr F1：check 经 checker shell 执行，代入值不可携带 shell 语法）
    check: tpl.check.replace(/\{([A-Za-z0-9_]+)\}/g, (m, name: string) =>
      Object.prototype.hasOwnProperty.call(tpl.params, name) &&
      Object.prototype.hasOwnProperty.call(params, name) &&
      params[name] !== undefined
        ? shellQuote(String(params[name]))
        : m,
    ),
    schedule: scheduleToProbeSpec(tpl.schedule ?? def.schedule),
  };
}

/** key 生成规则（ADR 0002：key generator 归 profile 层；kind = 规则名，其余字段 = 规则参数）。 */
function keyFromGenerator(def: ProfileDefinition, entityType: string, params: Record<string, unknown>): EntityRef {
  const g = def.keyGenerator;
  switch (g.kind) {
    case "url": {
      const raw = params[(g.param as string | undefined) ?? "url"];
      if (typeof raw !== "string") throw new Error(`url keyGenerator 需要字符串参数 "${g.param ?? "url"}"`);
      const u = new URL(raw); // 非法 URL → invalid-params（不静默）
      return { type: entityType, key: `external/${u.host}${u.pathname.replace(/\/+$/, "")}` };
    }
    case "path": {
      const raw = params[(g.param as string | undefined) ?? "path"];
      if (typeof raw !== "string" || raw === "") throw new Error(`path keyGenerator 需要非空字符串参数 "${g.param ?? "path"}"`);
      return { type: entityType, key: `external/${raw}` };
    }
    case "fields": {
      const fields = (g.fields as string[] | undefined) ?? [];
      const parts = fields.map((f) => params[f]);
      if (fields.length === 0 || parts.some((p) => typeof p !== "string" || p === "")) {
        throw new Error(`fields keyGenerator 需要非空字符串参数: ${fields.join(", ")}`);
      }
      return { type: entityType, key: `external/${parts.join("/")}` };
    }
    default:
      throw new Error(`未知 keyGenerator kind "${g.kind}"（支持: url | path | fields）`);
  }
}
