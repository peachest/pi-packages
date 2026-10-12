import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { showPresetDialog, PresetState, readPresetsConfig } from "../index.ts";
import { getGlobalSettingsPath } from "../src/config.ts";
import type { PresetsConfig } from "../index.ts";

/**
 * Confirm-callback error guard (ocr R8M): the confirm path executes its
 * callback on a live settings read (defaultPreset getter → readPresetsConfig).
 * If settings.json was corrupted after the dialog opened (legal JSON `null`
 * makes readPresetsConfig throw a TypeError), Enter must notify an error and
 * return the dialog to browse mode — not leave it stranded in confirm mode
 * with a cleared pendingConfirm (both Enter and Esc swallowed forever).
 */

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
        // Captured below via the wrapper in the test body.
      },
    },
    hasUI: true,
    cwd,
    getSystemPromptOptions: () => ({ skills: [] }),
  } as unknown as ExtensionCommandContext;
}

function makeFakePi(): ExtensionAPI {
  return {
    appendEntry: () => {},
  } as unknown as ExtensionAPI;
}

describe("confirm-callback error guard (ocr R8M)", () => {
  it("corrupt settings during confirm: notify error + dialog returns to browse", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "preset-dialog-guard-"));
    const agentDir = mkdtempSync(join(tmpdir(), "preset-dialog-guard-agent-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ presets: { definitions: { gone: { skills: ["one"] } } } }, null, 2),
    );

    const config: PresetsConfig = readPresetsConfig(cwd);
    expect(Object.keys(config.definitions)).toEqual(["gone"]);

    // Live getter like createCommands passes in: re-reads settings.json each call.
    const getDefaultPreset = () => readPresetsConfig(cwd).default;

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
    await showPresetDialog(captureCtx, makeFakePi(), new PresetState(), config, getDefaultPreset);
    const d = dialog as { handleInput: (data: string) => void; mode?: string };
    expect(d).toBeTruthy();

    // Corrupt the global settings after the dialog opened: legal JSON `null`
    // makes readPresetsConfig throw inside the live defaultPreset getter.
    writeFileSync(getGlobalSettingsPath(), "null", "utf-8");

    // Real key path: browse 'd' → confirm mode.
    d.handleInput("d");
    expect(d.mode).toBe("confirm");

    // Enter → onConfirm no longer throws on the corrupt read (ocr R9M: the
    // defaultPreset getter is guarded, so deletePreset reaches saveConfig,
    // whose existing catch notifies the failure and rolls back). Either way
    // the dialog must return to browse mode with an error notify.
    d.handleInput("\r");
    expect(d.mode).toBe("browse");
    const error = notifyLog.find((n) => n.level === "error");
    expect(error).toBeTruthy();
    expect(error!.message).toContain("Failed to save preset");
  });

  it("corrupt settings after confirm guard: real render degrades, Enter keeps working (ocr R9M)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "preset-dialog-guard-"));
    const agentDir = mkdtempSync(join(tmpdir(), "preset-dialog-guard-agent-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ presets: { definitions: { gone: { skills: ["one"] } } } }, null, 2),
    );

    const config: PresetsConfig = readPresetsConfig(cwd);
    const getDefaultPreset = () => readPresetsConfig(cwd).default;

    const notifyLog: RecordedNotify[] = [];
    let dialog: unknown;
    const ctx = makeFakeDialogCtx(cwd, notifyLog);
    const captureCtx = {
      ...ctx,
      ui: {
        ...ctx.ui,
        custom: async (factory: (...args: unknown[]) => unknown) => {
          dialog = factory(
            { requestRender: () => {}, terminal: { rows: 40, columns: 100 } },
            // theme.fg(style, text) must return the text, not just the style
            // name — the R9M error line asserts on its message content.
            new Proxy({}, { get: () => (...args: unknown[]) => args[args.length - 1] }),
            { matches: () => false },
            () => {},
          );
        },
      },
    } as unknown as ExtensionCommandContext;
    await showPresetDialog(captureCtx, makeFakePi(), new PresetState(), config, getDefaultPreset);
    const d = dialog as { handleInput: (data: string) => void; mode?: string; render: (width: number) => string[] };
    expect(d).toBeTruthy();

    writeFileSync(getGlobalSettingsPath(), "null", "utf-8");

    // Confirm guard restores browse mode (previous test covers the notify).
    d.handleInput("d");
    expect(d.mode).toBe("confirm");
    d.handleInput("\r");
    expect(d.mode).toBe("browse");

    // Real render path: buildBrowseLines must not throw on the corrupt read
    // (no requestRender mocking — this executes the actual line builder) and
    // must show the degraded error line.
    const frame = d.render(60);
    expect(frame.join("\n")).toContain("settings.json unreadable");

    // preset-edit render path degrades the same way.
    d.handleInput("e");
    expect(d.mode).toBe("preset-edit");
    const editFrame = d.render(60);
    expect(editFrame.join("\n")).toContain("settings.json unreadable");
    d.handleInput("\u001b"); // back to browse
    expect(d.mode).toBe("browse");

    // Enter-driven actions in the corrupted state: toggle goes through
    // togglePreset (default comparison safe), 'd' + Enter through the
    // deletePreset → saveConfig failure path. Neither may throw uncaught.
    expect(() => d.handleInput("\r")).not.toThrow();
    expect(() => d.handleInput("d")).not.toThrow();
    expect(d.mode).toBe("confirm");
    expect(() => d.handleInput("\r")).not.toThrow();
    expect(d.mode).toBe("browse");
    const saveError = notifyLog.find((n) => n.level === "error" && n.message.includes("Failed to save"));
    expect(saveError).toBeTruthy();
  });
});
