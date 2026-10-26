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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PresetState } from "./src/preset-state.ts";
import { createCommands } from "./src/commands.ts";
import { readPresetsConfig } from "./src/config.ts";
import { markWarned, recordNotify, resetScope, unseenWarned, warnedNames } from "./src/notify.ts";
import { turnFilter } from "./src/turn-gate.ts";

export default function skillPresetsExtension(pi: ExtensionAPI) {
  // Shared state
  const state = new PresetState();
  let cwd = process.cwd();
  let defaultPresetName: string | undefined;

  // One-shot settings-corruption notify (ocr R11M2): while readPresetsConfig
  // throws (corrupt settings.json), notify once per continuous failure period
  // instead of every turn; reset on the first successful read so a later
  // corruption notifies again.
  let settingsErrorNotified = false;

  /** Read presets config; on unreadable settings notify once and return null. */
  const readConfigOrNotify = (
    ui: { notify(message: string, level?: string): void } | undefined,
  ): ReturnType<typeof readPresetsConfig> | null => {
    try {
      const config = readPresetsConfig(cwd);
      settingsErrorNotified = false;
      return config;
    } catch (err) {
      if (!settingsErrorNotified) {
        settingsErrorNotified = true;
        const reason = err instanceof Error ? err.message : String(err);
        recordNotify(
          ui,
          `skill-presets: settings.json unreadable, presets inactive: ${reason}`,
          "error",
        );
      }
      return null;
    }
  };

  /**
   * Rebuild the active set from the current leaf path.
   *
   * Full-branch replay (ocr R4H): getBranch() walks root → current leaf in
   * time order and includes compaction entries without truncation.
   * buildContextEntries() is the right source for building the LLM context —
   * it drops everything before the last compaction summary — but replaying
   * state needs the full history, so preset-ops from before a compaction
   * still restore the active set after restart or tree navigation. Preset-ops
   * on abandoned branches are excluded either way (path-aware, #64).
   */
  const rebuildActiveSet = (sessionManager: {
    getBranch(fromId?: string): unknown[];
  }) => {
    state.rebuildFromEntries(sessionManager.getBranch() as Parameters<PresetState["rebuildFromEntries"]>[0]);
  };

  // --- session_start: rebuild active set from current leaf path ---
  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd;

    // Read config to get default preset name. Unreadable settings keep the
    // previous default name and do not abort the replay (ocr R11M2).
    const config = readConfigOrNotify(ctx.ui);
    if (config) defaultPresetName = config.default;

    rebuildActiveSet(ctx.sessionManager);
    resetScope();
  });

  // --- session_tree: rebuild active set after tree navigation (#64) ---
  pi.on("session_tree", async (_event, ctx) => {
    rebuildActiveSet(ctx.sessionManager);
    resetScope();
  });

  // --- before_agent_start: stateless per-turn skills mutation ---
  pi.on("before_agent_start", (event, ctx) => {
    // Unreadable settings (ocr R11M2): conservative passthrough — no options
    // mutation, active-set state untouched, one-time error notify.
    const config = readConfigOrNotify(ctx.ui);
    if (!config) return undefined;

    // Per-turn default refresh: settings.json can change mid-session; keep
    // defaultPresetName in sync. The default's skills are unioned by
    // resolveSkills — the default name itself never enters the active set.
    defaultPresetName = config.default;

    const resolved = state.resolveSkills(config, defaultPresetName);

    // Per-turn strategy (turn-gate.ts): pure computation of this turn's
    // advertised skills + bad-reference names. Mutation and warning delivery
    // stay here; the dedup policy lives in the notify WarningLedger.
    const turn = turnFilter({
      discovered: event.systemPromptOptions.skills ?? [],
      resolved,
      config,
      activePresets: state.getLoaded(),
      warnedSkillNames: warnedNames(),
    });
    if (turn.passthrough) return undefined;

    // Bad-reference warnings: per-name incremental (ocr N4). Every turn,
    // missing names not yet warned in this replay cycle fire the warning —
    // so config changes introducing NEW missing names still warn.
    if (turn.unseenMissing.length > 0) {
      markWarned(turn.unseenMissing);
      recordNotify(
        ctx.ui,
        `Active presets reference unavailable skills (missing or disabled): ${turn.unseenMissing.join(", ")}`,
        "warning",
      );
    }

    event.systemPromptOptions.skills = turn.skills;
    return undefined;
  });

  // --- Commands ---
  const commands = createCommands(
    pi,
    state,
    () => cwd,
    // Fresh at interaction time (ocr N2): settings.json's default can change
    // between turns; the turn-boundary-cached defaultPresetName would go stale
    // in long-lived interactions (dialog window, command round-trip).
    () => readPresetsConfig(cwd).default,
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
export { showPresetDialog } from "./src/dialog.ts";
export { findBadRefs } from "./src/bad-refs.ts";
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
