/* ------------------------------------------------------------------ */
/*  Pi Wishlist — shared formatting utilities                         */
/* ------------------------------------------------------------------ */

import { t } from "../state/i18n-bridge.ts";
import type { WishlistEntry } from "../data/types.ts";

const GLYPH_DOWNLOAD = "⬇️";
const GLYPH_FORK = "🍴";
const GLYPH_ISSUE = "🆔";

/**
 * Determine status icon for a wishlist entry.
 *
 * Priority:
 *   1. 🆕 if latest new_version event is within 7 days
 *   2. 💤 if repo pushedAt > 90 days ago
 *   3. ✅ otherwise
 */
export function getStatusIcon(entry: WishlistEntry): string {
  const DAY_MS = 86_400_000;

  // 🆕: latest new_version event within 7 days
  if (entry.notificationEvents.length > 0) {
    const last = entry.notificationEvents.at(-1)!;
    if (last.type === "new_version") {
      const age = Date.now() - new Date(last.at).getTime();
      if (age < 7 * DAY_MS) return "🆕";
    }
  }

  // ⚠️: persistent GitHub fetch failures
  if (entry.githubFailCount >= 3) return "⚠️";

  // 💤: repo not pushed for > 90 days
  if (entry.sources.github?.pushedAt) {
    const pushedAge = Date.now() - new Date(entry.sources.github.pushedAt).getTime();
    if (pushedAge > 90 * DAY_MS) return "💤";
  }

  return "✅";
}

/**
 * Format detail section for a package.
 */
export function formatDetail(
  key: string,
  entry: WishlistEntry,
): string[] {
  const lines: string[] = [];
  const displayName = key.replace(/^npm:/, "");

  lines.push(`── ${displayName} ──────────────────────`);

  if (entry.sources.npm) {
    const n = entry.sources.npm;
    const dl = typeof n.weeklyDownloads === "number" && n.weeklyDownloads > 0 ? formatDownloads(n.weeklyDownloads) : "--";
    lines.push(t("tui.detail.npm", "npm:    {version} · {downloads}/wk").replace("{version}", n.latestVersion).replace("{downloads}", dl));
  }
  if (entry.sources.github) {
    const gh = entry.sources.github;
    lines.push(
      t("tui.detail.github", "git:    github.com/{owner}/{repo} · {stars} stars · {forks} · {issues} issues")
        .replace("{owner}", gh.owner).replace("{repo}", gh.repo)
        .replace("{stars}", String(gh.stars)).replace("{forks}", String(gh.forks))
        .replace("{issues}", String(gh.openIssues)),
    );
  }
  if (entry.notes) lines.push(t("tui.detail.notes", "notes:  {notes}").replace("{notes}", entry.notes));
  lines.push(t("tui.detail.added", "added:  {date}").replace("{date}", entry.addedAt.slice(0, 10)));

  const lastEvent = entry.notificationEvents.at(-1);
  if (lastEvent) {
    const daysAgo = Math.floor(
      (Date.now() - new Date(lastEvent.at).getTime()) / 86_400_000,
    );
    const age = daysAgo === 0 ? t("tui.detail.today", "today") : t("tui.detail.daysAgo", "{days}d ago").replace("{days}", String(daysAgo));
    lines.push(t("tui.detail.event", "event:  {type} {age}").replace("{type}", lastEvent.type).replace("{age}", age));
  }

  return lines;
}

function formatDownloads(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * Highlight the first occurrence of `query` in `text` with `**` markers.
 * Case-insensitive match. Returns original text if query is empty or not found.
 */
export function highlightMatch(text: string, query: string): string {
  if (!query || !text) return text;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const idx = lower.indexOf(q);
  if (idx === -1) return text;
  return text.slice(0, idx) + "**" + text.slice(idx, idx + query.length) + "**" + text.slice(idx + query.length);
}