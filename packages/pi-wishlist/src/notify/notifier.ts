/* ------------------------------------------------------------------ */
/*  Pi Wishlist — notification formatting                             */
/* ------------------------------------------------------------------ */

import { t } from "../state/i18n-bridge.ts";
import type { CheckResult } from "../data/types.ts";

/**
 * Build the lines for the TUI chat container notification panel.
 */
/**
 * Build notification panel with frame.
 */
export function buildNotificationPanel(
  results: CheckResult[],
  width: number,
): string[] {
  const lines: string[] = [];

  lines.push(`  ${t("notify.changedCount", "{count} packages have changes").replace("{count}", String(results.length))}`);
  lines.push("");

  lines.push("  Updates:");
  for (const r of results) {
    const name = r.packageKey.replace(/^npm:/, "");
    for (const ev of r.newEvents) {
      if (ev.type === "new_version") {
        lines.push(`  - ${name}   ${ev.from || "?"} → ${ev.to}  🆕`);
      } else if (ev.type === "stars_changed") {
        lines.push(`  - ${name}   ⭐ ${ev.from || 0} → ${ev.to}`);
      } else {
        lines.push(`  - ${name}   ${ev.to}`);
      }
    }
  }

  lines.push("");
  lines.push(`  → ${t("notify.openWishlist", "/wish to open wishlist")}`);

  
  const maxInner = Math.max(...lines.map((l) => l.length), 0);
  const panelWidth = Math.max(maxInner + 4, 40);

  const panel: string[] = [];
  const title = ` ${t("notify.panelTitle", "📋 wishlist update")} `;
  const leftPad = Math.floor((panelWidth - title.length) / 2);
  const rightPad = panelWidth - title.length - leftPad;
  panel.push(`┌${"─".repeat(leftPad)}${title}${"─".repeat(rightPad)}┐`);
  for (const line of lines) {
    panel.push(`│ ${line.padEnd(panelWidth - 3)}│`);
  }
  panel.push(`└${"─".repeat(panelWidth - 1)}┘`);

  return panel;
}