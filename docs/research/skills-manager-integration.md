# Research: `@vanillagreen/pi-skills-manager` Extensibility & Integration Surface

> Ticket #3 — Investigate how a "presets" extension can coexist with and integrate into the
> skills manager (`@vanillagreen/pi-skills-manager@1.1.3`).
>
> Source root examined:
> `/mnt/disk1/hyx/.pi/agent/npm/node_modules/@vanillagreen/pi-skills-manager/extensions/`
> Files read in full: `skills-manager.ts`, `skills-manager/{types,registry,settings,toggle,constants,paths,creation,startup,dialog,components,ui}.ts`,
> plus `package.json`.

This document answers the five questions from the ticket, each backed by specific code,
function signatures, and an explicit "exported / extensible?" verdict. A short
"Recommendations" section at the end summarises the integration strategy for the presets
package.

---

## 0. Package shape & public API surface

`package.json` declares the Pi extension entry point and **nothing else** as public API:

```jsonc
{
  "name": "@vanillagreen/pi-skills-manager",
  "version": "1.1.3",
  "pi": { "extensions": ["./extensions/skills-manager.ts"] },
  "files": ["extensions/", "assets/", "README.md", "THIRD_PARTY_NOTICES.md", "package.json"]
  // NOTE: no "exports", no "main", no "types"
}
```

Consequences:

- There is **no `exports` map**. Every submodule under `extensions/skills-manager/` is
  technically shipped on disk (via `files: ["extensions/"]`) and importable by deep path
  (`@vanillagreen/pi-skills-manager/extensions/skills-manager/registry.js`), but **this is
  not a declared public API**. Any import of those submodules is reaching into internals
  and can break on a minor/patch bump.
- The only contractually-stable surface is the **Pi extension default export** in
  `extensions/skills-manager.ts` (the `skillsManager(pi: ExtensionAPI)` function), plus the
  `vstack.extensionManager.settings` schema declared in `package.json` (the `enabled`,
  `hideStartupSkillsBlock`, `aiGenerationEnabled`, `popupWidth`, `popupMaxHeight`,
  `listRows`, `defaultCreateLocation`, `glyphStyle` keys).
- The TypeScript types in `skills-manager/types.ts` (`SkillEntry`, `SkillRegistry`,
  `SkillsManagerOptions`, `Mode`, …) are **not re-exported from a package entry point**;
  they live in an internal module. To use them without coupling, the presets package should
  define its own structural equivalents (see §6).

This shapes every answer below: the manager is functionally rich internally but
**deliberately exposes almost nothing** to other packages.

---

## 1. Dialog integration — can we add a 'Presets' tab to the `/skill` dialog?

**Verdict: No. The dialog is a closed, non-extensible internal component.**

The TUI is rendered by the `SkillsManagerDialog` class in
`skills-manager/dialog.ts`. Key facts:

- `SkillsManagerDialog` is a **non-exported class** (`class SkillsManagerDialog implements Focusable { … }`,
  no `export`). Only the free function `showSkillsManager` is exported from `dialog.ts`:

  ```ts
  export async function showSkillsManager(
    ctx: ExtensionContext,
    registry: SkillRegistry,
    options: SkillsManagerOptions,
  ): Promise<SkillEntry | null> { … }
  ```

- `showSkillsManager` constructs the dialog internally and passes it to
  `ctx.ui.custom<SkillEntry | null>(…)`. There is **no hook, no plugin point, no
  section/tab registry**. The modes are hard-coded in the `Mode` union
  (`skills-manager/types.ts`):

  ```ts
  export type Mode =
    | "browse" | "create" | "preview" | "edit"
    | "rename" | "delete-confirm" | "generating";
  ```

  There is no `"presets"` mode and no mechanism to add one.

- The browse list is assembled from hard-coded entry kinds
  (`{ kind: "create" } | { kind: "header" } | { kind: "skill" }`) inside
  `renderBrowse(width)`. Sections ("Your Skills", "Library Skills") are derived from
  `isDeletableSkill(skill)`, not from a pluggable section list. A third party cannot inject
  a "Presets" header/section without monkey-patching the class.

