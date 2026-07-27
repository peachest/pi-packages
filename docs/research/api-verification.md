# API Verification (Review Gap 3.3/3.4/3.5)

## 3.3 formatSkillsForPrompt — VERIFIED ✅

```typescript
// From @earendil-works/pi-coding-agent/dist/core/skills.d.ts
export declare function formatSkillsForPrompt(skills: Skill[]): string;
```

- **Input**: `Skill[]` — array of `Skill` objects with `{ name, description, filePath, baseDir, sourceInfo, disableModelInvocation }`
- **Output**: `string` — XML-formatted `<available_skills>` block
- **Exported from**: `@earendil-works/pi-coding-agent` (confirmed in `dist/index.d.ts` line 18)
- **Usage**: `const skillsBlock = formatSkillsForPrompt(activeSkills)` → put into `CustomMessage.content`
- **Compatible with**: `loadSkills()` which returns `LoadSkillsResult { skills: Skill[], diagnostics }`

## 3.4 Settings.json write API — VERIFIED ✅

`SettingsManager` does NOT have a generic setter for custom fields like `presets`. Two options:

### Option A: `withLock` (recommended)
```typescript
// withLock gives raw JSON string access
settingsManager.withLock("global", (current) => {
  const json = current ? JSON.parse(current) : {};
  json.presets = { default: "engineer", definitions: { ... } };
  return JSON.stringify(json, null, 2);
});
await settingsManager.flush();
```

### Option B: Direct file I/O (like pi-skills-manager does)
pi-skills-manager's `settings.ts` uses `readFileSync`/`writeFileSync` directly on `settings.json` — NOT `SettingsManager.withLock`. This is the proven pattern in the ecosystem.

For the presets package: use direct file I/O for writing the `presets` field (following pi-skills-manager's pattern), and use `SettingsManager` for reading skill toggle state.

## 3.5 ctx.reload() — VERIFIED ✅

```typescript
// From types.d.ts line 275
// ExtensionCommandContext extends ExtensionContext
reload(): Promise<void>;
```

- Available on `ExtensionCommandContext` (command handlers), NOT on `ExtensionContext` (event handlers)
- Description: "Reload extensions, skills, prompts, and themes."
- Usage in command handler: `await ctx.reload()`
- Note: `reload()` is on `ExtensionCommandContext`, which is passed to `registerCommand` handlers. It is NOT available in `session_start` or `context` event handlers (those get `ExtensionContext`).

## 3.4 supplemental: setSkillPaths / setPackages — VERIFIED ✅

For writing default preset skills to `settings.skills`:
```typescript
setSkillPaths(paths: string[]): void;           // global scope
setProjectSkillPaths(paths: string[]): void;     // project scope
setPackages(packages: PackageSource[]): void;
setProjectPackages(packages: PackageSource[]): void;
```
All followed by `await settingsManager.flush()`.

## Summary

| API | Status | Notes |
|---|---|---|
| `formatSkillsForPrompt(skills: Skill[]): string` | ✅ Verified | Exported, takes Skill[], returns string |
| `loadSkills(): LoadSkillsResult` | ✅ Verified | Returns `{ skills: Skill[], diagnostics }` |
| `ctx.reload(): Promise<void>` | ✅ Verified | On ExtensionCommandContext (command handlers only) |
| `SettingsManager.setSkillPaths()` | ✅ Verified | For writing default preset skills |
| `SettingsManager.withLock()` | ✅ Verified | For writing custom `presets` field |
| Direct file I/O | ✅ Verified | pi-skills-manager pattern — proven alternative |
