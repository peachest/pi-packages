import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { showPresetDialog, PresetState, readPresetsConfig } from "../index.ts";
import { writePresetsConfig } from "../src/config.ts";
import type { PresetsConfig } from "../index.ts";

/**
 * Interactive save-failure retry path (ocr R6M1) and confirm-mode recovery
 * (ocr R6M2).
 *
 * R6M1: a failed writePresetsConfig must notify the user (preset name +
 * reason), leave the local edit uncommitted (rolled back so retrying the
 * original action re-attempts the write instead of hitting an
 * already-exists / already-added guard), and never commit session side
 * effects (offload / appendEntry) for a failed delete.
 *
 * R6M2: a rejected confirm (deleting the default preset) must return the
 * dialog to browse mode — not strand it in confirm mode where both Enter
 * and Esc are swallowed by the `if (!action) return` guard.
 */

vi.mock("../src/config.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config.ts")>();
  return { ...actual, writePresetsConfig: vi.fn() };
});

const writeMock = vi.mocked(writePresetsConfig);

interface RecordedNotify {
  message: string;
  level: string;
}

function makeFakeDialogCtx(cwd: string, notifyLog: RecordedNotify[]): ExtensionCommandContext {
  return {
    ui: {
      notify: (message: string, level?: string) => {
        notifyLog.push({ message, level: level ?? "info" });
      },
      select: async () => undefined,
      confirm: async () => false,
      custom: async (factory: (...args: unknown[]) => unknown) => {
        factory(
          { requestRender: () => {} },
          new Proxy({}, { get: () => (s: string) => s }),
          { matches: () => false },
          () => {},
        );
      },
    },
    hasUI: true,
    cwd,
    getSystemPromptOptions: () => ({ skills: [] }),
  } as unknown as ExtensionCommandContext;
}

function makeFakePi(entries: { action: string; preset: string }[] = []): ExtensionAPI {
  return {
    appendEntry: (_type: string, value: { action: string; preset: string }) => {
      entries.push(value);
    },
  } as unknown as ExtensionAPI;
}

async function buildDialog(
  cwd: string,
  config: PresetsConfig,
  opts: { notifyLog: RecordedNotify[]; entries?: { action: string; preset: string }[]; getDefaultPreset?: () => string | undefined },
): Promise<Record<string, (...args: unknown[]) => unknown> & { handleInput: (data: string) => void }> {
  let dialog: unknown;
  const ctx = makeFakeDialogCtx(cwd, opts.notifyLog);
  const captureCtx = {
    ...ctx,
    ui: {
      ...ctx.ui,
      custom: async (factory: (...args: unknown[]) => unknown) => {
        dialog = factory(
          { requestRender: () => {} },
          new Proxy({}, { get: () => (s: string) => s }),
          { matches: () => false },
          () => {},
        );
      },
    },
  } as unknown as ExtensionCommandContext;
  await showPresetDialog(captureCtx, makeFakePi(opts.entries), new PresetState(), config, opts.getDefaultPreset);
  return dialog as never;
}

