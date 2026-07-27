/**
 * Config reading and writing for skill-presets.
 *
 * Reads the `presets` field from settings.json (global + project).
 * Uses direct file I/O following the pi-skills-manager pattern.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import type { PresetsConfig, PresetDefinition } from "./types.ts";

/** Get the pi agent directory (~/.pi/agent or PI_CODING_AGENT_DIR). */
export function getAgentDir(): string {
  return resolve(
    process.env.PI_CODING_AGENT_DIR?.trim() || homedir() + "/.pi/agent",
  );
}

/** Get the global settings.json path. */
export function getGlobalSettingsPath(): string {
  return resolve(getAgentDir(), "settings.json");
}

/** Get the project settings.json path. */
export function getProjectSettingsPath(cwd: string): string {
  return resolve(cwd, ".pi", "settings.json");
}

/**
 * Read a settings.json file and return the parsed JSON (or {} if missing/invalid).
 */
function readSettingsFile(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Extract the presets config from a parsed settings object.
 */
function extractPresets(
  settings: Record<string, unknown>,
): PresetsConfig | undefined {
  const raw = settings.presets;
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const definitions: Record<string, PresetDefinition> = {};
  const rawDefs = obj.definitions;
  if (rawDefs && typeof rawDefs === "object") {
    for (const [name, def] of Object.entries(
      rawDefs as Record<string, unknown>,
    )) {
      if (def && typeof def === "object" && Array.isArray((def as { skills?: unknown }).skills)) {
        definitions[name] = {
          skills: (def as { skills: string[] }).skills.filter(
            (s): s is string => typeof s === "string",
          ),
        };
      }
    }
  }
  return {
    default: typeof obj.default === "string" ? obj.default : undefined,
    definitions,
  };
}

/**
 * Read merged presets config from global + project settings.
 * Project settings override global for same preset name.
 */
export function readPresetsConfig(cwd: string): PresetsConfig {
  const globalSettings = readSettingsFile(getGlobalSettingsPath());
  const projectSettings = readSettingsFile(getProjectSettingsPath(cwd));

  const globalPresets = extractPresets(globalSettings);
  const projectPresets = extractPresets(projectSettings);

  if (!globalPresets && !projectPresets) {
    return { definitions: {} };
  }

  // Merge: project overrides global
  const merged: PresetsConfig = {
    default: projectPresets?.default ?? globalPresets?.default,
    definitions: {
      ...globalPresets?.definitions,
      ...projectPresets?.definitions,
    },
  };

  return merged;
}

/**
 * Write the presets field back to a settings.json file.
 * Preserves all other fields in the file.
 */
export function writePresetsConfig(
  presets: PresetsConfig,
  scope: "global" | "project",
  cwd?: string,
): void {
  const filePath =
    scope === "global"
      ? getGlobalSettingsPath()
      : getProjectSettingsPath(cwd!);

  const settings = readSettingsFile(filePath);
  settings.presets = presets;

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
}

/**
 * Get the list of skill names for a preset.
 * Returns undefined if the preset doesn't exist.
 */
export function getPresetSkills(
  config: PresetsConfig,
  presetName: string,
): string[] | undefined {
  return config.definitions[presetName]?.skills;
}

/**
 * Get the default preset name, if configured.
 */
export function getDefaultPresetName(config: PresetsConfig): string | undefined {
  return config.default;
}
