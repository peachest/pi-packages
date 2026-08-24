import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBashTool, createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { t, I18N_NAMESPACE } from "./state/i18n-bridge.js";

// --- i18n registration ---
const LOCALE_CODES = ["en", "zh", "de", "es", "fr", "pt", "pt-BR", "ru", "uk"] as const;

try {
  const sdk = await import("@juicesharp/rpiv-i18n");
  const byLocale: Record<string, Record<string, string>> = {};
  for (const code of LOCALE_CODES) {
    try {
      byLocale[code] = JSON.parse(readFileSync(new URL(`./locales/${code}.json`, import.meta.url), "utf-8")) as Record<string, string>;
    } catch {}
  }
  sdk.registerStrings(I18N_NAMESPACE, byLocale);
} catch {
  // SDK not installed — t() returns fallback verbatim
}

// ═════════════════════════════════════════════════════════════
// Pure functions (exported for testing)
// ═════════════════════════════════════════════════════════════

/** All 8 proxy-related env var keys. */
const ALL_PROXY_KEYS = [
  "http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY",
  "all_proxy", "ALL_PROXY", "no_proxy", "NO_PROXY",
] as const;

/** The 6 proxy URL keys (excluding no_proxy/NO_PROXY). */
const PROXY_URL_KEYS = [
  "http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY",
  "all_proxy", "ALL_PROXY",
] as const;

/** Mapping from tool parameters to the env-var keys they control. */
const PROXY_KEY_GROUPS = {
  proxyUrl: ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"],
  allProxy: ["all_proxy", "ALL_PROXY"],
  noProxy: ["no_proxy", "NO_PROXY"],
} as const;

/**
 * Merge two comma-separated host lists into a deduplicated union.
 * Order: entries from `a` first (in order), then new entries from `b`.
 */
export function mergeNoProxyLists(a: string, b: string): string {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of [...a.split(","), ...b.split(",")]) {
    const host = raw.trim();
    if (!host || seen.has(host)) continue;
    seen.add(host);
    result.push(host);
  }
  return result.join(",");
}

/** Parse KEY=VALUE text (one per line, # comments) into a dict. */
export function parseProxyEnv(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1);
    if (key) result[key] = val;
  }
  return result;
}

/** Serialize a dict to KEY=VALUE text with a header comment. */
export function serializeProxyEnv(env: Record<string, string>): string {
  const lines = ["# 代理环境变量", "# /proxy 开启后注入到所有 bash 命令", ""];
  for (const [k, v] of Object.entries(env)) {
    lines.push(`${k}=${v}`);
  }
  lines.push("");
  return lines.join("\n");
}

/** Compute the proxy.env path using XDG convention. */
export function computeProxyEnvPath(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdgConfig, "proxy.env");
}

/**
 * Returns true if any of the 6 proxy URL keys differ between two env dicts.
 * Used to decide whether rebuildDispatcher() is needed.
 */
export function diffProxyUrl(oldEnv: Record<string, string>, newEnv: Record<string, string>): boolean {
  for (const key of PROXY_URL_KEYS) {
    const oldVal = oldEnv[key] ?? "";
    const newVal = newEnv[key] ?? "";
    if (oldVal !== newVal) return true;
  }
  return false;
}

// ═════════════════════════════════════════════════════════════
// Constants
// ═════════════════════════════════════════════════════════════

const CONFIG_DIR = join(homedir(), ".pi", "agent");
const CONFIG_FILE = join(CONFIG_DIR, "proxy-config.json");
const ENV_FILE_PATH = computeProxyEnvPath();
const XDG_CONFIG_DIR = dirname(ENV_FILE_PATH);
const STATUS_KEY = "proxy";

const ENV_TEMPLATE = `# http_proxy=
# https_proxy=
# HTTP_PROXY=
# HTTPS_PROXY=
# all_proxy=
# ALL_PROXY=
# no_proxy=
# NO_PROXY=
`;

// --- Config ---
interface ProxyConfig {
  enabled: boolean;
}

function loadConfig(): ProxyConfig {
  try {
    const raw = readFileSync(CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return { enabled: Boolean(parsed.enabled) };
    }
  } catch {
    // first run
  }
  return { enabled: false };
}

