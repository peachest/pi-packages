/**
 * Default preset handler: writes default preset skills to settings.skills.
 *
 * Called on session_start. Reads the presets config, resolves the default
 * preset's skills to file paths, and writes them to settings.skills with
 * `+` prefix — respecting existing `-` patterns (not overwriting user disables).
 */

import { SettingsManager, loadSkills } from "@earendil-works/pi-coding-agent";
import { getAgentDir, readPresetsConfig, getPresetSkills } from "./config.js";

/**
 * Write default preset skills to settings.skills.
 * Respects existing `-` patterns: if a skill path already has a `-` prefix,
 * it is not re-enabled.
 *
 * @param cwd - Current working directory
 * @returns The default preset name and its skill names, or null if no default
 */
export async function applyDefaultPreset(cwd: string): Promise<{
  name: string;
  skills: string[];
} | null> {
  const config = readPresetsConfig(cwd);
  const defaultName = config.default;

  if (!defaultName) return null;
  const defaultSkills = getPresetSkills(config, defaultName);
  if (!defaultSkills || defaultSkills.length === 0) return null;

  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const settings = settingsManager.getGlobalSettings();
  const projectSettings = settingsManager.getProjectSettings();

  // Build current skill paths from settings (global + project)
  const currentPaths = [
    ...(settings.skills ?? []),
    ...(projectSettings.skills ?? []),
  ];

  // Find disabled patterns (paths starting with "-")
  const disabledPaths = new Set(currentPaths.filter((p) => p.startsWith("-")));

  // Load all available skills to resolve names to file paths
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

  // Build the updated global skills list: keep existing entries,
  // add default preset skills that aren't already present and aren't disabled
  const globalSkills = [...(settings.skills ?? [])];

  for (const skillName of defaultSkills) {
    const filePath = skillPaths.get(skillName);
    if (!filePath) continue; // skill not found, skip
    if (disabledPaths.has(`-${filePath}`)) continue; // respect user disable by path
    if (disabledPaths.has(`-${skillName}`)) continue; // respect user disable by name

    const plusPath = `+${filePath}`;
    if (
      !globalSkills.includes(plusPath) &&
      !globalSkills.includes(filePath)
    ) {
      globalSkills.push(plusPath);
    }
  }

  settingsManager.setSkillPaths(globalSkills);
  await settingsManager.flush();

  return { name: defaultName, skills: defaultSkills };
}
