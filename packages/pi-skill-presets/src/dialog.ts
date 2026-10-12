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
import type { ExtensionContext, ExtensionCommandContext, ExtensionAPI, Theme, Skill } from "@earendil-works/pi-coding-agent";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import type { PresetState } from "./preset-state.ts";
import type { PresetsConfig, PresetOpEntry } from "./types.ts";
import { getPresetSkills, readPresetsConfig, writePresetsConfig, getAgentDir } from "./config.ts";
import { findBadRefs } from "./bad-refs.ts";
import { PRESET_OP_CUSTOM_TYPE } from "./types.ts";

type DialogMode = "browse" | "preset-edit" | "skill-list" | "new-preset" | "confirm";

/** Pending confirmation action. */
interface ConfirmAction {
  message: string;
  onConfirm: () => void;
  returnMode: DialogMode;
}

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
  getDefaultPreset?: () => string | undefined,
  consumeReplayWarning?: (names: string[]) => void,
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("/preset requires interactive mode", "warning");
    return;
  }

  await ctx.ui.custom<void>((tui, theme, _kb, done) => {
    return new PresetDialog(
      ctx,
      pi,
      state,
      config,
      theme,
      tui,
      done,
      getDefaultPreset ?? (() => undefined),
      consumeReplayWarning,
    );
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
  /** Delta base for merging saves — refreshed to the merged result after each save (ocr R4M2). */
  private originalDefinitions: PresetsConfig["definitions"];
  private readonly getDefaultPreset: () => string | undefined;
  private readonly consumeReplayWarning?: (names: string[]) => void;
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
  private pendingConfirm: ConfirmAction | null = null;

  constructor(
    ctx: ExtensionContext,
    pi: ExtensionAPI,
    state: PresetState,
    config: PresetsConfig,
    theme: Theme,
    tui: TUI,
    done: (result: void) => void,
    getDefaultPreset: () => string | undefined,
    consumeReplayWarning?: (names: string[]) => void,
  ) {
    super();
    this.ctx = ctx;
    this.pi = pi;
    this.state = state;
    this.config = config;
    this.originalDefinitions = structuredClone(config.definitions);
    this.theme = theme;
    this.tui = tui;
    this.done = done;
    this.getDefaultPreset = getDefaultPreset;
    this.consumeReplayWarning = consumeReplayWarning;
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

  // Live read (ocr N2): the default can change in settings.json while the
  // dialog is open; every default comparison uses the current value.
  // Tri-state (ocr R10M): an unreadable settings.json (corrupt or truncated
  // JSON) makes the live read throw, and a bare undefined would make operation
  // paths mistake the always-on default for "no default configured" and
  // proceed to load/offload it with an entry written. Callers must handle
  // ok:false: render paths degrade to the error line, operation paths refuse
  // to act. (ocr R11M1: with parse errors no longer swallowed by
  // readSettingsFile, this tri-state now actually fires for the common
  // "truncated to `{`" corruption, not just legal JSON `null`.)
  private readDefaultPreset(): { ok: true; name?: string } | { ok: false; error: string } {
    try {
      return { ok: true, name: this.getDefaultPreset() };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Returns true when the write succeeded; false after a notified failure (ocr R6M1). */
  private saveConfig(presetName?: string): boolean {
    // Merge dialog edits onto a fresh read (ocr R2): settings.json can change
    // while the dialog is open (e.g. a new default written externally); writing
    // the stale snapshot whole would clobber it. Only the definitions this
    // dialog actually touched (added, edited, deleted) are applied — the fresh
    // default and all externally-modified/untouched definitions survive.
    // Catch read + merge + write failures (ocr R6M1/R7M): the fresh read can
    // throw too — e.g. settings.json externally corrupted (legal JSON `null`
    // or truncated/invalid JSON, ocr R11M1) makes readPresetsConfig throw —
    // so the whole read-merge-write sequence shares one failure path: notify the user
    // with the preset name and reason, then report failure to the caller —
    // which rolls back its local edit so retrying the original action
    // re-attempts the save instead of hitting an already-exists /
    // already-added guard. this.config/originalDefinitions still hold the
    // pre-save edits, so a retry re-merges and re-writes them (ocr R5M4).
    let fresh: PresetsConfig;
    try {
      fresh = readPresetsConfig(this.cwd);
      const defs = { ...fresh.definitions };
      for (const name of Object.keys(this.originalDefinitions)) {
        if (!this.config.definitions[name]) delete defs[name]; // deleted in dialog
      }
      for (const [name, def] of Object.entries(this.config.definitions)) {
        const original = this.originalDefinitions[name];
        if (!original || JSON.stringify(original) !== JSON.stringify(def)) {
          defs[name] = def; // added or edited in dialog
        }
      }
      fresh.definitions = defs;
      writePresetsConfig(fresh, "global");
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const label = presetName ? `preset "${presetName}"` : "presets";
      this.ctx.ui.notify(`Failed to save ${label}: ${reason}`, "error");
      return false;
    }
    this.config = fresh;
    // ocr R12L: fresh is the merged on-disk state — the browse-selected preset
    // may have been externally deleted while editing. Realign browseIndex to
    // the selected name (clamped when gone) so returning to browse always has
    // a valid selection instead of pointing past the end of the list.
    const selected = this.presetNames[this.browseIndex];
    const idx = selected ? this.presetNames.indexOf(selected) : -1;
    this.browseIndex = idx >= 0
      ? idx
      : Math.min(this.browseIndex, Math.max(0, this.presetNames.length - 1));
    // Refresh the delta baseline to the merged result (ocr R4M2/M3): later
    // saves only merge edits not yet on disk, so external changes made after
    // this save survive, and a preset created-then-deleted in this dialog is
    // actually deleted (it is now part of the baseline).
    this.originalDefinitions = structuredClone(fresh.definitions);
    return true;
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
      case "confirm":
        this.buildConfirmLines(lines, innerWidth);
        return renderFrame(this.theme, width, lines, "Confirm");
    }
  }

  private buildBrowseLines(lines: string[], innerWidth: number): void {
    // Read the default once up front: on unreadable settings the tri-state
    // getter returns ok:false and we render the error state instead of
    // throwing (ocr R9M).
    const def = this.readDefaultPreset();
    const defaultName = def.ok ? def.name : undefined;
    if (!def.ok) {
      lines.push(this.theme.fg("warning", `settings.json unreadable: ${def.error}`));
    }
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
        const isDefault = name === defaultName;

        const prefix = isSelected ? this.theme.fg("accent", "→ ") : "  ";
        const namePart = name;
        let status: string;
        if (isDefault) {
          status = " " + this.theme.fg("accent", "[always-on]");
        } else if (loaded) {
          status = " " + this.theme.fg("success", "[loaded]");
        } else {
          status = " " + this.theme.fg("dim", "[─]");
        }
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
    lines.push(this.theme.fg("dim", "↑↓ navigate  Space toggle  e edit  n new  d delete  Esc quit"));
  }

  private buildPresetEditLines(lines: string[], innerWidth: number): void {
    const name = this.editPresetName;
    if (!name) return;

    // ocr R9M: same corrupt-settings guard as buildBrowseLines.
    const def = this.readDefaultPreset();
    const defaultName = def.ok ? def.name : undefined;
    if (!def.ok) {
      lines.push(this.theme.fg("warning", `settings.json unreadable: ${def.error}`));
    }
    const isDefault = name === defaultName;
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

  private buildConfirmLines(lines: string[], innerWidth: number): void {
    const action = this.pendingConfirm;
    if (!action) return;
    lines.push("");
    // Wrap message to innerWidth
    const words = action.message.split(" ");
    let current = "";
    for (const word of words) {
      if (current.length + word.length + 1 > innerWidth) {
        lines.push(current);
        current = word;
      } else {
        current = current ? `${current} ${word}` : word;
      }
    }
    if (current) lines.push(current);
    lines.push("");
    lines.push(this.theme.fg("warning", "Enter confirm  Esc cancel"));
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
      case "confirm":
        this.handleConfirmInput(data);
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

    // 'd' — delete selected preset (with confirmation)
    if (data === "d") {
      const name = this.presetNames[this.browseIndex];
      if (name) {
        const presetName = name;
        this.requestConfirm(
          `Delete preset "${name}"? This cannot be undone.`,
          () => this.deletePreset(presetName),
          "browse",
        );
      }
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
      const skillName = skills[this.editSkillIndex]!;
      this.requestConfirm(
        `Remove "${skillName}" from preset "${name}"?`,
        () => this.removeSkillFromPreset(name, this.editSkillIndex),
      );
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

  private handleConfirmInput(data: string): void {
    const action = this.pendingConfirm;
    if (!action) return;

    if (matchesKey(data, Key.enter)) {
      // Always restore returnMode after the callback (ocr R6M2): a rejected
      // confirm (e.g. deleting the default preset) returns without changing
      // mode — without this the dialog stays in confirm mode with no pending
      // action and both Enter and Esc are swallowed by the guard above.
      const returnMode = action.returnMode;
      this.pendingConfirm = null;
      try {
        action.onConfirm();
      } catch (error) {
        // The callback runs on a fresh settings read (ocr R8M): a corrupt
        // config can throw. Report it and still return to returnMode so
        // the dialog does not stay stuck in confirm mode.
        this.ctx.ui.notify(
          `Action failed: ${action.message} (${error instanceof Error ? error.message : String(error)})`,
          "error",
        );
      }
      this.mode = returnMode;
      return;
    }

    if (matchesKey(data, Key.escape)) {
      const returnMode = action.returnMode;
      this.pendingConfirm = null;
      this.mode = returnMode;
      return;
    }
  }

  /** Show a confirmation dialog. Returns to returnMode on cancel. */
  private requestConfirm(message: string, onConfirm: () => void, returnMode: DialogMode = "preset-edit"): void {
    this.pendingConfirm = { message, onConfirm, returnMode };
    this.mode = "confirm";
  }

  // --- Actions ---

  private togglePreset(name: string): void {
    // ocr R10M: refuse to act while settings.json is unreadable — treating
    // the always-on default as "no default" would offload/load it and write
    // a replay entry for a config we cannot even read.
    const def = this.readDefaultPreset();
    if (!def.ok) {
      this.ctx.ui.notify("settings.json unreadable, cannot proceed", "error");
      return;
    }
    if (name === def.name) {
      // Default preset is always-on: it is not a member of the explicit
      // active set, so it can be neither offloaded nor usefully re-loaded.
      this.ctx.ui.notify(`Preset "${name}" is the default preset and cannot be offloaded.`, "warning");
      return;
    }
    if (this.state.has(name)) {
      this.state.offload(name);
      this.pi.appendEntry<PresetOpEntry>(PRESET_OP_CUSTOM_TYPE, {
        action: "offload",
        preset: name,
        timestamp: Date.now(),
      });
      this.ctx.ui.notify(`Offloaded preset "${name}".`, "info");
      return;
    }
    // Align with /preset-load: warn on bad references, still load. The
    // platform skill list comes from this dialog's own command context
    // (optional at runtime even though only commands normally open it);
    // absent that, skip the check.
    const platformOptions = (this.ctx as ExtensionCommandContext).getSystemPromptOptions?.();
    if (platformOptions) {
      const badRefs = findBadRefs(
        (platformOptions.skills ?? []).map((s) => s!.name),
        getPresetSkills(this.config, name) ?? [],
      );
      if (badRefs.length > 0) {
        this.ctx.ui.notify(
          `Preset "${name}" loaded, but these skills are unavailable (missing or disabled): ${badRefs.join(", ")}`,
          "warning",
        );
        // Aligned with /preset-load (ocr N3): the warned names are recorded
        // so the replay path does not repeat them.
        this.consumeReplayWarning?.(badRefs);
      }
    }
    this.state.load(name);
    this.pi.appendEntry<PresetOpEntry>(PRESET_OP_CUSTOM_TYPE, {
      action: "load",
      preset: name,
      timestamp: Date.now(),
    });
    this.ctx.ui.notify(`Loaded preset "${name}".`, "info");
  }

  private addSkillToPreset(presetName: string, skillName: string): void {
    const def = this.config.definitions[presetName];
    if (!def) return;

    if (def.skills.includes(skillName)) {
      this.ctx.ui.notify(`Skill "${skillName}" is already in preset "${presetName}".`, "info");
      return;
    }

    def.skills.push(skillName);
    if (!this.saveConfig(presetName)) {
      def.skills.pop(); // roll back so retrying this action re-attempts the write
      return;
    }
    this.ctx.ui.notify(`Added "${skillName}" to preset "${presetName}".`, "info");
  }

  private removeSkillFromPreset(presetName: string, skillIndex: number): void {
    const def = this.config.definitions[presetName];
    if (!def || skillIndex < 0 || skillIndex >= def.skills.length) return;

    const removed = def.skills.splice(skillIndex, 1)[0];
    if (!this.saveConfig(presetName)) {
      def.skills.splice(skillIndex, 0, removed); // roll back for retry
      return;
    }
    this.ctx.ui.notify(`Removed "${removed}" from preset "${presetName}".`, "info");

    const len = def.skills.length;
    if (this.editSkillIndex >= len && len > 0) {
      this.editSkillIndex = len - 1;
    }
  }

  private deletePreset(presetName: string): void {
    // ocr R10M: same unreadable-config gate as togglePreset.
    const def = this.readDefaultPreset();
    if (!def.ok) {
      this.ctx.ui.notify("settings.json unreadable, cannot proceed", "error");
      return;
    }
    if (presetName === def.name) {
      // Default preset is protected (#63): offload is rejected, so is delete.
      this.ctx.ui.notify(
        `Preset "${presetName}" is the default preset and cannot be deleted.`,
        "warning",
      );
      return;
    }

    const removedDef = this.config.definitions[presetName];
    delete this.config.definitions[presetName];
    // No default clearing here: default protection is judged against the live
    // getter above, and saveConfig preserves whatever default is fresh on disk
    // (ocr R2 — the dialog's snapshot default may be stale).

    // Save first; commit session side effects only after success (ocr R6M1):
    // a failed write must not leave the preset offloaded or a replay entry
    // written for a definition that is still on disk.
    if (!this.saveConfig(presetName)) {
      this.config.definitions[presetName] = removedDef; // roll back for retry
      return;
    }

    if (this.state.has(presetName)) {
      this.state.offload(presetName);
      this.pi.appendEntry<PresetOpEntry>(PRESET_OP_CUSTOM_TYPE, {
        action: "offload",
        preset: presetName,
        timestamp: Date.now(),
      });
    }

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
    if (!this.saveConfig(name)) {
      delete this.config.definitions[name]; // roll back so the name is free to retry
      return;
    }
    this.ctx.ui.notify(`Created preset "${name}".`, "info");

    this.editPresetName = name;
    this.editSkillIndex = 0;
    this.mode = "preset-edit";
  }
}
