/**
 * EventsDock — 事件 dock 终端组件（票 45）：ctx.ui.custom 弹出面板。
 *
 * 交互姿势与 pi-background-tasks 的 bg dock 同构（registerShortcut → ctx.ui.custom overlay →
 * setStatus footer hint），实现独立——共用评估结论见 ADR 0009（不共用骨架，只对齐姿势）。
 * 内容：daemon 连接状态（socket/epoch）+ 本 session 订阅明细（票 44 query 形态）+ parked/dlq
 * 计数 + 最近 Transitioned 沿（票 44 沿广播）。r 刷新 / up-down 移选 / q·esc 关闭。
 * 刷新 = 沿驱动（wake onTransitioned 回调重建快照）+ r 手动；面板自身零轮询。
 */
import { matchesKey, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { dockHint, formatEdgeLine, formatSubRow, type DockSnapshot, type TransitionedEdge } from "./dock.ts";

const VISIBLE_SUB_ROWS = 10;
const VISIBLE_EDGE_LINES = 6;

export interface EventsDockOptions {
  /** 快照拉取（沿到达 / r 键调用；实现方注入真 sender，组件不做传输）。 */
  fetchSnapshot: () => Promise<DockSnapshot>;
  /** 沿日志只读视图（wake onTransitioned 已在 extension 层入账）。 */
  edges: () => readonly TransitionedEdge[];
  /** 打开时的初始快照（extension 层已拉好；组件再异步刷新覆盖）。 */
  initial: DockSnapshot | null;
}

export class EventsDock implements Component {
  private snapshot: DockSnapshot | null;
  private error: string | undefined;
  private loading = false;
  private selectedIndex = 0;
  private scrollTop = 0;

  constructor(
    private readonly tui: Pick<TUI, "requestRender">,
    private readonly theme: Theme,
    private readonly done: (result: "closed") => void,
    private readonly options: EventsDockOptions,
  ) {
    this.snapshot = options.initial;
    void this.refresh();
  }

  invalidate(): void {
    this.tui.requestRender();
  }

  dispose(): void {}

  handleInput(data: string): void {
    this.error = undefined;
    if (matchesKey(data, "escape") || data === "q" || data === "Q") {
      this.done("closed");
      return;
    }
    if (data === "r" || data === "R") {
      void this.refresh();
      return;
    }
    const rows = this.snapshot?.subs ?? [];
    if (matchesKey(data, "up")) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.ensureVisible();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "down")) {
      this.selectedIndex = Math.min(Math.max(0, rows.length - 1), this.selectedIndex + 1);
      this.ensureVisible();
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    const w = Math.max(2, width);
    const dim = (t: string) => this.theme.fg("dim", t);
    const accent = (t: string) => this.theme.fg("accent", t);
    const lines: string[] = [];

    const snap = this.snapshot;
    lines.push(accent(" pi-events dock "));
    if (!snap) {
      lines.push(dim("  加载中…"));
    } else {
      const daemon = `daemon ${snap.connected ? "reachable" : "unreachable"} · socket ${snap.socketPath} · epoch ${snap.epoch}`;
      lines.push(dim(truncateToWidth(` ${daemon}`, w)));
      lines.push("");
      lines.push(sectionHeader(this.theme, ` subscriptions (${snap.subs.length}) · parked ${snap.parkedTotal} · dlq ${snap.deadLetters}`, w));
      if (snap.subs.length === 0) {
        lines.push(dim("  （本 session 无订阅——subscribe op 或 .pi/events.json 声明后出现）"));
      } else {
        const window = snap.subs.slice(this.scrollTop, this.scrollTop + VISIBLE_SUB_ROWS);
        window.forEach((s, i) => {
          const actual = this.scrollTop + i;
          const text = formatSubRow(s);
          const line = actual === this.selectedIndex
            ? this.theme.fg("accent", `▸ ${text}`)
            : `  ${text}`;
          lines.push(truncateToWidth(line, w));
        });
        if (snap.subs.length > VISIBLE_SUB_ROWS) {
          lines.push(dim(`  … ${snap.subs.length - VISIBLE_SUB_ROWS} more（up/down 滚动）`));
        }
      }
      const edges = this.options.edges();
      lines.push("");
      lines.push(sectionHeader(this.theme, ` recent transitions (${edges.length})`, w));
      if (edges.length === 0) {
        lines.push(dim("  （暂无沿——Transitioned 事件经 wake 通道到达后自动刷新）"));
      } else {
        for (const e of edges.slice(-VISIBLE_EDGE_LINES).reverse()) {
          lines.push(dim(truncateToWidth(` ${formatEdgeLine(e)}`, w)));
        }
      }
    }
    if (this.loading) lines.push(dim("  刷新中…"));
    if (this.error) lines.push(this.theme.fg("error", truncateToWidth(` ${this.error}`, w)));
    lines.push("");
    lines.push(dim(truncateToWidth(" r 刷新 · up/down 选择 · q/esc 关闭", w)));
    return lines;
  }

  /** 沿到达 / r 键刷新：失败不关闭面板，错误行内呈现（下一沿或 r 可恢复）。 */
  private async refresh(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.tui.requestRender();
    try {
      const snap = await this.options.fetchSnapshot();
      this.snapshot = snap;
      this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, snap.subs.length - 1));
      this.ensureVisible();
    } catch (err) {
      this.error = `daemon 不可达: ${err instanceof Error ? err.message : String(err)}`;
      if (this.snapshot) this.snapshot = { ...this.snapshot, connected: false };
    } finally {
      this.loading = false;
      this.tui.requestRender();
    }
  }

  private ensureVisible(): void {
    if (this.selectedIndex < this.scrollTop) this.scrollTop = this.selectedIndex;
    else if (this.selectedIndex >= this.scrollTop + VISIBLE_SUB_ROWS) {
      this.scrollTop = this.selectedIndex - VISIBLE_SUB_ROWS + 1;
    }
  }
}

/** 节标题（小写弱化，theme.accent 不存在时退回默认色的安全面——theme.fg 语义 token 恒可用）。 */
function sectionHeader(theme: Theme, text: string, width: number): string {
  const line = truncateToWidth(text, width);
  return theme.fg("accent", line);
}
