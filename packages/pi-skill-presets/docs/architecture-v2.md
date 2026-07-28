# Architecture v2: System Prompt Filtering + Transient Injection

## 1. Overview

The v2 redesign of pi-skill-presets replaces the `settings.skills` write approach with **`before_agent_start` system prompt filtering**. The preset system no longer touches `settings.json`.

### What v2 achieves

- **Default preset + active set skills appear in system prompt's `<available_skills>`** — controlled by filtering, not by writing config files.
- **Mid-session preset loads use transient injection** — appended to messages array end, preserving KV cache.
- **Session start / reload reconstructs active set from persistent entries** — loaded presets survive restart.
- **Zero `settings.json` side effects** — preset system is read-only on config; skill-manager owns `+`/`-` exclusively.

### Two loading paths

| Timing | Mechanism | KV cache | Skills included |
|---|---|---|---|
| Session start / reload | `before_agent_start` filters `<available_skills>` | Rebuilt (inherent cost) | default + active set |
| Mid-session (`/preset-load`) | `context` event transient injection | Preserved (append-only) | new preset only |

---

## 2. Module Structure

### Files removed

| File | Reason |
|---|---|
| `src/default-preset.ts` | Replaced by `before_agent_start` filtering. No more `settings.skills` writes. |

### Files modified

| File | Changes |
|---|---|
| `index.ts` | Remove `applyDefaultPreset` import/call. Add `before_agent_start` handler. Add `needsFilter` flag. Default preset is always loaded into active set at `session_start`. |
| `src/injector.ts` | Exclude ALL active set skills from injection (not just default preset). Since active set skills are now in system prompt, injecting them again would be redundant. Only inject skills from presets loaded mid-session that weren't present at last `before_agent_start` filter. |
| `src/preset-state.ts` | `resolveSkills` no longer excludes default preset — default is in active set. Add method `getActiveSkillNames(config)` returning all skill names from active set. |
| `src/skill-resolver.ts` | `getSystemPromptSkillNames` now returns ALL active set skill names (not just default). Remove `resolveSkills` function (no longer needed for injection — replaced by `filterSkills` for system prompt filtering). Add `filterSystemPromptSkills(allSkills, allowedNames, disabledPatterns)`. |
| `src/types.ts` | Update `PresetsConfig.default` comment (no longer "via settings.skills"). |
| `src/commands.ts` | `/preset-load` sets `needsFilter = false` — mid-session loads use injection only. `/preset-off` may need to trigger reload if the offloaded preset was in system prompt. |
| `src/dialog.ts` | Same as commands — toggling sets `needsFilter` state correctly. |
| `CONTEXT.md` | Update glossary: "Default preset" no longer writes to settings.skills. "Active set" now includes default. Add "System prompt filtering" term. |

### Files added

| File | Purpose |
|---|---|
| `src/prompt-filter.ts` | New module: `before_agent_start` handler. Filters `systemPromptOptions.skills` to active set, rebuilds `<available_skills>` section using `formatSkillsForPrompt`, replaces it in the system prompt string. |

### Files unchanged

| File | Reason |
|---|---|
| `src/config.ts` | `readPresetsConfig` still reads presets from settings.json. `writePresetsConfig` still used by dialog editing. No `settings.skills` interaction. |
| `test/config.test.ts` | Config tests unaffected. |
| `test/preset-state.test.ts` | Minor updates: default preset now in active set. |
| `test/skill-resolver.test.ts` | `filterSkills` pure function tests still valid. |

---

## 3. Event Flow Diagrams

### 3.1 Session start / reload flow

```
User starts session (or /reload)
        │
        ▼
┌─────────────────────────────────┐
│  session_start event             │
│  ┌─────────────────────────────┐ │
│  │ 1. Read presets config       │ │
│  │ 2. Load default preset into  │ │
│  │    active set (always)       │ │
│  │ 3. Replay preset-op entries  │ │
│  │    from sessionManager       │ │
│  │ 4. Set needsFilter = true    │ │
│  └─────────────────────────────┘ │
└─────────────────────────────────┘
        │
        ▼  (user sends first message)
┌─────────────────────────────────┐
│  before_agent_start event        │
│  ┌─────────────────────────────┐ │
│  │ needsFilter == true:         │ │
│  │ 1. Get all skill names from  │ │
│  │    active set                │ │
│  │ 2. Filter systemPromptOptions│ │
│  │    .skills to those names    │ │
│  │ 3. Rebuild <available_skills>│ │
│  │    via formatSkillsForPrompt │ │
│  │ 4. Replace section in        │ │
│  │    event.systemPrompt        │ │
│  │ 5. Return modified prompt    │ │
│  │ 6. Set needsFilter = false   │ │
│  └─────────────────────────────┘ │
└─────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────┐
│  context event                   │
│  ┌─────────────────────────────┐ │
│  │ Active set skills already   │ │
│  │ in system prompt → skip     │ │
│  │ injection (nothing to add)  │ │
│  └─────────────────────────────┘ │
└─────────────────────────────────┘
        │
        ▼
   LLM request (filtered system prompt + messages)
```

