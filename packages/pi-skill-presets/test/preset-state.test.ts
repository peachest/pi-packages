import { describe, it, expect } from "vitest";
import { PresetState, PRESET_OP_CUSTOM_TYPE } from "../index.ts";
import type { PresetsConfig, PresetOpEntry } from "../index.ts";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

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

  /** Wrap a preset op as the custom entry shape the replay path filters for. */
  const asEntry = (op: PresetOpEntry): SessionEntry =>
    ({ type: "custom", customType: PRESET_OP_CUSTOM_TYPE, data: op, id: "x", parentId: null }) as unknown as SessionEntry;

  it("rebuildFromEntries rebuilds active set from history", () => {
    const state = new PresetState();
    const entries = [
      asEntry({ action: "load", preset: "ddd", timestamp: 1000 }),
      asEntry({ action: "load", preset: "go", timestamp: 2000 }),
      asEntry({ action: "offload", preset: "ddd", timestamp: 3000 }),
    ];
    state.rebuildFromEntries(entries);
    expect(state.getLoaded()).toEqual(["go"]);
  });

  it("rebuildFromEntries with empty array clears state", () => {
    const state = new PresetState();
    state.load("ddd");
    state.rebuildFromEntries([]);
    expect(state.getLoaded()).toEqual([]);
  });

  it("rebuildFromEntries handles re-load after offload", () => {
    const state = new PresetState();
    const entries = [
      asEntry({ action: "load", preset: "ddd", timestamp: 1000 }),
      asEntry({ action: "offload", preset: "ddd", timestamp: 2000 }),
      asEntry({ action: "load", preset: "ddd", timestamp: 3000 }),
    ];
    state.rebuildFromEntries(entries);
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

  it("includes all explicitly loaded preset skills (default or not)", () => {
    const state = new PresetState();
    state.load("engineer");
    state.load("ddd");

    const result = state.resolveSkills(config);
    // Explicit loads always contribute their skills, whatever their name.
    expect(result.skillNames).toContain("wayfinder");
    expect(result.skillNames).toContain("tdd");
    expect(result.skillNames).toContain("domain-modeling");
  });

  it("returns empty when no presets loaded", () => {
    const state = new PresetState();
    const result = state.resolveSkills(config);
    expect(result.skillNames).toEqual([]);
  });

  it("reports missing presets (preset-level, v3 semantics)", () => {
    const state = new PresetState();
    state.load("nonexistent");

    const result = state.resolveSkills(config);
    expect(result.missingPresets).toContain("nonexistent");
    expect(result.skillNames).toEqual([]);
  });

  // v3 default-identity semantics (ocr-F1): the default preset is NOT stored
  // in the active set; its skills are unioned per call via defaultName.
  it("unions the default preset's skills with the active set (defaultName)", () => {
    const state = new PresetState();
    state.load("ddd");

    const result = state.resolveSkills(config, "engineer");
    expect(result.skillNames.sort()).toEqual([
      "domain-modeling",
      "implement",
      "tdd",
      "ubiquitous-language",
      "wayfinder",
    ]);
  });

  it("dedups skills shared by default and active presets", () => {
    const state = new PresetState();
    state.load("go"); // shares "domain-modeling" with the default "engineer"

    const result = state.resolveSkills(config, "engineer");
    const names = result.skillNames;
    expect(names).toContain("domain-modeling");
    expect(names.filter((n) => n === "domain-modeling")).toHaveLength(1);
  });

  it("reports a default preset missing from config in missingPresets", () => {
    const state = new PresetState();
    state.load("ddd");

    const result = state.resolveSkills(config, "ghost");
    expect(result.missingPresets).toContain("ghost");
    // Active-set skills still resolve despite the missing default.
    expect(result.skillNames).toContain("domain-modeling");
  });

  it("without defaultName resolves only the active set (no implicit default)", () => {
    const state = new PresetState();
    state.load("ddd");

    const result = state.resolveSkills(config);
    expect(result.skillNames).not.toContain("wayfinder");
  });
});

describe("rebuildActiveSetFromEntries — compaction-safe replay (ocr R4H)", () => {
  it("replays preset-ops recorded before a compaction from the full branch", async () => {
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const sm = SessionManager.inMemory(process.cwd());

    const first = sm.appendCustomEntry(PRESET_OP_CUSTOM_TYPE, {
      action: "load",
      preset: "early",
      timestamp: Date.now(),
    } satisfies PresetOpEntry);
    const second = sm.appendCustomEntry(PRESET_OP_CUSTOM_TYPE, {
      action: "load",
      preset: "late",
      timestamp: Date.now(),
    } satisfies PresetOpEntry);

    // Compaction keeps entries from `second` onward; buildContextEntries()
    // therefore drops the first preset-op (correct for LLM context, wrong for replay).
    sm.appendCompaction("summary", second, 1234);

    expect(sm.buildContextEntries().some((e) => e.id === first)).toBe(false);

    // The extension replays from getBranch() (full history, no truncation).
    const state = new PresetState();
    state.rebuildFromEntries(sm.getBranch());
    expect(state.has("early")).toBe(true);
    expect(state.has("late")).toBe(true);
  });

  it("skips custom entries with null data without aborting the replay (ocr R5M3)", () => {
    // state.clear() has already run by the time entries are filtered, so a
    // single malformed entry must not throw and leave the active set empty.
    const nullEntry = {
      type: "custom",
      customType: PRESET_OP_CUSTOM_TYPE,
      data: null,
    } as unknown as SessionEntry;
    const legit = (action: "load" | "offload", preset: string): SessionEntry =>
      ({
        type: "custom",
        customType: PRESET_OP_CUSTOM_TYPE,
        data: { action, preset, timestamp: Date.now() },
      }) as unknown as SessionEntry;

    const state = new PresetState();
    expect(() =>
      state.rebuildFromEntries([
        legit("load", "before"),
        nullEntry,
        legit("load", "after"),
      ]),
    ).not.toThrow();
    expect(state.has("before")).toBe(true);
    expect(state.has("after")).toBe(true);
  });
});
