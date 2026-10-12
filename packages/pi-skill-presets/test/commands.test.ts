import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCommands } from "../src/commands.ts";
import { PRESET_OP_CUSTOM_TYPE } from "../src/types.ts";
import { PresetState } from "../src/preset-state.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { PresetOpEntry } from "../src/types.ts";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";

// Set up temp agent dir with presets config so readPresetsConfig works
const TMP_DIR = path.join(os.tmpdir(), `skill-presets-cmd-test-${Date.now()}`);
const AGENT_DIR = path.join(TMP_DIR, "agent");

// Fake pi that records appendEntry calls
function makeFakePi(): { pi: ExtensionAPI; entries: PresetOpEntry[] } {
  const entries: PresetOpEntry[] = [];
  const pi = {
    appendEntry: (_customType: string, data: PresetOpEntry) => {
      entries.push(data);
    },
  } as unknown as ExtensionAPI;
  return { pi, entries };
}

// Fake command context that records notify calls; platformSkills feeds
// ctx.getSystemPromptOptions() (the platform's discovered skill set).
function makeFakeCtx(
  platformSkills: string[] = [],
): { ctx: ExtensionCommandContext; notifications: Array<{ msg: string; type: string }> } {
  const notifications: Array<{ msg: string; type: string }> = [];
  const ctx = {
    ui: {
      notify: (msg: string, type?: string) => {
        notifications.push({ msg, type: type ?? "info" });
      },
      select: async () => undefined,
      confirm: async () => false,
    },
    hasUI: true,
    cwd: TMP_DIR,
    getSystemPromptOptions: () => ({
      skills: platformSkills.map((name) => ({ name, description: "", filePath: "" })),
    }),
  } as unknown as ExtensionCommandContext;
  return { ctx, notifications };
}

