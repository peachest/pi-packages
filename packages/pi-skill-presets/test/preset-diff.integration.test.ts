/**
 * SDK 回归基线（#38 实测口径重建）：真实 session 中 preset load/offload 只产出
 * 最小 skills section patch（prefix cache 不破坏）。
 *
 * Seam（#62 预定）：createAgentSession + extensionFactories + 自定义 agentDir +
 * 测试技能目录；断言谓词 = sessionManager.buildContextEntries() 中的 system
 * sections 消息（path-aware，#64）。
 *
 * 模型 pin：glm53-flash-internal，严格 pin（#65 B4）——网关不可达或
 * getAvailable() 找不到该 id 时整组 skip，不回退 available[0]。
 *
 * 网关预检与 session factory 见 test/helpers/preset-harness.ts。
 */

import { afterAll } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { AgentSession, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  PINNED_MODEL_ID,
  PROMPT,
  cleanupMadeDirs,
  createTestSession,
  gatewayUp,
  makeSkill,
  makeTempDir,
  restoreAgentDirEnv,
  suite,
} from "./helpers/preset-harness.ts";

afterAll(() => {
  restoreAgentDirEnv();
  cleanupMadeDirs();
});

const PRESET_SETTINGS = {
  presets: {
    default: "base",
    definitions: {
      base: { skills: ["alpha"] },
      extra: { skills: ["beta", "gamma"] },
      dup: { skills: ["alpha", "beta"] },
    },
  },
};

// ---------------------------------------------------------------------------
// Sections assertions helpers
// ---------------------------------------------------------------------------

interface SectionsView {
  keys: string[];
  text: (section: string) => string;
}