### 3.2 Mid-session preset load flow

```
User: /preset-load ddd
        │
        ▼
┌─────────────────────────────────┐
│  presetLoadCommand               │
│  ┌─────────────────────────────┐ │
│  │ 1. state.load("ddd")        │ │
│  │ 2. appendEntry("preset-op") │ │
│  │ 3. needsFilter stays false  │ │
│  │    (do NOT trigger filter)  │ │
│  └─────────────────────────────┘ │
└─────────────────────────────────┘
        │
        ▼  (user sends next message)
┌─────────────────────────────────┐
│  before_agent_start event        │
│  ┌─────────────────────────────┐ │
│  │ needsFilter == false:        │ │
│  │ → return undefined           │ │
│  │ → pi uses _baseSystemPrompt  │ │
│  │   (unchanged, KV cache OK)   │ │
│  └─────────────────────────────┘ │
└─────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────┐
│  context event                   │
│  ┌─────────────────────────────┐ │
│  │ 1. Resolve active set:       │ │
│  │    {engineer, ddd}           │ │
│  │ 2. System prompt skills =    │ │
│  │    {engineer skills}         │ │
│  │ 3. Inject only ddd skills    │ │
│  │    (not in system prompt)    │ │
│  │ 4. Append as CustomMessage   │ │
│  └─────────────────────────────┘ │
└─────────────────────────────────┘
        │
        ▼
   LLM request (unchanged system prompt + messages + ddd skills appended)
```

### 3.3 Reload after mid-session load

```
User: /preset-load ddd  →  ...  →  /reload
        │
        ▼
┌─────────────────────────────────┐
│  session_start (reason: reload)  │
│  ┌─────────────────────────────┐ │
│  │ 1. Clear active set          │ │
│  │ 2. Load default preset       │ │
│  │ 3. Replay entries:           │ │
│  │    load ddd → active={eng,ddd}│ │
│  │ 4. needsFilter = true        │ │
│  └─────────────────────────────┘ │
└─────────────────────────────────┘
        │
        ▼  (user sends message)
┌─────────────────────────────────┐
│  before_agent_start              │
│  ┌─────────────────────────────┐ │
│  │ needsFilter == true:         │ │
│  │ Filter to {engineer + ddd}   │ │
│  │ skills in <available_skills> │ │
│  │ needsFilter = false          │ │
│  └─────────────────────────────┘ │
└─────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────┐
│  context event                   │
│  │ All active set skills are in │ │
│  │ system prompt now → skip     │ │
│  └─────────────────────────────┘ │
└─────────────────────────────────┘
```

---

## 4. `before_agent_start` Filtering Algorithm

### Input

- `event.systemPrompt: string` — the fully assembled system prompt
- `event.systemPromptOptions.skills: Skill[]` — all skills pi loaded (from `resourceLoader.getSkills()`)
- Active set skill names (from `PresetState`)
- Disabled patterns from `settings.skills` (`-` prefixed entries)

### Algorithm

```
function filterSystemPrompt(event, activeSkillNames, disabledPatterns):
    // 1. Filter the skills array
    allowedSkills = event.systemPromptOptions.skills.filter(skill =>
        activeSkillNames.has(skill.name)          // must be in active set
        && !isDisabled(skill.name, disabledPatterns)  // respect skill-manager
        && !skill.disableModelInvocation           // respect pi's own flag
    )

    // 2. If no change needed, return undefined (preserve KV cache)
    currentSkillNames = new Set(
        event.systemPromptOptions.skills
            .filter(s => !s.disableModelInvocation)
            .map(s => s.name)
    )
    if (setsEqual(currentSkillNames, new Set(allowedSkills.map(s => s.name)))):
        return undefined  // no filtering needed

    // 3. Rebuild the skills section
    newSkillsSection = formatSkillsForPrompt(allowedSkills)

    // 4. Replace in system prompt string
    // The skills section starts with "\n\nThe following skills..." 
    // and ends with "</available_skills>"
    // It appears AFTER context files and BEFORE "Current working directory:"
    
    // Strategy: find "<available_skills>" ... "</available_skills>" block
    // and the preceding header lines, replace the whole section
    
    oldSectionPattern = /\n\nThe following skills provide specialized instructions.*?<\/available_skills>/s
    if (newSkillsSection):
        modifiedPrompt = event.systemPrompt.replace(oldSectionPattern, newSkillsSection)
    else:
        // No skills to show — remove the entire section
        modifiedPrompt = event.systemPrompt.replace(oldSectionPattern, "")
    
    return modifiedPrompt
```

