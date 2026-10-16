/**
 * client — daemon op 客户端（票 34 基础发送面；票 37 叠加重试/惰性拉起）。
 *
 * 线协议纪律（#31）：op 走每请求短连接（连接→请求→关闭），帧携带 daemon epoch（I12）。
 * epoch 发现约定：<socketPath>.epoch 旁车文件（daemon bootstrap 写入；票 38 对齐点），
 * 缺失按 0 处理——I12 会静默拒帧，表现为响应超时，错误文案指向旁车文件。
 */
import { readFileSync } from "node:fs";
import { connectEvents, resolveSocketPath, type EventsClient } from "pi-events-daemon/transport.ts";
import type { OpName, RpcError } from "pi-events-daemon/protocol.ts";

export interface OpClientConfig {
  socketPath?: string;
  /** 缺省读 <socketPath>.epoch 旁车文件（每请求重读，daemon 重启换代后自动跟上）。 */
  epoch?: number;
  /** 单请求响应超时（缺省 10s）——epoch 静默拒帧的兜底观测面。 */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface OpClient {
  request(op: OpName, params: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

/** epoch 旁车文件读取（<socketPath>.epoch，整数；缺失/垃圾 → 0）。 */
export function readDaemonEpoch(socketPath: string): number {
  try {
    const n = parseInt(readFileSync(`${socketPath}.epoch`, "utf8").trim(), 10);
    return Number.isInteger(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function isRpcError(err: unknown): err is RpcError {
  const e = err as Partial<RpcError> | null | undefined;
  return e != null && typeof e.code === "number" && typeof e.message === "string";
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export function createOpClient(cfg: OpClientConfig = {}): OpClient {
  const socketPath = cfg.socketPath ?? resolveSocketPath(cfg.env ?? process.env);
  const timeoutMs = cfg.timeoutMs ?? 10_000;
  return {
    async request(op, params) {
      let client: EventsClient | null = null;
      try {
        const epoch = cfg.epoch ?? readDaemonEpoch(socketPath);
        client = await connectEvents(socketPath, { epoch });
        const p = client.request(op, params);
        p.catch(() => {}); // 超时竞速输家的 rejection 不得成为 unhandled
        return await withTimeout(p, timeoutMs, `op ${op} 响应超时（${timeoutMs}ms）——daemon 停摆或 epoch 过期？检查 ${socketPath}.epoch / 重启 daemon`);
      } catch (err) {
        if (isRpcError(err)) throw err; // daemon 业务错误原样上抛（错误文案已列可用选项）
        const msg = (err as Error | undefined)?.message ?? String(err);
        throw new Error(`daemon 连接失败（${socketPath}）: ${msg}`);
      } finally {
        await client?.close();
      }
    },
    // 每请求短连接：无常驻资源
    async close() {},
  };
}
