/**
 * wake — 常驻长连接收推送 → session 内提示注入（票 36；#31 L146 wake 通道）。
 *
 * 正典边界：
 *  - 长连接建立 = SESSION_START 信号：daemon 侧 drain（parked）+ snapshot（pending）冲刷——
 *    重连 wake snapshot+flush 由 daemon applySessionStart 承载，本模块只负责"断线→退避→重连→再声明"。
 *  - 断线指数退避 2s 起、上限 5min（spec 自定裁量，借用 #31 L2 投递退避数字）；与 op 短连接
 *    有限重试（票 37）、kernel Intent 消费重试三者相互独立，不混用。
 *  - G 档：wake 不保证 exactly-once——notificationId 去重兜底（尽力投递 + 幂等注入）。
 *  - fork no-inherit：fork 会话不建立长连接（transport SESSION_START 注册时决定，零推送）。
 *  - 传输失败兜底：socket 通道不可达 → HarnessFault 通道降级（ui.notify 尽力通知，去重：每次断供只通知一次，票 46），
 *    后台退避重试不放弃（daemon 恢复后自愈回升）。
 *  - batch 呈现（#31）：合流条目 billboard = count + 实体 + verdict；evidence 超 2KB 截断标记。
 */
import { connectEvents, resolveSocketPath, type EventsClient } from "pi-events-daemon/transport.ts";
import { readDaemonEpoch } from "./client.ts";

/** wake 推送行 envelope（daemon loops assembleLine 正典：sessionId 编址 + count + entries）。 */
export interface WakeEntry {
  notificationId: string;
  entityRef: string;
  verdict: string;
  /** 截断前的 evidence 全文（daemon billboard 内联超 2KB 时走 evidence op；envelope 不携带，防御性透传）。 */
  evidence?: string;
  evidenceRef?: string;
}
export interface WakeEnvelope {
  sessionId: string;
  count: number;
  entries: WakeEntry[];
}

/** pi.sendMessage 注入消息形状（注入路径 = followUp，票 36）。 */
export interface WakeInjection {
  customType: string;
  content: string;
  display: boolean;
  details: unknown;
  options: { deliverAs: "followUp"; triggerTurn: boolean };
}

export const WAKE_CUSTOM_TYPE = "pi-events-daemon.wake";
/** 断线退避：2s 起、上限 5min（spec 自定裁量）。 */
export const WAKE_BACKOFF_BASE_MS = 2000;
export const WAKE_BACKOFF_MAX_MS = 5 * 60_000;

/** 第 n 次连续失败的退避时长（0 起）：2000 → 4000 → … → 300000 封顶。 */
export function wakeBackoffMs(consecutiveFailures: number): number {
  return Math.min(WAKE_BACKOFF_BASE_MS * 2 ** Math.max(0, consecutiveFailures), WAKE_BACKOFF_MAX_MS);
}

/** evidence 超 2KB 截断标记（全量走 evidence op，#31 batch 呈现）。 */
export const EVIDENCE_INLINE_LIMIT = 2048;
export function truncateEvidence(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= EVIDENCE_INLINE_LIMIT) return text;
  return `${Buffer.from(text, "utf8").subarray(0, EVIDENCE_INLINE_LIMIT).toString("utf8")}…[截断，用 evidence op 查全文${""}]`;
}

/** 合流条目呈现（billboard = count + 实体 + verdict；evidence 超 2KB 截断标记）。 */
export function renderWakeBatch(entries: readonly WakeEntry[]): string {
  const lines = entries.map((e) => {
    const verdict = e.verdict || "?";
    let line = `- ${e.entityRef} → ${verdict}`;
    if (typeof e.evidence === "string" && e.evidence.length > 0) {
      line += `\n  ${truncateEvidence(e.evidence).replaceAll("\n", "\n  ")}`;
      if (e.evidenceRef) line += `（evidenceRef: ${e.evidenceRef}）`;
    }
    return line;
  });
  return `wake ×${entries.length}:\n${lines.join("\n")}`;
}

