# skill-presets

Prefix-cache-aware dynamic skill loading via named presets for [pi](https://github.com/earendil-works/pi-coding-agent).

## How it works

- **Default preset** → loaded into the system prompt via `settings.skills` (persistent, all sessions)
- **Non-default presets** → loaded via transient injection through the `context` event (session-level, per-turn)
- **Restart recovery** → load/offload operations persisted as custom entries, replayed on session start
- **Cache-friendly** → transient injection appends at the end of the message array, preserving prefix cache

## Coexistence with pi-skills-manager

This package coexists with `@vanillagreen/pi-skills-manager`:

- Separate command namespace: `/preset*` vs `/skill*`
- Respects skill-manager's `+`/`-` toggle state — disabled skills are never re-enabled
- Uses `SettingsManager` to read toggle state (does not import skill-manager internals)

## Configuration

Add a `presets` field to your `settings.json` (`~/.pi/agent/settings.json` or `<project>/.pi/settings.json`):

```jsonc
{
  "presets": {
    "default": "engineer",
    "definitions": {
      "engineer": {
        "skills": [
          "ask-matt", "codebase-design", "code-review",
          "diagnosing-bugs", "domain-modeling", "grill-with-docs",
          "implement", "improve-codebase-architecture",
          "prototype", "research", "resolving-merge-conflicts",
          "setup-matt-pocock-skills", "tdd", "to-spec",
          "to-tickets", "triage", "wayfinder"
        ]
      },
      "ddd": {
        "skills": [
          "ddd-aggregates", "ddd-context-map", "ddd-contexts",
          "ddd-discover", "ddd-domain-interactions",
          "ddd-model-review", "ddd-openspec-bridge",
          "ddd-scope", "ddd-subdomains",
          "domain-modeling", "ubiquitous-language"
        ]
      },
      "go": {
        "skills": [
          "go", "cobra-viper", "fileflow-pathologize",
          "go-release", "go-spec-reviewer",
          "clean-architecture", "concurrency-safety",
          "design-patterns", "error-handling", "idiomatic-go",
          "golang-fullstack-best-practices",
          "write-gomega-matcher"
        ]
      },
      "frontend": {
        "skills": [
          "frontend-design", "impeccable",
          "make-interfaces-feel-better",
          "web-design-guidelines", "html-review"
        ]
      }
    }
  }
}
```

### Skill sources

| Preset | Source |
|---|---|
| engineer | [matt-pocock](https://github.com/total-typescript/ts-morph-skills) engineering category |
| ddd | [ForceInjection/domain-driven-design-skills](https://github.com/ForceInjection/domain-driven-design-skills) + matt-pocock DDD skills |
| go | [spf13/go-skills](https://github.com/spf13/go-skills) + [saifoelloh/golang-best-practices-skill](https://github.com/saifoelloh/golang-best-practices-skill) |
| frontend | Frontend design/review skills |

These are examples — adjust to match your installed skills.

## Commands

| Command | Description |
|---|---|
| `/preset` | Open TUI dialog to browse, toggle, and edit presets |
| `/preset-load <name>` | Load a preset by name |
| `/preset-off <name>` | Offload a preset by name |
| `/preset-status` | Show current active set status |

## TUI Dialog (`/preset`)

The dialog has four modes:

### Browse mode (default)
- `↑↓` — navigate presets
- `Space` — toggle load/offload
- `e` — edit selected preset (add/remove skills, delete preset)
- `n` — create a new preset
- `Esc` — quit

### Preset-edit mode
- `↑↓` — navigate skills in the preset
- `a` — add a skill (opens skill-list mode)
- `⌫ Backspace` — remove selected skill from preset
- `d` — delete the entire preset
- `Esc` — back to browse

### Skill-list mode
- `↑↓` — navigate all available skills (with truncated descriptions)
- `Enter` — add selected skill to the preset
- `Esc` — back to preset-edit

### New-preset mode
- Type a name (lowercase letters, numbers, hyphens)
- `Enter` — create and enter edit mode
- `Esc` — cancel

Changes are written to `settings.json` immediately.

## Install

```sh
pi install ./pi-skill-presets  # from ~/projects/pi-mypackage
```

## Development

```sh
cd packages/skill-presets
npx tsc --noEmit   # typecheck
npx vitest run     # tests
```
