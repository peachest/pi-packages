/** 票 136（peer 事故根因2）：脚本消费者 createOpClient 的 sessionId 缺省并入——
 *  短连接不发 session_start（transport 不注入），投递类 op 的 opts.sessionId 需客户端面补。 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOpClient } from "../index.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("票 136：createOpClient cfg.sessionId 缺省并入投递类 op", () => {
  it("subscribe 时 params.opts.sessionId 缺省 = cfg.sessionId（显式传入不覆盖）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "t136-"));
    dirs.push(dir);
    const captured: Array<Record<string, unknown>> = [];
    const c = createOpClient({
      socketPath: join(dir, "t.sock"),
      sessionId: "peer-sess-1",
      launcher: async () => { throw new Error("no daemon in test"); },
    });
    // 拦截：用内部 once 不可达——直接打 request 并捕获 params（需要 socket）。
    // 简化：不开真 socket，request 会失败——但 params 构造逻辑可经由 export 的纯函数验证？
    // 换契约面：cfg.sessionId 并入逻辑抽纯函数，直接测。
    const { withDefaultSessionId } = await import("../lib/client.ts");
    expect(withDefaultSessionId("subscribe", { url: "x" }, "peer-sess-1")).toEqual({ url: "x", opts: { sessionId: "peer-sess-1" } });
    expect(withDefaultSessionId("subscribe", { url: "x", opts: { sessionId: "explicit" } }, "peer-sess-1")).toEqual({ url: "x", opts: { sessionId: "explicit" } });
    expect(withDefaultSessionId("query", {}, "peer-sess-1")).toEqual({}); // 非投递类不注入
    expect(withDefaultSessionId("subscribe", { url: "x" }, undefined)).toEqual({ url: "x" }); // 无 cfg 不动
  });
});
