/**
 * Ticket 35 — events.json auto 订阅声明链 + project key 推导（B 层）。
 * 正典：events.schema.json（同源）；ADR 0002 project key 规则；daemon 发现不走此文件。
 */
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseEntityRefKey } from "pi-events-daemon/domain.ts";
import { resolveSocketPath } from "pi-events-daemon/transport.ts";
import type { OpName } from "pi-events-daemon/protocol.ts";
import {
  declareAutoSubscriptions,
  deriveProjectKey,
  findEventsJson,
  loadTemplates,
  readEventsJson,
  type OpSender,
} from "../index.ts";

let dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "pi-ext-t35-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("票 35：project key 推导（ADR 0002 正典规则逐例）", () => {
  it("cwd 绝对路径 → project/<realpath>；key 通过 daemon 正典校验器 parseEntityRefKey", () => {
    const root = tmp();
    const key = deriveProjectKey(root);
    expect(key).toBe(`project/${root}`);
    expect(() => parseEntityRefKey(key)).not.toThrow(); // daemon 侧封闭前缀域（external/|project/|user/）放行
  });

  it("symlink cwd → realpath 归一（同一项目唯一 key，不因挂载路径漂移）", () => {
    const root = tmp();
    mkdirSync(join(root, "real"));
    const link = join(root, "link");
    symlinkSync(join(root, "real"), link);
    expect(deriveProjectKey(link)).toBe(`project/${join(root, "real")}`);
  });
});

describe("票 35：daemon 发现不走 events.json（socket 约定 + PI_EVENTS_SOCK）", () => {
  it("op 客户端缺省 socketPath = daemon 正典 resolveSocketPath（PI_EVENTS_SOCK 优先），与 events.json 无关", () => {
    // 正典面由 daemon transport 导出（单一拼写）；events.schema.json additionalProperties:false
    // 已在 schema 矩阵拒绝任何 socket 字段——此处 pin 两侧不再漂移
    expect(resolveSocketPath({ PI_EVENTS_SOCK: "/run/x.sock" })).toBe("/run/x.sock");
  });
});

describe("票 35：.pi/events.json 发现与读取", () => {
  it("cwd 命中 / 父目录上溯命中 / 无文件返回 null", () => {
    const root = tmp();
    mkdirSync(join(root, ".pi"));
    writeFileSync(join(root, ".pi", "events.json"), JSON.stringify({ subscriptions: [] }));
    const sub = tmp();
    mkdirSync(join(sub, "deep"), { recursive: true });

    expect(findEventsJson(root)?.path).toBe(join(root, ".pi", "events.json"));
    expect(findEventsJson(join(sub, "deep"))).toBeNull(); // 无关项目不误认
    expect(findEventsJson(join(root, "deep"))?.path).toBe(join(root, ".pi", "events.json")); // 上溯
  });

  it("合法声明读取；缺 subscriptions / 未知字段 / 缺 template → 校验错误列 issue", () => {
    const root = tmp();
    mkdirSync(join(root, ".pi"));
    const p = join(root, ".pi", "events.json");
    writeFileSync(p, JSON.stringify({ subscriptions: [{ template: "df-free", params: { path: "/tmp" }, on: "failed" }] }));
    const doc = readEventsJson(p);
    expect(doc.ok).toBe(true);
    if (doc.ok) expect(doc.subscriptions).toHaveLength(1);

    const bad = (obj: unknown) => {
      writeFileSync(p, JSON.stringify(obj));
      return readEventsJson(p);
    };
    expect(bad({}).ok).toBe(false);
    expect(bad({ subscriptions: [{ params: {} }] }).ok).toBe(false); // 缺 template
    expect(bad({ subscriptions: [], socket: "/tmp/x.sock" }).ok).toBe(false); // daemon 发现不走此文件：socket 字段非法
    expect(bad("not-json{").ok).toBe(false); // 坏 JSON → 校验失败不抛
  });
});

