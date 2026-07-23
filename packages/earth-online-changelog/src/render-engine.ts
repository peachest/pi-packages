/**
 * Render Engine — Earth Online Changelog
 *
 * Unified rendering engine for patch notes formatting.
 * Pure functions — no I/O, no external module dependencies.
 *
 * All box/card/section component functions guarantee:
 *   output.length === canvas.W
 *
 * ── Layout hierarchy ─────────────────────────────────────────────
 *
 *   ┌─────────────────────────────────────────────────────────┐   ← boxTop
 *   │  ━━━ 区块标题 ━━━                                        │   ← sectionHeader
 *   │  ┌─ 🎮 活动标题 ───────────────────────────────────────┐  │   ← cardTop
 *   │  │ 内容                                                 │  │   ← cardLine
 *   │  └──────────────────────────────────────────────────────┘  │   ← cardBottom
 *   ├─────────────────────────────────────────────────────────┤   ← boxSep
 *   │  ...                                                     │
 *   └─────────────────────────────────────────────────────────┘   ← boxBottom
 */

// ─── Canvas Type ─────────────────────────────────────────────────────────────

export interface Canvas {
  /** Total line width (including border characters) */
  W: number
  /** Inner content width (│ and │) = W - 4 */
  O_INNER: number
  /** Sub-box (card) total width = W - 6 */
  CARD_TOTAL: number
  /** Sub-box inner content width = W - 10 */
  CARD_INNER: number
  /** Card title dash fill length */
  cardDashes(titleVis: number): number
  /** Card bottom dash fill length */
  cardBottomDashes(): number
}

// ─── Width Utilities ─────────────────────────────────────────────────────────

const CJK_RE = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;
const EMOJI_RE = /[\u{1F000}-\u{1FFFF}]/u;
const CANVAS_MIN_WIDTH = 50;
const CANVAS_MAX_WIDTH = 80;

/**
 * Calculate visible width of a string.
 * CJK characters and emoji count as 2, ASCII and others count as 1.
 */
export function visibleWidth(text: string): number {
  let w = 0;
  for (const ch of text) {
    w += CJK_RE.test(ch) || EMOJI_RE.test(ch) ? 2 : 1;
  }
  return w;
}

/**
 * Right-pad a string to target visual width with trailing spaces.
 * Returns original text if already >= width.
 */
export function padRight(text: string, width: number): string {
  const padLen = width - visibleWidth(text);
  return padLen > 0 ? text + " ".repeat(padLen) : text;
}

/**
 * Center-pad a string to target visual width.
 * Left pad is floor((width - visWidth) / 2), right pad rounds up.
 * When odd difference, left side gets 1 fewer space than right.
 */
export function centerPad(text: string, width: number): string {
  const visWidth = visibleWidth(text);
  const leftPad = Math.max(0, Math.floor((width - visWidth) / 2));
  const rightPad = Math.max(0, width - visWidth - leftPad);
  return " ".repeat(leftPad) + text + " ".repeat(rightPad);
}

// ─── Canvas Factory ─────────────────────────────────────────────────────────

/**
 * Create a Canvas from the maximum core content width.
 *
 * coreMaxWidth = max visible width of header text + activity card content.
 *
 * Formula:
 *   W           = max(50, min(80, coreMaxWidth + 4))
 *   O_INNER     = W - 4
 *   CARD_TOTAL  = W - 6
 *   CARD_INNER  = W - 10
 */
export function createCanvas(coreMaxWidth: number): Canvas {
  const W = Math.max(CANVAS_MIN_WIDTH, Math.min(CANVAS_MAX_WIDTH, coreMaxWidth + 4));
  return {
    W,
    O_INNER: W - 4,
    CARD_TOTAL: W - 6,
    CARD_INNER: W - 10,
    cardDashes(titleVis: number) {
      return Math.max(0, W - 9 - titleVis);
    },
    cardBottomDashes() {
      return Math.max(0, W - 8);
    },
  };
}

// ─── Box Components (Outer Frame) ───────────────────────────────────────────

/**
 * Outer frame top border: ┌─────────────────────┐
 */
export function boxTop(canvas: Canvas): string {
  return `┌${"─".repeat(canvas.W - 2)}┐`;
}

/**
 * Outer frame separator: ├─────────────────────┤
 */
export function boxSep(canvas: Canvas): string {
  return `├${"─".repeat(canvas.W - 2)}┤`;
}

/**
 * Outer frame bottom border: └─────────────────────┘
 */
export function boxBottom(canvas: Canvas): string {
  return `└${"─".repeat(canvas.W - 2)}┘`;
}

/**
 * Outer frame content line: │ padded text         │
 */
export function boxLine(canvas: Canvas, text: string): string {
  return `│ ${padRight(text, canvas.O_INNER)} │`;
}

/**
 * Outer frame centered line: │  centered text      │
 */
export function boxCenter(canvas: Canvas, text: string): string {
  return `│ ${centerPad(text, canvas.O_INNER)} │`;
}

/**
 * Outer frame spacer line: │                     │
 */
export function boxSpacer(canvas: Canvas): string {
  return `│ ${" ".repeat(canvas.O_INNER)} │`;
}

// ─── Section Components ─────────────────────────────────────────────────────

/**
 * Section title line: │  ━━━ Title ━━━               │
 * Title wrapped with ━━━ (U+2501) on both sides.
 */
export function sectionHeader(canvas: Canvas, text: string): string {
  return boxLine(canvas, `  ━━━ ${text} ━━━`);
}

/**
 * Inner full-width divider line: │  ━━━━━━━━━━━━━━━     │
 * Default character is ━ (U+2501).
 */
export function innerDivider(canvas: Canvas, char: string = "━"): string {
  return `│  ${char.repeat(canvas.O_INNER - 2)}  │`;
}

// ─── Card Components (Sub-box) ─────────────────────────────────────────────

/**
 * Card top border with title: │  ┌─ 🎮 Title ─────────┐  │
 */
export function cardTop(canvas: Canvas, icon: string, name: string): string {
  const titleContent = ` ${icon} ${name} `;
  const titleVis = visibleWidth(titleContent);
  const dashes = canvas.cardDashes(titleVis);
  return `│  ┌─${titleContent}${"─".repeat(dashes)}┐  │`;
}

/**
 * Card content line: │  │ padded content          │  │
 */
export function cardLine(canvas: Canvas, text: string): string {
  return `│  │ ${padRight(text, canvas.CARD_INNER)} │  │`;
}

/**
 * Card divider line: │  │ ───────────────────── │  │
 */
export function cardDivider(canvas: Canvas): string {
  return `│  │ ${"─".repeat(canvas.CARD_INNER)} │  │`;
}

/**
 * Card spacer line: │  │                       │  │
 */
export function cardSpacer(canvas: Canvas): string {
  return `│  │ ${" ".repeat(canvas.CARD_INNER)} │  │`;
}

/**
 * Card bottom border: │  └────────────────────────┘  │
 */
export function cardBottom(canvas: Canvas): string {
  const dashes = canvas.cardBottomDashes();
  return `│  └${"─".repeat(dashes)}┘  │`;
}

/**
 * Indented content line: │     indented text          │
 * For world update ▷ prefix lines.
 */
export function indentedLine(canvas: Canvas, indent: number, text: string): string {
  return boxLine(canvas, " ".repeat(indent) + text);
}
