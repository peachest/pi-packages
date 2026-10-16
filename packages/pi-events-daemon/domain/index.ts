/**
 * domain — public surface (deep-module layout, packages/README.md).
 *
 * 票 34 机械补齐：domain/index.ts 此前为票 01 空壳，类型正典 domain/types.ts（EntityRef/
 * entityRefKeyOf/parseEntityRefKey 等，type-unification 裁定单一来源）从未经根入口导出——
 * 跨包消费方（pi-events-daemon-extension）按入口边界规则只能走根文件。零实现变更，仅接线。
 */
export * from "./types.ts";
