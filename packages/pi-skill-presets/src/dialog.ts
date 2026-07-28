/**
 * Preset manager TUI dialog.
 *
 * Follows the ExtensionSelectorComponent pattern from pi core,
 * with frame rendering and scrollable lists inspired by
 * @vanillagreen/pi-skills-manager.
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
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import type { ExtensionContext, ExtensionAPI, Theme, Skill } from "@earendil-works/pi-coding-agent";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import type { PresetState } from "./preset-state.ts";
import type { PresetsConfig, PresetOpEntry } from "./types.ts";
import { getPresetSkills, writePresetsConfig, getAgentDir } from "./config.ts";
import { PRESET_OP_CUSTOM_TYPE } from "./commands.ts";

type DialogMode = "browse" | "preset-edit" | "skill-list" | "new-preset";

// Frame glyphs (unicode)
const FRAME = {
  tl: "┏",
  tr: "┓",
  bl: "┗",
  br: "┛",
  h: "━",
  v: "┃",
};

/** Non-list overhead: top border + bottom border + title + spacer + footer + spacer */
const FRAME_OVERHEAD = 6;

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

/**
 * Calculate the scroll window for a list.
 * Returns startIndex and endIndex (exclusive) so only visible items are rendered.
 */
function scrollWindow(itemCount: number, selectedIndex: number, visibleRows: number): {
  startIndex: number;
  endIndex: number;
} {
  if (itemCount === 0) return { startIndex: 0, endIndex: 0 };
  const rows = Math.min(visibleRows, itemCount);
  const maxStart = Math.max(0, itemCount - rows);
  // Center the selected item in the window
  const startIndex = Math.max(0, Math.min(maxStart, selectedIndex - Math.floor(rows / 2)));
  return { startIndex, endIndex: startIndex + rows };
}

/** Pad a line to fill the frame width, with ANSI awareness. */
function padLine(text: string, width: number): string {
  const w = visibleWidth(text);
  if (w >= width) return truncateToWidth(text, width, "");
  return text + " ".repeat(width - w);
}

