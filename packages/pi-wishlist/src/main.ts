/* ------------------------------------------------------------------ */
/*  Pi Wishlist — Extension main entry point                          */
/*                                                                     */
/*  Registers:                                                         */
/*    - /wish slash command (TUI modal when no subcommand)             */
/*    - /wishlist slash command (alias)                               */
/*    - session_start hook (daily check + installed detection)         */
/* ------------------------------------------------------------------ */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { WishlistEntry } from "./data/types.ts";
import { debugLog } from "./data/debug.ts";
import { loadWishlist, saveWishlist } from "./data/wishlist.ts";
import { isTodayChecked, runDailyCheck, removeInstalledPackages, saveCheckedDate } from "./data/checker.ts";
import { createWishlistComponent } from "./ui/wishlist-view.ts";
import { t, bridge } from "./state/i18n-bridge.ts";

export default function (pi: ExtensionAPI) {
  // ── session_start: daily check ────────────────────────────────
  pi.on("session_start", async (event, ctx) => {
    if (event.reason === "resume") return;
    if (!ctx.hasUI) return;

    // Show i18n install hint if optional SDK is missing
    if (!bridge.i18nAvailable) {
      ctx.ui.setWidget(
        "wishlist-i18n-hint",
        (_, theme) => ({
          invalidate: () => {},
          render: (width: number) => [
            "",
            new DynamicBorder((s) => theme.fg("warning", s)).render(width)[0],
            `  ${theme.bold(theme.fg("warning", t("cli.i18nTitle", "Localization Support")))}`,
            `  ${theme.fg("muted", t("cli.i18nDesc", "pi-wishlist: @juicesharp/rpiv-i18n adds /languages command and auto locale detection. Install with "))}${theme.fg("accent", "pi install @juicesharp/rpiv-i18n")}`,
            `  ${theme.fg("dim", "(" + t("cli.i18nAutoDismiss", "this notification will disappear in a few seconds") + ")")}`,
            new DynamicBorder((s) => theme.fg("warning", s)).render(width)[0],
          ],
        }),
        { placement: "aboveEditor" },
      );
      setTimeout(() => ctx.ui.setWidget("wishlist-i18n-hint", undefined), 20000);
    }

    const wl = loadWishlist();
    if (Object.keys(wl.packages).length === 0) return;
    if (!wl.settings.notifications) return;
    if (isTodayChecked()) return;

    // Defer async check to avoid blocking startup
    setTimeout(async () => {
      try {
        // 1. Check installed packages and auto-remove
        const removed = removeInstalledPackages(wl);
        if (removed.length > 0) {
          saveWishlist(wl);
          for (const key of removed) {
            const name = key.replace(/^npm:/, "");
            ctx.ui.notify(`✅ ${t("cli.installedRemoved", "{name} installed, auto-removed from wishlist").replace("{name}", name)}`, "info");
          }
        }

        // 2. Run update check
        const results = await runDailyCheck();

        // 3. Show compact notify if updates found
        if (results.length > 0) {
          ctx.ui.notify(
            t("notify.hint", "📋 {count} packages have updates — /wish to view details")
              .replace("{count}", String(results.length)),
            "info",
          );
        }
      } catch (err) {
        debugLog("main", "startup daily check failed", err);
      }
    }, 500);
  });

  // ── Shared handler for /wish and /wishlist ─────────────────────
  async function wishHandler(
    _args: string,
    ctx: ExtensionCommandContext,
  ) {
    const parts = _args.trim().split(/\s+/);
    const sub = parts[0]?.toLowerCase() || "";

    switch (sub) {
      case "list":
        await handleList(parts.slice(1), ctx, pi);
        break;
      case "stats":
        await handleStats(parts.slice(1), ctx, pi);
        break;
      case "add":
        await handleAdd(parts.slice(1), ctx, pi);
        break;
      case "remove":
        await handleRemove(parts.slice(1), ctx, pi);
        break;
      case "refresh":
        await handleRefresh(ctx, pi);
        break;
      case "edit":
        await handleEditSlash(parts.slice(1), ctx);
        break;
      case "notify-test":
        // Debug: simulate daily check notification without real API
        ctx.ui.notify(
          t("notify.hint", "📋 {count} packages have updates — /wish to view details")
            .replace("{count}", "2"),
          "info",
        );
        break;
      default:
        if (!_args.trim()) {
          await handleModal(ctx, pi);
        } else {
          ctx.ui.notify(t("cli.unknownSubcommand", "unknown subcommand `{sub}`. available: list, stats, add, remove, refresh").replace("{sub}", sub), "info");
        }
    }
  }

  // ── Register /wish ──────────────────────────────────────────
  pi.registerCommand("wish", {
    description: "Pi Package Wishlist — track packages you want to install later",
    handler: wishHandler,
  });

  // ── Register /wishlist (alias) ──────────────────────────────
  pi.registerCommand("wishlist", {
    description: "Pi Package Wishlist (alias for /wish)",
    handler: wishHandler,
  });
}

