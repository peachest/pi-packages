---
id: "08"
title: Skill migration - to-tickets + wayfinder + triage + implement + to-spec
map: issue-tracker-tool
type: task
status: open
triage: null
blocked_by: ["07"]
created_at: 2026-08-19T12:00:00Z
reviewed_at: null
claimed_at: null
resolved_at: null
---

# Skill migration - to-tickets + wayfinder + triage + implement + to-spec

## What to build

Update 5 skill files to reference the new local tracker format and CLI. All changes reference issue-tracker-local.md (Ticket 07) as the canonical source.

### to-tickets/SKILL.md (items 6-8)

**Item 6 — Rewrite `<local-ticket-template>`**:
- Current: `**What to build:**` / `**Blocked by:**` / `**Status:**` text lines
- New: YAML front matter + body sections referencing issue-tracker-local.md templates
- **Only change `<local-ticket-template>`** — `<issue-template>` (GitHub/GitLab) unchanged

**Item 7 — Update publish path**:
- Current: "Local files → write one file per ticket"
- New: "Local files → run `tracker ticket create` for each ticket"

**Item 8 — Triage behavior change** (flag as data-model-driven correction):
- Current: "Apply the `ready-for-agent` triage label unless instructed otherwise"
- New: wayfinder/to-tickets tickets don't set triage field (null). `ready-for-agent` only for external inbound issues.
- Add note: this is a data-model correction (old behavior assumed triage=label; new model separates Status from Triage), not a skill business-logic change

### wayfinder/SKILL.md (items 9-10)

**Item 9 — Map body template**:
- Add front matter example (`title/state/milestone/created_at/closed_at`) to Map body template

**Item 10 — Work through the map**:
- Reference CLI commands: `tracker ticket status --set claimed` / `tracker ticket status --set resolved`
- Note semantic mapping: wayfinder says "assign it to yourself", local CLI uses `status --set claimed` (no assignee field, claimed status = claim)

### triage/SKILL.md (item 11)

**Add local tracker path**:
- Triage operations on local: `tracker ticket triage --set <role>` (read/write `triage:` field)
- wontfix is triage role: `tracker ticket triage --set wontfix` (NOT status change)
- Triage Roles section: keep 5 roles unchanged
- **triage category (bug/enhancement) is GitHub/GitLab-only** — local tickets have state roles only, no category field
- triage skill's "exactly one category role and one state role" rule applies to GitHub/GitLab only; local tickets require only state role (optional)

### implement/SKILL.md (item 15)

- Do NOT add commit convention here (G7 decision)
- Add one line: "commit convention见 tracker config" (generic reference)
- implement/SKILL.md stays generic

### to-spec/SKILL.md (item 18)

**Update local publish path** (R3-Q1):
- to-spec in local tracker: call `tracker ticket create --map <slug> --title "Spec: ..." --type task --triage ready-for-agent`
- Then fill body with bash/edit (to-spec's own template: Problem Statement / Solution / etc.)
- **to-spec tickets retain `triage: ready-for-agent`** — unlike wayfinder/to-tickets (triage=null), to-spec output is agent-grabbable by construction
- to-spec body template unchanged

### Testing

- Manual review: each updated skill file references correct CLI commands
- Cross-check: verify CLI command names match route.md spec
- Verify `<issue-template>` in to-tickets unchanged
- Verify triage Roles section still has 5 roles
- Verify to-spec body template unchanged

## Acceptance criteria

- [ ] to-tickets `<local-ticket-template>` uses YAML front matter
- [ ] to-tickets publish path references `tracker ticket create`
- [ ] to-tickets triage behavior change documented
- [ ] wayfinder Map template has front matter example
- [ ] wayfinder references CLI commands for claim/resolve
- [ ] triage has local tracker path with wontfix as triage role
- [ ] triage category marked GitHub/GitLab-only
- [ ] implement has generic "见 tracker config" reference
- [ ] to-spec local publish path uses `tracker ticket create --triage ready-for-agent`
- [ ] to-spec body template unchanged
