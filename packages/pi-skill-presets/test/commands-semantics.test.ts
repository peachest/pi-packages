/**
 * Command semantics integration tests (#63): failure visibility, default
 * guard, status annotation — driven through the native command dispatch seam
 * (session.prompt("/preset-...")), same harness as preset-diff.integration.
 *
 * Warning/error content is asserted via the recordNotify sink in src/notify.ts
 * (SDK command contexts use a no-op UI, so ctx.ui.notify is not observable).
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { AgentSession, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  PINNED_MODEL_ID,
  PROMPT,
  cleanupMadeDirs,
  createTestSession,
  gatewayUp,
  suite,
} from "./helpers/preset-harness.ts";
import { notificationLog, resetNotificationLog } from "../index.ts";
import { PRESET_OP_CUSTOM_TYPE } from "../index.ts";

afterAll(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  cleanupMadeDirs();
});

beforeEach(() => {
  resetNotificationLog();
});

// "ghost" is referenced by presets but never discovered as a skill.
const BASE_SETTINGS = {
  presets: {
    default: "base",
    definitions: {
      base: { skills: ["alpha"] },
      broken: { skills: ["alpha", "ghost"] },
    },
  },
};

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

function presetOpCount(session: AgentSession): number {
  return (session.sessionManager.getEntries() as SessionEntry[]).filter(
    (e) => e.type === "custom" && (e as { customType?: string }).customType === PRESET_OP_CUSTOM_TYPE,
  ).length;
}

interface SectionsView {
  keys: string[];
  text: (section: string) => string;
}

function systemSectionMessages(session: AgentSession): SectionsView[] {
  const views: SectionsView[] = [];
  for (const entry of session.sessionManager.getEntries() as SessionEntry[]) {
    if (entry.type !== "message") continue;
    const message = entry.message as { role?: string; sections?: Record<string, string | null> };
    if (message.role !== "system" || !message.sections) continue;
    const sections = message.sections;
    views.push({
      keys: Object.keys(sections),
      text: (section: string) => sections[section] ?? "",
    });
  }
  return views;
}

function lastSkillsText(session: AgentSession): string {
  const views = systemSectionMessages(session);
  expect(views.length).toBeGreaterThan(0);
  return views[views.length - 1]!.text("skills");
}

function notificationsOf(level: string): string[] {
  return notificationLog.filter((n) => n.level === level).map((n) => n.msg);
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

suite(`command semantics integration (gateway up=${gatewayUp}, model ${PINNED_MODEL_ID})`, () => {
  it(
    "unknown preset name: error notify with available names, no entry, no skills change",
    async () => {
      const session = await createTestSession({ settings: BASE_SETTINGS, agentDirSkills: true });
      await session.prompt(PROMPT);
      const opsBefore = presetOpCount(session);

      await session.prompt("/preset-load nonexistent");
      await session.prompt(PROMPT);

      expect(presetOpCount(session)).toBe(opsBefore);
      const errors = notificationsOf("error");
      expect(errors.some((m) => m.includes("nonexistent") && m.includes("Available"))).toBe(true);
      // Active set unchanged: only the default preset's alpha is rendered.
      expect(lastSkillsText(session)).toContain("<name>alpha</name>");
      expect(lastSkillsText(session)).not.toContain("<name>beta</name>");
    },
    180_000,
  );

  it(
    "bad-reference load: aggregated warning, load proceeds, repeat load warns again",
    async () => {
      const session = await createTestSession({ settings: BASE_SETTINGS, agentDirSkills: true });
      await session.prompt(PROMPT);

      await session.prompt("/preset-load broken");
      await session.prompt(PROMPT);

      // Load took effect: alpha rendered (ghost skipped, never discovered).
      expect(lastSkillsText(session)).toContain("<name>alpha</name>");
      expect(lastSkillsText(session)).not.toContain("ghost");
      // Warning lists the bad ref with the unified cause label.
      const warnings1 = notificationsOf("warning").filter((m) => m.includes("ghost"));
      expect(warnings1).toHaveLength(1);
      expect(warnings1[0]).toContain("broken");
      expect(warnings1[0]).toContain("missing or disabled");

      // Repeat load of the same bad preset warns again (no cross-action dedup).
      const opsBefore = presetOpCount(session);
      await session.prompt("/preset-load broken");
      await session.prompt(PROMPT);

      const warnings2 = notificationsOf("warning").filter((m) => m.includes("ghost"));
      expect(warnings2).toHaveLength(2);
      expect(presetOpCount(session)).toBe(opsBefore);
      expect(lastSkillsText(session)).toContain("<name>alpha</name>");
    },
    180_000,
  );

  it(
    "offloading the default preset is rejected: error, no entry, active set unchanged",
    async () => {
      const session = await createTestSession({ settings: BASE_SETTINGS, agentDirSkills: true });
      await session.prompt(PROMPT);
      const opsBefore = presetOpCount(session);

      await session.prompt("/preset-off base");
      await session.prompt(PROMPT);

      const errors = notificationsOf("error");
      expect(errors.some((m) => m.includes("base") && m.includes("default preset"))).toBe(true);
      expect(presetOpCount(session)).toBe(opsBefore);
      expect(lastSkillsText(session)).toContain("<name>alpha</name>");
    },
    180_000,
  );

  it(
    "replayed bad references (default preset) warn once, not every turn",
    async () => {
      const session = await createTestSession({
        settings: {
          presets: {
            default: "base",
            definitions: { base: { skills: ["alpha", "ghost"] } },
          },
        },
        agentDirSkills: true,
      });

      await session.prompt(PROMPT);
      expect(lastSkillsText(session)).toContain("<name>alpha</name>");
      expect(lastSkillsText(session)).not.toContain("ghost");
      const warningsAfterTurn1 = notificationsOf("warning").filter((m) => m.includes("ghost"));
      expect(warningsAfterTurn1).toHaveLength(1);

      await session.prompt(PROMPT);
      const warningsAfterTurn2 = notificationsOf("warning").filter((m) => m.includes("ghost"));
      expect(warningsAfterTurn2).toHaveLength(1);
    },
    180_000,
  );
});
