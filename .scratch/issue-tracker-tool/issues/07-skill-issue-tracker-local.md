---
id: "07"
title: Skill migration - issue-tracker-local.md
map: issue-tracker-tool
type: task
status: open
triage: null
blocked_by: ["01"]
created_at: 2026-08-19T12:00:00Z
reviewed_at: null
claimed_at: null
resolved_at: null
---

# Skill migration - issue-tracker-local.md

## What to build

Rewrite `issue-tracker-local.md` — the core reference document for local tracker. This is the canonical source that all other skill migrations reference.

### 5 updates (route migration plan items 1-5)

**1. Conventions section** (item 1):
- Current: `Status:` line records triage state; `Type:` line records ticket type; `Blocked by: NN, NN` line
- New: YAML front matter (`id/title/map/type/status/triage/blocked_by/timestamps`); body only free-text sections

**2. Wayfinding operations section** (item 2):
- Current: Claim=set `Status: claimed`; Resolve=append `## Answer` + set `Status: resolved` + append decision pointer; Frontier=scan issues/
- New: Reference CLI commands:
  - Claim: `tracker ticket status --map <slug> --id <N> --set claimed`
  - Resolve: **agent workflow** (CLI is thin CRUD, G-Q15): (1) agent fills `## Answer` section using bash/edit, (2) agent appends decision pointer line to map.md's `## Decisions so far` using bash/edit, (3) `tracker ticket status --map <slug> --id <N> --set resolved`. Decision pointer line format: `- [#<id> <title>](issues/<NN>-<slug>.md) — <gist>`. On reopen+re-resolve: agent replaces existing pointer line (matched by `- [#<id>` prefix).
  - Reopen: `tracker ticket status --map <slug> --id <N> --set open` (clears resolved_at + claimed_at). Agent handles map.md decision pointer (replace or remove) per issue-tracker-local.md.
  - Frontier: `tracker query frontier --map <slug>`

**3. Publish/fetch section** (item 3):
- Current: "Create a new file" / "Read the file"
- New: publish=`tracker ticket create`; fetch=read file (unchanged) or `tracker ticket list`

**4. New "实现操作" section** (item 4):
- Local ticket commit convention: `Resolves <map>/#<N>` (G7 decision — commit convention in tracker doc, not implement/SKILL.md)

**5. New body template section** (item 5):
- Define body section templates (G4 decision — CLI doesn't manage templates, templates defined here):
  - task: `## What to build` + `## Acceptance criteria` + `## Out of scope` (optional) + `## Testing` (optional)
  - research/grilling/prototype: `## Question`
  - to-spec spec ticket (type=task but to-spec template): `## Problem Statement` + `## Solution` + `## User Stories` + `## Implementation Decisions` + `## Testing Decisions` + `## Out of Scope` + `## Further Notes`
  - All types share: `## Answer` (CLI pre-sets) + `## Comments` (CLI pre-sets)

### Implementation notes

- File path: `/mnt/disk1/hyx/.pi/agent/skills/setup-matt-pocock-skills/issue-tracker-local.md`
- This is the seed template that `setup-matt-pocock-skills` writes to new repos — updating it means new repos get the new format automatically
- The updated file must be consistent with the CLI's actual behavior (Ticket 01-06)

### Testing

- Manual review: read the updated file, verify all 5 updates are present
- Cross-check: verify CLI command references match actual CLI spec in route.md
- Verify body templates match to-spec/SKILL.md and wayfinder/SKILL.md definitions

## Acceptance criteria

- [ ] Conventions section uses YAML front matter format
- [ ] Wayfinding operations references CLI commands (not text-line operations)
- [ ] Publish/fetch section references `tracker ticket create`
- [ ] "实现操作" section added with `Resolves <map>/#<N>` convention
- [ ] Body template section defines task/research/grilling/prototype/spec templates
- [ ] File is consistent with CLI spec in route.md
