/**
 * Per-turn skills filter (the v3 core strategy, named).
 *
 * Pure function: computes the skills array that pi should advertise this
 * turn (allowed = default ∪ active presets, deduped, intersected with pi's
 * discovered skills) and the bad-reference names it introduces. Mutation of
 * event options and warning delivery stay with the caller — this module owns
 * neither I/O nor the warning ledger.
 */

import type { Skill } from "@earendil-works/pi-coding-agent";
import type { PresetsConfig, ResolvedActiveSet } from "./types.ts";

export interface TurnFilterInput {
  /** pi's discovered skills for this turn (event.systemPromptOptions.skills). */
  discovered: Skill[];
  /** Freshly resolved allowed set: default ∪ active preset skill names. */
  resolved: ResolvedActiveSet;
  /** Presets configured in settings.json (for the zero-config gate). */
  config: PresetsConfig;
  /** Names in the active set (explicit loads only). */
  activePresets: string[];
  /** Names already warned in this replay scope (from the WarningLedger). */
  warnedSkillNames: ReadonlySet<string>;
}

export interface TurnFilterResult {
  /** Filtered skills array to write back into systemPromptOptions.skills. */
  skills: Skill[];
  /** Allowed names absent from pi's discovery (missing or disabled). */
  missingSkillNames: string[];
  /** missingSkillNames minus already-warned names — the ones to warn now. */
  unseenMissing: string[];
  /** True when no presets are configured AND the active set is empty: the
   *  caller must pass through without touching options (zero-config gate). */
  passthrough: boolean;
}

export function turnFilter(input: TurnFilterInput): TurnFilterResult {
  const allowed = new Set(input.resolved.skillNames);
  const present = new Set<string>();
  // Dedup by name (a skill listed by multiple presets renders once); keep
  // pi's discovery order for the skills pi already found.
  const skills = input.discovered.filter((skill) => {
    if (!allowed.has(skill.name) || present.has(skill.name)) return false;
    present.add(skill.name);
    return true;
  });

  // Zero-config passthrough (strict): only when no presets are configured AND
  // the active set is empty. A configured preset that resolves to zero skills
  // still writes back an empty array to clear pi's advertised skills.
  const noPresetsConfigured =
    Object.keys(input.config.definitions).length === 0 && input.config.default === undefined;
  const passthrough = noPresetsConfigured && input.activePresets.length === 0;

  const missingSkillNames = [...allowed].filter((name) => !present.has(name));
  const unseenMissing = missingSkillNames.filter(
    (name) => !input.warnedSkillNames.has(name),
  );

  return { skills, missingSkillNames, unseenMissing, passthrough };
}