function systemSectionMessages(session: AgentSession): SectionsView[] {
  const views: SectionsView[] = [];
  // Path-aware (#64): read from the current leaf path, not the flat entry list —
  // after tree navigation the LLM-visible sections come from the path's own
  // system messages (abandoned-branch sections must not leak in).
  for (const entry of session.sessionManager.buildContextEntries() as SessionEntry[]) {
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

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

suite(`preset-diff integration (gateway up=${gatewayUp}, model ${PINNED_MODEL_ID})`, () => {
  it(
    "baseline → load → offload: full sections, skills-only patch, rollback",
    async () => {
      const skillRoot = makeTempDir("t62-skills-");
      makeSkill(skillRoot, "alpha", "fixture skill one");
      makeSkill(skillRoot, "beta", "fixture skill two");
      makeSkill(skillRoot, "gamma", "fixture skill three");

      const session = await createTestSession({ settings: PRESET_SETTINGS, skillRoot });

      // Turn 1 — baseline: leading system message with the full section set.
      await session.prompt(PROMPT);
      const baseline = systemSectionMessages(session);
      expect(baseline.length).toBe(1);
      expect(baseline[0].keys).toContain("skills");
      // Full render, not a patch: more than the skills section alone.
      expect(baseline[0].keys.length).toBeGreaterThan(1);
      expect(baseline[0].text("skills")).toContain("<name>alpha</name>");
      expect(baseline[0].text("skills")).not.toContain("<name>beta</name>");

      // Mid-session load via the real command path.
      await session.prompt("/preset-load extra");
      await session.prompt(PROMPT);

      const afterLoad = systemSectionMessages(session);
      expect(afterLoad.length).toBe(2);
      // Patch carries exactly the skills section — prefix untouched.
      expect(afterLoad[1].keys).toEqual(["skills"]);
      expect(afterLoad[1].text("skills")).toContain("<name>alpha</name>");
      expect(afterLoad[1].text("skills")).toContain("<name>beta</name>");
      expect(afterLoad[1].text("skills")).toContain("<name>gamma</name>");

      // Offload rolls the skills section back.
      await session.prompt("/preset-off extra");
      await session.prompt(PROMPT);

      const afterOffload = systemSectionMessages(session);
      expect(afterOffload.length).toBe(3);
      expect(afterOffload[2].keys).toEqual(["skills"]);
      expect(afterOffload[2].text("skills")).toContain("<name>alpha</name>");
      expect(afterOffload[2].text("skills")).not.toContain("<name>beta</name>");
    },
    180_000,
  );

  it(
    "settings `-` overlay: beta excluded at discovery, preset cannot revive it",
    async () => {
      const session = await createTestSession({
        settings: {
          skills: ["-skills/beta"],
          presets: {
            default: "base",
            definitions: { base: { skills: ["alpha", "beta"] } },
          },
        },
        agentDirSkills: true,
      });

      await session.prompt(PROMPT);
      const views = systemSectionMessages(session);
      expect(views.length).toBe(1);
      const skills = views[0].text("skills");
      expect(skills).toContain("<name>alpha</name>");
      expect(skills).not.toContain("<name>beta</name>");
      // Not in the default preset either — filtered by the allowed-set intersection.
      expect(skills).not.toContain("<name>gamma</name>");
    },
    180_000,
  );

  it(
    "zero-config passthrough: no presets configured → all discovered skills visible",
    async () => {
      const skillRoot = makeTempDir("t62-skills-");
      makeSkill(skillRoot, "alpha", "fixture skill one");
      makeSkill(skillRoot, "beta", "fixture skill two");
      makeSkill(skillRoot, "gamma", "fixture skill three");

      const session = await createTestSession({ settings: {}, skillRoot });

      await session.prompt(PROMPT);
      const views = systemSectionMessages(session);
      expect(views.length).toBe(1);
      const skills = views[0].text("skills");
      expect(skills).toContain("<name>alpha</name>");
      expect(skills).toContain("<name>beta</name>");
      expect(skills).toContain("<name>gamma</name>");
    },
    180_000,
  );

  it(
    "loading an empty-skills preset clears advertised skills (no passthrough, #65 B1)",
    async () => {
      const skillRoot = makeTempDir("t62-skills-");
      makeSkill(skillRoot, "alpha", "fixture skill one");
      makeSkill(skillRoot, "beta", "fixture skill two");
      makeSkill(skillRoot, "gamma", "fixture skill three");

      // No default preset; the active set only becomes non-empty after the
      // explicit load, but presets ARE configured — the strict passthrough
      // condition must not kick in.
      const session = await createTestSession({
        settings: {
          presets: {
            definitions: { empty: { skills: [] } },
          },
        },
        skillRoot,
      });

      await session.prompt(PROMPT);
      // Presets are configured but nothing is loaded — strict passthrough must
      // NOT kick in: advertised skills are already cleared (#65 B1).
      const before = systemSectionMessages(session);
      expect(before[before.length - 1].text("skills")).not.toContain("<name>alpha</name>");

      await session.prompt("/preset-load empty");
      await session.prompt(PROMPT);

      const after = systemSectionMessages(session);
      const skills = after[after.length - 1].text("skills");
      expect(skills).not.toContain("<name>alpha</name>");
      expect(skills).not.toContain("<name>beta</name>");
      expect(skills).not.toContain("<name>gamma</name>");
    },
    180_000,
  );

  it(
    "default preset change mid-session is refreshed per-turn (#65 B2)",
    async () => {
      const skillRoot = makeTempDir("t62-skills-");
      makeSkill(skillRoot, "alpha", "fixture skill one");
      makeSkill(skillRoot, "beta", "fixture skill two");
      makeSkill(skillRoot, "gamma", "fixture skill three");

      let agentDir = "";
      const session = await createTestSession({
        settings: PRESET_SETTINGS, // default = base → alpha only
        skillRoot,
        onCreated: (p) => {
          agentDir = p.agentDir;
        },
      });

      await session.prompt(PROMPT);
      const before = systemSectionMessages(session);
      expect(before[before.length - 1].text("skills")).toContain("<name>alpha</name>");
      expect(before[before.length - 1].text("skills")).not.toContain("<name>beta</name>");

      // Mid-session: settings.json default switches from base to extra.
      // Per-turn refresh must pull extra into the active set without any
      // explicit /preset-load.
      writeFileSync(
        join(agentDir, "settings.json"),
        JSON.stringify(
          {
            presets: {
              default: "extra",
              definitions: {
                base: { skills: ["alpha"] },
                extra: { skills: ["beta", "gamma"] },
              },
            },
          },
          null,
          2,
        ),
      );
      await session.prompt(PROMPT);

      const after = systemSectionMessages(session);
      const skills = after[after.length - 1].text("skills");
      expect(skills).toContain("<name>beta</name>");
      expect(skills).toContain("<name>gamma</name>");
    },
    180_000,
  );

  it(
    "default switch mid-session removes old default skills (H1 regression, ocr F1)",
    async () => {
      const skillRoot = makeTempDir("t66-skills-");
      makeSkill(skillRoot, "alpha", "fixture skill one");
      makeSkill(skillRoot, "beta", "fixture skill two");
      makeSkill(skillRoot, "gamma", "fixture skill three");

      let agentDir = "";
      const session = await createTestSession({
        settings: PRESET_SETTINGS, // default = base → alpha only
        skillRoot,
        onCreated: (p) => {
          agentDir = p.agentDir;
        },
      });

      await session.prompt(PROMPT);
      const before = systemSectionMessages(session);
      expect(before[before.length - 1].text("skills")).toContain("<name>alpha</name>");

      // Mid-session: default switches base → extra. The default is never in
      // the explicit active set, so the old default's skills must disappear
      // on the next turn (no stale base residue).
      writeFileSync(
        join(agentDir, "settings.json"),
        JSON.stringify(
          {
            presets: {
              default: "extra",
              definitions: {
                base: { skills: ["alpha"] },
                extra: { skills: ["beta", "gamma"] },
              },
            },
          },
          null,
          2,
        ),
      );
      await session.prompt(PROMPT);

      const after = systemSectionMessages(session);
      const skills = after[after.length - 1].text("skills");
      expect(skills).toContain("<name>beta</name>");
      expect(skills).toContain("<name>gamma</name>");
      expect(skills).not.toContain("<name>alpha</name>");
    },
    180_000,
  );

  it(
    "multi-preset same-name skill is deduplicated in the section",
    async () => {
      const skillRoot = makeTempDir("t62-skills-");
      makeSkill(skillRoot, "alpha", "fixture skill one");
      makeSkill(skillRoot, "beta", "fixture skill two");
      makeSkill(skillRoot, "gamma", "fixture skill three");

      const session = await createTestSession({ settings: PRESET_SETTINGS, skillRoot });

      await session.prompt(PROMPT);
      await session.prompt("/preset-load dup");
      await session.prompt(PROMPT);

      const views = systemSectionMessages(session);
      expect(views.length).toBe(2);
      expect(views[1].keys).toEqual(["skills"]);
      const skills = views[1].text("skills");
      expect(skills).toContain("<name>beta</name>");
      // alpha is in both `base` (default) and `dup` — rendered once.
      expect(countOccurrences(skills, "<name>alpha</name>")).toBe(1);
    },
    180_000,
  );

  it(
    "session tree navigation: side-branch preset load reverts on navigate back (#64)",
    async () => {
      const skillRoot = makeTempDir("t64-skills-");
      makeSkill(skillRoot, "alpha", "fixture skill one");
      makeSkill(skillRoot, "beta", "fixture skill two");
      makeSkill(skillRoot, "gamma", "fixture skill three");

      const session = await createTestSession({ settings: PRESET_SETTINGS, skillRoot });

      // Main line: two turns → u1→a1→u2→a2 (leaf = a2).
      await session.prompt(PROMPT);
      await session.prompt(PROMPT);
      const mainLeafId = session.sessionManager.getLeafId();
      expect(mainLeafId).not.toBeNull();

      // Navigate back to the first assistant reply → leaf = a1 (non-user message:
      // leaf stays on the selected node). Next prompt forks a side branch under a1.
      const firstAssistant = (
        session.sessionManager.getEntries() as SessionEntry[]
      ).find((e) => e.type === "message" && e.message.role === "assistant");
      expect(firstAssistant).toBeDefined();
      const nav = await session.navigateTree(firstAssistant!.id, { summarize: false });
      expect(nav.cancelled).toBe(false);

      // Side branch: load `extra` (beta+gamma) and turn.
      await session.prompt("/preset-load extra");
      await session.prompt(PROMPT);
      const sideViews = systemSectionMessages(session);
      const sideSkills = sideViews[sideViews.length - 1].text("skills");
      expect(sideSkills).toContain("<name>alpha</name>");
      expect(sideSkills).toContain("<name>beta</name>");
      expect(sideSkills).toContain("<name>gamma</name>");

      // Navigate back to the main leaf: the side branch's preset-op must be
      // excluded by path-aware replay — active set falls back to default only.
      const back = await session.navigateTree(mainLeafId!, { summarize: false });
      expect(back.cancelled).toBe(false);
      await session.prompt(PROMPT);
      const mainViews = systemSectionMessages(session);
      const mainSkills = mainViews[mainViews.length - 1].text("skills");
      expect(mainSkills).toContain("<name>alpha</name>");
      expect(mainSkills).not.toContain("<name>beta</name>");
      expect(mainSkills).not.toContain("<name>gamma</name>");
    },
    180_000,
  );
});
