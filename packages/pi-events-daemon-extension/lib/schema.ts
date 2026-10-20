/**
 * schema — D1a 客户侧完整 JSON Schema 校验器（票 34；#31 Schema 策略 R3）。
 *
 * 分层正典：daemon 内置最小校验器（required/enum/type/正则），完整校验归 extension——
 * 本实现覆盖三契约（op/profile/events schema）实际使用的关键词子集：
 *   type（含数组）、enum、pattern、properties、required、items（含 tuple 形态）、
 *   additionalProperties（false | schema）、oneOf、$ref（内部 #/definitions 指针）、
 *   minimum、minItems、minLength、maxLength。
 * 子集外关键词按 JSON Schema 惯例忽略（与 daemon 最小校验器同一"不报错"精神）。
 * 绝不抛错：垃圾 schema / 垃圾值只产出 issue（与帧解码同一纪律）。
 *
 * 同源纪律：schema 文档从 pi-events-daemon 包内 schemas/ 目录加载（随包发版），零复制。
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import type { MiniIssue } from "pi-events-daemon/protocol.ts";

export type JsonSchema = {
  type?: string | string[];
  enum?: unknown[];
  pattern?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema | JsonSchema[];
  additionalProperties?: boolean | JsonSchema;
  oneOf?: JsonSchema[];
  $ref?: string;
  minimum?: number;
  minItems?: number;
  minLength?: number;
  maxLength?: number;
  definitions?: Record<string, JsonSchema>;
  [key: string]: unknown;
};

export type Issue = MiniIssue;

/**
 * 完整校验：schema = 校验节点，value = 待校验值；root = $ref 解析基准文档（缺省 = schema 本身，
 * 即整文档校验；校验嵌套节点时显式传同源根）。全部放行返回 []。
 */
export function validateFull(schema: JsonSchema | undefined, value: unknown, root: JsonSchema = schema as JsonSchema): Issue[] {
  const issues: Issue[] = [];
  try {
    checkNode(root, schema, value, "", issues, new Set());
  } catch {
    // never-throw 兑底：递归意外异常归一为单条 issue，不外溢
    issues.push({ path: "", message: "schema 校验内部异常（垃圾 schema？）" });
  }
  return issues;
}

function checkNode(
  root: JsonSchema,
  schema: JsonSchema | undefined,
  value: unknown,
  path: string,
  out: Issue[],
  visited: Set<string>,
): void {
  if (schema === undefined || schema === null || typeof schema !== "object" || Array.isArray(schema)) return;

  if (typeof schema.$ref === "string") {
    const resolved = resolveRef(root, schema.$ref);
    if (!resolved.ok) {
      out.push({ path, message: `schema $ref 无法解析：${schema.$ref}` });
      return;
    }
    // 评审 M：循环截断按 (ref, 值路径) 记账而非仅 ref——同 ref 在不同值路径（如 queryEntity
    // children 逐层）仍逐层校验；仅纯 $ref 链原路径重入（真 schema 循环）才截断。
    const visitKey = `${schema.$ref}\u0000${path}`;
    if (visited.has(visitKey)) return;
    visited.add(visitKey);
    checkNode(root, resolved.node, value, path, out, visited);
    return;
  }

  checkType(schema, value, path, out);
  checkEnum(schema, value, path, out);
  checkPattern(schema, value, path, out);
  checkBounds(schema, value, path, out);

  if (Array.isArray(schema.oneOf)) {
    const branches = schema.oneOf.map((branch) => {
      const branchIssues: Issue[] = [];
      // 分支各自克隆 visited：同 ref 同路径的兄弟分支互不污染（ancestral 循环截断仍继承）
      checkNode(root, branch, value, path, branchIssues, new Set(visited));
      return branchIssues;
    });
    const hits = branches.filter((b) => b.length === 0).length;
    if (hits === 0) {
      const first = branches[0] ?? [];
      const detail = first.map((i) => `${i.path || "<根>"}: ${i.message}`).join("; ");
      out.push({ path, message: `未命中任何 oneOf 分支（${detail || "无分支约束细节"}）` });
    } else if (hits > 1) {
      out.push({ path, message: `命中多个 oneOf 分支（${hits} 个）——二义，请显式指定` });
    }
  }

  if (isRecord(value)) {
    checkObject(root, schema, value, path, out, visited);
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    checkItems(root, schema, value, path, out, visited);
  }
}

function checkType(schema: JsonSchema, value: unknown, path: string, out: Issue[]): void {
  const type = schema.type;
  if (type === undefined) return;
  const wanted = Array.isArray(type) ? type : [type];
  const ok = wanted.some((t) => typeof t === "string" && typeMatches(t, value));
  if (!ok) {
    const names = wanted.map((t) => (typeof t === "string" ? JSON.stringify(t) : String(t))).join("|");
    // 票 119：字符串化标量高频误传（模型把 boolean/number 包进引号）——文案直接给纠正动作
    let hint = "";
    if (typeof value === "string") {
      const t = wanted.find((x) => x === "boolean" || x === "number");
      if (t === "boolean" && (value === "true" || value === "false")) hint = `——JSON 里去掉引号: ${value}`;
      else if (t === "number" && value !== "" && !Number.isNaN(Number(value))) hint = `——JSON 里去掉引号: ${value}`;
    }
    out.push({ path, message: `期望类型 ${names}，实际 ${jsonTypeName(value)}${hint}` });
  }
}

