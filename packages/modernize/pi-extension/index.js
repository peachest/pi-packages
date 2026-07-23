import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, "..");

const REFERENCES_DIR = join(PKG_ROOT, "references");

const RESOLVED = Symbol("resolved");

// ——— Mode parsing ———

/** @returns {{ type: "set-mode" | "status" | "invalid", mode?: "proactive" | "reactive" }} */
function parseModeCommand(text) {
  const normalized = String(text || "").trim().toLowerCase();
  if (!normalized) return { type: "status" };

  if (normalized === "proactive" || normalized === "on") return { type: "set-mode", mode: "proactive" };
  if (normalized === "reactive" || normalized === "off") return { type: "set-mode", mode: "reactive" };

  return { type: "invalid" };
}

function isDeactivationCommand(text) {
  const t = String(text || "").trim().toLowerCase().replace(/[.!?\s]+$/, "");
  return t === "stop modernize" || t === "normal mode";
}

// ——— Reference reading ———

function readReference(lang) {
  const file = join(REFERENCES_DIR, `${lang}.md`);
  if (!existsSync(file)) return null;
  return readFileSync(file, "utf-8");
}

function buildInstructions(mode, language) {
  const refs = [];
  for (const lang of language) {
    const content = readReference(lang);
    if (content) refs.push(`## ${lang.toUpperCase()} Modern Features\n\n${content}`);
  }

  if (refs.length === 0) return null;

  const modeLabel = mode === "proactive"
    ? "ACTIVE — write modern syntax by default"
    : "AVAILABLE on request — run /modernize or call the modernize-review/modernize-fix skills";

  return [
    `MODERNIZE MODE — ${modeLabel}`,
    "",
    "When writing or modifying code in these languages, prefer the latest stable syntax and language features.",
    "Do NOT use deprecated patterns even if they still compile/work.",
    "Keep compatibility — only use syntax that is available in the minimum supported version of the language for the project.",
    "",
    ...refs,
    "",
    "## Rules",
    "",
    "- Prefer modern syntax over deprecated equivalents (e.g., Go 1.21+ slices package over manual slice ops, TS `as const` over manual literal types)",
    "- Do NOT upgrade dependency versions just to enable modern syntax — the project's existing toolchain determines what's available",
    "- If unsure whether a syntax is available, check go.mod / tsconfig.json / package.json for the target version",
    "- Mark intentional legacy code with a `modernize:` comment (`// modernize: keep old syntax for Node 16 compat`)",
    "",
    "Turn off: 'stop modernize' / 'normal mode'.",
  ].join("\n");
}

// ——— Session entry key ———

const MODE_ENTRY_TYPE = "modernize-mode";

function resolveSessionMode(entries, fallbackMode) {
  if (fallbackMode === "proactive" || fallbackMode === "reactive") {
    // if it's been explicitly set in this session, that wins
  }
  if (!Array.isArray(entries)) return fallbackMode;

  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "custom" || entry?.customType !== MODE_ENTRY_TYPE) continue;
    const mode = entry?.data?.mode;
    if (mode === "proactive" || mode === "reactive") return mode;
  }
  return fallbackMode;
}

// ——— Extension entry ———

export default function modernizeExtension(pi) {
  let activeMode = "proactive";

  pi.registerCommand("modernize", {
    description: "Report or toggle modernize mode. /modernize proactive|reactive|on|off",
    handler: async (args, ctx) => {
      const parsed = parseModeCommand(args);

      if (parsed.type === "set-mode") {
        activeMode = parsed.mode;
        pi.appendEntry(MODE_ENTRY_TYPE, { mode: parsed.mode });
        ctx?.ui?.notify?.(`Modernize mode set to ${parsed.mode}.`, "info");
        return;
      }

      if (parsed.type === "status") {
        ctx?.ui?.notify?.(`Modernize: current ${activeMode}`, "info");
        return;
      }

      ctx?.ui?.notify?.(`Unknown mode "${args}". Use proactive|reactive|on|off`, "warning");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const entries = ctx?.sessionManager?.getBranch?.()
      || ctx?.sessionManager?.getEntries?.() || [];
    activeMode = resolveSessionMode(entries, "proactive");
  });

  pi.on("before_agent_start", (event) => {
    if (activeMode === "reactive") return;

    const prompt = event.systemPrompt ?? "";
    const files = [...prompt.matchAll(/\.(go|ts|tsx|js|jsx|mjs|cjs)(?=\s|"|'|,|;|$)/gi)].map((m) => m[1].toLowerCase());
    const languages = new Set(
      files.map((ext) => {
        if (ext === "go") return "go";
        if (["ts", "tsx"].includes(ext)) return "ts";
        return "js";
      }),
    );
    if (languages.size === 0) return;

    const langList = [...languages].map(l => l === "js" ? "ts" : l);
    const instructions = buildInstructions(activeMode, langList);
    if (!instructions) return;

    return {
      systemPrompt: `${event.systemPrompt}\n\n${instructions}`,
    };
  });

  pi.on("input", (event) => {
    if (isDeactivationCommand(event.text)) {
      activeMode = "reactive";
      pi.appendEntry(MODE_ENTRY_TYPE, { mode: "reactive" });
    }
  });
}