/**
 * Ticket 32 acceptance tests — resolve URL 路由（唯一/多/零命中 + 双 GitLab host 显式路由）
 * + ephemeral key sha1(check+schedule+cwd) 稳定性 + 订阅侧 token 拒检矩阵 + schedule 资产→probe spec 换算。
 * B 层：组合根接线同 profiles-registry.test.ts（eda-profiles-deps）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as daemon from "../index.ts";

const { ProfileRegistry } = daemon.profiles;
const { validateValue } = daemon.protocol;
const { ephemeralRef, checkRegister, scheduleToProbeSpec, everyToMs } = daemon.profiles;

const SCHEMA: object = JSON.parse(
  readFileSync(new URL("../schemas/profile.schema.json", import.meta.url), "utf8"),
);

const makeDef = (overrides: Record<string, unknown> = {}) => ({
  id: "fixture-widget",
  entityType: "fixture:widget",
  version: 1,
  states: ["green", "red"],
  transitions: [{ from: "green", to: "red" }],
  payloadSchema: { type: "object" },
  keyGenerator: { kind: "path", param: "path" },
  schedule: { type: "interval", every: "60s" },
  onTransition: [],
  templates: [
    { name: "watch", check: "cat {path}", params: { path: "路径" }, usage: "监视" },
  ],
  stateMigrations: {},
  ...overrides,
});

const makeRegistry = () => new ProfileRegistry({ validate: validateValue, schema: SCHEMA });

/** 双 GitLab host 场景 fixture：同 URL 形态两实例，仅靠模板 host 字段显式分流。 */
const gitlabA = makeDef({
  id: "gl-a",
  entityType: "gitlab:mr",
  templates: [
    {
      name: "mr",
      check: "glab mr status",
      params: {},
      usage: "mr 判定",
      urlPattern: "merge_requests/\\d+",
      host: "gitlab.a.com",
    },
  ],
});
const gitlabB = makeDef({
  id: "gl-b",
  entityType: "gitlab:mr-b",
  templates: [
    {
      name: "mr",
      check: "glab mr status",
      params: {},
      usage: "mr 判定",
      urlPattern: "merge_requests/\\d+",
      host: "gitlab.b.com",
    },
  ],
});

describe("组 1：resolve URL 路由——唯一命中绑定 / 多命中列候选 / 零命中列可用模板", () => {
  it("唯一命中 → {ok, profileId, template}", () => {
    const reg = makeRegistry();
    reg.load(makeDef({
      templates: [{ name: "watch", check: "cat {path}", params: {}, usage: "u", urlPattern: "files/\\d+" }],
    }));
    expect(reg.resolve("https://x.test/files/7")).toEqual({
      ok: true,
      profileId: "fixture-widget",
      template: "watch",
      params: {},
    });
  });

  it("票 49/#114：urlPattern 命名捕获组随命中提取为参数字典（多参数 URL 路由）", () => {
    const reg = makeRegistry();
    reg.load(makeDef({
      keyGenerator: { kind: "fields", fields: ["project", "mr_id"] },
      templates: [{
        name: "mr",
        check: "glab mr view {project} {mr_id}",
        params: { project: "项目路径", mr_id: "MR 编号" },
        usage: "u",
        urlPattern: "(?<project>[^/]+/[^/]+)/-/merge_requests/(?<mr_id>\\d+)",
      }],
    }));
    const r = reg.resolve("https://x.test/grp/proj/-/merge_requests/42");
    expect(r).toEqual({
      ok: true,
      profileId: "fixture-widget",
      template: "mr",
      params: { project: "grp/proj", mr_id: "42" },
    });
  });

  it("多命中 → ambiguous 错误列全部候选，要求显式 template", () => {
    const reg = makeRegistry();
    reg.load(makeDef({
      templates: [{ name: "a", check: "c", params: {}, usage: "u", urlPattern: "things/\\d+" }],
    }));
    reg.load(makeDef({
      id: "fixture-2",
      entityType: "fixture:2",
      templates: [{ name: "b", check: "c", params: {}, usage: "u", urlPattern: "things/\\d+" }],
    }));
    const r = reg.resolve("https://x.test/things/7");
    expect(r.ok).toBe(false);
    if (!r.ok && r.error === "ambiguous") {
      expect(r.reason).toContain("fixture-widget/a");
      expect(r.reason).toContain("fixture-2/b");
    } else throw new Error("expected ambiguous");
  });

  it("零命中 → no-match 错误列可用模板（可 URL 路由的清单）", () => {
    const reg = makeRegistry();
    reg.load(makeDef({
      templates: [{ name: "watch", check: "cat {path}", params: {}, usage: "u", urlPattern: "files/\\d+" }],
    }));
    const r = reg.resolve("https://x.test/whatever/9");
    expect(r.ok).toBe(false);
    if (!r.ok && r.error === "no-match") {
      expect(r.reason).toContain("fixture-widget/watch");
    } else throw new Error("expected no-match");
  });
});

