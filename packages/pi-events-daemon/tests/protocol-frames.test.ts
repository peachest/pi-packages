import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { protocol } from "../index.ts";

// #31 判定器契约：agent 可见面一律语义名
const V = {
  syntaxOk: true,
  verdict: "waiting",
  reason: "probe scheduled",
  evidence: "ev-1",
  durationMs: 12,
  warnings: [] as string[],
};

// #31 操作面表逐字取样的代表帧：[op, 请求 params, 响应 result]
const SAMPLES: Array<[protocol.OpName, Record<string, unknown>, Record<string, unknown>]> = [
  [
    "subscribe",
    {
      entityRef: "external/https://gl.corp/g/p/-/merge_requests/1",
      opts: { flip: true, failureThreshold: 3, successThreshold: 2 },
    },
    {
      subscriptionId: "s-1",
      entityRef: "external/https://gl.corp/g/p/-/merge_requests/1",
      state: null,
      validate: V,
      warnings: [],
    },
  ],
  // smoke 失败响应 {subscribed:false, validate} 是 subscribe 的另一响应形态
  [
    "subscribe",
    { check: "curl -sf http://localhost:200/healthz" },
    { subscribed: false, validate: { ...V, verdict: "failed", reason: "exit 7" } },
  ],
  ["cancel", { subscriptionId: "s-1" }, { cancelled: true }],
  [
    "query",
    { scope: "external/" },
    {
      entities: [
        {
          entityRef: "external/https://gl.corp/g/p/-/merge_requests/1",
          state: "running",
          payloadSummary: { title: "Fix login" },
          lastProbedAt: "2026-09-21T00:00:00Z",
          backlog: 2,
          children: [],
        },
      ],
      deadLetters: [{ entityRef: "external/x", reason: "retired" }],
    },
  ],
  [
    "publish",
    { entityRef: "project/foo", transition: { to: "done", contentIdentity: "sha1:abc", payload: { note: "ok" } } },
    { eventSeq: 7, from: "running", to: "done" },
  ],
  ["drain", { sessionId: "w1:pA" }, { drained: 3, deadLetterSummary: { count: 1, oldestAge: 120000 } }],
  ["evidence", { evidenceRef: "ev-1" }, { content: "log line", truncated: false }],
  [
    "status",
    { type: "task", key: "user/todo-1", state: "doing", payload: { owner: "me" } },
    { entityRef: "project/todo-1", state: "doing", event: { eventSeq: 8, to: "doing" } },
  ],
  ["validate", { check: "curl -sf http://localhost:200/healthz" }, V],
  [
    "templates",
    { profile: "gitlab" },
    {
      templates: [
        {
          name: "gitlab:mr",
          entityType: "external",
          states: ["open", "merged"],
          schedule: { type: "interval", every: "60s" },
          params: { host: "GitLab host" },
          usage: "subscribe url=<mr url>",
        },
      ],
    },
  ],
];

describe("ticket 05+：op 帧携带 daemon epoch（I12 帧级扩展，向后兼容）", () => {
  it("encodeRequest 带 epoch → decode 还原 epoch；不带 epoch → 无该成员", () => {
    const withEpoch = protocol.encodeRequest(1, "drain", {}, 42);
    expect(protocol.decodeLine(withEpoch)).toEqual({ kind: "op-request", id: 1, op: "drain", params: {}, epoch: 42 });
    const without = protocol.encodeRequest(1, "drain", {});
    expect(protocol.decodeLine(without)).toEqual({ kind: "op-request", id: 1, op: "drain", params: {} });
    expect("epoch" in (protocol.decodeLine(without) as object)).toBe(false);
  });

  it("epoch 非有限数字（字符串/true）→ 不提取，帧仍按缺 epoch 解码", () => {
    const line = '{"jsonrpc":"2.0","id":1,"method":"drain","params":{},"epoch":"7"}';
    expect(protocol.decodeLine(line)).toEqual({ kind: "op-request", id: 1, op: "drain", params: {} });
  });
});

