/**
 * Command handlers for skill-presets.
 *
 * Commands:
 * - /preset          — Open TUI dialog for browsing/toggling presets
 * - /preset-load     — Load a preset by name
 * - /preset-off      — Offload a preset by name
 * - /preset-status   — Show current active set status
 */

import type { ExtensionCommandContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PresetState } from "./preset-state.ts";
import type { PresetOpEntry } from "./types.ts";
import { PRESET_OP_CUSTOM_TYPE } from "./types.ts";
import { readPresetsConfig, getPresetSkills } from "./config.ts";
import { showPresetDialog } from "./dialog.ts";
import { recordNotify } from "./notify.ts";
import type { PresetsConfig } from "./types.ts";

/**
 * Skills of a preset that are absent from the platform's discovered skill set
 * (ctx.getSystemPromptOptions().skills). Single criterion by design: a missing
 * name is reported as "missing or disabled" without distinguishing the cause.
 */
function findBadRefs(
  ctx: ExtensionCommandContext,
  config: PresetsConfig,
  presetName: string,
): string[] {
  const platform = new Set((ctx.getSystemPromptOptions().skills ?? []).map((s) => s!.name));
  return (getPresetSkills(config, presetName) ?? []).filter((s) => !platform.has(s));
}

/** The custom type for preset operation entries. */

/**
 * Create command handlers with shared state.
 *
 * @param pi - The ExtensionAPI instance (for appendEntry)
 * @param state - The preset state (active set)
 * @param getCwd - Function to get current cwd
 * @param getDefaultPreset - Function to get default preset name
 */
export function createCommands(
  pi: ExtensionAPI,
  state: PresetState,
  getCwd: () => string,
  getDefaultPreset: () => string | undefined,
) {
  /** /preset — TUI dialog */
  async function presetCommand(_args: string, ctx: ExtensionCommandContext): Promise<void> {
    const cwd = getCwd();
    const config = readPresetsConfig(cwd);
    const defaultPreset = getDefaultPreset();
    await showPresetDialog(ctx, pi, state, config, defaultPreset);
  }

  /** /preset-load <name> */
  async function presetLoadCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const name = args.trim();
    if (!name) {
      ctx.ui.notify("Usage: /preset-load <name>", "info");
      return;
    }

    const cwd = getCwd();
    const config = readPresetsConfig(cwd);

    if (!config.definitions[name]) {
      recordNotify(
        ctx.ui,
        `Preset "${name}" not found. Available: ${Object.keys(config.definitions).join(", ")}`,
        "error",
      );
      return;
    }

    const badRefs = findBadRefs(ctx, config, name);

    if (state.has(name)) {
      // Repeat load of a bad preset warns again (no cross-action dedup).
      if (badRefs.length > 0) {
        recordNotify(
          ctx.ui,
          `Preset "${name}" is already loaded, but these skills are unavailable (missing or disabled): ${badRefs.join(", ")}`,
          "warning",
        );
      }
      ctx.ui.notify(`Preset "${name}" is already loaded.`, "info");
      return;
    }

    if (badRefs.length > 0) {
      recordNotify(
        ctx.ui,
        `Preset "${name}" loaded, but these skills are unavailable (missing or disabled): ${badRefs.join(", ")}`,
        "warning",
      );
    }

    doLoad(pi, ctx, state, name);
  }

  /** /preset-off <name> */
  async function presetOffCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const name = args.trim();
    if (!name) {
      ctx.ui.notify("Usage: /preset-off <name>", "info");
      return;
    }

    const defaultPreset = getDefaultPreset();
    if (defaultPreset && name === defaultPreset) {
      recordNotify(
        ctx.ui,
        `Preset "${name}" is the default preset and cannot be offloaded.`,
        "error",
      );
      return;
    }

    if (!state.has(name)) {
      ctx.ui.notify(`Preset "${name}" is not loaded.`, "info");
      return;
    }

    doOffload(pi, ctx, state, name);
  }

  /** /preset-prompt — Dump system prompt to file */
  async function presetPromptCommand(_args: string, ctx: ExtensionCommandContext): Promise<void> {
    const prompt = ctx.getSystemPrompt();
    if (!prompt) {
      ctx.ui.notify("System prompt is empty.", "warning");
      return;
    }
    const outPath = `${getCwd()}/system-prompt-dump.txt`;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(outPath, prompt, "utf-8");
    ctx.ui.notify(`System prompt (${prompt.length} chars) written to ${outPath}`, "info");
  }

  /** /preset-status */
  async function presetStatusCommand(_args: string, ctx: ExtensionCommandContext): Promise<void> {
    const cwd = getCwd();
    const config = readPresetsConfig(cwd);
    const defaultPreset = getDefaultPreset();
    const loaded = state.getLoaded();

    if (loaded.length === 0 && !defaultPreset) {
      ctx.ui.notify("No presets loaded.", "info");
      return;
    }

    const lines: string[] = [];

    if (defaultPreset) {
      const skills = getPresetSkills(config, defaultPreset) ?? [];
      const missing = config.definitions[defaultPreset] ? "" : " (missing from config)";
      lines.push(`Default: ${defaultPreset}${missing} (${skills.length} skills → system prompt)`);
    }

    if (loaded.length > 0) {
      lines.push("Active set:");
      for (const name of loaded) {
        const skills = getPresetSkills(config, name) ?? [];
        const notes: string[] = [];
        if (name === defaultPreset) notes.push("default, system prompt");
        if (!config.definitions[name]) notes.push("missing from config");
        const marker = notes.length > 0 ? ` (${notes.join(", ")})` : "";
        lines.push(`  ${name}${marker}: ${skills.join(", ")}`);
      }
    }

    ctx.ui.notify(lines.join("\n"), "info");
  }

  return {
    presetCommand,
    presetLoadCommand,
    presetOffCommand,
    presetStatusCommand,
    presetPromptCommand,
  };
}

/** Execute a load operation: update state + append entry. */
function doLoad(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  state: PresetState,
  presetName: string,
): void {
  state.load(presetName);
  const entry: PresetOpEntry = {
    action: "load",
    preset: presetName,
    timestamp: Date.now(),
  };
  pi.appendEntry(PRESET_OP_CUSTOM_TYPE, entry);
  ctx.ui.notify(`Loaded preset "${presetName}".`, "info");
}

/** Execute an offload operation: update state + append entry. */
function doOffload(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  state: PresetState,
  presetName: string,
): void {
  state.offload(presetName);
  const entry: PresetOpEntry = {
    action: "offload",
    preset: presetName,
    timestamp: Date.now(),
  };
  pi.appendEntry(PRESET_OP_CUSTOM_TYPE, entry);
  ctx.ui.notify(`Offloaded preset "${presetName}".`, "info");
}
