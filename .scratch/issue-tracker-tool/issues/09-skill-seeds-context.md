---
id: "09"
title: Skill migration - setup seeds + CONTEXT.md
map: issue-tracker-tool
type: task
status: resolved
triage: null
blocked_by: ["07"]
created_at: 2026-08-19T12:00:00Z
reviewed_at: 2026-08-26T08:08:11Z
claimed_at: 2026-08-26T08:08:11Z
resolved_at: 2026-08-26T08:10:00Z
---

# Skill migration - setup seeds + CONTEXT.md

## What to build

Update seed templates and the Navigation Metaphor glossary.

### setup-matt-pocock-skills/SKILL.md (items 12-14)

**Item 12 — Update issue-tracker-local.md seed**:
- Current seed: old format (`Status:` / `Type:` / `Blocked by:` text lines)
- New seed: matches new YAML front matter format (consistent with Ticket 07's rewrite)

**Item 13 — Section B text "five canonical roles"**:
- **No change** — triage keeps 5 roles (including wontfix), wontfix not removed

**Item 14 — triage-labels.md seed**:
- **No change** — 5 state roles unchanged

### CONTEXT.md (item 16)

**Update Destination avoid list**:
- Current: `_Avoid_: goal, objective, milestone`
- New: `_Avoid_: goal, objective` (remove `milestone`)

**Add Milestone glossary entry**:
```markdown
- **Milestone**: A checkpoint above the Map — a named long-term goal containing multiple related Maps. Tracks progress across Maps (resolved / total). Distinct from Destination (the end of one Map) and Map (the decision index for one effort). Persistence: `.scratch/.milestones/<slug>.md`.
_Avoid_: phase, stage, sprint
```

**Add Progress glossary entry**:
```markdown
- **Progress**: A derived view — ticket counts by status (open / claimed / resolved) within a Map or Milestone. Not persisted; computed on demand by CLI (`tracker map progress`, `tracker milestone progress`).
_Avoid_: stats, metrics
```

### Implementation notes

- CONTEXT.md path: `/mnt/disk1/hyx/skills/CONTEXT.md`
- setup-matt-pocock-skills path: `/mnt/disk1/hyx/.pi/agent/skills/setup-matt-pocock-skills/SKILL.md`
- The seed template for issue-tracker-local.md is a **separate file** in the setup-matt-pocock-skills skill folder: `/mnt/disk1/hyx/.pi/agent/skills/setup-matt-pocock-skills/issue-tracker-local.md`. SKILL.md §4 references it ("write the docs files using the seed templates in this skill folder"). Ticket 07 rewrites this same file; Ticket 09 updates the setup-matt-pocock-skills/SKILL.md references if needed (items 13-14 = no change).
- New glossary entries must match existing entry style (term + description + `_Avoid_:` line)

### Testing

- Manual review: read updated CONTEXT.md, verify Milestone and Progress entries present
- Verify Destination avoid list no longer contains `milestone`
- Verify seed template matches new YAML format
- Verify Section B and triage-labels.md unchanged
- Cross-check: verify Milestone definition matches route.md data model

## Acceptance criteria

- [ ] issue-tracker-local.md seed template matches new YAML front matter format
- [ ] Section B "five canonical roles" text unchanged
- [ ] triage-labels.md seed unchanged (5 roles)
- [ ] CONTEXT.md Destination avoid list: `milestone` removed
- [ ] CONTEXT.md has Milestone glossary entry with `_Avoid_: phase, stage, sprint`
- [ ] CONTEXT.md has Progress glossary entry with `_Avoid_: stats, metrics`
- [ ] New glossary entries match existing entry style
