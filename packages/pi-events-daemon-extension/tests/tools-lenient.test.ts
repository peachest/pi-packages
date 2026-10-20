/** 票 119：注册 schema 放宽 + D1a 接管——host AJV 不再拒拍平帧，D1a 层产自纠文案 */
// @ts-expect-error ajv d.ts ESM interop（票 119 遗留类型环境问题，运行时正常）
import Ajv2020 from "ajv/dist/2020";
import { describe, expect, it } from "vitest";
import { buildToolDefs, loadOpSchema } from "../index.ts";

const defs = buildToolDefs({ opSchema: loadOpSchema(), sender: async () => ({}) });
const sub = defs.find((d) => d.name === "subscribe")!;

const hostValidate = (params: unknown): { ok: boolean; errors: string } => {
  const ajv = new Ajv2020({ coerceTypes: true, allowUnionTypes: true, strict: false, allErrors: true });
  const v = ajv.compile(sub.parameters);
  return { ok: v(params) as boolean, errors: JSON.stringify(v.errors ?? []) };
};

describe("票 119：注册面放宽 + D1a 接管", () => {
  it("host AJV 放行根级拍平帧（on/once 在根级）——不再产 schema is false / additional properties", () => {
    const r = hostValidate({ check: "echo ok", on: "passed", once: true });
    expect(r.ok).toBe(true);
  });

  it("host AJV 放行字符串化 schedule（coerce 面收宽）", () => {
    const r = hostValidate({ check: "echo ok", opts: { once: "true" } });
    expect(r.ok).toBe(true);
  });

  it("D1a 层拒绝拍平帧且文案带允许列表（execute 路径）", async () => {
    const r = await sub.execute("t1", { check: "echo ok", on: "passed", once: true }, undefined, undefined, undefined);
    const text = JSON.stringify(r.content);
    expect(text).toContain("不允许的字段");
    expect(text).toContain("opts");
    expect(text).not.toContain("schema is false");
  });

  it("正确形态仍通过 D1a（check + opts.on/once）", async () => {
    const r = await sub.execute("t1", { check: "echo ok", opts: { on: "passed", once: true } }, undefined, undefined, undefined);
    expect(JSON.stringify(r.content)).not.toContain("参数校验失败");
  });
});

describe("票 119：D1a 类型提示——字符串化标量给纠正动作", () => {
  it("opts.once 传 \"true\" → 文案含「去掉引号」", async () => {
    const r = await sub.execute("t1", { check: "echo ok", opts: { once: "true" } }, undefined, undefined, undefined);
    expect(JSON.stringify(r.content)).toContain("去掉引号");
  });
});