function saveConfig(config: ProxyConfig): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
}

// --- .env file reader / writer ---
function readEnvFile(filePath: string): Record<string, string> {
  const raw = readFileSync(filePath, "utf-8");
  return parseProxyEnv(raw);
}

function writeEnvFile(filePath: string, env: Record<string, string>): void {
  if (!existsSync(XDG_CONFIG_DIR)) mkdirSync(XDG_CONFIG_DIR, { recursive: true });
  writeFileSync(filePath, serializeProxyEnv(env), "utf-8");
}

function resetEnvFile(filePath: string): void {
  if (!existsSync(XDG_CONFIG_DIR)) mkdirSync(XDG_CONFIG_DIR, { recursive: true });
  writeFileSync(filePath, ENV_TEMPLATE, "utf-8");
}

// --- process.env sync ---

/**
 * Sync the given env dict to process.env.
 * First deletes any of the 8 proxy vars present in process.env but absent
 * from the new dict (stale key cleanup). Then writes all keys from the dict.
 */
function syncProcessEnv(env: Record<string, string>): void {
  for (const key of ALL_PROXY_KEYS) {
    if (!(key in env)) {
      delete process.env[key];
    }
  }
  for (const [key, val] of Object.entries(env)) {
    process.env[key] = val;
  }
}

/** Delete all 8 proxy vars from process.env. */
function cleanProcessEnv(): void {
  for (const key of ALL_PROXY_KEYS) {
    delete process.env[key];
  }
}

/**
 * Given pi-coding-agent's resolved main entry path (dist/index.js), derive the
 * path to dist/core/http-dispatcher.js. Pure, for unit testing.
 *
 * dist/index.js → dirname=dist → dirname=pkgRoot → pkgRoot/dist/core/http-dispatcher.js
 */
export function dispatcherPathFromMain(mainPath: string): string {
  const pkgRoot = dirname(dirname(mainPath));
  return join(pkgRoot, "dist", "core", "http-dispatcher.js");
}

/**
 * Rebuild the undici global dispatcher by calling pi's configureHttpDispatcher.
 * Must be called when proxy URL changes — NO_PROXY changes are auto-detected.
 *
 * The package's exports field only has "import" (no "require"), so CJS
 * require.resolve fails. Resolution strategy:
 *
 * 1. import.meta.resolve — jiti's importMetaResolvePlugin rewrites this to its
 *    alias-aware resolver, which maps "@earendil-works/pi-coding-agent" to the
 *    actual install location (the loader's own __dirname), regardless of where
 *    the node binary lives. This is the robust path.
 *
 * 2. Fallback: derive from process.execPath
 *    (/prefix/bin/node → /prefix/lib/node_modules/...). Breaks when node is a
 *    symlink into a read-only store (e.g. nix), where execPath resolves away
 *    from the tree that holds the global packages — which is exactly why
 *    strategy 1 is preferred.
 */
async function rebuildDispatcher(): Promise<void> {
  const req = createRequire(import.meta.url);
  const candidates: string[] = [];

  // Strategy 1: import.meta.resolve (jiti-shimmed, alias-aware).
  try {
    const resolved = import.meta.resolve("@earendil-works/pi-coding-agent");
    candidates.push(dispatcherPathFromMain(fileURLToPath(resolved)));
  } catch {
    // import.meta.resolve unavailable or specifier unresolvable — fall through.
  }

  // Strategy 2 (fallback): process.execPath heuristic.
  const globalModules = join(dirname(dirname(process.execPath)), "lib", "node_modules");
  candidates.push(
    join(globalModules, "@earendil-works", "pi-coding-agent", "dist", "core", "http-dispatcher.js"),
  );

  const dispatcherPath = candidates.find(existsSync);
  if (!dispatcherPath) {
    throw new Error(
      "Could not locate pi-coding-agent's http-dispatcher.js. Tried:\n" +
        candidates.map((p) => `  - ${p}`).join("\n"),
    );
  }

  const { configureHttpDispatcher } = req(dispatcherPath);
  configureHttpDispatcher();
}

// --- Module state ---
let proxyEnv: Record<string, string> = {};
let enabled = false;
let footerUrlTimer: ReturnType<typeof setTimeout> | null = null;

