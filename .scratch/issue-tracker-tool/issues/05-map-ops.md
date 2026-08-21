---
id: "05"
title: map state + map progress + map list
map: issue-tracker-tool
type: task
status: resolved
triage: null
blocked_by: ["01"]
created_at: 2026-08-19T12:00:00Z
reviewed_at: 2026-08-21T10:05:20Z
claimed_at: 2026-08-21T10:05:20Z
resolved_at: 2026-08-21T10:15:00Z
---

# map state + map progress + map list

## What to build

Map lifecycle and query — three commands for managing maps.

### `map state` command

```
tracker map state --slug <slug> --set <active|closed>
```

- Read `.scratch/<slug>/map.md`, parse front matter
- Update `state:` field and timestamp:
  - `--set closed`: set `state: closed`, `closed_at: <now>`
  - `--set active`: set `state: active`, `closed_at: null` (reopen)
- Return JSON: `{"slug": "slo-testing", "title": "SLO Testing", "state": "closed", "closed_at": "2026-08-20T00:00:00Z"}`
- Map directory not found → exit 2

### Progress struct (G-Q6)

This ticket defines the `Progress` struct and `ComputeProgress` function, used by Tickets 05 and 06:

```go
// Progress holds ticket status counts for a map or milestone.
// Does NOT include frontier_size — that is computed separately by
// ComputeFrontierSize() from Ticket 01's frontier.go (G-Q6/G-Q7).
type Progress struct {
    Open     int `json:"open"`
    Claimed  int `json:"claimed"`
    Resolved int `json:"resolved"`
    Total    int `json:"total"`
}

// ComputeProgress scans all tickets in a map and returns status counts.
func ComputeProgress(fs afero.Fs, mapSlug string) (Progress, error)
```

`frontier_size` is NOT in `Progress`. It is computed by `ComputeFrontierSize(fs, mapSlug)` from Ticket 01's `frontier.go` (G-Q7). Only `map progress` calls it; `map list` and `milestone progress` do not.

### `map progress` command

```
tracker map progress --slug <slug>
```

- Read map.md front matter (title, state, milestone)
- Call `ComputeProgress(fs, mapSlug)` → Progress struct
- Call `ComputeFrontierSize(fs, mapSlug)` from Ticket 01's `frontier.go` (G-Q7)
- Return JSON: `{"slug": "slo-testing", "title": "SLO Testing", "state": "active", "milestone": "inference-benchmarking", "progress": {"open": 2, "claimed": 1, "resolved": 3, "total": 6}, "frontier_size": 2}`
- `frontier_size` is a top-level field, NOT inside `progress` (G-Q6)

### `map list` command

```
tracker map list [--milestone <slug>]
```

- Scan `.scratch/` for directories containing `map.md` (skip `.milestones/` hidden directory)
- For each map: parse map.md front matter + call `ComputeProgress(fs, mapSlug)` (G-Q6 — no frontier_size in map list)
- Filter by `--milestone <slug>` if provided (match map front matter `milestone:` field)
- **Default includes all maps** (active + closed) — no state filter (R3-Q8)
- Return JSON array: `[{"slug": "slo-testing", "title": "...", "state": "active", "milestone": "...", "progress": {"open": 2, "claimed": 1, "resolved": 3, "total": 6}}, ...]`
- Sort by slug ascending (use `slices.SortFunc`)

### Implementation notes

- Map discovery: `afero.ReadDir(.scratch/)`, filter entries that are directories and not hidden (don't start with `.`), check for `map.md` existence
- `ComputeProgress` is shared between `map progress`, `map list`, and Ticket 06's `milestone progress`

### Testing

- Table-driven: state transitions, progress counting, list filtering
- afero MemMapFs: pre-create maps with various ticket states
- Test `--milestone` filter
- Test closed maps included in `map list` by default
- Test empty `.scratch/` → `[]`
- Test map with no tickets → Progress all zeros, total=0
- Test `map progress` includes `frontier_size` as top-level field
- Test `map list` does NOT include `frontier_size`

## Acceptance criteria

- [ ] `tracker map state --slug m --set closed` updates state + closed_at
- [ ] `tracker map state --slug m --set active` resets closed_at to null
- [ ] `tracker map progress --slug m` returns correct counts + frontier_size (top-level)
- [ ] `Progress` struct defined with `open/claimed/resolved/total` (no frontier_size)
- [ ] `ComputeProgress(fs, mapSlug)` function defined and exported
- [ ] `map progress` calls `ComputeFrontierSize` from Ticket 01's `frontier.go` (G-Q7)
- [ ] `tracker map list` returns all maps (active + closed) with progress (no frontier_size)
- [ ] `tracker map list --milestone infra` filters by milestone field
- [ ] Empty .scratch/ → `[]`
- [ ] Map with no tickets → progress zeros, total=0
- [ ] All tests use afero MemMapFs
- [ ] `go vet ./...` clean
