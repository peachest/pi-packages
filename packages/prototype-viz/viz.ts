/**
 * PROTOTYPE — throwaway. Answers ONE question:
 *
 *   Can a pure pi extension (no fork) deliver a Codex-Visualize-like loop
 *   entirely INSIDE the TUI (remote-dev friendly, no browser)?
 *
 *     /viz        → inline card in the chat transcript: Unicode box diagram
 *                   (always renders) + kitty/iterm2 PNG when the terminal supports it
 *     ctrl+g      → overlay drill-down with live detail preview →
 *                   appends a HIGHLIGHTED replacement card + sendUserMessage() follow-up
 */

import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
	Box,
	Container,
	getCapabilities,
	Image,
	SelectList,
	Text,
	truncateToWidth,
	visibleWidth,
	type SelectItem,
} from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface VizNode {
	id: string;
	label: string;
	detail: string;
}

interface VizData {
	title: string;
	topic: string;
	/** id of the node highlighted by a drill-down (replacement card), if any */
	highlight?: string;
	pngBase64: string;
	nodes: VizNode[];
	edges: [number, number][];
	/** box-grid layout (col/row per node), persisted with the entry */
	grid: { col: number; row: number }[];
	createdAt: number;
}

// ---------------------------------------------------------------------------
// Deterministic fake-architecture generator (seeded by topic hash)
// ---------------------------------------------------------------------------

const NODE_VOCAB: VizNode[] = [
	{ id: "gw", label: "API GATEWAY", detail: "入口层：路由/限流/鉴权转发" },
	{ id: "auth", label: "AUTH SVC", detail: "认证服务：JWT 签发与校验" },
	{ id: "db", label: "USER DB", detail: "用户主库：PostgreSQL 主从" },
	{ id: "cache", label: "REDIS CACHE", detail: "热点缓存：session 与配置" },
	{ id: "mq", label: "MSG QUEUE", detail: "异步解耦：Kafka，阈值 10k" },
	{ id: "worker", label: "WORKER POOL", detail: "后台任务：8 worker 幂等消费" },
	{ id: "oss", label: "OBJECT STORE", detail: "文件存储：S3 兼容，30 天" },
	{ id: "search", label: "SEARCH IDX", detail: "检索：ES 3 分片近实时" },
	{ id: "cdn", label: "CDN EDGE", detail: "静态加速：多 region 边缘" },
	{ id: "obs", label: "OBSERVABILITY", detail: "可观测：metrics/log/trace" },
];

const PALETTE: [number, number, number][] = [
	[76, 122, 168], [89, 161, 79], [242, 142, 43], [176, 122, 161],
	[225, 87, 89], [118, 183, 178], [237, 201, 72], [156, 117, 95],
];

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function lighten(c: [number, number, number], f: number): [number, number, number] {
	return [
		Math.round(255 - (255 - c[0]) * f),
		Math.round(255 - (255 - c[1]) * f),
		Math.round(255 - (255 - c[2]) * f),
	];
}

interface BoxLayout {
	col: number;
	row: number;
}

export function planViz(topic: string): { nodes: VizNode[]; edges: [number, number][]; grid: { col: number; row: number }[] } {
	const seed = createHash("sha256").update(topic).digest().readUInt32BE(0);
	const rnd = mulberry32(seed);

	const count = 5 + (seed % 3);
	const pool = [...NODE_VOCAB];
	const nodes: VizNode[] = [];
	for (let i = 0; i < count && pool.length > 0; i++) {
		nodes.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]!);
	}

	const edges: [number, number][] = [];
	for (let i = 0; i < nodes.length - 1; i++) edges.push([i, i + 1]);
	if (nodes.length > 3) edges.push([Math.floor(rnd() * 2), nodes.length - 1]);
	if (nodes.length > 4) edges.push([nodes.length - 1, 1]);

	const cols = nodes.length <= 3 ? nodes.length : Math.min(3, Math.ceil(nodes.length / 2));
	const grid = nodes.map((_, i) => ({ col: i % cols, row: Math.floor(i / cols) }));
	return { nodes, edges, grid };
}

// ---------------------------------------------------------------------------
// Unicode box diagram — renders in ANY terminal (primary display)
// ---------------------------------------------------------------------------

