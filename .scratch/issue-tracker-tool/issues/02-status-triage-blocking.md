---
id: "02"
title: ticket status + ticket triage + ticket blocking
map: issue-tracker-tool
type: task
status: resolved
triage: null
blocked_by: ["01"]
created_at: 2026-08-19T12:00:00Z
reviewed_at: 2026-08-21T09:19:54Z
claimed_at: 2026-08-21T09:20:00Z
resolved_at: 2026-08-21T09:45:00Z
---

# ticket status + ticket triage + ticket blocking

## What to build

Ticket lifecycle and dependency management — three commands that modify ticket state. CLI is thin CRUD (G-Q15): only front matter fields, no body content manipulation.

### `ticket status` command

```
tracker ticket status --map <slug> --id <N> --set <open|claimed|resolved>
```

- `--set` accepts `open`, `claimed`, or `resolved` (G2 撤回 — thin CRUD, CLI 不绑定内容操作)
- **`--set claimed`**: check `reviewed_at != null` (G-Q12). If null → error exit 1 (ErrInvalidInput): `Error: Ticket #03 has not been reviewed. Run /skill:review-spec and 'tracker ticket review --map <slug> --id 3' before claiming.` If reviewed → update front matter `status: claimed`, `claimed_at: <now>`. Return JSON.
- **`--set open`** (release claim): update front matter `status: open`, `claimed_at: null`. Return JSON.
- **`--set open`** (reopen resolved, G-Q1/Q2/Q3): update front matter `status: open`, `resolved_at: null`, `claimed_at: null` (both cleared — reopened ticket returns to unclaimed open state). Agent handles map.md decision pointer per issue-tracker-local.md.
- **`--set resolved`**: update front matter `status: resolved`, `resolved_at: <now>`. Agent responsibility: fill `## Answer` + append map.md decision pointer BEFORE calling this (documented in issue-tracker-local.md). CLI does NOT check or modify body content.
- **`--set claimed` on a resolved ticket** → error exit 3 (ErrAlreadyResolved): `Error: Ticket #03 is already resolved. Use 'tracker ticket status --set open' to reopen first.`
- **`--set resolved` on already resolved ticket** → error exit 3 (ErrAlreadyResolved): `Error: Ticket #03 is already resolved.`
- ID input normalization: accept `3` or `03`, match against front matter id (zero-padded 2-digit string)

### `ticket triage` command

```
tracker ticket triage --map <slug> --id <N> --set <triage>
```

- `--set` accepts 5 values: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix` (triage 5 roles unchanged)
- **Enum validation (G-Q10)**: invalid values → error exit 1: `Error: Invalid triage 'foo'. Valid values: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix.`
- Update front matter `triage:` field. Return JSON.
- wontfix is a triage role, NOT a status change — `tracker ticket triage --set wontfix` only updates the triage field, does not touch status

### `ticket blocking` command

```
tracker ticket blocking --map <slug> --id <N> --by 1,2
```

- **Replace (SET) semantics** (G5 decision) — `--by` overwrites entire `blocked_by` array
- `--by ""` (empty string) clears all blockers → `blocked_by: []`
- Parse comma-separated IDs, normalize to zero-padded 2-digit strings
- **ID validation (G-Q4)**: each ID in `--by` must correspond to an existing ticket in the same map. Non-existent ID → error exit 1: `Error: Ticket #99 not found in map. Cannot block on a non-existent ticket.`
- **Self-blocking**: `--by 3` on ticket #03 is a self-cycle. DFS catches it → error exit 3 (ErrCycleDetected): `Error: Cannot set blocking: ticket #03 → #03 creates a cycle (self-blocking). A ticket cannot block itself.`
- **Cycle detection (G-Q6)**: before writing, build adjacency list with the PROPOSED new edges (replace current ticket's blocked_by with `--by` values, other tickets use existing blocked_by). DFS from this ticket. If cycle found → error exit 3: `Error: Cannot set blocking: ticket #03 → #01 → #03 creates a cycle. Remove #01 from blocked_by or check if #01 should block #03 instead.`
- Return JSON: `{"id": "03", "map": "...", "blocked_by": ["01", "02"], "cycle_detected": false}`
- Cycle detection implementation: build adjacency list from all tickets' blocked_by fields in the map (with current ticket's edges replaced by proposed `--by` values), DFS with visited+recursion-stack tracking. Use `slices.Contains` for membership checks.

