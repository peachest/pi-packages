/**
 * Section Components — section header and inner divider
 *
 * Extracted from render-engine.ts.
 */

import type { Canvas } from "./canvas.ts";
import { boxLine } from "./box.ts";

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
