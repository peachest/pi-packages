/**
 * footer — daemon 存活状态位（票 46；#111 简化口径）。
 *
 * 只显示 daemon 活着还是死了，没有更多状态（订阅计数/epoch 留票 45 dock）。
 * 姿势参照 pi-proxy proxy.ts:255-285：STATUS_KEY 常驻 + 沿驱动刷新（同态不重绘）。
 * 图标语言对齐 herdr indicators（dots|symbols 语法）：● running / ○ idle / ✗ down。
 *
 * 零副作用探测：session_start 只读 socket 文件 + 连接握手，不 spawn daemon
 * （惰性拉起语义不变——probe 不持 launcher）。
 */
import { existsSync } from "node:fs";
import { connectEvents, type EventsClient } from "pi-events-daemon/transport.ts";
import { readDaemonEpoch } from "./client.ts";

export const DAEMON_STATUS_KEY = "pi-events";

export type DaemonStatus = "running" | "idle" | "down";

export function renderDaemonStatus(status: DaemonStatus): string {
  if (status === "running") return "● pi-events running";
  if (status === "idle") return "○ pi-events idle";
  return "✗ pi-events down";
}

/** footer 呈现面（pi event ctx 的最小切片，照 pi-proxy refreshFooter 签名）。 */
export interface FooterSurface {
  hasUI: boolean;
  ui: { setStatus(key: string, text: string | undefined): void };
}

export interface FooterStatus {
  /** 绑定呈现面（每个有 ctx 的事件沿重绑，wake 回调用最新面）。 */
  bind(surface: FooterSurface | null): void;
  /** 沿驱动刷新：同态跳过（不重绘 footer）。 */
  set(status: DaemonStatus): void;
  current(): DaemonStatus | null;
}

export function createFooterStatus(): FooterStatus {
  let surface: FooterSurface | null = null;
  let last: DaemonStatus | null = null;
  return {
    bind(s) {
      surface = s && s.hasUI ? s : null;
    },
    set(status) {
      if (!surface || status === last) return;
      last = status;
      surface.ui.setStatus(DAEMON_STATUS_KEY, renderDaemonStatus(status));
    },
    current: () => last,
  };
}

/**
 * 零副作用探测：socket 文件不存在 → idle（未启动，首操作自动拉起，正常现象）；
 * 存在则握手一次（不注册 session、不 spawn）→ running / down。
 */
export async function probeDaemonStatus(socketPath: string): Promise<DaemonStatus> {
  if (!existsSync(socketPath)) return "idle";
  let client: EventsClient | null = null;
  try {
    client = await connectEvents(socketPath, { epoch: readDaemonEpoch(socketPath) });
    return "running";
  } catch {
    return "down";
  } finally {
    await client?.close();
  }
}

/** 传输失败后的状态归类：socket 已消失 → idle（已停），仍在 → down（故障）。 */
export function statusFromTransportFailure(socketPath: string): DaemonStatus {
  return existsSync(socketPath) ? "down" : "idle";
}
