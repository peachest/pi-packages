/**
 * Ticket 31 acceptance tests — ProfileRegistry.load（资产→Profile 定义）+ 冲突拒绝 + B7 迁移声明数据面。
 * B 层：schema 校验器（protocol D1a validateValue）与 Profile Schema 文档均经构造注入
 * （eda-profiles-deps：profiles 禁 import protocol——测试扮演组合根接线注入缝）。
 *
 * I-01 试金石前置：状态集与实体名全部是 fixture 数据；注入 kernel 后闭集校验走注册表值传递。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as daemon from "../index.ts";

// 组合根接线（eda-profiles-deps：profiles/ 目录含测试均只许经 kernel 类型面；store/protocol 经包根入口取）
const { ProfileRegistry } = daemon.profiles;
const { validateValue } = daemon.protocol;
const { Kernel } = daemon.kernel;
const { createMemoryStore } = daemon.store;

const SCHEMA: object = JSON.parse(
  readFileSync(new URL("../schemas/profile.schema.json", import.meta.url), "utf8"),
);

/** 合法 profile fixture（schemas/profile.schema.json 八项正典全量）。 */
const makeDef = (overrides: Record<string, unknown> = {}) => ({
  id: "fixture-widget",
  entityType: "fixture:widget",
  version: 1,
  states: ["green", "red"],
  transitions: [{ from: "green", to: "red" }, { from: "red", to: "green" }],
  payloadSchema: { type: "object" },
  keyGenerator: { kind: "path", param: "path" },
  schedule: { type: "interval", every: "60s" },
  onTransition: [],
  templates: [
    {
      name: "watch",
      check: "cat {path}",
      params: { path: "被监视文件路径" },
      usage: "监视文件判定器",
    },
  ],
  stateMigrations: {},
  ...overrides,
});

const makeRegistry = () => new ProfileRegistry({ validate: validateValue, schema: SCHEMA });

const REF = { type: "fixture:widget", key: "external/fixture-1" };
const at = (n: number) => `2026-01-01T00:00:${String(n).padStart(2, "0")}Z`;

describe("组 1：load 三路——合法 / 缺字段 / 坏 schema（schema 校验经 03 D1a 注入）", () => {
  it("合法定义 load → 返回 Profile 定义并注册（profiles()/get 可查）", () => {
    const reg = makeRegistry();
    const def = reg.load(makeDef());
    expect(def.id).toBe("fixture-widget");
    expect(def.entityType).toBe("fixture:widget");
    expect(reg.profiles()).toHaveLength(1);
    expect(reg.get("fixture-widget")?.states).toEqual(["green", "red"]);
    expect(reg.get("nope")).toBeUndefined();
  });

  it("缺字段（缺 payloadSchema）→ 拒绝并列缺失字段名", () => {
    const reg = makeRegistry();
    const { payloadSchema: _dropped, ...missing } = makeDef();
    expect(() => reg.load(missing)).toThrow(/payloadSchema/);
    expect(reg.profiles()).toHaveLength(0);
  });

  it("坏 schema（states 非数组 / version 非整数）→ 拒绝", () => {
    const reg = makeRegistry();
    expect(() => reg.load(makeDef({ states: "green" }))).toThrow(/profile load rejected/);
    expect(() => reg.load(makeDef({ version: "1" }))).toThrow(/profile load rejected/);
    expect(reg.profiles()).toHaveLength(0);
  });

  it("结构面（D1a 子集表达不了）：空 states / 转换表引用集外状态 / 坏 schedule → 拒绝", () => {
    const reg = makeRegistry();
    expect(() => reg.load(makeDef({ states: [] }))).toThrow(/states/);
    expect(() => reg.load(makeDef({ transitions: [{ from: "green", to: "blue" }] }))).toThrow(/blue/);
    expect(() => reg.load(makeDef({ schedule: { type: "interval" } }))).toThrow(/every/);
    expect(() => reg.load(makeDef({ schedule: { type: "wat", every: "60s" } }))).toThrow(/schedule/);
  });

  it("评审 F7(med)：模板 states 越闭集 → 拒载并列可用 states（kernel 侧会拒 'typo'，load 即拦）", () => {
    const reg = makeRegistry();
    expect(() =>
      reg.load(
        makeDef({
          templates: [
            { name: "watch", check: "cat {path}", params: { path: "p" }, usage: "u", states: ["green", "typo"] },
          ],
        }),
      ),
    ).toThrow(/typo.*green|green.*typo/);
    expect(reg.profiles()).toHaveLength(0);
  });

  it("cron 语义校验经注入解析器（validateCron）——坏表达式 load 即拒", () => {
    const reg = new ProfileRegistry({
      validate: validateValue,
      schema: SCHEMA,
      validateCron: (expr) => {
        if (expr === "not a cron") throw new Error("字段数不对");
        return 0;
      },
    });
    expect(() => reg.load(makeDef({ schedule: { type: "cron", expr: "not a cron" } }))).toThrow(/not a cron/);
    expect(reg.load(makeDef({ schedule: { type: "cron", expr: "*/5 * * * *" } })).schedule).toEqual({
      type: "cron",
      expr: "*/5 * * * *",
    });
  });
});

