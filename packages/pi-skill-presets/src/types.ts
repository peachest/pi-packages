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
  /** Name of the default preset (always in the active set). */
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

/** Result of resolving the full active set (v3 semantics). */
export interface ResolvedActiveSet {
  /** All skill names from active presets (deduplicated). */
  skillNames: string[];
  /** Preset names in the active set that have no definition in config. */
  missingPresets: string[];
}

/** Custom entry type for preset operations (shared by commands and dialog). */
export const PRESET_OP_CUSTOM_TYPE = "preset-op";
