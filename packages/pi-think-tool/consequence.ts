/**
 * Consequence Tool — pi extension
 *
 * A tool that lets the LLM evaluate potential consequences of a proposed
 * action before executing it. Delegates the analysis to a separate model
 * so the main agent's context is not polluted with reasoning tokens.
 *
 * Modeled after Anthropic's "think" tool pattern, with the addition of
 * an independent safety-review inference step.
 *
 * Install: pi install ./pi-think-tool  (from ~/projects/pi-mypackage)
 *   Test:  pi -e ./consequence.ts
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { complete } from "@earendil-works/pi-ai";

const CONSEQUENCE_SYSTEM_PROMPT = [
  "You are a consequence analyzer for an AI coding agent. Given the current",
  "environment state and a proposed action, evaluate potential risks and",
  "side effects. Be concise and specific.",
  "",
  "Assess these categories:",
  "- Data loss or corruption",
  "- Service disruption or instability",
  "- Security or permission violations",
  "- Cascading effects (files that depend on the target)",
  "- Reversibility (can the change be undone?)",
  "- Environment-specific concerns (git state, k8s cluster, running services)",
  "",
  "Respond in EXACTLY this format, nothing else:",
  "",
  "Severity: high | medium | low",
  "Risks:",
  "- [severity] description",
  "Decision: proceed | caution | abort",
  "Rationale: <one short paragraph>",
].join("\n");

function buildPrompt(
  proposedAction: string,
  envSummary: string | undefined,
): string {
  const parts: string[] = [];
  parts.push("Evaluate the consequences of this proposed action:");
  parts.push("");
  parts.push(proposedAction);
  parts.push("");
  if (envSummary) {
    parts.push("Current environment state:");
    parts.push(envSummary);
  }
  return parts.join("\n");
}

function parseConsequenceOutput(text: string): {
  risks: { severity: string; description: string }[];
  decision: string;
  rationale: string;
} {
  const risks: { severity: string; description: string }[] = [];
  let decision = "caution";
  let rationale = "";

  const lines = text.split("\n");
  let inRisks = false;
  let afterRationale = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("Severity:")) {
      continue;
    }

    if (trimmed.startsWith("Risks:")) {
      inRisks = true;
      afterRationale = false;
      continue;
    }

    if (/^Decision:\s*(proceed|caution|abort)/i.test(trimmed)) {
      inRisks = false;
      afterRationale = false;
      decision = trimmed.replace(/^Decision:\s*/i, "").trim().toLowerCase();
      continue;
    }

    if (/^Rationale:/i.test(trimmed)) {
      inRisks = false;
      afterRationale = true;
      rationale = trimmed.replace(/^Rationale:\s*/i, "").trim();
      continue;
    }

    if (inRisks && /^-\s*\[(high|medium|low)\]\s/i.test(trimmed)) {
      const match = trimmed.match(/^-\s*\[(high|medium|low)\]\s+(.*)/i);
      if (match) {
        risks.push({ severity: match[1].toLowerCase(), description: match[2] });
      }
      continue;
    }

    if (inRisks && trimmed) {
      if (risks.length > 0) {
        risks[risks.length - 1].description += " " + trimmed;
      }
      continue;
    }

    // ponytail: flag-based, not rational && truthy check
    if (afterRationale) {
      rationale += " " + trimmed;
      continue;
    }
  }

  rationale = rationale.trim();
  if (!rationale) rationale = text.slice(0, 200).trim();

  return { risks, decision, rationale };
}

async function pickModel(ctx: ExtensionContext) {
  const { modelRegistry, model: currentModel } = ctx;

  // 1. Reuse the current session's model if it has auth
  if (currentModel && modelRegistry.hasConfiguredAuth(currentModel)) {
    return currentModel;
  }

  // 2. Try preferred Anthropic models (only if auth is configured)
  const preferred = [
    "claude-sonnet-4-20250514",
    "claude-sonnet-4",
    "claude-haiku-4-5-20250514",
    "claude-haiku-4-5",
  ];
  for (const id of preferred) {
    const model = modelRegistry.find("anthropic", id);
    if (model && modelRegistry.hasConfiguredAuth(model)) return model;
  }

  // 3. Fallback: cheapest text model with auth configured
  const all = modelRegistry.getAvailable();
  const textModels = all.filter((m: any) => m.input?.includes?.("text") ?? false);
  textModels.sort((a: any, b: any) => {
    const costA = Number(a.cost?.input ?? 0) + Number(a.cost?.output ?? 0);
    const costB = Number(b.cost?.input ?? 0) + Number(b.cost?.output ?? 0);
    return costA - costB;
  });
  return textModels[0];
}