describe("组 2：冲突拒绝逐例——不静默覆盖（ddd-discover 裁定）", () => {
  it("同 id 同版本异内容 → 冲突拒绝", () => {
    const reg = makeRegistry();
    reg.load(makeDef());
    expect(() => reg.load(makeDef({ schedule: { type: "interval", every: "5s" } }))).toThrow(/冲突/);
    expect(reg.profiles()).toHaveLength(1);
  });

  it("同 id 同版本同内容 → 幂等（不重复注册）", () => {
    const reg = makeRegistry();
    reg.load(makeDef());
    reg.load(makeDef());
    expect(reg.profiles()).toHaveLength(1);
  });

  it("同 EntityRef 域（同 entityType）异 id → 冲突拒绝", () => {
    const reg = makeRegistry();
    reg.load(makeDef());
    expect(() => reg.load(makeDef({ id: "fixture-widget-2" }))).toThrow(/冲突.*fixture:widget/);
    expect(reg.profiles()).toHaveLength(1);
  });

  it("无冲突共存：不同 id 不同 entityType → 双双载入", () => {
    const reg = makeRegistry();
    reg.load(makeDef());
    reg.load(makeDef({ id: "fixture-other", entityType: "fixture:other" }));
    expect(reg.profiles()).toHaveLength(2);
  });

  it("版本降级 → 拒绝（单向升级）", () => {
    const reg = makeRegistry();
    reg.load(makeDef({ version: 2 }));
    expect(() => reg.load(makeDef({ version: 1 }))).toThrow(/版本/);
    expect(reg.get("fixture-widget")?.version).toBe(2);
  });
});

describe("组 3：I-01 状态集传值——注入 kernel 后闭集校验查注册表值", () => {
  it("states() = 并集；kernel 构造注入后 register 校验闭集、越界 state 拒绝", () => {
    const reg = makeRegistry();
    reg.load(makeDef());
    reg.load(
      makeDef({
        id: "fixture-other",
        entityType: "fixture:other",
        states: ["alpha", "beta"],
        transitions: [{ from: "alpha", to: "beta" }],
      }),
    );
    expect([...reg.states()].sort()).toEqual(["alpha", "beta", "green", "red"]);

    const kernel = new Kernel(createMemoryStore(), reg.states(), 0);
    expect(kernel.register({ entityRef: REF, profileId: "fixture-widget", state: "green" }).created).toBe(true);
    expect(() =>
      kernel.register({ entityRef: { type: "fixture:widget", key: "external/x" }, profileId: "fixture-widget", state: "purple" }),
    ).toThrow(/purple/);
  });

  it("entries() 形状 = kernel ProfileRegistryEntry（模板清单：name/entityType/states/params/usage/schedule）", () => {
    const reg = makeRegistry();
    reg.load(makeDef());
    expect(reg.entries()).toEqual([
      {
        profileId: "fixture-widget",
        templates: [
          {
            name: "watch",
            entityType: "fixture:widget",
            states: ["green", "red"],
            params: ["path"],
            schedule: { type: "interval", every: "60s" },
            usage: "监视文件判定器",
          },
        ],
        onTransition: [],
      },
    ]);
  });
});

describe("组 4：B7 状态改名迁移——迁移声明产出 + 无映射拒加载", () => {
  it("改名带映射 → load 通过且产出迁移声明（数据面，执行归 kernel.migrateState/loops）", () => {
    const reg = makeRegistry();
    reg.load(makeDef());
    reg.load(
      makeDef({
        version: 2,
        states: ["opened", "red"],
        transitions: [{ from: "opened", to: "red" }, { from: "red", to: "opened" }],
        stateMigrations: { green: "opened" },
      }),
    );
    expect(reg.migrations()).toEqual([{ profileId: "fixture-widget", version: 2, from: "green", to: "opened" }]);
  });

  it("删除状态无映射 → 拒加载（无映射遇旧状态）", () => {
    const reg = makeRegistry();
    reg.load(makeDef());
    expect(() =>
      reg.load(
        makeDef({
          version: 2,
          states: ["opened"],
          transitions: [{ from: "opened", to: "opened" }],
          stateMigrations: {},
        }),
      ),
    ).toThrow(/green.*映射|映射.*green/);
    expect(reg.get("fixture-widget")?.version).toBe(1);
  });

  it("评审 F4(med)：原型链键不充当映射——删 'constructor' 无 own 映射 → 拒加载（in 原型链误报已映射）", () => {
    const reg = makeRegistry();
    reg.load(makeDef({ states: ["constructor", "done"], transitions: [{ from: "constructor", to: "done" }] }));
    expect(() =>
      reg.load(
        makeDef({
          version: 2,
          states: ["done"],
          transitions: [{ from: "done", to: "done" }],
          stateMigrations: {},
        }),
      ),
    ).toThrow(/constructor/);
    expect(reg.get("fixture-widget")?.version).toBe(1);
  });

  it("迁移映射目标不在新状态集 → 拒绝", () => {
    const reg = makeRegistry();
    reg.load(makeDef());
    expect(() =>
      reg.load(
        makeDef({
          version: 2,
          states: ["opened", "red"],
          transitions: [{ from: "opened", to: "red" }, { from: "red", to: "opened" }],
          stateMigrations: { green: "ghost" },
        }),
      ),
    ).toThrow(/ghost/);
  });
});

