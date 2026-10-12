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
   * Kept because preset-state.test.ts exercises it; index.ts replays entries
   * inline (path-aware, #64) instead of calling this.
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
   *
   * v3 semantics: the default preset is always part of the active set, so its
   * skills are included without special-casing. A loaded preset name absent
   * from config is reported in missingPresets (preset-level); skill-level bad
   * references (listed names absent from pi's discovery) are computed by the
   * caller against the discovered skill set, not here.
   *
   * @param config - Presets configuration
   */
  resolveSkills(config: PresetsConfig): ResolvedActiveSet {
    const skillSet = new Set<string>();
    const missingPresets: string[] = [];

    for (const presetName of this.activePresets) {
      const skills = getPresetSkills(config, presetName);
      if (!skills) {
        missingPresets.push(presetName);
        continue;
      }

      for (const skill of skills) skillSet.add(skill);
    }

    return {
      skillNames: [...skillSet],
      missingPresets,
    };
  }
}
