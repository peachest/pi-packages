/**
 * Shared integration-test harness for skill-presets — extracted from
 * preset-diff.integration.test.ts and commands-semantics.test.ts.
 *
 * Provides: gateway precheck, strictly pinned model resolution (#65 B4 —
 * no silent fallback), skill fixtures, and a full agent-session factory
 * driven through the real extension entry (index.ts).
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe } from "vitest";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import skillPresetsExtension from "../../index.ts";

export const PINNED_MODEL_ID = "glm53-flash-internal";
export const PROMPT = "Reply with exactly one word: ok";

export const REAL_AGENT_DIR =
  process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");

// ---------------------------------------------------------------------------
// Gateway precheck
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

export const gatewayUp = await gatewayReachable();

// ---------------------------------------------------------------------------
// Fixtures + session factory
// ---------------------------------------------------------------------------

const madeDirs: string[] = [];

export function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  madeDirs.push(dir);
  return dir;
}

/** Best-effort removal of every temp dir created by this harness. Register via afterAll. */
export function cleanupMadeDirs(): void {
  for (const dir of madeDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

/** Write a minimal skill fixture: <root>/<name>/SKILL.md with name/description frontmatter. */
export function makeSkill(root: string, name: string, description: string): void {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(
    join(root, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${description}\n`,
  );
}

export interface SessionOpts {
  settings: Record<string, unknown>;
  /** Extra skills dir passed as additionalSkillPaths (bypasses settings `-` filtering). */
  skillRoot?: string;
  /** Skills placed in <agentDir>/skills for auto-discovery (settings `-` applies). */
  agentDirSkills?: boolean;
  /** Receives the created paths so tests can rewrite settings mid-session. */
  onCreated?: (paths: { agentDir: string; cwd: string }) => void;
}

export async function createTestSession(opts: SessionOpts): Promise<AgentSession> {
  const agentDir = makeTempDir("preset-harness-agent-");
  const cwd = makeTempDir("preset-harness-cwd-");
  opts.onCreated?.({ agentDir, cwd });
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

// ---------------------------------------------------------------------------
// Shared runtime — strict model pin (#65 B4): no fallback to available[0]
// ---------------------------------------------------------------------------

export const modelRuntime = await ModelRuntime.create({
  authPath: join(REAL_AGENT_DIR, "auth.json"),
  modelsPath: join(REAL_AGENT_DIR, "models.json"),
});
const available = await modelRuntime.getAvailable();
export const model: Model<Api> | undefined = available.find(
  (m) => m.id === PINNED_MODEL_ID,
);

// Whole group skips when the gateway is unreachable OR the pinned model is
// absent — same treatment as network unreachability, never a silent fallback.
export const suite = gatewayUp && model ? describe : describe.skip;
