/**
 * Active set management for skill-presets.
 *
 * The active set is a Set<string> of preset names that are currently loaded.
 * Skills are resolved dynamically from preset names each turn.
 */

import type { CustomEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { PresetOpEntry, ResolvedActiveSet, PresetsConfig } from "./types.ts";
import { PRESET_OP_CUSTOM_TYPE } from "./types.ts";
import { getPresetSkills } from "./config.ts";

/** In-memory active set: names of loaded presets (explicit loads only — the
 * default preset is NOT auto-added; its skills are unioned in resolveSkills). */
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
   *
   * The single production replay path (index.ts session_start/session_tree
   * and tests all call this): preset-op custom entries on the given entry
   * list are replayed in order. Callers pass the entry list; path-awareness
   * (session tree / compaction) is the caller's source choice — index.ts
   * passes sessionManager.getBranch() (full root→leaf history, compaction-
   * safe per ocr R4H), so preset-ops on abandoned branches never enter.
   *
   * The active set is pure explicit-load state: the default preset is NOT
   * part of it (its skills are unioned per turn in resolveSkills), so
   * switching settings.json's default mid-session drops the old default's
   * skills immediately.
   */
  rebuildFromEntries(entries: SessionEntry[]): void {
    this.clear();

    // Historical load(<old-default>) entries still enter the active set here;
    // harmless — the per-turn union with the current default dedups skills.
    const presetOps: PresetOpEntry[] = entries
      .filter(
        (e): e is CustomEntry<PresetOpEntry> =>
          e.type === "custom" && e.customType === PRESET_OP_CUSTOM_TYPE,
      )
      .map((e) => e.data as PresetOpEntry)
      .filter(
        (d) =>
          // Null guard (ocr R5M3): a custom entry with null data is legal on
          // disk and `typeof null === "object"` — dereferencing it here would
          // throw and abort the whole replay after clear(). Skip it.
          d !== null &&
          d !== undefined &&
          typeof d === "object" &&
          typeof d.action === "string" &&
          typeof d.preset === "string",
      );

    for (const entry of presetOps) {
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
   * v3 semantics: the active set holds ONLY explicitly loaded presets — the
   * default preset is not stored in it. Instead, the default's skills are
   * unioned in here on every call (allowed = default ∪ active, computed
   * fresh each turn), so changing settings.json's default mid-session takes
   * effect immediately without stale default names lingering in the set.
   * A default or loaded preset name absent from config is reported in
   * missingPresets (preset-level); skill-level bad references (listed names
   * absent from pi's discovery) are computed by the caller against the
   * discovered skill set, not here.
   *
   * @param config - Presets configuration
   * @param defaultName - Current default preset name from config, if any
   */
  resolveSkills(config: PresetsConfig, defaultName?: string): ResolvedActiveSet {
    const skillSet = new Set<string>();
    const missingPresets: string[] = [];

    const mergePreset = (presetName: string) => {
      const skills = getPresetSkills(config, presetName);
      if (!skills) {
        missingPresets.push(presetName);
        return;
      }

      for (const skill of skills) skillSet.add(skill);
    };

    if (defaultName !== undefined) mergePreset(defaultName);
    for (const presetName of this.activePresets) mergePreset(presetName);

    return {
      skillNames: [...skillSet],
      missingPresets,
    };
  }
}
