/**
 * protocol/validate — D1a 校验分层的手写最小校验器（#31 Schema 策略，R2-final 裁定）。
 *
 * 只实现 JSON Schema 子集：type / required / enum / pattern（正则），
 * 加 properties / items 两个遍历脚手架（把四个判定带到嵌套值上）。
 * 其余 JSON Schema 关键字一律静默忽略——完整校验归 extension/CLI 侧标准校验器。
 * 客户：profile 注册表校验（I-01，kernel 加载 Profile 文档时）；schemas/ 三契约文件
 * 刻意只使用子集关键字 + 完整校验器专属关键字，保证本器可直接消费（三契约同源）。
 */

/** JSON Schema 的 D1a 子集视图：本校验器认识的关键字；其余关键字被忽略。 */
export interface JsonSchemaSubset {
  type?: string | string[];
  /** 枚举命中（本仓 schema 的 enum 全为标量，严格相等比较）。 */
  enum?: unknown[];
  /** 正则（JS RegExp 语义）；只作用于字符串值。 */
  pattern?: string;
  required?: string[];
  properties?: Record<string, JsonSchemaSubset>;
  items?: JsonSchemaSubset;
}

/**
 * 校验 value 是否满足 schema 的子集约束。返回违反清单（空数组 = 通过）；
 * 每条带 JSONPath 式路径（根为 "$"），注册表校验报错可直接展示。
 */
export function validateSubset(schema: JsonSchemaSubset, value: unknown, path = "$"): string[] {
  const errors: string[] = [];
  if (schema.type !== undefined && !typeMatches(schema.type, value)) {
    errors.push(`${path}: expected type ${describeType(schema.type)}, got ${describeValue(value)}`);
    return errors; // 类型不符时嵌套判定无意义
  }
  if (schema.enum !== undefined && !schema.enum.some((allowed) => allowed === value)) {
    errors.push(`${path}: must be one of ${JSON.stringify(schema.enum)}`);
  }
  if (typeof value === "string" && schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${path}: must match /${schema.pattern}/`);
  }
  if (schema.required !== undefined && isPlainObject(value)) {
    for (const key of schema.required) {
      if (!(key in value)) errors.push(`${path}: missing required field "${key}"`);
    }
  }
  if (schema.properties !== undefined && isPlainObject(value)) {
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (key in value) errors.push(...validateSubset(sub, value[key], `${path}.${key}`));
    }
  }
  if (schema.items !== undefined && Array.isArray(value)) {
    value.forEach((element, index) => errors.push(...validateSubset(schema.items!, element, `${path}[${index}]`)));
  }
  return errors;
}

function typeMatches(type: string | string[], value: unknown): boolean {
  return (Array.isArray(type) ? type : [type]).some((name) => typeIs(name, value));
}

function typeIs(name: string, value: unknown): boolean {
  switch (name) {
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    default:
      return true; // 未知类型名按子集语义放行（完整校验器裁决）
  }
}

function describeType(type: string | string[]): string {
  return Array.isArray(type) ? type.join(" | ") : type;
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
