# Research: Agent Tool Architecture — When to Use Registered Tools vs CLI vs Skills/Prompts

## Summary

The decision between registered tools (function-calling tools in the LLM's tool list), CLI binaries (invoked via bash), and skills/prompt instructions is driven by four factors: **discovery cost** (token overhead per turn), **autonomy vs control** (who decides when to act), **composability** (can operations chain), and **deterministic logic encapsulation** (does the operation need algorithms the LLM can't reliably do via bash). The research converges on a clear hierarchy: **start with bash/CLI for breadth, promote to tools only when you need gating, rendering, auditing, or parallelization that bash can't provide**. For a local issue-tracker, a CLI binary with deterministic logic (graph traversal, cycle detection, atomic writes) is the correct primary interface — no registered tool layer needed.

## Findings

### 1. Anthropic's Own Architecture: The "Start with Bash, Promote When Needed" Principle

Anthropic's official agent design guide (`skills/claude-api/shared/agent-design.md` in the `anthropics/skills` repo) states the principle explicitly:

> **Rule of thumb:** Start with bash for breadth. Promote to dedicated tools when you need to gate, render, audit, or parallelize the action.

The four promotion criteria are:
- **Security boundary** — hard-to-reverse actions (external API calls, deleting data) need gating; `bash -c "curl -X POST"` can't be gated
- **Staleness checks** — a dedicated `edit` tool can reject writes if the file changed since last read; bash can't enforce that invariant
- **Rendering** — some actions benefit from custom UI (e.g., question-asking as a modal)
- **Scheduling** — read-only tools like `glob`/`grep` can be marked parallel-safe; bash can't distinguish parallel-safe `grep` from parallel-unsafe `git push`

Source: `https://github.com/anthropics/skills/blob/main/skills/claude-api/shared/agent-design.md`

### 2. Claude Code's Extension Model: Skills + Tools + Hooks as Orthogonal Primitives

Claude Code's official features-overview doc (`https://code.claude.com/docs/en/features-overview`) defines three distinct extension points:

| Primitive | When Active | Primary Job |
|-----------|------------|-------------|
| **CLAUDE.md** (system prompt) | Every request | Project context, standing rules |
| **Skill (SKILL.md)** | When task matches trigger | Step-by-step procedures |
| **Hook** | On tool call events | Automated shell commands, validation |

Skills use **progressive disclosure**: the skill's ~100-word description sits in context; the full instructions are loaded only when triggered. This is fundamentally different from tools, where the full JSON schema sits in context on every turn (though tool search mitigates this).

Claude Code's built-in tools are minimal: Bash, Text editor (read/edit/write), Computer use, Code execution, Web search/fetch, Memory. Everything else is a skill or MCP server. The principle: **tools are for primitive capabilities the harness needs to intercept; skills are for domain knowledge and workflows.**

Source: `https://code.claude.com/docs/en/features-overview`

### 3. The Token Cost Hierarchy: Skills < CLI < MCP/Tools

Multiple independent benchmarks confirm the token economics:

**Standing cost (per-turn, whether or not the tool is used):**
- **Skill**: ~30-50 tokens (just the description line)
- **CLI**: ~0 tokens (binary on PATH; agent learns it exists once)
- **MCP tool**: 550-1,400 tokens per tool definition, every turn

**Per-call cost:**
- **CLI**: command string + stdout text (controllable via `--fields`, `--format`)
- **MCP tool**: JSON-RPC serialization overhead + structured response (often verbose)

Key benchmark numbers:
- SerpApi MCP: 771 tokens standing cost, 6,047 tokens per call. Same query via CLI: 0 standing, 351 tokens per call (~17x difference). Source: `https://dev.to/aryrabelo-com/i-measured-mcp-vs-a-cli-for-agent-search-the-mcp-used-17x-more-tokens-per-call-43p6`
- GitHub MCP: 55,000 tokens of schema injected before conversation starts (93 tools). Source: `https://browserbash.com/blog/cli-vs-mcp-browser-automation`
- Anthropic's own report: tool definitions consumed 134,000 tokens before optimization in multi-server setups. Source: Anthropic "Code execution with MCP" blog post, referenced in multiple sources.
- MindStudio benchmark: MCP consumed 35x more tokens than equivalent CLI, reliability dropped from 100% to 72% as task complexity increased. Source: `https://www.mindstudio.ai/blog/mcp-vs-cli-agentic-workflows-token-overhead-reliability`

