#!/usr/bin/env node
/**
 * subscriptions-pane — herdr plugin pane 进程（票 44，open-subscriptions 打开）。
 *
 * 数据源 = daemon query op（订阅行明细，票 44）；刷新 = Transitioned 沿驱动：
 * 连接 daemon 长连接并以合成观察者 session（pane:<id>）声明 SESSION_START——daemon
 * wake 推送是「线路广播 + 接收端 sessionId 过滤」（transport broadcastWake 正典），
 * 合成 session 无订阅不产生投递行，只借广播沿触发重拉，不轮询、不偷真 session 的投递。
 *
 * 线协议正典在 pi-events-daemon/protocol（JSON-RPC 单行帧 + epoch 帧门）；此处
 * 自包含最小实现，因 herdr 插件检出是独立分发单元，不随 repo 包解析（shortcut:
 * 帧形状漂移时本文件需同步——正典漂移由 protocol/index.ts 的测试护栏拦截）。
 *
 * 键位：a 全量/自己视图切换 · r 手动刷新 · q 退出。
 */
import {
  renderPanel,
  type PanelData,
  type ViewMode,
  type WireSubscription,
} from "../pane-render.ts";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import * as net from "node:net";
import * as readline from "node:readline";

// --- 参数与状态目录（action 传入的 cwd 内 session 文件 = 焦点 pane 的 pi session uuid） ---
const args = process.argv.slice(2);
const argOf = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const socketPath = argOf("--socket") ?? process.env.PI_EVENTS_SOCK ?? join(homedir(), ".pi", "run", "pi-events.sock");
const stateFile = argOf("--session-file") ?? join(process.cwd(), "session");
// 优先级：--session > cwd/session 文件 > 无（self 视图无锚自动落全量）
const selfSession = argOf("--session") ?? (existsSync(stateFile) ? readFileSync(stateFile, "utf8").trim() || null : null);

let view: ViewMode = "all";
let selfSessionEffective = selfSession;

const epochOf = (): number | null => {
  try {
    return Number(readFileSync(`${socketPath}.epoch`, "utf8").trim());
  } catch {
    return null;
  }
};

// --- 面板状态 ---
const data: PanelData = { subs: [], deadLetters: 0, connected: false, epoch: null, lastEdgeAt: null };
let reqId = 0;
let client: net.Socket | null = null;
let redrawTimer: NodeJS.Timeout | null = null;

const observerSession = `pane:${process.env.HERDR_PANE_ID ?? randomUUID()}`;

const send = (obj: unknown): void => {
  client?.write(`${JSON.stringify(obj)}\n`);
};

const draw = (): void => {
  process.stdout.write("\x1b[2J\x1b[H");
  process.stdout.write(renderPanel(data, view, selfSessionEffective, Date.now()));
};

/** 沿驱动重拉（100ms 去抖：一批合流推送只触发一次 query）。 */
const scheduleRefresh = (): void => {
  if (redrawTimer) return;
  redrawTimer = setTimeout(() => {
    redrawTimer = null;
    refresh();
  }, 100);
};

const refresh = (): void => {
  if (!client) return;
  const params: Record<string, unknown> = view === "self" && selfSessionEffective ? { session: selfSessionEffective } : {};
  send({ jsonrpc: "2.0", id: ++reqId, method: "query", params, epoch: epochOf() ?? 0 });
};

const connect = (): void => {
  const sock = net.connect(socketPath);
  client = sock;
  let buffer = "";
  sock.setEncoding("utf8");
  sock.on("connect", () => {
    data.connected = true;
    data.epoch = epochOf();
    // 合成观察者声明：daemon 侧 drain(空)+snapshot(空) 无副作用；此后收广播沿。
    send({ jsonrpc: "2.0", method: "session_start", params: { sessionId: observerSession } });
    refresh();
    draw();
  });
  sock.on("data", (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // 畸形帧跳过（protocol 同纪律）
      }
      if (frame.method !== undefined) {
        // 通知行：wake（Transitioned 沿）——登记沿时刻，去抖重拉
        data.lastEdgeAt = Date.now();
        scheduleRefresh();
      } else if (frame.id !== undefined && frame.result !== undefined) {
        const result = frame.result as { entities?: unknown[]; deadLetters?: unknown[]; subscriptions?: WireSubscription[] };
        data.subs = result.subscriptions ?? [];
        data.deadLetters = result.deadLetters?.length ?? 0;
        draw();
      }
    }
  });
  const retry = (): void => {
    if (client !== sock) return; // 已被新连接替换
    client = null;
    data.connected = false;
    draw();
    setTimeout(connect, 2000);
  };
  sock.on("close", retry);
  sock.on("error", retry);
};

// --- 键位（raw mode；pane 是终端面） ---
readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on("keypress", (_str: string, key: { name?: string; ctrl?: boolean; sequence?: string }) => {
  if (!key) return;
  if (key.ctrl && key.name === "c") return quit();
  if (key.name === "q") return quit();
  if (key.name === "a") {
    view = view === "all" ? "self" : "all";
    if (view === "self" && !selfSessionEffective) view = "all"; // 无锚 session 无 self 视图
    refresh();
    return;
  }
  if (key.name === "r") refresh();
});
const quit = (): void => {
  client?.destroy();
  process.exit(0);
};

connect();
