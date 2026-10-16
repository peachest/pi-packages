/**
 * client — JSON-RPC socket 客户端壳（票 29 联测交付，extension/daemon-main 复用）。
 * 只做帧收发与请求 id 配对（C 层链路驱动面，#31），不承载业务与重连策略。
 */
import * as net from "node:net";
import {
  decodeLine,
  encodeRequest,
  encodeSessionStart,
  type OpName,
  type RequestId,
  type RpcError,
} from "../protocol/index.ts";

export interface EventsClient {
  /** op 请求（帧携带 epoch，I12）：resolve=result，reject=RpcError。 */
  request(op: OpName, params: Record<string, unknown>): Promise<unknown>;
  /** 长连接声明（长连接建立 = SESSION_START 信号）：此后本连接收推送。 */
  startSession(sessionId: string): void;
  /** daemon 推送行监听。 */
  onNotification(handler: (method: string, params: unknown) => void): void;
  /** 断连回调（连接关闭即触发一次；wake 重连循环消费，票 36）。 */
  onClose(handler: () => void): void;
  /** 未决（已发未答）请求数：诊断面，pending 生命周期可观测。 */
  pendingCount(): number;
  close(): Promise<void>;
}

export function connectEvents(path: string, opts: { epoch: number }): Promise<EventsClient> {
  const pending = new Map<RequestId, { resolve: (v: unknown) => void; reject: (e: RpcError) => void }>();
  let nextId = 0;
  let notificationHandler: ((method: string, params: unknown) => void) | null = null;
  let closeHandler: (() => void) | null = null;
  let closed: Promise<void> | null = null;
  const socket = net.connect(path);
  socket.setEncoding("utf8");

  let buffer = "";
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    for (let idx = buffer.indexOf("\n"); idx >= 0; idx = buffer.indexOf("\n")) {
      const frame = decodeLine(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 1);
      if (!frame) continue;
      if (frame.kind === "op-response") {
        const p = pending.get(frame.id);
        if (p) {
          pending.delete(frame.id);
          if (frame.error === undefined) p.resolve(frame.result);
          else p.reject(frame.error);
        }
      } else if (frame.kind === "notification") {
        notificationHandler?.(frame.method, frame.params);
      }
    }
  });

  // close 即终态：正常断连（对端 destroy）没有 error 事件——pending 必须清算，否则永久悬挂
  socket.on("close", () => {
    const error: RpcError = { code: -32000, message: "connection closed", phase: "transport" };
    for (const p of pending.values()) p.reject(error);
    pending.clear();
    closeHandler?.();
  });

  const client: EventsClient = {
    request(op, params) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        let line: string;
        try {
          line = encodeRequest(id, op, params, opts.epoch); // 先序列化：失败时 reject 且不入 pending（不残留泄漏）
        } catch (err) {
          reject(err);
          return;
        }
        pending.set(id, { resolve, reject });
        socket.write(line + "\n");
      });
    },
    startSession(sessionId) {
      socket.write(encodeSessionStart(sessionId) + "\n");
    },
    onNotification(handler) {
      notificationHandler = handler;
    },
    onClose(handler) {
      closeHandler = handler;
    },
    pendingCount: () => pending.size,
    close() {
      // 复用同一 shutdown promise：二次调用/对端已断连（close 已过，once 永不触发）都不得悬挂
      return (closed ??= socket.destroyed
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            socket.once("close", () => resolve());
            socket.destroy();
          }));
    },
  };
  return new Promise((resolve, reject) => {
    let settled = false;
    socket.on("connect", () => {
      settled = true;
      resolve(client);
    });
    socket.on("error", (err) => {
      const error: RpcError = { code: -32000, message: err.message, phase: "transport" };
      for (const p of pending.values()) p.reject(error);
      pending.clear();
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}