- The only extension seam is the `SkillsManagerOptions` callback bag
  (`skills-manager/types.ts`):

  ```ts
  export interface SkillsManagerOptions {
    onCreate:  (answers: SkillCreationAnswers, signal?: AbortSignal) => Promise<SkillEntry | null>;
    onDelete:  (skill: SkillEntry) => Promise<boolean>;
    onToggle:  (skill: SkillEntry, enabled: boolean) => Promise<void>;
    onRefresh: () => Promise<SkillRegistry>;
  }
  ```

  These callbacks are wired by the **manager's own** command handler in
  `skills-manager.ts` (`showSkillsManager(ctx, registry, { onCreate, onDelete, onToggle, onRefresh })`).
  A third-party package never gets to supply its own `options` — `showSkillsManager` is
  called from inside the manager's registered `/skill` handler, not exposed for reuse.

- The dialog also acquires a global modal lock (`acquireVstackModalLock()` in `ui.ts`,
  backed by `Symbol.for("vstack.pi.modal-lock")`) and patches
  `InteractiveMode.prototype.showLoadedResources` (`startup.ts`). Both are
  **process-global mutations** keyed by well-known `Symbol.for(...)` keys (see
  `constants.ts`: `INSTALL_SYMBOL`, `STARTUP_PATCH_SYMBOL`, `STARTUP_HIDE_ENABLED_SYMBOL`,
  `VSTACK_MODAL_LOCK_SYMBOL`). Reusing the lock is possible (it's a shared symbol), but the
  dialog itself is not reusable as a host for foreign tabs.

**Conclusion for presets:** Do **not** attempt to add a tab inside the skills manager
dialog. Instead, the presets package should register its **own** command (e.g. `/preset`)
and, if a unified UI is desired later, render its own overlay via `ctx.ui.custom(...)` —
the same primitive `showSkillsManager` uses. See §6.

---

## 2. Registry API — can we call `loadSkillRegistry(cwd)` to know which skills exist and their state?

**Verdict: The function exists and is exported from the internal module, but it is not a
declared public API. Usable with caveats.**

`skills-manager/registry.ts` exports:

```ts
export async function loadSkillRegistry(cwd: string): Promise<SkillRegistry>;
export function isDeletableSkill(skill: SkillEntry): boolean;
export function skillStorageTarget(skill: SkillEntry): string;
export async function deleteSkill(ctx: ExtensionContext, skill: SkillEntry): Promise<boolean>;
```

`loadSkillRegistry` is the real workhorse. Its implementation:

```ts
export async function loadSkillRegistry(cwd: string): Promise<SkillRegistry> {
  const settingsManager = SettingsManager.create(cwd, getAgentDir(),
    { projectTrusted: projectSettingsTrusted(cwd) });
  const packageManager = new DefaultPackageManager({ cwd, agentDir: getAgentDir(), settingsManager });
  const resolved = await packageManager.resolve();
  const allSkills = dedupeByPath(resolved.skills.map(toSkillEntry)
    .filter((entry): entry is SkillEntry => entry !== null)).sort(compareSkills);
  const byName = new Map<string, SkillEntry>();
  for (const skill of allSkills) {
    if (!skill.enabled) continue;
    if (!byName.has(skill.name)) byName.set(skill.name, skill);
  }
  const skills = Array.from(byName.values()).sort(compareSkills);
  return { skills, allSkills, byName: new Map(skills.map((s) => [s.name, s])) };
}
```

The returned `SkillRegistry` (`skills-manager/types.ts`):

```ts
export interface SkillRegistry {
  skills: SkillEntry[];      // enabled, deduped-by-name
  allSkills: SkillEntry[];   // every resolved skill (enabled OR disabled)
  byName: Map<string, SkillEntry>;  // enabled only
}
export interface SkillEntry {
  name: string; description: string; path: string; content: string;
  frontmatter?: Record<string, unknown>;
  scope: SkillScope;        // "user" | "project" | "temporary"
  origin: SkillOrigin;      // "package" | "top-level"
  source: string; baseDir?: string;
  enabled: boolean;         // <-- the toggle state
}
```

So yes — calling `loadSkillRegistry(cwd)` gives you the full picture, including
`enabled`/disabled state, scope, origin and source package. `allSkills` is the array to
iterate when you care about disabled entries; `skills`/`byName` are pre-filtered to enabled
only.

**Important caveats:**

1. **Not a declared export.** Importing
   `@vanillagreen/pi-skills-manager/extensions/skills-manager/registry.js` works today
   because `files` ships the directory, but it is internal. Pin the exact installed version
   and be ready to vendor/copy the logic if it breaks.
2. **It depends on `projectSettingsTrusted(cwd)`** (from `paths.ts`), which is populated by
   `recordProjectTrust(ctx)` during the manager's `session_start` handler. If you call
   `loadSkillRegistry` **before** the manager has recorded trust for the current project,
   project-scoped settings will be silently ignored (only user/global settings are read).
   The presets extension should either (a) run after `session_start` and call
   `recordProjectTrust` itself, or (b) construct `SettingsManager` with the correct
   `projectTrusted` flag from `ctx.isProjectTrusted?.()`.
3. It performs filesystem I/O (`readFileSync` per skill file) and a full package resolution
   on every call — not free. Cache the result per session and refresh on demand.

**Recommended safer alternative:** Use the same primitives the manager uses —
`SettingsManager.create(cwd, getAgentDir(), { projectTrusted })` and
`DefaultPackageManager` from `@earendil-works/pi-coding-agent` — directly from the presets
package, rather than importing the manager's internal `registry.ts`. This couples you to
the stable `@earendil-works/pi-coding-agent` API instead of the manager's private module.
See §6.

---

## 3. Toggle respect — how do we read enabled/disabled state, and avoid re-enabling a user-disabled skill?

**Verdict: State lives in Pi's `settings.json` as `+`/`-`-prefixed skill path patterns.
Read it via `loadSkillRegistry` (or `SettingsManager` directly). Never write `+` patterns
blindly for a skill the user has `-`'d.**

### 3a. How toggles are persisted

`skills-manager/toggle.ts` → `setSkillEnabled(cwd, skill, enabled)`:

```ts
function updatePatterns(current: string[], pattern: string, enabled: boolean): string[] {
  const updated = current.filter((entry) => {
    const stripped = entry.startsWith("!") || entry.startsWith("+") || entry.startsWith("-")
      ? entry.slice(1) : entry;
    return stripped !== pattern;
  });
  updated.push(`${enabled ? "+" : "-"}${pattern}`);
  return updated;
}
```

So a disabled skill is recorded as `-<relative-path>` and an enabled one as
`+<relative-path>`, in the `skills` array of either the global settings or a package's
`skills` filter array. Two scopes:

- **Top-level skills** (`origin === "top-level"`): pattern is relative to the project `.pi`
  dir (`findProjectPiDir(cwd)`) or the agent dir; written via
  `settingsManager.setProjectSkillPaths(updated)` / `setSkillPaths(updated)`.
- **Package skills** (`origin === "package"`): pattern is relative to `skill.baseDir`
  (the package's skill root); written into the package entry's `skills` filter array via
  `setProjectPackages(packages)` / `setPackages(packages)`, and the entry is collapsed back
  to a bare string when it has no remaining filters (`hasPackageFilters`).

  ```ts
  function hasPackageFilters(pkg: Exclude<PackageSource, string>): boolean {
    return pkg.extensions !== undefined || pkg.skills !== undefined
        || pkg.prompts !== undefined || pkg.themes !== undefined;
  }
  ```

After writing, `settingsManager.flush()` is called. The dialog then re-reads via
`onRefresh → refreshRegistry → loadSkillRegistry`.

### 3b. How to read the current state

Three options, in increasing order of coupling:

1. **`loadSkillRegistry(cwd)`** (internal, see §2) — inspect `skill.enabled` on each
   `SkillEntry`. `allSkills` includes disabled ones.
2. **`SettingsManager` directly** (stable, from `@earendil-works/pi-coding-agent`):
   ```ts
   const sm = SettingsManager.create(cwd, getAgentDir(), { projectTrusted });
   const global = sm.getGlobalSettings();        // { skills?: string[], packages?: PackageSource[] }
   const project = sm.getProjectSettings();      // same shape, project-scoped
   ```
   Each `skills` entry is a `+`/`-`/`!`-prefixed pattern (or bare). Each `packages` entry is
   either a string or `{ source, skills?: string[], … }`. Parse prefixes the same way
   `updatePatterns` does to determine enabled/disabled per skill path.
3. **Read `settings.json` files directly.** The manager's own `settings.ts` shows the
   layout for *its own* config under
   `vstack.extensionManager.config["@vanillagreen/pi-skills-manager"]`, but **skill toggle
   state is NOT stored there** — it is stored in the Pi-core `skills`/`packages` arrays at
   the top level of `~/.pi/agent/settings.json` and `<project>/.pi/settings.json`. Use
   option 2 to avoid reimplementing path resolution and trust checks.

### 3c. Preset must not re-enable a user-disabled skill

The presets package, when "applying" a preset, must respect an existing `-` pattern.
Concretely:

- Before writing a `+<pattern>` for a skill the preset wants enabled, check the current
  resolved state (via `loadSkillRegistry` or `SettingsManager`). If the user has explicitly
  disabled it (`-` pattern present), **skip it** (or surface a conflict) rather than
  overwriting with `+`.
- `updatePatterns` itself is idempotent in the sense that it strips any existing
  `+`/`-`/`!` entry for the same pattern before pushing the new one — so calling
  `setSkillEnabled(cwd, skill, true)` *will* flip a user's `-` to `+`. The presets package
  must therefore **gate** calls to `setSkillEnabled` (or its own equivalent) on the
  current state, not call it unconditionally.
- A subtle but important corollary: `setSkillEnabled` throws for `temporary` scope and for
  untrusted projects (`projectSettingsTrusted(cwd) === false`). The presets package must
  handle both cases gracefully.

---

## 4. Event hooks — does the manager emit events on toggle, or must we poll?

**Verdict: No events. The manager is entirely pull-based. You must re-read settings.**

Evidence:

- The manager registers exactly one event listener, in `skills-manager.ts`:
  ```ts
  pi.on("session_start", async (_event, ctx) => { await prepareSession(ctx); });
  ```
  `prepareSession` calls `recordProjectTrust(ctx)` and `refreshRegistry(ctx.cwd)` once. There
  is **no `pi.on("skill_toggled", …)`** or any analogous hook.

- The toggle path (`toggle.ts → setSkillEnabled`) ends with `await settingsManager.flush()`
  and returns `void`. It does **not** emit any event, call any registry, or notify other
  extensions. The only "notification" is the dialog's local `ctx.ui.notify(...)`:
  ```ts
  this.ctx.ui.notify(`${nextEnabled ? "Enabled" : "Disabled"} ${skill.name}. Run /reload to fully apply the change.`, "info");
  ```
  That is a user-facing toast, not a programmatic signal.

- The manager's own dialog stays consistent by calling `onRefresh → refreshRegistry` (i.e.
  re-reading from disk) after every toggle. There is no in-memory pub/sub.

**Implication for presets:** To react to a user toggling a skill, the presets package has
two options:

1. **Poll / re-read on demand.** Whenever the presets UI is opened (or a preset is about to
   be applied), call `loadSkillRegistry(cwd)` (or `SettingsManager`) fresh. This is exactly
   what the manager does and is the cheapest correct approach. Cache invalidation is
   trivial because the user must run `/reload` for toggle changes to take effect anyway
   (per the notify message above).
2. **Watch the settings file.** A `fs.watch` on `~/.pi/agent/settings.json` and
   `<project>/.pi/settings.json` could detect writes, but this is fragile (atomic renames,
   editor writes, cross-platform quirks) and unnecessary given option 1. Not recommended.

There is no third option via the manager today. If event-driven integration is desired, it
would require an upstream change to `pi-coding-agent`'s `ExtensionAPI` (e.g. a
`settings_changed` event) — out of scope for the presets package.

