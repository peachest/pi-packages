/**
 * Preset manager TUI dialog.
 *
 * Follows the ExtensionSelectorComponent pattern from pi core:
 * Extends Container directly, uses keybindings for input handling.
 */

import {
  Container,
  getKeybindings,
  Key,
  matchesKey,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { PresetState } from "./preset-state.ts";
import type { PresetsConfig } from "./types.ts";
import { getPresetSkills } from "./config.ts";

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
    return new PresetDialog(ctx, state, config, theme, tui, done, defaultPreset);
  }, {
    overlay: true,
    overlayOptions: {
      anchor: "center",
      width: "60%",
      maxHeight: "50%",
    },
  });
}

class PresetDialog extends Container {
  private readonly ctx: ExtensionContext;
  private readonly theme: Theme;
  private readonly tui: TUI;
  private readonly done: (result: void) => void;
  private readonly state: PresetState;
  private readonly config: PresetsConfig;
  private readonly defaultPreset?: string;
  private selectedIndex = 0;
  private listContainer: Container;

  constructor(
    ctx: ExtensionContext,
    state: PresetState,
    config: PresetsConfig,
    theme: Theme,
    tui: TUI,
    done: (result: void) => void,
    defaultPreset: string | undefined,
  ) {
    super();
    this.ctx = ctx;
    this.state = state;
    this.config = config;
    this.theme = theme;
    this.tui = tui;
    this.done = done;
    this.defaultPreset = defaultPreset;

    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.fg("accent", theme.bold("Presets")), 1, 0));
    this.addChild(new Spacer(1));
    this.listContainer = new Container();
    this.addChild(this.listContainer);
    this.addChild(new Spacer(1));
    this.addChild(new Text(
      theme.fg("dim", "↑↓ navigate  Enter toggle  Esc quit"),
      1, 0,
    ));
    this.addChild(new Spacer(1));
    this.updateList();
  }

  private get presetNames(): string[] {
    return Object.keys(this.config.definitions);
  }

  private updateList(): void {
    this.listContainer.clear();
    const presetNames = this.presetNames;

    if (presetNames.length === 0) {
      this.listContainer.addChild(new Text(
        this.theme.fg("dim", "No presets defined."),
        1, 0,
      ));
      this.listContainer.addChild(new Text(
        this.theme.fg("dim", 'Add "presets" to settings.json'),
        1, 0,
      ));
      return;
    }

    for (let i = 0; i < presetNames.length; i++) {
      const name = presetNames[i]!;
      const isSelected = i === this.selectedIndex;
      const loaded = this.state.has(name);
      const isDefault = name === this.defaultPreset;

      const parts: string[] = [];
      if (isSelected) {
        parts.push(this.theme.fg("accent", "→ "));
      } else {
        parts.push("  ");
      }

      parts.push(name);

      if (loaded) {
        parts.push(" " + this.theme.fg("success", "[loaded]"));
      } else {
        parts.push(" " + this.theme.fg("dim", "[─]"));
      }
      if (isDefault) {
        parts.push(" " + this.theme.fg("accent", "★"));
      }

      const skills = getPresetSkills(this.config, name) ?? [];
      parts.push(this.theme.fg("dim", ` (${skills.length})`));

      this.listContainer.addChild(new Text(parts.join(""), 1, 0));
    }
  }

  handleInput(data: string): void {
    // Try keybindings first (matches pi core pattern)
    const kb = getKeybindings();
    if (kb.matches(data, "tui.select.up")) {
      this.selectedIndex = this.selectedIndex === 0
        ? Math.max(0, this.presetNames.length - 1)
        : this.selectedIndex - 1;
      this.updateList();
      this.tui.requestRender();
      return;
    }

    if (kb.matches(data, "tui.select.down")) {
      const len = this.presetNames.length;
      this.selectedIndex = len === 0 ? 0 : (this.selectedIndex + 1) % len;
      this.updateList();
      this.tui.requestRender();
      return;
    }

    if (kb.matches(data, "tui.select.confirm") || matchesKey(data, Key.enter)) {
      const name = this.presetNames[this.selectedIndex];
      if (name) this.togglePreset(name);
      return;
    }

    if (kb.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape)) {
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
    this.updateList();
    this.tui.requestRender();
  }
}
