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
  close(): Promise<void>;
  /** daemon 推送行：广播给全部已注册（SESSION_START）长连接。 */
  broadcastWake(method: string, params: unknown): void;
  /** I12 计数：epoch 不匹配被静默拒的帧数。 */
  epochMismatches(): number;
}

/** 断连后迟到写（EPIPE）不得炸进程：socket 已死即丢（尽力投递语义归上层）。 */
function writeLine(socket: net.Socket, line: string): void {
  if (!socket.destroyed) socket.write(line + "\n");
}

export function serve(path: string, handlers: TransportHandlers): TransportHandle {
  // 遗留 socket 文件先清（fx SocketPusher 同款先例）：异常退出残留会让 listen 报 EADDRINUSE
  try {
    unlinkSync(path);
  } catch {
    /* 不存在即目标状态 */
  }

  let mismatches = 0;
  /** 全部连接（含未注册会话的短连接）：value = 已注册 sessionId | null。 */
  const connections = new Map<net.Socket, string | null>();

  const server = net.createServer((socket) => {
    connections.set(socket, null);
    socket.setEncoding("utf8");
    let sessionId: string | null = null;
    let buffer = "";

    const handleLine = (line: string): void => {
      const frame = decodeLine(line);
      if (!frame) return; // 畸形帧跳过不崩（帧型判定唯一依据 = protocol）
      switch (frame.kind) {
        case "op-request": {
          // I12：帧携带 daemon epoch，不匹配（含缺省）静默拒+计数——不回错误、不断连
          if (frame.epoch !== handlers.getEpoch()) {
            mismatches++;
            return;
          }
          // .then 包装：dispatch 同步 throw 也归入 rejection 路径（不炸 socket data 回调）
          void Promise.resolve()
            .then(() => handlers.dispatch(frame))
            .then(
            (result) => writeLine(socket, encodeResult(frame.id, result === undefined ? null : result)),
            (err: unknown) => {
              const e = err as Partial<RpcError> | null;
              const error: RpcError =
                e !== null && typeof e.code === "number" && typeof e.message === "string"
                  ? { code: e.code, message: e.message }
                  : { code: -32603, message: `internal error: ${String((err as Error)?.message ?? err)}` };
              writeLine(socket, encodeError(frame.id, error));
            },
          );
          return;
        }
        case "session-start": {
          if (sessionId !== null) return; // 一连接一会话：重复声明忽略
          sessionId = frame.sessionId;
          connections.set(socket, frame.sessionId);
          handlers.onSessionStart?.(frame.sessionId, (method, params) =>
            writeLine(socket, encodeNotification(method, params)),
          );
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
    });
    socket.on("close", () => {
      connections.delete(socket);
      if (sessionId !== null) handlers.onSessionEnd?.(sessionId); // 断连 = 注销
    });
    socket.on("error", () => socket.destroy()); // 连接级错误只销毁本连接，close 钩子随后注销
  });

  server.listen(path);

  return {
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
      for (const [socket, sid] of connections) {
        if (sid !== null) writeLine(socket, line); // 显式注册才收推送（fork no-inherit 对偶）
      }
    },
    epochMismatches: () => mismatches,
  };
}
