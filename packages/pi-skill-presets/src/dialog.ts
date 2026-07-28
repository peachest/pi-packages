/**
 * Preset manager TUI dialog.
 *
 * Follows the ExtensionSelectorComponent pattern from pi core:
 * Extends Container directly, uses keybindings for input handling.
 *
 * Modes:
 * - browse: preset list (toggle load, 'e' edit, 'n' new)
 * - preset-edit: view/edit a preset's skills (add, remove, delete preset)
 * - skill-list: pick a skill to add to the preset being edited
 * - new-preset: input field for new preset name
 */

import {
  Container,
  getKeybindings,
  Input,
  Key,
  matchesKey,
  Spacer,
  Text,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import type { ExtensionContext, ExtensionAPI, Theme, Skill } from "@earendil-works/pi-coding-agent";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import type { PresetState } from "./preset-state.ts";
import type { PresetsConfig, PresetOpEntry } from "./types.ts";
import { getPresetSkills, writePresetsConfig, getAgentDir } from "./config.ts";
import { PRESET_OP_CUSTOM_TYPE } from "./commands.ts";

type DialogMode = "browse" | "preset-edit" | "skill-list" | "new-preset";

export async function showPresetDialog(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  state: PresetState,
  config: PresetsConfig,
  defaultPreset?: string,
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("/preset requires interactive mode", "warning");
    return;
  }

  await ctx.ui.custom<void>((tui, theme, _kb, done) => {
    return new PresetDialog(ctx, pi, state, config, theme, tui, done, defaultPreset);
  }, {
    overlay: true,
    overlayOptions: {
      anchor: "center",
      width: "70%",
      maxHeight: "70%",
    },
  });
}

class PresetDialog extends Container {
  private readonly ctx: ExtensionContext;
  private readonly pi: ExtensionAPI;
  private readonly theme: Theme;
  private readonly tui: TUI;
  private readonly done: (result: void) => void;
  private readonly state: PresetState;
  private config: PresetsConfig;
  private readonly defaultPreset?: string;
  private readonly cwd: string;

  // Navigation state
  private mode: DialogMode = "browse";
  private browseIndex = 0;
  private editPresetName: string | null = null;
  private editSkillIndex = 0;
  private skillListIndex = 0;
  private allSkills: Skill[] = [];
  private skillListLoaded = false;
  private readonly nameInput = new Input();
  private listContainer: Container;

  constructor(
    ctx: ExtensionContext,
    pi: ExtensionAPI,
    state: PresetState,
    config: PresetsConfig,
    theme: Theme,
    tui: TUI,
    done: (result: void) => void,
    defaultPreset: string | undefined,
  ) {
    super();
    this.ctx = ctx;
    this.pi = pi;
    this.state = state;
    this.config = config;
    this.theme = theme;
    this.tui = tui;
    this.done = done;
    this.defaultPreset = defaultPreset;
    this.cwd = ctx.cwd;

    this.nameInput.onSubmit = () => this.confirmNewPreset();
    this.nameInput.onEscape = () => {
      this.mode = "browse";
      this.renderMode();
      this.tui.requestRender();
    };

    this.listContainer = new Container();
    this.addChild(new Spacer(1));
    this.addChild(this.listContainer);
    this.addChild(new Spacer(1));

    this.renderMode();
  }

  // --- Helpers ---

  private get presetNames(): string[] {
    return Object.keys(this.config.definitions);
  }

  private saveConfig(): void {
    writePresetsConfig(this.config, "global");
  }

  private loadAllSkills(): void {
    if (this.skillListLoaded) return;
    const agentDir = getAgentDir();
    const loadResult = loadSkills({
      cwd: this.cwd,
      agentDir,
      skillPaths: [],
      includeDefaults: true,
    });
    this.allSkills = loadResult.skills;
    this.skillListLoaded = true;
  }

  private truncate(text: string, max: number): string {
    return truncateToWidth(text, max, "…");
  }

  // --- Rendering ---

  private renderMode(): void {
    this.listContainer.clear();

    switch (this.mode) {
      case "browse":
        this.renderBrowse();
        break;
      case "preset-edit":
        this.renderPresetEdit();
        break;
      case "skill-list":
        this.renderSkillList();
        break;
      case "new-preset":
        this.renderNewPreset();
        break;
    }
  }

