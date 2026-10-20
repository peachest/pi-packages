/**
 * transport — socket server adapter（票 05 短帧 op + 票 29 长连接推送）。
 *
 * 薄纪律（模块 spec）：只做连接 accept、帧分流（判定唯一依据 = protocol 帧型）、
 * epoch 校验（I12 执行点）与推送行下发；任何裁决（订阅语义、幂等、错误文案）
 * 归 kernel/loops/extension——本模块不解析 payload 业务字段。
 */
import * as net from "node:net";
import { unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  decodeLine,
  encodeError,
  encodeNotification,
  encodeResult,
  MAX_LINE_LENGTH,
  type OpRequestFrame,
  type RpcError,
} from "../protocol/index.ts";

export * from "./client.ts";

/** socket 路径正典（#31 数据布局）：PI_EVENTS_SOCK env 优先，默认 .pi 运行时目录。 */
export function resolveSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_EVENTS_SOCK ?? join(homedir(), ".pi", "run", "pi-events.sock");
}

/** 短帧 op 处理回调（daemon-main 注入，内部进 L0 队列）；resolve=result，reject→错误响应。 */
export type Dispatch = (frame: OpRequestFrame) => unknown | Promise<unknown>;

export interface TransportHandlers {
  dispatch: Dispatch;
  /** I12：daemon 当前 epoch（daemon-main 启动 flock 仲裁后生成）。 */
  getEpoch: () => number;
  /** SESSION_START（长连接建立 = SESSION_START 信号，#31）→ 注册会话；push 下发该连接的推送行。 */
  onSessionStart?: (sessionId: string, push: (method: string, params: unknown) => void) => void;
  /** 断连 = 注销（无心跳保活：断连即失效，spec 自定裁量）。 */
  onSessionEnd?: (sessionId: string) => void;
}

export interface TransportHandle {
  /** listen 生命周期：listening 时 resolve，listen 失败（ENOENT/EACCES 等）reject——启动失败可观测。 */
  ready: Promise<void>;
  close(): Promise<void>;
  /** daemon 推送行：广播给全部已注册（SESSION_START）长连接；返回实际送达数（成功写的已注册连接数）——
   *  票 38 评审 H：0 = 无人收到，上层不得迁移投递状态（零客户端不假成功）。 */
  broadcastWake(method: string, params: unknown): number;
  /** I12 计数：epoch 不匹配被静默拒的帧数。 */
  epochMismatches(): number;
  /** 慢消费者计数：推送时单连接写积压超限被丢的推送条数。 */
  slowConsumers(): number;
  /** 超长未换行残留被丢弃的次数（接收缓冲上限守卫）。 */
  oversizeLines(): number;
}

/** 单连接推送写积压高水位：超过即丢该条推送并计数（推送尽力而为语义允许丢弃，防单慢客户端拖累 daemon 内存）。 */
const MAX_WRITE_BUFFER = 1024 * 1024;

/** 断连后迟到写（EPIPE）不得炸进程：socket 已死即丢（尽力投递语义归上层）。 */
function writeLine(socket: net.Socket, line: string): void {
  if (!socket.destroyed) socket.write(line + "\n");
}

/** rejection → 线上 RpcError：undefined/null/非 RpcError 形状一律归一（守卫缺口不得外溢为二次异常）。 */
function toRpcError(err: unknown): RpcError {
  const e = err as Partial<RpcError> | null | undefined;
  if (e != null && typeof e.code === "number" && typeof e.message === "string") {
    return { code: e.code, message: e.message };
  }
  return { code: -32603, message: `internal error: ${String((err as Error | null | undefined)?.message ?? err)}` };
}

