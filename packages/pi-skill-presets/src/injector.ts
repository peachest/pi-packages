/**
 * Context event handler: transient injection of active preset skills.
 *
 * On every context event (every provider request), determines which skills
 * are in the active set but NOT in the system prompt, and injects those
 * as a CustomMessage at the end of the messages array.
 *
 * This handles mid-session preset loads: when a user does `/preset-load ddd`,
 * the system prompt is NOT modified (preserving KV cache). Instead, ddd's
 * skills are injected here every turn until offload or reload.
 */

import type { ContextEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PresetState } from "./preset-state.ts";
import type { PresetsConfig } from "./types.ts";
import { resolveSkills, formatSkills } from "./skill-resolver.ts";

/** Custom type for the injected skill content message. */
export const SKILL_INJECTION_CUSTOM_TYPE = "preset-context";

/** The message type from ContextEvent. */
type Message = ContextEvent["messages"][number];

/** Tracks which warnings have already been shown to avoid spamming every turn. */
interface WarningTracker {
  notifiedMissing: boolean;
  notifiedDisabled: boolean;
  notifiedDuplicates: boolean;
}

/**
 * Create the context event handler.
 *
 * @param state - The preset state (active set)
 * @param config - The presets config
 * @param cwd - Current working directory
 * @param ctx - Extension context (for ui.notify)
 * @param systemPromptSkillNames - Skill names already in the system prompt
 *                                  (from before_agent_start filtering)
 * @returns A function that takes messages and returns messages with injection
 */
export function createInjector(
  state: PresetState,
  config: PresetsConfig,
  cwd: string,
  ctx: ExtensionContext,
  systemPromptSkillNames: Set<string>,
) {
  const warnings: WarningTracker = {
    notifiedMissing: false,
    notifiedDisabled: false,
    notifiedDuplicates: false,
  };

  return (
    messages: ContextEvent["messages"],
  ): { messages: ContextEvent["messages"] } => {
    // 1. Get ALL active set skill names
    const resolved = state.resolveSkills(config);
    if (resolved.skillNames.length === 0) {
      return { messages };
    }

    // 2. Notify duplicates (once per session)
    if (!warnings.notifiedDuplicates && resolved.duplicates.length > 0) {
      warnings.notifiedDuplicates = true;
      ctx.ui.notify(
        `[skill-presets] Skills in multiple presets (deduplicated): ${resolved.duplicates.join(", ")}`,
        "warning",
      );
    }

    // 3. Determine which skills to inject (not in system prompt)
    const injectSkillNames = resolved.skillNames.filter(
      (name) => !systemPromptSkillNames.has(name),
    );

    if (injectSkillNames.length === 0) {
      return { messages };
    }

    // 4. Resolve to Skill objects, filter disabled/missing
    const { skills, missing, disabled } = resolveSkills(
      cwd,
      injectSkillNames,
      new Set(), // no excluded set needed — systemPromptSkillNames already handled
    );

    // Notify missing skills (once per session)
    if (!warnings.notifiedMissing && missing.length > 0) {
      warnings.notifiedMissing = true;
      ctx.ui.notify(
        `[skill-presets] Skills not found: ${missing.join(", ")}`,
        "warning",
      );
    }

    // Notify disabled skills (once per session)
    if (!warnings.notifiedDisabled && disabled.length > 0) {
      warnings.notifiedDisabled = true;
      ctx.ui.notify(
        `[skill-presets] Skills disabled by toggle: ${disabled.join(", ")}`,
        "info",
      );
    }

    if (skills.length === 0) {
      return { messages };
    }

    // 5. Format and append
    const skillsBlock = formatSkills(skills);
    if (!skillsBlock) {
      return { messages };
    }

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
