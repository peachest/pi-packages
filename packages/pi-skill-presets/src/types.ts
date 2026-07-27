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
  /** Name of the default preset (loaded to system prompt via settings.skills). */
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

/** Result of resolving the full active set. */
export interface ResolvedActiveSet {
  /** All skill names from active presets (deduplicated). */
  skillNames: string[];
  /** Skills that could not be resolved to a file path. */
  missing: string[];
  /** Skills excluded because they're disabled by skill-manager toggle. */
  disabled: string[];
}
