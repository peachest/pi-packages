/**
 * profiles — ProfileRegistry（票 31：load 资产→Profile 定义 + 冲突拒绝 + B7 迁移声明数据面）。
 *
 * I-01 / ADR 0005：profile 加载时把状态机定义作为数据注入 kernel 注册表——本模块生产数据，
 * kernel 消费（校验 transition(to) 查注册表值传递，无代码 import）。依赖方向 profiles → kernel
 * 仅类型（eda-profiles-deps）；schema 校验器与 Profile Schema 文档均构造注入（禁 import protocol）。
 *
 * 冲突拒绝（ddd-discover 裁定）：同 EntityRef 域（entityType）被冲突 profile 定义携带 → 注册拒绝，
 * 不静默覆盖；kernel 侧实体级对应物 = US-32（一实体不跨两 profile）。
 *
 * B7 状态改名迁移数据面：load 产出迁移声明（migrations()）；执行归 kernel.migrateState/loops
 * 唯一写路径（禁原地改名）；版本升级删除状态而无映射 → 拒加载（无映射遇旧状态）。
 */
import type { ValidateRequest, ValidateResult } from "../kernel/index.ts";
import type { MigrationDeclaration, ProfileDefinition, ProfileValidator } from "./types.ts";
import { everyToMs, resolveUrl } from "./routing.ts";
import { instantiateProfile } from "./instantiate.ts";

export type { MigrationDeclaration, ProfileDefinition, ProfileTemplate, ProfileValidator, ScheduleData, SchemaIssue } from "./types.ts";

export interface ProfileRegistryOpts {
  /** D1a 子集校验器（组合根接 protocol validateValue；profiles 禁 import protocol）。 */
  validate: ProfileValidator;
  /** Profile JSON Schema 文档（schemas/profile.schema.json 解析产物，构造注入同上）。 */
  schema: object;
  /** cron 语义校验（组合根接 domain cronNextMs 同形；缺省跳过——kernel subscribe 入口 D11 兜底）。 */
  validateCron?: (expr: string, fromMs: number) => number | null;
}

/** profile 声明的 EntityRef 域 = 顶层 entityType ∪ 模板覆盖（票 33 三域；冲突拒绝的比对域）。 */
function claimedTypes(def: ProfileDefinition): string[] {
  return [def.entityType, ...def.templates.map((t) => t.entityType).filter((t): t is string => t !== undefined)];
}

/**
 * profile 注册表条目（I-01：profile 静态面作为数据声明注入）。票 42 owner 归位：原
 * kernel/index.ts 定义迁此，profiles→kernel 反向形状依赖消除；onTransition 编排数据消费归
 * loops（结构子集注入），状态集仍走构造注入 states。消费面：templates 清单 / validate
 * 三类错误 + ADR 0004 副作用 pattern。
 */
export interface ProfileRegistryEntry {
  profileId: string;
  templates: ReadonlyArray<{
    name: string;
    entityType: string;
    states: readonly string[];
    params?: readonly string[];
    schedule?: unknown;
    usage?: string;
  }>;
  /** 已知副作用 pattern（子串匹配）：validate 命中出 warning 不阻断（ADR 0004 checks-are-probes）。 */
  sideEffectPatterns?: readonly string[];
  /** C2 on-transition 编排规则（数据声明；schema profile.onTransition 投影）：消费归 loops L0——
   *  transition 消费成功后匹配 from/to，编排动作（subscribe/close）经 L0 队列执行。 */
  onTransition?: ReadonlyArray<{ on: string | string[]; action: string; params?: Record<string, unknown> }>;
}

/** 模板元数据清单条目（templates 渐进式披露面；票 42 自 kernel 迁入）。 */
export type TemplateMeta = {
  profileId: string;
  name: string;
  entityType: string;
  states: readonly string[];
  params?: readonly string[];
  schedule?: unknown;
  usage?: string;
};

/** cron every 之外的时长字面量校验在 checkSchedule 内联（schema oneOf D1a 表达不了）。 */
export class ProfileRegistry {
  private readonly defs = new Map<string, ProfileDefinition>();

  constructor(private readonly opts: ProfileRegistryOpts) {}

