/**
 * 票 40 ocr 评审修复 — op dispatch 接线语义缺陷群回归（F1/F2/F4/F5/F6/F7/F11/F12/F13）。
 * A 层：fx 全 fake + MemoryStore + startLoops + ProfileRegistry fixture + Prober（同 FakeExec）。
 * dispatch 帧 = OpRequestFrame 直调（transport 序列化层不在本集）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as daemon from "../index.ts";

const { createOpDispatch } = daemon.daemonMain;

const { createMemoryStore } = daemon.store;
const { FakeClock, FakeExec, FakeFs, FakePusher } = daemon.fx;
const { entityRefKeyOf } = daemon.domain;
const { ProfileRegistry } = daemon.profiles;
const { Prober } = daemon.prober;
const { startLoops } = daemon.loops;
const { validateValue } = daemon.protocol;

type MiniSchema = daemon.protocol.MiniSchema;
// I5 槽键形状（domain/intent runnerSlotKey）：slot:<type>:<key>#<template>——不经根入口导出，测试按形状字面构造
const slotKeyOf = (ref: { type: string; key: string }, template: string): string => `slot:${ref.type}:${ref.key}#${template}`;

const SCHEMA: object = JSON.parse(readFileSync(new URL("../schemas/profile.schema.json", import.meta.url), "utf8"));
/** op.schema.json 的 validateReport 定义节点（$ref 目标；F6 验收面 = smoke 响应过 op.schema）。 */
const VALIDATE_REPORT_SCHEMA = (
  JSON.parse(readFileSync(new URL("../schemas/op.schema.json", import.meta.url), "utf8")) as {
    definitions: Record<string, MiniSchema>;
  }
).definitions.validateReport!;

/** URL 路由 fixture：模板携带 urlPattern（票 32 路由面）。 */
const URL_DEF = {
  id: "gl-fixture",
  entityType: "gitlab:mr",
  version: 1,
  states: ["passed", "failed", "waiting"],
  transitions: [
    { from: "waiting", to: "passed" },
    { from: "waiting", to: "failed" },
    { from: "passed", to: "failed" },
    { from: "failed", to: "passed" },
    { from: "passed", to: "passed" },
  ],
  payloadSchema: { type: "object" },
  keyGenerator: { kind: "url", param: "url" },
  schedule: { type: "interval", every: "60s" },
  onTransition: [],
  templates: [
    {
      name: "mr",
      check: "glab mr status",
      params: {},
      usage: "mr 判定",
      urlPattern: "merge_requests/\\d+",
      host: "gl.a.com",
    },
  ],
  stateMigrations: {},
};

interface Rig {
  store: ReturnType<typeof createMemoryStore>;
  exec: InstanceType<typeof FakeExec>;
  loops: daemon.loops.LoopsHandle;
  dispatch: ReturnType<typeof createOpDispatch>;
}

const makeRig = (): Rig => {
  const store = createMemoryStore();
  const exec = new FakeExec();
  const clock = new FakeClock();
  const registry = new ProfileRegistry({ validate: validateValue, schema: SCHEMA });
  registry.load(URL_DEF);
  const loops = startLoops({
    clock,
    exec,
    pusher: new FakePusher(),
    fs: new FakeFs(),
    store,
    states: registry.states(),
    registry: registry.entries(),
  });
  const prober = new Prober({ exec, clock, onResult: () => undefined }); // runOnce 专用（组合根同构）
  const dispatch = createOpDispatch({ loops, store, registry, clock, prober });
  return { store, exec, loops, dispatch };
};

const frame = (op: string, params: Record<string, unknown>) =>
  ({ kind: "op-request", id: 1, op, params }) as Parameters<ReturnType<typeof createOpDispatch>>[0];

describe("票 40 评审 F1 — 变更类只经 L0：stopped 后 dispatch 拒绝", () => {
  it("loops.stop() 后 status/register（subscribe 路径）→ 拒绝（stopped），无绕过队列的活写路径", async () => {
    const rig = makeRig();
    rig.loops.stop();
    await expect(
      rig.dispatch(frame("status", { type: "fixture:widget", key: "external/1", state: "waiting" })),
    ).rejects.toThrow(/loops stopped/);
    await expect(rig.dispatch(frame("subscribe", { check: "exit 0" }))).rejects.toThrow(/loops stopped/);
    expect(rig.store.queryEntities({})).toHaveLength(0); // 无绕过写者产生的实体
  });
});