### Edge cases

- **No active set skills**: Remove the entire `<available_skills>` section from the system prompt.
- **All skills already match**: Return `undefined` to avoid unnecessary string replacement.
- **Skills with `disable-model-invocation: true`**: Already excluded by `formatSkillsForPrompt`, but we also filter them in step 1 for the equality check.
- **Regex failure**: If the regex doesn't match (pi format changed), return `undefined` (fail safe — don't break the system prompt).

---

## 5. Active Set Lifecycle

### Initialization (session_start)

```
session_start:
    config = readPresetsConfig(cwd)
    state.clear()
    
    // Default preset is always in active set
    if config.default:
        state.load(config.default)
    
    // Replay persistent entries for non-default presets
    entries = sessionManager.getEntries()
        .filter(e => e.customType === "preset-op")
    
    state.replayEntries(entries)
    // After replay: active set = {default} ∪ {presets loaded but not offloaded}
    
    needsFilter = true
```

### Modification (commands)

| Command | Effect on active set | `needsFilter` |
|---|---|---|
| `/preset-load ddd` | `state.load("ddd")` | Stays `false` (injection path) |
| `/preset-off ddd` | `state.offload("ddd")` | Stays `false` (injection stops naturally) |
| Dialog toggle on | `state.load(name)` | Stays `false` |
| Dialog toggle off | `state.offload(name)` | Stays `false` |

### Usage

1. **`before_agent_start`** (when `needsFilter == true`): `state.getActiveSkillNames(config)` → filter system prompt
2. **`context` event** (every turn): `state.resolveSkills(config)` → determine which skills to inject (exclude those already in system prompt)

### `getActiveSkillNames` method (new)

```typescript
getActiveSkillNames(config: PresetsConfig): Set<string> {
    const names = new Set<string>();
    for (const presetName of this.activePresets) {
        const skills = getPresetSkills(config, presetName);
        if (skills) {
            for (const s of skills) names.add(s);
        }
    }
    return names;
}
```

---

## 6. Transient Injection (Context Event)

### What changes from v1

In v1, the injector excluded only the default preset's skills. In v2, the injector excludes **all skills that were in the system prompt at last `before_agent_start` filter**.

### `systemPromptSkills` tracking

```typescript
// In index.ts module scope:
let systemPromptSkillNames: Set<string> = new Set();

// In before_agent_start handler (when needsFilter == true):
systemPromptSkillNames = state.getActiveSkillNames(config);
// ... filter system prompt ...

// In context event handler:
const injector = createInjector(state, config, cwd, ctx, systemPromptSkillNames);
```

### Injector logic (v2)

```
function inject(messages, state, config, systemPromptSkillNames):
    // 1. Get ALL active set skill names
    allActiveSkillNames = state.getActiveSkillNames(config)
    
    // 2. Determine which skills to inject (not in system prompt)
    injectSkillNames = allActiveSkillNames - systemPromptSkillNames
    
    // 3. If nothing to inject, return unchanged
    if injectSkillNames is empty:
        return { messages }
    
    // 4. Resolve to Skill objects, filter disabled/missing
    { skills, missing, disabled } = resolveSkills(cwd, injectSkillNames, excludedSet)
    
    // 5. Format and append
    skillsBlock = formatSkills(skills)
    return { messages: [...messages, customMessage(skillsBlock)] }
```

### Example

