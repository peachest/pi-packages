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
import { readPresetsConfig, getPresetSkills } from "./config.ts";
import { showPresetDialog } from "./dialog.ts";

/** The custom type for preset operation entries. */
export const PRESET_OP_CUSTOM_TYPE = "preset-op";

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
    await showPresetDialog(ctx, state, config, defaultPreset);
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
      ctx.ui.notify(
        `Preset "${name}" not found. Available: ${Object.keys(config.definitions).join(", ")}`,
        "error",
      );
      return;
    }

    if (state.has(name)) {
      ctx.ui.notify(`Preset "${name}" is already loaded.`, "info");
      return;
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

    if (!state.has(name)) {
      ctx.ui.notify(`Preset "${name}" is not loaded.`, "info");
      return;
    }

    doOffload(pi, ctx, state, name);
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
      lines.push(`Default: ${defaultPreset} (${skills.length} skills → system prompt)`);
    }

    if (loaded.length > 0) {
      lines.push("Active set:");
      for (const name of loaded) {
        const skills = getPresetSkills(config, name) ?? [];
        const isDefault = name === defaultPreset;
        const marker = isDefault ? " (default, system prompt)" : "";
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
