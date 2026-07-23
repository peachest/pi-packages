/* ------------------------------------------------------------------ */
/*  Pi Wishlist — inline edit engine                                  */
/*                                                                     */
/*  Inspired by @vanillagreen/pi-extension-manager inline edit.        */
/*  Pure functions: no pi-tui imports needed (caller passes raw data). */
/* ------------------------------------------------------------------ */

import type { InlineEditChar, InlineEditState } from "./types.ts";
import { isPlainSearchInput } from "./render.ts";

// ── Helpers ──────────────────────────────────────────────────────

function inlineEditChars(text: string): InlineEditChar[] {
  const out: InlineEditChar[] = [];
  let offset = 0;
  for (const ch of text) {
    const start = offset;
    offset += ch.length;
    out.push({ ch, start, end: offset });
  }
  return out;
}

function clampInlineCursor(editing: InlineEditState): void {
  editing.cursor = Math.max(0, Math.min(editing.cursor, editing.buffer.length));
}

function codeUnitToCharIndex(chars: InlineEditChar[], cursor: number): number {
  let index = 0;
  while (index < chars.length && chars[index]!.end <= cursor) index += 1;
  return index;
}

function charIndexToCodeUnit(chars: InlineEditChar[], index: number, textLength: number): number {
  if (index <= 0) return 0;
  if (index >= chars.length) return textLength;
  return chars[index]!.start;
}

function inlineCharKind(ch: string): "space" | "word" | "punct" {
  if (/\s/u.test(ch)) return "space";
  if (/[A-Za-z0-9_]/.test(ch)) return "word";
  return "punct";
}

function moveInlineCursorByChars(editing: InlineEditState, delta: number): void {
  const chars = inlineEditChars(editing.buffer);
  const index = codeUnitToCharIndex(chars, editing.cursor);
  editing.cursor = charIndexToCodeUnit(chars, index + delta, editing.buffer.length);
}

function moveInlineCursorWordLeft(editing: InlineEditState): void {
  const chars = inlineEditChars(editing.buffer);
  let index = codeUnitToCharIndex(chars, editing.cursor);
  while (index > 0 && inlineCharKind(chars[index - 1]!.ch) === "space") index -= 1;
  if (index <= 0) {
    editing.cursor = 0;
    return;
  }
  const kind = inlineCharKind(chars[index - 1]!.ch);
  while (index > 0 && inlineCharKind(chars[index - 1]!.ch) === kind) index -= 1;
  editing.cursor = charIndexToCodeUnit(chars, index, editing.buffer.length);
}

function moveInlineCursorWordRight(editing: InlineEditState): void {
  const chars = inlineEditChars(editing.buffer);
  let index = codeUnitToCharIndex(chars, editing.cursor);
  while (index < chars.length && inlineCharKind(chars[index]!.ch) === "space") index += 1;
  if (index >= chars.length) {
    editing.cursor = editing.buffer.length;
    return;
  }
  const kind = inlineCharKind(chars[index]!.ch);
  while (index < chars.length && inlineCharKind(chars[index]!.ch) === kind) index += 1;
  editing.cursor = charIndexToCodeUnit(chars, index, editing.buffer.length);
}

function insertInlineText(editing: InlineEditState, text: string): void {
  if (!text) return; // ponytail: empty guard
  clampInlineCursor(editing);
  editing.buffer = `${editing.buffer.slice(0, editing.cursor)}${text}${editing.buffer.slice(editing.cursor)}`;
  editing.cursor += text.length;
}

function deleteInlineRange(editing: InlineEditState, start: number, end: number): void {
  const safeStart = Math.max(0, Math.min(start, editing.buffer.length));
  const safeEnd = Math.max(safeStart, Math.min(end, editing.buffer.length));
  editing.buffer = `${editing.buffer.slice(0, safeStart)}${editing.buffer.slice(safeEnd)}`;
  editing.cursor = safeStart;
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Process a keyboard input against an InlineEditState.
 *
 * Returns true if the state was modified, false if the input was
 * not recognized (caller should treat as a different action).
 *
 * Matches raw terminal data strings; the caller is responsible for
 * providing the raw event data (typically from ctx.ui.custom's
 * handleInput or node readline keypress).
 */
export function handleInlineEditInput(editing: InlineEditState, data: string): boolean {
  clampInlineCursor(editing);

  // Left
  if (data === "\x1b[D" || data === "\x02") {
    moveInlineCursorByChars(editing, -1);
    return true;
  }
  // Right
  if (data === "\x1b[C" || data === "\x06") {
    moveInlineCursorByChars(editing, 1);
    return true;
  }
  // Alt+Left / Ctrl+Left / Alt+B
  if (data === "\x1b[1;5D" || data === "\x1b[1;3D" || data === "\x1bb") {
    moveInlineCursorWordLeft(editing);
    return true;
  }
  // Alt+Right / Ctrl+Right / Alt+F
  if (data === "\x1b[1;5C" || data === "\x1b[1;3C" || data === "\x1bf") {
    moveInlineCursorWordRight(editing);
    return true;
  }
  // Home / Ctrl+A
  if (data === "\x1b[H" || data === "\x01") {
    editing.cursor = 0;
    return true;
  }
  // End / Ctrl+E
  if (data === "\x1b[F" || data === "\x05") {
    editing.cursor = editing.buffer.length;
    return true;
  }
  // Backspace
  if (data === "\x7f" || data === "\b") {
    const before = editing.cursor;
    moveInlineCursorByChars(editing, -1);
    deleteInlineRange(editing, editing.cursor, before);
    return true;
  }
  // Delete / Ctrl+D
  if (data === "\x1b[3~" || data === "\x04") {
    const start = editing.cursor;
    moveInlineCursorByChars(editing, 1);
    deleteInlineRange(editing, start, editing.cursor);
    return true;
  }
  // Ctrl+U — clear line
  if (data === "\x15") {
    editing.buffer = "";
    editing.cursor = 0;
    return true;
  }
  // Visible character insertion (handles Kitty CSI-u encoded printable)
  const ch = isPlainSearchInput(data);
  if (typeof ch === "string") {
    insertInlineText(editing, ch);
    return true;
  }


  return false;
}

/**
 * Render the editing state as a string with a block cursor.
 */
export function renderInlineEditValue(editing: InlineEditState): string {
  clampInlineCursor(editing);
  return `${editing.buffer.slice(0, editing.cursor)}█${editing.buffer.slice(editing.cursor)}`;
}