  private renderBrowse(): void {
    this.listContainer.addChild(new Text(
      this.theme.fg("accent", this.theme.bold("Presets")),
      1, 0,
    ));
    this.listContainer.addChild(new Spacer(1));

    const names = this.presetNames;
    if (names.length === 0) {
      this.listContainer.addChild(new Text(
        this.theme.fg("dim", "No presets defined. Press 'n' to create one."),
        1, 0,
      ));
    } else {
      for (let i = 0; i < names.length; i++) {
        const name = names[i]!;
        const isSelected = i === this.browseIndex;
        const loaded = this.state.has(name);
        const isDefault = name === this.defaultPreset;

        const parts: string[] = [];
        parts.push(isSelected ? this.theme.fg("accent", "→ ") : "  ");
        parts.push(name);
        parts.push(loaded
          ? " " + this.theme.fg("success", "[loaded]")
          : " " + this.theme.fg("dim", "[─]"));
        if (isDefault) parts.push(" " + this.theme.fg("accent", "★"));

        const skills = getPresetSkills(this.config, name) ?? [];
        parts.push(this.theme.fg("dim", ` (${skills.length})`));

        this.listContainer.addChild(new Text(parts.join(""), 1, 0));
      }
    }

    this.listContainer.addChild(new Spacer(1));
    this.listContainer.addChild(new Text(
      this.theme.fg("dim", "↑↓ navigate  Space toggle  e edit  n new  Esc quit"),
      1, 0,
    ));
  }

  private renderPresetEdit(): void {
    const name = this.editPresetName;
    if (!name) return;

    this.listContainer.addChild(new Text(
      this.theme.fg("accent", this.theme.bold(`Edit: ${name}`)),
      1, 0,
    ));

    const isDefault = name === this.defaultPreset;
    if (isDefault) {
      this.listContainer.addChild(new Text(
        this.theme.fg("accent", "★ default preset"),
        1, 0,
      ));
    }
    this.listContainer.addChild(new Spacer(1));

    const skills = getPresetSkills(this.config, name) ?? [];
    if (skills.length === 0) {
      this.listContainer.addChild(new Text(
        this.theme.fg("dim", "No skills in this preset. Press 'a' to add."),
        1, 0,
      ));
    } else {
      this.listContainer.addChild(new Text(
        this.theme.fg("muted", this.theme.bold(`Skills (${skills.length}):`)),
        1, 0,
      ));
      this.listContainer.addChild(new Spacer(1));

      for (let i = 0; i < skills.length; i++) {
        const skillName = skills[i]!;
        const isSelected = i === this.editSkillIndex;
        const prefix = isSelected ? this.theme.fg("accent", "→ ") : "  ";

        // Find skill description if available
        const desc = this.getSkillDescription(skillName);
        const descText = desc
          ? this.theme.fg("dim", ` — ${this.truncate(desc, 50)}`)
          : this.theme.fg("warning", " (not found)");

        this.listContainer.addChild(new Text(
          `${prefix}${skillName}${descText}`,
          1, 0,
        ));
      }
    }

    this.listContainer.addChild(new Spacer(1));
    this.listContainer.addChild(new Text(
      this.theme.fg("dim", "↑↓ navigate  a add skill  ⌫ remove  d delete preset  Esc back"),
      1, 0,
    ));
  }

  private renderSkillList(): void {
    this.loadAllSkills();

    this.listContainer.addChild(new Text(
      this.theme.fg("accent", this.theme.bold(`Add skill to: ${this.editPresetName}`)),
      1, 0,
    ));
    this.listContainer.addChild(new Spacer(1));

    const currentSkills = new Set(getPresetSkills(this.config, this.editPresetName!) ?? []);

    if (this.allSkills.length === 0) {
      this.listContainer.addChild(new Text(
        this.theme.fg("dim", "No skills available."),
        1, 0,
      ));
    } else {
      for (let i = 0; i < this.allSkills.length; i++) {
        const skill = this.allSkills[i]!;
        const isSelected = i === this.skillListIndex;
        const alreadyAdded = currentSkills.has(skill.name);

        const prefix = isSelected ? this.theme.fg("accent", "→ ") : "  ";
        const name = alreadyAdded
          ? this.theme.fg("success", `${skill.name} ✓`)
          : skill.name;
        const desc = this.theme.fg("dim", ` — ${this.truncate(skill.description, 45)}`);

        this.listContainer.addChild(new Text(
          `${prefix}${name}${desc}`,
          1, 0,
        ));
      }
    }

    this.listContainer.addChild(new Spacer(1));
    this.listContainer.addChild(new Text(
      this.theme.fg("dim", "↑↓ navigate  Enter add  Esc back"),
      1, 0,
    ));
  }