**Important nuance**: Modern agent harnesses (Claude Code 2.x) now defer MCP tool loading — tool definitions are pulled in lazily, similar to skills. This narrows the gap significantly. Source: `https://www.checklyhq.com/blog/mcp-vs-cli-token-efficiency/`

### 4. Composability: CLI Wins Decisively

CLI tools compose via Unix pipes (`A | B | C`). Each tool call in a registered-tool model requires a round-trip: LLM calls tool → result lands in context → LLM reasons → LLM calls next tool. Three sequential actions = three round trips, each adding latency and tokens.

Anthropic introduced **Programmatic Tool Calling (PTC)** to address this: Claude writes a script that invokes tools as functions, with intermediate results staying in the code execution container rather than Claude's context. But this is a workaround for a limitation that doesn't exist with CLIs.

Source: `https://github.com/anthropics/skills/blob/main/skills/claude-api/shared/agent-design.md` (section "Composing Tool Calls: Programmatic Tool Calling")

### 5. The "Decision Rubric" from Practitioners

Ben Greenberg's five-question rubric (`https://dev.to/bengreenberg/mcp-server-or-cli-a-decision-rubric-for-developer-tooling-2ch6`) synthesizes industry practice:

**Use CLI when:**
- Task is repo-local or terminal-native
- Humans need to run it directly
- CI should run the same interface
- Shell composition is a feature
- Text output and exit codes are enough
- Auth model is already appropriate for local developer context

**Use MCP/registered tool when:**
- Agent needs to discover the capability autonomously
- Task touches an external system
- Inputs and outputs should be typed and constrained
- Permissions need to be scoped
- Multiple agent clients should share the same integration
- Tool should hide implementation details
- Auditability and policy matter

**Use both when:**
- Humans and agents both need the capability
- CLI is already valuable
- MCP/tool can expose a safer or more structured subset
- Shared core logic can prevent drift

### 6. Scale Labs Controlled Study: Interface Matters Less for Frontier Models

A controlled 1-to-1 comparison of MCP vs CLI on 50 long-horizon agentic tasks (`https://labs.scale.com/blog/mcp-vs-cli`) found:

- CLI is not universally better — it helps less capable models on retrieval-heavy tasks but is neutral on targeted tasks
- **Interface choice matters much less for latest frontier models** (Opus 4.8, GPT-5.5 perform similarly across all interface setups)
- Interface choice still affects **cost** (trajectory length, latency, dollar cost) even when performance converges
- CLI mainly compensates for tool-use errors that capable models don't make

### 7. Deterministic Logic Encapsulation: CLI Is Sufficient

The research question was: "When an operation needs deterministic logic (graph traversal, cycle detection, atomic multi-file writes), is a CLI wrapper sufficient, or does it need to be a registered tool?"

Answer: **CLI is sufficient.** Deterministic logic is about *implementation*, not about *discovery*. A CLI binary can encapsulate graph traversal, cycle detection, and atomic multi-file writes perfectly well — the agent calls `tracker frontier --map foo` and gets JSON back. The tool/CLI distinction is about *how the agent discovers and invokes the capability*, not about what happens inside.

The only reason to promote deterministic logic to a registered tool would be if:
1. The harness needs to intercept/gate the operation (security boundary)
2. The harness needs to render the result in a custom UI
3. The harness needs to audit the call at the tool-call level (vs. just logging bash output)
4. The operation needs in-process state across calls

None of these apply to a local issue-tracker: it's repo-local, the output is JSON text, there's no security boundary (it's the developer's own files), and it's stateless (each CLI invocation reads/writes files).

### 8. Human Usability: CLI Wins Decisively

CLIs can be run by humans for debugging, batch processing, and CI. Registered tools cannot (usually) be invoked outside the agent loop. Skills are readable by humans but not executable.

For a local issue-tracker, this is a significant factor: the developer will want to manually check `tracker frontier`, `tracker progress`, or `tracker list` without spinning up an agent session.

### 9. Maintenance Cost Hierarchy: Skill < CLI < Extension/Tool

| Mechanism | Implementation | Maintenance Cost | Human Usable |
|-----------|---------------|-----------------|--------------|
| **Skill (markdown)** | Markdown file | Lowest — just text | Readable, not executable |
| **CLI binary** | Go/Rust/Python binary | Medium — code, tests, packaging | Yes — humans and CI can run |
| **Pi extension (TypeScript)** | TS + registerTool API + TUI rendering | Highest — code + extension API + rendering hooks | No — only agent can call |

