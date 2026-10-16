/**
 * Ticket 05 acceptance tests — socket server 骨架 + 短帧 op 分流 + epoch 校验（链 A 里程碑）。
 * C 层：真 unix socket（node:net 客户端 ↔ transport serve ↔ dispatch fake）——
 * op 全链路 echo、PI_EVENTS_SOCK 优先、epoch 静默拒+计数、畸形帧跳过、transport 薄度。
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import * as net from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { protocol, transport } from "../index.ts";
type OpRequestFrame = protocol.OpRequestFrame;

const EPOCH = 7;

/** 每个 case 独立临时 socket 路径（unix path 长度受限，tmpdir 足够短）。 */
let dir: string;
let path: string;
let handle: transport.TransportHandle | null = null;

const startServer = (
  handlers: Partial<transport.TransportHandlers> & { dispatch: transport.TransportHandlers["dispatch"] },
) => {
  dir = mkdtempSync(join(tmpdir(), "pi-events-t05-"));
  path = join(dir, "t.sock");
  handle = transport.serve(path, { getEpoch: () => EPOCH, ...handlers });
  return path;
};

afterEach(() => {
  handle?.close();
  handle = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** 真 socket 客户端：写行、收 n 行（超时即 fail，不挂死套件）。 */
function connectRaw(p: string): net.Socket {
  const socket = net.connect(p);
  socket.setEncoding("utf8");
  return socket;
}

function readLines(socket: net.Socket, n: number, ms = 2000): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const lines: unknown[] = [];
    let buffer = "";
    const timer = setTimeout(
      () => reject(new Error(`timeout: 收到 ${lines.length}/${n} 行`)),
      ms,
    );
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (let idx = buffer.indexOf("\n"); idx >= 0; idx = buffer.indexOf("\n")) {
        lines.push(JSON.parse(buffer.slice(0, idx)));
        buffer = buffer.slice(idx + 1);
        if (lines.length === n) {
          clearTimeout(timer);
          resolve(lines);
          return;
        }
      }
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

const opRequest = (id: protocol.RequestId, op: protocol.OpName, params: Record<string, unknown>, epoch: number = EPOCH) =>
  protocol.encodeRequest(id, op, params, epoch) + "\n";

describe("ticket 05: 短帧 op 全链路（链 A 里程碑：echo）", () => {
  it("真 socket 发短帧 → dispatch fake 收到解码 op → 响应按请求 id 配对返回", async () => {
    const seen: OpRequestFrame[] = [];
    const p = startServer({
      dispatch: (frame) => {
        seen.push(frame);
        return { echoed: frame.op, params: frame.params };
      },
    });
    const socket = connectRaw(p);
    // 两个请求连续写（含 string id 与 number id），响应必须按各自 id 配对
    socket.write(opRequest("r1", "status", {}));
    socket.write(opRequest(2, "query", { q: "x" }));
    const responses = await readLines(socket, 2);

    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ kind: "op-request", op: "status", params: {} });
    expect(seen[1]).toMatchObject({ kind: "op-request", op: "query", params: { q: "x" } });

    const byId = new Map(responses.map((r) => [(r as { id: protocol.RequestId }).id, r]));
    expect(byId.get("r1")).toMatchObject({ jsonrpc: "2.0", id: "r1", result: { echoed: "status", params: {} } });
    expect(byId.get(2)).toMatchObject({ jsonrpc: "2.0", id: 2, result: { echoed: "query", params: { q: "x" } } });
    socket.destroy();
  });

  it("dispatch reject → 按请求 id 回 JSON-RPC error 响应（不崩不断连）", async () => {
    const p = startServer({ dispatch: () => { throw new Error("boom"); } });
    const socket = connectRaw(p);
    socket.write(opRequest("r1", "status", {}));
    const [resp] = await readLines(socket, 1);
    expect(resp).toMatchObject({ id: "r1", error: { code: -32603, message: expect.stringContaining("boom") } });
    socket.write(opRequest("r2", "status", {})); // 同连接后续请求仍可用
    const [resp2] = await readLines(socket, 1);
    expect(resp2).toMatchObject({ id: "r2" });
    socket.destroy();
  });
});

