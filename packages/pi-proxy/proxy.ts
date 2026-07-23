import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool, createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
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

// --- Constants ---
const CONFIG_DIR = join(homedir(), ".pi", "agent");
const CONFIG_FILE = join(CONFIG_DIR, "proxy-config.json");
const DEFAULT_ENV_FILE = join(CONFIG_DIR, "proxy.env");
const STATUS_KEY = "proxy";

const ENV_TEMPLATE = `# http_proxy=http://127.0.0.1:7890
# https_proxy=http://127.0.0.1:7890
# all_proxy=socks5://127.0.0.1:7891
# no_proxy=localhost,127.0.0.1,.local
`;

// --- Config ---
interface ProxyConfig {
  envFile: string;
  enabled: boolean;
}

function loadConfig(): ProxyConfig {
  try {
    const raw = readFileSync(CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return {
        envFile: typeof parsed.envFile === "string" ? parsed.envFile : DEFAULT_ENV_FILE,
        enabled: Boolean(parsed.enabled),
      };
    }
  } catch {
    // first run
  }
  return { envFile: DEFAULT_ENV_FILE, enabled: false };
}

function saveConfig(config: ProxyConfig): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
}

// --- .env file reader / writer ---
function readEnvFile(filePath: string): Record<string, string> {
  const raw = readFileSync(filePath, "utf-8");
  const result: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
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

function writeEnvFile(filePath: string, env: Record<string, string>): void {
  const lines = ["# 代理环境变量", "# /proxy 开启后注入到所有 bash 命令", ""];
  for (const [k, v] of Object.entries(env)) {
    lines.push(`${k}=${v}`);
  }
  lines.push("");
  writeFileSync(filePath, lines.join("\n"), "utf-8");
}

// --- Module state ---
let proxyEnv: Record<string, string> = {};
let enabled = false;

// --- Footer ---
function refreshFooter(ctx: {
  hasUI: boolean;
  ui: { setStatus: (key: string, text: string | undefined) => void };
}): void {
  if (!ctx.hasUI) return;
  if (!enabled) {
    ctx.ui.setStatus(STATUS_KEY, t("footer.off", "○ Proxy off"));
  } else {
    const firstUrl = Object.values(proxyEnv)[0] ?? "";
    ctx.ui.setStatus(STATUS_KEY, t("footer.on", "● Proxy ({url})").replace("{url}", firstUrl));
  }
}

// --- Entry point ---
export default function (pi: ExtensionAPI) {
  let config = loadConfig();
  enabled = config.enabled;
  if (enabled && existsSync(config.envFile)) {
    proxyEnv = readEnvFile(config.envFile);
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

  // 3. session_start — restore state + footer
  pi.on("session_start", async (_event, ctx) => {
    config = loadConfig();
    enabled = config.enabled;
    if (enabled && existsSync(config.envFile)) {
      proxyEnv = readEnvFile(config.envFile);
    } else {
      proxyEnv = {};
    }
    refreshFooter(ctx);
  });

  // 4. /proxy-config — edit .env in pi's built-in editor
  pi.registerCommand("proxy-config", {
    description: "编辑代理环境变量（Shift+Enter 换行，Ctrl+G 外部编辑器）",
    handler: async (_args, ctx) => {
      const envFile = config.envFile;

      // Ensure .env exists with template
      if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
      if (!existsSync(envFile)) {
        writeFileSync(envFile, ENV_TEMPLATE, "utf-8");
      }

      const current = readFileSync(envFile, "utf-8");

      const edited = await ctx.ui.editor(
        t("editor.title", "编辑代理环境变量 — 每行一个 KEY=VALUE（Shift+Enter 换行，Enter 提交）"),
        current,
      );

      if (edited === undefined) return; // user cancelled

      // Parse and validate
      const pairs = readEnvLines(edited);
      if (Object.keys(pairs).length === 0) {
        ctx.ui.notify(t("notify.config_parse_fail", "未检测到有效的 KEY=VALUE，配置未更改"), "warning");
        return;
      }

      // Save — 保持当前 enabled 状态不变
      writeEnvFile(envFile, pairs);
      proxyEnv = enabled ? { ...pairs } : {};
      config.enabled = enabled;
      saveConfig(config);
      refreshFooter(ctx);

      const stateLabel = enabled
        ? t("notify.config_state_on", "代理保持开启")
        : t("notify.config_state_off", "代理已关闭，使用 /proxy 开启");
      const count = Object.keys(pairs).length;
      ctx.ui.notify(
        t("notify.config_saved", "已保存 {count} 个代理变量").replace("{count}", String(count)) + "\n" + stateLabel,
        "info",
      );
    },
  });

  // 5. /proxy — enable
  pi.registerCommand("proxy", {
    description: "开启代理注入（需先 /proxy-config 配置）",
    handler: async (_args, ctx) => {
      const envFile = config.envFile;
      if (!existsSync(envFile)) {
        ctx.ui.notify(
          t("notify.proxy_no_config", "配置文件不存在: {path}\n请先使用 /proxy-config 创建").replace("{path}", envFile),
          "warning",
        );
        return;
      }

      const pairs = readEnvFile(envFile);
      if (Object.keys(pairs).length === 0) {
        ctx.ui.notify(
          t("notify.proxy_empty", "{path} 中未配置任何变量\n请使用 /proxy-config 编辑").replace("{path}", envFile),
          "warning",
        );
        return;
      }

      proxyEnv = pairs;
      enabled = true;
      config.enabled = true;
      saveConfig(config);

      refreshFooter(ctx);
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

      refreshFooter(ctx);
      ctx.ui.notify(t("notify.proxy_off", "代理已关闭"), "info");
    },
  });

  // 7. /proxy-status — show current config
  pi.registerCommand("proxy-status", {
    description: "查看当前代理配置和状态",
    handler: async (_args, ctx) => {
      const currentCfg = loadConfig();
      const envFile = currentCfg.envFile;
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
}

// --- Inline parser (no file dependency, used for editor output) ---
function readEnvLines(text: string): Record<string, string> {
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
