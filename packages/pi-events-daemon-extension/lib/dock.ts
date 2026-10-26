/**
 * dock — 事件 dock 数据面（票 45）：本 session 订阅快照 + footer hint 文案 + Transitioned 沿环形日志。
 *
 * 纯逻辑（无 pi/p-tui 依赖）供 EventsDock 组件与单测消费；数据源 = 票 44 query 订阅行明细
 * （session 过滤形态）+ daemon "transitioned" 沿广播（wake 通道旁路，票 44 pushEdge）。
 * 零副作用纪律（对齐票 46）：本模块不主动探测 socket——快照只在已有 daemon 接触面
 * （wake 连接沿 / op 副作用 / 用户显式开 dock）之后拉取。
 */
import { readDaemonEpoch } from "./client.ts";
import type { OpSender } from "./tools.ts";
import type { QuerySubscription } from "pi-events-daemon/protocol.ts";

/** daemon "transitioned" 沿（daemon-main pushEdge 正典形状）。 */
export interface TransitionedEdge {
  entityRef: string;
  from: string | null;
  to: string;
  eventSeq: number;
  /** 本地接收时刻（ms，展示用，非事件域字段）。 */
  receivedAt: number;
}

/** 沿环形日志容量（面板尾部展示最近 N 条；沿是刷新触发非投递，超容量丢弃无语义损失）。 */
export const EDGE_LOG_LIMIT = 12;

/** 追加一条沿并封顶（返回新数组，纯函数）。 */
export function recordEdge(log: readonly TransitionedEdge[], edge: TransitionedEdge): TransitionedEdge[] {
  const next = [...log, edge];
  return next.length > EDGE_LOG_LIMIT ? next.slice(next.length - EDGE_LOG_LIMIT) : next;
}

/** daemon "transitioned" 通知 params → 沿（形状不符返回 null，防御广播契约漂移）。 */
export function parseEdge(params: unknown): TransitionedEdge | null {
  const e = params as Partial<TransitionedEdge> | null;
  if (!e || typeof e.entityRef !== "string" || typeof e.to !== "string") return null;
  return {
    entityRef: e.entityRef,
    from: e.from ?? null,
    to: e.to,
    eventSeq: typeof e.eventSeq === "number" ? e.eventSeq : 0,
    receivedAt: Date.now(),
  };
}

/** dock 快照（一次 query 的归一视图）。 */
export interface DockSnapshot {
  connected: boolean;
  socketPath: string;
  epoch: number;
  subs: QuerySubscription[];
  /** parked 投递行合计（session×实体 backlog join 之和）。 */
  parkedTotal: number;
  deadLetters: number;
}

/**
 * 拉取快照：query({session}) 订阅行明细 + epoch 旁车。sender 失败原样上抛（调用方决定降级呈现）。
 * 注意：op 短连接自带惰性拉起——用户显式开 dock 时 daemon 未运行会被拉起（与 9 op 工具同语义）。
 */
export async function fetchSnapshot(sender: OpSender, sessionId: string, socketPath: string): Promise<DockSnapshot> {
  const res = (await sender("query", { session: sessionId })) as {
    entities: unknown[];
    deadLetters: unknown[];
    subscriptions: QuerySubscription[];
  };
  const subs = res.subscriptions ?? [];
  return {
    connected: true,
    socketPath,
    epoch: readDaemonEpoch(socketPath),
    subs,
    parkedTotal: subs.reduce((sum, s) => sum + (s.backlog ?? 0), 0),
    deadLetters: (res.deadLetters ?? []).length,
  };
}

/** footer hint 文案（setStatus "pi-events-dock" 段）。 */
export function dockHint(snap: DockSnapshot | null | undefined): string | undefined {
  if (!snap) return undefined; // 零副作用纪律：本 session 无 daemon 接触前不显示任何段
  if (!snap.connected) return "⏻ events unreachable";
  const parts = [`⏻ ${snap.subs.length} subs · ${snap.parkedTotal} parked`];
  if (snap.deadLetters > 0) parts.push(`${snap.deadLetters} dlq`);
  return parts.join(" · ");
}

/** 订阅行格式化（面板列表行；宽字符安全交给组件层 truncateToWidth，此处产纯文本列）。 */
export function formatSubRow(s: QuerySubscription): string {
  const id = s.subscriptionId.length > 10 ? `${s.subscriptionId.slice(0, 8)}…` : s.subscriptionId;
  const state = s.state ?? "—";
  const on = s.on === undefined ? "" : ` on=${typeof s.on === "string" ? s.on : `[${s.on.join(",")}]`}`;
  const schedule = s.schedule === undefined
    ? ""
    : ` ${s.schedule.type === "interval" ? `every ${s.schedule.intervalMs ?? "?"}ms` : `cron ${s.schedule.cron ?? "?"}`}`;
  const phase = s.phase ? ` ${s.phase}` : "";
  const backlog = s.backlog ? ` backlog=${s.backlog}` : "";
  return `${id}  ${s.entityRef} = ${state}${on}${schedule}${phase}${backlog}`;
}

/** 沿行格式化（面板尾部最近沿）。 */
export function formatEdgeLine(e: TransitionedEdge): string {
  const time = new Date(e.receivedAt).toLocaleTimeString();
  return `${time}  ${e.entityRef} ${e.from ?? "∅"} → ${e.to} (#${e.eventSeq})`;
}
