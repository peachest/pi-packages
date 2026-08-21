---
id: "01"
title: Go skeleton + ticket create + ticket list
map: issue-tracker-tool
type: task
status: open
triage: null
blocked_by: []
created_at: 2026-08-19T12:00:00Z
reviewed_at: 2026-08-21T06:59:17Z
claimed_at: null
resolved_at: null
---

# Go skeleton + ticket create + ticket list

## What to build

A buildable Go CLI binary with full infrastructure and the first two commands: `ticket create` and `ticket list`. This ticket delivers the foundation that all subsequent tickets build on.

### Technology stack (Go skill + cobra-viper skill driven)

- **Go 1.25+** — `t.Context()`, `slices`/`maps`/`cmp` stdlib, `iter` iterators
- **cobra** CLI framework (factory pattern, RunE, SilenceUsage/Errors, OutOrStdout) — consistent with gh/glab
- **No viper** — tracker is not config-driven; all input via cobra flags (YAGNI)
- **gopkg.in/yaml.v3** — YAML front matter parse/write
- **github.com/spf13/afero** — filesystem abstraction; MemMapFs for tests (Go skill: "Do not hardcode os package calls deep within business logic")
- **github.com/google/go-cmp/cmp** — struct comparison in tests (Go skill: "cmp over DeepEqual")
- **log/slog** — structured logging (pass logger, never use package-level globals beyond main)

### Module path

`github.com/peachest/pi-packages/tracker` — tracker lives in `tracker/` directory of the pi-packages monorepo.

### Package structure (cobra-viper skill: cmd/ + domain package)

```
pi-packages/
├── tracker/                      # this CLI
│   ├── main.go                   # minimal: signal.NotifyContext + cmd.Execute(ctx)
│   ├── go.mod                    # module github.com/peachest/pi-packages/tracker
│   ├── cmd/                      # cobra routing layer — zero business logic
│   │   ├── root.go               # NewRootCmd() factory, SilenceUsage/Errors, PersistentPreRunE
│   │   ├── ticket.go             # NewTicketCreateCmd(), NewTicketListCmd() factories
│   │   ├── ticket_test.go        # in-memory CLI testing via NewRootCmd()
│   │   ├── map.go                # (later: NewMapStateCmd() etc.)
│   │   ├── milestone.go          # (later)
│   │   └── query.go              # (later: NewQueryFrontierCmd())
│   └── tracker/                  # domain package — zero cobra/viper imports
│       ├── store.go              # .scratch/ discovery + afero.Fs operations
│       ├── frontmatter.go        # YAML front matter parse/write (fixed key order)
│       ├── ticket.go             # CreateTicket, ListTickets business logic
│       ├── slug.go               # slug generation
│       ├── frontier.go           # Frontier() + ComputeFrontierSize() — shared by tickets 03/05
│       ├── errors.go             # sentinel errors
│       ├── store_test.go
│       ├── frontmatter_test.go
│       ├── ticket_test.go
│       ├── slug_test.go
│       └── frontier_test.go

**Note**: `markdown.go` is NOT created in this ticket. CLI is thin CRUD (G-Q15) — it does not parse or modify markdown body content. Body operations (`## Answer` fill, map.md decision pointer append) are the agent's responsibility per issue-tracker-local.md.
```

**Key rules** (cobra-viper skill):
- `cmd/` does only: define cobra command, bind flags, call `tracker` package function, return error
- `tracker/` package has **zero imports** from `github.com/spf13/cobra` or viper
- `main.go` is minimal: `signal.NotifyContext` → `cmd.Execute(ctx)` → `os.Exit(1)` on error
- No `internal/`, no `utils/`, no `helpers/`

### Cobra command patterns (cobra-viper skill)

- **Factory functions**: `NewRootCmd()`, `NewTicketCreateCmd(v *viper.Viper)` — wait, no viper. `NewTicketCreateCmd()` returns `*cobra.Command`. Root factory creates and wires subcommands.
- **RunE**: all commands use `RunE`, never `Run` — errors propagate to main
- **SilenceUsage: true, SilenceErrors: true** on root — main prints errors to stderr
- **Output via cmd.OutOrStdout()**: JSON output through `cmd.OutOrStdout()`, errors through `cmd.ErrOrStderr()`. Tests capture via `root.SetOut(buf)`.
- **Args validation**: use `cobra.Args` validators (e.g., `cobra.NoArgs`), not manual checks in RunE

### main.go pattern

```go
package main

import (
    "context"
    "os"
    "os/signal"
    "syscall"

    "github.com/peachest/pi-packages/tracker/cmd"
)

