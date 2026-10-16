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
import type { ProfileRegistryEntry } from "../kernel/index.ts";
import type { MigrationDeclaration, ProfileDefinition, ProfileValidator } from "./types.ts";

export type { MigrationDeclaration, ProfileDefinition, ProfileTemplate, ProfileValidator, ScheduleData, SchemaIssue } from "./types.ts";

export interface ProfileRegistryOpts {
  /** D1a 子集校验器（组合根接 protocol validateValue；profiles 禁 import protocol）。 */
  validate: ProfileValidator;
  /** Profile JSON Schema 文档（schemas/profile.schema.json 解析产物，构造注入同上）。 */
  schema: object;
  /** cron 语义校验（组合根接 domain cronNextMs 同形；缺省跳过——kernel subscribe 入口 D11 兜底）。 */
  validateCron?: (expr: string, fromMs: number) => number | null;
}

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

  get(profileId: string): ProfileDefinition | undefined {
    return this.defs.get(profileId);
  }

  /** I-01 状态集并集（kernel 构造注入态：单一封闭集 = 全部 profile 状态的并集）。 */
  states(): ReadonlySet<string> {
    return new Set([...this.defs.values()].flatMap((d) => d.states));
  }

  /** I-01 kernel 注册表静态面（validate/templates 消费；schedule 保持资产形态——op 回显同形）。 */
  entries(): ProfileRegistryEntry[] {
    return this.profiles().map((def) => ({
      profileId: def.id,
      templates: def.templates.map((t) => ({
        name: t.name,
        entityType: def.entityType,
        states: t.states ?? def.states,
        params: Object.keys(t.params),
        schedule: t.schedule ?? def.schedule,
        usage: t.usage,
      })),
    }));
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
      if (t.schedule !== undefined) this.checkSchedule(t.schedule, `templates[${i}].schedule`, fail);
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
      // B7 版本升级：删除的旧状态必须都有改名映射（无映射遇旧状态 → 拒加载）
      const removed = existing.states.filter((s) => !def.states.includes(s));
      const unmapped = removed.filter((s) => !(s in def.stateMigrations));
      if (unmapped.length > 0) {
        throw new Error(
          `profile load rejected (B7): "${def.id}" v${def.version} 删除状态 [${unmapped.join(", ")}] 而 stateMigrations 无映射 — 旧状态须显式改名迁移（kernel.migrateState 唯一写路径）`,
        );
      }
    }
    const clash = this.profiles().find((other) => other.id !== def.id && other.entityType === def.entityType);
    if (clash) {
      throw new Error(
        `profile load rejected (conflict): 同 EntityRef 域冲突 "${def.entityType}" 已被 profile "${clash.id}" 携带 — 冲突定义拒绝注册（US-32 静态面）`,
      );
    }
  }
}
