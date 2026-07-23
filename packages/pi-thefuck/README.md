# pi-thefuck

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> [中文文档](./docs/README.zh.md) · English

**Undo the last failed tool call in [pi agent](https://github.com/badlogic/pi-mono/), like [thefuck](https://github.com/nvbn/thefuck).**

When an LLM-generated tool call fails (bash command error, read on a directory, etc.), invoke `/fuck` to remove the failed call from context and let the agent retry automatically.

## Installation

```bash
pi install npm:pi-thefuck
```

Or try without installing:

```bash
pi -e /path/to/pi-thefuck/index.ts
```

Restart or `/reload` after installing.

## Usage

### `/fuck` command

When the agent responds with a failed tool call, type:

```
/fuck
```

The failed tool call is removed from the LLM's context and the agent retries automatically.

### Double-tap `f` shortcut

With an **empty chat editor**, press `f` twice within ~300ms. Equivalent to `/fuck`.

Only fires when the agent is idle. A single `f` enters the character normally.

### Example

```
assistant: Let me check the project...
  toolCall: read(path="issues/")     ← EISDIR — it's a directory
  ↓
  toolResult(read, isError: true)    ← failed!

→ /fuck

assistant: Oops, that's a directory. Let me list it instead.
  toolCall: bash("ls issues/")
  ↓
  toolResult(bash, ok)               ← works now
```

## Features

| Feature | Description |
|---------|-------------|
| **Unobtrusive** | Session file is never modified — only filtered from LLM context |
| **Batch-scoped** | Only cancels failures in the most recent assistant response — won't reach across turns |
| **One at a time** | Multiple failures need multiple `/fuck`, one per call — like thefuck |
| **Idempotent** | Re-fucking the same call is a no-op |
| **Sibling-safe** | Parallel tool calls that succeeded are preserved |
| **Conflict-free** | Uses double-tap `f` — doesn't interfere with built-in shortcuts |

## How it works

pi-thefuck uses pi's extension `context` event to filter messages before they reach the LLM:

1. Finds the **last assistant message with tool calls** in the current branch
2. Checks if any tool results from that batch have `isError: true`
3. If found, removes that toolCall + toolResult from the context array
4. Sends an invisible `Continue` signal to trigger retry

The session JSONL file on disk is never touched. All filtering happens in memory, per-turn.

## Compatible with pi-bump

Both extensions work together without conflict:

| | pi-bump | pi-thefuck |
|---|---|---|
| Shortcut | Double-tap Enter | Double-tap `f` |
| What it does | Makes the agent continue | Undoes a failed tool call |
| When to use | Agent is stuck | Agent made an error |

## Acknowledgments

- [thefuck](https://github.com/nvbn/thefuck) — the original command-correction tool that inspired this project
- [pi-bump](https://github.com/alexleekt/pi-bump) — `ctx.ui.onTerminalInput()` double-tap pattern reused here for the `f` shortcut

## License

MIT