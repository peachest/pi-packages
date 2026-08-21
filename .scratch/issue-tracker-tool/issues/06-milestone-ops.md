---
id: "06"
title: milestone state + milestone progress + milestone list
map: issue-tracker-tool
type: task
status: open
triage: null
blocked_by: ["05"]
created_at: 2026-08-19T12:00:00Z
reviewed_at: null
claimed_at: null
resolved_at: null
---

# milestone state + milestone progress + milestone list

## What to build

Milestone lifecycle and query — three commands for managing milestones above maps.

### `milestone state` command

```
tracker milestone state --slug <slug> --set <active|closed>
```

- Read `.scratch/.milestones/<slug>.md`, parse front matter
- Update `state:` field and timestamp (same pattern as `map state`):
  - `--set closed`: set `state: closed`, `closed_at: <now>`
  - `--set active`: set `state: active`, `closed_at: null`
- Return JSON: `{"slug": "ppu-mig-device-plugin", "title": "PPU MIG 设备插件", "state": "closed", "closed_at": "..."}`
- Milestone file not found → exit 2: `Error: Milestone '<slug>' not found. No .scratch/.milestones/<slug>.md file.`

### `milestone progress` command

```
tracker milestone progress --slug <slug>
```

- Read milestone front matter (title, state)
- Find all maps with `milestone: <slug>` in their front matter (scan `.scratch/*/map.md`)
- For each map: call `ComputeProgress(fs, mapSlug)` from Ticket 05 (G-Q6 — Progress struct, no frontier_size)
- Aggregate across maps: sum open/claimed/resolved/total
- Return JSON: `{"slug": "ppu-mig-device-plugin", "title": "...", "state": "active", "maps": ["mig-integration", "dynamic-reconfig", "health-monitor"], "progress": {"open": 5, "claimed": 2, "resolved": 8, "total": 16}}`
- **No frontier_size** in milestone progress (G-Q6 — frontier is a per-map concept, not meaningful at milestone level)

### `milestone list` command

```
tracker milestone list
```

- Scan `.scratch/.milestones/` for `.md` files
- For each milestone: parse front matter (title, state), count maps referencing it
- Return JSON: `[{"slug": "ppu-mig-device-plugin", "title": "...", "state": "active", "map_count": 3}, ...]`
- Sort by slug ascending
- If `.scratch/.milestones/` doesn't exist → return `[]` (no milestones yet)

### Implementation notes

- Map-to-milestone relationship is via Map front matter `milestone:` field — milestone doesn't store a list of maps, it's derived
- `ComputeProgress` from Ticket 05 is reused for per-map progress (G-Q6)
- Milestone discovery: `afero.ReadDir(.scratch/.milestones/)`, filter `.md` files

### Testing

- Table-driven: state transitions, progress aggregation across maps, list
- afero MemMapFs: pre-create milestones + maps with various ticket states
- Test milestone with 0 maps → progress zeros, maps=[]
- Test `.milestones/` doesn't exist → `[]`
- Test aggregation: 2 maps with different progress → correct sum
- Test no frontier_size in milestone progress JSON

## Acceptance criteria

- [ ] `tracker milestone state --slug m --set closed` updates state + closed_at
- [ ] `tracker milestone progress --slug m` aggregates across all maps in milestone
- [ ] `milestone progress` uses `ComputeProgress` from Ticket 05 (G-Q6)
- [ ] `milestone progress` does NOT include frontier_size
- [ ] `tracker milestone list` returns all milestones with map_count
- [ ] Milestone with 0 maps → progress zeros, maps=[]
- [ ] `.milestones/` doesn't exist → `[]`
- [ ] Milestone not found → exit 2 with actionable error
- [ ] All tests use afero MemMapFs
- [ ] `go vet ./...` clean