func main() {
    ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
    defer stop()
    if err := cmd.Execute(ctx); err != nil {
        os.Exit(1)
    }
}
```

### Sentinel errors (tracker/errors.go)

```go
var (
    ErrNotFound        = errors.New("not found")
    ErrAlreadyResolved = errors.New("already resolved")
    ErrCycleDetected   = errors.New("cycle detected")
    ErrHeadingMissing  = errors.New("heading missing")
)
```

cmd/ layer uses `errors.Is` to translate to exit codes: `ErrNotFound` → exit 2, `ErrAlreadyResolved`/`ErrCycleDetected` → exit 3, `ErrHeadingMissing`/`ErrInvalidInput` → exit 1, others → exit 1.

**Note**: Permission denied (e.g. `.scratch/` not writable) is a user error → exit 1, NOT `ErrNotFound`. Use `ErrInvalidInput` or a generic error wrapped with context.

### .scratch/ discovery (route: CLI 安装与 .scratch/ 发现)

1. From cwd, search upward for first directory containing `.scratch/`. If found, use it.
2. If not found, auto-create `.scratch/` at git root (`git rev-parse --show-toplevel` + `.scratch/`). If not in git repo, create at cwd.
3. If git root or cwd not writable, error (exit 1): `Error: Cannot create .scratch/ directory at <path>: permission denied.` — this is a user error, NOT `ErrNotFound`.

### Slug generation (G-Q8)

CLI generates ticket filename slug from `--title`. Rules (in order):
1. Lowercase all ASCII characters
2. Spaces → hyphens
3. Delete all ASCII punctuation EXCEPT hyphen: `` !"#$%&'()*+,./:;<=>?@[\]^_`{|}~ `` (hyphen is preserved as separator)
4. Non-ASCII (中文 etc.) preserved
5. Collapse consecutive hyphens into one
6. Strip leading/trailing hyphens
7. Truncate to max 50 **runes** (not bytes — Chinese chars are 3 bytes each, 50 bytes = only 16 Chinese chars)

Examples:
- `"Spec: PPU MIG 调度实现"` → `spec-ppu-mig-调度实现`
- `"Fix bug #123 (urgent!)"` → `fix-bug-123-urgent`
- `"A!B@C#D$E"` → `abcde`

### `ticket create` command

```
tracker ticket create --map <slug> --title "..." --type <type> [--blocked-by 1,2] [--triage <t>]
```

**Enum validation (G-Q10)**: `--type` accepts only `research`/`prototype`/`grilling`/`task`. `--triage` accepts only `needs-triage`/`needs-info`/`ready-for-agent`/`ready-for-human`/`wontfix`. Invalid values → error exit 1: `Error: Invalid type 'foo'. Valid values: research, prototype, grilling, task.`

**blocked_by ID validation (G-Q4)**: `--blocked-by 1,2` — each ID must correspond to an existing ticket in the same map. Non-existent ID → error exit 1: `Error: Ticket #99 not found in map. Cannot block on a non-existent ticket.`

- Scan `issues/` directory for existing ticket files, parse front matter `id` fields, find max + 1, zero-pad to 2 digits (string, quoted in YAML: `"01"`, `"02"`, ..., `"10"`)
- If `.scratch/<map-slug>/` doesn't exist → `ErrNotFound`: `Error: Map '<slug>' not found. No .scratch/<slug>/ directory. Run 'tracker map list' to see available maps.`
- If `.scratch/<map-slug>/issues/` doesn't exist → auto-create (map dir exists = map created, issues/ is substructure)
- Write file: front matter + minimal body skeleton (`# <title>` + `## Answer` + `## Comments`)
- **YAML key order (G-Q9)**: front matter keys MUST appear in this exact order: `id, title, map, type, status, triage, blocked_by, created_at, reviewed_at, claimed_at, resolved_at`
- `blocked_by`: always write as array, `[]` if empty (never omit field)
- `--blocked-by 1,2`: parse comma-separated, normalize to zero-padded 2-digit strings `["01", "02"]`
- Return JSON to stdout: `{"id": "03", "title": "...", "map": "...", "type": "task", "status": "open", "path": ".scratch/.../issues/03-....md", "blocked_by": ["01", "02"], "triage": null, "created_at": "..."}`

### `ticket list` command

```
tracker ticket list --map <slug> [--status <s>] [--type <t>] [--triage <t>]
```

- Scan `issues/` directory, parse each file's front matter
- Filters are AND-combinable. `--triage null` matches triage=null/omitted. `--status`, `--type` accept their enum values.
- Return JSON array of ticket summaries: `[{"id": "01", "title": "...", "type": "task", "status": "resolved", "triage": null, "blocked_by": []}, ...]`
- Sort by id ascending (use `slices.SortFunc` + `cmp.Compare`)

### Error handling framework (route: 错误处理)

- Exit codes: 0=success, 1=user error, 2=not found, 3=conflict
- stderr format: `Error: <description>\nAvailable: <suggestion>`
- Never panic — domain functions return error, cmd/ translates to exit code + stderr
- Go skill: wrap with `fmt.Errorf("...: %w", err)` for context

### `ticket review` command (G-Q12)

```
tracker ticket review --map <slug> --id <N>
```

- Marks a ticket as reviewed by review-spec. Sets `reviewed_at: <now>` in front matter.
- Can be called multiple times (re-review updates `reviewed_at`).
- Return JSON: `{"id": "03", "map": "...", "reviewed_at": "2026-08-20T12:00:00Z"}`
- This command is called by the agent after running `/skill:review-spec` on the ticket.

### Frontier shared module (G-Q7)