  private renderNewPreset(): void {
    this.listContainer.addChild(new Text(
      this.theme.fg("accent", this.theme.bold("New Preset")),
      1, 0,
    ));
    this.listContainer.addChild(new Spacer(1));
    this.listContainer.addChild(new Text(
      this.theme.fg("dim", "Enter preset name (lowercase letters, numbers, hyphens):"),
      1, 0,
    ));
    this.listContainer.addChild(new Spacer(1));
    // Input renders itself
    this.listContainer.addChild(this.nameInput);
    this.listContainer.addChild(new Spacer(1));
    this.listContainer.addChild(new Text(
      this.theme.fg("dim", "Enter create  Esc cancel"),
      1, 0,
    ));
  }

  private getSkillDescription(skillName: string): string | undefined {
    this.loadAllSkills();
    const skill = this.allSkills.find((s) => s.name === skillName);
    return skill?.description;
  }

  // --- Input handling ---

  handleInput(data: string): void {
    switch (this.mode) {
      case "browse":
        this.handleBrowseInput(data);
        break;
      case "preset-edit":
        this.handlePresetEditInput(data);
        break;
      case "skill-list":
        this.handleSkillListInput(data);
        break;
      case "new-preset":
        this.handleNewPresetInput(data);
        break;
    }
  }

