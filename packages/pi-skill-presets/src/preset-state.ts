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
   * Get all skill names from all presets in the active set.
   * Used by before_agent_start to filter available_skills.
   */
  getActiveSkillNames(config: PresetsConfig): Set<string> {
    const names = new Set<string>();
    for (const presetName of this.activePresets) {
      const skills = getPresetSkills(config, presetName);
      if (skills) {
        for (const s of skills) names.add(s);
      }
    }
    return names;
  }

  /**
   * Resolve the active set to a deduplicated list of skill names.
   * In v2, default preset is in active set, so no exclusion is needed.
   * Used by transient injection to determine which skills to inject.
   *
   * @param config - Presets configuration
   * @returns Resolved active set with skill names, missing skills, and warnings
   */
  resolveSkills(config: PresetsConfig): ResolvedActiveSet {
    const skillSet = new Set<string>();
    const skillCount = new Map<string, number>();
    const missing: string[] = [];

    for (const presetName of this.activePresets) {
      const skills = getPresetSkills(config, presetName);
      if (!skills) {
        missing.push(`preset:${presetName}`);
        continue;
      }

      for (const skill of skills) {
        skillSet.add(skill);
        skillCount.set(skill, (skillCount.get(skill) ?? 0) + 1);
      }
    }

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
