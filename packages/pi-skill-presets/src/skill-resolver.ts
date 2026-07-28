/**
 * Skill resolution: resolve skill names to Skill objects.
 *
 * Uses pi's loadSkills() to find skill files, then filters out:
 * 1. Skills already in the system prompt (default preset skills)
 * 2. Skills disabled by skill-manager toggle (+/- patterns)
 * 3. Skills that can't be found (missing)
 */

import { loadSkills, formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "./config.ts";

/**
 * Pure filtering function: given available skills and requested names,
 * filter out excluded, disabled, and missing skills.
 *
 * @param availableSkills - All skills that exist in the system
 * @param requestedNames - Skill names requested by the active set
 * @param excludedSkills - Skill names to exclude (already in system prompt)
 * @param disabledPatterns - Raw patterns from settings.skills starting with "-"
 * @returns Filtered skills, missing names, and disabled names
 */
export function filterSkills(
  availableSkills: Skill[],
  requestedNames: string[],
  excludedSkills: Set<string>,
  disabledPatterns: string[],
): {
  skills: Skill[];
  missing: string[];
  disabled: string[];
} {
  const skillMap = new Map<string, Skill>();
  for (const skill of availableSkills) {
    skillMap.set(skill.name, skill);
  }

  const isDisabled = (skillName: string): boolean => {
    for (const pattern of disabledPatterns) {
      const stripped = pattern.slice(1); // remove "-"
      if (stripped === skillName || stripped.endsWith(`/${skillName}`)) {
        return true;
      }
    }
    return false;
  };

  const skills: Skill[] = [];
  const missing: string[] = [];
  const disabled: string[] = [];

  for (const name of requestedNames) {
    // Skip skills already in system prompt
    if (excludedSkills.has(name)) continue;

    // Skip disabled skills
    if (isDisabled(name)) {
      disabled.push(name);
      continue;
    }

    const skill = skillMap.get(name);
    if (!skill) {
      missing.push(name);
      continue;
    }

    skills.push(skill);
  }

  return { skills, missing, disabled };
}

/**
 * Resolve skill names to Skill objects using pi's skill loading system.
 *
 * @param cwd - Current working directory
 * @param skillNames - Skill names to resolve
 * @param excludedSkills - Skill names to exclude (e.g. default preset skills)
 * @returns Object with resolved skills, missing names, and disabled names
 */
export function resolveSkills(
  cwd: string,
  skillNames: string[],
  excludedSkills: Set<string>,
): {
  skills: Skill[];
  missing: string[];
  disabled: string[];
} {
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const settings = settingsManager.getGlobalSettings();
  const projectSettings = settingsManager.getProjectSettings();

  // Build skill paths from settings (global + project)
  const skillPaths = [
    ...(settings.skills ?? []),
    ...(projectSettings.skills ?? []),
  ];

  // Load all available skills
  const loadResult = loadSkills({
    cwd,
    agentDir,
    skillPaths,
    includeDefaults: true,
  });

  // Build disabled patterns from settings
  const disabledPatterns = [
    ...(settings.skills ?? []),
    ...(projectSettings.skills ?? []),
  ].filter((p) => p.startsWith("-"));

  return filterSkills(loadResult.skills, skillNames, excludedSkills, disabledPatterns);
}

/**
 * Format resolved skills into a prompt string using pi's formatSkillsForPrompt.
 */
export function formatSkills(skills: Skill[]): string {
  if (skills.length === 0) return "";
  return formatSkillsForPrompt(skills);
}

/**
 * Get the skill names from the default preset that are in the system prompt.
 * These should be excluded from transient injection.
 */
export function getSystemPromptSkillNames(
  cwd: string,
  defaultPresetSkills: string[],
): Set<string> {
  // The default preset's skills are written to settings.skills,
  // so they're loaded into the system prompt by pi native.
  // We exclude all of them from transient injection.
  return new Set(defaultPresetSkills);
}
