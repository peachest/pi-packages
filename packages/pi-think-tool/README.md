# pi-think-tool

> [中文文档](./docs/README.zh.md) · English

Three extension tools for the pi coding agent: **think**, **env**, and **consequence** — making multi-step agent operations safer and more auditable.

## Install

```bash
# Local path
pi install ./pi-think-tool

# Try without installing
pi -e ./pi-think-tool/think.ts
pi -e ./pi-think-tool/env.ts
pi -e ./pi-think-tool/consequence.ts
```

## Tools

### think — Record reasoning

Log the current assessment between tool calls. Does not fetch new information or modify external state.

```
think({ thought: "After analyzing test output, root cause is in function X. Next step: fix Y." })
→ Appends the thought to the conversation log
```

**When to use**:
- Re-evaluating next steps after receiving tool results
- Checking multi-condition policy/rule combinations
- Comparing fix approaches before editing, to avoid fixing the wrong direction

**Inspiration**: Anthropic Engineering Blog — [The "think" tool](https://www.anthropic.com/engineering/think-tool)

---

### env — Record environment context

Log environment state (gathered via bash/kubectl/git etc.) into the conversation for other tools like `consequence` to scan.

```
env({ scope: "k8s", data: "Context: prod\nNamespace: default\n..." })
→ [env:k8s]
  Context: prod
  Namespace: default
```

**When to use**:
- Collect target environment state before an operation
- Record git branch, remote, latest commit
- Record k8s cluster context and namespace
- Record file permissions, type, size

**Available scopes**:

| scope | Purpose |
|-------|---------|
| `system` | OS, architecture, user, shell, node version |
| `k8s` | k8s cluster context, namespace, server version |
| `git` | Current branch, remote, status, latest commit |
| `file` | File path, existence, size, type, imports |
| `project` | Project root, package manager, scripts, dependencies |

---

### consequence — Evaluate action consequences

Before writing a file, running a command, or performing k8s/git operations, delegate risk assessment to an independent sub-model.

```
consequence({
  proposedAction: {
    operation: "edit",
    target: "src/config.ts",
    details: "Change DATABASE_URL from staging to production"
  },
  context: {
    envSummary: "Git branch: main | 3 commits ahead | remote: origin"
  }
})
→ Risks:
  - [high] Production database URL written into the repository
  - [medium] Current branch not pushed; changes could be lost
  Decision: caution
```

**Decision outcomes**:

| decision | Meaning |
|----------|---------|
| `proceed` | Risks are manageable, safe to execute |
| `caution` | Risks identified, address them first |
| `abort` | Do not execute this operation |

**Model selection**: Prefers `claude-sonnet-4`, falls back to the cheapest available text model.

## File Structure

```
pi-think-tool/
├── think.ts          # think tool extension
├── env.ts            # env tool extension
├── consequence.ts    # consequence tool extension
├── package.json      # pi package manifest
├── README.md         # English
├── README.zh.md      # 中文
└── docs/
    ├── design.md     # architecture, design decisions, optimization roadmap
    └── roadmap.md
```

## Development

```bash
# Test a single extension from the project directory
pi -e ./think.ts
pi -e ./env.ts
pi -e ./consequence.ts

# Reinstall after updates
pi remove ./pi-think-tool 2>/dev/null; pi install ./pi-think-tool
```

### Dependencies

All three tools depend on the pi core `ExtensionAPI` type. `consequence.ts` additionally uses `@earendil-works/pi-ai`'s `complete()` for sub-model inference. `typebox` is used for parameter schema definitions.

These are declared in `peerDependencies` and provided automatically by pi when loading extensions — no separate install needed.