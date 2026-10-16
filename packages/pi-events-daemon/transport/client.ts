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
  close(): Promise<void>;
}

export function connectEvents(path: string, opts: { epoch: number }): Promise<EventsClient> {
  const pending = new Map<RequestId, { resolve: (v: unknown) => void; reject: (e: RpcError) => void }>();
  let nextId = 0;
  let notificationHandler: ((method: string, params: unknown) => void) | null = null;
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

  const client: EventsClient = {
    request(op, params) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.write(encodeRequest(id, op, params, opts.epoch) + "\n");
      });
    },
    startSession(sessionId) {
      socket.write(encodeSessionStart(sessionId) + "\n");
    },
    onNotification(handler) {
      notificationHandler = handler;
    },
    close() {
      return new Promise((resolve) => {
        socket.once("close", () => resolve());
        socket.destroy();
      });
    },
  };
  return new Promise((resolve, reject) => {
    let settled = false;
    socket.on("connect", () => {
      settled = true;
      resolve(client);
    });
    socket.on("error", (err) => {
      const error: RpcError = { code: -32000, message: err.message };
      for (const p of pending.values()) p.reject(error);
      pending.clear();
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}