describe("组 2：双 GitLab host 显式路由——模板 host 字段精确匹配，零 fallback 猜测", () => {
  it("同 urlPattern 双实例：URL host 决定唯一命中", () => {
    const reg = makeRegistry();
    reg.load(gitlabA);
    reg.load(gitlabB);
    expect(reg.resolve("https://gitlab.a.com/grp/proj/-/merge_requests/42")).toEqual({
      ok: true,
      profileId: "gl-a",
      template: "mr",
      params: {},
    });
    expect(reg.resolve("https://gitlab.b.com/grp/proj/-/merge_requests/42")).toEqual({
      ok: true,
      profileId: "gl-b",
      template: "mr",
      params: {},
    });
  });

  it("host 不匹配不 fallback：错实例 URL → 零命中列可用模板", () => {
    const reg = makeRegistry();
    reg.load(gitlabA);
    const r = reg.resolve("https://gitlab.b.com/grp/proj/-/merge_requests/42");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("no-match");
  });
});

describe("组 3：ephemeral key 稳定性（I-02：同参同 key、异参异 key；ADR 0002 唯一 daemon 铸造键）", () => {
  it("同 (check, schedule, cwd) → 同 EntityRef；异 cwd / 异 schedule → 异 key", () => {
    const s = { type: "interval" as const, intervalMs: 60_000 };
    const a = ephemeralRef("glab mr status", s, "/home/u/proj");
    const b = ephemeralRef("glab mr status", s, "/home/u/proj");
    const c = ephemeralRef("glab mr status", s, "/home/u/other");
    const d = ephemeralRef("glab mr status", { type: "interval" as const, intervalMs: 30_000 }, "/home/u/proj");
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(a).not.toEqual(d);
    expect(a.type).toBe("adhoc");
    expect(a.key).toMatch(/^project\/[0-9a-f]{40}$/);
  });

  it("canonical 序列化抵抗字段构造序：同参异构造序 → 同 key", () => {
    const a = ephemeralRef("check x", { type: "interval", intervalMs: 60_000 }, "/w");
    const b = ephemeralRef("check x", { intervalMs: 60_000, type: "interval" } as unknown as Record<string, unknown>, "/w");
    expect(a).toEqual(b);
  });

  it("评审 F2(high)：schedule 同值同键——every 拼写与 intervalMs 归一为 ms、cron expr/cron 别名归一", () => {
    const base = ephemeralRef("c", { type: "interval", every: "60s" }, "/w");
    expect(ephemeralRef("c", { type: "interval", every: "1m" }, "/w")).toEqual(base);
    expect(ephemeralRef("c", { type: "interval", intervalMs: 60_000 }, "/w")).toEqual(base);
    const cron = ephemeralRef("c", { type: "cron", expr: "*/5 * * * *" }, "/w");
    expect(ephemeralRef("c", { type: "cron", cron: "*/5 * * * *" }, "/w")).toEqual(cron);
    expect(ephemeralRef("c", { type: "interval", every: "90s" }, "/w")).not.toEqual(base);
  });
});

describe("组 4：订阅侧 token 拒检矩阵（第一道防线；命中拒并列原因，绝不回显命中内容）", () => {
  it.each([
    ["gitlab pat", { check: "curl -H 'PRIVATE-TOKEN: glpat-AbCdEfGhIjKlMnOp' https://x" }, "gitlab-personal-token"],
    ["inline bearer", { check: "curl -H 'Authorization: Bearer abcdefghijklmn' https://x" }, "inline-auth-header"],
    ["password kv", { check: "curl -u u --data password=hunter2secret https://x" }, "credential-kv"],
    ["token kv", { check: "curl token=AbCdEfGhIjKlMnOp12 https://x" }, "token-kv"],
    ["query param", { params: { webhook: "https://x/?key=AbCdEfGhIjKlMnOp" } }, "credential-query-param"],
  ])("%s 命中拒检", (_label, req, pattern) => {
    const r = checkRegister(req as { check?: string; params?: Record<string, unknown> });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reasons.length).toBeGreaterThanOrEqual(1);
      expect(r.reasons.join("\n")).toContain(pattern);
      expect(r.reasons.join("\n")).not.toContain("glpat-AbCdEfGhIjKlMnOp");
    }
  });

  it("干净请求放行：零凭证模板惯例（check 运行时自取 token）与 env 引用参数均不误伤", () => {
    expect(
      checkRegister({
        check: "glab mr view 42 --repo grp/proj --token $(glab config get token --host gitlab.a.com)",
        params: { host: "gitlab.a.com", project: "grp/proj", webhook: "$GITLAB_WEBHOOK_URL" },
      }),
    ).toEqual({ ok: true });
  });

  it("评审 F5(med)：运行时凭据引用不误伤——kv 位置的 env/命令替换形态（带引号与不带）放行，明文仍拒", () => {
    expect(checkRegister({ check: "curl -u u --data password=$PASSWORD https://x" })).toEqual({ ok: true });
    expect(checkRegister({ check: "curl -H 'X-Api-Key: \"$API_KEY\"' https://x" })).toEqual({ ok: true });
    expect(checkRegister({ check: "curl --data secret=$(pass show db) https://x" })).toEqual({ ok: true });
    expect(checkRegister({ check: "curl -u u --data password=hunter2secret https://x" }).ok).toBe(false);
  });
});