// --- Footer ---
function refreshFooter(ctx: {
  hasUI: boolean;
  ui: { setStatus: (key: string, text: string | undefined) => void };
}): void {
  if (!ctx.hasUI) return;
  if (!enabled) {
    ctx.ui.setStatus(STATUS_KEY, t("footer.off", "○ Proxy off"));
  } else if (footerUrlTimer !== null) {
    const firstUrl = Object.values(proxyEnv)[0] ?? "";
    ctx.ui.setStatus(STATUS_KEY, t("footer.on", "● Proxy ({url})").replace("{url}", firstUrl));
  } else {
    ctx.ui.setStatus(STATUS_KEY, t("footer.on_short", "● Proxy on"));
  }
}

function showFooterUrlBriefly(ctx: {
  hasUI: boolean;
  ui: { setStatus: (key: string, text: string | undefined) => void };
}): void {
  if (footerUrlTimer !== null) clearTimeout(footerUrlTimer);
  refreshFooter(ctx);
  footerUrlTimer = setTimeout(() => {
    footerUrlTimer = null;
    refreshFooter(ctx);
  }, 10000);
}

// --- Entry point ---
export default function (pi: ExtensionAPI) {
  let config = loadConfig();
  enabled = config.enabled;
  if (enabled && existsSync(ENV_FILE_PATH)) {
    proxyEnv = readEnvFile(ENV_FILE_PATH);
  }

  // 1. Override bash tool for agent commands
  const cwd = process.cwd();
  const bashTool = createBashTool(cwd, {
    spawnHook: ({ command, cwd, env }) => ({
      command,
      cwd,
      env: { ...env, ...proxyEnv },
    }),
  });

  pi.registerTool({
    ...bashTool,
    execute: async (id, params, signal, onUpdate, _ctx) => {
      return bashTool.execute(id, params, signal, onUpdate);
    },
  });

  // 2. Intercept user_bash (! commands)
  pi.on("user_bash", () => {
    const local = createLocalBashOperations();
    return {
      operations: {
        exec(command, cwd, options) {
          return local.exec(command, cwd, {
            ...options,
            env: { ...(options.env ?? {}), ...proxyEnv },
          });
        },
      },
    };
  });

  // 3. session_start — restore state + sync process.env + rebuild dispatcher
  pi.on("session_start", async (_event, ctx) => {
    config = loadConfig();
    enabled = config.enabled;
    if (enabled && existsSync(ENV_FILE_PATH)) {
      proxyEnv = readEnvFile(ENV_FILE_PATH);
      syncProcessEnv(proxyEnv);
    } else {
      proxyEnv = {};
      cleanProcessEnv();
    }
    await rebuildDispatcher();
    refreshFooter(ctx);
  });

  // Ctrl+R detection: legacy (\x12), Kitty (CSI 114;5u), modifyOtherKeys (CSI 27;5;114~)
  function isCtrlR(data: string): boolean {
    return data === "\x12" || data === "\x1b[114;5u" || data === "\x1b[27;5;114~";
  }

  // 4. /proxy-config — edit .env in pi's built-in editor
  //     Ctrl+R inside the editor resets content to template.
  async function handleProxyConfig(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const envFile = ENV_FILE_PATH;

    // Ensure .env exists with template
    if (!existsSync(XDG_CONFIG_DIR)) mkdirSync(XDG_CONFIG_DIR, { recursive: true });
    if (!existsSync(envFile)) {
      writeFileSync(envFile, ENV_TEMPLATE, "utf-8");
    }

    // /proxy-config reset — quick reset to template
    const normalizedArgs = String(args || "").trim().toLowerCase();
    if (normalizedArgs === "reset" || normalizedArgs === "r") {
      resetEnvFile(envFile);
      proxyEnv = {};
      config.enabled = false;
      saveConfig(config);
      enabled = false;
      cleanProcessEnv();
      await rebuildDispatcher();
      refreshFooter(ctx);
      ctx.ui.notify(
        t("notify.config_reset", "已重置为模板，代理已关闭"),
        "info",
      );
      return;
    }

    // Edit loop: Ctrl+R cancels & reopens with template
    let content = readFileSync(envFile, "utf-8");
    let edited: string | undefined;

    while (true) {
      let resetRequested = false;

      const unsub = ctx.ui.onTerminalInput((data) => {
        if (isCtrlR(data)) {
          resetRequested = true;
          return { data: "\x1b" };
        }
        return undefined;
      });

      edited = await ctx.ui.editor(
        t("editor.title", "代理环境变量 KEY=VALUE — Enter 保存 · Ctrl+- 撤销 · Ctrl+Y 粘贴 · Ctrl+K 剪切至行尾 · Ctrl+U 剪切至行首 · Ctrl+A/E 行首/尾 · Ctrl+R 重置"),
        content,
      );

      unsub();

      if (resetRequested) {
        content = ENV_TEMPLATE;
        continue;
      }

      break;
    }

    if (edited === undefined) return;

    const pairs = parseProxyEnv(edited);
    if (Object.keys(pairs).length === 0) {
      ctx.ui.notify(t("notify.config_parse_fail", "未检测到有效的 KEY=VALUE，配置未更改"), "warning");
      return;
    }

    // Save
    writeEnvFile(envFile, pairs);
    proxyEnv = enabled ? { ...pairs } : {};
    config.enabled = enabled;
    saveConfig(config);

    // Sync to process.env + rebuild dispatcher if enabled
    if (enabled) {
      syncProcessEnv(pairs);
      await rebuildDispatcher();
    }

    refreshFooter(ctx);

    const stateLabel = enabled
      ? t("notify.config_state_on", "代理保持开启")
      : t("notify.config_state_off", "代理已关闭，使用 /proxy 开启");
    const count = Object.keys(pairs).length;
    ctx.ui.notify(
      t("notify.config_saved", "已保存 {count} 个代理变量").replace("{count}", String(count)) + "\n" + stateLabel,
      "info",
    );
  }

  pi.registerCommand("proxy-config", {
    description: "编辑代理环境变量（Ctrl+G 外部编辑器，Ctrl+R 重置为模板）— 参数 reset 可快速重置",
    handler: handleProxyConfig,
  });

  // 5. /proxy — enable
  pi.registerCommand("proxy", {
    description: "开启代理注入（需先 /proxy-config 配置）",
    handler: async (_args, ctx) => {
      if (!existsSync(ENV_FILE_PATH)) {
        ctx.ui.notify(
          t("notify.proxy_no_config", "配置文件不存在: {path}\n请先使用 /proxy-config 创建").replace("{path}", ENV_FILE_PATH),
          "warning",
        );
        return;
      }

      const pairs = readEnvFile(ENV_FILE_PATH);
      if (Object.keys(pairs).length === 0) {
        ctx.ui.notify(
          t("notify.proxy_empty", "{path} 中未配置任何变量\n请使用 /proxy-config 编辑").replace("{path}", ENV_FILE_PATH),
          "warning",
        );
        return;
      }

      proxyEnv = pairs;
      enabled = true;
      config.enabled = true;
      saveConfig(config);

      syncProcessEnv(pairs);
      await rebuildDispatcher();

      showFooterUrlBriefly(ctx);
      ctx.ui.notify(
        t("notify.proxy_on", "代理已开启 ({count} 个变量)").replace("{count}", String(Object.keys(pairs).length)),
        "info",
      );
    },
  });

  // 6. /proxy-unset — disable
  pi.registerCommand("proxy-unset", {
    description: "关闭代理注入",
    handler: async (_args, ctx) => {
      proxyEnv = {};
      enabled = false;
      config.enabled = false;
      saveConfig(config);

      cleanProcessEnv();
      await rebuildDispatcher();

      refreshFooter(ctx);
      ctx.ui.notify(t("notify.proxy_off", "代理已关闭"), "info");
    },
  });

  // 7. /proxy-status — show current config
  pi.registerCommand("proxy-status", {
    description: "查看当前代理配置和状态",
    handler: async (_args, ctx) => {
      const currentCfg = loadConfig();
      const envFile = ENV_FILE_PATH;
      const fileExists = existsSync(envFile);
      const pairs = fileExists ? readEnvFile(envFile) : {};

      const status = enabled
        ? t("notify.status_on", "已开启")
        : t("notify.status_off", "已关闭");
      const configLine = fileExists
        ? t("notify.status_config_file", "配置文件: {path}").replace("{path}", envFile)
        : t("notify.status_config_file", "配置文件: {path}").replace("{path}", envFile) + " " + t("notify.status_missing", "(不存在)");
      const lines = [
        t("notify.status_title", "代理状态: {status}").replace("{status}", status),
        configLine,
      ];

      if (Object.keys(pairs).length > 0) {
        lines.push(t("notify.status_env_header", "环境变量:"));
        for (const [k, v] of Object.entries(pairs)) {
          lines.push(`  ${k}=${v}`);
        }
      } else {
        lines.push(t("notify.status_no_vars", "未配置任何变量"));
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ═══════════════════════════════════════════════════════════
  // Agent-callable tools
  // ═══════════════════════════════════════════════════════════

  // --- Shared helpers for tools ---

  function readCurrentEnv(): Record<string, string> {
    if (!existsSync(ENV_FILE_PATH)) return {};
    try {
      return readEnvFile(ENV_FILE_PATH);
    } catch {
      return {};
    }
  }

  function persistEnv(env: Record<string, string>): void {
    writeEnvFile(ENV_FILE_PATH, env);
  }

  function applyProxyState(
    envPairs: Record<string, string>,
    enable: boolean,
    ctx: ExtensionContext,
  ): void {
    proxyEnv = enable ? { ...envPairs } : {};
    enabled = enable;
    config.enabled = enable;
    saveConfig(config);
    if (enable) {
      showFooterUrlBriefly(ctx);
    } else {
      refreshFooter(ctx);
    }
  }

  function formatEnvText(env: Record<string, string>): string {
    const keys = Object.keys(env);
    if (keys.length === 0) return "(none)";
    return keys.map((k) => `  ${k}=${env[k]}`).join("\n");
  }

  // 8. proxy_set — configure proxy env vars, enable injection immediately
  pi.registerTool({
    name: "proxy_set",
    label: "Proxy Set",
    description:
      "Configure proxy environment variables for this session and optionally enable injection. " +
      "Sets http_proxy, https_proxy, HTTP_PROXY, HTTPS_PROXY from proxyUrl; " +
      "all_proxy, ALL_PROXY from allProxy; no_proxy, NO_PROXY from noProxy. " +
      "Omitted parameters preserve existing values; pass an empty string to clear a group. " +
      "Changes are saved to disk and take effect immediately for all subsequent bash commands — no restart needed.",
    promptSnippet: "Set proxy env vars (http_proxy, no_proxy, etc.) — takes effect immediately",
    promptGuidelines: [
      "Use proxy_set to configure proxy URLs and no_proxy hosts. Changes apply immediately to all bash commands without restarting the session.",
      "Pass proxyUrl to set HTTP/HTTPS proxy, allProxy for SOCKS, noProxy for bypass hosts. Omit a parameter to keep the existing value; pass \"\" to clear it.",
    ],
    parameters: Type.Object({
      proxyUrl: Type.Optional(
        Type.String({
          description:
            "HTTP/HTTPS proxy URL, e.g. \"http://127.0.0.1:7890\". " +
            "Sets http_proxy, https_proxy, HTTP_PROXY, HTTPS_PROXY. " +
            "Pass \"\" to clear these vars. Omit to preserve existing values.",
        }),
      ),
      allProxy: Type.Optional(
        Type.String({
          description:
            "SOCKS/all-protocol proxy URL, e.g. \"socks5://127.0.0.1:7891\". " +
            "Sets all_proxy, ALL_PROXY. Pass \"\" to clear. Omit to preserve.",
        }),
      ),
      noProxy: Type.Optional(
        Type.String({
          description:
            "Comma-separated hosts to bypass, e.g. \"localhost,127.0.0.1,.local\". " +
            "Sets no_proxy, NO_PROXY. Pass \"\" to clear. Omit to preserve.",
        }),
      ),
      enable: Type.Optional(
        Type.Boolean({
          description: "Enable proxy injection immediately after saving (default: true).",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const { proxyUrl, allProxy, noProxy } = params;
      const enable = params.enable !== false;

      // Read current env as the baseline for diff
      const oldEnv = readCurrentEnv();
      const env = { ...oldEnv };
      const changes: string[] = [];

      if (proxyUrl !== undefined) {
        for (const key of PROXY_KEY_GROUPS.proxyUrl) {
          if (proxyUrl === "") delete env[key];
          else env[key] = proxyUrl;
        }
        changes.push(proxyUrl ? `proxyUrl=${proxyUrl}` : "proxyUrl cleared");
      }

      if (allProxy !== undefined) {
        for (const key of PROXY_KEY_GROUPS.allProxy) {
          if (allProxy === "") delete env[key];
          else env[key] = allProxy;
        }
        changes.push(allProxy ? `allProxy=${allProxy}` : "allProxy cleared");
      }

      if (noProxy !== undefined) {
        for (const key of PROXY_KEY_GROUPS.noProxy) {
          if (noProxy === "") delete env[key];
          else env[key] = noProxy;
        }
        changes.push(noProxy ? `noProxy=${noProxy}` : "noProxy cleared");
      }

      if (changes.length === 0 && Object.keys(env).length === 0) {
        return {
          content: [{
            type: "text",
            text: "No proxy variables configured and no parameters provided. " +
              "Call proxy_set with at least proxyUrl, allProxy, or noProxy.",
          }],
          details: { changes: [], enabled: false, env },
        };
      }

      persistEnv(env);

      if (Object.keys(env).length === 0) {
        applyProxyState(env, false, ctx);
        cleanProcessEnv();
        await rebuildDispatcher();
        ctx.ui.notify(t("notify.tool_set_empty", "No proxy variables to enable"), "warning");
        return {
          content: [{
            type: "text",
            text: "All proxy variables cleared. Proxy injection disabled.\n\nCurrent env:\n" +
              formatEnvText(env),
          }],
          details: { changes, enabled: false, env },
        };
      }

      applyProxyState(env, enable, ctx);

      // Sync to process.env
      if (enable) {
        syncProcessEnv(env);
        // Rebuild dispatcher only if proxy URL changed
        if (diffProxyUrl(oldEnv, env)) {
          await rebuildDispatcher();
        }
      } else {
        // Disabling: clean process.env and rebuild dispatcher
        cleanProcessEnv();
        await rebuildDispatcher();
      }

      const stateLabel = enable ? "enabled" : "disabled (config saved)";
      ctx.ui.notify(
        t("notify.proxy_on", "代理已开启 ({count} 个变量)").replace("{count}", String(Object.keys(env).length)),
        "info",
      );

      const text = [
        `Proxy ${stateLabel}. Changes: ${changes.length > 0 ? changes.join(", ") : "(none, just enabled)"}`,
        "",
        "Current proxy variables:",
        formatEnvText(env),
      ].join("\n");

      return {
        content: [{ type: "text", text }],
        details: { changes, enabled: enable, env },
      };
    },
  });

  // 9. proxy_unset — disable injection immediately
  pi.registerTool({
    name: "proxy_unset",
    label: "Proxy Unset",
    description:
      "Disable proxy injection immediately. The proxy configuration is preserved on disk " +
      "and can be re-enabled with proxy_set (enable: true) or the /proxy command.",
    promptSnippet: "Disable proxy injection immediately (config preserved)",
    promptGuidelines: [
      "Use proxy_unset to turn off proxy injection. The env file is preserved — use proxy_set or /proxy to re-enable.",
    ],
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const env = readCurrentEnv();
      applyProxyState(env, false, ctx);
      cleanProcessEnv();
      await rebuildDispatcher();
      ctx.ui.notify(t("notify.proxy_off", "代理已关闭"), "info");

      return {
        content: [{
          type: "text",
          text: "Proxy injection disabled. Configuration preserved on disk.\n" +
            "Use proxy_set or /proxy to re-enable.",
        }],
        details: { enabled: false, envCount: Object.keys(env).length },
      };
    },
  });

  // 10. proxy_status — return current status as tool result
  pi.registerTool({
    name: "proxy_status",
    label: "Proxy Status",
    description:
      "Get the current proxy status: enabled/disabled, all configured environment variables, " +
      "and the env file path. Use this to inspect the current proxy configuration before " +
      "making changes.",
    promptSnippet: "Check current proxy status and env vars",
    promptGuidelines: [
      "Call proxy_status to inspect the current proxy state before calling proxy_set or proxy_noproxy.",
    ],
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, _ctx) {
      const env = readCurrentEnv();
      const envFile = ENV_FILE_PATH;
      const fileExists = existsSync(envFile);

      const lines = [
        `Proxy: ${enabled ? "enabled" : "disabled"}`,
        `Config file: ${envFile}${fileExists ? "" : " (not found)"}`,
        "",
        "Environment variables:",
        formatEnvText(env),
      ];

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { enabled, envFile, fileExists, env },
      };
    },
  });

  // 11. proxy_noproxy — manage the no_proxy bypass list
  pi.registerTool({
    name: "proxy_noproxy",
    label: "Proxy NoProxy",
    description:
      "Manage the no_proxy bypass list. Add, remove, set, or clear hosts that should bypass the proxy. " +
      "Takes effect immediately if proxy is enabled. Updates both no_proxy and NO_PROXY env vars.",
    promptSnippet: "Manage no_proxy bypass list (add/remove/set/clear hosts)",
    promptGuidelines: [
      "Use proxy_noproxy to add or remove individual hosts from the no_proxy list without replacing the entire proxy config.",
      "action 'add' appends hosts (deduplicates); 'remove' deletes matching hosts; 'set' replaces the entire list; 'clear' empties it.",
    ],
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("add"),
          Type.Literal("remove"),
          Type.Literal("set"),
          Type.Literal("clear"),
        ],
        {
          description:
            "What to do with the no_proxy list: 'add' appends hosts (deduplicates); " +
            "'remove' deletes matching hosts; 'set' replaces the entire list; 'clear' empties it.",
        },
      ),
      hosts: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Host entries for add/remove/set actions, e.g. [\"localhost\", \"127.0.0.1\", \".internal\"]. " +
            "Ignored for 'clear' action.",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const { action } = params;
      const hosts = params.hosts ?? [];

      if ((action === "add" || action === "remove" || action === "set") && hosts.length === 0) {
        return {
          content: [{
            type: "text",
            text: `Error: action \"${action}\" requires at least one host in the 'hosts' parameter.`,
          }],
          details: { action, hosts: [], error: true },
        };
      }

      const env = readCurrentEnv();
      const currentNoProxy = env["no_proxy"] ?? "";
      const currentHosts = currentNoProxy
        .split(",")
        .map((h) => h.trim())
        .filter(Boolean);

      let newHosts: string[];
      let actionLabel: string;

      switch (action) {
        case "add":
          newHosts = [...new Set([...currentHosts, ...hosts])];
          actionLabel = `added ${newHosts.length - currentHosts.length} host(s)`;
          break;
        case "remove":
          newHosts = currentHosts.filter((h) => !hosts.includes(h));
          actionLabel = `removed ${currentHosts.length - newHosts.length} host(s)`;
          break;
        case "set":
          newHosts = [...new Set(hosts)];
          actionLabel = `set to ${newHosts.length} host(s)`;
          break;
        case "clear":
          newHosts = [];
          actionLabel = "cleared";
          break;
      }

      const noProxyValue = newHosts.join(",");
      for (const key of PROXY_KEY_GROUPS.noProxy) {
        if (noProxyValue === "") delete env[key];
        else env[key] = noProxyValue;
      }

      persistEnv(env);

      if (enabled) {
        proxyEnv = { ...env };
        syncProcessEnv(env);
      }

      ctx.ui.notify(
        t("notify.tool_noproxy", "no_proxy 已更新 ({action})").replace("{action}", action),
        "info",
      );

      const text = [
        `no_proxy ${actionLabel}.`,
        "",
        `Current no_proxy: ${noProxyValue || "(empty)"}`,
        enabled ? "Proxy is currently enabled — change takes effect immediately." : "Proxy is currently disabled.",
      ].join("\n");

      return {
        content: [{ type: "text", text }],
        details: { action, hosts, newHosts, noProxy: noProxyValue, enabled },
      };
    },
  });
}