---

## 5. Coexistence — do both packages conflict on `/skill`? How is command namespace resolution done?

**Verdict: Yes, they conflict. The manager owns `/skill`; a second `registerCommand("skill")`
would collide. Use a distinct command name and a `preset:` sub-namespace, mirroring the
manager's own `skill:` convention.**

### 5a. What the manager registers

From `skills-manager.ts` (enabled branch):

```ts
pi.registerCommand("skill", {
  description: "Pi skills manager view. Native skills remain /skill:name.",
  handler: async (args, ctx) => { … },
});
```

And, only when the manager is **disabled** (`settingBoolean("enabled", true) === false`), it
instead registers a recovery pair:

```ts
pi.registerCommand("skill", { … });                 // recovery: only handles "enable"
pi.registerCommand("skill:enable", { … });
```

So in the normal (enabled) case, the manager claims the **bare `/skill`** command (no args
→ opens the dialog; `enable`/`disable` subcommands; anything else → warning). It does
**not** register `/skill:<name>` — those are Pi-core *native skill invocation* commands,
dispatched by the agent itself when a user types `/skill:react-review` etc. The manager's
own description makes this explicit: *"Native skills remain /skill:name."*

### 5b. Namespace resolution model

The command naming convention visible across this codebase is **colon-segmented**:

