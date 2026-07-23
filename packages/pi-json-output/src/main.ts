import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join, dirname, resolve, isAbsolute } from "node:path";

// ── Constants ───────────────────────────────────────────────

const API_BASE = "https://api.deepseek.com/chat/completions";
const MODELS = ["deepseek-v4-flash", "deepseek-chat"] as const;
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 1000;

// ── API key resolution ──────────────────────────────────────

async function readAuthJson(): Promise<Record<string, string>> {
  const authPath = join(
    process.env.HOME || process.env.USERPROFILE || "",
    ".pi/agent/auth.json"
  );
  try {
    return JSON.parse(await readFile(authPath, "utf-8"));
  } catch {
    return {};
  }
}

async function getDeepSeekApiKey(): Promise<string> {
  // 1) Environment variable (same as Pi uses)
  const envKey = process.env.DEEPSEEK_API_KEY;
  if (envKey) return envKey;

  // 2) Pi auth.json
  const auth = await readAuthJson();
  if (auth.deepseek) return auth.deepseek;

  throw new Error(
    "DeepSeek API key not found. Set DEEPSEEK_API_KEY environment variable " +
    "or login via `/login deepseek` in Pi."
  );
}

// ── DeepSeek API call ───────────────────────────────────────

interface DeepSeekMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface DeepSeekResponse {
  choices: Array<{
    message: { content: string | null };
    finish_reason: string;
  }>;
  error?: { message: string };
}

async function callDeepSeek(
  messages: DeepSeekMessage[],
  signal?: AbortSignal
): Promise<{ content: string; model: string }> {
  const apiKey = await getDeepSeekApiKey();
  let lastError: Error | null = null;

  for (const model of MODELS) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const body = JSON.stringify({
          model,
          messages,
          response_format: { type: "json_object" },
          stream: false,
          temperature: 0,
        });

        const resp = await fetch(API_BASE, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body,
          signal,
        });

        if (!resp.ok) {
          const errBody = await resp.text().catch(() => "");
          // Rate limit → retry with backoff
          if (resp.status === 429 || resp.status >= 500) {
            throw new Error(`HTTP ${resp.status}: ${errBody.slice(0, 200)}`);
          }
          // Other errors (auth, bad request) → fail fast
          throw new Error(
            `DeepSeek API error (${resp.status}): ${errBody.slice(0, 200)}`
          );
        }

        const data = (await resp.json()) as DeepSeekResponse;

        if (data.error) {
          throw new Error(`DeepSeek API error: ${data.error.message}`);
        }

        const choice = data.choices?.[0];
        if (!choice) {
          throw new Error("DeepSeek returned empty choices");
        }

        return {
          content: choice.message.content ?? "",
          model,
        };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Don't retry on auth errors
        if (
          lastError.message.includes("401") ||
          lastError.message.includes("Authentication")
        ) {
          throw lastError;
        }

        // Abort signal → fail fast
        if (signal?.aborted) throw lastError;

        // Last attempt on last model: throw
        if (
          attempt === MAX_RETRIES &&
          model === MODELS[MODELS.length - 1]
        ) {
          throw lastError;
        }

        // Backoff with jitter
        const delay =
          RETRY_BASE_MS * Math.pow(2, attempt) +
          Math.random() * RETRY_BASE_MS;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw lastError ?? new Error("DeepSeek API call failed");
}

// ── Schema validation ───────────────────────────────────────

function validateAgainstSchema(data: unknown, schemaStr: string): void {
  let schema: Record<string, unknown>;
  try {
    schema = JSON.parse(schemaStr);
  } catch {
    throw new Error("schema is not valid JSON");
  }

  // Simple built-in validation (no Ajv dependency — ponytail)
  // Covers: type check, required fields (1-level), enum, nested object.
  // Skipped: array items, string minLength/maxLength/pattern, number minimum/maximum.
  if (typeof schema === "object" && schema !== null) {
    const type = schema.type as string | undefined;

    // Type check: typeof can't distinguish array vs object, handle separately
    if (type) {
      if (type === "array") {
        if (!Array.isArray(data)) {
          throw new Error(`Schema requires type "array" but got ${typeof data}`);
        }
      } else if (typeof data !== type) {
        throw new Error(`Schema requires type "${type}" but got ${typeof data}`);
      }
    }

    // Required fields (object only)
    if (type === "object" || (!type && typeof data === "object" && !Array.isArray(data) && data !== null)) {
      const required = schema.required as string[] | undefined;
      const props = schema.properties as Record<string, unknown> | undefined;
      if (required && Array.isArray(required)) {
        for (const field of required) {
          if (!(field in (data as Record<string, unknown>))) {
            throw new Error(
              `Missing required field: "${field}"`
            );
          }
          // Recursively validate nested objects
          const fieldSchema = props?.[field] as Record<string, unknown> | undefined;
          if (fieldSchema && fieldSchema.type === "object") {
            validateAgainstSchema(
              (data as Record<string, unknown>)[field],
              JSON.stringify(fieldSchema)
            );
          }
        }
      }
    }

    // Enum check
    if (schema.enum && Array.isArray(schema.enum)) {
      if (!schema.enum.includes(data)) {
        throw new Error(
          `Value ${JSON.stringify(data)} is not in enum ${JSON.stringify(schema.enum)}`
        );
      }
    }
  }
}

