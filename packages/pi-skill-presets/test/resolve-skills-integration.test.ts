import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { resolveSkills, getSystemPromptSkillNames } from "../src/skill-resolver.ts";

const TMP_DIR = path.join(os.tmpdir(), `skill-presets-resolve-test-${Date.now()}`);
const AGENT_DIR = path.join(TMP_DIR, "agent");
const PROJECT_DIR = path.join(TMP_DIR, "project");
const SKILLS_DIR = path.join(AGENT_DIR, "skills");

// Create real skill files for integration testing
function createSkill(name: string): void {
  const skillDir = path.join(SKILLS_DIR, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: Test skill ${name}\n---\nSkill body.\n`,
  );
}

describe("resolveSkills (integration)", () => {
  beforeAll(() => {
    process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
    fs.mkdirSync(AGENT_DIR, { recursive: true });
    fs.mkdirSync(path.join(PROJECT_DIR, ".pi"), { recursive: true });
    fs.mkdirSync(SKILLS_DIR, { recursive: true });

    // Create test skills
    createSkill("go");
    createSkill("tdd");
    createSkill("wayfinder");

    // Write settings with skills path + a disabled pattern
    fs.writeFileSync(
      path.join(AGENT_DIR, "settings.json"),
      JSON.stringify({
        skills: [`+${SKILLS_DIR}`],
      }),
    );
  });

  afterAll(() => {
    delete process.env.PI_CODING_AGENT_DIR;
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it("resolves existing skill names to Skill objects", () => {
    const result = resolveSkills(PROJECT_DIR, ["go", "tdd"], new Set());
    const names = result.skills.map((s) => s.name).sort();
    expect(names).toEqual(["go", "tdd"]);
    expect(result.missing).toEqual([]);
    expect(result.disabled).toEqual([]);
  });

  it("reports missing skills", () => {
    const result = resolveSkills(PROJECT_DIR, ["go", "nonexistent"], new Set());
    expect(result.skills.map((s) => s.name)).toEqual(["go"]);
    expect(result.missing).toEqual(["nonexistent"]);
  });

  it("excludes skills in the excluded set", () => {
    const result = resolveSkills(
      PROJECT_DIR,
      ["go", "tdd"],
      new Set(["tdd"]),
    );
    expect(result.skills.map((s) => s.name)).toEqual(["go"]);
    expect(result.missing).toEqual([]);
  });

  it("reports disabled skills from settings patterns", () => {
    // Write settings with a disabled pattern
    fs.writeFileSync(
      path.join(AGENT_DIR, "settings.json"),
      JSON.stringify({
        skills: [`+${SKILLS_DIR}`, "-tdd"],
      }),
    );

    const result = resolveSkills(PROJECT_DIR, ["go", "tdd"], new Set());
    expect(result.skills.map((s) => s.name)).toEqual(["go"]);
    expect(result.disabled).toEqual(["tdd"]);

    // Restore settings
    fs.writeFileSync(
      path.join(AGENT_DIR, "settings.json"),
      JSON.stringify({ skills: [`+${SKILLS_DIR}`] }),
    );
  });
});

describe("getSystemPromptSkillNames", () => {
  it("returns a set of default preset skill names", () => {
    const result = getSystemPromptSkillNames("/tmp", ["wayfinder", "tdd"]);
    expect(result).toBeInstanceOf(Set);
    expect(result.has("wayfinder")).toBe(true);
    expect(result.has("tdd")).toBe(true);
    expect(result.has("go")).toBe(false);
  });

  it("returns empty set for empty input", () => {
    const result = getSystemPromptSkillNames("/tmp", []);
    expect(result.size).toBe(0);
  });
});
