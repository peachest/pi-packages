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
    const injector = createInjector(state, config, "/tmp", ctx, "engineer");

    const inputMessages = [{ role: "user", content: "hello" }] as never[];
    const result = injector(inputMessages);
    expect(result.messages).toBe(inputMessages);
  });

  it("appends a CustomMessage when a non-default preset is loaded", () => {
    const state = new PresetState();
    state.load("ddd");
    const ctx = makeFakeCtx();
    const injector = createInjector(state, config, "/tmp", ctx, "engineer");

    const inputMessages = [{ role: "user", content: "hello" }] as never[];
    const result = injector(inputMessages);

    // Should have original + 1 injected message
    expect(result.messages.length).toBe(2);
    const injected = result.messages[1] as unknown as Record<string, unknown>;
    expect(injected.role).toBe("custom");
    expect(injected.customType).toBe(SKILL_INJECTION_CUSTOM_TYPE);
    expect(injected.display).toBe(false);
  });

  it("does not inject when only the default preset is in active set", () => {
    const state = new PresetState();
    state.load("engineer"); // default preset
    const ctx = makeFakeCtx();
    const injector = createInjector(state, config, "/tmp", ctx, "engineer");

    const inputMessages = [{ role: "user", content: "hello" }] as never[];
    const result = injector(inputMessages);
    // Default preset skills are excluded, so nothing to inject
    expect(result.messages.length).toBe(1);
  });

  it("includes preset names in details field of injected message", () => {
    const state = new PresetState();
    state.load("ddd");
    const ctx = makeFakeCtx();
    const injector = createInjector(state, config, "/tmp", ctx, "engineer");

    const inputMessages = [] as never[];
    const result = injector(inputMessages);

    if (result.messages.length > 0) {
      const injected = result.messages[result.messages.length - 1] as unknown as Record<string, unknown>;
      const details = injected.details as { presets: string[] };
      expect(details.presets).toContain("ddd");
    }
  });
});
