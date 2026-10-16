/**
 * Ticket 34 — D1a 完整 JSON Schema 校验器（extension 侧）。
 * B 层：daemon 最小校验器同子集语义的扩展集（additionalProperties/oneOf/$ref/minimum/minItems…）
 * 的拒绝矩阵；never-throw（垃圾 schema/垃圾值不崩）。
 * 正典：schemas/op.schema.json（同源加载，不复制）。
 */
import { describe, expect, it } from "vitest";
import {
  loadEventsSchema,
  loadOpSchema,
  loadProfileSchema,
  validateFull,
  type JsonSchema,
} from "../index.ts";

const OP_SCHEMA = loadOpSchema();

const subscribeRequest = ((OP_SCHEMA.properties as Record<string, JsonSchema>).subscribe.properties as Record<string, JsonSchema>)
  .request as JsonSchema;

describe("票 34：完整校验器——daemon 最小校验同子集语义 + 扩展集", () => {
  it("type（含数组形态）：不匹配报路径与期望/实际", () => {
    const schema: JsonSchema = { type: "string" };
    expect(validateFull(schema, 5)).toEqual([{ path: "", message: '期望类型 "string"，实际 number' }]);
    const multi: JsonSchema = { type: ["string", "number"] };
    expect(validateFull(multi, true)).toEqual([{ path: "", message: '期望类型 "string"|"number"，实际 boolean' }]);
    expect(validateFull({ type: ["string", "number"] }, 5)).toEqual([]);
  });

  it("enum：严格相等，错误列全部可用选项（#31 错误形态）", () => {
    const schema: JsonSchema = { enum: ["session", "auto"] };
    expect(validateFull(schema, "auto")).toEqual([]);
    expect(validateFull(schema, "session ")).toEqual([
      { path: "", message: "值不在枚举 [session, auto] 内" },
    ]);
  });

  it("required/properties 嵌套路径（点号）", () => {
    const schema: JsonSchema = {
      type: "object",
      required: ["a"],
      properties: { a: { type: "object", required: ["b"], properties: { b: { type: "number" } } } },
    };
    expect(validateFull(schema, {})).toEqual([{ path: "", message: "缺少必填字段 a" }]);
    expect(validateFull(schema, { a: {} })).toEqual([{ path: "a", message: "缺少必填字段 b" }]);
    expect(validateFull(schema, { a: { b: "x" } })).toEqual([{ path: "a.b", message: '期望类型 "number"，实际 string' }]);
    expect(validateFull(schema, { a: { b: 1 } })).toEqual([]);
  });

  it("additionalProperties: false——未知键拒绝并列出允许键（daemon 最小校验器不管此项：D1a 行为差异锚点）", () => {
    const schema: JsonSchema = { type: "object", properties: { a: { type: "number" } }, additionalProperties: false };
    expect(validateFull(schema, { a: 1 })).toEqual([]);
    expect(validateFull(schema, { a: 1, extra: "x" })).toEqual([
      { path: "extra", message: "不允许的字段（允许: a）" },
    ]);
  });

  it("additionalProperties 为 schema 形态：额外键按该 schema 校验（templateInfo.params 先例）", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {},
      additionalProperties: { type: "string" },
    };
    expect(validateFull(schema, { k: "v" })).toEqual([]);
    expect(validateFull(schema, { k: 5 })).toEqual([{ path: "k", message: '期望类型 "string"，实际 number' }]);
  });

  it("oneOf：零命中报首分支聚合 issue；多命中报二义", () => {
    const schema: JsonSchema = {
      oneOf: [{ required: ["a"] }, { required: ["b"] }],
    };
    expect(validateFull(schema, { a: 1 })).toEqual([]);
    expect(validateFull(schema, {}).length).toBe(1);
    expect(validateFull(schema, {})[0].message).toContain("未命中任何 oneOf 分支");
    expect(validateFull(schema, { a: 1, b: 2 })[0].message).toContain("命中多个 oneOf 分支");
  });

  it("$ref：内部 definitions 指针解析（op schema 同源依赖）", () => {
    const schema: JsonSchema = {
      definitions: { positive: { type: "integer", minimum: 1 } },
      properties: { n: { $ref: "#/definitions/positive" } },
    };
    expect(validateFull(schema, { n: 1 })).toEqual([]);
    expect(validateFull(schema, { n: 0 })).toEqual([{ path: "n", message: "期望 >= 1" }]);
    expect(validateFull(schema, { n: 1.5 })).toEqual([{ path: "n", message: '期望类型 "integer"，实际 number' }]);
  });

  it("minimum/minItems/minLength/maxLength/pattern", () => {
    expect(validateFull({ minimum: 3 }, 2)).toEqual([{ path: "", message: "期望 >= 3" }]);
    expect(validateFull({ minItems: 2 }, [1])).toEqual([{ path: "", message: "期望数组长度 >= 2" }]);
    expect(validateFull({ minLength: 2 }, "a")).toEqual([{ path: "", message: "期望字符串长度 >= 2" }]);
    expect(validateFull({ maxLength: 2 }, "abc")).toEqual([{ path: "", message: "期望字符串长度 <= 2" }]);
    expect(validateFull({ pattern: "^ab" }, "xb")).toEqual([{ path: "", message: "不匹配正则 /^ab/" }]);
    expect(validateFull({ pattern: "^ab" }, "abc")).toEqual([]);
  });

  it("items：数组逐元素带下标路径；tuple 形态按位校验", () => {
    const schema: JsonSchema = { items: { type: "string" } };
    expect(validateFull(schema, ["a", 5])).toEqual([{ path: "[1]", message: '期望类型 "string"，实际 number' }]);
    const tuple: JsonSchema = { items: [{ type: "string" }, { type: "number" }] };
    expect(validateFull(tuple, ["a", 1])).toEqual([]);
    expect(validateFull(tuple, [1, "a"])).toEqual([
      { path: "[0]", message: '期望类型 "string"，实际 number' },
      { path: "[1]", message: '期望类型 "number"，实际 string' },
    ]);
  });

  it("never-throw：垃圾 schema 与垃圾值只产出 issue 不崩", () => {
    expect(validateFull(null as unknown as JsonSchema, { x: 1 })).toEqual([]);
    expect(validateFull("garbage" as unknown as JsonSchema, 5)).toEqual([]);
    expect(validateFull({ pattern: "[" }, "x")).toEqual([{ path: "", message: "schema 正则非法：/[/" }]);
    expect(validateFull({ $ref: "#/definitions/missing" }, 1)).toEqual([
      { path: "", message: 'schema $ref 无法解析：#/definitions/missing' },
    ]);
    // 循环 $ref 不栈溢出
    const cyclic: JsonSchema = { definitions: {} };
    cyclic.definitions!.self = { $ref: "#" };
    expect(() => validateFull(cyclic, 1)).not.toThrow();
  });
});

describe("票 34：同源加载（schemas/ 随 daemon 包发版，extension 不复制）", () => {
  it("op/events/profile 三契约可从 pi-events-daemon 包解析加载", () => {
    expect(Object.keys(OP_SCHEMA.properties as object).sort()).toEqual(
      ["subscribe", "cancel", "query", "publish", "drain", "evidence", "status", "validate", "templates"].sort(),
    );
    expect((loadEventsSchema().properties as Record<string, unknown>).subscriptions).toBeDefined();
    expect((loadProfileSchema().properties as Record<string, unknown>).templates).toBeDefined();
  });

  it("真实 op schema 的 subscribe request 全量校验：合法 url 形态放行，oneOf/additionalProperties 拒绝", () => {
    expect(validateFull(subscribeRequest, { url: "https://gitlab.com/g/p/-/merge_requests/1" })).toEqual([]);
    // 缺 target（oneOf 零命中）与未知键（additionalProperties: false）
    expect(validateFull(subscribeRequest, {}).length).toBeGreaterThan(0);
    expect(validateFull(subscribeRequest, { url: "x", shell: "rm -rf /" }).some((i) => i.path === "shell")).toBe(true);
  });
});