describe("command dispatch", () => {
  beforeAll(() => {
    process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
    fs.mkdirSync(AGENT_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(AGENT_DIR, "settings.json"),
      JSON.stringify({
        presets: {
          default: "engineer",
          definitions: {
            engineer: { skills: ["wayfinder", "tdd"] },
            ddd: { skills: ["domain-modeling"] },
          },
        },
      }),
    );
  });

  afterAll(() => {
    delete process.env.PI_CODING_AGENT_DIR;
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  });

  describe("/preset-load", () => {
    it("loads a preset and appends an entry", async () => {
      const state = new PresetState();
      const { pi, entries } = makeFakePi();
      const { ctx, notifications } = makeFakeCtx();
      const commands = createCommands(pi, state, () => TMP_DIR, () => "engineer");

      await commands.presetLoadCommand("ddd", ctx);

      expect(state.has("ddd")).toBe(true);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.action).toBe("load");
      expect(entries[0]!.preset).toBe("ddd");
      expect(notifications.some((n) => n.msg.includes("Loaded preset"))).toBe(true);
    });

    it("does nothing when preset is already loaded", async () => {
      const state = new PresetState();
      state.load("ddd");
      const { pi, entries } = makeFakePi();
      const { ctx, notifications } = makeFakeCtx();
      const commands = createCommands(pi, state, () => TMP_DIR, () => "engineer");

      await commands.presetLoadCommand("ddd", ctx);

      expect(entries).toHaveLength(0);
      expect(notifications.some((n) => n.msg.includes("already loaded"))).toBe(true);
    });

    it("notifies error when preset does not exist", async () => {
      const state = new PresetState();
      const { pi, entries } = makeFakePi();
      const { ctx, notifications } = makeFakeCtx();
      const commands = createCommands(pi, state, () => TMP_DIR, () => "engineer");

      await commands.presetLoadCommand("nonexistent", ctx);

      expect(state.has("nonexistent")).toBe(false);
      expect(entries).toHaveLength(0);
      expect(notifications.some((n) => n.type === "error")).toBe(true);
    });

    it("notifies usage when no name provided", async () => {
      const state = new PresetState();
      const { pi, entries } = makeFakePi();
      const { ctx, notifications } = makeFakeCtx();
      const commands = createCommands(pi, state, () => TMP_DIR, () => "engineer");

      await commands.presetLoadCommand("", ctx);

      expect(entries).toHaveLength(0);
      expect(notifications.some((n) => n.msg.includes("Usage"))).toBe(true);
    });

    it("warns about bad references but still loads", async () => {
      const { pi } = makeFakePi();
      const { ctx, notifications } = makeFakeCtx(["wayfinder", "tdd", "domain-modeling"]);
      const commands = createCommands(pi, new PresetState(), () => TMP_DIR, () => "engineer");

      // "ddd" references domain-modeling (present) only — no warning.
      await commands.presetLoadCommand("ddd", ctx);
      expect(notifications.some((n) => n.type === "warning")).toBe(false);

      // Platform list missing domain-modeling: bad ref warns, load proceeds.
      const state2 = new PresetState();
      const fake2 = makeFakePi();
      const fakeCtx2 = makeFakeCtx(["wayfinder", "tdd"]);
      const commands2 = createCommands(fake2.pi, state2, () => TMP_DIR, () => "engineer");
      await commands2.presetLoadCommand("ddd", fakeCtx2.ctx);

      expect(state2.has("ddd")).toBe(true);
      expect(fake2.entries).toHaveLength(1);
      const warn = fakeCtx2.notifications.find((n) => n.type === "warning");
      expect(warn?.msg).toContain("domain-modeling");
      expect(warn?.msg).toContain("missing or disabled");
    });

    it("warns again when a bad preset is loaded twice", async () => {
      const state = new PresetState();
      state.load("ddd");
      const { pi, entries } = makeFakePi();
      const { ctx, notifications } = makeFakeCtx(["wayfinder", "tdd"]);
      const commands = createCommands(pi, state, () => TMP_DIR, () => "engineer");

      await commands.presetLoadCommand("ddd", ctx);

      const warnings = notifications.filter((n) => n.type === "warning");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.msg).toContain("domain-modeling");
      expect(entries).toHaveLength(0);
    });
  });

  describe("/preset-off", () => {
    it("offloads a preset and appends an entry", async () => {
      const state = new PresetState();
      state.load("ddd");
      const { pi, entries } = makeFakePi();
      const { ctx, notifications } = makeFakeCtx();
      const commands = createCommands(pi, state, () => TMP_DIR, () => "engineer");

      await commands.presetOffCommand("ddd", ctx);

      expect(state.has("ddd")).toBe(false);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.action).toBe("offload");
      expect(entries[0]!.preset).toBe("ddd");
    });

    it("does nothing when preset is not loaded", async () => {
      const state = new PresetState();
      const { pi, entries } = makeFakePi();
      const { ctx, notifications } = makeFakeCtx();
      const commands = createCommands(pi, state, () => TMP_DIR, () => "engineer");

      await commands.presetOffCommand("ddd", ctx);

      expect(entries).toHaveLength(0);
      expect(notifications.some((n) => n.msg.includes("not loaded"))).toBe(true);
    });

    it("rejects offloading the default preset", async () => {
      const state = new PresetState();
      state.load("engineer");
      const { pi, entries } = makeFakePi();
      const { ctx, notifications } = makeFakeCtx();
      const commands = createCommands(pi, state, () => TMP_DIR, () => "engineer");

      await commands.presetOffCommand("engineer", ctx);

      expect(state.has("engineer")).toBe(true);
      expect(entries).toHaveLength(0);
      const err = notifications.find((n) => n.type === "error");
      expect(err?.msg).toContain("default preset");
      expect(err?.msg).toContain("cannot be offloaded");
    });
  });

  describe("/preset-status", () => {
    it("shows default preset and active set", async () => {
      const state = new PresetState();
      state.load("ddd");
      const { pi } = makeFakePi();
      const { ctx, notifications } = makeFakeCtx();
      const commands = createCommands(pi, state, () => TMP_DIR, () => "engineer");

      await commands.presetStatusCommand("", ctx);

      const statusMsg = notifications[0]?.msg ?? "";
      expect(statusMsg).toContain("Default: engineer");
      expect(statusMsg).toContain("ddd");
      expect(statusMsg).toContain("domain-modeling");
    });

    it("shows no presets loaded when empty", async () => {
      const state = new PresetState();
      const { pi } = makeFakePi();
      const { ctx, notifications } = makeFakeCtx();
      const commands = createCommands(pi, state, () => TMP_DIR, () => undefined);

      await commands.presetStatusCommand("", ctx);

      expect(notifications[0]?.msg).toContain("No presets loaded");
    });

    it("annotates presets missing from config", async () => {
      const state = new PresetState();
      state.load("ddd");
      state.load("ghost");
      const { pi } = makeFakePi();
      const { ctx, notifications } = makeFakeCtx();
      const commands = createCommands(pi, state, () => TMP_DIR, () => "engineer");

      await commands.presetStatusCommand("", ctx);

      const msg = notifications[0]?.msg ?? "";
      expect(msg).toContain("ghost (missing from config)");
      expect(msg).not.toContain("ddd (missing from config)");
    });
  });
});
