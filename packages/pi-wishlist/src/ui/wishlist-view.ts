/* ------------------------------------------------------------------ */
/*  Pi Wishlist — self-contained custom UI component                  */
/*                                                                     */
/*  Implements the { render, handleInput, invalidate } interface      */
/*  for use inside ctx.ui.custom(). All interactions (list, search,   */
/*  edit, remove-confirm, add-search, add-note) happen in a single     */
/*  component — no exiting custom.                                     */
/*                                                                     */
/*  Inspired by @vanillagreen/pi-extension-manager's                   */
/*  quick-settings-ui.ts pattern.                                      */
/* ------------------------------------------------------------------ */

import { t } from "../state/i18n-bridge.ts";
import type { WishlistEntry } from "../data/types.ts";
import { listPackages, addPackage, removePackage, updatePackage } from "../data/wishlist.ts";
import { handleEditNote } from "../data/edit-note.ts";
import { searchPiPackages, type SearchResult } from "../data/search.ts";
import { trackPackage } from "../data/tracker.ts";
import { clearAllCooldowns, runDailyCheck } from "../data/checker.ts";
import { formatDetail, getStatusIcon, highlightMatch } from "./format.ts";
import { handleInlineEditInput, renderInlineEditValue } from "./inline-edit.ts";
import { frame, pad, selectedLine, divider, footerHint, isPlainSearchInput, type Theme } from "./render.ts";
import { matchesKey } from "@earendil-works/pi-tui";
import type { InlineEditState, WishlistMode } from "./types.ts";

export type WishlistAction = { type: "close" };

/**
 * Create a self-contained wishlist component for ctx.ui.custom().
 */
