---
description: "Generate structured JSON output with schema validation. Use when the task requires deterministic, reusable, schema-validated JSON in a file — instead of relying on the LLM's natural language response."
---

# pi-json-output

This package registers the `json_write` tool — a Pi tool that calls DeepSeek API directly with `response_format: { type: "json_object" }` and produces schema-validated JSON files.

## When to use

- **Deterministic structured data** — you need JSON output that follows a specific schema
- **Reusable artifacts** — the output needs to be saved to a file for later use or sharing
- **Schema enforcement** — the LLM's freeform JSON in assistant text is unreliable; `json_write` validates output against a JSON Schema before writing

## Tool: `json_write`

| Parameter | Required | Description |
|-----------|----------|-------------|
| `path` | ✅ | Output file path (relative to session cwd or absolute) |
| `schema` | ✅ | JSON Schema (draft-07) defining output structure |
| `instruction` | ✅ | Natural language: what to generate, referencing session context |

### System prompt used

The tool sends to DeepSeek:

```text
You are a precise JSON output generator.
Output valid JSON according to this schema:
{schema}
Your response must be pure JSON. Do not include markdown fences, or explanation text.
```

### Error handling

- **Network failure** — exponential backoff with jitter, retries 2× on each model
- **Model fallback** — `deepseek-v4-flash` first, `deepseek-chat` on persistent failure
- **Invalid JSON** — one auto-retry with corrective prompt
- **Schema violation** — throws error with details
- **Missing API key** — clear error: set `DEEPSEEK_API_KEY` or login via `/login deepseek`

### Model selection

Default: `deepseek-v4-flash` (cheapest). Falls back to `deepseek-chat` on failure. Always uses `response_format: { type: "json_object" }` and `temperature: 0` for deterministic output.

## Prerequisites

```bash
export DEEPSEEK_API_KEY=sk-...
# Or: `/login deepseek` inside Pi
```

## API key resolution order

1. `DEEPSEEK_API_KEY` environment variable
2. Pi auth.json (`~/.pi/agent/auth.json` → `deepseek` key)