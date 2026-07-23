/* ------------------------------------------------------------------ */
/*  Pi Wishlist — theme-driven rendering utilities                    */
/*                                                                     */
/*  Inspired by @vanillagreen/pi-extension-manager render.ts.          */
/*  All rendering goes through the pi Theme object so colors adapt     */
/*  to the user's color scheme.                                        */
/* ------------------------------------------------------------------ */

import { t } from "../state/i18n-bridge.ts";
import { truncateToWidth, visibleWidth, decodeKittyPrintable } from "@earendil-works/pi-tui";
import type { WishlistMode } from "./types.ts";

/**
 * Minimal Theme interface matching the pi-ui custom() callback.
 * Defined locally since @earendil-works/pi-coding-agent doesn't ship .d.ts.
 */
export interface Theme {
  fg(key: string, text: string): string;
  bg(key: string, text: string): string;
  inverse(text: string): string;
  bold(text: string): string;
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Pad (or truncate) text to an exact display width, handling ANSI codes.
 */
export function pad(text: string, width: number): string {
  const truncated = truncateToWidth(text, width, "");
  return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

/**
 * A horizontal divider line using theme's dim color.
 */
export function divider(width: number, theme: Theme): string {
  return theme.fg("dim", "─".repeat(Math.max(1, width)));
}

/**
 * Render a line with the selection background.
 */
export function selectedLine(theme: Theme, text: string, width: number): string {
  return theme.bg("selectedBg", pad(text, width));
}

/**
 * Wrap an array of content lines in a bordered frame.
 *
 * If `title` is provided, it appears centered in the top border.
 * If `fixedInnerRows` is set, content is truncated/padded to fit.
 */
export function frame(
  lines: string[],
  width: number,
  theme: Theme,
  fixedInnerRows?: number,
  title?: string,
): string[] {
  const inner = Math.max(1, width - 2);
  const contentWidth = Math.max(1, width - 6);

  const border = (s: string) => theme.fg("borderAccent", s);

  // Truncate if too many lines
  let body = lines;
  if (fixedInnerRows !== undefined && body.length > fixedInnerRows) {
    const hidden = body.length - fixedInnerRows + 1;
    body = [...body.slice(0, Math.max(0, fixedInnerRows - 1)), theme.fg("dim", `↓ ${hidden} more line(s)`)].slice(0, fixedInnerRows);
  }

  const blankLine = `${border("│")}${" ".repeat(inner)}${border("│")}`;

  // Top border
  const top = (): string => {
    if (!title) return `${border("┌")}${border("─".repeat(inner))}${border("┐")}`;
    const titlePlain = ` ${truncateToWidth(title, Math.max(1, inner - 2), "…")} `;
    const fill = Math.max(1, inner - visibleWidth(titlePlain));
    return `${border("┌")}${titlePlain}${border("─".repeat(fill))}${border("┐")}`;
  };

  const out: string[] = [top()];
  out.push(blankLine);
  for (const line of body) {
    out.push(`${border("│")}  ${pad(line, contentWidth)}  ${border("│")}`);
  }
  out.push(blankLine);
  out.push(`${border("└")}${border("─".repeat(inner))}${border("┘")}`);

  return out.map((line) => truncateToWidth(line, width, ""));
}

/**
 * Decode a plain printable character from raw terminal data.
 *
 * Returns the decoded character string for normal input and vanilla Kitty
 * CSI-u sequences, or null if `data` is a control sequence, delete, etc.
 *
 * Callers use the return value directly: non-null → insert, null → skip.
 */
export function isPlainSearchInput(data: string): string | null {
  // Fast path: bare printable byte (most terminals, no CSI-u)
  if (data.length === 1 && data >= " " && data !== "\x7f") return data;
  // Kitty protocol CSI-u encoded printable
  const decoded = decodeKittyPrintable(data);
  if (decoded != null) return decoded;
  return null;
}


/**
 * Return a context-sensitive footer hint line for the given mode.
 */
export function footerHint(mode: WishlistMode): string {
  switch (mode) {
    case "list":
      return t("footer.list", "a add  d remove  e edit note  / search  ↑↓ Enter detail  r refresh  Esc/q quit");
    case "search":
      return t("footer.search.confirm", "Esc/Enter confirm  Backspace delete");
    case "edit-note":
      return t("footer.editNote.save", "Enter save  Esc cancel  ←/→ move cursor");
    case "remove-confirm":
      return t("footer.removeConfirm.confirm", "y/Enter confirm  other key cancel");
    case "add-search":
      return t("footer.addSearch.navigate", "↑↓ navigate  Enter select  Esc back");
    case "add-note":
      return t("footer.addNote.confirm", "Enter confirm  Esc cancel");
  }
}