/**
 * profiles — public surface. See packages/README.md (deep-module layout).
 *
 * 票 31 起：ProfileRegistry（load 资产→Profile 定义 + 冲突拒绝 + B7 迁移声明）。
 * schema 校验器（protocol D1a）与 Profile Schema 文档经构造注入——eda-profiles-deps
 * 禁 profiles→protocol，组合根（daemon-main/测试）负责接线。
 */
export { ProfileRegistry, type ProfileRegistryOpts } from "./registry.ts";
export type {
  MigrationDeclaration,
  ProfileDefinition,
  ProfileTemplate,
  ProfileValidator,
  ScheduleData,
  SchemaIssue,
} from "./types.ts";
