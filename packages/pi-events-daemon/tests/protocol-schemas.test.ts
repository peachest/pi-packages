import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { protocol } from "../index.ts";

const { OP_NAMES, validateSubset } = protocol;
type SubscribeOpts = protocol.SubscribeOpts;

// 票 03：三契约同源 JSON Schema 文件随包发版（#31 Schema 策略 R3）——
// op 契约 / Profile 定义 / .pi/events.json。测试经包入口导入（tests-through-entrypoints）；
// 位置在 tests/ 而非 protocol/ 同位：票 02 断言 5 扫 protocol/ 全部 .ts 禁 import，
// vitest 测试文件无法同位（票 04 validator.test.ts 同雷，已在报告上报 coordinator）。
// 校验器本体归票 04（validateValue）；本文件用同 D1a 子集语义的 validateSubset 执行，
// 票 04 合并后把 import 一行切换为 validateValue 即可（两侧都返回 issue 数组，断言形状兼容）。
const SCHEMA_FILES = ["op.schema.json", "profile.schema.json", "events.schema.json"] as const;
const DRAFT07 = "http://json-schema.org/draft-07/schema#";

function loadSchema(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`../schemas/${name}`, import.meta.url), "utf8"));
}

const opSchema = loadSchema("op.schema.json");
const profileSchema = loadSchema("profile.schema.json");
const eventsSchema = loadSchema("events.schema.json");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** draft-07 已知关键字白名单：遍历全部 schema 节点只允许出现这些键——
 *  「文件可被标准 JSON Schema 校验器验证」（模块 spec Testing Decisions）的零依赖 proxy。 */
const DRAFT07_KEYWORDS = new Set([
  "$schema",
  "$id",
  "$comment",
  "$ref",
  "title",
  "description",
  "default",
  "examples",
  "type",
  "enum",
  "const",
  "pattern",
  "required",
  "properties",
  "items",
  "additionalProperties",
  "oneOf",
  "anyOf",
  "allOf",
  "definitions",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
]);

function checkSchemaNode(node: unknown, at: string, errors: string[]): void {
  if (!isRecord(node)) {
    errors.push(`${at}: schema 节点必须是对象`);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (!DRAFT07_KEYWORDS.has(key)) {
      errors.push(`${at}: 非 draft-07 关键字 "${key}"`);
      continue;
    }
    if ((key === "properties" || key === "definitions") && isRecord(value)) {
      for (const [name, sub] of Object.entries(value)) checkSchemaNode(sub, `${at}.${key}.${name}`, errors);
    } else if (key === "items" && isRecord(value)) {
      checkSchemaNode(value, `${at}.items`, errors);
    } else if ((key === "oneOf" || key === "anyOf" || key === "allOf") && Array.isArray(value)) {
      value.forEach((sub, i) => checkSchemaNode(sub, `${at}.${key}[${i}]`, errors));
    } else if (key === "additionalProperties" && isRecord(value)) {
      checkSchemaNode(value, `${at}.additionalProperties`, errors);
    }
  }
}

// D1a 元校验：三份 schema 文档本身作为值，过 D1a 子集的 required/type/enum 检查
//（纠偏口径：票 04 validateValue 的检查种类；合并后切换为 validateValue 调用）。
const META_SCHEMA = {
  type: "object",
  required: ["$schema", "type"],
  properties: {
    $schema: { enum: [DRAFT07] },
    type: { enum: ["object"] },
    definitions: { type: "object" },
    properties: { type: "object" },
  },
};

describe("票 03: 三契约 schema 文件随包发版（schemas/）", () => {
  it("三文件存在、合法 JSON、$schema = draft-07", () => {
    for (const name of SCHEMA_FILES) {
      const schema = loadSchema(name);
      expect(schema.$schema, name).toBe(DRAFT07);
    }
  });

  it("三份 schema 本身过 D1a 子集 required/type/enum 检查（票 04 validateValue 同语义）", () => {
    for (const name of SCHEMA_FILES) {
      expect(validateSubset(META_SCHEMA, loadSchema(name)), name).toEqual([]);
    }
  });

  it("全部节点只用 draft-07 已知关键字（可被标准 JSON Schema 校验器验证）", () => {
    for (const name of SCHEMA_FILES) {
      const errors: string[] = [];
      checkSchemaNode(loadSchema(name), name, errors);
      expect(errors, name).toEqual([]);
    }
  });

  it("op schema 根属性 = 9 op 全集（与 OP_NAMES 对齐，#31 操作面表）", () => {
    expect(Object.keys(opSchema.properties as Record<string, unknown>).sort()).toEqual([...OP_NAMES].sort());
  });

  it("subscribe opts 与票 02 已合并 SubscribeOpts 类型逐键对齐（flat + 显式枚举，pi-fabric 教训）", () => {
    const opts = (opSchema.properties as Record<string, any>).subscribe.properties.request.properties.opts;
    // 双向 pin：缺键或多余键都在编译期红（schema 手改漂移同样红）
    const optsPin: Record<keyof SubscribeOpts, true> = {
      on: true,
      once: true,
      flip: true,
      template: true,
      smoke: true,
      sessionId: true,
      readyCheck: true,
      ttl: true,
      failureThreshold: true,
      successThreshold: true,
    };
    expect(Object.keys(opts.properties).sort()).toEqual(Object.keys(optsPin).sort());
    // 每个 opt 都有类型（或 $ref）与说明——显式声明，不靠猜
    for (const [name, opt] of Object.entries(opts.properties) as [string, Record<string, unknown>][]) {
      expect(opt.type ?? opt.$ref ?? opt.enum, `opts.${name} 类型`).toBeDefined();
      expect(opt.description, `opts.${name} description`).toEqual(expect.any(String));
    }
  });

  it("Profile schema 内容清单 8 项齐全（R3 正典：I-01 注册表格式的正式化）", () => {
    const properties = Object.keys(profileSchema.properties as Record<string, unknown>);
    // R3 清单：状态集（闭集）+ 转换表 + payload schema + key 生成规则 + schedule +
    // on-transition 编排规则（C2）+ probe 模板 + 状态改名迁移映射（B7）
    for (const item of [
      "states",
      "transitions",
      "payloadSchema",
      "keyGenerator",
      "schedule",
      "onTransition",
      "templates",
      "stateMigrations",
    ]) {
      expect(properties, item).toContain(item);
    }
    // 身份与版本（B7 版本化改名的前提）
    expect(properties).toEqual(expect.arrayContaining(["id", "entityType", "version"]));
  });

  it(".pi/events.json 契约：subscriptions[].template 必填；意图 opts 为 auto 子集（无 sessionId/smoke/schedule）", () => {
    const entry = (eventsSchema.properties as Record<string, any>).subscriptions.items;
    expect(entry.required).toEqual(["template"]);
    expect(Object.keys(entry.properties).sort()).toEqual([
      "failureThreshold",
      "flip",
      "on",
      "once",
      "params",
      "successThreshold",
      "template",
      "ttl",
    ]);
    expect(Object.keys(eventsSchema.properties as Record<string, unknown>)).toEqual(["subscriptions"]);
  });
});
