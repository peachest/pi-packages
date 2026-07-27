/**
 * Default preset handler: writes default preset skills to settings.skills.
 *
 * Called on session_start. Reads the presets config, resolves the default
 * preset's skills to file paths, and writes them to settings.skills with
 * `+` prefix — respecting existing `-` patterns (not overwriting user disables).
 */

import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import { getAgentDir, readPresetsConfig, getPresetSkills } from "./config.js";

/**
 * Write default preset skills to settings.skills.
 * Respects existing `-` patterns: if a skill path already has a `-` prefix,
 * it is not re-enabled.
 *
 * @param cwd - Current working directory
 * @returns The default preset name and its skill names, or null if no default
 */
export function applyDefaultPreset(cwd: string): {
  name: string;
  skills: string[];
} | null {
  const config = readPresetsConfig(cwd);
  const defaultName = config.default;

  if (!defaultName) return null;
  const defaultSkills = getPresetSkills(config, defaultName);
  if (!defaultSkills || defaultSkills.length === 0) return null;

  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const settings = settingsManager.getGlobalSettings();
  const projectSettings = settingsManager.getProjectSettings();

  // Build current skill paths from settings
  const currentPaths = [
    ...(settings.skills ?? []),
    ...(projectSettings.skills ?? []),
  ];

  // Find disabled patterns (paths starting with "-")
  const disabledPaths = new Set(
    currentPaths.filter((p) => p.startsWith("-")),
  );

  // Load all available skills to resolve names to paths
  const loadResult = loadSkills({
    cwd,
    agentDir,
    skillPaths: currentPaths,
    includeDefaults: true,
  });

  // Build name → filePath map
  const skillPaths = new Map<string, string>();
  for (const skill of loadResult.skills) {
    skillPaths.set(skill.name, skill.filePath);
  }

  // Build the new skills array: keep existing entries, add default preset skills
  // that aren't already present and aren't disabled
  const newSkills = [...currentPaths];
  const existingPaths = new Set(currentPaths.map((p) => p.replace(/^[+-]/, "")));

  for (const skillName of defaultSkills) {
    const filePath = skillPaths.get(skillName);
    if (!filePath) continue; // skill not found, skip
    if (disabledPaths.has(`-${filePath}`)) continue; // respect user disable
    if (disabledPaths.has(`-${skillName}`)) continue; // respect by name
    if (existingPaths.has(filePath)) continue; // already present

    newSkills.push(`+${filePath}`);
    existingPaths.add(filePath);
  }

  // Write back to global settings
  settingsManager.setSkillPaths(newSkills.filter((p) => !p.startsWith("-") || true));
  // Note: setSkillPaths replaces the entire skills array, so we need to preserve
  // disabled patterns too. Actually, let's use a more careful approach.

  // Actually, setSkillPaths sets the global skills. We should preserve project skills.
  // Let's only update global skills with the default preset additions.
  const globalSkills = settings.skills ?? [];
  const updatedGlobalSkills = [...globalSkills];

  for (const skillName of defaultSkills) {
    const filePath = skillPaths.get(skillName);
    if (!filePath) continue;
    if (disabledPaths.has(`-${filePath}`)) continue;
    if (disabledPaths.has(`-${skillName}`)) continue;

    const plusPath = `+${filePath}`;
    if (!updatedGlobalSkills.includes(plusPath) && !updatedGlobalSkills.includes(filePath)) {
      updatedGlobalSkills.push(plusPath);
    }
  }

  settingsManager.setSkillPaths(updatedGlobalSkills);
  settingsManager.flush();

  return { name: defaultName, skills: defaultSkills };
}