### Exit code wiring (task gap from review)

The implemented `main.go` always calls `os.Exit(1)`. The `printError` function in `cmd/ticket.go` is dead code. This ticket must wire exit codes:

- Update `main.go` (or `cmd.Execute`) to use `errors.Is` to map sentinel errors to exit codes:
  - `ErrNotFound` → exit 2
  - `ErrAlreadyResolved`, `ErrCycleDetected` → exit 3
  - `ErrInvalidInput`, `ErrHeadingMissing`, others → exit 1
- The `printError` function in `cmd/ticket.go` should be called from `main.go` (or the error should be returned and translated in main)

### Testing

- Table-driven: each status transition, each triage value, blocking set/clear/cycle
- afero MemMapFs: pre-create ticket files, verify front matter after command
- Cycle detection test: create 3 tickets with circular blocked_by, verify error
- **Self-blocking test**: `--by 3` on ticket #03 → exit 3 with self-cycle error message
- **Reopen test**: resolve a ticket (set resolved), then `--set open` → status=open, resolved_at=null, claimed_at=null
- **Reopen then re-resolve test**: reopen, then `--set resolved` → status=resolved, resolved_at=now
- **Claim on resolved test**: `--set claimed` on resolved → exit 3
- **`--set resolved` on already resolved test**: → exit 3
- Test ID normalization: `--id 3` and `--id 03` both work
- **Exit code waymarks**: verify `ErrAlreadyResolved` → exit 3, `ErrCycleDetected` → exit 3, `ErrInvalidInput` → exit 1, `ErrNotFound` → exit 2
- **Invalid blocked_by ID test**: `--by 99` (non-existent) → exit 1
- **Unreviewed claim test**: `--set claimed` on ticket with reviewed_at=null → exit 1

## Acceptance criteria

- [ ] `tracker ticket status --map m --id 1 --set claimed` updates status + claimed_at
- [ ] `--set claimed` on unreviewed ticket (reviewed_at=null) → exit 1 with review hint (G-Q12)
- [ ] `--set claimed` on reviewed ticket (reviewed_at != null) → succeeds
- [ ] `tracker ticket status --map m --id 1 --set open` resets claimed_at to null
- [ ] `tracker ticket status --set resolved` allowed (G2 撤回), sets resolved_at
- [ ] `--set open` on resolved ticket → status=open, resolved_at=null, claimed_at=null (reopen, G-Q1/Q2/Q3)
- [ ] `--set claimed` on resolved ticket → exit 3 with reopen hint
- [ ] `--set resolved` on already resolved ticket → exit 3
- [ ] `tracker ticket triage --map m --id 1 --set ready-for-agent` updates triage field
- [ ] `tracker ticket triage --set wontfix` only updates triage, not status
- [ ] `tracker ticket triage --set invalid` rejected with exit 1 and valid values listed
- [ ] `tracker ticket blocking --map m --id 3 --by 1,2` sets blocked_by to ["01","02"]
- [ ] `tracker ticket blocking --map m --id 3 --by ""` clears blocked_by to []
- [ ] `tracker ticket blocking --map m --id 3 --by 99` (non-existent ID) → exit 1
- [ ] Circular blocking detected and rejected with exit code 3
- [ ] Self-blocking (`--by 3` on #03) detected and rejected with exit code 3
- [ ] DFS uses proposed new edges, not old edges (G-Q6)
- [ ] ID normalization: `--id 3` and `--id 03` both match ticket "03"
- [ ] Exit code mapping wired in main.go: ErrNotFound→2, ErrAlreadyResolved/ErrCycleDetected→3, ErrInvalidInput→1
- [ ] All tests use afero MemMapFs
- [ ] `go vet ./...` clean