This ticket creates `tracker/frontier.go` with two exported functions used by Tickets 03 and 05:

```go
// Frontier returns all tickets in the map matching frontier conditions:
// status=open + triage=null|ready-for-agent + all blocked_by tickets resolved.
func Frontier(fs afero.Fs, mapSlug string) ([]Ticket, error)

// ComputeFrontierSize returns len(Frontier(fs, mapSlug)).
// Convenience function for map progress.
func ComputeFrontierSize(fs afero.Fs, mapSlug string) (int, error)
```

Ticket 03's `query frontier` command calls `Frontier()`. Ticket 05's `map progress` calls `ComputeFrontierSize()`. Both depend on this shared module — no duplicated frontier logic.

### Out of scope

- **No backward compatibility (Q12)**: this is a new tool. Existing `.scratch/` files from manual wayfinder workflows are not migrated. Maps created before this CLI must be manually updated to include YAML front matter.
- **Installation**: `go install github.com/peachest/pi-packages/tracker/cmd/tracker@latest` from the pi-packages monorepo. Alternatively `go build` from `tracker/` directory.

### Testing (Go skill + cobra-viper skill driven)

- **Domain package tests** (`tracker/*_test.go`): table-driven, afero MemMapFs, `cmp.Diff`, `t.Context()`. Direct function calls, no cobra.
- **Command tests** (`cmd/*_test.go`): in-memory CLI testing via `NewRootCmd()` factory. `root.SetOut(buf)`, `root.SetArgs(args)`, `root.ExecuteContext(t.Context())`. Fresh tree per test case.
- Testdata: create ticket files in MemMapFs, verify front matter + body skeleton

## Acceptance criteria

- [ ] `go build ./...` from `tracker/` produces `tracker` binary
- [ ] `go.mod` module path is `github.com/peachest/pi-packages/tracker`
- [ ] `cmd/` package has zero business logic — only cobra command definitions + flag binding + calling tracker package
- [ ] `tracker/` package has zero imports from `github.com/spf13/cobra`
- [ ] `main.go` is minimal: signal.NotifyContext + cmd.Execute(ctx) + os.Exit(1) on error
- [ ] All commands use `RunE`, not `Run`
- [ ] Root command has `SilenceUsage: true, SilenceErrors: true`
- [ ] JSON output via `cmd.OutOrStdout()`, errors via `cmd.ErrOrStderr()`
- [ ] `tracker ticket create --map test-map --title "Test ticket" --type task` creates `.scratch/test-map/issues/01-test-ticket.md` with correct YAML front matter and minimal body skeleton
- [ ] `tracker ticket create` with `--blocked-by 1,2` writes `blocked_by: ["01", "02"]` in front matter
- [ ] `tracker ticket create` without `--blocked-by` writes `blocked_by: []`
- [ ] `tracker ticket list --map test-map` returns JSON array of all tickets sorted by id
- [ ] `tracker ticket list --status open --type task` filters with AND logic
- [ ] `tracker ticket list --triage null` returns tickets with triage=null
- [ ] `.scratch/` auto-created at git root when not found
- [ ] Map directory not found → exit code 2 with actionable error message
- [ ] `issues/` subdirectory auto-created when map exists but issues/ doesn't
- [ ] Slug generation: `"Spec: PPU MIG 调度实现"` → `spec-ppu-mig-调度实现`
- [ ] Slug generation: `"Fix bug #123 (urgent!)"` → `fix-bug-123-urgent` (ASCII punctuation deleted)
- [ ] Slug generation: truncates at 50 runes, not 50 bytes
- [ ] YAML front matter keys appear in fixed order: `id, title, map, type, status, triage, blocked_by, created_at, claimed_at, resolved_at`
- [ ] `--type` rejects invalid values with exit 1 and lists valid values
- [ ] `--triage` rejects invalid values with exit 1 and lists valid values
- [ ] `--blocked-by 99` (non-existent ID) rejected with exit 1
- [ ] Permission denied on `.scratch/` creation → exit 1 (not exit 2)
- [ ] Sentinel errors defined: `ErrNotFound`, `ErrAlreadyResolved`, `ErrCycleDetected`, `ErrHeadingMissing`, `ErrInvalidInput`
- [ ] `frontier.go` exists with `Frontier()` and `ComputeFrontierSize()` functions
- [ ] `tracker ticket review --map m --id 1` sets `reviewed_at` timestamp
- [ ] `ticket create` writes `reviewed_at: null` in front matter
- [ ] YAML front matter keys include `reviewed_at` between `created_at` and `claimed_at`
- [ ] `Frontier()` returns open + unblocked + unclaimed tickets
- [ ] `Frontier()` excludes tickets blocked by wontfix (wontfix doesn't unblock)
- [ ] `markdown.go` does NOT exist (CLI is thin CRUD, G-Q15 — no body content manipulation)
- [ ] Domain package tests use afero MemMapFs (no disk I/O)
- [ ] Domain package tests are table-driven with `t.Run()`
- [ ] Command tests use `NewRootCmd()` factory with `SetOut`/`SetArgs`/`ExecuteContext`
- [ ] `go vet ./...` clean
