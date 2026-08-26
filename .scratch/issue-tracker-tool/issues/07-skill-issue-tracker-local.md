---
id: "07"
title: Skill migration - issue-tracker-local.md
map: issue-tracker-tool
type: task
status: resolved
triage: null
blocked_by: ["01"]
created_at: 2026-08-19T12:00:00Z
reviewed_at: 2026-08-26T07:52:59Z
claimed_at: 2026-08-26T07:52:59Z
resolved_at: 2026-08-26T08:00:00Z
---

# Skill migration - issue-tracker-local.md

## What to build

Rewrite `issue-tracker-local.md` — the core reference document for local tracker. This is the canonical source that all other skill migrations reference.

### 5 updates (route migration plan items 1-5)

**1. Conventions section** (item 1):
- Current: `Status:` line records triage state; `Type:` line records ticket type; `Blocked by: NN, NN` line
- New: YAML front matter with ALL fields: `id/title/map/type/status/triage/blocked_by/created_at/reviewed_at/claimed_at/resolved_at` (G-Q12 — reviewed_at is mandatory, claim precondition)
- Timestamps written as ISO 8601 UTC (e.g. `2026-08-21T09:00:00Z`), NOT `<now>` shorthand
- Body only free-text sections

**2. Wayfinding operations section** (item 2):
- Current: Claim=set `Status: claimed`; Resolve=append `## Answer` + set `Status: resolved` + append decision pointer; Frontier=scan issues/
- New: Reference CLI commands (all verified implemented in Tickets 01-06):
  - Claim: `tracker ticket status --map <slug> --id <N> --set claimed` (requires `reviewed_at != null`, G-Q12)
  - Resolve: **agent workflow** (CLI is thin CRUD, G-Q15 — G2 withdrawn, `--set resolved` allowed): (1) agent fills `## Answer` section using bash/edit, (2) agent appends decision pointer line to map.md's `## Decisions so far` using bash/edit, (3) `tracker ticket status --map <slug> --id <N> --set resolved`. Decision pointer line format: `- [#<id> <title>](issues/<NN>-<slug>.md) — <gist>` (grilling Q2=A). On reopen+re-resolve: agent replaces existing pointer line (matched by `- [#<id>` prefix).
  - Reopen: `tracker ticket status --map <slug> --id <N> --set open` (clears resolved_at + claimed_at). Agent handles map.md decision pointer (replace or remove) per issue-tracker-local.md.
  - Review: `tracker ticket review --map <slug> --id <N>` (run after review-spec passes, sets reviewed_at — G-Q12)
  - Frontier: `tracker query frontier --map <slug>`
- **NOTE for implementer**: route.md migration plan item 2 STILL references the deleted `tracker ticket resolve` command (stale). Ticket 07 is correct — follow G-Q15, NOT route.md item 2. Fix route.md item 2 too.

**3. Publish/fetch section** (item 3):
- Current: "Create a new file" / "Read the file"
- New: publish=`tracker ticket create`; fetch=read file (unchanged) or `tracker ticket list --map <slug>`

**4. New "实现操作" section** (item 4):
- Local ticket commit convention: `Resolves <map>/#<N>` (G7 decision — commit convention in tracker doc, not implement/SKILL.md)

**5. New body template section** (item 5):
- Define body section templates (G4 decision — CLI doesn't manage templates, templates defined here). Exact headings:
  - task: `## What to build` + `## Acceptance criteria` + `## Out of scope` (optional) + `## Testing` (optional)
  - research/grilling/prototype: `## Question`
  - to-spec spec ticket (type=task but to-spec template): `## Problem Statement` + `## Solution` + `## User Stories` + `## Implementation Decisions` + `## Testing Decisions` + `## Out of Scope` + `## Further Notes`
  - All types share: `## Answer` (CLI pre-sets) + `## Comments` (CLI pre-sets)

### Implementation notes

- File path: `/mnt/disk1/hyx/.pi/agent/skills/setup-matt-pocock-skills/issue-tracker-local.md`
- This is the seed template that `setup-matt-pocock-skills` writes to new repos — updating it means new repos get the new format automatically
- The updated file must be consistent with the CLI's actual behavior (Tickets 01-06 implemented)
- **Route fix**: update route.md migration plan item 2 to remove the stale `tracker ticket resolve` reference (task gap #4 from review)

### Testing

- Manual review: read the updated file, verify all 5 updates are present
- Cross-check: verify CLI command references match actual implemented commands (`ticket status --set resolved`, NOT `ticket resolve`)
- Verify body templates match to-spec/SKILL.md and wayfinder/SKILL.md definitions
- Verify decision pointer format matches grilling Q2=A (`- [#<id> <title>](issues/<NN>-<slug>.md) — <gist>`)

## Acceptance criteria

- [ ] Conventions section uses YAML front matter with ALL fields including `reviewed_at` (G-Q12~Q14)
- [ ] Timestamps written as ISO 8601 UTC, not `<now>` shorthand
- [ ] Wayfinding operations references implemented CLI commands (claim, resolve, reopen, review, frontier)
- [ ] Resolve workflow documented as agent workflow (fill Answer → append decision pointer → `status --set resolved`)
- [ ] G2 withdrawal named explicitly (`--set resolved` allowed, G-Q15)
- [ ] Reopen workflow documented (`--set open` clears resolved_at + claimed_at)
- [ ] Review command documented (`tracker ticket review`, G-Q12)
- [ ] Publish/fetch section references `tracker ticket create` + `tracker ticket list`
- [ ] "实现操作" section added with `Resolves <map>/#<N>` convention
- [ ] Body template section defines task/research/grilling/prototype/spec templates with exact headings
- [ ] Decision pointer format: `- [#<id> <title>](issues/<NN>-<slug>.md) — <gist>`
- [ ] route.md migration plan item 2 updated (stale `ticket resolve` reference removed)
- [ ] File is consistent with CLI spec in route.md (all commands verified against implemented code)