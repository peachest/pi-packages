---
id: "06"
title: milestone state + milestone progress + milestone list
map: issue-tracker-tool
type: task
status: resolved
triage: null
blocked_by: ["05"]
created_at: 2026-08-19T12:00:00Z
reviewed_at: 2026-08-26T07:47:03Z
claimed_at: 2026-08-26T07:47:03Z
resolved_at: 2026-08-26T07:55:00Z
---

# milestone state + milestone progress + milestone list

## What to build

Milestone lifecycle and query — three commands for managing milestones above maps. Terrain context: Ticket 05 already implemented `MapFrontMatter`, `Progress`, `ComputeProgress(fs, scratchDir, mapSlug)`, `ListMaps(fs, scratchDir)`, `SetMapState` in `tracker/map.go` and `tracker/map_ops.go`.

### MilestoneFrontMatter struct (grilling Q1=A)

New struct in `tracker/milestone.go`:

```go
type MilestoneFrontMatter struct {
    Title     string     `yaml:"title"`
    State     string     `yaml:"state"`
    CreatedAt time.Time  `yaml:"created_at"`
    ClosedAt  *time.Time `yaml:"closed_at"`
}
```

- **Separate struct, NOT reuse MapFrontMatter** (grilling Q1=A) — milestone has no `milestone` field (it IS a milestone)
- Marshal/parse: same pattern as MapFrontMatter (fixed key order: title, state, created_at, closed_at)
- File: `.scratch/.milestones/<slug>.md`, created by agent manually (grilling Q3=A) — CLI does NOT create it, only reads/writes front matter. Consistent with thin CRUD (G-Q15).

### `milestone state` command

```
tracker milestone state --slug <slug> --set <active|closed>
```

- Read `.scratch/.milestones/<slug>.md`, parse front matter
- Update `state:` field and timestamp (same pattern as `map state`):
  - `--set closed`: set `state: closed`, `closed_at: <now>`
  - `--set active`: set `state: active`, `closed_at: null`
- Return JSON: `{"slug": "ppu-mig-device-plugin", "title": "PPU MIG 设备插件", "state": "closed", "closed_at": "<ISO8601 UTC>"}`
- Milestone file not found → exit 2: `Error: Milestone '<slug>' not found. No .scratch/.milestones/<slug>.md file.`

### `milestone progress` command

```
tracker milestone progress --slug <slug>
```

- Read milestone front matter (title, state)
- Find all maps with `milestone: <slug>` in their front matter: call `ListMaps(fs, scratchDir)` then `FilterMapsByMilestone(maps, slug)` (already implemented in Ticket 05's `map_ops.go`)
- For each matched map: call `ComputeProgress(fs, scratchDir, mapSlug)` — **3 params** (G-Q6, matches implemented signature; NOT the 2-param version in the original ticket draft)
- Aggregate across maps: sum open/claimed/resolved/total
- Return JSON: `{"slug": "ppu-mig-device-plugin", "title": "...", "state": "active", "maps": ["mig-integration", "dynamic-reconfig", "health-monitor"], "progress": {"open": 5, "claimed": 2, "resolved": 8, "total": 16}}`
- **No frontier_size** in milestone progress (G-Q6 — frontier is a per-map concept, not meaningful at milestone level)

### `milestone list` command

```
tracker milestone list
```

- Scan `.scratch/.milestones/` for `.md` files
- For each milestone: parse front matter (title, state), count maps referencing it (`FilterMapsByMilestone` length)
- Return JSON: `[{"slug": "ppu-mig-device-plugin", "title": "...", "state": "active", "map_count": 3}, ...]`
- Sort by slug ascending
- If `.scratch/.milestones/` doesn't exist → return `[]` (no milestones yet)

### Implementation notes

- Map-to-milestone relationship is via Map front matter `milestone:` field — milestone doesn't store a list of maps, it's derived
- `MilestoneFrontMatter` creation is manual (grilling Q3=A): agent writes `.scratch/.milestones/<slug>.md` with front matter + body using bash/edit, same as map.md
- Milestone discovery: `afero.ReadDir(.scratch/.milestones/)`, filter `.md` files
- `ComputeProgress` and `FilterMapsByMilestone` from Ticket 05 are reused (no duplicated logic)

### Testing

- Table-driven: state transitions, progress aggregation across maps, list
- afero MemMapFs: pre-create milestones + maps with various ticket states
- **MilestoneFrontMatter round-trip test**: marshal → parse → verify equal (title/state/created_at/closed_at)
- **MilestoneFrontMatter with closed state test**: closed_at set
- **Map find test**: ListMaps + FilterMapsByMilestone returns only maps with matching milestone
- **milestone progress test**: maps with matching milestone aggregated, maps without milestone excluded
- Test milestone with 0 maps → progress zeros, maps=[]
- Test `.milestones/` doesn't exist → `[]`
- Test aggregation: 2 maps with different progress → correct sum
- **milestone not found test**: state on nonexistent → ErrNotFound
- Test no frontier_size in milestone progress JSON

## Acceptance criteria

- [ ] `MilestoneFrontMatter` struct defined in `tracker/milestone.go` with title/state/created_at/closed_at (grilling Q1=A)
- [ ] Milestone front matter round-trip: marshal → parse → equal
- [ ] Milestone file is `.scratch/.milestones/<slug>.md`, created by agent manually (grilling Q3=A)
- [ ] `tracker milestone state --slug m --set closed` updates state + closed_at
- [ ] `tracker milestone state --slug m --set active` resets closed_at to null
- [ ] `tracker milestone progress --slug m` aggregates across all maps in milestone
- [ ] `milestone progress` uses `ComputeProgress(fs, scratchDir, mapSlug)` — 3 params, matches implemented signature (G-Q6)
- [ ] `milestone progress` uses `ListMaps` + `FilterMapsByMilestone` to find referencing maps
- [ ] `milestone progress` does NOT include frontier_size
- [ ] `tracker milestone list` returns all milestones with map_count
- [ ] `milestone list` sorts by slug ascending
- [ ] Milestone with 0 maps → progress zeros, maps=[]
- [ ] `.milestones/` doesn't exist → `[]`
- [ ] Milestone not found → exit 2 with actionable error
- [ ] All tests use afero MemMapFs
- [ ] `go vet ./...` clean