describe("票 40 评审 F2 — status register+首转换同事务", () => {
  it("无效 state：拒绝且无残留实体（半注册收口）", async () => {
    const rig = makeRig();
    await expect(
      rig.dispatch(frame("status", { type: "fixture:widget", key: "external/1", state: "bogus" })),
    ).rejects.toThrow(/outside profile closed set/);
    expect(rig.store.getEntity("fixture:widget", "external/1")).toBeUndefined();
    expect(rig.store.outboxBatch(10)).toHaveLength(0);
  });

  it("合法 state：登记 + 首转换一请求落账（事件随响应携回）", async () => {
    const rig = makeRig();
    const r = (await rig.dispatch(
      frame("status", { type: "fixture:widget", key: "external/1", state: "waiting", payload: { a: 1 } }),
    )) as { entityRef: string; state: string | null; event?: { from: string | null; to: string } };
    expect(r.entityRef).toBe("fixture:widget:external/1");
    expect(r.state).toBe("waiting");
    expect(r.event).toMatchObject({ from: null, to: "waiting" });
    expect(rig.store.getEntity("fixture:widget", "external/1")).toMatchObject({ state: "waiting", profileId: "" });
  });
});

describe("票 40 评审 F4 — URL 订阅模板名回填（槽身份不裂）", () => {
  it("URL 订阅与显式同名模板订阅共享槽（I5）：订阅行 template 一致、probe_spec 单槽", async () => {
    const rig = makeRig();
    const url = "https://gl.a.com/merge_requests/42";
    const viaUrl = (await rig.dispatch(frame("subscribe", { url, opts: { sessionId: "s1" } }))) as {
      subscribed: boolean;
      entityRef: string;
    };
    expect(viaUrl.subscribed).toBe(true);
    const ref = { type: "gitlab:mr", key: viaUrl.entityRef.slice("gitlab:mr:".length) };
    const explicit = (await rig.dispatch(
      frame("subscribe", {
        entityRef: viaUrl.entityRef,
        check: "glab mr status",
        opts: { sessionId: "s2", template: "mr" },
      }),
    )) as { subscribed: boolean };
    expect(explicit.subscribed).toBe(true);
    // 修复前：URL 订阅存 'adhoc' → 同 URL 显式 'mr' 订阅裂到另一槽
    const rows = rig.store.querySubscriptions({ entityRefType: ref.type, entityRefKey: ref.key });
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.template).toBe("mr");
    const slot = slotKeyOf(ref, "mr");
    expect(rig.store.getProbeSpec(slot)).toBeDefined();
  });
});

describe("票 40 评审 F5 — query scope/session 过滤落 kernel", () => {
  it("session/scope 过滤生效；非法 scope 明确拒绝", async () => {
    const rig = makeRig();
    await rig.dispatch(frame("status", { type: "fixture:widget", key: "external/1", state: "waiting" }));
    await rig.dispatch(frame("status", { type: "fixture:widget", key: "external/2", state: "waiting" }));
    rig.store.putSubscription({
      subscriptionId: "sub-1", sessionId: "s1", entityRefType: "fixture:widget", entityRefKey: "external/1",
      template: "adhoc", origin: "session", createdAt: 1,
    });
    rig.store.putSubscription({
      subscriptionId: "sub-2", sessionId: "s2", entityRefType: "fixture:widget", entityRefKey: "external/2",
      template: "adhoc", origin: "session", scope: "user", createdAt: 1,
    });
    const q1 = (await rig.dispatch(frame("query", { session: "s1" }))) as { entities: { entityRef: string }[] };
    expect(q1.entities.map((e) => e.entityRef)).toEqual(["fixture:widget:external/1"]);
    const q2 = (await rig.dispatch(frame("query", { scope: "user" }))) as { entities: { entityRef: string }[] };
    expect(q2.entities.map((e) => e.entityRef)).toEqual(["fixture:widget:external/2"]);
    expect(() => rig.dispatch(frame("query", { scope: "tenant" }))).toThrow(/scope/);
  });
});

describe("票 40 评审 F7 — wire type:key 拆分以 key 前缀锚定（native key 含冒号）", () => {
  it("fs:path + project/a:external/b 往返：status 登记 → subscribe 解析同 ref", async () => {
    const rig = makeRig();
    const r = (await rig.dispatch(
      frame("status", { type: "fs:path", key: "project/a:external/b", state: "waiting" }),
    )) as { entityRef: string };
    expect(r.entityRef).toBe("fs:path:project/a:external/b");
    // wire 单串再入：贪婪拆分会把 type 错切成 "fs:path:project/a"
    const sub = (await rig.dispatch(
      frame("subscribe", { entityRef: "fs:path:project/a:external/b", check: "exit 0" }),
    )) as { subscribed: boolean; entityRef: string };
    expect(sub.subscribed).toBe(true);
    expect(sub.entityRef).toBe("fs:path:project/a:external/b");
    const row = rig.store.querySubscriptions({ entityRefType: "fs:path", entityRefKey: "project/a:external/b" });
    expect(row).toHaveLength(1);
  });
});