describe("票 35：模板解析 + 声明映射（错误一律列可用选项）", () => {
  it("真模板资产加载：daemon 包 templates/ 目录（fs-watermark df-free 等）", () => {
    const reg = loadTemplates();
    const names = reg.entries().flatMap((e) => e.templates.map((t) => t.name));
    expect(names).toContain("df-free");
  });

  it("模板名零命中 → 错误列全部可用模板；二义 → 列 profile/template 候选", async () => {
    const dir = tmp();
    const def = (id: string, tpl: string) => ({
      id,
      entityType: `fix:${id}`,
      version: 1,
      states: ["waiting", "passed", "failed"],
      transitions: [{ from: "waiting", to: "passed" }],
      payloadSchema: { type: "object" },
      keyGenerator: { kind: "path", param: "path" },
      schedule: { type: "interval", every: "60s" },
      onTransition: [],
      templates: [{ name: tpl, check: "cat {path}", params: { path: "路径" }, usage: "fixture" }],
      stateMigrations: {},
    });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.json"), JSON.stringify(def("fix-a", "solo")));
    writeFileSync(join(dir, "b.json"), JSON.stringify(def("fix-b", "solo")));
    writeFileSync(join(dir, "c.json"), JSON.stringify(def("fix-c", "other")));
    const reg = loadTemplates(dir);

    const sent: Array<{ op: OpName; params: unknown }> = [];
    const sender: OpSender = async (op, params) => {
      sent.push({ op, params });
      return {};
    };
    const failed = await declareAutoSubscriptions([{ template: "nope" }], sender, reg);
    expect(failed.failed).toHaveLength(1);
    expect(failed.failed[0].error).toContain("可用");
    expect(sent).toHaveLength(0);

    const amb = await declareAutoSubscriptions([{ template: "solo", params: { path: "/x" } }], sender, reg);
    expect(amb.failed[0].error).toContain("fix-a/solo");
    expect(amb.failed[0].error).toContain("fix-b/solo");
    expect(sent).toHaveLength(0);
  });

  it("成功声明 → subscribe 帧带 entityRef wire 单串 + 代入 check + opts 意图 + origin:auto（无 sessionId/smoke）", async () => {
    const dir = tmp();
    const def = {
      id: "fix-a",
      entityType: "fix-a:thing",
      version: 1,
      states: ["waiting", "passed", "failed"],
      transitions: [{ from: "waiting", to: "passed" }],
      payloadSchema: { type: "object" },
      keyGenerator: { kind: "path", param: "path" },
      schedule: { type: "interval", every: "60s" },
      onTransition: [],
      templates: [{ name: "solo", check: "cat {path}", params: { path: "路径" }, usage: "fixture" }],
      stateMigrations: {},
    };
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.json"), JSON.stringify(def));
    const reg = loadTemplates(dir);

    const sent: Array<{ op: OpName; params: Record<string, unknown> }> = [];
    const sender: OpSender = async (op, params) => {
      sent.push({ op, params: params as Record<string, unknown> });
      return { subscribed: true, subscriptionId: "sub-1" };
    };
    const r = await declareAutoSubscriptions(
      [{ template: "solo", params: { path: "/tmp/x" }, on: ["failed", "passed"], once: true, flip: true, ttl: 60000, failureThreshold: 2 }],
      sender,
      reg,
    );
    expect(r.failed).toHaveLength(0);
    expect(sent).toEqual([
      {
        op: "subscribe",
        params: {
          entityRef: "fix-a:thing:external//tmp/x",
          check: "cat '/tmp/x'",
          opts: {
            template: "solo",
            on: ["failed", "passed"],
            once: true,
            flip: true,
            ttl: 60000,
            failureThreshold: 2,
            origin: "auto",
          },
        },
      },
    ]);
  });

  it("invalid-params（缺模板参数）→ 逐条失败不中断后续条目（containment）", async () => {
    const dir = tmp();
    const def = {
      id: "fix-a",
      entityType: "fix:thing",
      version: 1,
      states: ["waiting", "passed", "failed"],
      transitions: [{ from: "waiting", to: "passed" }],
      payloadSchema: { type: "object" },
      keyGenerator: { kind: "path", param: "path" },
      schedule: { type: "interval", every: "60s" },
      onTransition: [],
      templates: [{ name: "solo", check: "cat {path}", params: { path: "路径" }, usage: "fixture" }],
      stateMigrations: {},
    };
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.json"), JSON.stringify(def));
    const reg = loadTemplates(dir);

    const sent: unknown[] = [];
    const r = await declareAutoSubscriptions(
      [{ template: "solo" }, { template: "solo", params: { path: "/ok" } }],
      async (op, params) => {
        sent.push(params);
        return {};
      },
      reg,
    );
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].error).toContain("缺少必填参数: path");
    expect(sent).toHaveLength(1);
  });
});

// 存在性哨兵：harness 引用的 node:fs 导入在 B 层文件里未被使用则删
void existsSync;
