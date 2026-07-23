> [中文文档](./docs/README.zh.md) · English

# pi-json-output

A Pi extension that provides the `json_write` tool — generate schema-validated JSON output via DeepSeek API with `response_format: { type: "json_object" }` support.

## Install

```bash
pi install npm:pi-json-output
# Or from local:
pi install /path/to/pi-json-output
```

## Usage

The LLM calls `json_write` automatically when it needs structured JSON output:

```text
json_write({
  path: "output/data.json",
  schema: '{"type":"object","properties":{"name":{"type":"string"},"score":{"type":"number"}},"required":["name","score"]}',
  instruction: "Generate a test result from the conversation"
})
```

Output: validated JSON written to the specified file.

## How it works

1. Tool receives path, schema, and instruction from the LLM
2. Constructs a system prompt with the schema
3. Calls DeepSeek Chat Completions API with `response_format: { type: "json_object" }`
4. Validates output: is it valid JSON? does it match the schema?
5. Writes to file
6. Returns file path and summary to the LLM

## Requirements

- `DEEPSEEK_API_KEY` environment variable, or login via `/login deepseek`