// =============================================================================
// 票 42 — validate/templates 静态面（票 11 组 4 自 kernel.test.ts 迁入：owner 归位 profiles；
// kernel 面测试受 eda-kernel-deps 禁 import profiles，故经包根 barrel 消费纯函数。
// 断言不变；调用点 kernel.validate/templates → validateEntry/profileTemplates）。

const { profileTemplates, validateEntry } = daemon.profiles;

// 票 11 fake registry（静态面数据注入，I-01：零 profile import、零具体 profile 名）
const REGISTRY = [
  {
    profileId: "fixture-profile",
    templates: [
      {
        name: "fixture-tpl",
        entityType: "fixture:widget",
        states: ["passed", "failed", "waiting"],
        params: ["target"],
        usage: "fixture usage",
      },
      { name: "fixture-tpl-b", entityType: "fixture:gadget", states: ["passed", "failed"], usage: "b" },
    ],
    sideEffectPatterns: ["fixture-destructive"],
  },
] as const;

describe("票 11 组 4：validate 三类错误 + templates 注册表清单（票 42 迁 profiles 静态面）", () => {
  it("validate 三类错误：profile/template 未找到（列可用选项）/缺必填参数/ad-hoc 缺 check 声明", () => {
    expect(validateEntry(REGISTRY, { profile: "nope", check: "true" })).toMatchObject({
      ok: false,
      error: "profile-not-found",
    });
    expect((validateEntry(REGISTRY, { profile: "nope", check: "true" }) as { reason: string }).reason).toContain("fixture-profile");
    expect(validateEntry(REGISTRY, { profile: "fixture-profile", template: "nope-tpl" })).toMatchObject({
      ok: false,
      error: "profile-not-found",
    });
    expect(validateEntry(REGISTRY, { profile: "fixture-profile", template: "fixture-tpl" })).toMatchObject({
      ok: false,
      error: "invalid-params",
    });
    expect(validateEntry(REGISTRY, { profile: "fixture-profile" })).toMatchObject({
      ok: false,
      error: "checker-declaration",
    });
  });

  it("validate ADR 0004：已知副作用 pattern 命中 → warning 不阻断（ok:true）；干净 check 零 warning", () => {
    expect(validateEntry(REGISTRY, { profile: "fixture-profile", check: "fixture-destructive-cmd --force" })).toEqual({
      ok: true,
      warnings: [expect.stringContaining("fixture-destructive")],
    });
    // 干净 check：无副作用 pattern 但无显式 exit → 语义启发式 warning（2026-10-19 生产反馈新增）
    expect(validateEntry(REGISTRY, { profile: "fixture-profile", check: "curl -sf http://x/health" })).toEqual({
      ok: true,
      warnings: [expect.stringContaining("exit")],
    });
  });

  it("templates：注册表注入内容的元数据清单（profileId 附带）+ profile 过滤 + 未知 profile 拒绝", () => {
    expect(profileTemplates(REGISTRY, )).toEqual({
      templates: [
        { profileId: "fixture-profile", name: "fixture-tpl", entityType: "fixture:widget", states: ["passed", "failed", "waiting"], params: ["target"], usage: "fixture usage" },
        { profileId: "fixture-profile", name: "fixture-tpl-b", entityType: "fixture:gadget", states: ["passed", "failed"], usage: "b" },
      ],
    });
    expect(profileTemplates(REGISTRY, "fixture-profile").templates).toHaveLength(2);
    expect(() => profileTemplates(REGISTRY, "nope")).toThrow(/fixture-profile/);
  });

  it("validate 歧义声明拒绝：template 与 check 同时提供 → checker-declaration（二选一，warnings 不再从 check 推导）", () => {
    const res = validateEntry(REGISTRY, {
      profile: "fixture-profile",
      template: "fixture-tpl",
      params: { target: "x" },
      check: "fixture-destructive-cmd",
    });
    expect(res).toMatchObject({ ok: false, error: "checker-declaration" });
    expect((res as { reason: string }).reason).toContain("二选一");
  });

  it("validate 必填参数不吃原型链：params ['constructor'] + {} → invalid-params（own-property 判定，票 04 同修法）", () => {
    const registry = [
      {
        profileId: "proto-profile",
        templates: [
          { name: "proto-tpl", entityType: "fixture:widget", states: ["passed", "failed"], params: ["constructor"], usage: "u" },
        ],
      },
    ] as const;
    const res = validateEntry(registry, { profile: "proto-profile", template: "proto-tpl", params: {} });
    expect(res).toMatchObject({ ok: false, error: "invalid-params" });
    expect((res as { reason: string }).reason).toContain("constructor");
  });
});
