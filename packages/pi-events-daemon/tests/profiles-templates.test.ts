/**
 * Ticket 33 acceptance tests — 内置三模板数据完整（checker 声明/参数模板/文档段）
 * + validate 静态面三类错误与 ADR 0004 warning 经注册表数据驱动（kernel 零 profile import）。
 * 资产 = packages/pi-events-daemon/templates/*.json（与 schemas/ 同级随包发版）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import * as daemon from "../index.ts";

const { ProfileRegistry } = daemon.profiles;
const { validateValue } = daemon.protocol;
const { Kernel } = daemon.kernel;
const { createMemoryStore } = daemon.store;

const SCHEMA: object = JSON.parse(
  readFileSync(new URL("../schemas/profile.schema.json", import.meta.url), "utf8"),
);

/** 装载全部内置模板资产（templates/*.json，与 schemas/ 同级随包发版）。 */
const loadBuiltin = () => {
  const reg = new ProfileRegistry({ validate: validateValue, schema: SCHEMA });
  const dir = new URL("../templates/", import.meta.url);
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
    reg.load(JSON.parse(readFileSync(new URL(`../templates/${f}`, import.meta.url), "utf8")));
  }
  return reg;
};

describe("组 1：内置三模板资产——schema 合法 + 数据完整（checker 声明/参数模板/文档段）", () => {
  it("gitlab-pipeline / k8s-pod / fs-watermark 全部通过 Profile schema 校验并载入", () => {
    const reg = loadBuiltin();
    expect(reg.profiles().map((p) => p.id).sort()).toEqual(["fs-watermark", "gitlab-pipeline", "k8s-pod"]);
  });

  it("每模板自包含：check 非空（checker 声明）/ params 非空（参数模板）/ usage 非空（文档段）", () => {
    const reg = loadBuiltin();
    for (const def of reg.profiles()) {
      expect(def.templates.length).toBeGreaterThanOrEqual(1);
      for (const tpl of def.templates) {
        expect(tpl.check.trim(), `${def.id}/${tpl.name} check`).not.toBe("");
        expect(Object.keys(tpl.params).length, `${def.id}/${tpl.name} params`).toBeGreaterThan(0);
        expect(tpl.usage.trim(), `${def.id}/${tpl.name} usage`).not.toBe("");
      }
    }
  });

  it("gitlab-pipeline 三域模板：mr/ci/ticket 各自 EntityRef.type（票 42：templates 静态面经 ProfileRegistry.templates）", () => {
    const reg = loadBuiltin();
    const { templates } = reg.templates("gitlab-pipeline");
    expect(templates.map((t) => [t.name, t.entityType]).sort()).toEqual([
      ["ci", "gitlab:pipeline"],
      ["mr", "gitlab:mr"],
      ["ticket", "gitlab:ticket"],
    ]);
  });
});

describe("组 2：validate 静态面——三类错误数据 + ADR 0004 warning 全部来自注册表注入（票 42 经 ProfileRegistry.validate）", () => {
  const regWithEntries = () => loadBuiltin();

  it("profile 未找到（列可用）/ 模板缺参数（invalid-params）/ ad-hoc 缺 check（checker-declaration）", () => {
    const reg = regWithEntries();
    expect(reg.validate({ profile: "nope" })).toMatchObject({ ok: false, error: "profile-not-found" });
    expect(reg.validate({ profile: "k8s-pod", template: "pod-ready", params: {} })).toMatchObject({
      ok: false,
      error: "invalid-params",
    });
    expect(reg.validate({ profile: "k8s-pod" })).toMatchObject({ ok: false, error: "checker-declaration" });
  });

  it("sideEffectPatterns 命中 → warning 不阻断（ADR 0004 checks-are-probes）；干净 check 零 warning", () => {
    const reg = regWithEntries();
    const hit = reg.validate({ profile: "k8s-pod", check: "kubectl delete pod x" });
    expect(hit).toMatchObject({ ok: true });
    if (hit.ok) expect(hit.warnings.join(" ")).toContain("kubectl delete");
    const clean = reg.validate({ profile: "k8s-pod", check: "kubectl get pod x -n ns" });
    // 无显式 exit → 语义启发式 warning（新增行为：三态语义提醒）
    expect(clean).toEqual({ ok: true, warnings: [expect.stringContaining("exit")] });
  });
});