describe("票 40 评审 F11 — ad-hoc 幂等哈希 canonical（键序不裂实体）", () => {
  it("同 check 同 schedule（键序异形）→ 同一 adhoc 实体；store 单实体", async () => {
    const rig = makeRig();
    const a = (await rig.dispatch(
      frame("subscribe", { check: "cond-a", opts: { schedule: { type: "interval", every: 60_000 } } }),
    )) as { subscribed: boolean; entityRef: string };
    const b = (await rig.dispatch(
      frame("subscribe", { check: "cond-a", opts: { schedule: { every: 60_000, type: "interval" } } }),
    )) as { subscribed: boolean; entityRef: string };
    expect(a.subscribed).toBe(true);
    expect(b.entityRef).toBe(a.entityRef);
    expect(a.entityRef).toMatch(/^adhoc:/);
    expect(rig.store.queryEntities({})).toHaveLength(1);
  });
});

describe("票 40 评审 F6/F12 — validate 报告接真实静态语法校验（ValidateReport wire 契约）", () => {
  it("语法通过 + live-run 通过 → syntaxOk:true 全字段报告（smoke/validate 同形过 op.schema）", async () => {
    const rig = makeRig();
    rig.exec.enqueue({ exitCode: 0 }); // sh -n 语法检查
    rig.exec.enqueue({ exitCode: 0, stdout: "ok" }); // live-run
    const r = (await rig.dispatch(frame("validate", { check: "echo validate-ok" }))) as Record<string, unknown>;
    expect(r).toEqual({
      syntaxOk: true,
      verdict: "passed",
      reason: "exit 0",
      evidence: "ok",
      durationMs: expect.any(Number),
      warnings: [],
    });
    expect(rig.exec.calls[0]!.command).toContain("sh -n"); // 静态语法校验真实发生
    expect(validateValue(VALIDATE_REPORT_SCHEMA, r)).toEqual([]); // validate op 响应同过 op.schema
  });

  it("语法损坏 → syntaxOk:false + waiting，不执行 live-run（坏 checker 不落执行）", async () => {
    const rig = makeRig();
    rig.exec.enqueue({ exitCode: 2, stderr: "sh: 1: Syntax error" });
    const r = (await rig.dispatch(frame("validate", { check: "then fi ( broken" }))) as Record<string, unknown>;
    expect(r).toMatchObject({ syntaxOk: false, verdict: "waiting" });
    expect(String(r.reason)).toContain("syntax error");
    expect(rig.exec.calls).toHaveLength(1); // 只有语法检查，无 live-run
  });

  it("subscribe smoke 失败响应 {subscribed:false, validate} 携全字段 ValidateReport", async () => {
    const rig = makeRig();
    rig.exec.enqueue({ exitCode: 0 }); // 语法检查通过
    rig.exec.enqueue({ exitCode: 2 }); // smoke live-run failed
    const r = (await rig.dispatch(
      frame("subscribe", { check: "exit 2", opts: { smoke: true } }),
    )) as { subscribed: boolean; validate: Record<string, unknown> };
    expect(r.subscribed).toBe(false);
    expect(r.validate).toMatchObject({ syntaxOk: true, verdict: "failed", warnings: [] });
    // F6 验收口径：smoke 响应 validate 过 op.schema 的 validateReport 定义（required 全集 + 无多余键）
    expect(validateValue(VALIDATE_REPORT_SCHEMA, r.validate)).toEqual([]);
  });
});

describe("票 44 — query wire 订阅行明细", () => {
  it("query 响应携带 subscriptions（entityRef 单串 + ISO 时间戳 + thresholds/schedule 透传）", async () => {
    const rig = makeRig();
    await rig.dispatch(frame("status", { type: "fixture:widget", key: "external/1", state: "waiting" }));
    rig.store.putSubscription({
      subscriptionId: "sub-1", sessionId: "s1", entityRefType: "fixture:widget", entityRefKey: "external/1",
      template: "mr", origin: "session", check: "glab mr status", on: ["failed"],
      thresholds: { failureThreshold: 2, successThreshold: 1 }, phase: "flip", createdAt: 0,
    });
    rig.store.putProbeSpec({ slotKey: slotKeyOf({ type: "fixture:widget", key: "external/1" }, "mr"), check: "true", schedule: { type: "interval", intervalMs: 60_000 }, source: "poll" });
    const q = (await rig.dispatch(frame("query", { session: "s1" }))) as { subscriptions: Record<string, unknown>[] };
    expect(q.subscriptions).toEqual([
      {
        subscriptionId: "sub-1",
        sessionId: "s1",
        entityRef: "fixture:widget:external/1",
        state: "waiting",
        origin: "session",
        template: "mr",
        check: "glab mr status",
        on: ["failed"],
        thresholds: { failureThreshold: 2, successThreshold: 1 },
        phase: "flip",
        schedule: { type: "interval", intervalMs: 60_000 },
        backlog: 0,
        createdAt: "1970-01-01T00:00:00.000Z",
      },
    ]);
  });
});
