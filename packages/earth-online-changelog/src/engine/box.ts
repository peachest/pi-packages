/**
 * Box Components — outer frame borders and content lines
 *
 * Extracted from render-engine.ts.
 */

import type { Canvas } from "./canvas.ts";
import { padRight, centerPad } from "./canvas.ts";

// ─── Box Components (Outer Frame) ───────────────────────────────────────────

/** Outer frame top border: ┌─────────────────────┐ */
export function boxTop(canvas: Canvas): string {
  return `┌${"─".repeat(canvas.W - 2)}┐`;
}

/** Outer frame separator: ├─────────────────────┤ */
export function boxSep(canvas: Canvas): string {
  return `├${"─".repeat(canvas.W - 2)}┤`;
}

/** Outer frame bottom border: └─────────────────────┘ */
export function boxBottom(canvas: Canvas): string {
  return `└${"─".repeat(canvas.W - 2)}┘`;
}

/** Outer frame content line: │ padded text         │ */
export function boxLine(canvas: Canvas, text: string): string {
  return `│ ${padRight(text, canvas.O_INNER)} │`;
}

/** Outer frame centered line: │  centered text      │ */
export function boxCenter(canvas: Canvas, text: string): string {
  return `│ ${centerPad(text, canvas.O_INNER)} │`;
}

/** Outer frame spacer line: │                     │ */
export function boxSpacer(canvas: Canvas): string {
  return `│ ${" ".repeat(canvas.O_INNER)} │`;
}