/* ------------------------------------------------------------------ */
/*  Handler implementations                                           */
/* ------------------------------------------------------------------ */

async function handleList(_args: string[], _ctx: ExtensionCommandContext, pi: ExtensionAPI) {
  const { handleList: cmd } = await import("./commands/list.ts");
  const result = await cmd(_args);

  if (!result.success) {
    sendDisplay(pi, `❌ ${result.error}`);
    return;
  }

  const packages = result.data;
  if (packages.length === 0) {
    sendDisplay(pi, `📭 ${t("cli.listEmpty", "wishlist is empty. use `/wish add <name>` to add packages.")}`);
    return;
  }

  const details = _args.includes("--details");

  if (details) {
    const lines = packages.map(({ key, entry }) => formatDetail(key, entry));
    sendDisplay(pi, `${t("cli.listDetailTitle", "Wishlist Details")}\n\n${lines.join("\n---\n")}`);
  } else {
    const header = t("cli.tableHeader", "| # | name | version | stars | downloads/month | notes | status |");
    const sep = "|---|---|---|---|---|---|---|---|";
    const rows = packages.map(({ key, entry }, i) => {
      const name = key.replace(/^npm:/, "");
      const ver = entry.sources.npm?.latestVersion || "---";
      const stars = entry.sources.github?.stars ?? 0;
      const dl = entry.sources.npm?.weeklyDownloads ?? 0;
      const note = entry.notes || "";
      const status = entry.githubCooldownUntil ? t("cli.statusCooldown", "cooling") : t("cli.statusNormal", "ok");
      return `| ${i + 1} | ${name} | ${ver} | ${stars} | ${dl.toLocaleString()} | ${note} | ${status} |`;
    });
    sendDisplay(pi, `${t("cli.listTitle", "Wishlist ({count})").replace("{count}", String(packages.length))}\n\n${header}\n${sep}\n${rows.join("\n")}`);
  }
}

async function handleStats(args: string[], _ctx: ExtensionCommandContext, pi: ExtensionAPI) {
  const { handleStats: cmd } = await import("./commands/stats.ts");
  const result = await cmd(args);

  if (!result.success) {
    sendDisplay(pi, result.error);
    return;
  }

  const detail = formatDetail(result.data.key, result.data.entry);

  const events = result.data.entry.notificationEvents;
  if (events.length > 0) {
    const recent = events.slice(-5).reverse();
    const history = recent.map((c) => {
      const ts = c.at.slice(0, 16).replace("T", " ");
      const from = c.from ? `${c.from} → ` : "";
      return `  - ${ts} \`${c.type}\` ${from}${c.to}`;
    });
    sendDisplay(pi, `${detail}\n\n**${t("cli.changeHistory", "change history (recent {count})").replace("{count}", String(recent.length))}**\n${history.join("\n")}`);
  } else {
    sendDisplay(pi, `${detail}\n\n_${t("cli.noHistory", "no change history")}_`);
  }
}

function formatDetail(key: string, entry: WishlistEntry): string {
  const name = key.replace(/^npm:/, "");
  const lines: string[] = [];
  lines.push(`**${name}**`);
  lines.push(`- source: \`${key}\``);
  if (entry.sources.npm) {
    lines.push(`- ${t("cli.detailNpm", "npm: v{version} ({downloads}/mo)").replace("{version}", entry.sources.npm.latestVersion).replace("{downloads}", entry.sources.npm.weeklyDownloads.toLocaleString())}`);
  }
  if (entry.sources.github) {
    const g = entry.sources.github;
    lines.push(`- ${t("cli.detailGithub", "GitHub: {stars} stars / {forks} forks / {issues} issues").replace("{stars}", String(g.stars)).replace("{forks}", String(g.forks)).replace("{issues}", String(g.openIssues))}`);
    lines.push(`- ${t("cli.detailLastPush", "last push: {date}").replace("{date}", g.pushedAt.slice(0, 10))}`);
  }
  if (entry.notes) lines.push(`- ${t("cli.detailNotes", "notes: {text}").replace("{text}", entry.notes)}`);
  lines.push(`- ${t("cli.detailAddedAt", "added: {date}").replace("{date}", entry.addedAt.slice(0, 10))}`);
  lines.push(`- ${t("cli.detailLastChecked", "last checked: {date}").replace("{date}", entry.lastChecked.slice(0, 10))}`);
  if (entry.githubFailCount > 2) {
    lines.push(`- ❌ ${t("cli.detailGitHubFails", "GitHub failed {count} times").replace("{count}", String(entry.githubFailCount))}`);
  }
  if (entry.githubCooldownUntil) {
    lines.push(`- ⚠️ ${t("cli.detailCooldown", "cooling down (until {date})").replace("{date}", entry.githubCooldownUntil.slice(0, 10))}`);
  }
  return lines.join("\n");
}