describe("ticket 02: 9 op encode→decode round-trip（断言 1）", () => {
  it.each(SAMPLES)("%s 请求与响应两侧逐字节还原", (op, req, res) => {
    const reqLine = protocol.encodeRequest(1, op, req);
    expect(reqLine).not.toContain("\n");
    expect(protocol.decodeLine(reqLine)).toEqual({ kind: "op-request", id: 1, op, params: req });
    expect(JSON.stringify((protocol.decodeLine(reqLine) as { params: unknown }).params)).toBe(JSON.stringify(req));

    const resLine = protocol.encodeResult("id-1", res);
    expect(resLine).not.toContain("\n");
    expect(protocol.decodeLine(resLine)).toEqual({ kind: "op-response", id: "id-1", result: res, error: undefined });
  });
});

describe("ticket 02: 短帧/长帧分流（断言 2）", () => {
  it("op 帧带请求 id", () => {
    expect(protocol.decodeLine(protocol.encodeRequest(42, "drain", {}))).toMatchObject({
      kind: "op-request",
      id: 42,
      op: "drain",
    });
  });

  it("notification 行不被当作 op（分流按 id 有无）", () => {
    expect(protocol.decodeLine(protocol.encodeNotification("wake", { sessionId: "w1:pA" }))).toEqual({
      kind: "notification",
      method: "wake",
      params: { sessionId: "w1:pA" },
    });
    expect(protocol.decodeLine('{"jsonrpc":"2.0","method":"publish","params":{}}')).toEqual({
      kind: "notification",
      method: "publish",
      params: {},
    });
  });

  it("ack 是内部传输确认行，不是 op", () => {
    expect(protocol.decodeLine(protocol.encodeAck("n-1"))).toEqual({ kind: "ack", notificationId: "n-1" });
    expect(
      protocol.decodeLine('{"jsonrpc":"2.0","id":1,"method":"ack","params":{"notificationId":"n-1"}}'),
    ).toBeNull();
  });

  it("SESSION_START 连接声明行（声明 sessionId）", () => {
    expect(protocol.decodeLine(protocol.encodeSessionStart("w1:pA"))).toEqual({
      kind: "session-start",
      sessionId: "w1:pA",
    });
    expect(
      protocol.decodeLine('{"jsonrpc":"2.0","id":1,"method":"session_start","params":{"sessionId":"w1:pA"}}'),
    ).toBeNull();
  });

  it("SESSION_START observer 声明（票 44 评审 H：纯广播观察者旗标解码）", () => {
    expect(protocol.decodeLine(protocol.encodeSessionStart("pane:obs", { observer: true }))).toEqual({
      kind: "session-start",
      sessionId: "pane:obs",
      observer: true,
    });
    // 非 boolean observer 值不置旗标（decode 严格）
    expect(protocol.decodeLine('{"jsonrpc":"2.0","method":"session_start","params":{"sessionId":"x","observer":"yes"}}')).toEqual({
      kind: "session-start",
      sessionId: "x",
    });
  });
});

describe("ticket 02: 畸形帧跳过不崩（断言 3）", () => {
  it("单行畸形帧返回 null 不抛错", () => {
    const lines = [
      "",
      "   ",
      "\t",
      "{oops",
      "not json at all",
      "[1,2]",
      "42",
      '"str"',
      '{"jsonrpc":"1.0","id":1,"method":"drain"}',
      '{"jsonrpc":"2.0","id":1,"method":"teleport","params":{}}', // 未知 op
      '{"jsonrpc":"2.0","id":true,"method":"drain"}',
      '{"jsonrpc":"2.0","method":42}',
      '{"jsonrpc":"2.0","id":1}', // 无 method 无 result/error
      '{"jsonrpc":"2.0","method":"ack"}', // ack 缺 notificationId
      '{"jsonrpc":"2.0","id":1,"method":"drain","params":[1,2]}', // params 非对象
      "x".repeat(protocol.MAX_LINE_LENGTH + 1), // 超长行
      '{"jsonrpc":"2.0","method":"drain","pad":"' + "y".repeat(protocol.MAX_LINE_LENGTH) + '"}',
    ];
    for (const line of lines) {
      expect(() => protocol.decodeLine(line)).not.toThrow();
      expect(protocol.decodeLine(line)).toBeNull();
    }
  });

  it("畸形帧之后合法帧正常", () => {
    const good1 = protocol.encodeRequest(1, "drain", {});
    const good2 = protocol.encodeResult(1, { drained: 0, deadLetterSummary: { count: 0, oldestAge: 0 } });
    const frames = protocol.decodeLines(
      ["", "   ", "{oops", '{"jsonrpc":"2.0","id":1,"method":"teleport"}', good1, good2].join("\n"),
    );
    expect(frames).toEqual([
      { kind: "op-request", id: 1, op: "drain", params: {} },
      {
        kind: "op-response",
        id: 1,
        result: { drained: 0, deadLetterSummary: { count: 0, oldestAge: 0 } },
        error: undefined,
      },
    ]);
  });

  it("CRLF 容错", () => {
    expect(protocol.decodeLines(protocol.encodeAck("n-9") + "\r\n")).toEqual([{ kind: "ack", notificationId: "n-9" }]);
  });
});

