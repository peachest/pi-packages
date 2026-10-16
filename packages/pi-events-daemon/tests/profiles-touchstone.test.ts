/**
 * Ticket 33 acceptance tests — I-01/ADR 0005 试金石：新增测试 profile fixture 后
 * kernel/loops 零改动全绿（依赖图断言 + 全栈数据流）。
 *
 * 流程：fixture profile → ProfileRegistry.load → startLoops（states/registry 注入）
 * → instantiate 产出 → L0 subscribe（模板形态）→ L0 transition → 事件落 outbox。
 * fixture 是内联数据（零新增源码文件进入核心模块）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import * as daemon from "../index.ts";

const { ProfileRegistry } = daemon.profiles;
const { validateValue } = daemon.protocol;
const { createMemoryStore } = daemon.store;
const { FakeClock, FakeExec, FakeFs, FakePusher } = daemon.fx;
const { startLoops } = daemon.loops;

const SCHEMA: object = JSON.parse(
  readFileSync(new URL("../schemas/profile.schema.json", import.meta.url), "utf8"),
);

/** 新增测试 profile fixture——独立于内置三模板的全新域（零 kernel/loops 改动即可用）。 */
const FIXTURE_ID = "touchstone-widget";
const fixtureDef = {
  id: FIXTURE_ID,
  entityType: "touchstone:widget",
  version: 1,
  states: ["green", "red"],
  transitions: [
    { from: "green", to: "red" },
    { from: "red", to: "green" },
  ],
  payloadSchema: { type: "object" },
  keyGenerator: { kind: "path", param: "path" },
  schedule: { type: "interval", every: "60s" },
  onTransition: [],
  templates: [
    {
      name: "watch",
      check: "test -f {path}",
      params: { path: "被监视文件（绝对路径）" },
      usage: "试金石 fixture：存在=green（passed），缺失=red",
    },
  ],
  stateMigrations: {},
};

describe("试金石：新增 fixture profile 全绿零核心改动（I-01/ADR 0005）", () => {
  it("依赖图断言：kernel/loops 源码零 profiles import、零 fixture 名（真图门 = lint:boundaries）", () => {
    for (const mod of ["kernel", "loops"]) {
      const dir = new URL(`../${mod}/`, import.meta.url);
      for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
        const src = readFileSync(new URL(`../${mod}/${f}`, import.meta.url), "utf8");
        expect(src, `${mod}/${f} import profiles`).not.toMatch(/from\s+"\.\.\/profiles/);
        expect(src, `${mod}/${f} fixture 泄漏`).not.toContain(FIXTURE_ID);
      }
    }
  });

  it("fixture 经 load→instantiate→L0 subscribe/transition 全栈数据流，errors 空", () => {
    const reg = new ProfileRegistry({ validate: validateValue, schema: SCHEMA });
    reg.load(fixtureDef);

    const store = createMemoryStore();
    const handle = startLoops({
      clock: new FakeClock(),
      exec: new FakeExec(),
      pusher: new FakePusher(),
      fs: new FakeFs(),
      store,
      states: reg.states(),
      registry: reg.entries(),
    });

    const inst = reg.instantiate(FIXTURE_ID, "watch", { path: "/data/msgs" });
    if (!inst.ok) throw new Error(inst.reason);

    // 实体种子（loops.test 同法；register 簿记经 store 行 profileId 记名）
    store.putEntity({ ...inst.entityRef, state: null, profileId: inst.profileId });

    handle.submit({
      kind: "subscribe",
      req: {
        sessionId: "s1",
        entityRef: inst.entityRef,
        template: inst.template,
        check: inst.check,
        now: 1_000,
        opts: { schedule: inst.schedule },
      },
    });
    // publish 路径（链 B 复用）：L0 transition 入参为判定词表 Verdict，自定义状态集经 consumeIntent
    // （intent.to 开放 string，闭集由注入 states 执法——kernel F2）。
    // intent 字面量仿 crash-inject.test.ts（tests/ 走入口不可深导入 domain/intent——tests-through-entrypoints；
    // planTransition 构造路径已由 kernel.test.ts 覆盖，此处断言的是消费链非构造）
    handle.submit({
      kind: "consumeIntent",
      intent: {
        eventId: "evt-touchstone-1",
        eventSeq: 1,
        entityRef: inst.entityRef,
        from: null,
        to: "red",
        occurredAt: "2026-01-01T00:00:01Z",
        decisionOrder: 1,
      },
    });

    const subs = store.querySubscriptions({ entityRefType: inst.entityRef.type, entityRefKey: inst.entityRef.key });
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ template: "watch", check: "test -f '/data/msgs'" });
    expect(store.getEntity(inst.entityRef.type, inst.entityRef.key)?.state).toBe("red");
    expect(store.outboxBatch(Number.MAX_SAFE_INTEGER)).toHaveLength(1);
    expect(handle.errors).toEqual([]);
    handle.stop();
  });
});