- `skill` — the manager's dialog (bare command).
- `skill:enable` — a subcommand registered by `pi.registerCommand("skill:enable", …)`.
- `skill:<name>` — native skill invocation, owned by Pi core, **not** by
  `registerCommand`. The manager never registers these; it inserts them into the editor via
  `ctx.ui.pasteToEditor(\`/skill:${skill.name}\n\`)` (see `insertNativeSkillCommand`).

`pi.registerCommand(name, …)` takes a single string `name`. There is no first-class
"namespace" object; the colon is a **convention**, and the bare `skill` name is just one
entry. Two extensions calling `pi.registerCommand("skill", …)` both target the same
command name. The `ExtensionAPI` type itself is not shipped in this node_modules tree (it
lives in the Pi agent binary / `@earendil-works/pi-coding-agent`), so the exact
conflict-resolution policy (last-wins vs. error) cannot be confirmed from this package
alone — but regardless of policy, registering the same name from two packages is a conflict
by construction and must be avoided.

### 5c. The manager's self-install guard is NOT a cross-package guard

The manager prevents *itself* from double-installing via a shared symbol
(`skills-manager.ts` + `constants.ts`):

```ts
const guard = pi as unknown as Record<PropertyKey, unknown>;
if (guard[INSTALL_SYMBOL]) return;
guard[INSTALL_SYMBOL] = true;
```
where `INSTALL_SYMBOL = Symbol.for("vstack.pi-skills-manager.installed")`.

