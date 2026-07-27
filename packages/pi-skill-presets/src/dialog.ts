/**
 * Preset manager TUI dialog.
 *
 * Modeled after pi-skills-manager's dialog pattern:
 * - Uses ctx.ui.custom() with a Focusable component
 * - Up/Down to navigate, Enter to toggle load/offload
 * - Shows loaded/default status per preset
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PresetState } from "./preset-state.ts";
import type { PresetsConfig } from "./types.ts";
import { getPresetSkills } from "./config.ts";

// Import pi-tui primitives — resolved from pi-coding-agent's nested dependency
import { Container, Key, matchesKey, Spacer, Text } from "@earendil-works/pi-tui";
import type { Focusable, TUI, Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

export async function showPresetDialog(
  ctx: ExtensionContext,
  state: PresetState,
  config: PresetsConfig,
  defaultPreset?: string,
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("/preset requires interactive mode", "warning");
    return;
  }

  await ctx.ui.custom<void>((tui, theme, _kb, done) => {
    const dialog = new PresetDialog(ctx, state, config, theme, tui, done, defaultPreset);
    const component: Component & Focusable = {
      get focused() { return dialog.focused; },
      set focused(value: boolean) { dialog.focused = value; },
      render(width: number) { return dialog.render(width); },
      invalidate() { /* no-op */ },
      handleInput(data: string) { dialog.handleInput(data); tui.requestRender(); },
    };
    return component;
  }, {
    overlay: true,
    overlayOptions: {
      anchor: "center",
      width: 60,
      maxHeight: 20,
    },
  });
}

class PresetDialog implements Focusable {
  private readonly ctx: ExtensionContext;
  private readonly theme: Theme;
  private readonly tui: TUI;
  private readonly done: () => void;
  private readonly state: PresetState;
  private readonly config: PresetsConfig;
  private readonly defaultPreset?: string;
  private readonly requestRender: () => void;
  private _focused = false;
  private selectedIndex = 0;

  constructor(
    ctx: ExtensionContext,
    state: PresetState,
    config: PresetsConfig,
    theme: Theme,
    tui: TUI,
    done: () => void,
    defaultPreset: string | undefined,
  ) {
    this.ctx = ctx;
    this.state = state;
    this.config = config;
    this.theme = theme;
    this.tui = tui;
    this.done = done;
    this.defaultPreset = defaultPreset;
    this.requestRender = () => tui.requestRender();
  }

  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; }

  private get presetNames(): string[] {
    return Object.keys(this.config.definitions);
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 4);
    const root = new Container();

    // Title
    root.addChild(new Text(this.theme.fg("text", this.theme.bold("Presets")), 1, 0));
    root.addChild(new Spacer(1));

    const presetNames = this.presetNames;

    if (presetNames.length === 0) {
      root.addChild(new Text(this.theme.fg("dim", "No presets defined."), 1, 0));
      root.addChild(new Text(this.theme.fg("dim", "Add presets to settings.json:"), 1, 0));
      root.addChild(new Text(this.theme.fg("dim", '  "presets": { "definitions": { ... } }'), 1, 0));
    } else {
      // Preset list
      for (let i = 0; i < presetNames.length; i++) {
        const name = presetNames[i]!;
        const isSelected = i === this.selectedIndex;
        const loaded = this.state.has(name);
        const isDefault = name === this.defaultPreset;

        const markers: string[] = [];
        if (loaded) markers.push(this.theme.fg("success", "[loaded]"));
        else markers.push(this.theme.fg("dim", "[─]"));
        if (isDefault) markers.push(this.theme.fg("accent", "★default"));

        const skills = getPresetSkills(this.config, name) ?? [];
        const skillCount = this.theme.fg("dim", ` (${skills.length} skills)`);

        const line = ` ${name}  ${markers.join(" ")}${skillCount}`;
        if (isSelected) {
          root.addChild(new Text(this.theme.bg("selectedBg", this.padLine(line, innerWidth)), 1, 0));
        } else {
          root.addChild(new Text(line, 1, 0));
        }
      }
    }

    root.addChild(new Spacer(1));

    // Key hints
    const hints = this.theme.fg("dim", [
      "↑↓ navigate",
      "Enter toggle",
      "Esc quit",
    ].join("  "));
    root.addChild(new Text(hints, 1, 0));

    return this.renderFrame(width, root.render(innerWidth));
  }

  private padLine(text: string, width: number): string {
    const visibleLen = text.replace(/\x1b\[[0-9;]*m/g, "").length;
    return text + " ".repeat(Math.max(0, width - visibleLen));
  }

  private renderFrame(width: number, lines: string[]): string[] {
    const innerWidth = Math.max(1, width - 4);
    const v = "│";
    const h = "─";
    return [
      this.theme.fg("borderAccent", `┌${h.repeat(innerWidth + 2)}┐`),
      ...lines.map((line) => `${this.theme.fg("borderAccent", `${v} `)}${line}${this.theme.fg("borderAccent", ` ${v}`)}`),
      this.theme.fg("borderAccent", `└${h.repeat(innerWidth + 2)}┘`),
    ];
  }

  handleInput(data: string): void {
    const presetNames = this.presetNames;

    if (matchesKey(data, Key.up)) {
      this.selectedIndex = this.selectedIndex === 0
        ? Math.max(0, presetNames.length - 1)
        : this.selectedIndex - 1;
      this.requestRender();
      return;
    }

    if (matchesKey(data, Key.down)) {
      this.selectedIndex = presetNames.length === 0
        ? 0
        : (this.selectedIndex + 1) % presetNames.length;
      this.requestRender();
      return;
    }

    if (matchesKey(data, Key.enter) && presetNames.length > 0) {
      const name = presetNames[this.selectedIndex];
      if (!name) return;
      this.togglePreset(name);
      return;
    }

    if (matchesKey(data, Key.escape)) {
      this.done();
      return;
    }
  }

  private togglePreset(name: string): void {
    if (this.state.has(name)) {
      this.state.offload(name);
      this.ctx.ui.notify(`Offloaded preset "${name}".`, "info");
    } else {
      this.state.load(name);
      this.ctx.ui.notify(`Loaded preset "${name}".`, "info");
    }
    this.requestRender();
  }
}
