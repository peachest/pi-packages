/**
 * Ticket 33 acceptance tests — instantiate（Profile→实体创建参数）+ 链 B 复用
 * （instantiate 产出经 kernel 可 register/subscribe/transition）。
 * B 层：组合根接线同 profiles-registry.test.ts（eda-profiles-deps）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as daemon from "../index.ts";

const { ProfileRegistry } = daemon.profiles;
const { validateValue } = daemon.protocol;
const { Kernel } = daemon.kernel;
const { createMemoryStore } = daemon.store;

const SCHEMA: object = JSON.parse(
  readFileSync(new URL("../schemas/profile.schema.json", import.meta.url), "utf8"),
);

const makeRegistry = () => new ProfileRegistry({ validate: validateValue, schema: SCHEMA });

const gitlabDef = {
  id: "gl-fixture",
  entityType: "gitlab:mr",
  version: 1,
  states: ["passed", "failed", "waiting"],
  transitions: [
    { from: "waiting", to: "passed" },
    { from: "waiting", to: "failed" },
    { from: "passed", to: "failed" },
    { from: "failed", to: "passed" },
  ],
  payloadSchema: { type: "object" },
  keyGenerator: { kind: "url", param: "url" },
  schedule: { type: "interval", every: "60s" },
  onTransition: [],
  templates: [
    {
      name: "mr",
      entityType: "gitlab:mr",
      check: "glab api --host {host} projects/{project}/merge_requests/{mr_iid}",
      params: { host: "GitLab host", project: "项目 id", mr_iid: "mr 序号" },
      usage: "mr 判定",
    },
    {
      name: "ci",
      entityType: "gitlab:pipeline",
      check: "glab api --host {host} projects/{project}/pipelines/{pipeline_id}",
      params: { host: "GitLab host", project: "项目 id", pipeline_id: "pipeline id" },
      usage: "ci 判定",
      schedule: { type: "cron", expr: "*/5 * * * *" },
    },
  ],
  stateMigrations: {},
};

const at = (n: number) => `2026-01-01T00:00:${String(n).padStart(2, "0")}Z`;

describe("组 1：instantiate 三类静态错误（错误一律列可用选项）", () => {
  it("profile 未找到 → 列可用 profile", () => {
    const reg = makeRegistry();
    reg.load(gitlabDef);
    const r = reg.instantiate("nope", "mr", {});
    expect(r).toMatchObject({ ok: false, error: "profile-not-found" });
    if (!r.ok) expect(r.reason).toContain("gl-fixture");
  });

  it("template 未找到 → 列可用模板", () => {
    const reg = makeRegistry();
    reg.load(gitlabDef);
    const r = reg.instantiate("gl-fixture", "ticket", {});
    expect(r).toMatchObject({ ok: false, error: "template-not-found" });
    if (!r.ok) expect(r.reason).toContain("mr");
  });

  it("缺必填参数 → invalid-params 列缺失名", () => {
    const reg = makeRegistry();
    reg.load(gitlabDef);
    const r = reg.instantiate("gl-fixture", "mr", { host: "gitlab.a.com" });
    expect(r).toMatchObject({ ok: false, error: "invalid-params" });
    if (!r.ok) expect(r.reason).toContain("project");
  });
});

describe("组 2：instantiate 成功路——keyGenerator 产出 EntityRef + check 代入 + schedule 换算", () => {
  it("url kind：URL 规范化 → external/<host><path>；{param} 代入 check；模板 schedule 覆盖换算", () => {
    const reg = makeRegistry();
    reg.load(gitlabDef);
    const r = reg.instantiate("gl-fixture", "mr", {
      host: "gitlab.a.com",
      project: "grp%2Fproj",
      mr_iid: "42",
      url: "https://gitlab.a.com/grp/proj/-/merge_requests/42",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entityRef).toEqual({ type: "gitlab:mr", key: "external/gitlab.a.com/grp/proj/-/merge_requests/42" });
      expect(r.check).toBe("glab api --host 'gitlab.a.com' projects/'grp%2Fproj'/merge_requests/'42'");
      expect(r.schedule).toEqual({ type: "interval", intervalMs: 60_000 });
    }
  });

  it("模板 schedule 覆盖 → cron 换算（expr→kernel cron 形）", () => {
    const reg = makeRegistry();
    reg.load(gitlabDef);
    const r = reg.instantiate("gl-fixture", "ci", {
      host: "gitlab.a.com",
      project: "p",
      pipeline_id: "7",
      url: "https://gitlab.a.com/g/p/-/pipelines/7",
    });
    if (r.ok) expect(r.schedule).toEqual({ type: "cron", cron: "*/5 * * * *" });
    else throw new Error("expected ok");
  });

  it("keyGenerator kinds：path / fields / 未知 kind", () => {
    const reg = makeRegistry();
    reg.load(gitlabDef);
    reg.load({
      ...gitlabDef,
      id: "multi-kind",
      entityType: "fixture:x",
      keyGenerator: { kind: "path", param: "path" },
      templates: [{ name: "t", check: "c", params: { path: "p" }, usage: "u" }],
    });
    reg.load({
      ...gitlabDef,
      id: "fields-kind",
      entityType: "fixture:k8s",
      keyGenerator: { kind: "fields", fields: ["namespace", "pod"] },
      templates: [{ name: "t", check: "c", params: { namespace: "n", pod: "p" }, usage: "u" }],
    });
    const byPath = reg.instantiate("multi-kind", "t", { path: "/data/msgs" });
    if (byPath.ok) expect(byPath.entityRef).toEqual({ type: "fixture:x", key: "external//data/msgs" });
    else throw new Error("expected ok");
    const byFields = reg.instantiate("fields-kind", "t", { namespace: "ns1", pod: "api-0" });
    if (byFields.ok) expect(byFields.entityRef).toEqual({ type: "fixture:k8s", key: "external/ns1/api-0" });
    else throw new Error("expected ok");

    reg.load({
      ...gitlabDef,
      id: "bad-kind",
      entityType: "fixture:bad",
      keyGenerator: { kind: "wat" },
      templates: [{ name: "t", check: "c", params: {}, usage: "u" }],
    });
    expect(reg.instantiate("bad-kind", "t", {})).toMatchObject({ ok: false, error: "invalid-params" });
  });
});