function checkEnum(schema: JsonSchema, value: unknown, path: string, out: Issue[]): void {
  if (!Array.isArray(schema.enum)) return;
  if (!schema.enum.some((e) => e === value)) {
    out.push({ path, message: `值不在枚举 [${schema.enum.map((e) => String(e)).join(", ")}] 内` });
  }
}

function checkPattern(schema: JsonSchema, value: unknown, path: string, out: Issue[]): void {
  if (typeof schema.pattern !== "string" || typeof value !== "string") return;
  let re: RegExp | null = null;
  try {
    re = new RegExp(schema.pattern);
  } catch {
    out.push({ path, message: `schema 正则非法：/${schema.pattern}/` });
    return;
  }
  if (!re.test(value)) out.push({ path, message: `不匹配正则 /${schema.pattern}/` });
}

function checkBounds(schema: JsonSchema, value: unknown, path: string, out: Issue[]): void {
  if (typeof value === "number" && typeof schema.minimum === "number" && value < schema.minimum) {
    out.push({ path, message: `期望 >= ${schema.minimum}` });
  }
  if (Array.isArray(value) && typeof schema.minItems === "number" && value.length < schema.minItems) {
    out.push({ path, message: `期望数组长度 >= ${schema.minItems}` });
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      out.push({ path, message: `期望字符串长度 >= ${schema.minLength}` });
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      out.push({ path, message: `期望字符串长度 <= ${schema.maxLength}` });
    }
  }
}

function checkObject(
  root: JsonSchema,
  schema: JsonSchema,
  value: Record<string, unknown>,
  path: string,
  out: Issue[],
  visited: Set<string>,
): void {
  const props = isRecord(schema.properties) ? (schema.properties as Record<string, JsonSchema>) : {};
  if (Array.isArray(schema.required)) {
    for (const key of schema.required) {
      if (typeof key === "string" && !Object.prototype.hasOwnProperty.call(value, key)) {
        out.push({ path, message: `缺少必填字段 ${key}` });
      }
    }
  }
  for (const [key, sub] of Object.entries(props)) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      checkNode(root, sub, value[key], childPath(path, key), out, visited);
    }
  }
  const extra = Object.keys(value).filter(
    (k) => !Object.prototype.hasOwnProperty.call(props, k),
  );
  if (extra.length === 0) return;
  if (schema.additionalProperties === false) {
    for (const key of extra) {
      out.push({ path: childPath(path, key), message: `不允许的字段（允许: ${Object.keys(props).join(", ") || "无"}）` });
    }
  } else if (isRecord(schema.additionalProperties)) {
    for (const key of extra) {
      checkNode(root, schema.additionalProperties as JsonSchema, value[key], childPath(path, key), out, visited);
    }
  }
}

function checkItems(
  root: JsonSchema,
  schema: JsonSchema,
  value: unknown[],
  path: string,
  out: Issue[],
  visited: Set<string>,
): void {
  if (Array.isArray(schema.items)) {
    // draft-07 tuple 形态：按位校验
    schema.items.forEach((sub, i) => {
      if (i < value.length) checkNode(root, sub, value[i], `${path}[${i}]`, out, visited);
    });
    return;
  }
  value.forEach((el, i) => checkNode(root, schema.items as JsonSchema, el, `${path}[${i}]`, out, visited));
}

function resolveRef(root: JsonSchema, ref: string): { ok: true; node: JsonSchema } | { ok: false } {
  if (!ref.startsWith("#/")) return { ok: false };
  let node: unknown = root;
  for (const seg of ref.slice(2).split("/")) {
    if (!isRecord(node) || !Object.prototype.hasOwnProperty.call(node, seg)) return { ok: false };
    node = (node as Record<string, unknown>)[seg];
  }
  return isRecord(node) ? { ok: true, node: node as JsonSchema } : { ok: false };
}

function typeMatches(t: string, v: unknown): boolean {
  switch (t) {
    case "object":
      return isRecord(v);
    case "array":
      return Array.isArray(v);
    case "string":
      return typeof v === "string";
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "boolean":
      return typeof v === "boolean";
    case "null":
      return v === null;
    default:
      return false; // 未知类型名不匹配任何值（垃圾 schema 保守拒绝）
  }
}

function jsonTypeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function childPath(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// --- 同源加载：三契约 schema 从 pi-events-daemon 包内 schemas/ 解析（随包发版） ---

let cachedSchemasDir: string | null = null;

/** pi-events-daemon 包内 schemas/ 目录（经 node_modules 软链解析，仓规 install-packages.md）。 */
export function daemonSchemasDir(): string {
  if (cachedSchemasDir) return cachedSchemasDir;
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve("pi-events-daemon/package.json");
  cachedSchemasDir = join(dirname(pkgPath), "schemas");
  return cachedSchemasDir;
}

export function loadSchemaFile(name: string): JsonSchema {
  return JSON.parse(readFileSync(join(daemonSchemasDir(), name), "utf8")) as JsonSchema;
}

export const loadOpSchema = (): JsonSchema => loadSchemaFile("op.schema.json");
export const loadProfileSchema = (): JsonSchema => loadSchemaFile("profile.schema.json");
export const loadEventsSchema = (): JsonSchema => loadSchemaFile("events.schema.json");
