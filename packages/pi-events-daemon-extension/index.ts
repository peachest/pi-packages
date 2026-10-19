/**
 * pi-events-daemon-extension — agent 入口（#31 extension 模块，票 34-37）。
 *
 * 独立 pi 包（仓规 `pi install ./packages/pi-events-daemon-extension`，docs/agents/install-packages.md）。
 * 入口 index.ts 唯一公共面：默认导出 = pi extension 工具工厂；命名导出 = 票 34-37 的
 * 可单测面（schema 校验 / 工具面 / op 客户端 / events.json 声明链 / wake / batch 呈现）。
 * 实现藏 lib/（包内私有）；协议与契约 schema 经 pi-events-daemon 包根入口同源消费，零复制。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadOpSchema, type JsonSchema } from "./lib/schema.ts";
import { buildToolDefs, type OpSender, type OpToolDef } from "./lib/tools.ts";
import { createOpClient } from "./lib/client.ts";
import {
  declareAutoSubscriptions,
  deriveProjectKey,
  daemonTemplatesDir,
  findEventsJson,
  loadTemplates,
  readEventsJson,
} from "./lib/eventsjson.ts";
import { startWake, type WakeHandle } from "./lib/wake.ts";
import type { KeyId } from "@earendil-works/pi-tui";
import { dockHint, fetchSnapshot, parseEdge, recordEdge, type DockSnapshot, type TransitionedEdge } from "./lib/dock.ts";
import { EventsDock } from "./lib/dock-component.ts";
import {
  createFooterStatus,
  probeDaemonStatus,
  statusFromTransportFailure,
} from "./lib/footer.ts";
import { isRpcError } from "./lib/client.ts";
import type { ProfileRegistry } from "pi-events-daemon/profiles.ts";
import { resolveSocketPath } from "pi-events-daemon/transport.ts";

/** 事件 dock 默认快捷键（票 45：bg dock 占 shift+down，本 dock 让位换键；ADR 0009）。 */
const DEFAULT_DOCK_SHORTCUT = "ctrl+alt+e" as const;
/** footer 状态段 key（票 46 的三态状态位用 "pi-events"，dock 订阅计数独立段不互踩）。 */
const DOCK_STATUS_KEY = "pi-events-dock";

/** 工厂注入面（测试替身 / 环境覆盖；缺省全走默认实现）。 */
export interface ExtensionDeps {
  opSchema?: JsonSchema;
  /** 覆盖 op 发送面（不建真实 client）。 */
  sender?: OpSender;
  socketPath?: string;
  epoch?: number;
  timeoutMs?: number;
  /** 模板资产目录覆盖（缺省 = pi-events-daemon 包内 templates/）。 */
  templatesDir?: string;
  /** 模板注册表注入（缺省 loadTemplates(templatesDir)）。 */
  templates?: ProfileRegistry;
  /** 惰性拉起器覆盖（缺省 defaultDaemonLauncher：spawn pi-events-daemon daemon-main 入口）。 */
  launcher?: () => Promise<void>;
  /** 短连接重试间隔覆盖（缺省 100ms 固定）。 */
  retryDelayMs?: (ms: number) => Promise<void>;
  /** 事件 dock 快捷键（票 45；缺省 ctrl+alt+e，传 null 关闭注册，仍可用 /events-dock 命令）。 */
  dockShortcut?: string | null;
}

