import { describe, expect, it } from "vitest";
import { validateSubset } from "./validate.ts";

// 票 03 断言组 1：D1a 手写最小校验器（R2-final 裁定）——只实现 required/enum/type/正则 子集，
// 完整 JSON Schema 校验归 extension 侧（#31 Schema 策略）。本组钉死子集语义的命中与放行。
describe("票 03: D1a 最小校验器（required/enum/type/正则 子集）", () => {
  it("type 命中与放行（含 type 数组；object 不含数组）", () => {
    expect(validateSubset({ type: "string" }, "x")).toEqual([]);
    expect(validateSubset({ type: ["string", "null"] }, null)).toEqual([]);
    expect(validateSubset({ type: "object" }, { a: 1 })).toEqual([]);
    expect(validateSubset({ type: "array" }, [])).toEqual([]);
    expect(validateSubset({ type: "integer" }, 3)).toEqual([]);
  });

  it("type 违反：报路径与期望类型", () => {
    expect(validateSubset({ type: "integer" }, 1.5)).toEqual(["$: expected type integer, got number"]);
    expect(validateSubset({ type: "object" }, [])).toEqual(["$: expected type object, got array"]);
    expect(validateSubset({ type: ["string", "null"] }, 42)).toEqual(["$: expected type string | null, got number"]);
  });

  it("required 违反：缺字段报错，嵌套经 properties 遍历带路径", () => {
    expect(validateSubset({ type: "object", required: ["a"] }, {})).toEqual(['$: missing required field "a"']);
    const schema = { type: "object", required: ["p"], properties: { p: { type: "object", required: ["q"] } } };
    expect(validateSubset(schema, { p: {} })).toEqual(['$.p: missing required field "q"']);
    expect(validateSubset(schema, { p: { q: 1 } })).toEqual([]);
  });

  it("enum 命中与违反", () => {
    const schema = { enum: ["passed", "failed", "waiting"] };
    expect(validateSubset(schema, "failed")).toEqual([]);
    expect(validateSubset(schema, "ok")).toEqual(['$: must be one of ["passed","failed","waiting"]']);
  });

  it("pattern（正则）命中与违反；非字符串值不触发", () => {
    const schema = { type: ["string", "object"], pattern: "^(external|project|user)/.+$" };
    expect(validateSubset(schema, "external/mr/1")).toEqual([]);
    expect(validateSubset(schema, "mr/1")).toEqual(["$: must match /^(external|project|user)/.+$/"]);
    expect(validateSubset(schema, { any: "object" })).toEqual([]);
  });

  it("items 遍历：数组元素违规带下标路径", () => {
    const schema = { type: "array", items: { type: "string" } };
    expect(validateSubset(schema, ["a", "b"])).toEqual([]);
    expect(validateSubset(schema, ["a", 42])).toEqual(["$[1]: expected type string, got number"]);
  });

  it("子集语义：未知关键字静默忽略，不报错不抛错", () => {
    const schema = { type: "string", minLength: 99, format: "date-time", description: "ignored", default: "x" };
    expect(validateSubset(schema, "abc")).toEqual([]);
  });

  it("properties 只遍历声明过的键，未声明键放行（additionalProperties 归完整校验器）", () => {
    const schema = { type: "object", properties: { a: { type: "string" } } };
    expect(validateSubset(schema, { a: "x", extra: { deep: true } })).toEqual([]);
  });
});