// ── System prompt construction ──────────────────────────────

function buildSystemPrompt(schema: string): string {
  return [
    "You are a precise JSON output generator. Output valid JSON according to this schema:",
    "",
    schema,
    "",
    "Your response must be pure JSON. Do not include markdown fences, code blocks, or any explanation text.",
  ].join("\n");
}

// ── Extension entry ─────────────────────────────────────────

export default function jsonOutputExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "json_write",
    label: "JSON Output",
    description:
      "Generate structured JSON output via DeepSeek API with JSON Schema enforcement. " +
      "Calls DeepSeek directly to produce schema-validated JSON and writes it to a file. " +
      "Use this when you need deterministic, reusable structured data in a file.",
    promptSnippet:
      "Use json_write to generate validated JSON output. " +
      "Provide a JSON schema, the path to write to, and an instruction for what to generate.",
    promptGuidelines: [
      "Call json_write when the task requires structured JSON output in a file.",
      "path is required — specify the output file path (relative to session dir or absolute).",
      "schema is required — a JSON Schema (draft-07) defining the output structure.",
      "instruction is required — describe what content to generate, referencing session context.",
      "The tool calls DeepSeek API separately — it does not use the current conversation model.",
    ],
    parameters: Type.Object({
      path: Type.String({
        description:
          "Output file path. Relative paths are resolved against the session's working directory. " +
          "Absolute paths are used as-is.",
      }),
      schema: Type.String({
        description:
          "JSON Schema (draft-07) defining the expected output structure. " +
          "The generated JSON will be validated against this schema before writing.",
      }),
      instruction: Type.String({
        description:
          "Natural language instruction describing what content to generate. " +
          "Reference the current session context as needed (e.g., files read, data discussed).",
      }),
    }),
    async execute(
      toolCallId: string,
      params: { path: string; schema: string; instruction: string },
      signal: AbortSignal | undefined
    ) {
      const { path: filePath, schema, instruction } = params;

      // Resolve output path
      // If not absolute, resolve relative to session cwd or process.cwd()
      const outputPath = isAbsolute(filePath)
        ? filePath
        : resolve(process.cwd(), filePath);

      // Build messages for DeepSeek
      const messages: DeepSeekMessage[] = [
        { role: "system", content: buildSystemPrompt(schema) },
        { role: "user", content: instruction },
      ];

      // Call DeepSeek API
      const { content, model } = await callDeepSeek(messages, signal);

      if (!content.trim()) {
        throw new Error("DeepSeek returned empty content");
      }

      // Parse and validate
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        // One retry: ask DeepSeek to fix
        const retryMessages: DeepSeekMessage[] = [
          ...messages,
          {
            role: "assistant",
            content,
          },
          {
            role: "user",
            content:
              "Your previous response was not valid JSON. " +
              "Output ONLY valid JSON according to the provided schema, with no extra text.",
          },
        ];
        const retryResult = await callDeepSeek(retryMessages, signal);
        try {
          parsed = JSON.parse(retryResult.content);
        } catch {
          throw new Error(
            `Failed to generate valid JSON. Raw response: ${retryResult.content.slice(0, 500)}`
          );
        }
      }

      // Validate against schema
      try {
        validateAgainstSchema(parsed, schema);
      } catch (valErr) {
        throw new Error(
          `Generated JSON does not match schema: ${(valErr as Error).message}`
        );
      }

      // Write to file
      const dir = dirname(outputPath);
      await mkdir(dir, { recursive: true });

      const jsonContent = JSON.stringify(parsed, null, 2);
      await writeFile(outputPath, jsonContent, "utf-8");

      // Return result to LLM
      const summary =
        Array.isArray(parsed)
          ? `${parsed.length} items`
          : typeof parsed === "object" && parsed !== null
            ? `${Object.keys(parsed).length} fields`
            : "single value";

      return {
        content: [
          {
            type: "text" as const,
            text:
              `JSON output written to \`${outputPath}\`\n` +
              `Model: ${model}\n` +
              `Size: ${jsonContent.length} bytes\n` +
              `Content: ${summary}`,
          },
        ],
        details: {
          path: outputPath,
          model,
          size: jsonContent.length,
        },
      };
    },
  });
}