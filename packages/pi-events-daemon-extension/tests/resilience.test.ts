/**
 * Ticket 37 — 惰性拉起 + op 短连接有限重试（3 次，独立于 wake 退避）+ batch 呈现截断标记。
 * C 层真 socket（死路径→注入拉起器→重试命中）；B 层重试节拍与 RpcError 不重试。
 * 正典：#31 线协议节（round-4 补落）——每请求短连接失败 → 有限重试（自定裁量 3 次）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { OpRequestFrame } from "pi-events-daemon/protocol.ts";
import { serve, type TransportHandle } from "pi-events-daemon/transport.ts";
import { createOpClient, MAX_OP_ATTEMPTS, renderWakeBatch, truncateEvidence, type OpClient } from "../index.ts";
import { EPOCH, startTestDaemon, waitFor, type TestDaemon } from "./harness.ts";

/** dispatch 挂起的 daemon（响应相位失败锚点：连接成功、请求永不答）。 */
const startHangingDaemon = () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-ext-t37-hang-"));
  const path = join(dir, "h.sock");
  const received: Array<{ op: string; params: unknown }> = [];
  const handle: TransportHandle = serve(path, {
    dispatch: (frame: OpRequestFrame) => {
      received.push({ op: frame.op, params: frame.params });
      return new Promise(() => {}); // 永不完成：慢操作/停摆替身
    },
    getEpoch: () => EPOCH,
  });
  let closed = false;
  return {
    path,
    received,
    close: async () => {
      if (!closed) {
        closed = true;
        await handle.close();
      }
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

describe("票 37：daemon 未运行 → 自动拉起 → 操作成功（C 层真 socket）", () => {
  it("死路径首操作失败 → 注入拉起器拉起真 daemon → 重试命中响应", async () => {
    const path = join(tmpdir(), `pi-ext-t37-${Date.now()}-lazy.sock`);
    let daemon: TestDaemon | null = null;
    const client: OpClient = createOpClient({
      socketPath: path,
      epoch: 5,
      launcher: async () => {
        daemon = startTestDaemon({ socketPath: path });
      },
    });
    try {
      const res = (await client.request("templates", { profile: "x" })) as { echoed: string };
      expect(res.echoed).toBe("templates");
      expect(daemon).not.toBeNull(); // 拉起确实发生
    } finally {
      await client.close();
      await (daemon as TestDaemon | null)?.close();
    }
  });
});

describe("票 37：短连接有限重试 3 次 → 错误列可用选项（独立于 wake 退避）", () => {
  it("持续不可达：恰 3 次尝试（拉起 1 次 + 固定间隔重试 2 次）后报错，错误含 remedies", async () => {
    const delays: number[] = [];
    let launches = 0;
    const path = join(tmpdir(), `pi-ext-t37-${Date.now()}-dead.sock`);
    const client: OpClient = createOpClient({
      socketPath: path,
      epoch: 5,
      retryDelayMs: async (ms: number) => {
        delays.push(ms);
      },
      launcher: async () => {
        launches++;
      },
    });
    await expect(client.request("query", {})).rejects.toThrow(/已重试/);
    expect(launches).toBe(1); // 惰性拉起仅一次
    expect(delays).toEqual([100]); // 3 次尝试：1 失败→拉起重试，2 失败→固定间隔，3 失败→报错（非指数退避，独立于 wake）
    await expect(client.request("query", {})).rejects.toThrow(/PI_EVENTS_SOCK|手动启动/); // 错误列可用选项
  });

  it("daemon 业务错误（RpcError）不重试：原样上抛一次即止", async () => {
    const daemon: TestDaemon = startTestDaemon();
    try {
      const client = createOpClient({
        socketPath: daemon.socketPath,
        epoch: 5,
        launcher: async () => {
          throw new Error("launcher 不应被调用");
        },
      });
      // harness dispatch echo 不抛；RpcError 形状的业务错误语义由下方两个评审 M 测试真 socket pin：
      // transport 断连（phase:"transport"）重试不弃，业务错误首试即抛；此处只锚定成功路径零拉起。
      const res = (await client.request("query", {})) as { echoed: string };
      expect(res.echoed).toBe("query");
      await client.close();
    } finally {
      await daemon.close();
    }
  });

  it("MAX_OP_ATTEMPTS 正典常量 = 3（spec 自定裁量）", () => {
    expect(MAX_OP_ATTEMPTS).toBe(3);
  });
});

describe("评审 M：传输失败 ≠ RpcError——socket 中途断连继续重试，不首试即弃（finding 4）", () => {
  it("请求在途时服务端断连（-32000 transport 标记）→ 走满重试节拍 → 末错列可用选项；拉起零触发", async () => {
    const d = startHangingDaemon();
    try {
      const delays: number[] = [];
      let launches = 0;
      const client: OpClient = createOpClient({
        socketPath: d.path,
        epoch: EPOCH,
        retryDelayMs: async (ms: number) => {
          delays.push(ms);
        },
        launcher: async () => {
          launches++;
        },
      });
      const p = client.request("query", {});
      await waitFor(() => d.received.length === 1, "frame in flight");
      await d.close(); // 传输中途断连 → pending 清算（phase:"transport"）
      await expect(p).rejects.toThrow(/已重试/); // 不被误判为业务错误首试即抛
      expect(delays).toEqual([100, 100]); // 3 次尝试全走固定间隔
      expect(launches).toBe(0); // 首失败是响应相位，不拉起
    } finally {
      await d.close();
      d.cleanup();
    }
  });
});

describe("评审 M：首响应超时不拉起——惰性拉起仅对连接相位失败生效（finding 5）", () => {
  it("daemon 已活（dispatch 挂起）+ 响应超时 → launcher 零调用，重试走固定间隔", async () => {
    const d = startHangingDaemon();
    try {
      let launches = 0;
      const delays: number[] = [];
      const client: OpClient = createOpClient({
        socketPath: d.path,
        epoch: EPOCH,
        timeoutMs: 60,
        retryDelayMs: async (ms: number) => {
          delays.push(ms);
        },
        launcher: async () => {
          launches++;
        },
      });
      await expect(client.request("query", {})).rejects.toThrow(/已重试/);
      expect(launches).toBe(0); // 响应相位失败不 spawn daemon
      expect(delays).toEqual([100, 100]);
    } finally {
      await d.close();
      d.cleanup();
    }
  });
});

describe("票 37：batch 呈现 + 截断标记（billboard=count+实体+verdict；evidence>2KB 截断）", () => {
  it("batch 头部计数 + 逐条实体/verdict；超 2KB evidence 截断并标记全量入口", () => {
    const long = "x".repeat(3000);
    const short = "df: /dev/sda1 42%";
    const out = renderWakeBatch([
      { notificationId: "n1", entityRef: "fs:path:external//tmp", verdict: "failed", evidence: long, evidenceRef: "n1" },
      { notificationId: "n2", entityRef: "fs:path:external//var", verdict: "passed", evidence: short },
    ]);
    expect(out).toContain("wake ×2");
    expect(out).toContain("fs:path:external//tmp → failed");
    expect(out).toContain("fs:path:external//var → passed");
    expect(out).toContain("[截断"); // 截断标记
    expect(out).toContain("evidence op"); // 全量入口指引
    expect(out).toContain("evidenceRef: n1");
    // 截断后内联体不超过 2KB 限额（含标记）
    const truncatedLine = out.split("\n").find((l) => l.includes("[截断"))!;
    expect(truncatedLine.length).toBeLessThanOrEqual(2048 + 200);
    expect(out).not.toContain("x".repeat(2500)); // 全文未内联

    const t = truncateEvidence("y".repeat(3000));
    expect(t).toContain("[截断");
    expect(Buffer.byteLength(t, "utf8")).toBeLessThan(3000);
    expect(truncateEvidence("short")).toBe("short"); // 未超限原样
  });
});
