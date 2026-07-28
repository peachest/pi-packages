import { describe, it, expect } from "vitest";
import { filterSkills } from "../src/skill-resolver.ts";
import type { Skill } from "@earendil-works/pi-coding-agent";

// Helper: create a minimal Skill object
function makeSkill(name: string): Skill {
  return {
    name,
    description: `${name} skill`,
    filePath: `/skills/${name}/SKILL.md`,
    baseDir: `/skills/${name}`,
    sourceInfo: { source: "test", origin: "package" as const, path: `/skills/${name}`, scope: "user" as const },
    disableModelInvocation: false,
  };
}

describe("filterSkills", () => {
  it("returns all requested skills that are available", () => {
    const available = [makeSkill("go"), makeSkill("tdd"), makeSkill("wayfinder")];
    const result = filterSkills(
      available,
      ["go", "tdd"],
      new Set(),
      [],
    );
    expect(result.skills.map((s) => s.name).sort()).toEqual(["go", "tdd"]);
    expect(result.missing).toEqual([]);
    expect(result.disabled).toEqual([]);
  });

  it("reports missing skills not in available list", () => {
    const available = [makeSkill("go")];
    const result = filterSkills(
      available,
      ["go", "nonexistent"],
      new Set(),
      [],
    );
    expect(result.skills.map((s) => s.name)).toEqual(["go"]);
    expect(result.missing).toEqual(["nonexistent"]);
  });

  it("excludes skills in the excluded set", () => {
    const available = [makeSkill("go"), makeSkill("tdd"), makeSkill("wayfinder")];
    const result = filterSkills(
      available,
      ["go", "tdd", "wayfinder"],
      new Set(["tdd"]),
      [],
    );
    expect(result.skills.map((s) => s.name).sort()).toEqual(["go", "wayfinder"]);
    expect(result.missing).toEqual([]);
  });

  it("excludes skills matching disabled patterns by name", () => {
    const available = [makeSkill("go"), makeSkill("tdd")];
    const result = filterSkills(
      available,
      ["go", "tdd"],
      new Set(),
      ["-tdd"],
    );
    expect(result.skills.map((s) => s.name)).toEqual(["go"]);
    expect(result.disabled).toEqual(["tdd"]);
  });

  it("excludes skills matching disabled patterns by path suffix", () => {
    const available = [makeSkill("go"), makeSkill("tdd")];
    const result = filterSkills(
      available,
      ["go", "tdd"],
      new Set(),
      ["-/skills/tdd"],
    );
    expect(result.skills.map((s) => s.name)).toEqual(["go"]);
    expect(result.disabled).toEqual(["tdd"]);
  });

  it("handles empty input", () => {
    const result = filterSkills([], [], new Set(), []);
    expect(result.skills).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.disabled).toEqual([]);
  });

  it("does not report excluded skills as missing", () => {
    const available = [makeSkill("go"), makeSkill("tdd")];
    const result = filterSkills(
      available,
      ["go", "tdd"],
      new Set(["tdd"]),
      [],
    );
    // tdd is excluded, not missing
    expect(result.missing).toEqual([]);
  });
});
