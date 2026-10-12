import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { showPresetDialog, PresetState, readPresetsConfig } from "../index.ts";
import { writePresetsConfig } from "../src/config.ts";
import type { PresetsConfig } from "../index.ts";

/**
 * saveConfig baseline-refresh timing (ocr R5M4): a failed writePresetsConfig
 * must not refresh this.config/originalDefinitions — the pending edits stay
 * queued so a retry merges and writes them.
 */

vi.mock("../src/config.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config.ts")>();
  return { ...actual, writePresetsConfig: vi.fn() };
});

const writeMock = vi.mocked(writePresetsConfig);

function makeFakeDialogCtx(cwd: string): ExtensionCommandContext {
  return {
    ui: {
      notify: () => {},
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

function makeFakePi(): ExtensionAPI {
  return { appendEntry: () => {} } as unknown as ExtensionAPI;
}

describe("saveConfig write-failure baseline retention (ocr R5M4)", () => {
  it("keeps edits mergeable for retry when the first write throws", async () => {
    const realWrite = await vi.importActual<typeof import("../src/config.ts")>(
      "../src/config.ts",
    ).then((m) => m.writePresetsConfig);

    // Project settings on disk: one preset "base" with skill "one".
    const cwd = mkdtempSync(join(tmpdir(), "preset-dialog-save-"));
    const agentDir = mkdtempSync(join(tmpdir(), "preset-dialog-agent-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ presets: { definitions: { base: { skills: ["one"] } } } }, null, 2),
    );

    const config: PresetsConfig = readPresetsConfig(cwd);
    const state = new PresetState();
    let dialog: unknown;
    const ctx = makeFakeDialogCtx(cwd);
    // dialog.test.ts pattern: ui.custom's factory builds the component
    // synchronously; capture it to reach the private save paths.
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
    await showPresetDialog(captureCtx, makeFakePi(), state, config);
    const d = dialog as {
      addSkillToPreset: (preset: string, skill: string) => void;
    };
    expect(d).toBeTruthy();

    // First save fails on disk.
    writeMock.mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    expect(() => d.addSkillToPreset("base", "two")).toThrow("disk full");

    // Retry: the previous edit ("two") must still be merged and written.
    writeMock.mockImplementation(realWrite);
    d.addSkillToPreset("base", "three");

    const written = JSON.parse(
      readFileSync(join(agentDir, "settings.json"), "utf-8"),
    );
    expect(written.presets.definitions.base.skills).toEqual(["one", "two", "three"]);
  });
});