const BOX_W = 18; // content width 16
const BOX_H = 5;
const GAP = 5; // " ──> " between horizontally adjacent boxes

function fitCell(s: string, w: number): string {
	const t = truncateToWidth(s, w - 1);
	return `${t} ${" ".repeat(Math.max(0, w - 1 - visibleWidth(t)))}`;
}

export function renderAsciiDiagram(
	nodes: VizNode[],
	grid: { col: number; row: number }[],
	highlight: string | undefined,
	theme: Pick<Theme, "fg" | "bold">,
): string[] {
	const cols = Math.max(...grid.map((g) => g.col)) + 1;
	const rows = Math.max(...grid.map((g) => g.row)) + 1;
	const lines: string[] = [];

	for (let r = 0; r < rows; r++) {
		const rowNodes = nodes.map((n, i) => ({ n, g: grid[i]! })).filter(({ g }) => g.row === r);
		const isHi = (n: VizNode) => highlight === n.id;
		const color = (n: VizNode, s: string) =>
			isHi(n) ? theme.fg("accent", s) : theme.fg("dim", s);

		for (let li = 0; li < BOX_H; li++) {
			const cells = rowNodes.map(({ n, g }) => {
				const left = li === 2 && isHi(n) ? "> " : "  ";
				if (li === 0 || li === BOX_H - 1) {
					const bar = "─".repeat(BOX_W);
					return color(n, `${li === 0 ? "┌" : "└"}${bar}${li === 0 ? "┐" : "┘"}`);
				}
				if (li === 1) return color(n, `│${left}${fitCell(theme.bold(n.label), BOX_W - 2)}│`);
				if (li === 2) return color(n, `│ ${fitCell(n.detail, BOX_W - 1)}│`);
				return color(n, `│${" ".repeat(BOX_W)}│`);
			});
			const sep = li === 2 ? " ──> " : " ".repeat(GAP);
			lines.push(cells.join(sep));
		}
		if (r < rows - 1) lines.push("");
	}
	return lines;
}

export function renderEdgeLegend(nodes: VizNode[], edges: [number, number][]): string {
	const short = (n: VizNode) => n.label.split(" ")[0] ?? n.id;
	const text = edges.map(([a, b]) => `${short(nodes[a]!)}>${short(nodes[b]!)}`).join(" ");
	return `edges: ${text}`;
}

// ---------------------------------------------------------------------------
// Minimal PNG encoder (RGB, filter 0) — only shown on kitty/iterm2 terminals
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

function crc32(buf: Buffer): number {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!)!]! ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length, 0);
	const typeB = Buffer.from(type, "ascii");
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([typeB, data])), 0);
	return Buffer.concat([len, typeB, data, crc]);
}