export default function eventsDaemonExtension(pi: ExtensionAPI, deps: ExtensionDeps = {}): void {
  const opSchema = deps.opSchema ?? loadOpSchema();
  const client = deps.sender
    ? null
    : createOpClient({
        socketPath: deps.socketPath,
        epoch: deps.epoch,
        timeoutMs: deps.timeoutMs,
        launcher: deps.launcher,
        retryDelayMs: deps.retryDelayMs,
      });
  const sender: OpSender = deps.sender ?? ((op, params) => {
    if (!client) throw new Error("op client 未初始化");
    return client.request(op, params);
  });

  // 票 46：footer 状态位（三态沿驱动）。op 副作用刷新——成功/业务错误 = daemon 活着；
  // 传输失败按 socket 存在性归类（消失 = idle 已停，仍在 = down 故障）。
  const footer = createFooterStatus();
  const senderWithFooter: OpSender = async (op, params) => {
    try {
      const result = await sender(op, params);
      footer.set("running");
      return result;
    } catch (err) {
      footer.set(isRpcError(err) ? "running" : statusFromTransportFailure(socketPath));
      throw err;
    }
  };

  // --- 票 45：事件 dock 状态面（footer hint + 弹出面板，sender 基座 = senderWithFooter） ---
  let edges: TransitionedEdge[] = [];
  let lastSnapshot: DockSnapshot | null = null;
  let uiCtx: ExtensionContext | null = null;
  let sessionId = "";
  let hintInFlight = false;
  const socketPath = deps.socketPath ?? resolveSocketPath();

  /** footer hint 刷新（零副作用纪律：无 daemon 接触面时不发请求，此前 hint 不存在）。 */
  const refreshDockHint = async (): Promise<void> => {
    if (!uiCtx || !sessionId || hintInFlight) return;
    hintInFlight = true;
    try {
      lastSnapshot = await fetchSnapshot(senderWithFooter, sessionId, socketPath);
      uiCtx.ui.setStatus(DOCK_STATUS_KEY, dockHint(lastSnapshot));
    } catch {
      if (lastSnapshot) {
        // 沿/op 驱动的刷新失败 = daemon 掉线：降级段（wake 降级 warning 链已另行通知详情）
        uiCtx.ui.setStatus(DOCK_STATUS_KEY, dockHint({ ...lastSnapshot, connected: false }));
      }
    } finally {
      hintInFlight = false;
    }
  };

  /** op 副作用沿：任何 op 成功后刷 hint（subscribe/cancel 等改变订阅面的操作自动跟进）。 */
  const senderWithHint: OpSender = async (op, params) => {
    const res = await senderWithFooter(op, params);
    void refreshDockHint();
    return res;
  };

  const openDock = async (ctx: ExtensionContext): Promise<void> => {
    if (!ctx.hasUI) {
      ctx.ui.notify("事件 dock 需要交互式 TUI（非交互模式用 9 op 工具查询订阅状态）", "warning");
      return;
    }
    uiCtx = ctx;
    // 显式打开是用户动作：允许惰性拉起语义（与 9 op 工具同）；拉取失败面板内降级呈现
    let initial = lastSnapshot;
    try {
      initial = await fetchSnapshot(senderWithFooter, sessionId, socketPath);
      lastSnapshot = initial;
      ctx.ui.setStatus(DOCK_STATUS_KEY, dockHint(initial));
    } catch {
      /* initial 保持旧快照/ null，组件错误行呈现 */
    }
    await ctx.ui.custom<"closed">(
      (tui, theme, _keybindings, done) =>
        new EventsDock(tui, theme, done, {
          fetchSnapshot: () => fetchSnapshot(senderWithFooter, sessionId, socketPath),
          edges: () => edges,
          initial,
        }),
      {
        overlay: true,
        overlayOptions: {
          anchor: "bottom-center",
          width: "96%",
          minWidth: 64,
          maxHeight: "60%",
          margin: { bottom: 1, left: 1, right: 1 },
        },
      },
    );
  };

  for (const tool of buildToolDefs({ opSchema, sender: senderWithHint })) {
    // 同源 JSON Schema（无 TypeBox Kind 符号）→ pi 以 JSON Schema 路径校验（coerceWithJsonSchema + Compile）；
    // D1a 权威门在 lib/tools execute 内（完整校验客户端先行），此处 cast 仅为注册边界。
    pi.registerTool(tool as unknown as Parameters<ExtensionAPI["registerTool"]>[0]);
  }

  // 票 35 声明链 + 票 36 wake（SESSION_START：长连接建立 = SESSION_START 信号，#31）。
  let wake: WakeHandle | null = null;
  pi.on("session_start", (event, ctx) => {
    void wake?.stop(); // 评审 H：任何 session_start（含 fork）先退位旧 handle——fork 检查前 stop+清引用，
    wake = null; // 父长连接的注入回调不得活到子会话（no-inherit）
    uiCtx = ctx;
    sessionId = ctx.sessionManager.getSessionId();
    if (event.reason === "fork") return; // fork no-inherit：子会话不重声明、不建长连接（零推送）
    footer.bind(ctx as never); // wake 断连沿回调引用最新呈现面
    // 零副作用探测先行（不拉起 daemon）：probe 结果落后于并发 op 副作用的窗口极小
    // （probe 只读 socket 存在性 + 一次握手），可接受（票 46）。
    void (async () => {
      footer.set(await probeDaemonStatus(socketPath));
      void declareFromEventsJson(pi, ctx, { sender: senderWithFooter, templatesDir: deps.templatesDir, templates: deps.templates });
    })();
    wake = startWake({
      sessionId,
      socketPath: deps.socketPath,
      inject: (message) => pi.sendMessage(message, message.options),
      notify: (message, type) => ctx.ui.notify(message, type),
      // 票 45：沿广播旁路入账 + 沿驱动 hint 刷新（wake 建连沿 = daemon 可达）。
      onTransitioned: (params) => {
        const edge = parseEdge(params);
        if (!edge) return;
        edges = recordEdge(edges, edge);
        void refreshDockHint();
      },
      onEdge: (connected) => {
        // 票 46 footer 状态位沿 + 票 45 dock hint 刷新（同源连接沿，两个消费面）
        footer.set(connected ? "running" : statusFromTransportFailure(socketPath));
        if (connected) void refreshDockHint();
        else if (lastSnapshot) uiCtx?.ui.setStatus(DOCK_STATUS_KEY, dockHint({ ...lastSnapshot, connected: false }));
      },
    });
  });
  pi.on("session_shutdown", () => {
    void wake?.stop();
    wake = null;
    uiCtx?.ui.setStatus(DOCK_STATUS_KEY, undefined);
    uiCtx = null;
  });

  // 票 45：dock 入口（快捷键让位 bg dock 默认 shift+down，默认 ctrl+alt+e；/events-dock 命令常驻）。
  pi.registerCommand("events-dock", {
    description: "Open pi-events daemon activity dock (subscriptions, transitions, parked)",
    handler: (_args, ctx) => openDock(ctx),
  });
  if (deps.dockShortcut !== null) {
    pi.registerShortcut((deps.dockShortcut ?? DEFAULT_DOCK_SHORTCUT) as KeyId, {
      description: "Open pi-events daemon activity dock",
      handler: (ctx) => openDock(ctx),
    });
  }
}

