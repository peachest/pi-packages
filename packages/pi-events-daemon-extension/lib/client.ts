/**
 * client — daemon op 客户端（票 34 基础发送面；票 37 叠加惰性拉起 + 短连接有限重试）。
 *
 * 线协议纪律（#31）：op 走每请求短连接（连接→请求→关闭），帧携带 daemon epoch（I12）。
 * epoch 发现约定：<socketPath>.epoch 旁车文件（daemon bootstrap 写入；票 38 对齐点），
 * 缺失按 0 处理——I12 会静默拒帧，表现为响应超时，错误文案指向旁车文件。
 *
 * 票 37 韧性（相互独立，不混用）：
 *  - 惰性拉起：首操作 daemon 未运行（连接失败）→ launcher 拉起 daemon 再重试（每请求至多一次）。
 *  - op 短连接有限重试：每请求至多 MAX_OP_ATTEMPTS=3 次尝试（spec 自定裁量），固定间隔；
 *    与 wake 长连接指数退避、kernel Intent 消费重试三者相互独立。
 *  - daemon 业务错误（RpcError）不重试：错误文案已列可用选项，重试只会复读。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import {
  connectEvents,
  resolveSocketPath,
  type EventsClient,
} from "pi-events-daemon/transport.ts";
import type { OpName, RpcError } from "pi-events-daemon/protocol.ts";

export interface OpClientConfig {
  socketPath?: string;
  /** 缺省读 <socketPath>.epoch 旁车文件（每请求重读，daemon 重启换代后自动跟上）。 */
  epoch?: number;
  /** 单请求响应超时（缺省 10s）——epoch 静默拒帧的兜底观测面。 */
  timeoutMs?: number;
  /** 短连接每请求尝试上限（spec 自定裁量 3）；缺省 MAX_OP_ATTEMPTS。 */
  maxAttempts?: number;
  /** 惰性拉起器（daemon 未运行时调用一次后重试）；缺省 defaultDaemonLauncher（spawn daemon-main 入口）。 */
  launcher?: () => Promise<void>;
  /** 重试间隔（缺省固定 100ms；测试注入记录器）。 */
  retryDelayMs?: (ms: number) => Promise<void>;
  env?: NodeJS.ProcessEnv;
}

export interface OpClient {
  request(op: OpName, params: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

/** op 短连接每请求尝试上限（#31 round-4 补落：spec 自定裁量 3 次）。 */
export const MAX_OP_ATTEMPTS = 3;
/** 重试固定间隔（非指数——与 wake 退避独立）。 */
export const OP_RETRY_DELAY_MS = 100;

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
  return e !== null && e !== undefined && typeof e.code === "number" && typeof e.message === "string";
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 缺省惰性拉起器：spawn `pi-events-daemon` 包内 daemon-main 入口（detached，PI_EVENTS_SOCK 指向本 socket），
 * 轮询等待 socket 文件出现（≤5s）。入口缺失/拉起超时报错列 remedies（票 38 落地真实入口后即插即用）。
 */
export function defaultDaemonLauncher(socketPath: string, env: NodeJS.ProcessEnv = process.env): () => Promise<void> {
  return async () => {
    const require = createRequire(import.meta.url);
    let entry: string;
    try {
      entry = join(dirname(require.resolve("pi-events-daemon/package.json")), "daemon-main.ts");
    } catch {
      throw new Error(`daemon 拉起失败：pi-events-daemon 包未找到（socket: ${socketPath}）`);
    }
    if (!existsSync(entry)) {
      throw new Error(`daemon 拉起失败：入口缺失 ${entry}（票 38 bootstrap 落地前请手动启动 daemon）`);
    }
    spawn(process.execPath, ["--experimental-strip-types", entry], {
      detached: true,
      stdio: "ignore",
      env: { ...env, PI_EVENTS_SOCK: socketPath },
    }).unref();
    for (let i = 0; i < 50; i++) {
      if (existsSync(socketPath)) return;
      await sleep(100);
    }
    throw new Error(`daemon 拉起超时（socket 未出现）: ${socketPath} — 检查入口日志或手动启动`);
  };
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
  const launcher = cfg.launcher ?? defaultDaemonLauncher(socketPath, cfg.env ?? process.env);
  const delay = cfg.retryDelayMs ?? sleep;

  /** 单次尝试：一条短连接（连接→请求→关闭）。 */
  const once = async (op: OpName, params: Record<string, unknown>): Promise<unknown> => {
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
  };

  return {
    async request(op, params) {
      const maxAttempts = cfg.maxAttempts ?? MAX_OP_ATTEMPTS;
      let lastErr: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          return await once(op, params);
        } catch (err) {
          if (isRpcError(err)) throw err; // 业务错误不重试
          lastErr = err;
          if (attempt >= maxAttempts) break;
          if (attempt === 1) {
            // 惰性拉起：daemon 未运行 → 拉起后重试（拉起失败并入末错误）
            try {
              await launcher();
            } catch (launchErr) {
              lastErr = launchErr;
            }
          } else {
            await delay(OP_RETRY_DELAY_MS);
          }
        }
      }
      const detail = lastErr instanceof Error ? lastErr.message : String(lastErr);
      throw new Error(
        `daemon 不可达（已重试 ${maxAttempts} 次）: ${detail}\n可用选项: 检查 PI_EVENTS_SOCK / ${socketPath}.epoch / 手动启动 daemon`,
      );
    },
    // 每请求短连接：无常驻资源
    async close() {},
  };
}