This guards against the manager's own module being evaluated twice in the same process
(e.g. installed both globally and per-project). It does **not** prevent a different package
from registering `skill`. So our presets package must not rely on this guard for
coexistence.

### 5d. Recommended coexistence strategy

- **Do not register `skill`.** Let the manager own `/skill` and `/skill:enable`/`/skill:disable`.
- Register **`preset`** as the presets package's bare command (opens the presets dialog),
  and use the **`preset:`** colon-namespace for subcommands, mirroring the manager's
  `skill:` convention:
  - `preset` — open the presets manager dialog.
  - `preset:apply <name>` — apply a preset.
  - `preset:save <name>` — save current skill configuration as a preset.
  - `preset:list` — list presets.
  - `preset:enable` / `preset:disable` — recovery commands if the presets package has its
    own `enabled` setting (recommended, see below).
- If the presets package is **not** installed, `/preset*` simply does not exist — no
  conflict with the manager. If the manager is **not** installed, the presets package still
  works standalone (it just won't be reachable from inside the manager's dialog; see §1).
- Optionally, declare a `vstack.extensionManager` settings schema in the presets
  `package.json` (mirroring the manager's) with an `enabled` boolean and `apply: "reload"`,
  and register a `preset:enable` recovery command when disabled — exactly the pattern the
  manager uses in its disabled branch. This gives operators a uniform enable/disable UX
  across both packages.

---

## 6. Summary & recommendations for the presets package

| Question | Answer | Action for presets |
|---|---|---|
| 1. Add a 'Presets' tab to `/skill`? | **No.** Dialog is a non-exported, non-extensible class. | Render a **separate** `/preset` overlay via `ctx.ui.custom(...)`. |
| 2. Call `loadSkillRegistry(cwd)`? | Works, but it's an **internal** module; couples to manager version. | Prefer building `SettingsManager` + `DefaultPackageManager` from `@earendil-works/pi-coding-agent` directly; fall back to importing `registry.js` only if needed, pinned. |
| 3. Read enabled/disabled state? | State = `+`/`-` patterns in `settings.json` `skills`/`packages` arrays. | Read via `SettingsManager.getGlobalSettings()`/`getProjectSettings()`. **Never** overwrite a user's `-` with `+` when applying a preset — gate on current state. |
| 4. Event hooks on toggle? | **None.** Manager is pull-only (`session_start` + on-demand re-read). | Re-read settings on every preset open/apply; do not subscribe to nonexistent events. |
| 5. Conflict on `/skill`? | **Yes.** Manager owns `/skill`; double registration collides. | Register **`preset`** + `preset:*` subcommands; leave `skill`/`skill:*` to the manager and Pi core. |

### Suggested presets package skeleton (integration-relevant parts)

```ts
// extensions/presets.ts
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, SettingsManager, DefaultPackageManager } from "@earendil-works/pi-coding-agent";

export default function presets(pi: ExtensionAPI): void {
  pi.registerCommand("preset", {
    description: "Presets manager view.",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) { ctx.ui.notify("/preset requires interactive mode", "warning"); return; }
      // Re-read skill state fresh every time (see §4: no events).
      const registry = await readSkillState(ctx);
      // …render own overlay via ctx.ui.custom(...) (see §1)…
    },
  });
  pi.registerCommand("preset:apply", { /* … */ });
  pi.registerCommand("preset:save",  { /* … */ });
  pi.on("session_start", async (_e, ctx) => { /* record trust, warm cache */ });
}

// Reads enabled/disabled state WITHOUT importing the manager's internals.
async function readSkillState(ctx: ExtensionContext) {
  const projectTrusted = ctx.isProjectTrusted?.() ?? false;
  const sm = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted });
  const pm = new DefaultPackageManager({ cwd: ctx.cwd, agentDir: getAgentDir(), settingsManager: sm });
  const resolved = await pm.resolve();
  // resolved.skills[i].enabled + .path + .metadata.scope/origin/source
  return resolved;
}
```

This keeps the presets package decoupled from the manager's private modules, coexists
cleanly on the command namespace, respects user toggles, and re-reads state on demand
because no events are available.

### Residual risks / open items

- **`ExtensionAPI` / `SettingsManager` / `DefaultPackageManager` exact signatures** could
  not be verified from type declarations in this node_modules tree (the
  `@earendil-works/pi-coding-agent` package is not present as a separate installable here;
  it is bundled into the Pi agent binary). The signatures used above are inferred from how
  the skills-manager source calls them. Confirm against the real `.d.ts` shipped with the
  Pi agent before relying on them.
- **Command conflict resolution policy** (last-wins vs. throw) is also unconfirmed from
  this package alone; the safe assumption — "don't register a name another package owns" —
  holds either way.
- **`projectSettingsTrusted` timing:** the manager populates trust on its own
  `session_start`. If the presets package's `session_start` runs first, project-scoped
  settings may be invisible until the manager's handler fires. Call `recordProjectTrust`
  (or `ctx.isProjectTrusted?.()`) explicitly before reading settings.
- **Deep-importing `registry.js`/`toggle.js`** from the manager is possible but unsupported;
  prefer the stable `@earendil-works/pi-coding-agent` primitives.