### 10. State Management: Tools Can Hold In-Process State, CLIs Cannot

A pi extension (registered tool) can maintain state across tool calls within a session: caches, connection pools, session context. A CLI is stateless — each invocation is a fresh process.

For a local issue-tracker, statelessness is a feature: all state lives in files (markdown + YAML front matter), not in memory. This makes the system debuggable, testable, and predictable.

### 11. Error Handling Differences

| Mechanism | Error Propagation | Agent Interpretation |
|-----------|------------------|---------------------|
| **Registered tool** | Returns error JSON in the tool result | Agent reads structured error, can retry |
| **CLI** | Exit code + stderr text | Agent reads stderr, must parse text |
| **Skill** | Agent interprets failure of bash command | Agent reasons about what went wrong |

CLI error handling is sufficient when errors are human-readable and actionable. A CLI returning `"Ticket #99 not found in map 'slo'. Available: #01-#06. Use list_tickets."` on stderr with exit code 1 is just as actionable as a structured JSON error from a tool.

### 12. Pi Framework Patterns

Examining actual pi extensions:

- **`@vndv/pi-codegraph`**: Registers 8 tools (`codegraph_search`, `codegraph_callers`, `codegraph_callees`, `codegraph_impact`, `codegraph_explore`, `codegraph_node`, `codegraph_status`, `codegraph_files`). These are **read-only structural queries** that the agent needs to discover autonomously — the agent doesn't know when to use codegraph without the tool description. Source: `/mnt/disk1/hyx/.pi/agent/npm/node_modules/@vndv/pi-codegraph/extensions/codegraph.ts`

- **`context-mode`**: Registers tools via MCP bridge. The tools (`ctx_execute`, `ctx_search`, etc.) need to be in the tool list so the agent reaches for them instead of reading files directly. Source: `/mnt/disk1/hyx/.pi/agent/npm/node_modules/context-mode/build/adapters/pi/mcp-bridge.d.ts`

- **`rtk.ts`**: Does NOT register tools. It hooks into `tool_call` events to rewrite bash commands (intercepting `helm` → `rtk rewrite`). This is an **event-driven extension**, not a tool provider. Source: `/mnt/disk1/hyx/.pi/agent/extensions/rtk.ts`

- **`@vanillagreen/pi-qol`**: Does NOT register tools (0 `registerTool` calls). It hooks into lifecycle events (`tool_call`, `tool_result`, `agent_end`) for notifications, compaction, session renaming. Source: `/mnt/disk1/hyx/.pi/agent/npm/node_modules/@vanillagreen/pi-qol/extensions/qol.ts`

- **`gh` and `glab` CLIs**: Not registered as tools. Agent learns to use them from skill prompts (`issue-tracker-github.md`, `issue-tracker-gitlab.md`). These are the most directly analogous to the proposed issue-tracker tool.

**Pattern**: Pi extensions register tools when the agent needs to **autonomously discover** a capability that isn't already part of its bash vocabulary. They use event hooks for **transparent interception** (rtk rewriting commands, qol adding notifications). They leave CLIs as CLIs when the skill prompt can reliably teach the agent to use them.

### 13. The "After Year One" Convergence

Multiple sources report that the industry is converging on a **two-layer model**:

- **Layer 1 (Transport)**: Choose per-integration. CLI for local/repo-native tools. MCP for external services needing auth/discovery.
- **Layer 2 (Interface design)**: Regardless of transport, design the interface for LLM consumption — minimal upfront context, on-demand discovery, structured but token-efficient output.

Skills sit above both layers: the skill routes to the appropriate transport (CLI or MCP), abstracting the choice from the agent.

Source: `https://manveerc.substack.com/p/mcp-vs-cli-ai-agents`

## Sources