  /**
   * load（templates 资产 → Profile 定义）：schema 校验（03 D1a 注入）→ 结构面（D1a 子集
   * 表达不了的 minItems/成员闭集/oneOf）→ 冲突拒绝 + B7 版本链 → 注册。拒绝一律 throw，
   * 错误信息列全部 issue（错误列可用选项惯例）。
   */
  load(asset: unknown): ProfileDefinition {
    const issues = this.opts.validate(this.opts.schema, asset);
    if (issues.length > 0) {
      throw new Error(
        `profile load rejected (schema): ${issues.map((i) => `${i.path || "<root>"}: ${i.message}`).join("; ")}`,
      );
    }
    const def = asset as ProfileDefinition;
    this.checkStructure(def);
    this.checkConflicts(def);
    this.defs.set(def.id, def);
    return def;
  }

  profiles(): readonly ProfileDefinition[] {
    return [...this.defs.values()];
  }

  /** 票 32：url → (profile, template) 路由（唯一绑定/多命中列候选/零命中列可用模板）。 */
  resolve(url: string) {
    return resolveUrl(this.profiles(), url);
  }

  /** 票 33：Profile + 模板 + 参数 → 实体创建参数（EntityRef/check/schedule，链 B 复用面）。 */
  instantiate(profileId: string, template: string, params: Record<string, unknown>) {
    return instantiateProfile(this.profiles(), profileId, template, params);
  }

  get(profileId: string): ProfileDefinition | undefined {
    return this.defs.get(profileId);
  }

  /** I-01 状态集并集（kernel 构造注入态：单一封闭集 = 全部 profile 状态的并集）。 */
  states(): ReadonlySet<string> {
    return new Set([...this.defs.values()].flatMap((d) => d.states));
  }

  /** I-01 kernel 注册表静态面（schedule 保持资产形态——op 回显同形）。 */
  entries(): ProfileRegistryEntry[] {
    return this.profiles().map((def) => ({
      profileId: def.id,
      templates: def.templates.map((t) => ({
        name: t.name,
        entityType: t.entityType ?? def.entityType,
        states: t.states ?? def.states,
        params: Object.keys(t.params),
        schedule: t.schedule ?? def.schedule,
        usage: t.usage,
      })),
      sideEffectPatterns: def.sideEffectPatterns,
      onTransition: def.onTransition,
    }));
  }

  /** 票 42：静态校验面（validateEntry 消费本注册表 entries；错误分类/ADR 0004 语义同原 kernel.validate）。 */
  validate(req: ValidateRequest): ValidateResult {
    return validateEntry(this.entries(), req);
  }

  /** 票 42：模板元数据清单（profileTemplates 消费本注册表 entries；渐进式披露面）。 */
  templates(profile?: string): { templates: readonly TemplateMeta[] } {
    return profileTemplates(this.entries(), profile);
  }

  /** B7 迁移声明清单（最新版定义的 stateMigrations 全量）。 */
  migrations(): MigrationDeclaration[] {
    return this.profiles().flatMap((def) =>
      Object.entries(def.stateMigrations).map(([from, to]) => ({
        profileId: def.id,
        version: def.version,
        from,
        to,
      })),
    );
  }