export function createWishlistComponent(
  theme: Theme,
  requestRender: (force?: boolean) => void,
  done: (action: WishlistAction) => void,
): { render(width: number): string[]; handleInput(data: string): void; invalidate(): void; focused: boolean; wantsKeyRelease: boolean } {
  // ── Internal state ──────────────────────────────────────────────
  let packages = listPackages();
  let mode: WishlistMode = "list";
  let selected = 0;
  let scroll = 0;
  let searchQuery = "";
  let showDetails = false;
  let editing: InlineEditState = { buffer: "", cursor: 0 };
  let removeTargetKey = "";

  // ── Add-flow state ────────────────────────────────────────────
  let addSearchQuery = "";
  let addSearchResults: SearchResult[] = [];
  let addSearchSelected = 0;
  let addEditing: InlineEditState = { buffer: "", cursor: 0 };
  let addChosenName = "";

  // ponytail: simple flag, not a full state machine
  let refreshing = false;

  // ── Debounce & race-token state ──────────────────────────────
  let searchSeq = 0;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;

  // ── Helpers ─────────────────────────────────────────────────────
  function getFiltered() {
    if (!searchQuery) return packages;
    const q = searchQuery.toLowerCase();
    return packages.filter(({ key, entry }) => {
      const name = key.replace(/^npm:/, "").toLowerCase();
      const note = (entry.notes || "").toLowerCase();
      return name.includes(q) || note.includes(q);
    });
  }

  function getSelectedEntry(): { key: string; entry: WishlistEntry } | undefined {
    const filtered = getFiltered();
    return filtered[selected];
  }

  const VISIBLE_ROWS = 10; // ponytail: fixed row count

  function clamp() {
    const filtered = getFiltered();
    const len = filtered.length;
    selected = Math.max(0, Math.min(selected, Math.max(0, len - 1)));
    if (selected < scroll) scroll = selected;
    if (selected >= scroll + VISIBLE_ROWS) scroll = selected - VISIBLE_ROWS + 1;
    scroll = Math.max(0, Math.min(scroll, Math.max(0, len - VISIBLE_ROWS)));
  }

  function triggerSearch(query: string, isBackspace = false): void {
    addSearchQuery = query;
    // Clear any pending timer
    if (searchTimer !== undefined) clearTimeout(searchTimer);
    if (!query) {
      addSearchResults = [];
      addSearchSelected = 0;
      searchTimer = undefined;
      return;
    }
    const delay = isBackspace ? 100 : 300;
    searchTimer = setTimeout(() => {
      const seq = ++searchSeq;
      searchPiPackages(query).then((results) => {
        if (seq !== searchSeq) return; // stale — discard
        addSearchResults = results;
        addSearchSelected = 0;
        requestRender(true);
      });
    }, delay);
  }

  // ── Render ──────────────────────────────────────────────────────
  function render(width: number): string[] {
    const lines: string[] = [];
    const innerWidth = Math.max(10, width - 4);

    if (refreshing) {
      const pc = (s: string) => s.length >= innerWidth ? s : " ".repeat(Math.floor((innerWidth - s.length) / 2)) + s;
      lines.push("");
      lines.push(pc(t("tui.refreshing.title", "🔄 checking for updates...")));
      lines.push("");
      lines.push(pc(t("tui.refreshing.body1", "querying npm and GitHub for the latest status of each package,")));
      lines.push(pc(t("tui.refreshing.body2", "please wait...")));
      return frame(lines, width, theme, undefined, "Pi Wishlist");
    }

    const filtered = getFiltered();

    // Title
    const countLabel = filtered.length === packages.length
      ? ` (${t("tui.title.count", "{count} packages").replace("{count}", String(packages.length))})`
      : ` (${t("tui.title.countFiltered", "{filtered}/{total}").replace("{filtered}", String(filtered.length)).replace("{total}", String(packages.length))})`;
    lines.push(`Pi Wishlist${countLabel}`);
    lines.push("");

    // ── Add note mode ──────────────────────────────────────────
    if (mode === "add-note") {
      lines.push(pad(t("tui.addNote.prompt", "> add {name}").replace("{name}", addChosenName), innerWidth));
      lines.push(divider(innerWidth, theme));
      const noteLine = `  ${t("tui.addNote.notePrefix", "notes:")} ${renderInlineEditValue(addEditing)}`;
      lines.push(noteLine);
      lines.push("");
      lines.push(footerHint("add-note"));
      return frame(lines, width, theme, undefined, "Pi Wishlist");
    }

    // ── Add search mode ────────────────────────────────────────
    if (mode === "add-search") {
      const searchLine = `> ${addSearchQuery}█`;
      lines.push(pad(searchLine, innerWidth));
      lines.push(divider(innerWidth, theme));

      if (addSearchResults.length > 0) {
        const displayCount = Math.min(addSearchResults.length, VISIBLE_ROWS);
        const addScroll = Math.max(0, Math.min(addSearchSelected - Math.floor(displayCount / 2), Math.max(0, addSearchResults.length - displayCount)));
        const addStartIdx = addScroll;
        const addEndIdx = Math.min(addScroll + displayCount, addSearchResults.length);

        for (let i = addStartIdx; i < addEndIdx; i++) {
          const { name, version, description } = addSearchResults[i];
          const isSelected = i === addSearchSelected;
          const prefix = isSelected ? "❯ " : "  ";
          const desc = description.length > innerWidth - 40
            ? description.slice(0, innerWidth - 43) + "..."
            : description;
          const line = `${prefix}${pad(name, 28)} ${pad(version, 10)}  ${desc}`;
          if (isSelected) {
            lines.push(selectedLine(theme, line, innerWidth));
          } else {
            lines.push(pad(line, innerWidth));
          }
        }
        if (addSearchResults.length > displayCount) {
          lines.push(t("tui.addSearch.remaining", "  ... {count} more").replace("{count}", String(addSearchResults.length - displayCount)));
        }
      } else if (addSearchQuery.length > 0) {
        lines.push("");
        lines.push(t("tui.addSearch.loading", "searching..."));
      } else {
        lines.push("");
        lines.push(t("tui.addSearch.placeholder", "search for pi packages by keyword"));
      }

      lines.push("");
      lines.push(footerHint("add-search"));
      return frame(lines, width, theme, undefined, "Pi Wishlist");
    }

    // ── Search bar (list/search mode) ─────────────────────────
    if (mode === "search") {
      const searchLine = `> ${searchQuery}█`;
      lines.push(pad(searchLine, innerWidth));
      lines.push(divider(innerWidth, theme));
    }

    // ── Edit note mode — show inline edit line ──────────────────
    if (mode === "edit-note") {
      const sel = getSelectedEntry();
      if (sel) {
        const name = sel.key.replace(/^npm:/, "");
        const editStr = renderInlineEditValue(editing);
        const editLine = `  ${pad(name, 28)} ${pad("", 10)} ${t("tui.editNote.prefix", "edit:")} ${editStr}`;
        lines.push(editLine);
      }
      lines.push(divider(innerWidth, theme));
      lines.push("");
      lines.push(footerHint(mode));
      return frame(lines, width, theme, undefined, "Pi Wishlist");
    }

    // ── Remove confirm mode ────────────────────────────────────
    if (mode === "remove-confirm") {
      const name = removeTargetKey.replace(/^npm:/, "");
      lines.push("");
      lines.push(`  ${t("cli.confirmRemove", "confirm remove")} ${name}？(y/N)`);
      lines.push("");
      lines.push(divider(innerWidth, theme));
      lines.push(footerHint(mode));
      return frame(lines, width, theme, undefined, "Pi Wishlist");
    }

    // ── Empty state ───────────────────────────────────────────────
    if (filtered.length === 0) {
      lines.push("");
      if (searchQuery) {
        lines.push(t("tui.empty.filtered.title", "no matching packages"));
        lines.push(t("tui.empty.filtered.hint", "Esc/Enter to clear search"));
      } else {
        lines.push(t("tui.empty.title", "wishlist is empty"));
        lines.push("");
        lines.push(t("tui.empty.body1", "no packages tracked yet."));
        lines.push(t("tui.empty.action1", "press a to search and add"));
        lines.push(t("tui.empty.action2", "or run /wish add npm:<package-name>"));
        lines.push("");
        lines.push(t("tui.empty.desc1", "track packages you're interested in but not ready to install,"));
        lines.push(t("tui.empty.desc2", "and get notified when there are new versions or activity."));
        lines.push("");
      }
      lines.push("");
      lines.push(footerHint(mode));
      return frame(lines, width, theme, undefined, "Pi Wishlist");
    }

    // ── Package list ──────────────────────────────────────────────
    const startIdx = scroll;
    const endIdx = Math.min(scroll + VISIBLE_ROWS, filtered.length);

    for (let i = startIdx; i < endIdx; i++) {
      const { key, entry } = filtered[i];
      const isSelected = i === selected;
      const prefix = isSelected ? "❯ " : "  ";
      const name = key.replace(/^npm:/, "");
      const ver = entry.sources.npm?.latestVersion ?? "---";
      const stars = entry.sources.github?.stars ?? 0;
      const dl = typeof entry.sources.npm?.weeklyDownloads === "number" && entry.sources.npm.weeklyDownloads > 0
        ? entry.sources.npm.weeklyDownloads : 0;
      const dlStr = dl >= 1000 ? `${(dl / 1000).toFixed(1)}k` : dl > 0 ? String(dl) : "--";
      const note = entry.notes ? `  📝` : "";
      const statusIcon = getStatusIcon(entry);

      const displayName = searchQuery ? highlightMatch(name, searchQuery) : name;
      const statusLabel = entry.githubCooldownUntil ? t("cli.statusCooldown", "cooling") : t("cli.statusNormal", "ok");
      const line = `${prefix}${pad(displayName, 28)} ${pad(ver, 10)} ⭐${String(stars).padStart(4)}  📥${pad(dlStr, 6)}  ${statusIcon}${note}`;

      if (isSelected) {
        lines.push(selectedLine(theme, line, innerWidth));
      } else {
        lines.push(pad(line, innerWidth));
      }
    }

    if (endIdx < filtered.length) {
      lines.push(t("tui.list.remaining", "  ... {count} more").replace("{count}", String(filtered.length - endIdx)));
    }

    // Detail panel
    if (showDetails && filtered[selected]) {
      const { key, entry } = filtered[selected];
      lines.push("");
      lines.push(divider(innerWidth, theme));
      const detailLines = formatDetail(key, entry);
      for (const dl of detailLines) {
        lines.push(`  ${dl}`);
      }
    }

    // Footer
    lines.push("");
    lines.push(footerHint(mode));

    return frame(lines, width, theme, undefined, "Pi Wishlist");
  }

  // ── Handle input ────────────────────────────────────────────────
  function handleInput(data: string): void {
    // Global: Ctrl+C closes modal in any mode
    if (data === "\x03") {
      done({ type: "close" });
      return;
    }

    // ── Add note mode ─────────────────────────────────────────
    if (mode === "add-note") {
      if (matchesKey(data, "escape")) {
        // Esc — cancel add, back to list
        mode = "list";
        addEditing = { buffer: "", cursor: 0 };
        addSearchQuery = "";
        addSearchResults = [];
        addSearchSelected = 0;
        return;
      }
      if (data === "\r" || data === "\n" || matchesKey(data, "enter")) {
        // Enter — confirm add
        const addedKey = `npm:${addChosenName}`;
        addPackage(addedKey, addedKey, addEditing.buffer || undefined);
        mode = "list";
        addChosenName = "";
        addSearchQuery = "";
        addSearchResults = [];
        addSearchSelected = 0;
        addEditing = { buffer: "", cursor: 0 };
        invalidate();
        // Async fetch sources — no-op if package was removed before callback fires
        trackPackage(addedKey).then((result) => {
          const sources: Record<string, unknown> = {};
          if (result.npm) sources.npm = result.npm;
          if (result.github) sources.github = result.github;
          updatePackage(addedKey, { sources, lastChecked: new Date().toISOString() });
          invalidate();
        }).catch(() => { invalidate(); });
        return;
      }
      handleInlineEditInput(addEditing, data);
      return;
    }

    // ── Add search mode ───────────────────────────────────────
    if (mode === "add-search") {
      if (matchesKey(data, "escape")) {
        // Esc — back to list
        mode = "list";
        addSearchQuery = "";
        addSearchResults = [];
        addSearchSelected = 0;
        return;
      }
      if (data === "\r" || data === "\n" || matchesKey(data, "enter")) {
        // Enter — select current result
        if (addSearchResults.length > 0 && addSearchSelected < addSearchResults.length) {
          addChosenName = addSearchResults[addSearchSelected].name;
          mode = "add-note";
          addEditing = { buffer: "", cursor: 0 };
        }
        return;
      }
      if (matchesKey(data, "up")) {
        if (addSearchSelected > 0) {
          addSearchSelected--;
        }
        return;
      }
      if (matchesKey(data, "down")) {
        if (addSearchSelected < addSearchResults.length - 1) {
          addSearchSelected++;
        }
        return;
      }
      if (data === "\x7f" || data === "\b") {
        addSearchQuery = addSearchQuery.slice(0, -1);
        if (addSearchQuery) {
          triggerSearch(addSearchQuery, true);
        } else {
          triggerSearch(""); // immediate clear
        }
        return;
      }
      if (isPlainSearchInput(data)) {
        addSearchQuery += data;
        triggerSearch(addSearchQuery);
        return;
      }
      return;
    }

    // ── Edit note mode ───────────────────────────────────────
    if (mode === "edit-note") {
      if (matchesKey(data, "escape")) {
        mode = "list";
        editing = { buffer: "", cursor: 0 };
        return;
      }
      if (data === "\r" || data === "\n" || matchesKey(data, "enter")) {
        const sel = getSelectedEntry();
        if (sel) {
          const err = handleEditNote(sel.key, editing.buffer);
          if (err) {
            // ponytail: silent failure — user stays in list mode
          }
        }
        mode = "list";
        editing = { buffer: "", cursor: 0 };
        invalidate();
        return;
      }
      handleInlineEditInput(editing, data);
      return;
    }

    // ── Remove confirm mode ──────────────────────────────────
    if (mode === "remove-confirm") {
      if (data === "y" || data === "Y" || matchesKey(data, "enter")) {
        removePackage(removeTargetKey);
        mode = "list";
        invalidate();
        return;
      }
      mode = "list";
      return;
    }

    // ── Close ────────────────────────────────────────────────
    if (data === "q") {
      done({ type: "close" });
      return;
    }

    // ── Search mode ──────────────────────────────────────────
    if (mode === "search") {
      if (data === "\x1b" || data === "\r" || data === "\n") {
        mode = "list";
        return;
      }
      if (data === "\x15") {
        searchQuery = "";
        return;
      }
      if (data === "\x7f" || data === "\b") {
        searchQuery = searchQuery.slice(0, -1);
        return;
      }
      if (isPlainSearchInput(data)) {
        searchQuery += data;
        return;
      }
      return;
    }

    // ── Enter search mode ────────────────────────────────────
    if (data === "/") {
      mode = "search";
      return;
    }

    // ── Add search mode (from list) ────────────────────────────
    if (data === "a") {
      mode = "add-search";
      addSearchQuery = "";
      addSearchResults = [];
      addSearchSelected = 0;
      // Focus automatically — start typing immediately
      return;
    }

    // ── Edit note ────────────────────────────────────────────
    if (data === "e") {
      const sel = getSelectedEntry();
      if (sel) {
        mode = "edit-note";
        editing = { buffer: sel.entry.notes || "", cursor: (sel.entry.notes || "").length };
      }
      return;
    }

    // ── Remove confirm ────────────────────────────────────────
    if (data === "d") {
      const sel = getSelectedEntry();
      if (sel) {
        mode = "remove-confirm";
        removeTargetKey = sel.key;
      }
      return;
    }

    // ── Refresh ─────────────────────────────────────────────
    if (data === "r" && !refreshing) {
      refreshing = true;
      requestRender();
      clearAllCooldowns();
      runDailyCheck().finally(() => {
        refreshing = false;
        invalidate();
        requestRender();
      }).catch(() => {});
      return;
    }

    // ── Escape — close detail or close modal ────────────────
    if (matchesKey(data, "escape")) {
      if (showDetails) {
        showDetails = false;
        return;
      }
      done({ type: "close" });
      return;
    }

    // ── Enter — toggle detail ────────────────────────────────
    if (data === "\r" || data === "\n" || matchesKey(data, "enter")) {
      showDetails = !showDetails;
      return;
    }

    // ── Navigation ────────────────────────────────────────────
    if (matchesKey(data, "up")) {
      if (selected > 0) {
        selected--;
        if (selected < scroll) scroll = selected;
      }
      return;
    }
    if (matchesKey(data, "down")) {
      const filtered = getFiltered();
      if (selected < filtered.length - 1) {
        selected++;
        if (selected >= scroll + VISIBLE_ROWS) scroll = selected - VISIBLE_ROWS + 1;
      }
      return;
    }
  }

  // ── Invalidate ────────────────────────────────────────────────
  function invalidate(): void {
    packages = listPackages();
    clamp();
    requestRender(true);
  }

  return { render, handleInput, invalidate, focused: false, wantsKeyRelease: false };
}