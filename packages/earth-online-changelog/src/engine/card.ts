/**
 * Card Components — sub-box (card) borders and content lines
 *
 * Extracted from render-engine.ts.
 */

import type { Canvas } from "./canvas.ts";
import { visibleWidth, padRight } from "./canvas.ts";
import { boxLine } from "./box.ts";

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
