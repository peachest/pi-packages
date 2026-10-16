/**
 * profiles — 共享数据形状（票 31）。单一来源是 schemas/profile.schema.json（Profile JSON Schema，
 * R3 正典 8 项）；本文件是其 TS 投影，字段与 schema 同步维护。行为在 registry/routing/instantiate。
 */

/** schedule 资产形态（schema#/definitions/scheduleSpec）：interval 的 every 是时长串（"60s"）。 */
export type ScheduleData = { type: "interval"; every: string } | { type: "cron"; expr: string; tz?: string };

/** probe 模板资产条目（schema templates.items；checker 声明 + 参数模板 + 文档段自包含）。 */
export interface ProfileTemplate {
  name: string;
  /** check 命令文本（tri-state 判定器原语；模板资产，agent 永不传入；{param} 占位符由 instantiate 代入）。 */
  check: string;
  /** 模板回显的闭集子集（缺省 = 全 states）。 */
  states?: string[];
  /** 模板级 schedule 覆盖（缺省用 profile 顶层 schedule）。 */
  schedule?: ScheduleData;
  /** URL 路由正则（票 32 resolve；load 校验可编译）。缺省不参与 URL 路由。 */
  urlPattern?: string;
  /** 显式 host 路由（双 GitLab 零 fallback）：携带时 URL host 必须精确相等才参与命中。 */
  host?: string;
  /** EntityRef.type 覆盖（票 33 三域：一 profile 内多判别符）；缺省继承顶层 entityType。 */
  entityType?: string;
  /** 参数名 → 说明（参数模板）。 */
  params: Record<string, string>;
  /** 文档段（usage）。 */
  usage: string;
}

/**
 * Profile 定义（I-01 注册表数据声明）。加载时注入 kernel 注册表——kernel 校验查注册表值，
 * 无代码 import（零依赖约束由 eda-profiles-deps 执法：profiles 只许 import kernel 类型面）。
 */
export interface ProfileDefinition {
  id: string;
  /** 源系统判别符 = domain EntityRef.type（key generator 产物携带它，ADR 0002）。 */
  entityType: string;
  /** 版本；stateMigrations 随改名递增（B7 版本化前提）。 */
  version: number;
  /** 封闭状态集（闭集）；null 表示尚未探测（无合成前态）。 */
  states: string[];
  /** 合法转换表声明（from→to 对；观测态来自现实，表是文档面非执法面）。 */
  transitions: { from: string; to: string; description?: string }[];
  /** payload 的 JSON Schema（draft-07 文档；daemon 侧 D1a 子集校验）。 */
  payloadSchema: Record<string, unknown>;
  /** key 生成规则（kind 为规则名，其余字段为规则参数——形状归 profile 层，ADR 0002）。 */
  keyGenerator: { kind: string } & Record<string, unknown>;
  /** schedule 默认（模板缺省节奏；模板可覆盖）。 */
  schedule: ScheduleData;
  /** on-transition 编排规则（C2 数据声明；执行归 kernel/loops，本模块只生产）。 */
  onTransition: { on: string | string[]; action: string; params?: Record<string, unknown> }[];
  templates: ProfileTemplate[];
  /** 状态改名迁移映射（B7）：旧状态名 → 新状态名；执行经 kernel.migrateState 唯一写路径。 */
  stateMigrations: Record<string, string>;
  /** 已知副作用 pattern（票 33 数据面；validate 命中出 warning 不阻断，ADR 0004）。 */
  sideEffectPatterns?: string[];
}

/** B7 迁移声明（load 产出的数据面；loops 逐实体消费经 kernel.migrateState 提交显式迁移事件）。 */
export interface MigrationDeclaration {
  profileId: string;
  version: number;
  from: string;
  to: string;
}

/** D1a 校验 issue（protocol validateValue 返回形状的结构投影——profiles 禁 import protocol）。 */
export type SchemaIssue = { path: string; message: string };

/**
 * Profile Schema 校验器（构造注入：组合根接 protocol 的 D1a validateValue，eda-profiles-deps）。
 * schema 参数宽化为 object：注入侧（protocol MiniSchema 是结构子集）与消费侧（JSON.parse 产物）均兼容。
 */
export type ProfileValidator = (schema: object, value: unknown) => readonly SchemaIssue[];