  private handleBrowseInput(data: string): void {
    const kb = getKeybindings();
    const len = this.presetNames.length;

    if (kb.matches(data, "tui.select.up")) {
      this.browseIndex = this.browseIndex === 0 ? Math.max(0, len - 1) : this.browseIndex - 1;
      this.renderMode();
      this.tui.requestRender();
      return;
    }

    if (kb.matches(data, "tui.select.down")) {
      this.browseIndex = len === 0 ? 0 : (this.browseIndex + 1) % len;
      this.renderMode();
      this.tui.requestRender();
      return;
    }

    if (kb.matches(data, "tui.select.confirm") || matchesKey(data, Key.space) || matchesKey(data, Key.enter)) {
      const name = this.presetNames[this.browseIndex];
      if (name) this.togglePreset(name);
      return;
    }

    // 'e' — edit preset
    if (data === "e") {
      const name = this.presetNames[this.browseIndex];
      if (name) {
        this.editPresetName = name;
        this.editSkillIndex = 0;
        this.mode = "preset-edit";
        this.renderMode();
        this.tui.requestRender();
      }
      return;
    }

    // 'n' — new preset
    if (data === "n") {
      this.nameInput.setValue("");
      this.mode = "new-preset";
      this.renderMode();
      this.tui.requestRender();
      return;
    }

    if (kb.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape)) {
      this.done();
      return;
    }
  }

  private handlePresetEditInput(data: string): void {
    const kb = getKeybindings();
    const name = this.editPresetName;
    if (!name) return;

    const skills = getPresetSkills(this.config, name) ?? [];
    const len = skills.length;

    if (kb.matches(data, "tui.select.up")) {
      this.editSkillIndex = this.editSkillIndex === 0 ? Math.max(0, len - 1) : this.editSkillIndex - 1;
      this.renderMode();
      this.tui.requestRender();
      return;
    }

    if (kb.matches(data, "tui.select.down")) {
      this.editSkillIndex = len === 0 ? 0 : (this.editSkillIndex + 1) % len;
      this.renderMode();
      this.tui.requestRender();
      return;
    }

    // 'a' — add skill
    if (data === "a") {
      this.skillListIndex = 0;
      this.mode = "skill-list";
      this.renderMode();
      this.tui.requestRender();
      return;
    }

    // Backspace — remove selected skill
    if (matchesKey(data, Key.backspace) && len > 0) {
      this.removeSkillFromPreset(name, this.editSkillIndex);
      return;
    }

    // 'd' — delete preset
    if (data === "d") {
      this.deletePreset(name);
      return;
    }

    if (kb.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape)) {
      this.mode = "browse";
      this.renderMode();
      this.tui.requestRender();
      return;
    }
  }

  private handleSkillListInput(data: string): void {
    const kb = getKeybindings();
    this.loadAllSkills();
    const len = this.allSkills.length;

    if (kb.matches(data, "tui.select.up")) {
      this.skillListIndex = this.skillListIndex === 0 ? Math.max(0, len - 1) : this.skillListIndex - 1;
      this.renderMode();
      this.tui.requestRender();
      return;
    }

    if (kb.matches(data, "tui.select.down")) {
      this.skillListIndex = len === 0 ? 0 : (this.skillListIndex + 1) % len;
      this.renderMode();
      this.tui.requestRender();
      return;
    }

    if (kb.matches(data, "tui.select.confirm") || matchesKey(data, Key.enter)) {
      const skill = this.allSkills[this.skillListIndex];
      if (skill && this.editPresetName) {
        this.addSkillToPreset(this.editPresetName, skill.name);
      }
      return;
    }

    if (kb.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape)) {
      this.mode = "preset-edit";
      this.renderMode();
      this.tui.requestRender();
      return;
    }
  }

  private handleNewPresetInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.mode = "browse";
      this.renderMode();
      this.tui.requestRender();
      return;
    }
    // Let Input handle the keystroke
    this.nameInput.handleInput(data);
    // Input.onSubmit triggers confirmNewPreset
    this.tui.requestRender();
  }

  // --- Actions ---

  private togglePreset(name: string): void {
    if (this.state.has(name)) {
      this.state.offload(name);
      this.pi.appendEntry<PresetOpEntry>(PRESET_OP_CUSTOM_TYPE, {
        action: "offload",
        preset: name,
        timestamp: Date.now(),
      });
      this.ctx.ui.notify(`Offloaded preset "${name}".`, "info");
    } else {
      this.state.load(name);
      this.pi.appendEntry<PresetOpEntry>(PRESET_OP_CUSTOM_TYPE, {
        action: "load",
        preset: name,
        timestamp: Date.now(),
      });
      this.ctx.ui.notify(`Loaded preset "${name}".`, "info");
    }
    this.renderMode();
    this.tui.requestRender();
  }

  private addSkillToPreset(presetName: string, skillName: string): void {
    const def = this.config.definitions[presetName];
    if (!def) return;

    if (def.skills.includes(skillName)) {
      this.ctx.ui.notify(`Skill "${skillName}" is already in preset "${presetName}".`, "info");
      return;
    }

    def.skills.push(skillName);
    this.saveConfig();
    this.ctx.ui.notify(`Added "${skillName}" to preset "${presetName}".`, "info");

    // Stay in skill-list for more additions, but update view
    this.renderMode();
    this.tui.requestRender();
  }

  private removeSkillFromPreset(presetName: string, skillIndex: number): void {
    const def = this.config.definitions[presetName];
    if (!def || skillIndex < 0 || skillIndex >= def.skills.length) return;

    const removed = def.skills.splice(skillIndex, 1)[0];
    this.saveConfig();
    this.ctx.ui.notify(`Removed "${removed}" from preset "${presetName}".`, "info");

    // Adjust index
    const len = def.skills.length;
    if (this.editSkillIndex >= len && len > 0) {
      this.editSkillIndex = len - 1;
    }

    this.renderMode();
    this.tui.requestRender();
  }

  private deletePreset(presetName: string): void {
    delete this.config.definitions[presetName];

    // If it was the default, clear default
    if (this.config.default === presetName) {
      this.config.default = undefined;
    }

    // Offload if loaded
    if (this.state.has(presetName)) {
      this.state.offload(presetName);
      this.pi.appendEntry<PresetOpEntry>(PRESET_OP_CUSTOM_TYPE, {
        action: "offload",
        preset: presetName,
        timestamp: Date.now(),
      });
    }

    this.saveConfig();
    this.ctx.ui.notify(`Deleted preset "${presetName}".`, "info");

    // Go back to browse
    this.mode = "browse";
    this.browseIndex = Math.min(this.browseIndex, Math.max(0, this.presetNames.length - 1));
    this.renderMode();
    this.tui.requestRender();
  }

  private confirmNewPreset(): void {
    const name = this.nameInput.getValue().trim();
    if (!name) {
      this.ctx.ui.notify("Preset name cannot be empty.", "error");
      return;
    }

    if (this.config.definitions[name]) {
      this.ctx.ui.notify(`Preset "${name}" already exists.`, "error");
      return;
    }

    // Validate name (lowercase, numbers, hyphens)
    if (!/^[a-z0-9-]+$/.test(name)) {
      this.ctx.ui.notify("Name must contain only lowercase letters, numbers, and hyphens.", "error");
      return;
    }

    this.config.definitions[name] = { skills: [] };
    this.saveConfig();
    this.ctx.ui.notify(`Created preset "${name}".`, "info");

    // Go to preset-edit mode for the new preset
    this.editPresetName = name;
    this.editSkillIndex = 0;
    this.mode = "preset-edit";
    this.renderMode();
    this.tui.requestRender();
  }
}