export function serve(path: string, handlers: TransportHandlers): TransportHandle {
  // 遗留 socket 文件先清（fx SocketPusher 同款先例）：异常退出残留会让 listen 报 EADDRINUSE
  try {
    unlinkSync(path);
  } catch {
    /* 不存在即目标状态 */
  }

  let mismatches = 0;
  /** 推送丢弃计数：单连接写积压超限（慢消费者）被丢的推送条数。 */
  let slowConsumerDrops = 0;
  /** 未终结超长行丢弃计数：接收缓冲上限守卫（decodeLine 上限只覆盖已换行的行）。 */
  let oversizeDrops = 0;
  /** 全部连接（含未注册会话的短连接）：value = 已注册 sessionId | null。 */
  const connections = new Map<net.Socket, string | null>();

  /** 推送行下发（区别于 op 响应的 writeLine）：对端不读导致写积压超高水位 → 丢本条并计数；
   *  对端追上后 writableLength 回落自动恢复，无需显式恢复监听。返回是否实际写出（送达计数的原子判定）。 */
  const pushLine = (socket: net.Socket, line: string): boolean => {
    if (socket.destroyed) return false;
    if (socket.writableLength > MAX_WRITE_BUFFER) {
      slowConsumerDrops++;
      return false;
    }
    socket.write(line + "\n");
    return true;
  };

  const server = net.createServer((socket) => {
    connections.set(socket, null);
    socket.setEncoding("utf8");
    let sessionId: string | null = null;
    let isObserver = false;
    let buffer = "";

    const handleLine = (line: string): void => {
      const frame = decodeLine(line);
      if (!frame) return; // 畸形帧跳过不崩（帧型判定唯一依据 = protocol）
      switch (frame.kind) {
        case "op-request": {
          // I12：帧携带 daemon epoch，不匹配 +计数——带 id 的 op-request 回错误（票 119 #118：
          // 静默拒零补救让调用方只能超时排查；错误带期望 epoch 客户端可立即自愈重连）。
          // 连接不断；epoch 缺省视为不匹配同路径。
          if (frame.epoch !== handlers.getEpoch()) {
            mismatches++;
            writeLine(
              socket,
              encodeError(frame.id, {
                code: -32001,
                message: `epoch mismatch: daemon=${handlers.getEpoch()} frame=${String(frame.epoch)}——重连 socket 取 .sock.epoch 旁车后重发`,
              }),
            );
            return;
          }
          // 票 119（#117）：subscribe 缺省 sessionId = 连接声明（投递归 session）。
          // 显式传入不覆盖；长连接未声明（短连接脚本消费者）保持现状空串；非 subscribe op 不注入。
          if (frame.op === "subscribe") {
            const opts = (frame.params.opts ??= {}) as Record<string, unknown>;
            if (opts.sessionId === undefined && sessionId !== null) opts.sessionId = sessionId;
          }
          // .then 包装：dispatch 同步 throw 也归入 rejection 路径（不炸 socket data 回调）；
          // dispatch 异常（含 reject(undefined)）与 success 序列化（循环引用/BigInt）都归一为配对 error 响应。
          void Promise.resolve()
            .then(() => handlers.dispatch(frame))
            .then(
              (result) => writeLine(socket, encodeResult(frame.id, result === undefined ? null : result)),
              (err: unknown) => writeLine(socket, encodeError(frame.id, toRpcError(err))),
            )
            .catch(() =>
              // success 分支序列化抛错不被同链 rejection 分支捕获：兑底必达配对 error 响应
              writeLine(socket, encodeError(frame.id, { code: -32603, message: "internal error: unserializable result" })),
            );
          return;
        }
        case "session-start": {
          if (sessionId !== null) return; // 一连接一会话：重复声明忽略
          sessionId = frame.sessionId;
          isObserver = frame.observer === true;
          connections.set(socket, frame.sessionId);
          // 票 44 评审 H：observer 连接只注册推送资格（broadcastWake 可达），不进投递活跃面——
          // 若照走 onSessionStart，fanOut auto 编址会给无订阅的观察者持久化投递行，永无 transcript 验证成死账。
          if (!frame.observer) {
            handlers.onSessionStart?.(frame.sessionId, (method, params) =>
              pushLine(socket, encodeNotification(method, params)),
            );
          }
          return;
        }
        case "ack":
        case "notification":
        case "op-response":
          return; // daemon 侧不消费这些帧型（两段式 ack 全链路属票 30），跳过不崩
      }
    };

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (let idx = buffer.indexOf("\n"); idx >= 0; idx = buffer.indexOf("\n")) {
        handleLine(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
      }
      if (buffer.length > MAX_LINE_LENGTH) {
        // 未终结残留即时截断防无界增长（decodeLine 上限只覆盖已换行的行）；截断处无合法行边界，丢弃安全
        buffer = "";
        oversizeDrops++;
      }
    });
    socket.on("close", () => {
      connections.delete(socket);
      if (sessionId !== null && !isObserver) handlers.onSessionEnd?.(sessionId); // 断连 = 注销（observer 无活跃面可注销）
    });
    socket.on("error", () => socket.destroy()); // 连接级错误只销毁本连接，close 钩子随后注销
  });

  const ready = new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject); // listen 失败（ENOENT/EACCES 等）可观测；无监听则 uncaught error
  });
  ready.catch(() => {}); // 无人 await 也不产生 unhandled rejection（await 方仍收到 rejection）
  server.listen(path);

  return {
    ready,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of connections.keys()) socket.destroy();
        connections.clear();
        server.close(() => {
          try {
            unlinkSync(path);
          } catch {
            /* 已被清理即目标状态 */
          }
          resolve();
        });
      }),
    broadcastWake: (method, params) => {
      const line = encodeNotification(method, params);
      let delivered = 0;
      for (const [socket, sid] of connections) {
        if (sid !== null && pushLine(socket, line)) delivered++; // 显式注册才收推送（fork no-inherit 对偶）
      }
      return delivered;
    },
    epochMismatches: () => mismatches,
    slowConsumers: () => slowConsumerDrops,
    oversizeLines: () => oversizeDrops,
  };
}