  /** 结构面校验：D1a 子集（required/type/enum/正则）表达不了的约束。 */
  private checkStructure(def: ProfileDefinition): void {
    const fail = (reason: string): never => {
      throw new Error(`profile load rejected (structure) "${def.id}": ${reason}`);
    };
    if (!Array.isArray(def.states) || def.states.length === 0 || def.states.some((s) => typeof s !== "string")) {
      fail("states 必须是非空字符串数组（闭集 minItems 1）");
    }
    for (const t of def.transitions) {
      if (!def.states.includes(t.from) || !def.states.includes(t.to)) {
        fail(`转换表引用集外状态: ${t.from}->${t.to}（states: [${def.states.join(", ")}]）`);
      }
    }
    this.checkSchedule(def.schedule, "schedule", fail);
    def.templates.forEach((t, i) => {
      // 模板 states 是闭集子集声明（ocr F7）：越集值 load 即拒——否则 entries() 宣告 kernel 会拒的状态
      if (t.states !== undefined) {
        const outside = t.states.filter((s) => !def.states.includes(s));
        if (outside.length > 0) {
          fail(`templates[${i}].states 引用集外状态 [${outside.join(", ")}]（states: [${def.states.join(", ")}]）`);
        }
      }
      if (t.schedule !== undefined) this.checkSchedule(t.schedule, `templates[${i}].schedule`, fail);
      if (t.urlPattern !== undefined) {
        let re: RegExp;
        try {
          re = new RegExp(t.urlPattern);
        } catch (err) {
          fail(`templates[${i}].urlPattern 不可编译: ${err instanceof Error ? err.message : String(err)}`);
        }
        // 票 49/#114：urlPattern 命名捕获组是 url 订阅的参数来源，必须全都在模板 params 声明——
        // 未声明的组名 = 多余参数，load 即拒（否则 instantiate 拿到模板不认识的参数字典）
        const groupNames = [...t.urlPattern.matchAll(/\(\?<([A-Za-z0-9_]+)>/g)].map((m) => m[1]!);
        const undeclared = groupNames.filter((n) => !(n in t.params));
        if (undeclared.length > 0) {
          fail(
            `templates[${i}].urlPattern 捕获组 [${undeclared.join(", ")}] 未在 params 声明（声明: [${Object.keys(t.params).join(", ")}]）`,
          );
        }
      }
    });
    for (const [from, to] of Object.entries(def.stateMigrations)) {
      if (!def.states.includes(to)) fail(`stateMigrations 目标 "${to}"（自 "${from}"）不在 states 闭集内`);
    }
  }

  /** schedule oneOf（schema#/definitions/scheduleSpec——D1a 不跟 $ref，此处机械执法）。 */
  private checkSchedule(s: unknown, path: string, fail: (reason: string) => never): void {
    if (typeof s !== "object" || s === null || !("type" in s)) fail(`${path} 缺 type`);
    const spec = s as { type: unknown; every?: unknown; expr?: unknown };
    if (spec.type === "interval") {
      if (typeof spec.every !== "string" || spec.every === "") fail(`${path} interval 需非空 every`);
      try {
        everyToMs(spec.every);
      } catch (err) {
        fail(`${path} ${err instanceof Error ? err.message : String(err)}`);
      }
    } else if (spec.type === "cron") {
      if (typeof spec.expr !== "string" || spec.expr === "") fail(`${path} cron 需非空 expr`);
      if (this.opts.validateCron) {
        try {
          this.opts.validateCron(spec.expr, 0);
        } catch (err) {
          fail(`${path} cron 表达式非法 "${spec.expr}": ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } else {
      fail(`${path} type 必须是 interval|cron，实际 ${String(spec.type)}`);
    }
  }

  /** 冲突拒绝 + B7 版本链：同 id（幂等/升级/降级/异内容）与同 EntityRef 域（entityType）。 */
  private checkConflicts(def: ProfileDefinition): void {
    const existing = this.defs.get(def.id);
    if (existing) {
      if (existing.version === def.version) {
        if (JSON.stringify(existing) === JSON.stringify(def)) return; // 幂等重载
        throw new Error(
          `profile load rejected (conflict): "${def.id}" v${def.version} 已注册且内容不同 — 冲突拒绝静默覆盖（同版本变更请递增 version）`,
        );
      }
      if (def.version < existing.version) {
        throw new Error(`profile load rejected (conflict): "${def.id}" v${def.version} 低于已注册 v${existing.version} — 版本单向升级`);
      }
      // B7 版本升级：删除的旧状态必须都有改名映射（无映射遇旧状态 → 拒加载）；
      // own-property 判定（ocr F4）：in 吃原型链，'constructor' 等键会被误报已映射
      const removed = existing.states.filter((s) => !def.states.includes(s));
      const unmapped = removed.filter((s) => !Object.prototype.hasOwnProperty.call(def.stateMigrations, s));
      if (unmapped.length > 0) {
        throw new Error(
          `profile load rejected (B7): "${def.id}" v${def.version} 删除状态 [${unmapped.join(", ")}] 而 stateMigrations 无映射 — 旧状态须显式改名迁移（kernel.migrateState 唯一写路径）`,
        );
      }
    }
    const clash = this.profiles().find(
      (other) =>
        other.id !== def.id &&
        claimedTypes(other).some((t) => claimedTypes(def).includes(t)),
    );
    if (clash) {
      throw new Error(
        `profile load rejected (conflict): 同 EntityRef 域冲突 "${claimedTypes(def)
          .filter((t) => claimedTypes(clash).includes(t))
          .join(", ")}" 已被 profile "${clash.id}" 携带 — 冲突定义拒绝注册（US-32 静态面）`,
      );
    }
  }
}

/**
 * 票 42 裁定：validate/templates 静态面自 kernel 迁入——本就只消费注册表 entries 注入（零
 * store/运行时依赖），属 profile 契约面；eda-profiles-deps 不破坏（唯一 kernel 依赖 =
 * ValidateRequest/ValidateResult 契约形状 type-only import）。导出纯函数供测试与组合根直呼。
 */

/** validate（票 11，静态面）：三类错误同步拒（错误信息一律列可用选项）+ ADR 0004 已知
 *  副作用 pattern 命中出 warning 不阻断。数据全部来自注入 entries（I-01）；live-run
 *  执行（verdict/durationMs）归 prober，本面不 spawn。 */
export function validateEntry(
  entries: ReadonlyArray<ProfileRegistryEntry>,
  req: ValidateRequest,
): ValidateResult {
  const entry = entries.find((r) => r.profileId === req.profile);
  if (!entry) {
    return {
      ok: false,
      error: "profile-not-found",
      reason: `profile "${req.profile}" 未找到 — 可用: [${entries.map((r) => r.profileId).sort().join(", ")}]`,
    };
  }
  if (req.template !== undefined && req.check !== undefined) {
    return {
      ok: false,
      error: "checker-declaration",
      reason: "template 与 check 二选一：模板形态（check 由模板派生）或 ad-hoc 形态（显式声明 check）",
    };
  }
  if (req.template !== undefined) {
    const tpl = entry.templates.find((t) => t.name === req.template);
    if (!tpl) {
      return {
        ok: false,
        error: "profile-not-found",
        reason: `template "${req.template}" 未找到 — 可用: [${entry.templates.map((t) => t.name).join(", ")}]`,
      };
    }
    // own-property 判定（票 04 校验器同修法）：不吃 Object.prototype 原型链（"constructor" 等）；显式 undefined 仍算缺失
    const provided = req.params ?? {};
    const missing = (tpl.params ?? []).filter(
      (p) => !Object.prototype.hasOwnProperty.call(provided, p) || provided[p] === undefined,
    );
    if (missing.length > 0) {
      return { ok: false, error: "invalid-params", reason: `缺少必填参数: ${missing.join(", ")}` };
    }
  }
  const check = req.check;
  if (check !== undefined && check.trim() === "") {
    return { ok: false, error: "checker-declaration", reason: "check 声明为空" };
  }
  if (check === undefined && req.template === undefined) {
    return { ok: false, error: "checker-declaration", reason: "ad-hoc 形态必须显式声明 check（模板形态由模板派生）" };
  }
  const warnings = (entry.sideEffectPatterns ?? [])
    .filter((p) => (check ?? "").includes(p))
    .map((p) => `check 命中已知副作用 pattern "${p}"（ADR 0004：探测零副作用，不阻断）`);
  // 语义启发式（生产反馈 2026-10-19：regen-gov converge check 自然退出误报 passed）：checker 无
  // 显式 exit 语句时末命令退出码即语义——提醒声明三态语义（0=passed/2=failed/其他=waiting）
  const c = check ?? "";
  if (c.trim() !== "" && !/exit\s+\d|exit\s+\$/.test(c)) {
    warnings.push("check 未显式声明 exit——末命令退出码即三态语义（0=passed / 2=failed / 其他=waiting），自然结束将被判 passed；建议末行显式 exit 或使用 wait/flip 形态");
  }
  return { ok: true, warnings };
}

/** templates（票 11）：模板元数据清单，全部来自注入 entries（渐进式披露面）。 */
export function profileTemplates(
  entries: ReadonlyArray<ProfileRegistryEntry>,
  profile?: string,
): { templates: readonly TemplateMeta[] } {
  if (profile !== undefined && !entries.some((r) => r.profileId === profile)) {
    throw new Error(`profile "${profile}" 未找到 — 可用: [${entries.map((r) => r.profileId).sort().join(", ")}]`);
  }
  const templates = entries
    .filter((r) => profile === undefined || r.profileId === profile)
    .flatMap((r) => r.templates.map((t) => ({ profileId: r.profileId, ...t })));
  return { templates };
}
