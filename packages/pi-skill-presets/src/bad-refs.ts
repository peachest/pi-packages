/**
 * Bad-reference check shared by /preset-load and the dialog's load toggle
 * (behavior must be identical in both entry points).
 *
 * A bad reference is a preset-listed skill name absent from the platform's
 * discovered skill set. Single criterion by design: a missing name is
 * reported as "missing or disabled" without distinguishing the cause.
 */

/**
 * @param platformSkillNames - Names of the platform's discovered skills
 *   (ctx.getSystemPromptOptions().skills)
 * @param presetSkills - Skill names referenced by the preset
 * @returns Preset-listed names absent from the platform set
 */
export function findBadRefs(
  platformSkillNames: Iterable<string>,
  presetSkills: readonly string[],
): string[] {
  const platform = new Set(platformSkillNames);
  return presetSkills.filter((s) => !platform.has(s));
}
