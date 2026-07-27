/**
 * skill-presets — pi extension
 *
 * Prefix-cache-aware dynamic skill loading via named presets.
 *
 * - Default preset → settings.skills → system prompt (persistent, all sessions)
 * - Non-default presets → transient injection via context event (session-level)
 * - Load/offload operations persisted as custom entries for restart recovery
 * - Coexists with @vanillagreen/pi-skills-manager (respects +/- toggle state)
 *
 * Commands:
 *   /preset            — Open TUI dialog for browsing/toggling presets
 *   /preset-load <n>   — Load a preset by name
 *   /preset-off <n>    — Offload a preset by name
 *   /preset-status     — Show current active set status
 *
 * Install: pi install ./skill-presets (from ~/projects/pi-mypackage)
 *   Test:  pi -e ./index.ts
 */

import type { ExtensionAPI, CustomEntry } from "@earendil-works/pi-coding-agent";
import { PresetState } from "./src/preset-state.ts";
import { createCommands, PRESET_OP_CUSTOM_TYPE } from "./src/commands.ts";
import { createInjector } from "./src/injector.ts";
import { applyDefaultPreset } from "./src/default-preset.ts";
import { readPresetsConfig } from "./src/config.ts";
import type { PresetOpEntry } from "./src/types.ts";

export default function skillPresetsExtension(pi: ExtensionAPI) {
  // Shared state
  const state = new PresetState();
  let cwd = process.cwd();
  let defaultPresetName: string | undefined;

  // --- session_start: apply default preset + rebuild active set ---
  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd;

    // Apply default preset: write skills to settings.skills
    const result = await applyDefaultPreset(cwd);
    defaultPresetName = result?.name;

    // Rebuild active set from persistent entries
    const entries = ctx.sessionManager.getEntries();
    const presetOps: PresetOpEntry[] = entries
      .filter(
        (e): e is CustomEntry<PresetOpEntry> =>
          e.type === "custom" && e.customType === PRESET_OP_CUSTOM_TYPE,
      )
      .map((e) => e.data as PresetOpEntry)
      .filter(
        (d) =>
          d !== undefined &&
          typeof d.action === "string" &&
          typeof d.preset === "string",
      );

    state.replayEntries(presetOps);
  });

  // --- context event: transient injection ---
  pi.on("context", (event, ctx) => {
    const config = readPresetsConfig(cwd);
    const injector = createInjector(state, config, cwd, ctx, defaultPresetName);
    return injector(event.messages);
  });

  // --- Commands ---
  const commands = createCommands(
    pi,
    state,
    () => cwd,
    () => defaultPresetName,
  );

  pi.registerCommand("preset", {
    description: "Browse and toggle preset loading",
    handler: commands.presetCommand,
  });

  pi.registerCommand("preset-load", {
    description: "Load a preset by name",
    handler: commands.presetLoadCommand,
  });

  pi.registerCommand("preset-off", {
    description: "Offload a preset by name",
    handler: commands.presetOffCommand,
  });

  pi.registerCommand("preset-status", {
    description: "Show current preset active set",
    handler: commands.presetStatusCommand,
  });
}
