/**
 * System prompt filtering: filters the `<available_skills>` section
 * to only include skills from the active set.
 *
 * Called by `before_agent_start` handler when `needsFilter` is true.
 * Uses pi's `formatSkillsForPrompt` to rebuild the section, ensuring
 * the output format matches pi's native rendering.
 */

import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "./config.ts";

/** Result of filtering: either a modified prompt or undefined (no change). */
export interface FilterResult {
  /** Modified system prompt, or undefined if no filtering needed. */
  systemPrompt?: string;
  /** The skill names that are now in the system prompt. */
  filteredSkillNames: Set<string>;
}

/**
 * Filter the system prompt's `<available_skills>` section to only include
 * skills whose names are in `allowedSkillNames`.
 *
 * - Skills with `disableModelInvocation: true` are excluded (pi's own behavior).
 * - Skills matching `-` disabled patterns from `settings.skills` are excluded.
 * - If the filtered set equals the current set, returns `systemPrompt: undefined`
 *   to avoid unnecessary string replacement (preserves KV cache).
 * - If the regex fails to match, returns `systemPrompt: undefined` (fail safe).
 *
 * @param systemPrompt - The full system prompt string from `before_agent_start`
 * @param allSkills - All skills pi loaded (`event.systemPromptOptions.skills`)
 * @param allowedSkillNames - Skill names allowed in the active set
 * @param cwd - Current working directory (for reading settings)
 * @returns FilterResult with modified prompt (or undefined) and filtered names
 */
export function filterSystemPrompt(
  systemPrompt: string,
  allSkills: Skill[],
  allowedSkillNames: Set<string>,
  cwd: string,
): FilterResult {
  // 1. Read disabled patterns from settings.skills
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const settings = settingsManager.getGlobalSettings();
  const projectSettings = settingsManager.getProjectSettings();

  const disabledPatterns = [
    ...(settings.skills ?? []),
    ...(projectSettings.skills ?? []),
  ].filter((p) => p.startsWith("-"));

  const isDisabled = (skillName: string): boolean => {
    for (const pattern of disabledPatterns) {
      const stripped = pattern.slice(1); // remove "-"
      if (stripped === skillName || stripped.endsWith(`/${skillName}`)) {
        return true;
      }
    }
    return false;
  };

  // 2. Filter skills: must be in allowed set, not disabled, not disableModelInvocation
  const allowedSkills = allSkills.filter(
    (skill) =>
      allowedSkillNames.has(skill.name) &&
      !skill.disableModelInvocation &&
      !isDisabled(skill.name),
  );

  const filteredNames = new Set(allowedSkills.map((s) => s.name));

  // 3. Check if filtering is needed
  const currentVisibleNames = new Set(
    allSkills
      .filter((s) => !s.disableModelInvocation && !isDisabled(s.name))
      .map((s) => s.name),
  );

  // If the current visible skills are already exactly the allowed set, no change needed
  if (setsEqual(currentVisibleNames, filteredNames)) {
    return { systemPrompt: undefined, filteredSkillNames: filteredNames };
  }

  // 4. Rebuild the skills section
  const newSection = formatSkillsForPrompt(allowedSkills);

  // 5. Replace in system prompt string
  // The section starts with "\n\nThe following skills provide specialized instructions"
  // and ends with "</available_skills>"
  const sectionRegex =
    /\n\nThe following skills provide specialized instructions.*?<\/available_skills>/s;

  let modifiedPrompt: string;
  if (newSection) {
    // Replace old section with rebuilt one
    modifiedPrompt = systemPrompt.replace(sectionRegex, newSection);
  } else {
    // No skills to show — remove the entire section
    modifiedPrompt = systemPrompt.replace(sectionRegex, "");
  }

  // Fail safe: if regex didn't match, return undefined
  if (modifiedPrompt === systemPrompt) {
    return { systemPrompt: undefined, filteredSkillNames: filteredNames };
  }

  return { systemPrompt: modifiedPrompt, filteredSkillNames: filteredNames };
}

/** Check if two sets contain the same elements. */
function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}
