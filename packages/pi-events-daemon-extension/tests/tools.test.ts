/**
 * Ticket 34 — 9 op 模型可见工具面（flat + 显式 enums，schema 与 03 同源逐 op 对齐）
 * + D1a 完整校验客户端先行（extension 拒的帧到不了 daemon）。
 * C 层：真 unix socket（transport serve + 计数 dispatch）驱动拒绝矩阵。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { serve, type TransportHandle } from "pi-events-daemon/transport.ts";
import type { OpRequestFrame } from "pi-events-daemon/protocol.ts";
import { OP_NAMES } from "pi-events-daemon/protocol.ts";
import {
  buildToolDefs,
  createOpClient,
  loadOpSchema,
  validateFull,
  type JsonSchema,
  type OpSender,
  type OpToolDef,
} from "../index.ts";

const OP_SCHEMA = loadOpSchema();

/** 空转 sender：不应被调用（拒绝矩阵锚点）。 */
const rejectingSender: OpSender = async () => {
  throw new Error("sender 不应被调用（校验应先行拒绝）");
};

const build = (sender: OpSender = rejectingSender): OpToolDef[] =>
  buildToolDefs({ opSchema: OP_SCHEMA, sender });

const run = async (tool: OpToolDef, params: unknown) => tool.execute("call-1", params as Record<string, unknown>, undefined, undefined, {});

describe("票 34：9 op 工具注册 + 参数 schema 与 03 同源逐 op 对齐", () => {
  it("工具名集 = OP_NAMES 全集，一一映射（flat）", () => {
    const tools = build();
    expect(tools.map((t) => t.name).sort()).toEqual([...OP_NAMES].sort());
  });

  it("每 op 工具 parameters 与 op.schema.json request 同源（deep equal，不复制不手写；#50：definitions 闭包内联）", () => {
    const props = OP_SCHEMA.properties as Record<string, { properties?: { request: JsonSchema }; description?: string }>;
    const allDefs = OP_SCHEMA.definitions ?? {};
    for (const tool of build()) {
      // 闭包子集：request 引到的 definitions（采集逻辑与 collectRefDefs 同口径，独立重写防同义反复）
      const used = new Set<string>();
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) return void node.forEach(walk);
        if (node === null || typeof node !== "object") return;
        const ref = (node as { $ref?: string }).$ref;
        if (typeof ref === "string" && ref.startsWith("#/definitions/")) {
          const n = ref.slice("#/definitions/".length);
          if (n in allDefs && !used.has(n)) { used.add(n); walk(allDefs[n]); }
        }
        Object.values(node).forEach(walk);
      };
      walk(props[tool.name].properties!.request);
      // 票 125（候选4 形态 A'）：subscribe = wire 剥顶层 additionalProperties:false（host 宽容）；
      // 其余 op wire 原样 deep equal
      const wire = {
        ...props[tool.name].properties!.request,
        definitions: Object.fromEntries([...used].map((k) => [k, allDefs[k]])),
      };
      if (tool.name === "subscribe") {
        const { additionalProperties: _stripped, ...rest } = wire as Record<string, unknown>;
        expect(tool.parameters, `${tool.name} parameters 同源（additionalProperties 剥离）`).toEqual(rest);
      } else {
        expect(tool.parameters, `${tool.name} parameters 同源`).toEqual(wire);
      }
      expect(tool.description, `${tool.name} description 来自 op schema`).toBe(props[tool.name].description);
    }
  });

  it("评审 H：工具 schema 自包含——$ref 全部落在工具级 definitions 内，host 独立校验可解析", () => {
    for (const tool of build()) {
      const refs: string[] = [];
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (!node || typeof node !== "object") return;
        const r = node as Record<string, unknown>;
        if (typeof r.$ref === "string") refs.push(r.$ref);
        for (const v of Object.values(r)) walk(v);
      };
      walk(tool.parameters);
      for (const ref of refs) {
        expect(ref.startsWith("#/"), `${tool.name} $ref ${ref} 应为文档内指针`).toBe(true);
        let node: unknown = tool.parameters;
        for (const seg of ref.slice(2).split("/")) node = (node as Record<string, unknown>)?.[seg];
        expect(node, `${tool.name} $ref ${ref} 应在工具级 schema 内解析`).toBeDefined();
      }
    }
    // host 校验视角：以工具级 schema 自身为解析基准，request 节点引用的 $ref 必须可解析
    const subscribe = build().find((t) => t.name === "subscribe")!;
    expect(validateFull(subscribe.parameters, { entityRef: "t:external/k" }, subscribe.parameters)).toEqual([]);
  });

  it("flat + 显式 enums：subscribe 参数顶层字段即 request 字段（票 125：hostLenient 退役，wire 原样）", () => {
    const subscribe = build().find((t) => t.name === "subscribe")!;
    const parameters = subscribe.parameters as JsonSchema;
    expect(parameters.type).toBe("object");
    expect(Object.keys(parameters.properties as object)).toEqual(["entityRef", "url", "check", "opts"]);
    expect(parameters.additionalProperties).toBeUndefined(); // 剥离——host 宽容，D1a 原始 wire 仍拒拍平
  });

  it("daemon 业务错误（RpcError）以错误文本返回且带 code——不吞不包装", async () => {
    const sender: OpSender = async () => {
      const e = new Error("subscribe rejected: unknown entity fixture:x — register/status first") as Error & { code: number };
      e.code = -32000;
      throw e;
    };
    const subscribe = build(sender).find((t) => t.name === "subscribe")!;
    const res = await run(subscribe, { entityRef: "fixture:external/k" });
    expect(res.content[0].text).toContain("register/status first");
    expect((res.details as { error: { code: number } }).error.code).toBe(-32000);
  });
});

