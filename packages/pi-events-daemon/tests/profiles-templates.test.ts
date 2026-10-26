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

describe("票 121：validate 三态启发式文案与 prober 正典对齐（0=passed/2=failed/其他=waiting）", () => {
  it("无显式 exit warning 不得写反三态（f255465 文案 bug 回归门）", () => {
    const reg = loadBuiltin();
    const clean = reg.validate({ profile: "k8s-pod", check: "kubectl get pod x -n ns" });
    const w = clean.ok ? clean.warnings.join(" ") : "";
    expect(w).toContain("0=passed / 2=failed / 其他=waiting");
    expect(w).not.toContain("2=waiting");
  });
});

describe("票 137（scan-A）：gitlab-pipeline ci 模板三态 case 映射——failed 不再判 passed", () => {
  const loadCi = () => {
    const d = JSON.parse(readFileSync(new URL("../templates/gitlab-pipeline.json", import.meta.url), "utf8"));
    return d.templates.find((t: { name: string }) => t.name === "ci")!;
  };
  it("check 含 status→退出码 case 映射（success→0 / failed,canceled→2 / 其他→1）", () => {
    const check = loadCi().check as string;
    expect(check).toContain("case");
    expect(check).toContain("success");
    expect(check).toContain("failed");
    expect(check).toContain("canceled");
    // failed/canceled 分支必须 exit 2（failed 断言沿），success 分支 exit 0（顺序无关结构断言）
    expect(check).toContain("success) echo pipeline-success; exit 0");
    expect(check).toContain("failed|canceled) echo pipeline-$st; exit 2");
  });
  it("fs-watermark 模板 check 同样不含裸 jq 管道（jq 恒 exit 0 语义缺陷族）", () => {
    const d = JSON.parse(readFileSync(new URL("../templates/fs-watermark.json", import.meta.url), "utf8"));
    for (const t of d.templates) {
      // 裸 `| jq` 管道结尾 = jq exit 0 语义（除非有 case/exit 映射）
      if ((t.check as string).includes("| jq")) {
        expect(t.check as string).toMatch(/case|exit [12]/);
      }
    }
  });
});

describe("票 138（移植）：URL-encode × 三态 case 合流——bb43876 与票 137 双修复并集", () => {
  const load = (name: string): { check: string; params: Record<string, string> } => {
    const d = JSON.parse(readFileSync(new URL("../templates/gitlab-pipeline.json", import.meta.url), "utf8"));
    return d.templates.find((t: { name: string }) => t.name === name)!;
  };
  it("三域 check 同时含 @uri 编码（gitblue 裸斜杠 404 修复）与 case 三态映射（票 137）", () => {
    for (const name of ["ci", "mr", "ticket"]) {
      const t = load(name);
      expect(t.check, `${name} @uri`).toContain("$p|@uri");
      expect(t.check, `${name} case`).toContain("case");
      expect(t.check, `${name} exit 2 或 exit 0 终态`).toMatch(/exit [02]/);
    }
  });
  it("ci check 端到端形状：encoded project + status case 映射（双层修复不可拆）", () => {
    const ci = load("ci");
    expect(ci.check).toContain("success) echo pipeline-success; exit 0");
    expect(ci.check).toContain("failed|canceled) echo pipeline-$st; exit 2");
    expect(ci.check).toContain("jq -rn --arg p '{project}'");
  });
});