function encodePng(w: number, h: number, rgb: Buffer): Buffer {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	const raw = Buffer.alloc(h * (w * 3 + 1));
	for (let y = 0; y < h; y++) {
		const rowStart = y * (w * 3 + 1);
		raw[rowStart] = 0;
		rgb.copy(raw, rowStart + 1, y * w * 3, (y + 1) * w * 3);
	}
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", deflateSync(raw, { level: 6 })),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

class RgbCanvas {
	readonly w: number;
	readonly h: number;
	private readonly data: Buffer;

	constructor(w: number, h: number, bg: [number, number, number]) {
		this.w = w;
		this.h = h;
		this.data = Buffer.alloc(w * h * 3);
		for (let i = 0; i < w * h; i++) this.data.set(bg, i * 3);
	}

	set(x: number, y: number, c: [number, number, number]): void {
		if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
		this.data.set(c, (y * this.w + x) * 3);
	}

	fillRect(x: number, y: number, w: number, h: number, c: [number, number, number]): void {
		for (let yy = y; yy < y + h; yy++)
			for (let xx = x; xx < x + w; xx++) this.set(xx, yy, c);
	}

	drawRect(x: number, y: number, w: number, h: number, c: [number, number, number]): void {
		for (let xx = x; xx < x + w; xx++) {
			this.set(xx, y, c);
			this.set(xx, y + h - 1, c);
		}
		for (let yy = y; yy < y + h; yy++) {
			this.set(x, yy, c);
			this.set(x + w - 1, yy, c);
		}
	}

	line(x0: number, y0: number, x1: number, y1: number, c: [number, number, number]): void {
		const dx = Math.abs(x1 - x0);
		const dy = Math.abs(y1 - y0);
		const sx = x0 < x1 ? 1 : -1;
		const sy = y0 < y1 ? 1 : -1;
		let err = dx - dy;
		for (;;) {
			this.set(x0, y0, c);
			this.set(x0 + 1, y0, c);
			if (x0 === x1 && y0 === y1) break;
			const e2 = 2 * err;
			if (e2 > -dy) {
				err -= dy;
				x0 += sx;
			}
			if (e2 < dx) {
				err += dx;
				y0 += sy;
			}
		}
	}

	toPng(): Buffer {
		return encodePng(this.w, this.h, this.data);
	}
}

function buildPng(
	nodes: VizNode[],
	grid: BoxLayout[],
	edges: [number, number][],
	highlight: string | undefined,
): string {
	const W = 760;
	const H = 430;
	const boxW = 190;
	const boxH = 78;
	const cols = Math.max(...grid.map((g) => g.col)) + 1;
	const rows = Math.max(...grid.map((g) => g.row)) + 1;
	const gapX = Math.floor((W - cols * boxW) / (cols + 1));
	const gapY = Math.floor((H - rows * boxH) / (rows + 1));
	const rect = (i: number) => {
		const g = grid[i]!;
		return { x: gapX + g.col * (boxW + gapX), y: gapY + g.row * (boxH + gapY), w: boxW, h: boxH };
	};

	const canvas = new RgbCanvas(W, H, [250, 251, 253]);
	const edgeColor: [number, number, number] = [186, 192, 202];
	for (const [a, b] of edges) {
		const ra = rect(a);
		const rb = rect(b);
		canvas.line(
			Math.round(ra.x + ra.w / 2), Math.round(ra.y + ra.h / 2),
			Math.round(rb.x + rb.w / 2), Math.round(rb.y + rb.h / 2),
			edgeColor,
		);
	}
	nodes.forEach((n, i) => {
		const r = rect(i);
		const color = PALETTE[i % PALETTE.length]!;
		const hi = highlight === n.id;
		canvas.fillRect(r.x, r.y, r.w, r.h, lighten(color, hi ? 0.55 : 0.78));
		canvas.drawRect(r.x, r.y, r.w, r.h, color);
		if (hi) canvas.drawRect(r.x + 3, r.y + 3, r.w - 6, r.h - 6, color);
	});
	return canvas.toPng().toString("base64");
}

// ---------------------------------------------------------------------------
// Extension wiring
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let lastViz: VizData | null = null;

	pi.registerEntryRenderer<VizData>("viz-card", (entry, { expanded }, theme) => {
		const data =
			entry.data ?? { title: "?", topic: "?", pngBase64: "", nodes: [], edges: [], grid: [], createdAt: 0 };
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(
			new Text(
				`${theme.fg("accent", theme.bold(`[viz] ${data.title}`))} ${theme.fg("dim", `(${data.nodes.length} nodes)`)}`,
				0,
				0,
			),
		);
		// Primary: Unicode box diagram — works in every terminal, incl. remote dev
		for (const line of renderAsciiDiagram(data.nodes, data.grid, data.highlight, theme)) {
			box.addChild(new Text(line, 0, 0));
		}
		box.addChild(new Text(theme.fg("dim", renderEdgeLegend(data.nodes, data.edges)), 0, 0));
		// Bonus: inline PNG only when the terminal actually supports an image protocol
		if (data.pngBase64 && getCapabilities().images) {
			box.addChild(
				new Image(
					data.pngBase64,
					"image/png",
					{ fallbackColor: (s) => theme.fg("dim", s) },
					{ maxWidthCells: 68, maxHeightCells: 14, filename: "viz.png" },
				),
			);
		}
		box.addChild(
			new Text(theme.fg("dim", "ctrl+g / /vizdrill 键盘下钻 · 展开本条目看节点明细"), 0, 0),
		);
		if (expanded) {
			for (const n of data.nodes) {
				const mark = n.id === data.highlight ? theme.fg("accent", "▶ ") : "  ";
				box.addChild(new Text(`${mark}${theme.fg("muted", `${n.label} — ${n.detail}`)}`, 0, 0));
			}
		}
		return box;
	});

	// Restore last viz on session reload
	pi.on("session_start", (_event, ctx) => {
		try {
			const entries = ctx.sessionManager.getEntries();
			for (let i = entries.length - 1; i >= 0; i--) {
				const e = entries[i]!;
				if (e.type === "custom" && e.customType === "viz-card") {
					lastViz = e.data as VizData;
					break;
				}
			}
		} catch {
			// best-effort restore only
		}
	});

	pi.registerCommand("viz", {
		description: "PROTOTYPE: TUI 内嵌可视化卡片（Unicode 架构图，全程不出终端）",
		handler: async (args, ctx) => {
			const topic = args.trim() || "sample microservice architecture";
			const plan = planViz(topic);
			const data: VizData = {
				title: topic,
				topic,
				pngBase64: buildPng(plan.nodes, plan.grid, plan.edges, undefined),
				nodes: plan.nodes,
				edges: plan.edges,
				grid: plan.grid,
				createdAt: Date.now(),
			};
			lastViz = data;
			pi.appendEntry<VizData>("viz-card", data);
			ctx.ui.notify(
				`viz card 已插入（${plan.nodes.length} 节点）— ctrl+g / /vizdrill 下钻`,
				"info",
			);
		},
	});

	async function drillDown(_args: string, ctx: ExtensionContext): Promise<void> {
		if (!lastViz) {
			ctx.ui.notify("还没有可视化卡片，先运行 /viz <主题>", "warning");
			return;
		}
		const viz = lastViz;
		const grid = viz.grid;
		const items: SelectItem[] = viz.nodes.map((n) => ({
			value: n.id,
			label: n.label,
			description: n.detail,
		}));

		const picked = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(new Text(theme.fg("accent", theme.bold(`下钻：${viz.title}`)), 1, 0));
			const list = new SelectList(items, Math.min(items.length, 10), {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			});
			// Live detail preview while navigating — the TUI-native "hover"
			const detailTitle = new Text(theme.fg("muted", "› ↑↓ 移动查看细节"), 1, 0);
			const detailBody = new Text("", 1, 0);
			list.onSelectionChange = (item) => {
				detailTitle.setText(theme.fg("accent", `› ${item.label}`));
				detailBody.setText(theme.fg("muted", `  ${item.description ?? ""}`));
			};
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(null);
			container.addChild(list);
			container.addChild(detailTitle);
			container.addChild(detailBody);
			container.addChild(new Text(theme.fg("dim", "↑↓ 导航 · enter 选中 · esc 取消"), 1, 0));
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			return {
				render: (w: number) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					list.handleInput(data);
					tui.requestRender();
				},
			};
		}, { overlay: true });

		if (picked) {
			const node = viz.nodes.find((n) => n.id === picked);
			if (node) {
				// Replacement-style card: same deterministic layout, node highlighted
				const replacement: VizData = {
					...viz,
					highlight: node.id,
					pngBase64: buildPng(viz.nodes, grid, viz.edges, node.id),
					createdAt: Date.now(),
				};
				lastViz = replacement;
				pi.appendEntry<VizData>("viz-card", replacement);
				pi.sendUserMessage(
					`[visualize 下钻] 用户在可视化 "${viz.title}" 中选择了节点 "${node.label}"（${node.detail}）。` +
						`请围绕该节点展开说明：职责边界、上下游依赖、关键指标与潜在风险。` +
						`回答结尾提示用户可再次运行 /viz 生成替换式新图。`,
				);
			}
		}
	}

	pi.registerCommand("vizdrill", {
		description: "PROTOTYPE: 键盘下钻最近一张 viz 卡片（overlay 实时预览 + 高亮替换卡片）",
		handler: drillDown,
	});

	pi.registerShortcut("ctrl+g", {
		description: "PROTOTYPE: viz 卡片键盘下钻",
		handler: async (ctx) => {
			await drillDown("", ctx);
		},
	});
}
