/**
 * Context event handler: transient injection of active preset skills.
 *
 * On every context event (every provider request), resolves the active set
 * to skills, formats them, and appends as a CustomMessage at the end of
 * the messages array.
 */

import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import type { PresetState } from "./preset-state.ts";
import type { PresetsConfig } from "./types.ts";
import { resolveSkills, formatSkills, getSystemPromptSkillNames } from "./skill-resolver.ts";
import { getPresetSkills } from "./config.ts";

/** Custom type for the injected skill content message. */
export const SKILL_INJECTION_CUSTOM_TYPE = "preset-context";

/** The message type from ContextEvent. */
type Message = ContextEvent["messages"][number];

/**
 * Create the context event handler.
 *
 * @param state - The preset state (active set)
 * @param config - The presets config
 * @param cwd - Current working directory
 * @param defaultPreset - The default preset name (its skills are excluded from injection)
 * @returns A function that takes messages and returns messages with injection
 */
export function createInjector(
  state: PresetState,
  config: PresetsConfig,
  cwd: string,
  defaultPreset?: string,
) {
  return (
    messages: ContextEvent["messages"],
  ): { messages: ContextEvent["messages"] } => {
    // Get active set skill names (excluding default preset)
    const resolved = state.resolveSkills(config, defaultPreset);
    if (resolved.skillNames.length === 0) {
      return { messages };
    }

    // Get default preset skills to exclude from injection
    const defaultSkills = defaultPreset
      ? (getPresetSkills(config, defaultPreset) ?? [])
      : [];
    const excludedSkills = getSystemPromptSkillNames(cwd, defaultSkills);

    // Resolve skill names to Skill objects, filter disabled/missing
    const { skills, missing, disabled } = resolveSkills(
      cwd,
      resolved.skillNames,
      excludedSkills,
    );

    // Warn about missing/disabled skills
    if (missing.length > 0) {
      console.warn(
        `[skill-presets] Skills not found: ${missing.join(", ")}`,
      );
    }
    if (disabled.length > 0) {
      console.warn(
        `[skill-presets] Skills disabled by toggle: ${disabled.join(", ")}`,
      );
    }

    if (skills.length === 0) {
      return { messages };
    }

    // Format skills into prompt string
    const skillsBlock = formatSkills(skills);
    if (!skillsBlock) {
      return { messages };
    }

    // Append as a CustomMessage at the end of the messages array
    const injection = {
      role: "custom",
      customType: SKILL_INJECTION_CUSTOM_TYPE,
      content: skillsBlock,
      display: false,
      details: { presets: state.getLoaded() },
      timestamp: Date.now(),
    } as Message;

    return {
      messages: [...messages, injection],
    };
  };
}