### Kept (cited in findings)
1. Anthropic agent design guide — `https://github.com/anthropics/skills/blob/main/skills/claude-api/shared/agent-design.md`
2. Claude Code features overview — `https://code.claude.com/docs/en/features-overview`
3. Ben Greenberg's CLI vs MCP decision rubric — `https://dev.to/bengreenberg/mcp-server-or-cli-a-decision-rubric-for-developer-tooling-2ch6`
4. Scale Labs MCP vs CLI controlled study — `https://labs.scale.com/blog/mcp-vs-cli`
5. MCP vs CLI token overhead benchmark (MindStudio) — `https://www.mindstudio.ai/blog/mcp-vs-cli-agentic-workflows-token-overhead-reliability`
6. SerpApi MCP vs CLI token measurement — `https://dev.to/aryrabelo-com/i-measured-mcp-vs-a-cli-for-agent-search-the-mcp-used-17x-more-tokens-per-call-43p6`
7. Checkly: "Are CLIs Really More Token-Efficient?" (nuance on lazy loading) — `https://www.checklyhq.com/blog/mcp-vs-cli-token-efficiency/`
8. OnlyCLI: Why Native CLI Beats MCP — `https://onlycli.github.io/OnlyCLI/blog/why-cli-beats-mcp-for-llm-agents/`
9. BrowserBash: CLI vs MCP for Browser Automation — `https://browserbash.com/blog/cli-vs-mcp-browser-automation`
10. MCP vs CLI + Skills context cache trade-off — `https://zenn.dev/fruitriin/articles/7fb64652bf08a9?locale=en`
11. Manveer Chawla: MCP vs CLI two-layer model — `https://manveerc.substack.com/p/mcp-vs-cli-ai-agents`
12. Red Hat: MCP servers vs skills — `https://developers.redhat.com/articles/2026/05/25/mcp-servers-vs-skills-choosing-right-context-your-ai`
13. arXiv: "The Scaffolding Matters More Than the Interface" — `https://arxiv.org/abs/2608.08654v1`
14. Pi codegraph extension source — `/mnt/disk1/hyx/.pi/agent/npm/node_modules/@vndv/pi-codegraph/extensions/codegraph.ts`
15. Pi context-mode MCP bridge — `/mnt/disk1/hyx/.pi/agent/npm/node_modules/context-mode/build/adapters/pi/mcp-bridge.d.ts`
16. Pi rtk extension (event hooks, no tools) — `/mnt/disk1/hyx/.pi/agent/extensions/rtk.ts`
17. Pi qol extension (event hooks, no tools) — `/mnt/disk1/hyx/.pi/agent/npm/node_modules/@vanillagreen/pi-qol/extensions/qol.ts`
18. Skills vs Hooks vs Prompts decision guide — `https://explainx.ai/blog/skills-vs-hooks-vs-prompts-when-to-use-each-2026`
19. Claude Code skills deep dive — `https://artandalgorithms.ai/articles/code/claude-code-skills`
20. CircleCI: MCP vs CLI for AI-native development — `https://circleci.com/blog/mcp-vs-cli/`

### Dropped (secondary commentary, SEO-heavy, or redundant)
- MindStudio "MCP Servers vs CLI Tools" (less detailed than their benchmark article)
- Cursor docs (Cursor's architecture is IDE-integrated, not applicable to CLI-first pi)
- Aider docs (Aider has no tool registration concept — it's pure CLI + git)
- LangChain/LangGraph docs (framework-specific, not applicable to pi's architecture)
- MCP specification (protocol-level, doesn't answer the "when to use" question)
- AWS MCP guidance (enterprise-focused, not applicable)

## Gaps

1. **No benchmark for pi specifically**: The token cost numbers are from Claude Code and custom harnesses. Pi's tool registration may have different overhead characteristics. A direct measurement of pi's per-tool token cost would be valuable.

2. **No data on tool invocation reliability in pi**: The Scale Labs study tested MCP vs CLI in controlled environments. Pi's specific tool-call routing and agent behavior with tools vs CLIs hasn't been benchmarked.

3. **PTC (Programmatic Tool Calling) availability in pi**: Anthropic's PTC feature addresses the composability gap of tools, but it's unclear whether pi supports it. If it does, the composability argument weakens.

### Suggested next steps for the issue-tracker decision

Based on this research, the recommendation is clear:

1. **Build a CLI binary** (`tracker`) in Go, encapsulating deterministic logic (numbering, status, blocking graph, frontier query, atomic resolve)
2. **Update `issue-tracker-local.md`** skill prompt to teach the agent to use `tracker` CLI commands
3. **Do NOT build a pi extension tool layer** — the skill prompt can reliably teach the agent to use the CLI (proven by `gh`/`glab` precedent), and none of Anthropic's four promotion criteria (gating, staleness, rendering, scheduling) apply
4. If future experience shows the agent doesn't proactively use the CLI, revisit the tool layer — but start without it