describe("组 3：链 B 复用——instantiate 产出经 kernel 可 register/subscribe/transition", () => {
  it("注册→订阅（模板形态，schedule 出自模板资产）→ 判定推进出事件", () => {
    const reg = makeRegistry();
    reg.load(gitlabDef);
    const inst = reg.instantiate("gl-fixture", "mr", {
      host: "gitlab.a.com",
      project: "grp%2Fproj",
      mr_iid: "42",
      url: "https://gitlab.a.com/grp/proj/-/merge_requests/42",
    });
    if (!inst.ok) throw new Error(inst.reason);

    const store = createMemoryStore();
    const kernel = new Kernel(store, reg.states(), 0);
    const regResult = kernel.register({ entityRef: inst.entityRef, profileId: inst.profileId, state: null });
    expect(regResult.created).toBe(true);

    const sub = kernel.subscribe({
      sessionId: "s1",
      entityRef: inst.entityRef,
      template: inst.template,
      check: inst.check,
      now: 1_000,
      opts: { schedule: inst.schedule },
    });
    expect(sub).toMatchObject({ subscribed: true, entityRef: inst.entityRef });

    const t = kernel.transition(inst.entityRef, "failed", at(1));
    expect(t).toMatchObject({ from: null, to: "failed", eventSeq: 1 });
    const rows = store.outboxBatch(Number.MAX_SAFE_INTEGER);
    expect(rows).toHaveLength(1);
    expect(store.getEntity(inst.entityRef.type, inst.entityRef.key)?.state).toBe("failed");
  });
});

describe("组 4：评审回归——check 代入 shell 安全（票 31-33 ocr findings）", () => {
  /** 仿内置 fs-watermark df-free：bare 词位置参数 + awk 程序体字面花括号。 */
  const shellFixture = {
    ...gitlabDef,
    id: "shell-fixture",
    entityType: "fixture:shell",
    keyGenerator: { kind: "path", param: "path" },
    templates: [
      {
        name: "df-free",
        check: "df -Pk {path} | tail -1 | awk -v t={threshold_kb} '{exit ($4 < t) ? 2 : 0}'",
        params: { path: "被监视目录", threshold_kb: "水位下限" },
        usage: "u",
      },
      {
        name: "literal-braces",
        check: "awk '{print}' {path}",
        params: { path: "路径" },
        usage: "u",
      },
    ],
    stateMigrations: {},
  };

  it("评审 F1(high)：参数值 POSIX 单引号包裹——命令替换/分号/空格不逃逸不裂参（值内 ' 转义为 '\\''）", () => {
    const reg = makeRegistry();
    reg.load(shellFixture);
    const r = reg.instantiate("shell-fixture", "df-free", {
      path: "/tmp/$(touch /tmp/pwned); rm -rf /",
      threshold_kb: "1024",
    });
    if (!r.ok) throw new Error(r.reason);
    expect(r.check).toBe(
      "df -Pk '/tmp/$(touch /tmp/pwned); rm -rf /' | tail -1 | awk -v t='1024' '{exit ($4 < t) ? 2 : 0}'",
    );
    const q = reg.instantiate("shell-fixture", "df-free", { path: "/tmp/it's", threshold_kb: "1" });
    if (!q.ok) throw new Error(q.reason);
    expect(q.check).toContain("'/tmp/it'\\''s'");
  });

  it("评审 F3(med)：代入仅限模板声明参数——caller 多余键不替换字面花括号（awk '{print}' 原样保留）", () => {
    const reg = makeRegistry();
    reg.load(shellFixture);
    const r = reg.instantiate("shell-fixture", "literal-braces", { path: "/data", print: "evil" });
    if (!r.ok) throw new Error(r.reason);
    expect(r.check).toBe("awk '{print}' '/data'");
  });
});
