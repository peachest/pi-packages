/**
 * Command semantics integration tests (#63): failure visibility, default
 * guard, status annotation — driven through the native command dispatch seam
 * (session.prompt("/preset-...")), same harness as preset-diff.integration.
 *
 * Warning/error content is asserted via the recordNotify sink in src/notify.ts
 * (SDK command contexts use a no-op UI, so ctx.ui.notify is not observable).
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
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
import type { Model, Api } from "@earendil-works/pi-ai";
import skillPresetsExtension from "../index.ts";
import {
  notificationLog,
  resetNotificationLog,
} from "../src/notify.ts";
import { PRESET_OP_CUSTOM_TYPE } from "../src/types.ts";

const PINNED_MODEL_ID = "glm53-flash-internal";
const PROMPT = "Reply with exactly one word: ok";

const REAL_AGENT_DIR =
  process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");

// ---------------------------------------------------------------------------
// Gateway precheck (same as preset-diff.integration)
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
// Fixtures + session factory (trimmed preset-diff harness)
// ---------------------------------------------------------------------------

const madeDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  madeDirs.push(dir);
  return dir;
}

function makeSkill(root: string, name: string, description: string): void {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(
    join(root, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${description}\n`,
  );
}

async function createTestSession(settings: Record<string, unknown>): Promise<AgentSession> {
  const agentDir = makeTempDir("t63-agent-");
  const cwd = makeTempDir("t63-cwd-");
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings, null, 2));
  const skillsDir = join(agentDir, "skills");
  mkdirSync(skillsDir, { recursive: true });
  makeSkill(skillsDir, "alpha", "fixture skill one");
  makeSkill(skillsDir, "beta", "fixture skill two");
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
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
  await session.bindExtensions({});
  return session;
}

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
// Shared runtime
// ---------------------------------------------------------------------------

const modelRuntime = await ModelRuntime.create({
  authPath: join(REAL_AGENT_DIR, "auth.json"),
  modelsPath: join(REAL_AGENT_DIR, "models.json"),
});
const available = await modelRuntime.getAvailable();
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

beforeEach(() => {
  resetNotificationLog();
});

const suite = gatewayUp && model ? describe : describe.skip;

suite(`command semantics integration (gateway ${gateway?.baseUrl ?? "n/a"}, model ${PINNED_MODEL_ID})`, () => {
  it(
    "unknown preset name: error notify with available names, no entry, no skills change",
    async () => {
      const session = await createTestSession(BASE_SETTINGS);
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
      const session = await createTestSession(BASE_SETTINGS);
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
      const session = await createTestSession(BASE_SETTINGS);
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
        presets: {
          default: "base",
          definitions: { base: { skills: ["alpha", "ghost"] } },
        },
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
