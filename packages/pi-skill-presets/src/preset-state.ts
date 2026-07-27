/**
 * Active set management for skill-presets.
 *
 * The active set is a Set<string> of preset names that are currently loaded.
 * Skills are resolved dynamically from preset names each turn.
 */

import type { PresetOpEntry, ResolvedActiveSet, PresetsConfig } from "./types.ts";
import { getPresetSkills } from "./config.ts";

/** In-memory active set: names of loaded presets. */
export class PresetState {
  private activePresets = new Set<string>();

  /** Load a preset: add its name to the active set. */
  load(presetName: string): void {
    this.activePresets.add(presetName);
  }

  /** Offload a preset: remove its name from the active set. */
  offload(presetName: string): void {
    this.activePresets.delete(presetName);
  }

  /** Check if a preset is currently loaded. */
  has(presetName: string): boolean {
    return this.activePresets.has(presetName);
  }

  /** Get all loaded preset names. */
  getLoaded(): string[] {
    return [...this.activePresets];
  }

  /** Clear the active set. */
  clear(): void {
    this.activePresets.clear();
  }

  /**
   * Replay persistent entries to rebuild the active set.
   * Entries are processed in chronological order.
   */
  replayEntries(entries: PresetOpEntry[]): void {
    this.clear();
    for (const entry of entries) {
      if (entry.action === "load") {
        this.load(entry.preset);
      } else if (entry.action === "offload") {
        this.offload(entry.preset);
      }
    }
  }

  /**
   * Resolve the active set to a deduplicated list of skill names.
   * Excludes the default preset's skills (those are in the system prompt).
   *
   * @param config - Presets configuration
   * @param defaultPreset - Name of the default preset (its skills are excluded)
   * @returns Resolved active set with skill names, missing skills, and warnings
   */
  resolveSkills(
    config: PresetsConfig,
    defaultPreset?: string,
  ): ResolvedActiveSet {
    const skillSet = new Set<string>();
    const skillCount = new Map<string, number>();
    const missing: string[] = [];
    const allDefinedSkills = new Set<string>();

    // Collect all defined skill names for missing-check
    for (const def of Object.values(config.definitions)) {
      for (const s of def.skills) {
        allDefinedSkills.add(s);
      }
    }

    for (const presetName of this.activePresets) {
      // Skip default preset — its skills are in system prompt
      if (presetName === defaultPreset) continue;

      const skills = getPresetSkills(config, presetName);
      if (!skills) {
        // Preset not found in config — skip with warning
        missing.push(`preset:${presetName}`);
        continue;
      }

      for (const skill of skills) {
        skillSet.add(skill);
        skillCount.set(skill, (skillCount.get(skill) ?? 0) + 1);
      }
    }

    // Warn about skills appearing in multiple loaded presets
    const duplicates = [...skillCount.entries()]
      .filter(([, count]) => count > 1)
      .map(([name]) => name);

    return {
      skillNames: [...skillSet],
      missing,
      disabled: [],
      duplicates,
    };
  }
}