async function handleEditSlash(args: string[], ctx: ExtensionCommandContext) {
  const { handleEdit } = await import("./commands/edit.ts");
  const result = await handleEdit(args);

  if (!result.success) {
    ctx.ui.notify(`❌ ${result.error}`, "error");
    return;
  }

  const name = result.data.key.replace(/^npm:/, "");
  ctx.ui.notify(result.data.note
    ? `✅ ${t("cli.editUpdated", "{name} note updated").replace("{name}", name)}`
    : `✅ ${t("cli.editCleared", "{name} note cleared").replace("{name}", name)}`, "info");
}

async function handleAdd(args: string[], ctx: ExtensionCommandContext, pi: ExtensionAPI) {
  // Interactive fallback when no arg provided
  let resolvedArgs = args;
  if (!args[0] || args[0].startsWith("--")) {
    const input = await ctx.ui.input(t("cli.inputPrompt", "enter package name or git URL"));
    if (!input) return;
    resolvedArgs = [input, ...args];
  }

  const { handleAdd: cmd } = await import("./commands/add.ts");
  const result = await cmd(resolvedArgs);

  if (!result.success) {
    ctx.ui.notify(`⚠️ ${result.error}`, "warning");
    return;
  }

  const name = result.data.addedKey.replace(/^npm:/, "");
  ctx.ui.notify(`✅ ${t("cli.added", "{name} added to wishlist").replace("{name}", name)}`, "info");
}

async function handleRemove(args: string[], ctx: ExtensionCommandContext, _pi: ExtensionAPI) {
  const target = args[0];
  if (!target) {
    ctx.ui.notify(t("cli.removeUsage", "usage: /wish remove <sourceKey>"), "warning");
    return;
  }

  // Resolve target first to get human-readable name for confirmation
  const { listPackages, getPackage } = await import("./data/wishlist.ts");
  const packages = listPackages();
  const idx = parseInt(target, 10);
  let sourceKey = target;
  if (!isNaN(idx) && idx >= 1 && idx <= packages.length) {
    sourceKey = packages[idx - 1].key;
  }

  const entry = getPackage(sourceKey);
  if (!entry) {
    ctx.ui.notify(`❌ ${t("cli.notFound", "could not find {key}").replace("{key}", sourceKey)}`, "error");
    return;
  }

  const confirmed = await ctx.ui.confirm(t("cli.confirmRemove", "confirm remove"), `${t("cli.removeConfirmSuffix", "")}${sourceKey.replace(/^npm:/, "")}？`);
  if (!confirmed) return;

  // Delegate to command module with resolved key
  const { handleRemove: cmd } = await import("./commands/remove.ts");
  const result = await cmd([sourceKey]);

  if (!result.success) {
    ctx.ui.notify(`❌ ${result.error}`, "error");
    return;
  }

  ctx.ui.notify(`✅ ${t("cli.removed", "{name} removed from wishlist").replace("{name}", result.data.removedKey.replace(/^npm:/, ""))}`, "info");
}

async function handleRefresh(ctx: ExtensionCommandContext, pi: ExtensionAPI) {
  const { handleRefresh: cmd } = await import("./commands/refresh.ts");
  const result = await cmd();

  if (!result.success) {
    sendDisplay(pi, `❌ ${result.error}`);
    return;
  }
  const { results, totalPackages } = result.data;
  const total = totalPackages;
  let changed = 0;

  const lines: string[] = [t("cli.refreshDone", "🔄 wishlist check complete ({count} packages)").replace("{count}", String(total))];
  if (results.length === 0) {
    lines.push(`— ${t("cli.noChanges", "no changes")}`);
  } else {
    for (const r of results) {
      const name = r.packageKey.replace(/^npm:/, "");
      if (r.newEvents.length === 0) {
        // no changes
      } else {
        changed++;
        for (const ev of r.newEvents) {
          if (ev.type === "new_version") {
            const label = t("cli.newRelease", "new release");
            lines.push(`⬆ **${name}** ${ev.from || "?"} → ${ev.to}  🆕 ${label}`);
          } else if (ev.type === "stars_changed") {
            const label = t("cli.newStars", "new stars");
            lines.push(`⭐ **${name}** ${ev.from || 0} → ${ev.to}  ${label}`);
          }
        }
      }
    }
  }

  lines.push(`\n_${t("cli.summaryLine", "{total} packages / {changed} changes").replace("{total}", String(total)).replace("{changed}", String(changed))}_`);
  sendDisplay(pi, lines.join("\n"));
}

function sendDisplay(pi: ExtensionAPI, content: string) {
  pi.sendMessage({ customType: "", content, display: true, details: {} }, { triggerTurn: false });
}

/* ------------------------------------------------------------------ */
/*  Modal TUI loop                                                    */
/* ------------------------------------------------------------------ */

async function handleModal(ctx: ExtensionCommandContext, _pi: ExtensionAPI) {
  await ctx.ui.custom<{ type: "close" }>(
    (tui, theme, _keybindings, done) => {
      const comp = createWishlistComponent(
        theme,
        () => tui.requestRender(true),
        done,
      );
      return comp;
    },
    {
      overlay: true,
      overlayOptions: { anchor: "center" as const, width: "90%" as const, maxHeight: "80%" as const },
    },
  );
}