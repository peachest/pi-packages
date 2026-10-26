/**
 * pane-render — 订阅面板纯渲染面（票 44，herdr plugin open-subscriptions）。
 *
 * 无 IO、无依赖：query op 返回体的订阅行明细 → session 分组文本面板。
 * bin/subscriptions-pane.ts（pane 进程）与 tests/pane-render.test.ts 同消费；
 * session 过滤随 query op 侧完成，这里只做视图裁剪与排版。
 */

/** query 响应 subscriptions 行（wire 形态，protocol QuerySubscription 同构）。 */
export interface WireSubscription {
  subscriptionId: string;
  sessionId: string;
  entityRef: string;
  state: string | null;
  origin: "session" | "auto";
  template?: string;
  check?: string;
  on?: string | string[];
  once?: boolean;
  flip?: boolean;
  readyCheck?: string;
  thresholds?: { failureThreshold: number; successThreshold: number };
  phase?: "startup" | "flip";
  schedule?: { type: "interval"; intervalMs?: number } | { type: "cron"; cron?: string; tz?: string };
  lastProbedAt?: string;
  backlog?: number;
  createdAt: string;
}

/** 面板数据快照（bin 层组装；lastEdgeAt = 最近一次 Transitioned 沿到达时刻）。 */
export interface PanelData {
  subs: WireSubscription[];
  deadLetters: number;
  connected: boolean;
  epoch: number | null;
  lastEdgeAt: number | null;
}

export type ViewMode = "all" | "self";

/** 视图裁剪：self = 仅本 session（open-subscriptions action 解析焦点 pane 所得）。 */
export function visibleSubs(data: PanelData, view: ViewMode, selfSession: string | null): WireSubscription[] {
  if (view === "all" || !selfSession) return data.subs;
  return data.subs.filter((s) => s.sessionId === selfSession);
}

/** session 分组（组序 = sessionId 字典序；行序随 query 返回序 = store 序）。 */
export function groupBySession(subs: readonly WireSubscription[]): { sessionId: string; subs: WireSubscription[] }[] {
  const groups = new Map<string, WireSubscription[]>();
  for (const s of subs) {
    const bucket = groups.get(s.sessionId);
    if (bucket) bucket.push(s);
    else groups.set(s.sessionId, [s]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([sessionId, rows]) => ({ sessionId, subs: rows }));
}

/** 相对时间（"12s ago" / "3m ago" / "—"）。 */
export function relativeTime(iso: string | undefined, now: number): string {
  if (!iso) return "—";
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

/** 槽节奏摘要（"60s" / "cron 0 * * *" / "—"）。 */
export function scheduleBrief(s: WireSubscription): string {
  const sch = s.schedule;
  if (!sch) return "—";
  if (sch.type === "interval") {
    const ms = sch.intervalMs ?? 0;
    return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
  }
  return `cron ${sch.cron ?? "?"}`;
}

/** 谓词摘要：on 集合 / once / flip 标记。 */
export function onBrief(s: WireSubscription): string {
  const on = s.on === undefined ? "any" : Array.isArray(s.on) ? `[${s.on.join(",")}]` : s.on;
  const flags = [s.once ? "once" : null, s.flip ? "flip" : null].filter(Boolean).join("+");
  return flags ? `${on} ${flags}` : on;
}

/** 单订阅行（一条 = 一个订阅；状态位沿用 daemon 三态图标语义 ● 活跃态/○ 无态）。 */
export function formatSub(s: WireSubscription, now: number): string {
  const state = s.state ?? "○ none";
  const thr = s.thresholds ? ` thr ${s.thresholds.failureThreshold}/${s.thresholds.successThreshold}` : "";
  const phase = s.phase ? ` phase=${s.phase}` : "";
  const origin = s.origin === "auto" ? " auto" : "";
  return [
    `${s.subscriptionId}`,
    `${s.entityRef} → ${state}`,
    `on=${onBrief(s)}`,
    `every=${scheduleBrief(s)}${thr}${phase}${origin}`,
    `backlog ${s.backlog ?? 0}`,
    `probe ${relativeTime(s.lastProbedAt, now)}`,
  ].join("  ·  ");
}

/** 整屏渲染（bin 层直接写 stdout；ANSI 清屏由 bin 负责，这里只出文本）。 */
export function renderPanel(
  data: PanelData,
  view: ViewMode,
  selfSession: string | null,
  now: number,
): string {
  const subs = visibleSubs(data, view, selfSession);
  const daemon = data.connected
    ? `● daemon running${data.epoch !== null ? ` epoch ${data.epoch}` : ""}`
    : "✗ daemon unreachable（重连中）";
  const edge = data.lastEdgeAt !== null ? `last edge ${relativeTime(new Date(data.lastEdgeAt).toISOString(), now)}` : "no edge yet";
  const viewLabel = view === "all" || !selfSession ? "all sessions" : `self ${selfSession.slice(0, 8)}`;
  const head = [
    `pi-events subscriptions  [${viewLabel}]  ${subs.length} subs · ${data.deadLetters} dead-letters`,
    `${daemon}  ·  ${edge}  ·  a 视图切换 · r 刷新 · q 退出`,
  ].join("\n");
  const groups = groupBySession(subs);
  const body = groups
    .map((g) => {
      const mark = selfSession && g.sessionId === selfSession ? "◆" : "·";
      const rows = g.subs.map((s) => `    ${formatSub(s, now)}`).join("\n");
      return `${mark} session ${g.sessionId} (${g.subs.length})\n${rows}`;
    })
    .join("\n");
  return groups.length > 0 ? `${head}\n\n${body}\n` : `${head}\n\n  （无订阅——subscribe op 或 .pi/events.json 声明后此处出现）\n`;
}