/** Render content lines inside a frame border. */
function renderFrame(
  theme: Theme,
  width: number,
  lines: string[],
  title?: string,
): string[] {
  const innerWidth = Math.max(1, width - 4); // 2 border chars + 2 spaces
  const result: string[] = [];

  // Top border with optional title
  if (title) {
    const titleText = ` ${title} `;
    const remaining = innerWidth + 2 - visibleWidth(titleText);
    result.push(
      theme.fg("borderAccent", FRAME.tl + titleText + FRAME.h.repeat(Math.max(0, remaining)) + FRAME.tr),
    );
  } else {
    result.push(
      theme.fg("borderAccent", FRAME.tl + FRAME.h.repeat(innerWidth + 2) + FRAME.tr),
    );
  }

  // Body lines
  for (const line of lines) {
    const clipped = truncateToWidth(line, innerWidth, theme.fg("dim", "…"));
    result.push(
      theme.fg("borderAccent", FRAME.v + " ") + padLine(clipped, innerWidth) + theme.fg("borderAccent", " " + FRAME.v),
    );
  }

  // Bottom border
  result.push(
    theme.fg("borderAccent", FRAME.bl + FRAME.h.repeat(innerWidth + 2) + FRAME.br),
  );

  return result;
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
      this.tui.requestRender();
    };
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

  private getSkillDescription(skillName: string): string | undefined {
    this.loadAllSkills();
    const skill = this.allSkills.find((s) => s.name === skillName);
    return skill?.description;
  }

  /** Available rows for list content based on terminal height. */
  private get visibleListRows(): number {
    const overlayRows = Math.floor(this.tui.terminal.rows * 0.7);
    return Math.max(3, overlayRows - FRAME_OVERHEAD);
  }

  // --- Rendering ---

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 4);
    const lines: string[] = [];

    switch (this.mode) {
      case "browse":
        this.buildBrowseLines(lines, innerWidth);
        return renderFrame(this.theme, width, lines, "Presets");
      case "preset-edit":
        this.buildPresetEditLines(lines, innerWidth);
        return renderFrame(this.theme, width, lines, `Edit: ${this.editPresetName}`);
      case "skill-list":
        this.buildSkillListLines(lines, innerWidth);
        return renderFrame(this.theme, width, lines, `Add skill → ${this.editPresetName}`);
      case "new-preset":
        this.buildNewPresetLines(lines, innerWidth);
        return renderFrame(this.theme, width, lines, "New Preset");
    }
  }

  private buildBrowseLines(lines: string[], innerWidth: number): void {
    const names = this.presetNames;
    const maxRows = this.visibleListRows;

    if (names.length === 0) {
      lines.push("");
      lines.push(this.theme.fg("dim", "No presets defined. Press 'n' to create one."));
      lines.push("");
    } else {
      const { startIndex, endIndex } = scrollWindow(names.length, this.browseIndex, maxRows);

      if (startIndex > 0) {
        lines.push(this.theme.fg("dim", "  ↑ more..."));
      }

      for (let i = startIndex; i < endIndex; i++) {
        const name = names[i]!;
        const isSelected = i === this.browseIndex;
        const loaded = this.state.has(name);
        const isDefault = name === this.defaultPreset;

        const prefix = isSelected ? this.theme.fg("accent", "→ ") : "  ";
        const namePart = name;
        const status = loaded
          ? " " + this.theme.fg("success", "[loaded]")
          : " " + this.theme.fg("dim", "[─]");
        const star = isDefault ? " " + this.theme.fg("accent", "★") : "";
        const skills = getPresetSkills(this.config, name) ?? [];
        const count = this.theme.fg("dim", ` (${skills.length})`);

        const line = `${prefix}${namePart}${status}${star}${count}`;
        lines.push(isSelected ? this.theme.bg("selectedBg", padLine(line, innerWidth)) : line);
      }

      if (endIndex < names.length) {
        lines.push(this.theme.fg("dim", "  ↓ more..."));
      }
    }

    lines.push("");
    lines.push(this.theme.fg("dim", "↑↓ navigate  Space toggle  e edit  n new  Esc quit"));
  }

  private buildPresetEditLines(lines: string[], innerWidth: number): void {
    const name = this.editPresetName;
    if (!name) return;

    const isDefault = name === this.defaultPreset;
    if (isDefault) {
      lines.push(this.theme.fg("accent", "★ default preset"));
    }

    const skills = getPresetSkills(this.config, name) ?? [];
    const maxRows = this.visibleListRows - 2; // account for header + footer

    lines.push(this.theme.fg("muted", this.theme.bold(`Skills (${skills.length}):`)));
    lines.push("");

    if (skills.length === 0) {
      lines.push(this.theme.fg("dim", "No skills. Press 'a' to add."));
    } else {
      const { startIndex, endIndex } = scrollWindow(skills.length, this.editSkillIndex, maxRows);

      if (startIndex > 0) {
        lines.push(this.theme.fg("dim", "  ↑ more..."));
      }

      for (let i = startIndex; i < endIndex; i++) {
        const skillName = skills[i]!;
        const isSelected = i === this.editSkillIndex;
        const prefix = isSelected ? this.theme.fg("accent", "→ ") : "  ";

        const desc = this.getSkillDescription(skillName);
        const descText = desc
          ? this.theme.fg("dim", ` — ${truncateToWidth(desc, 50, "…")}`)
          : this.theme.fg("warning", " (not found)");

        const line = `${prefix}${skillName}${descText}`;
        lines.push(isSelected ? this.theme.bg("selectedBg", padLine(line, innerWidth)) : line);
      }

      if (endIndex < skills.length) {
        lines.push(this.theme.fg("dim", "  ↓ more..."));
      }
    }

    lines.push("");
    lines.push(this.theme.fg("dim", "↑↓ navigate  a add  Backspace remove  Esc back"));
  }

  private buildSkillListLines(lines: string[], innerWidth: number): void {
    this.loadAllSkills();

    const currentSkills = new Set(getPresetSkills(this.config, this.editPresetName!) ?? []);
    const maxRows = this.visibleListRows - 2;

    if (this.allSkills.length === 0) {
      lines.push(this.theme.fg("dim", "No skills available."));
    } else {
      const { startIndex, endIndex } = scrollWindow(this.allSkills.length, this.skillListIndex, maxRows);

      if (startIndex > 0) {
        lines.push(this.theme.fg("dim", "  ↑ more..."));
      }

      for (let i = startIndex; i < endIndex; i++) {
        const skill = this.allSkills[i]!;
        const isSelected = i === this.skillListIndex;
        const alreadyAdded = currentSkills.has(skill.name);

        const prefix = isSelected ? this.theme.fg("accent", "→ ") : "  ";
        const name = alreadyAdded
          ? this.theme.fg("success", `${skill.name} ✓`)
          : skill.name;
        const desc = this.theme.fg("dim", ` — ${truncateToWidth(skill.description, 45, "…")}`);

        const line = `${prefix}${name}${desc}`;
        lines.push(isSelected ? this.theme.bg("selectedBg", padLine(line, innerWidth)) : line);
      }

      if (endIndex < this.allSkills.length) {
        lines.push(this.theme.fg("dim", "  ↓ more..."));
      }
    }

    lines.push("");
    lines.push(this.theme.fg("dim", "↑↓ navigate  Enter add  Esc back"));
  }

  private buildNewPresetLines(lines: string[], innerWidth: number): void {
    lines.push(this.theme.fg("dim", "Enter preset name (lowercase, numbers, hyphens):"));
    lines.push("");
    // Input renders itself
    const inputLines = this.nameInput.render(Math.max(1, innerWidth - 2));
    lines.push(...inputLines);
    lines.push("");
    lines.push(this.theme.fg("dim", "Enter create  Esc cancel"));
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
    this.tui.requestRender();
  }

  private handleBrowseInput(data: string): void {
    const kb = getKeybindings();
    const len = this.presetNames.length;

    if (kb.matches(data, "tui.select.up")) {
      this.browseIndex = this.browseIndex === 0 ? Math.max(0, len - 1) : this.browseIndex - 1;
      return;
    }

    if (kb.matches(data, "tui.select.down")) {
      this.browseIndex = len === 0 ? 0 : (this.browseIndex + 1) % len;
      return;
    }

    if (kb.matches(data, "tui.select.confirm") || matchesKey(data, Key.space) || matchesKey(data, Key.enter)) {
      const name = this.presetNames[this.browseIndex];
      if (name) this.togglePreset(name);
      return;
    }

    if (data === "e") {
      const name = this.presetNames[this.browseIndex];
      if (name) {
        this.editPresetName = name;
        this.editSkillIndex = 0;
        this.mode = "preset-edit";
      }
      return;
    }

    if (data === "n") {
      this.nameInput.setValue("");
      this.mode = "new-preset";
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
      return;
    }

    if (kb.matches(data, "tui.select.down")) {
      this.editSkillIndex = len === 0 ? 0 : (this.editSkillIndex + 1) % len;
      return;
    }

    if (data === "a") {
      this.skillListIndex = 0;
      this.mode = "skill-list";
      return;
    }

    if (matchesKey(data, Key.backspace) && len > 0) {
      this.removeSkillFromPreset(name, this.editSkillIndex);
      return;
    }

    if (kb.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape)) {
      this.mode = "browse";
      return;
    }
  }

  private handleSkillListInput(data: string): void {
    const kb = getKeybindings();
    this.loadAllSkills();
    const len = this.allSkills.length;

    if (kb.matches(data, "tui.select.up")) {
      this.skillListIndex = this.skillListIndex === 0 ? Math.max(0, len - 1) : this.skillListIndex - 1;
      return;
    }

    if (kb.matches(data, "tui.select.down")) {
      this.skillListIndex = len === 0 ? 0 : (this.skillListIndex + 1) % len;
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
      return;
    }
  }

  private handleNewPresetInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.mode = "browse";
      return;
    }
    this.nameInput.handleInput(data);
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
  }

  private removeSkillFromPreset(presetName: string, skillIndex: number): void {
    const def = this.config.definitions[presetName];
    if (!def || skillIndex < 0 || skillIndex >= def.skills.length) return;

    const removed = def.skills.splice(skillIndex, 1)[0];
    this.saveConfig();
    this.ctx.ui.notify(`Removed "${removed}" from preset "${presetName}".`, "info");

    const len = def.skills.length;
    if (this.editSkillIndex >= len && len > 0) {
      this.editSkillIndex = len - 1;
    }
  }

  private deletePreset(presetName: string): void {
    delete this.config.definitions[presetName];

    if (this.config.default === presetName) {
      this.config.default = undefined;
    }

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

    this.mode = "browse";
    this.browseIndex = Math.min(this.browseIndex, Math.max(0, this.presetNames.length - 1));
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

    if (!/^[a-z0-9-]+$/.test(name)) {
      this.ctx.ui.notify("Name must contain only lowercase letters, numbers, and hyphens.", "error");
      return;
    }

    this.config.definitions[name] = { skills: [] };
    this.saveConfig();
    this.ctx.ui.notify(`Created preset "${name}".`, "info");

    this.editPresetName = name;
    this.editSkillIndex = 0;
    this.mode = "preset-edit";
  }
}
