import { describe, it, expect } from "vitest";
import { createInjector, SKILL_INJECTION_CUSTOM_TYPE } from "../src/injector.ts";
import { PresetState } from "../src/preset-state.ts";
import type { PresetsConfig } from "../src/types.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// Minimal fake ctx — only ui.notify is used
function makeFakeCtx(): ExtensionContext {
  return {
    ui: {
      notify: () => {},
    },
  } as unknown as ExtensionContext;
}

const config: PresetsConfig = {
  default: "engineer",
  definitions: {
    engineer: { skills: ["wayfinder", "tdd"] },
    ddd: { skills: ["domain-modeling", "ubiquitous-language"] },
  },
};

describe("createInjector message transformation", () => {
  it("returns messages unchanged when no presets are loaded", () => {
    const state = new PresetState();
    const ctx = makeFakeCtx();
    // Empty system prompt skills — nothing to exclude
    const injector = createInjector(state, config, "/tmp", ctx, new Set());

    const inputMessages = [{ role: "user", content: "hello" }] as never[];
    const result = injector(inputMessages);
    expect(result.messages).toBe(inputMessages);
  });

  it("appends a CustomMessage when a preset is loaded and its skills are not in system prompt", () => {
    const state = new PresetState();
    state.load("ddd");
    const ctx = makeFakeCtx();
    // System prompt has engineer skills, ddd skills are not in it
    const systemPromptSkills = new Set(["wayfinder", "tdd"]);
    const injector = createInjector(state, config, "/tmp", ctx, systemPromptSkills);

    const inputMessages = [{ role: "user", content: "hello" }] as never[];
    const result = injector(inputMessages);

    // Should have original + 1 injected message (ddd skills injected)
    expect(result.messages.length).toBe(2);
    const injected = result.messages[1] as unknown as Record<string, unknown>;
    expect(injected.role).toBe("custom");
    expect(injected.customType).toBe(SKILL_INJECTION_CUSTOM_TYPE);
    expect(injected.display).toBe(false);
  });

  it("does not inject when all active set skills are already in system prompt", () => {
    const state = new PresetState();
    state.load("engineer"); // default preset, skills in system prompt
    const ctx = makeFakeCtx();
    // System prompt has engineer skills
    const systemPromptSkills = new Set(["wayfinder", "tdd"]);
    const injector = createInjector(state, config, "/tmp", ctx, systemPromptSkills);

    const inputMessages = [{ role: "user", content: "hello" }] as never[];
    const result = injector(inputMessages);
    // All engineer skills are in system prompt → nothing to inject
    expect(result.messages.length).toBe(1);
  });

  it("includes preset names in details field of injected message", () => {
    const state = new PresetState();
    state.load("ddd");
    const ctx = makeFakeCtx();
    const systemPromptSkills = new Set(["wayfinder", "tdd"]);
    const injector = createInjector(state, config, "/tmp", ctx, systemPromptSkills);

    const inputMessages = [] as never[];
    const result = injector(inputMessages);

    if (result.messages.length > 0) {
      const injected = result.messages[result.messages.length - 1] as unknown as Record<string, unknown>;
      const details = injected.details as { presets: string[] };
      expect(details.presets).toContain("ddd");
    }
  });
});