/** events.json → 启动声明（US-29/30）。任何失败经 ui.notify 呈现，不阻塞 session 启动。 */
async function declareFromEventsJson(
  pi: ExtensionAPI,
  ctx: { cwd: string; ui: { notify(message: string, type?: "info" | "warning" | "error"): void } },
  opts: { sender: OpSender; templatesDir?: string; templates?: ProfileRegistry },
): Promise<void> {
  try {
    const found = findEventsJson(ctx.cwd);
    if (!found) return;
    const doc = readEventsJson(found.path);
    if (!doc.ok) {
      ctx.ui.notify(`pi-events-daemon: ${doc.error}`, "warning");
      return;
    }
    if (doc.subscriptions.length === 0) return;
    const registry = opts.templates ?? loadTemplates(opts.templatesDir);
    const report = await declareAutoSubscriptions(doc.subscriptions, opts.sender, registry);
    if (report.failed.length > 0) {
      const lines = report.failed.map((f) => `- ${f.template}: ${f.error}`).join("\n");
      ctx.ui.notify(`pi-events-daemon: events.json 声明部分失败（${report.declared.length} 成功 / ${report.failed.length} 失败）：\n${lines}`, "warning");
    }
  } catch (err) {
    ctx.ui.notify(`pi-events-daemon: events.json 声明链异常: ${err instanceof Error ? err.message : String(err)}`, "error");
  }
}

// --- 可单测公共面（tests/ 经包根入口消费；deep-module 布局 packages/README.md） ---
export { validateFull, loadOpSchema, loadProfileSchema, loadEventsSchema, daemonSchemasDir } from "./lib/schema.ts";
export { createFooterStatus, probeDaemonStatus, renderDaemonStatus, DAEMON_STATUS_KEY } from "./lib/footer.ts";
export type { DaemonStatus } from "./lib/footer.ts";
export type { JsonSchema, Issue } from "./lib/schema.ts";
export { buildToolDefs } from "./lib/tools.ts";
export type { OpToolDef, OpSender, ToolResult } from "./lib/tools.ts";
export { createOpClient, readDaemonEpoch, defaultDaemonLauncher, MAX_OP_ATTEMPTS, OP_RETRY_DELAY_MS } from "./lib/client.ts";
export type { OpClient, OpClientConfig } from "./lib/client.ts";
export {
  declareAutoSubscriptions,
  daemonTemplatesDir,
  deriveProjectKey,
  findEventsJson,
  loadTemplates,
  readEventsJson,
} from "./lib/eventsjson.ts";
export type { EventsJsonEntry, EventsJsonDoc, DeclareReport } from "./lib/eventsjson.ts";
export {
  startWake,
  wakeBackoffMs,
  renderWakeBatch,
  truncateEvidence,
  WAKE_CUSTOM_TYPE,
  WAKE_BACKOFF_BASE_MS,
  WAKE_BACKOFF_MAX_MS,
  EVIDENCE_INLINE_LIMIT,
} from "./lib/wake.ts";
export type { WakeDeps, WakeHandle, WakeEnvelope, WakeEntry, WakeInjection } from "./lib/wake.ts";
export { dockHint, fetchSnapshot, parseEdge, recordEdge, formatSubRow, formatEdgeLine, EDGE_LOG_LIMIT } from "./lib/dock.ts";
export type { DockSnapshot, TransitionedEdge } from "./lib/dock.ts";
export { EventsDock } from "./lib/dock-component.ts";
export type { EventsDockOptions } from "./lib/dock-component.ts";