describe("票 34：完整校验拒绝矩阵（客户端先行，帧到不了 daemon）", () => {
  const cases: Array<[string, OpName2, unknown]> = [
    ["subscribe：oneOf 零命中（缺 target）", "subscribe", {}],
    ["subscribe：oneOf 多命中（entityRef+url 二义）", "subscribe", { entityRef: "t:external/k", url: "https://x" }],
    ["subscribe：entityRef 类型错误", "subscribe", { entityRef: 123 }],
    ["subscribe：opts.ttl 类型错误（嵌套）", "subscribe", { entityRef: "t:external/k", opts: { ttl: "soon" } }],
    ["subscribe：未知键（additionalProperties）", "subscribe", { entityRef: "t:external/k", shell: "evil" }],
    ["cancel：缺 subscriptionId", "cancel", {}],
    ["query：entityRef 类型错误", "query", { entityRef: 9 }],
    ["publish：缺 transition", "publish", { entityRef: "t:external/k" }],
    ["drain：sessionId 类型错误", "drain", { sessionId: 4 }],
    ["evidence：缺 evidenceRef", "evidence", {}],
    ["status：缺 key", "status", { type: "t" }],
    ["validate：缺 check", "validate", {}],
    ["templates：profile 类型错误", "templates", { profile: 5 }],
  ];
  type OpName2 = (typeof OP_NAMES)[number];

  it.each(cases)("%s → 本地拒绝，sender 零调用，错误列 issue 路径", async (_name, op, params) => {
    const tool = build().find((t) => t.name === op)!;
    const res = await run(tool, params);
    expect(res.content[0].text).toContain("参数校验失败");
    expect(res.content[0].text).toContain("帧未发送到 daemon");
    expect((res.details as { validationIssues: unknown[] }).validationIssues.length).toBeGreaterThan(0);
  });
});

describe("票 34：C 层——真 socket 全链路（合法帧到达 daemon，拒绝帧零到达）", () => {
  let dir: string;
  let path: string;
  let handle: TransportHandle | null = null;
  let received: Array<{ op: string; params: unknown }> = [];

  const start = () => {
    dir = mkdtempSync(join(tmpdir(), "pi-ext-t34-"));
    path = join(dir, "t.sock");
    handle = serve(path, {
      dispatch: (frame: OpRequestFrame) => {
        received.push({ op: frame.op, params: frame.params });
        return { op: frame.op, echoed: frame.params };
      },
      getEpoch: () => 3,
    });
    return path;
  };

  afterEach(() => {
    handle?.close();
    handle = null;
    received = [];
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("合法 subscribe 帧到达 daemon 并带回结果；拒绝矩阵帧计数保持 0", async () => {
    const p = start();
    const client = createOpClient({ socketPath: p, epoch: 3 });
    const tools = build((op, params) => client.request(op, params));
    const subscribe = tools.find((t) => t.name === "subscribe")!;

    const ok = await run(subscribe, { entityRef: "fixture:external/k", opts: { on: "failed" } });
    expect(received).toEqual([{ op: "subscribe", params: { entityRef: "fixture:external/k", opts: { on: "failed" } } }]);
    expect(ok.content[0].text).toContain("已订阅");
    expect(ok.content[0].text).toContain('"echoed"');

    const bad = await run(subscribe, { entityRef: 123 });
    expect(bad.content[0].text).toContain("帧未发送到 daemon");
    expect(received).toHaveLength(1); // 拒绝帧零到达（daemon 只见最小校验放行过的帧，D1a）

    await client.close();
  });
});
