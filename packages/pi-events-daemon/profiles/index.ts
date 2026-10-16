/**
 * profiles — public surface. See packages/README.md (deep-module layout).
 *
 * 职责（模块 spec）：ProfileRegistry（load/resolve/instantiate/checkRegister 编排位）
 * + 模板资产 + 校验 + URL 路由。schema 校验器（protocol D1a）与 Profile Schema 文档经
 * 构造注入——eda-profiles-deps 禁 profiles→protocol，组合根（daemon-main/测试）负责接线。
 */
export { ProfileRegistry, type ProfileRegistryOpts } from "./registry.ts";
export {
  checkRegister,
  ephemeralRef,
  everyToMs,
  resolveUrl,
  scheduleToProbeSpec,
  type CredentialCheck,
  type ProbeSchedule,
  type ResolveResult,
} from "./routing.ts";
export type {
  MigrationDeclaration,
  ProfileDefinition,
  ProfileTemplate,
  ProfileValidator,
  ScheduleData,
  SchemaIssue,
} from "./types.ts";