describe("ticket 02: op 契约形状与 #31 操作面表一致（断言 4）", () => {
  it("9 op 逐字一致", () => {
    expect([...protocol.OP_NAMES]).toEqual([
      "subscribe",
      "cancel",
      "query",
      "publish",
      "drain",
      "evidence",
      "status",
      "validate",
      "templates",
    ]);
  });

  it("smoke 失败响应 {subscribed:false, validate} 不抛错", () => {
    const res: protocol.SubscribeResponse = {
      subscribed: false,
      validate: { ...V, verdict: "failed", reason: "exit 7" },
    };
    expect(protocol.decodeLine(protocol.encodeResult(3, res))).toEqual({
      kind: "op-response",
      id: 3,
      result: res,
      error: undefined,
    });
  });

  it("publish 响应含 {eventSeq, from, to}", () => {
    const res: protocol.PublishResponse = { eventSeq: 7, from: "running", to: "done" };
    expect(Object.keys(res).sort()).toEqual(["eventSeq", "from", "to"]);
    expect(protocol.decodeLine(protocol.encodeResult(4, res))).toMatchObject({ kind: "op-response", result: res });
  });

  it("publish 首转换 from=null（domain Transitioned 正典对齐，#31）round-trip", () => {
    const first: protocol.PublishResponse = { eventSeq: 1, from: null, to: "open" };
    expect(protocol.decodeLine(protocol.encodeResult(6, first))).toMatchObject({ kind: "op-response", result: first });
  });

  it("错误响应列可用选项（多命中模板报错形态）round-trip", () => {
    const err: protocol.RpcError = {
      code: -32602,
      message: "url 命中多个模板，显式指定 opts.template",
      data: { available: ["gitlab:mr", "gitlab:ci"] },
    };
    expect(protocol.decodeLine(protocol.encodeError(5, err))).toEqual({
      kind: "op-response",
      id: 5,
      result: undefined,
      error: err,
    });
  });

  it("类型契约编译期成立（OpContract map）", () => {
    const req: protocol.OpRequest<"cancel"> = { subscriptionId: "s-1" };
    const res: protocol.OpResponse<"cancel"> = { cancelled: true };
    const sreq: protocol.SubscribeRequest = { url: "https://gl.corp/x", opts: { once: true } };
    expect([req, res, sreq].length).toBe(3);
  });

  it("opts 类型对齐：ttl number 毫秒 + ad-hoc schedule（interval.every number / cron.expr string）编译期成立", () => {
    const ms: protocol.SubscribeOpts = { ttl: 60000 };
    const adhoc: protocol.SubscribeOpts = { schedule: { type: "interval", every: 60000 } };
    const cron: protocol.SubscribeOpts = { schedule: { type: "cron", expr: "*/5 * * * *", tz: "Asia/Shanghai" } };
    expect([ms, adhoc, cron].length).toBe(3);
  });
});

describe("ticket 02: 零依赖源码断言（断言 5）", () => {
  it("protocol 源码零引入（无其他模块、无第三方库）", () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "../protocol");
    // 只扫源码：协议目录内同位 *.test.ts 是测试，允引 vitest（实现票 04；零引入不变量只约束源码）
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const code = readFileSync(join(dir, f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(code, `${f} 含引入语句`).not.toMatch(/\b(?:import|require)\b/);
    }
  });
});