export default function consequenceExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "consequence",
    label: "Consequence",
    description:
      "Evaluate the potential consequences of a proposed action before executing it. " +
      "Use this to check if a write, edit, bash, kubectl, or git operation is safe " +
      "given the current environment state. Delegates the analysis to a separate model.",
    promptSnippet: "Evaluate consequences of an action before executing it",
    promptGuidelines: [
      "Use consequence before write/edit/bash/kubectl/git operations when you are about to modify the environment.",
      "Describe what you plan to do in proposedAction, and pass any relevant environment state as context.",
    ],
    parameters: Type.Object({
      proposedAction: Type.String({
        description:
          "What the agent plans to do, in natural language. " +
          "Example: 'Write src/config.ts: change DATABASE_URL from staging to production'",
      }),
      context: Type.Optional(
        Type.String({
          description:
            "Current environment state, if available. " +
            "Include git branch, k8s context, file details, or any other relevant context.",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const proposedAction = params.proposedAction;
      const envSummary = params.context;

      // Pick a model and get auth
      const model = await pickModel(ctx);
      if (!model) {
        return {
          content: [
            {
              type: "text",
              text: [
                "Severity: unknown",
                "Risks:",
                "- [unknown] No model available for consequence analysis",
                "Decision: caution",
                "Rationale: Could not find an available model to analyze consequences.",
              ].join("\n"),
            },
          ],
          details: null,
        };
      }

      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok || (!auth.apiKey && !auth.headers)) {
        return {
          content: [
            {
              type: "text",
              text: [
                "Severity: unknown",
                "Risks:",
                "- [unknown] No API key available for consequence analysis model",
                "Decision: caution",
                "Rationale: Could not authenticate with the analysis model.",
              ].join("\n"),
            },
          ],
          details: null,
        };
      }

      const prompt = buildPrompt(proposedAction, envSummary);

      try {
        const response = await complete(
          model,
          { messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }], systemPrompt: CONSEQUENCE_SYSTEM_PROMPT },
          { apiKey: auth.apiKey, headers: auth.headers, maxTokens: 1000, signal },
        );

        if (response.stopReason === "error") {
          return {
            content: [
              {
                type: "text",
                text: [
                  "Severity: unknown",
                  "Risks:",
                  `- [unknown] Model error: ${response.errorMessage ?? "unknown"}`,
                  "Decision: caution",
                  "Rationale: The analysis model returned an error. Proceed with caution.",
                ].join("\n"),
              },
            ],
            details: null,
          };
        }

        const rawText = response.content
          ?.filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("\n") ?? "";

        const { risks, decision, rationale } = parseConsequenceOutput(rawText);

        // Return parsed result so the agent sees structured info in the tool result
        const outputParts: string[] = [];

        if (risks.length > 0) {
          outputParts.push("Risks:");
          for (const r of risks) {
            outputParts.push(`- [${r.severity}] ${r.description}`);
          }
        } else {
          outputParts.push("Risks: None identified");
        }

        outputParts.push("");
        outputParts.push(`Decision: ${decision}`);
        outputParts.push(`Rationale: ${rationale}`);

        return {
          content: [{ type: "text", text: outputParts.join("\n") }],
          details: null,
        };
      } catch (err: any) {
        if (err?.name === "AbortError") {
          return {
            content: [
              {
                type: "text",
                text: [
                  "Severity: unknown",
                  "Risks:",
                  "- [unknown] Consequence analysis was cancelled",
                  "Decision: caution",
                  "Rationale: Analysis was interrupted before completion.",
                ].join("\n"),
              },
            ],
            details: null,
          };
        }
        throw err;
      }
    },
  });

  // Inject usage guidance into the system prompt
  pi.on("before_agent_start", async (event) => {
    return {
      systemPrompt:
        event.systemPrompt +
        [
          "",
          "## consequence tool usage",
          "You have a `consequence` tool that evaluates potential consequences of actions",
          "before you execute them. It delegates the analysis to a separate model so your",
          "own context is not polluted with reasoning tokens.",
          "",
          "### When to use it",
          "- Before running a bash command that modifies the environment (kubectl, git push,",
          "  rm, mv, install, restart services)",
          "- Before writing or editing a file when you are not sure which other files",
          "  depend on it or what the current state is",
          "- After you have collected env context and need to decide whether to proceed",
          "",
          "### How to use it",
          "1. Call consequence({ proposedAction, context? }).",
          "2. Read the returned risks and decision.",
          "3. Only proceed if decision is 'proceed' — if 'caution', address the risks",
          "   first; if 'abort', do not execute the action and explain why to the user.",
          "4. If you have env context (git branch, k8s cluster, file details), pass",
          "   it as context for better analysis.",
          "5. If you are unsure about the environment, do not guess — ask the user.",
          "",
        ].join("\n"),
    };
  });
}