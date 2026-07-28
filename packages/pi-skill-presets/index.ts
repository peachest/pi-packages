/**
 * skill-presets — pi extension
 *
 * Prefix-cache-aware dynamic skill loading via named presets.
 *
 * - System prompt filtering via before_agent_start (session start / reload)
 * - Transient injection via context event (mid-session preset loads)
 * - Load/offload operations persisted as custom entries for restart recovery
 * - Does NOT touch settings.json — skill-manager owns +/- exclusively
 *
 * Commands:
 *   /preset            — Open TUI dialog for browsing/toggling presets
 *   /preset-load <n>   — Load a preset by name
 *   /preset-off <n>    — Offload a preset by name
 *   /preset-status     — Show current active set status
 *   /preset-prompt     — Dump system prompt to file
 */

import type { ExtensionAPI, CustomEntry } from "@earendil-works/pi-coding-agent";
import { PresetState } from "./src/preset-state.ts";
import { createCommands, PRESET_OP_CUSTOM_TYPE } from "./src/commands.ts";
import { createInjector } from "./src/injector.ts";
import { filterSystemPrompt } from "./src/prompt-filter.ts";
import { readPresetsConfig } from "./src/config.ts";
import type { PresetOpEntry } from "./src/types.ts";

export default function skillPresetsExtension(pi: ExtensionAPI) {
  // Shared state
  const state = new PresetState();
  let cwd = process.cwd();
  let defaultPresetName: string | undefined;

  // v2: needsFilter flag — controls when before_agent_start re-filters the system prompt.
  // Set to true by session_start, consumed by next before_agent_start.
  let needsFilter = true;

  // Cached filtered system prompt. Returned every turn to prevent pi from
  // resetting to the unfiltered _baseSystemPrompt. Same string → KV cache hit.
  let cachedSystemPrompt: string | undefined;

  // v2: tracks which skill names are in the system prompt after filtering.
  // Used by the injector to exclude them from transient injection.
  let systemPromptSkillNames: Set<string> = new Set();

  // --- session_start: rebuild active set + set needsFilter ---
  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd;

    // Read config to get default preset name
    const config = readPresetsConfig(cwd);
    defaultPresetName = config.default;

    // Clear active set and load default preset (always in active set)
    state.clear();
    if (defaultPresetName) {
      state.load(defaultPresetName);
    }

    // Replay persistent entries to restore non-default presets
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

    // Replay on top of default preset (don't clear — default is already loaded)
    for (const entry of presetOps) {
      if (entry.action === "load") {
        state.load(entry.preset);
      } else if (entry.action === "offload") {
        state.offload(entry.preset);
      }
    }

    // Signal before_agent_start to re-filter on next call
    needsFilter = true;
    cachedSystemPrompt = undefined;
  });

  // --- before_agent_start: filter system prompt available_skills ---
  pi.on("before_agent_start", (event, _ctx) => {
    if (needsFilter) {
      // Session start / reload: recompute filtered prompt
      needsFilter = false;
      const config = readPresetsConfig(cwd);
      const activeSkillNames = state.getActiveSkillNames(config);

      const result = filterSystemPrompt(
        event.systemPrompt,
        event.systemPromptOptions.skills ?? [],
        activeSkillNames,
        cwd,
      );

      // Track which skills are now in the system prompt (for injector exclusion)
      systemPromptSkillNames = result.filteredSkillNames;

      // Cache the filtered prompt (or the base if no filtering needed)
      cachedSystemPrompt = result.systemPrompt ?? event.systemPrompt;
    }

    // Return cached prompt every turn.
    // Same string → KV cache hit. Without this, pi resets to _baseSystemPrompt (unfiltered).
    if (cachedSystemPrompt !== undefined) {
      return { systemPrompt: cachedSystemPrompt };
    }
    return undefined;
  });

  // --- context event: transient injection ---
  pi.on("context", (event, ctx) => {
    const config = readPresetsConfig(cwd);
    const injector = createInjector(state, config, cwd, ctx, systemPromptSkillNames);
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

  pi.registerCommand("preset-prompt", {
    description: "Dump system prompt to file",
    handler: commands.presetPromptCommand,
  });
}
