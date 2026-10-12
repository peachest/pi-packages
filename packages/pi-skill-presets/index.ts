/**
 * skill-presets — pi extension
 *
 * Prefix-cache-aware dynamic skill loading via named presets.
 *
 * - before_agent_start mutates systemPromptOptions.skills statelessly every turn:
 *   allowed = default preset ∪ active-set presets, intersected with pi's
 *   discovered skills by name, written back as a new array; returns undefined so
 *   pi renders the section diff itself (prefix cache stays intact)
 * - Load/offload operations persisted as custom entries for restart recovery
 * - Does not write settings.skills — skill-manager owns +/- exclusively; this
 *   package only reads the `-` patterns (pi excludes them at discovery) and
 *   manages its own presets block
 *
 * Commands:
 *   /preset            — Open TUI dialog for browsing/toggling presets
 *   /preset-load <n>   — Load a preset by name
 *   /preset-off <n>    — Offload a preset by name
 *   /preset-status     — Show current active set status
 *   /preset-prompt     — Dump system prompt to file
 */

import type {
  ExtensionAPI,
  CustomEntry,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { PresetState } from "./src/preset-state.ts";
import { createCommands } from "./src/commands.ts";
import { PRESET_OP_CUSTOM_TYPE } from "./src/types.ts";
import { readPresetsConfig } from "./src/config.ts";
import type { PresetOpEntry } from "./src/types.ts";

export default function skillPresetsExtension(pi: ExtensionAPI) {
  // Shared state
  const state = new PresetState();
  let cwd = process.cwd();
  let defaultPresetName: string | undefined;

  /**
   * Rebuild the active set from the current leaf path.
   *
   * Path-aware replay: buildContextEntries() walks the tree from the current
   * leaf (compaction-aware), so preset-ops on abandoned branches are excluded.
   * For linear/v2 sessions this equals the full entry list, keeping backwards
   * compatibility. Used by both session_start and session_tree (#64).
   */
  const rebuildActiveSet = (sessionManager: {
    buildContextEntries(): SessionEntry[];
  }) => {
    // Clear active set and load default preset (always in active set)
    state.clear();
    if (defaultPresetName) {
      state.load(defaultPresetName);
    }

    // Replay persistent entries to restore presets beyond the default one
    const entries = sessionManager.buildContextEntries();
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
  };

  // --- session_start: rebuild active set from current leaf path ---
  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd;

    // Read config to get default preset name
    const config = readPresetsConfig(cwd);
    defaultPresetName = config.default;

    rebuildActiveSet(ctx.sessionManager);
  });

  // --- session_tree: rebuild active set after tree navigation (#64) ---
  pi.on("session_tree", async (_event, ctx) => {
    rebuildActiveSet(ctx.sessionManager);
  });

  // --- before_agent_start: stateless per-turn skills mutation ---
  pi.on("before_agent_start", (event, _ctx) => {
    const config = readPresetsConfig(cwd);

    // Per-turn default refresh: settings.json can change mid-session; keep
    // defaultPresetName and the active set in sync. state.load is idempotent
    // and side-effect free, so calling it every turn is safe.
    defaultPresetName = config.default;
    if (config.default) {
      state.load(config.default);
    }

    const resolved = state.resolveSkills(config);

    // Zero-config passthrough (strict): only when no presets are configured
    // AND the active set is empty. A configured preset that resolves to zero
    // skills (empty skills list or all-missing) still writes back an empty
    // array to clear pi's advertised skills.
    const noPresetsConfigured =
      Object.keys(config.definitions).length === 0 && config.default === undefined;
    if (noPresetsConfigured && state.getLoaded().length === 0) return undefined;

    const allowed = new Set(resolved.skillNames);
    const present = new Set<string>();
    // Dedup by name (a skill listed by multiple presets renders once); keep
    // pi's discovery order for the skills pi already found.
    const nextSkills = (event.systemPromptOptions.skills ?? []).filter((skill) => {
      if (!allowed.has(skill.name) || present.has(skill.name)) return false;
      present.add(skill.name);
      return true;
    });

    // Bad-reference collection: preset-listed names absent from pi discovery.
    // Data structure only — warning surfacing lands with #63.
    const missingSkillNames = [...allowed].filter((name) => !present.has(name));

    event.systemPromptOptions.skills = nextSkills;
    return undefined;
  });

  // --- Commands ---
  const commands = createCommands(
    pi,
    state,
    () => cwd,
    () => defaultPresetName,
    // A load-time bad-reference warning consumes the pending replay warning
    // so the next turn does not repeat it.
    () => {
      replayWarningPending = false;
    },
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

// --- Programmatic surface -------------------------------------------------
// Tests and external consumers import from this entry (packages/README.md
// rule 3: no deep imports into src/). Selected exports, not a barrel.
export { PresetState } from "./src/preset-state.ts";
export { createCommands } from "./src/commands.ts";
export {
  getAgentDir,
  getDefaultPresetName,
  getPresetSkills,
  readPresetsConfig,
  writePresetsConfig,
} from "./src/config.ts";
export {
  recordNotify,
  setNotifyObserver,
} from "./src/notify.ts";
export type { NotifyLevel, RecordedNotification } from "./src/notify.ts";
export { PRESET_OP_CUSTOM_TYPE } from "./src/types.ts";
export type {
  PresetDefinition,
  PresetOpEntry,
  PresetsConfig,
  ResolvedActiveSet,
} from "./src/types.ts";
