/** 票 50（用户反馈）：工具注册面瘦身——definitions 闭包内联，平均 <200 tok。 */
import { describe, expect, it } from "vitest";
import { buildToolDefs, loadOpSchema } from "../index.ts";

describe("工具注册面：definitions 闭包内联（#50）", () => {
  const defs = buildToolDefs({ opSchema: loadOpSchema(), sender: async () => ({}) });

  it("只内联 $ref 闭包定义——response 侧定义不进工具面", () => {
    const sub = defs.find((d) => d.name === "subscribe")!;
    const names = Object.keys((sub.parameters as { definitions?: Record<string, unknown> }).definitions ?? {});
    expect(names).toContain("entityRef");
    expect(names).toContain("adhocSchedule");
    expect(names).not.toContain("queryEntity"); // response 侧
    expect(names).not.toContain("templateInfo");
    const ev = defs.find((d) => d.name === "evidence")!;
    expect((ev.parameters as { definitions?: unknown }).definitions ?? {}).toEqual({});
  });

  it("平均注册体积 <200 tok（≈3.5 chars/tok 粗估）", () => {
    const total = defs.reduce((n, d) => n + JSON.stringify(d.parameters).length, 0) / 3.5;
    expect(total / defs.length).toBeLessThan(200);
  });

  it("校验不回归：闭包内联后 D1a 仍拒绝非法 entityRef（validateFull 走完整 opSchema）", async () => {
    const pub = defs.find((d) => d.name === "publish")!;
    const r = await pub.execute("t1", { entityRef: "bad-shape", transition: { to: "x" } });
    expect(JSON.stringify(r.content)).toContain("参数校验失败");
  });
});
