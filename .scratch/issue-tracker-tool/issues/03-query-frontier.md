---
id: "03"
title: query frontier
map: issue-tracker-tool
type: task
status: resolved
triage: null
blocked_by: ["02"]
created_at: 2026-08-19T12:00:00Z
reviewed_at: 2026-08-21T09:57:38Z
claimed_at: 2026-08-21T09:57:38Z
resolved_at: 2026-08-21T10:00:00Z
---

# query frontier

## What to build

The frontier query command — wayfinder's core "what can I work on now" operation. This ticket implements the `query frontier` CLI command which calls the shared `Frontier()` function from Ticket 01's `frontier.go` (G-Q7).

### `query frontier` command

```
tracker query frontier --map <slug>
```

- Calls `tracker.Frontier(fs, mapSlug)` from Ticket 01's shared `frontier.go` module (G-Q7)
- A ticket is in the frontier if ALL of:
  1. `status == "open"`
  2. `triage == null || triage == "ready-for-agent"`
  3. Every ticket in `blocked_by` has `status == "resolved"` (only resolved unblocks; wontfix does not unblock)
- Return JSON array sorted by id ascending: `[{"id": "02", "title": "...", "type": "research", "status": "open", "triage": "ready-for-agent", "blocked_by": []}, ...]`
- If no tickets in frontier, return `[]`
- Sorting: use `slices.SortFunc` with `cmp.Compare` on id strings

### Implementation notes

- **No frontier logic in this ticket** — the `Frontier()` function is already implemented in Ticket 01's `frontier.go`. This ticket only implements the cobra command wrapper that calls it and formats JSON output.
- **No dangling blocked_by possible** — Ticket 02's `ticket blocking` validates that all blocked_by IDs exist (G-Q4), so frontier query never encounters a dangling reference.
- **Self-blocking tickets** — a ticket blocking itself can never enter the frontier (it can never be resolved, so it never unblocks itself). This is naturally handled by the frontier conditions.

### Testing

- Table-driven: various combinations of status/triage/blocked_by
- Test case: ticket with triage=needs-info excluded from frontier
- Test case: ticket blocked by a wontfix ticket — NOT in frontier (wontfix doesn't unblock)
- Test case: ticket blocked by a resolved ticket — IN frontier
- Test case: ticket blocked by a claimed ticket — NOT in frontier
- Test case: self-blocking ticket (#03 blocked_by ["03"]) — NOT in frontier
- Test case: empty map → `[]`
- afero MemMapFs with pre-created ticket files
- Command test via `NewRootCmd()` factory with `SetOut`/`SetArgs`/`ExecuteContext`

## Acceptance criteria

- [ ] `tracker query frontier --map m` returns open + unblocked + unclaimed tickets
- [ ] Tickets with triage=needs-info or triage=ready-for-human excluded
- [ ] Tickets with triage=null or triage=ready-for-agent included
- [ ] Ticket blocked by wontfix ticket NOT in frontier
- [ ] Ticket blocked by resolved ticket IN frontier
- [ ] Ticket blocked by claimed ticket NOT in frontier
- [ ] Self-blocking ticket NOT in frontier
- [ ] Result sorted by id ascending
- [ ] Empty frontier returns `[]`
- [ ] Calls shared `Frontier()` from `frontier.go` (no duplicated logic)
- [ ] All tests use afero MemMapFs
- [ ] `go vet ./...` clean
