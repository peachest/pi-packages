/**
 * Env Tool — pi extension
 *
 * A tool that records environment context collected by the agent into the
 * conversation log. The agent gathers environment data manually (bash, read,
 * kubectl, etc.), then calls env to register it in a structured, searchable
 * format.
 *
 * Unlike think (free-form reasoning), env provides a typed scope + data
 * structure so that consequence (and other tools) can reliably find all env
 * information by scanning tool calls in message history.
 *
 * Install: pi install ./pi-think-tool  (from ~/projects/pi-mypackage)
 *   Test:  pi -e ./env.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const SCOPE_DESCRIPTIONS: Record<string, string> = {
  system: "OS, arch, distro, user, hostname, shell, node version, pi version",
  k8s: "Kubernetes cluster, context, namespace, config file, server version",
  git: "Current branch, remote, status, last commit, ahead/behind",
  file: "File path, exists, size, type, permissions, imports",
  project: "Project root, package manager, scripts, dependencies, build system",
};

export default function envExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "env",
    label: "Env",
    description:
      "Record environment context collected by the agent. Use this to register " +
      "system, k8s, git, file, or project information. The agent is expected to " +
      "gather environment data via bash/read first, then pass it to env for logging. " +
      "Other tools (e.g. consequence) can find all env records by scanning tool calls.",
    promptSnippet: "Collect and record environment context",
    promptGuidelines: [
      "After gathering environment info via bash/read/kubectl, call env to register it.",
      "Choose the right scope for the data you collected (system/k8s/git/file/project).",
      "Future tools can discover all env records by scanning tool calls in the conversation.",
    ],
    parameters: Type.Object({
      scope: Type.String({
        description:
          "Environment domain. One of: system, k8s, git, file, project. " +
          `system — ${SCOPE_DESCRIPTIONS.system}. ` +
          `k8s — ${SCOPE_DESCRIPTIONS.k8s}. ` +
          `git — ${SCOPE_DESCRIPTIONS.git}. ` +
          `file — ${SCOPE_DESCRIPTIONS.file}. ` +
          `project — ${SCOPE_DESCRIPTIONS.project}.`,
      }),
      data: Type.String({
        description:
          "Environment data collected by the agent. Free-form text describing " +
          "what was found. The agent gathers this via bash/read/etc. before calling env.",
      }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { scope, data } = params;
      if (!scope || !data) {
        return {
          content: [{ type: "text", text: "Error: Both 'scope' and 'data' are required." }],
          details: null,
        };
      }
      return {
        content: [{ type: "text", text: `[env:${scope}]\n${data}` }],
        details: { scope },
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
          "## env tool usage",
          "You have an `env` tool that records environment context into the conversation.",
          "It does NOT execute commands — you gather data manually first.",
          "",
          "### When to use it",
          "Always call env after you collect new environment context, especially BEFORE:",
          "- Running a bash command that modifies the environment (kubectl, git push,",
          "  rm, mv, install, restart services) — first call env to record current state",
          "- Writing or editing a file — first call env({ scope: 'file', data }) with the target file info",
          "- Calling consequence — env data feeds into consequence for better risk analysis",
          "- After collecting system info via bash (uname, whoami, etc.): call env({ scope: 'system', data })",
          "- After inspecting k8s cluster state (kubectl config, nodes, etc.): call env({ scope: 'k8s', data })",
          "- After checking git status (branch, diff, remote): call env({ scope: 'git', data })",
          "",
          "### Flow",
          "",
          "1. Collect info (bash/read/kubectl etc.) → call env() to register it",
          "2. Then call consequence({ proposedAction, context }) — consequence scans env history automatically",
          "3. Only proceed if consequence says 'proceed'",
          "",
          "### How to use it",
          "1. Collect environment info via bash, read, kubectl, git commands.",
          "2. Pick the right scope for the collected data.",
          "3. Call env({ scope, data }).",
          "4. Other tools (e.g. consequence) find all env records by scanning message history.",
          "",
        ].join("\n"),
    };
  });
}