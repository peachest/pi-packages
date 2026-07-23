> [中文文档](./docs/README.zh.md) · English

# oh-my-pet

> A digital pet that lives in your codebase, growing from your AI agent usage.

One pet per project, shared across all contributors and all AI agent sessions (pi, Claude Code, etc.). No interruptions, just a little life in your status bar.

## How it works

Your pet grows from your coding activity:

- **`core.exp`** — experience points from output tokens (message volume)
- **`core.vitality`** — vitality from output token speed (tokens/sec)
- **`core.fullness`** — fullness from context usage percentage

Each pet session writes to an append-only binlog. Multiple agent sessions on the same project write concurrently without conflict. On startup, the framework replays binlog entries to compute the current pet state.

### Commands

| Command | Description |
|---------|-------------|
| `/pet`  | Show the pet dashboard — current attributes, level, and recent feeding history |

## Status bar

Your pet stays visible in the pi status bar:

```
🐶 Lv.3 [████░░░░░░] 42% 🏃28
```

No extra keystrokes needed — glance and go.

## Concepts

See [CONTEXT.md](./CONTEXT.md) for the full glossary (Pet, Mod, Binlog, Adaptor Layer, Attribute Policy, etc.).

## Install

```bash
pi install /path/to/oh-my-pet
```

## Development

```bash
npm test           # vitest run
npm run test:watch # vitest watch
npm run lint       # eslint
```