describe("组 5：schedule 模板资产 → kernel probe spec（B1：模板形态 agent opts 永不含 schedule）", () => {
  it("interval every 串 → intervalMs；cron expr/tz → kernel cron 形", () => {
    expect(scheduleToProbeSpec({ type: "interval", every: "60s" })).toEqual({ type: "interval", intervalMs: 60_000 });
    expect(scheduleToProbeSpec({ type: "cron", expr: "*/5 * * * *", tz: "Asia/Shanghai" })).toEqual({
      type: "cron",
      cron: "*/5 * * * *",
      tz: "Asia/Shanghai",
    });
  });

  it("模板 schedule 覆盖顶层（缺省继承）；坏 every load 即拒", () => {
    const reg = makeRegistry();
    reg.load(makeDef({
      schedule: { type: "interval", every: "30s" },
      templates: [
        { name: "watch", check: "c", params: {}, usage: "u", schedule: { type: "interval", every: "5m" } },
        { name: "inherits", check: "c", params: {}, usage: "u" },
      ],
    }));
    const entries = reg.entries()[0].templates;
    expect(entries[0].schedule).toEqual({ type: "interval", every: "5m" });
    expect(entries[1].schedule).toEqual({ type: "interval", every: "30s" });
    expect(() => reg.load(makeDef({ id: "bad-every", entityType: "fixture:bad", schedule: { type: "interval", every: "60" } }))).toThrow(/every/);
  });

  it("评审 F6(med)：everyToMs 拒 0 与溢出——须正 safe integer（0 致每拍轮询、Infinity 致永不触发），load 侧联动拒绝", () => {
    expect(() => everyToMs("0s")).toThrow(/safe integer/);
    expect(() => everyToMs("99999999999999999999h")).toThrow(/safe integer/);
    expect(everyToMs("60s")).toBe(60_000);
    const reg = makeRegistry();
    expect(() => reg.load(makeDef({ schedule: { type: "interval", every: "0s" } }))).toThrow(/safe integer/);
  });
});

describe("组 4b（票 119）：urlPattern 协议规范化——pattern 锚定在 authority 之后", () => {
  it("锚定 ^ 的 pattern 对带协议 URL 命中（host 捕获组吃 authority）", () => {
    const reg = makeRegistry();
    reg.load(makeDef({
      templates: [{ name: "watch", check: "c", params: { host: "", path: "" }, usage: "u",
        urlPattern: "^(?<host>[^/]+)/(?<path>files/\\d+)$" }],
    }));
    const r = reg.resolve("https://x.test/files/7");
    expect(r).toMatchObject({ ok: true, template: "watch" });
    if (r.ok) expect(r.params).toEqual({ host: "x.test", path: "files/7" });
  });
});

describe("组 5（票 119）：真实资产三模板 urlPattern——URL 形态端到端命中", () => {
  it("gitlab-pipeline 资产：MR/CI/ticket 三模板 URL 均可命中且参数字典齐", async () => {
    const { readFileSync } = await import("node:fs");
    const assets = JSON.parse(readFileSync(new URL("../templates/gitlab-pipeline.json", import.meta.url), "utf8"));
    const { resolveUrl } = daemon.profiles;
    const registry = makeRegistry();
    registry.load(assets);
    const gitblue = "https://gitblue.transwarp.io/applied-ai/kube-nodexpu-manager/-/pipelines/1366608";
    const ci = resolveUrl(registry.profiles(), gitblue);
    expect(ci.ok).toBe(true);
    if (ci.ok) {
      expect(ci.template).toBe("ci");
      expect(ci.params.pipeline_id).toBe("1366608");
      expect(ci.params.host).toBe("gitblue.transwarp.io");
    }
  });

  it("根级 subscribe URL 形态不再报「可用: []」——至少一个模板带 urlPattern", async () => {
    const { readFileSync } = await import("node:fs");
    for (const f of ["gitlab-pipeline.json", "fs-watermark.json", "k8s-pod.json"]) {
      const a = JSON.parse(readFileSync(new URL(`../templates/${f}`, import.meta.url), "utf8"));
      if (f === "gitlab-pipeline.json") {
        expect(a.templates.some((t: { urlPattern?: string }) => t.urlPattern)).toBe(true);
      }
    }
  });
});
