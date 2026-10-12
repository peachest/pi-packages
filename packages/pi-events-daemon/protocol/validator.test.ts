/**
 * Ticket 04 acceptance tests — D1a 最小校验器（required/enum/type/正则 子集）命中与放行.
 * B 层：零 IO 纯函数断言（spec #31 Schema 策略 R2-final D1a；模块 spec protocol.md Testing Decisions）。
 * 票文件 04-protocol-validator.md 缺失，断言按模块 spec + #31 正典重构（commit message 有标注）。
 */
import { describe, it, expect } from "vitest";
import { validateValue, type MiniSchema, type MiniIssue } from "./index.ts";

/** 运行时 schema 来自 schemas/ JSON（unknown），类型标注仅为作者便利；junk 注入校验 never-throw。 */
const asSchema = (v: unknown) => v as MiniSchema;
const paths = (issues: MiniIssue[]) => issues.map((i) => i.path).sort();

describe("ticket 04: type 命中与放行", () => {
  it("放行：类型匹配（含 object/array 区分、integer、null）", () => {
    expect(validateValue({ type: "string" }, "x")).toEqual([]);
    expect(validateValue({ type: "object" }, { a: 1 })).toEqual([]);
    expect(validateValue({ type: "array" }, [1])).toEqual([]);
    expect(validateValue({ type: "integer" }, 3)).toEqual([]);
    expect(validateValue({ type: "number" }, 3.5)).toEqual([]);
    expect(validateValue({ type: "boolean" }, false)).toEqual([]);
    expect(validateValue({ type: "null" }, null)).toEqual([]);
  });

  it("命中：类型不符逐个报 issue（object 不含 array/null）", () => {
    expect(validateValue({ type: "string" }, 42)).toEqual([
      { path: "", message: '期望类型 "string"，实际 number' },
    ]);
    expect(validateValue({ type: "object" }, [1, 2])).toEqual([
      { path: "", message: '期望类型 "object"，实际 array' },
    ]);
    expect(validateValue({ type: "object" }, null)).toHaveLength(1);
    expect(validateValue({ type: "integer" }, 3.5)).toHaveLength(1);
  });

  it("放行：type 数组形态（可空字段 state: string|null）", () => {
    const s: MiniSchema = { type: ["string", "null"] };
    expect(validateValue(s, "running")).toEqual([]);
    expect(validateValue(s, null)).toEqual([]);
    expect(validateValue(s, 42)).toHaveLength(1);
  });
});

describe("ticket 04: enum 命中与放行", () => {
  it("放行：值在枚举内", () => {
    expect(validateValue({ enum: ["passed", "failed", "waiting"] }, "waiting")).toEqual([]);
  });

  it("命中：值不在枚举内，错误信息列可用选项", () => {
    const issues = validateValue({ enum: ["passed", "failed", "waiting"] }, "ok");
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("passed");
    expect(issues[0].message).toContain("failed");
    expect(issues[0].message).toContain("waiting");
  });

  it("命中：不做类型强转（\"1\" ≠ 1）", () => {
    expect(validateValue({ enum: [1, 2] }, "1")).toHaveLength(1);
  });
});

describe("ticket 04: required 命中与放行", () => {
  const schema: MiniSchema = {
    type: "object",
    required: ["entityRef", "transition"],
    properties: {
      entityRef: { type: "string" },
      transition: {
        type: "object",
        required: ["to"],
        properties: { to: { type: "string" } },
      },
    },
  };

  it("放行：必填齐备，嵌套 properties 递归校验", () => {
    expect(validateValue(schema, { entityRef: "project/x", transition: { to: "done" } })).toEqual([]);
  });

  it("命中：缺必填字段 issue 落在宿主对象路径，消息含字段名（JSON Schema 语义）", () => {
    expect(validateValue(schema, { transition: { to: "done" } })).toEqual([
      { path: "", message: "缺少必填字段 entityRef" },
    ]);
    expect(validateValue(schema, { entityRef: "project/x", transition: {} })).toEqual([
      { path: "transition", message: "缺少必填字段 to" },
    ]);
  });

  it("properties/required 只作用于 object（JSON Schema 子集语义）", () => {
    expect(validateValue({ properties: { a: { type: "string" } }, required: ["a"] }, 42)).toEqual([]);
  });
});

describe("ticket 04: 正则 pattern 命中与放行", () => {
  it("放行：匹配正则（JSON Schema search 语义，未锚定）", () => {
    expect(validateValue({ pattern: "external/" }, "external/https://gl/x")).toEqual([]);
    expect(validateValue({ pattern: "^(external|project|user)/" }, "project/todo-1")).toEqual([]);
  });

  it("命中：不匹配正则", () => {
    const issues = validateValue({ pattern: "^[a-z]+$" }, "Todo-1");
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("[a-z]+");
  });

  it("pattern 只作用于 string（number 值放行）", () => {
    expect(validateValue({ pattern: "^a" }, 7)).toEqual([]);
  });

  it("命中：schema 正则非法报 issue 不抛错", () => {
    const issues = validateValue({ pattern: "([unclosed" }, "x");
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("正则非法");
  });
});

describe("ticket 04: 综合结构与 never-throw", () => {
  // Profile 定义形状（#31 Profile schema 内容清单的子集取样）
  const profileSchema: MiniSchema = {
    type: "object",
    required: ["name", "entityType", "states", "schedule", "key"],
    properties: {
      name: { type: "string" },
      entityType: { enum: ["external", "project", "user"] },
      states: { type: "array", items: { type: "string" } },
      schedule: {
        type: "object",
        required: ["type"],
        properties: {
          type: { enum: ["interval", "cron"] },
          every: { type: "string" },
          expr: { type: "string" },
          tz: { type: "string" },
        },
      },
      key: { pattern: "^(external|project|user)/" },
    },
  };

  it("放行：合法 Profile 定义零 issue", () => {
    const profile = {
      name: "gitlab-mr",
      entityType: "external",
      states: ["open", "merged", "closed"],
      schedule: { type: "interval", every: "60s" },
      key: "external/https://gl.corp/g/p/-/merge_requests/{iid}",
    };
    expect(validateValue(profileSchema, profile)).toEqual([]);
  });

  it("命中：多缺陷一次报全，路径可定位", () => {
    const profile = {
      entityType: "repo",
      states: ["open", 42],
      schedule: { every: 60 },
    };
    const issues = validateValue(profileSchema, profile);
    expect(paths(issues)).toEqual(["", "", "entityType", "schedule", "schedule.every", "states[1]"]);
    const missing = issues
      .filter((i) => i.message.startsWith("缺少必填字段"))
      .map((i) => i.message)
      .sort();
    expect(missing).toEqual(["缺少必填字段 key", "缺少必填字段 name", "缺少必填字段 type"]);
  });

  it("子集语义：未知关键词忽略（完整校验归 extension 侧）", () => {
    const s: MiniSchema = { type: "string", minLength: 100, title: "x", description: "y" } as MiniSchema;
    expect(validateValue(s, "short")).toEqual([]);
  });

  it("never-throw：垃圾 schema（null/标量/数组）不抛错", () => {
    expect(validateValue(asSchema(null), "x")).toEqual([]);
    expect(validateValue(asSchema(42), "x")).toEqual([]);
    expect(validateValue(asSchema("string"), "x")).toEqual([]);
  });
});