export interface WakeDeps {
  /** 本会话 id（SESSION_START 声明 + envelope 编址过滤）。 */
  sessionId: string;
  /** fork 会话：不建立长连接（no-inherit，零推送）。 */
  fork?: boolean;
  socketPath?: string;
  env?: NodeJS.ProcessEnv;
  /** session 内提示注入（index.ts 绑 pi.sendMessage）。 */
  inject: (message: WakeInjection) => void;
  /** HarnessFault 降级通知面（index.ts 绑 ctx.ui.notify）。去重：每次断供只通知一次（票 46）。 */
  notify: (message: string, type?: "info" | "warning" | "error") => void;
  /** 连接沿回调（票 46）：建立 true / 断连或连接失败 false——footer 状态位消费。 */
  onEdge?: (connected: boolean) => void;
  /** 退避等待（缺省真延时；测试注入即时返回并记录节拍）。 */
  sleep?: (ms: number) => Promise<void>;
}

export interface WakeHandle {
  stop(): Promise<void>;
  /** 连接尝试次数（诊断面）。 */
  attempts(): number;
  isConnected(): boolean;
  /** 已去重入账的 notificationId 数。 */
  seenCount(): number;
}

export function startWake(deps: WakeDeps): WakeHandle {
  let cancelSleep: (() => void) | null = null;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    cancelSleep = () => {
      clearTimeout(timer); // 评审 M：stop 清退避计时器——不拖住宿主进程退出
      resolve(); // 已 resolve 的再 resolve 无害；循环醒来后由 while(!stopped) 退出
    };
  }));
  const socketPath = deps.socketPath ?? resolveSocketPath(deps.env ?? process.env);
  const seen = new Set<string>();

  let stopped = false;
  let attempts = 0;
  let connected = false;
  let degraded = false; // 降级通知去重位（票 46）
  let client: EventsClient | null = null;
  let closeWait: Promise<void> | null = null;

  /** envelope 消费：目标编址过滤 → notificationId 去重 → batch 注入。 */
  const onWake = (params: unknown): void => {
    const envelope = params as WakeEnvelope;
    if (!envelope || envelope.sessionId !== deps.sessionId) return; // 编址过滤（评审 H4 接收端）
    const fresh = (envelope.entries ?? []).filter((e) => e?.notificationId && !seen.has(e.notificationId));
    for (const e of fresh) seen.add(e.notificationId);
    if (fresh.length === 0) return;
    deps.inject({
      customType: WAKE_CUSTOM_TYPE,
      content: renderWakeBatch(fresh),
      display: true,
      details: { entries: fresh, sessionId: envelope.sessionId },
      options: { deliverAs: "followUp", triggerTurn: true },
    });
  };

  const loop = async (): Promise<void> => {
    if (deps.fork) return; // fork no-inherit：子会话不建立长连接（注册时决定，零推送）
    let failures = 0;
    while (!stopped) {
      attempts++;
      try {
        client = await connectEvents(socketPath, { epoch: readDaemonEpoch(socketPath) });
        if (stopped) {
          // 评审 H：stop 竞态守卫——连接完成时已停摆 → 立即关闭，不注册旧 session/注入回调
          await client.close();
          client = null;
          return;
        }
        connected = true;
        failures = 0; // 传输恢复：退避归位
        degraded = false; // 去重复位：下次断供重新通知（票 46）
        deps.onEdge?.(true);
        client.onNotification((method, params) => {
          if (method === "wake") onWake(params);
        });
        client.startSession(deps.sessionId); // 长连接建立 = SESSION_START（含重连 snapshot 冲刷）
        closeWait = new Promise<void>((resolveClose) => client!.onClose(resolveClose));
        await closeWait;
        connected = false;
        client = null;
        deps.onEdge?.(false);
        if (stopped) return;
      } catch {
        connected = false;
        client = null;
        deps.onEdge?.(false);
        if (stopped) return;
      }
      // 断连/连接失败：降级提示（票 46 去重：每次断供只通知一次，恢复后复位），退避后重试
      if (!degraded) {
        degraded = true;
        deps.notify(
          `pi-events-daemon: wake 通道降级（socket ${socketPath} 不可达）——推送暂不可达，后台重试中`,
          "warning",
        );
      }
      await sleep(wakeBackoffMs(failures));
      failures++;
    }
  };
  void loop();

  return {
    stop: async () => {
      stopped = true;
      cancelSleep?.();
      try {
        await client?.close();
      } catch {
        /* 已断连即目标状态 */
      }
    },
    attempts: () => attempts,
    isConnected: () => connected,
    seenCount: () => seen.size,
  };
}
