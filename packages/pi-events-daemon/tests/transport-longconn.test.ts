/**
 * Ticket 29 acceptance tests — 长连接：SESSION_START 注册/推送行下发/断连注销/多连接并发。
 * C 层：真 unix socket，client fixture（transport.connectEvents，JSON-RPC socket 客户端壳）
 * 驱动 transport serve 的 session 钩子；两段式 ack 全链路属票 30，此处不涉及。
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { transport } from "../index.ts";

const EPOCH = 7;

let dir: string;
let path: string;
let handle: transport.TransportHandle | null = null;

type Push = (method: string, params: unknown) => void;

const startServer = (hooks: { onSessionStart?: (sid: string, push: Push) => void; onSessionEnd?: (sid: string) => void }) => {
  dir = mkdtempSync(join(tmpdir(), "pi-events-t29-"));
  path = join(dir, "t.sock");
  handle = transport.serve(path, {
    dispatch: (frame) => ({ echoed: frame.op, params: frame.params }),
    getEpoch: () => EPOCH,
    ...hooks,
  });
  return path;
};

afterEach(() => {
  handle?.close();
  handle = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const waitFor = async (cond: () => boolean, what = "condition"): Promise<void> => {
  const deadline = Date.now() + 2000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("ticket 29: SESSION_START→推送→断连注销", () => {
  it("SESSION_START 注册 → 推送行到达 → 断连注销后不再推送", async () => {
    const registry = new Map<string, Push>();
    const ended: string[] = [];
    const p = startServer({
      onSessionStart: (sid, push) => registry.set(sid, push), // daemon-main 侧进 L2 队列的钩子位
      onSessionEnd: (sid) => ended.push(sid),
    });
    const a = await transport.connectEvents(p, { epoch: EPOCH });
    const gotA: Array<[string, unknown]> = [];
    a.onNotification((method, params) => gotA.push([method, params]));
    a.startSession("s-A");
    await waitFor(() => registry.has("s-A"), "session start registration");

    registry.get("s-A")!("push", { seq: 1 }); // daemon 定向推送行
    await waitFor(() => gotA.length === 1, "targeted push");
    expect(gotA[0]).toEqual(["push", { seq: 1 }]);

    await a.close(); // 断连 = 注销
    await waitFor(() => ended.includes("s-A"), "session end callback");

    expect(() => registry.get("s-A")!("push", { seq: 2 })).not.toThrow(); // 注销后迟到推送不崩
    await new Promise((r) => setTimeout(r, 80)); // 已断连：对端不可能再收到

    // 广播只达仍在册连接：s-A 已注销，不参与
    const b = await transport.connectEvents(p, { epoch: EPOCH });
    const gotB: Array<[string, unknown]> = [];
    b.onNotification((method, params) => gotB.push([method, params]));
    b.startSession("s-B");
    await waitFor(() => registry.has("s-B"), "b registration");
    handle!.broadcastWake("wake", { n: 1 });
    await waitFor(() => gotB.length === 1, "broadcast to b");
    expect(gotB).toEqual([["wake", { n: 1 }]]);
    await b.close();
  });
});

describe("ticket 29: 多连接并发互不串扰", () => {
  it("定向推送只达目标连接；并发 op 响应按连接各自配对；广播双达", async () => {
    const registry = new Map<string, Push>();
    const p = startServer({ onSessionStart: (sid, push) => registry.set(sid, push) });
    const a = await transport.connectEvents(p, { epoch: EPOCH });
    const b = await transport.connectEvents(p, { epoch: EPOCH });
    const gotA: Array<[string, unknown]> = [];
    const gotB: Array<[string, unknown]> = [];
    a.onNotification((m, x) => gotA.push([m, x]));
    b.onNotification((m, x) => gotB.push([m, x]));
    a.startSession("s-A");
    b.startSession("s-B");
    await waitFor(() => registry.has("s-A") && registry.has("s-B"), "both registrations");

    registry.get("s-A")!("a-only", { n: 1 }); // 定向：只达 A
    await waitFor(() => gotA.length === 1, "targeted push to a");
    expect(gotB).toHaveLength(0); // B 不串扰

    // 并发短帧 op：各自连接的响应按请求 id 正确配对
    const [ra, rb] = await Promise.all([a.request("query", { who: "A" }), b.request("query", { who: "B" })]);
    expect(ra).toEqual({ echoed: "query", params: { who: "A" } });
    expect(rb).toEqual({ echoed: "query", params: { who: "B" } });

    handle!.broadcastWake("wake", { n: 2 }); // 广播：双达
    await waitFor(() => gotA.length === 2 && gotB.length === 1, "broadcast both");
    expect(gotA[1]).toEqual(["wake", { n: 2 }]);
    expect(gotB[0]).toEqual(["wake", { n: 2 }]);

    await a.close();
    await b.close();
  });
});

describe("ticket 29: transport 薄度（无策略渗入，源码审查）", () => {
  it("transport 源码无心跳/重连/重试/去重等策略词", () => {
    const tdir = join(new URL(".", import.meta.url).pathname, "../transport");
    const files = readdirSync(tdir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    for (const f of files) {
      const code = readFileSync(join(tdir, f), "utf8");
      expect(code, `${f} 出现策略词`).not.toMatch(/\b(?:heartbeat|keepalive|reconnect|backoff|retry|dedup|idempot|ttl)\b/i);
    }
  });
});
