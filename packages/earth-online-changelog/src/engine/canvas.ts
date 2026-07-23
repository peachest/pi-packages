/**
 * Canvas — width utilities and Canvas factory
 *
 * Extracted from render-engine.ts.
 * Pure functions — zero external dependencies.
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