describe("ticket 05: socket 路径正典（PI_EVENTS_SOCK 优先）", () => {
  it("PI_EVENTS_SOCK env 优先于默认路径", () => {
    expect(transport.resolveSocketPath({ PI_EVENTS_SOCK: "/run/x/events.sock" })).toBe("/run/x/events.sock");
  });

  it("无 env → .pi 运行时目录默认路径", () => {
    expect(transport.resolveSocketPath({})).toBe(join(homedir(), ".pi", "run", "pi-events.sock"));
  });
});

describe("ticket 05: epoch 校验（I12）", () => {
  it("epoch 不匹配 → 静默拒：dispatch 不被调用、连接不断、进程不崩 +计数", async () => {
    const seen: OpRequestFrame[] = [];
    const p = startServer({
      dispatch: (frame) => {
        seen.push(frame);
        return { echoed: frame.op };
      },
    });
    const socket = connectRaw(p);
    socket.write(opRequest("stale-1", "subscribe", {}, 999)); // 旧 daemon epoch 的残留帧
    await new Promise((r) => setTimeout(r, 120)); // 静默：无响应
    expect(seen).toHaveLength(0);
    expect(handle!.epochMismatches()).toBe(1);
    expect(socket.destroyed).toBe(false);

    socket.write(opRequest("fresh", "status", {}, EPOCH)); // 同连接换正确 epoch → 正常（客户端可重连取新 epoch 的对偶：帧内换 epoch 即恢复）
    const [resp] = await readLines(socket, 1);
    expect(resp).toMatchObject({ id: "fresh", result: { echoed: "status" } });
    socket.destroy();
  });

  it("op 帧缺 epoch 视为不匹配 → 静默拒 +计数", async () => {
    const seen: OpRequestFrame[] = [];
    const p = startServer({ dispatch: (f) => (seen.push(f), { ok: true }) });
    const socket = connectRaw(p);
    socket.write(JSON.stringify({ jsonrpc: "2.0", id: "n1", method: "status", params: {} }) + "\n");
    await new Promise((r) => setTimeout(r, 120));
    expect(seen).toHaveLength(0);
    expect(handle!.epochMismatches()).toBe(1);
    socket.destroy();
  });
});

describe("ticket 05: 畸形帧跳过不崩（socket 路径）", () => {
  it("坏 JSON/空行/未知 op 后，后续合法帧正常处理", async () => {
    const p = startServer({ dispatch: (f) => ({ echoed: f.op }) });
    const socket = connectRaw(p);
    socket.write("not-json\n\n{\"jsonrpc\":\"2.0\"}\n");
    socket.write(JSON.stringify({ jsonrpc: "2.0", id: "u1", method: "no_such_op", params: {}, epoch: EPOCH }) + "\n");
    socket.write(opRequest("ok", "status", {}));
    const [resp] = await readLines(socket, 1);
    expect(resp).toMatchObject({ id: "ok", result: { echoed: "status" } });
    expect(socket.destroyed).toBe(false);
    socket.destroy();
  });
});

describe("ticket 05: transport 薄度（源码审查）", () => {
  it("transport 源码不含任何 payload 业务字段解析", () => {
    const dir = join(new URL(".", import.meta.url).pathname, "../transport");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const code = readFileSync(join(dir, f), "utf8");
      // 业务字段/策略词一律不出现：裁决归 kernel/loops/extension（模块 spec 纪律）
      expect(code, `${f} 出现业务字段/策略词`).not.toMatch(
        /entityRef|subscriptionId|notificationId|eventSeq|verdict|billboard|drain|parked|deadLetter|profileId|backoff|retry/,
      );
    }
  });
});