describe("saveConfig write-failure retry path (ocr R6M1)", () => {
  it("addSkill: notify error + edit rolled back + retrying the original add succeeds", async () => {
    const realWrite = await vi.importActual<typeof import("../src/config.ts")>(
      "../src/config.ts",
    ).then((m) => m.writePresetsConfig);

    const cwd = mkdtempSync(join(tmpdir(), "preset-dialog-save-"));
    const agentDir = mkdtempSync(join(tmpdir(), "preset-dialog-agent-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ presets: { definitions: { base: { skills: ["one"] } } } }, null, 2),
    );

    const config = readPresetsConfig(cwd);
    const notifyLog: RecordedNotify[] = [];
    const dialog = await buildDialog(cwd, config, { notifyLog });
    const d = dialog as unknown as {
      addSkillToPreset: (preset: string, skill: string) => void;
    };
    expect(d).toBeTruthy();

    // First save fails on disk.
    writeMock.mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    d.addSkillToPreset("base", "two");

    // User was told, with the preset name and the reason.
    expect(notifyLog.some((n) => n.level === "error" && n.message.includes("base") && n.message.includes("disk full"))).toBe(true);
    // Local edit rolled back: retrying the original action is possible.
    expect(config.definitions.base.skills).toEqual(["one"]);
    expect(() => readFileSync(join(agentDir, "settings.json"), "utf-8")).toThrow(); // nothing written

    // Retry the SAME action — must not hit the "already added" guard.
    writeMock.mockImplementation(realWrite);
    d.addSkillToPreset("base", "two");
    expect(config.definitions.base.skills).toEqual(["one", "two"]);
    const written2 = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
    expect(written2.presets.definitions.base.skills).toEqual(["one", "two"]);
  });

  it("deletePreset: failed save commits no offload/entry and keeps the preset retryable", async () => {
    const realWrite = await vi.importActual<typeof import("../src/config.ts")>(
      "../src/config.ts",
    ).then((m) => m.writePresetsConfig);

    const cwd = mkdtempSync(join(tmpdir(), "preset-dialog-del-"));
    const agentDir = mkdtempSync(join(tmpdir(), "preset-dialog-agent2-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ presets: { definitions: { base: { skills: ["one"] } } } }, null, 2),
    );

    const config = readPresetsConfig(cwd);
    const state = new PresetState();
    state.load("base"); // active preset: a successful delete must offload it
    const entries: { action: string; preset: string }[] = [];
    const notifyLog: RecordedNotify[] = [];
    let dialog: unknown;
    const ctx = makeFakeDialogCtx(cwd, notifyLog);
    const captureCtx = {
      ...ctx,
      ui: {
        ...ctx.ui,
        custom: async (factory: (...args: unknown[]) => unknown) => {
          dialog = factory(
            { requestRender: () => {} },
            new Proxy({}, { get: () => (s: string) => s }),
            { matches: () => false },
            () => {},
          );
        },
      },
    } as unknown as ExtensionCommandContext;
    await showPresetDialog(captureCtx, makeFakePi(entries), state, config);
    const d = dialog as { deletePreset: (name: string) => void };
    expect(d).toBeTruthy();

    writeMock.mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    d.deletePreset("base");

    expect(notifyLog.some((n) => n.level === "error" && n.message.includes("base"))).toBe(true);
    // Session side effects NOT committed on failed save.
    expect(state.has("base")).toBe(true);
    expect(entries).toHaveLength(0);
    // Local state rolled back so retrying works.
    expect(config.definitions.base).toBeDefined();

    writeMock.mockImplementation(realWrite);
    d.deletePreset("base");
    expect(config.definitions.base).toBeUndefined();
    expect(state.has("base")).toBe(false);
    expect(entries.map((e) => ({ action: e.action, preset: e.preset }))).toEqual([
      { action: "offload", preset: "base" },
    ]);
  });

  it("confirmNewPreset: failed save frees the name for retry", async () => {
    const realWrite = await vi.importActual<typeof import("../src/config.ts")>(
      "../src/config.ts",
    ).then((m) => m.writePresetsConfig);

    const cwd = mkdtempSync(join(tmpdir(), "preset-dialog-new-"));
    const agentDir = mkdtempSync(join(tmpdir(), "preset-dialog-agent3-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ presets: {} }));

    const config = readPresetsConfig(cwd);
    const notifyLog: RecordedNotify[] = [];
    const dialog = await buildDialog(cwd, config, { notifyLog });
    const d = dialog as unknown as {
      nameInput: { setValue: (v: string) => void };
      confirmNewPreset: () => void;
    };

    writeMock.mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    d.nameInput.setValue("fresh");
    d.confirmNewPreset();

    expect(notifyLog.some((n) => n.level === "error" && n.message.includes("fresh"))).toBe(true);
    expect(config.definitions.fresh).toBeUndefined();

    writeMock.mockImplementation(realWrite);
    d.confirmNewPreset(); // same name again — must not hit "already exists"
    expect(config.definitions.fresh).toEqual({ skills: [] });
  });
});

describe("confirm-mode recovery (ocr R6M2)", () => {
  it("confirming delete of the default preset returns to browse and stays operable", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "preset-dialog-confirm-"));
    const agentDir = mkdtempSync(join(tmpdir(), "preset-dialog-agent4-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ presets: { default: "base", definitions: { base: { skills: ["one"] } } } }),
    );

    const config = readPresetsConfig(cwd);
    const notifyLog: RecordedNotify[] = [];
    let doneCalled = false;
    let dialog: unknown;
    const ctx = makeFakeDialogCtx(cwd, notifyLog);
    const captureCtx = {
      ...ctx,
      ui: {
        ...ctx.ui,
        custom: async (factory: (...args: unknown[]) => unknown) => {
          dialog = factory(
            { requestRender: () => {} },
            new Proxy({}, { get: () => (s: string) => s }),
            { matches: () => false },
            () => {
              doneCalled = true;
            },
          );
        },
      },
    } as unknown as ExtensionCommandContext;
    await showPresetDialog(captureCtx, makeFakePi(), new PresetState(), config, () => "base");
    const d = dialog as { handleInput: (data: string) => void; mode?: string };
    expect(d).toBeTruthy();

    // Real key path: browse 'd' on the (only, default) preset → confirm mode.
    d.handleInput("d");
    expect(d.mode).toBe("confirm");

    // Enter → delete rejected (default is protected) → back to browse.
    d.handleInput("\r");
    expect(d.mode).toBe("browse");
    expect(notifyLog.some((n) => n.level === "warning" && n.message.includes("default"))).toBe(true);

    // Dialog is still operable: Esc in browse closes it (would be swallowed
    // by `if (!action) return` if the dialog were stuck in confirm mode).
    d.handleInput("\x1b");
    expect(doneCalled).toBe(true);
  });

  it("successful delete via confirm also lands in browse mode", async () => {
    const realWrite = await vi.importActual<typeof import("../src/config.ts")>(
      "../src/config.ts",
    ).then((m) => m.writePresetsConfig);
    writeMock.mockImplementation(realWrite);

    const cwd = mkdtempSync(join(tmpdir(), "preset-dialog-confirm2-"));
    const agentDir = mkdtempSync(join(tmpdir(), "preset-dialog-agent5-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ presets: { definitions: { base: { skills: ["one"] } } } }),
    );

    const config = readPresetsConfig(cwd);
    const notifyLog: RecordedNotify[] = [];
    let dialog: unknown;
    const ctx = makeFakeDialogCtx(cwd, notifyLog);
    const captureCtx = {
      ...ctx,
      ui: {
        ...ctx.ui,
        custom: async (factory: (...args: unknown[]) => unknown) => {
          dialog = factory(
            { requestRender: () => {} },
            new Proxy({}, { get: () => (s: string) => s }),
            { matches: () => false },
            () => {},
          );
        },
      },
    } as unknown as ExtensionCommandContext;
    await showPresetDialog(captureCtx, makeFakePi(), new PresetState(), config, () => undefined);
    const d = dialog as { handleInput: (data: string) => void; mode?: string };

    d.handleInput("d");
    expect(d.mode).toBe("confirm");
    d.handleInput("\r");
    expect(d.mode).toBe("browse");
    expect(config.definitions.base).toBeUndefined();
  });
});
