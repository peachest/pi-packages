/**
 * Think Tool — pi extension
 *
 * A no-side-effect tool that lets the LLM record intermediate reasoning
 * during multi-step tool chains. Modeled after Anthropic's "think" tool.
 *
 * The tool does not call APIs, read files, or modify state.
 * It only logs the model's current thought to the conversation,
 * giving developers an auditable checkpoint between tool calls.
 *
 * Install: pi install ./pi-think-tool  (from ~/projects/pi-mypackage)
 *   Test:  pi -e ./think.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function thinkExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "think",
    label: "Think",
    description:
      "Record a structured thought for audit trail and complex reasoning. Does not change any state, only appends to the conversation log.",
    promptSnippet: "Record a thought between tool calls for audit trails",
    promptGuidelines: [
      "Use think when you need to re-evaluate available information between tool calls, check rules, or plan the next action.",
      "Before calling a write/execute tool, first use think to enumerate what you know and what rules apply.",
    ],
    parameters: Type.Object({
      thought: Type.String({ description: "A thought to think about." }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      return {
        content: [{ type: "text", text: params.thought }],
        details: null,
      };
    },
  });

  // Inject usage guidance into the system prompt
  pi.on("before_agent_start", async (event) => {
    return {
      systemPrompt:
        event.systemPrompt +
        [
          "",
          "## think tool usage",
          "You have a 'think' tool that writes a thought to the conversation log without side effects.",
          "",
          "### When to use it",
          "- After receiving tool results, before deciding the next action: re-evaluate available information, check rules, plan the next step.",
          "- Before calling a write or execute tool: enumerate what you know, verify completeness, and ensure all preconditions are met.",
          "- When policy rules (permissions, edge cases, business logic) must be checked before proceeding.",
          "- After a test failure, before editing code: analyze root cause and evaluate possible fixes.",
          "- Before making a decision that depends on multiple tool results: consolidate all available evidence and identify gaps.",
          "",
          "### What to include (checklist)",
          "Before you act or reply, use think to do ALL of the following:",
          "1. List the applicable rules or constraints for the current request.",
          "2. Check that all necessary information has been collected (required fields, status, policy details).",
          "3. Verify that the planned action is consistent with all relevant policies.",
          "4. Re-examine tool results for correctness and completeness.",
          "",
          "### Output format",
          "Structure your thought using these five sections:",
          "1. Current goal — what this step needs to accomplish",
          "2. Evidence — what tool results and information are already available",
          "3. Gaps — what information, rules, or user confirmation is still missing",
          "4. Next action — continue gathering info, execute, revert, or ask the user",
          "5. Risk handling — how to stop, roll back, or escalate on failure",
          "",
        ].join("\n"),
    };
  });
}