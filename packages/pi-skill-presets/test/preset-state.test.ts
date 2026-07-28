import { describe, it, expect } from "vitest";
import { PresetState } from "../src/preset-state.js";
import type { PresetsConfig, PresetOpEntry } from "../src/types.js";

describe("PresetState", () => {
  it("loads and offloads presets", () => {
    const state = new PresetState();
    expect(state.getLoaded()).toEqual([]);

    state.load("ddd");
    expect(state.getLoaded()).toEqual(["ddd"]);

    state.load("go");
    expect(state.getLoaded()).toEqual(["ddd", "go"]);

    state.offload("ddd");
    expect(state.getLoaded()).toEqual(["go"]);
  });

  it("has() checks loaded state", () => {
    const state = new PresetState();
    expect(state.has("ddd")).toBe(false);

    state.load("ddd");
    expect(state.has("ddd")).toBe(true);
    expect(state.has("go")).toBe(false);
  });

  it("clear() removes all presets", () => {
    const state = new PresetState();
    state.load("ddd");
    state.load("go");
    state.clear();
    expect(state.getLoaded()).toEqual([]);
  });

  it("replayEntries rebuilds active set from history", () => {
    const state = new PresetState();
    const entries: PresetOpEntry[] = [
      { action: "load", preset: "ddd", timestamp: 1000 },
      { action: "load", preset: "go", timestamp: 2000 },
      { action: "offload", preset: "ddd", timestamp: 3000 },
    ];
    state.replayEntries(entries);
    expect(state.getLoaded()).toEqual(["go"]);
  });

  it("replayEntries with empty array clears state", () => {
    const state = new PresetState();
    state.load("ddd");
    state.replayEntries([]);
    expect(state.getLoaded()).toEqual([]);
  });

  it("replayEntries handles re-load after offload", () => {
    const state = new PresetState();
    const entries: PresetOpEntry[] = [
      { action: "load", preset: "ddd", timestamp: 1000 },
      { action: "offload", preset: "ddd", timestamp: 2000 },
      { action: "load", preset: "ddd", timestamp: 3000 },
    ];
    state.replayEntries(entries);
    expect(state.has("ddd")).toBe(true);
  });
});

describe("PresetState.resolveSkills", () => {
  const config: PresetsConfig = {
    default: "engineer",
    definitions: {
      engineer: { skills: ["wayfinder", "tdd", "implement"] },
      ddd: { skills: ["domain-modeling", "ubiquitous-language"] },
      go: { skills: ["go", "idiomatic-go", "domain-modeling"] },
    },
  };

  it("resolves skills from loaded presets (deduplicated)", () => {
    const state = new PresetState();
    state.load("ddd");
    state.load("go");

    const result = state.resolveSkills(config);
    // domain-modeling appears in both ddd and go, should be deduplicated
    expect(result.skillNames.sort()).toEqual([
      "domain-modeling",
      "go",
      "idiomatic-go",
      "ubiquitous-language",
    ]);
  });

  it("includes all active set skills (default preset is not excluded in v2)", () => {
    const state = new PresetState();
    state.load("engineer"); // default preset, now included in v2
    state.load("ddd");

    const result = state.resolveSkills(config);
    // In v2, default preset is in active set, so its skills ARE included
    expect(result.skillNames).toContain("wayfinder");
    expect(result.skillNames).toContain("tdd");
    expect(result.skillNames).toContain("domain-modeling");
  });

  it("returns empty when no presets loaded", () => {
    const state = new PresetState();
    const result = state.resolveSkills(config);
    expect(result.skillNames).toEqual([]);
  });

  it("reports missing presets", () => {
    const state = new PresetState();
    state.load("nonexistent");

    const result = state.resolveSkills(config);
    expect(result.missing).toContain("preset:nonexistent");
    expect(result.skillNames).toEqual([]);
  });
});
