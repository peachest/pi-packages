import * as net from "node:net";
import { unlinkSync } from "node:fs";
import type { Pusher } from "./types.ts";

/** 真推送薄 adapter：unix socket 常驻监听，push 逐行广播给已连接 wake 客户端（daemon=服务端，extension 连入）。 */
export class SocketPusher implements Pusher {
  private readonly server: net.Server;
  private readonly clients = new Set<net.Socket>();
  private listenError: Error | null = null;

  constructor(socketPath: string) {
    // daemon kill 自愈前置：异常退出遗留的 socket 文件会让 listen 报 EADDRINUSE
    try {
      unlinkSync(socketPath);
    } catch {
      /* 不存在即目标状态 */
    }
    this.server = net.createServer((socket) => {
      this.clients.add(socket);
      socket.on("close", () => this.clients.delete(socket));
      socket.on("error", () => this.clients.delete(socket));
    });
    this.server.on("error", (err) => {
      this.listenError = err;
    });
    this.server.listen(socketPath);
  }

  push(line: string): Promise<void> {
    if (this.listenError) return Promise.reject(this.listenError);
    const sockets = [...this.clients];
    if (sockets.length === 0) return Promise.resolve(); // 无已连接客户端：本层无写对象；pending/snapshot+flush 语义归 transport/loops
    return new Promise((resolve, reject) => {
      let pending = sockets.length;
      let failed = false;
      for (const socket of sockets) {
        socket.write(line + "\n", (err) => {
          if (err && !failed) {
            failed = true;
            reject(err);
            return;
          }
          if (!failed && --pending === 0) resolve();
        });
      }
    });
  }

  close(): Promise<void> {
    for (const socket of this.clients) socket.destroy();
    this.clients.clear();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}
