import { describe, it, expect } from "vitest";
import { showPresetDialog, PresetState } from "../index.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { PresetOpEntry } from "../index.ts";

/**
 * Dialog bad-reference warning on load (ocr-F3): toggling a preset on in the
 * /preset dialog must warn about bad references exactly like /preset-load,
 * using the platform skill list from the dialog's own command context.
 *
 * The dialog component is captured by faking ctx.ui.custom and invoking the
 * factory synchronously; then the private togglePreset is exercised directly.
 */

function makeFakePi(): { pi: ExtensionAPI; entries: PresetOpEntry[] } {
  const entries: PresetOpEntry[] = [];
  const pi = {
    appendEntry: (_customType: string, data: PresetOpEntry) => {
      entries.push(data);
    },
  } as unknown as ExtensionAPI;
  return { pi, entries };
}

function makeFakeDialogCtx(platformSkills: string[]): {
  ctx: ExtensionCommandContext;
  notifications: Array<{ msg: string; type: string }>;
  capture: () => unknown;
} {
  const notifications: Array<{ msg: string; type: string }> = [];
  let component: unknown;
  const ctx = {
    ui: {
      notify: (msg: string, type?: string) => {
        notifications.push({ msg, type: type ?? "info" });
      },
      select: async () => undefined,
      confirm: async () => false,
      custom: async (factory: (...args: unknown[]) => unknown) => {
        // Fake tui/theme/keybindings/done — togglePreset only touches
        // ctx.ui.notify, pi.appendEntry and state.
        component = factory(
          { requestRender: () => {} },
          new Proxy({}, { get: () => (s: string) => s }),
          { matches: () => false },
          () => {},
        );
      },
    },
    hasUI: true,
    cwd: process.cwd(),
    getSystemPromptOptions: () => ({
      skills: platformSkills.map((name) => ({ name, description: "", filePath: "" })),
    }),
  } as unknown as ExtensionCommandContext;
  return { ctx, notifications, capture: () => component };
}

const config = {
  default: undefined,
  definitions: {
    ddd: { skills: ["domain-modeling", "ghost-skill"] },
  },
};

describe("dialog load bad-reference warning (ocr-F3)", () => {
  it("warns about bad references but still loads", async () => {
    const state = new PresetState();
    const { pi, entries } = makeFakePi();
    const fake = makeFakeDialogCtx(["domain-modeling"]);
    await showPresetDialog(fake.ctx, pi, state, config, undefined);

    const dialog = fake.capture() as { togglePreset: (name: string) => void };
    expect(dialog).toBeTruthy();
    dialog.togglePreset("ddd");

    const warn = fake.notifications.find((n) => n.type === "warning");
    expect(warn?.msg).toContain("ghost-skill");
    expect(warn?.msg).not.toContain("domain-modeling");
    expect(state.has("ddd")).toBe(true);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.action).toBe("load");
  });

  it("does not warn when all referenced skills are available", async () => {
    const state = new PresetState();
    const { pi } = makeFakePi();
    const fake = makeFakeDialogCtx(["domain-modeling", "ghost-skill"]);
    await showPresetDialog(fake.ctx, pi, state, config, undefined);

    const dialog = fake.capture() as { togglePreset: (name: string) => void };
    dialog.togglePreset("ddd");

    expect(fake.notifications.some((n) => n.type === "warning")).toBe(false);
    expect(state.has("ddd")).toBe(true);
  });

  it("rejects toggling the default preset (always-on, not in active set)", async () => {
    const state = new PresetState();
    const { pi, entries } = makeFakePi();
    const fake = makeFakeDialogCtx([]);
    await showPresetDialog(fake.ctx, pi, state, { ...config, default: "ddd" }, "ddd");

    const dialog = fake.capture() as { togglePreset: (name: string) => void };
    dialog.togglePreset("ddd");

    // Default must not enter the active set nor write a load entry (ocr-F1).
    expect(state.has("ddd")).toBe(false);
    expect(entries).toHaveLength(0);
    const warn = fake.notifications.find((n) => n.type === "warning");
    expect(warn?.msg).toContain("cannot be offloaded");
  });
});
