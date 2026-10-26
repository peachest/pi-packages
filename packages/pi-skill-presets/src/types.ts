/**
 * Type definitions for skill-presets.
 */

/** A single preset definition: a named group of skill references. */
export interface PresetDefinition {
  /** Skill names to include in this preset. */
  skills: string[];
}

/** The presets configuration block in settings.json. */
export interface PresetsConfig {
  /** Name of the default preset. Its name is NOT stored in the active set —
   * its skills are unioned into the allowed set at resolution time (see
   * PresetState.resolveSkills), so changing this value mid-session takes
   * effect immediately. */
  default?: string;
  /** Map of preset name → definition. */
  definitions: Record<string, PresetDefinition>;
}

/** Data stored in a persistent entry for load/offload operations. */
export interface PresetOpEntry {
  action: "load" | "offload";
  preset: string;
  timestamp: number;
}

/** Result of resolving the full active set (v3 semantics: allowed =
 * default ∪ explicitly loaded presets, computed fresh on each resolve). */
export interface ResolvedActiveSet {
  /** All skill names from the default preset plus explicitly loaded
   * (active) presets (deduplicated). */
  skillNames: string[];
  /** Preset names that resolved to nothing, from two sources (ocr R8L):
   * 1) names in the active set no longer present in config; 2) the
   * defaultName argument passed to resolveSkills when it is absent from
   * config. When no default is defined/defaultName is undefined, no entry
   * is produced for it. */
  missingPresets: string[];
}

/** Custom entry type for preset operations (shared by commands and dialog). */
export const PRESET_OP_CUSTOM_TYPE = "preset-op";
