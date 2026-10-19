/**
 * pi-events-daemon-extension — agent 入口（#31 extension 模块，票 34-37）。
 *
 * 独立 pi 包（仓规 `pi install ./packages/pi-events-daemon-extension`，docs/agents/install-packages.md）。
 * 入口 index.ts 唯一公共面：默认导出 = pi extension 工具工厂；命名导出 = 票 34-37 的
 * 可单测面（schema 校验 / 工具面 / op 客户端 / events.json 声明链 / wake / batch 呈现）。
 * 实现藏 lib/（包内私有）；协议与契约 schema 经 pi-events-daemon 包根入口同源消费，零复制。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
import {
  createFooterStatus,
  probeDaemonStatus,
  statusFromTransportFailure,
} from "./lib/footer.ts";
import { isRpcError } from "./lib/client.ts";
import { resolveSocketPath } from "pi-events-daemon/transport.ts";
import type { ProfileRegistry } from "pi-events-daemon/profiles.ts";

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
  const socketPath = deps.socketPath ?? resolveSocketPath();
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

  for (const tool of buildToolDefs({ opSchema, sender: senderWithFooter })) {
    // 同源 JSON Schema（无 TypeBox Kind 符号）→ pi 以 JSON Schema 路径校验（coerceWithJsonSchema + Compile）；
    // D1a 权威门在 lib/tools execute 内（完整校验客户端先行），此处 cast 仅为注册边界。
    pi.registerTool(tool as unknown as Parameters<ExtensionAPI["registerTool"]>[0]);
  }

  // 票 35 声明链 + 票 36 wake + 票 46 footer（SESSION_START：长连接建立 = SESSION_START 信号，#31）。
  let wake: WakeHandle | null = null;
  pi.on("session_start", (event, ctx) => {
    footer.bind(ctx as never); // wake 断连沿回调引用最新呈现面
    void wake?.stop(); // 评审 H：任何 session_start（含 fork）先退位旧 handle——fork 检查前 stop+清引用，
    wake = null; // 父长连接的注入回调不得活到子会话（no-inherit）
    if (event.reason === "fork") return; // fork no-inherit：子会话不重声明、不建长连接（零推送）
    void (async () => {
      // 零副作用探测先行（不拉起 daemon）：probe 结果落后于并发 op 副作用的窗口极小
      // （probe 只读 socket 存在性 + 一次握手），可接受（票 46）。
      footer.set(await probeDaemonStatus(socketPath));
      void declareFromEventsJson(pi, ctx, { sender: senderWithFooter, templatesDir: deps.templatesDir, templates: deps.templates });
    })();
    wake = startWake({
      sessionId: ctx.sessionManager.getSessionId(),
      socketPath: deps.socketPath,
      inject: (message) => pi.sendMessage(message, message.options),
      notify: (message, type) => ctx.ui.notify(message, type),
      onEdge: (connected) => {
        // wake 连接沿 → footer 刷新（notify 降级详情由 wake 自身去重，一次性）
        footer.set(connected ? "running" : statusFromTransportFailure(socketPath));
      },
    });
  });
  pi.on("session_shutdown", () => {
    void wake?.stop();
    wake = null;
  });
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
export type { JsonSchema, Issue } from "./lib/schema.ts";
export { buildToolDefs } from "./lib/tools.ts";
export type { OpToolDef, OpSender, ToolResult } from "./lib/tools.ts";
export { createOpClient, readDaemonEpoch, defaultDaemonLauncher, MAX_OP_ATTEMPTS, OP_RETRY_DELAY_MS } from "./lib/client.ts";
export { DAEMON_STATUS_KEY, createFooterStatus, probeDaemonStatus, renderDaemonStatus, statusFromTransportFailure } from "./lib/footer.ts";
export type { DaemonStatus, FooterStatus, FooterSurface } from "./lib/footer.ts";
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