- Session start: active set = {engineer}, system prompt filtered to engineer skills. `systemPromptSkillNames = {ask-matt, code-review, ...}` (17 engineer skills).
- User `/preset-load ddd`: active set = {engineer, ddd}. `needsFilter` stays false.
- Next message: context event → `allActiveSkillNames = {engineer ∪ ddd skills}`. `injectSkillNames = ddd skills` (engineer skills excluded because they're in `systemPromptSkillNames`). Inject ddd skills as CustomMessage.

---

## 7. Skill-Manager Compatibility

### How filtering respects `-` patterns

The `before_agent_start` filter reads disabled patterns from `settings.skills`:

```typescript
const settingsManager = SettingsManager.create(cwd, agentDir);
const settings = settingsManager.getGlobalSettings();
const projectSettings = settingsManager.getProjectSettings();

const disabledPatterns = [
    ...(settings.skills ?? []),
    ...(projectSettings.skills ?? []),
].filter(p => p.startsWith("-"));
```

Skills matching disabled patterns (by name or path suffix) are excluded from the filtered `<available_skills>`.

### Decoupling

| Concern | Owner |
|---|---|
| `settings.skills` `+`/`-` toggle | skill-manager |
| `<available_skills>` filtering | skill-presets (`before_agent_start`) |
| Preset definitions (`presets` in settings.json) | skill-presets (read-only) |
| Skill files in `~/.pi/agent/skills/` | pi (resource loader) |

The preset system never writes to `settings.skills`. It only reads `settings.skills` to check `-` patterns for filtering.

---

## 8. KV Cache Preservation

### Why this design preserves cache

**System prompt stability within a session:**

- `before_agent_start` only returns a modified `systemPrompt` when `needsFilter == true`.
- `needsFilter` is set to `true` only by `session_start` (which fires on new session, resume, fork, or reload).
- After the first `before_agent_start` in a session, `needsFilter` becomes `false`.
- All subsequent `before_agent_start` calls return `undefined` → pi uses `_baseSystemPrompt` (unchanged) → KV cache hit.

**Transient injection at message array end:**

- Mid-session `/preset-load` does not change the system prompt.
- New skills are appended as a `CustomMessage` at the end of the messages array.
- The prefix (system prompt + prior messages) is unchanged → KV cache hit.

**Reload is inherently cache-breaking:**

- `/reload` rebuilds the system prompt from scratch (`_rebuildSystemPrompt`).
- KV cache would be invalidated regardless of our extension.
- Our `before_agent_start` filter runs on the first message after reload, producing a consistent filtered prompt. The cost is the same as any reload.

### Cache invalidation timeline

```
Session start:    KV cache MISS (first request) → build cache
Subsequent turns: KV cache HIT (system prompt unchanged, injection appended)
/preset-load:     KV cache HIT (system prompt unchanged, injection appended)
/reload:          KV cache MISS (system prompt rebuilt) → rebuild cache
After reload:     KV cache HIT (system prompt stable again)
```

---

## 9. Migration from v1

### What's removed

1. **`src/default-preset.ts`** — entire file deleted. No more `applyDefaultPreset()` function.
2. **`settings.skills` writing** — `SettingsManager.setSkillPaths()` and `flush()` calls removed.
3. **`getSystemPromptSkillNames` returning only default preset** — replaced by tracking `systemPromptSkillNames` from `before_agent_start`.

### What's added

1. **`src/prompt-filter.ts`** — new module with `createPromptFilter()` function.
2. **`before_agent_start` event handler** in `index.ts`.
3. **`needsFilter` flag** in module scope.
4. **`systemPromptSkillNames` tracking** in module scope.
5. **`getActiveSkillNames()` method** on `PresetState`.

### What stays

1. **`PresetState` core logic** — active set, load/offload, replay entries.
2. **Transient injection via `context` event** — same mechanism, updated exclusion logic.
3. **Persistent entries (`preset-op`)** — same format, same replay logic.
4. **Commands** (`/preset`, `/preset-load`, `/preset-off`, `/preset-status`, `/preset-prompt`).
5. **TUI dialog** — unchanged.
6. **Config reading** (`readPresetsConfig`) — unchanged.
7. **`filterSkills` pure function** — reused for both system prompt filtering and injection.
8. **`formatSkillsForPrompt`** — pi's own function, used to rebuild the `<available_skills>` section.

### Migration steps

1. Delete `src/default-preset.ts`.
2. Create `src/prompt-filter.ts`.
3. Update `index.ts`: remove `applyDefaultPreset` import, add `before_agent_start` handler, add `needsFilter` and `systemPromptSkillNames` state, load default preset into active set at `session_start`.
4. Update `src/preset-state.ts`: add `getActiveSkillNames()`, update `resolveSkills()` to not exclude default (default is now in active set).
5. Update `src/injector.ts`: accept `systemPromptSkillNames: Set<string>` instead of `defaultPreset?: string`. Exclude all system prompt skills, not just default.
6. Update `src/skill-resolver.ts`: update `getSystemPromptSkillNames` or remove (replaced by module-scope tracking).
7. Update tests.
8. Update `CONTEXT.md` glossary.
