/**
 * SDK 回归基线（#38 实测口径重建）：真实 session 中 preset load/offload 只产出
 * 最小 skills section patch（prefix cache 不破坏）。
 *
 * Seam（#62 预定）：createAgentSession + extensionFactories + 自定义 agentDir +
 * 测试技能目录；断言谓词 = sessionManager.getEntries() 中的 system sections 消息。
 *
 * 模型 pin：glm53-flash-internal。若 modelRuntime.getAvailable() 找不到该 id，
 * 回退到第一个可用模型（文件顶部注释即此说明；回退后断言只依赖 fixture 技能，
 * 不依赖具体模型）。
 *
 * 网关预检：models.json 中托管 pin 模型的 provider baseUrl 3s 内不可达时整组 skip。
 */

import { afterAll, describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import type { AgentSession, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { Api } from "@earendil-works/pi-ai";
import skillPresetsExtension from "../index.ts";

const PINNED_MODEL_ID = "glm53-flash-internal";
const PROMPT = "Reply with exactly one word: ok";

// Capture the real agent dir before tests override PI_CODING_AGENT_DIR.
const REAL_AGENT_DIR =
  process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");

// ---------------------------------------------------------------------------
// Gateway precheck (3s timeout) against the provider hosting the pinned model.
// ---------------------------------------------------------------------------

function findGatewayProvider(): { baseUrl: string; apiKey?: string } | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(REAL_AGENT_DIR, "models.json"), "utf-8"));
  } catch {
    return undefined;
  }
  const providers = Object.values(
    (raw as { providers?: Record<string, { baseUrl?: string; apiKey?: string; models?: Array<{ id?: string }> }> })
      .providers ?? {},
  );
  const hosting = providers.find((p) =>
    (p.models ?? []).some((m) => m.id === PINNED_MODEL_ID),
  );
  const fallback = providers.find(
    (p) => typeof p.baseUrl === "string" && p.baseUrl.startsWith("http"),
  );
  const picked = hosting ?? fallback;
  if (!picked?.baseUrl) return undefined;
  return { baseUrl: picked.baseUrl, apiKey: picked.apiKey };
}

const gateway = findGatewayProvider();

async function gatewayReachable(): Promise<boolean> {
  if (!gateway) return false;
  try {
    const headers: Record<string, string> = {};
    if (gateway.apiKey && !gateway.apiKey.startsWith("${")) {
      headers.Authorization = `Bearer ${gateway.apiKey}`;
    }
    const res = await fetch(`${gateway.baseUrl}/models`, {
      headers,
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const gatewayUp = await gatewayReachable();

// ---------------------------------------------------------------------------
// Fixtures + session factory
// ---------------------------------------------------------------------------

const madeDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  madeDirs.push(dir);
  return dir;
}

/** Write a minimal skill fixture: <root>/<name>/SKILL.md with name/description frontmatter. */
function makeSkill(root: string, name: string, description: string): void {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(
    join(root, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${description}\n`,
  );
}

interface SessionOpts {
  settings: Record<string, unknown>;
  /** Extra skills dir passed as additionalSkillPaths (bypasses settings `-` filtering). */
  skillRoot?: string;
  /** Skills placed in <agentDir>/skills for auto-discovery (settings `-` applies). */
  agentDirSkills?: boolean;
}

async function createTestSession(opts: SessionOpts): Promise<AgentSession> {
  const agentDir = makeTempDir("t62-agent-");
  const cwd = makeTempDir("t62-cwd-");
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify(opts.settings, null, 2));
  if (opts.agentDirSkills) {
    const skillsDir = join(agentDir, "skills");
    mkdirSync(skillsDir, { recursive: true });
    makeSkill(skillsDir, "alpha", "fixture skill one");
    makeSkill(skillsDir, "beta", "fixture skill two");
    makeSkill(skillsDir, "gamma", "fixture skill three");
  }
  // The extension reads presets via PI_CODING_AGENT_DIR; align the whole stack.
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    additionalSkillPaths: opts.skillRoot ? [opts.skillRoot] : [],
    extensionFactories: [{ name: "skill-presets", factory: skillPresetsExtension }],
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd,
    modelRuntime,
    model,
    tools: ["read"],
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
  });
  // SDK mode: session_start (and command context) only fires via bindExtensions,
  // which the TUI normally calls. Empty bindings use pi's no-op UI context.
  await session.bindExtensions({});
  return session;
}

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
// Shared runtime
// ---------------------------------------------------------------------------

const modelRuntime = await ModelRuntime.create({
  authPath: join(REAL_AGENT_DIR, "auth.json"),
  modelsPath: join(REAL_AGENT_DIR, "models.json"),
});
const available = await modelRuntime.getAvailable();
// Pin glm53-flash-internal; fall back to the first available model when absent.
const model: Model<Api> | undefined =
  available.find((m) => m.id === PINNED_MODEL_ID) ?? available[0];

afterAll(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  for (const dir of madeDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

const suite = gatewayUp && model ? describe : describe.skip;

if (!available.some((m) => m.id === PINNED_MODEL_ID)) {
  // Documented fallback: pinned model absent from getAvailable() → first available.
  console.warn(
    `[preset-diff.integration] model "${PINNED_MODEL_ID}" not available; using fallback ${model?.provider}/${model?.id}`,
  );
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

suite(`preset-diff integration (gateway ${gateway?.baseUrl ?? "n/a"}, model ${PINNED_MODEL_ID})`, () => {
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
