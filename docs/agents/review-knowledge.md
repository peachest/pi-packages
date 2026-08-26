# Review Knowledge — FP Patterns and Lessons

Patterns and lessons learned from code review runs on the tracker package.
Future reviews consult this file to avoid re-litigating settled design decisions.

## FP Patterns (false positives to skip)

### FP-1: Package-level globals for test injection in CLI tools

**Pattern**: A CLI tool uses package-level variables (e.g. `var fs afero.Fs`,
`var cwd string`) with `SetX()` test helpers, and a reviewer flags this as
"avoid globals / use DI."

**Why it's a FP here**: For a single-binary CLI (not a library), package-level
state with explicit Set seams is an acceptable, low-ceremony test-injection
pattern. cobra commands are wired at package scope; threading a config struct
through every command adds boilerplate without benefit. The Go skill's
"library API design" guidance (avoid globals for embeddable libraries) does
not apply to CLI-only tools.

**Caveat**: This was eventually refactored away when afero was removed (the
`fs` global disappeared), but the `cwd` global + `SetCWD` remains and is
intentional.

## Lessons (insights that changed the codebase)

### L-1: Don't introduce a filesystem abstraction just for test isolation

**Origin**: tracker initially used `github.com/spf13/afero` (decision G-Q3)
solely so tests could run on `MemMapFs` (in-memory, no disk I/O). The Go skill
recommends afero for this.

**What went wrong**: afero's `Fs` interface uses arbitrary string paths with no
fd binding. When a path-traversal finding (L2) emerged, the natural fix was
Go 1.24's `os.Root` (openat-based kernel confinement), but `os.Root` is
incompatible with `afero.Fs` — the abstraction blocked the better solution.

**Resolution**: Removed afero entirely. Production uses `*os.Root`; tests use
`t.TempDir()` + `os.OpenRoot`. Both paths use the same `*os.Root` type — zero
abstraction, and tests now exercise real filesystem semantics (permissions,
symlinks) while staying isolated.

**Rule of thumb**: Before introducing an abstraction layer for testability,
check whether the stdlib already provides the capability. Go 1.21+ stdlib
(`t.TempDir`, `os.Root`, `testing/synctest`) covers most "test isolation" needs
that previously required afero. An abstraction that exists only for tests, and
that blocks a stronger stdlib solution, is over-engineering.

**Applies to**: local CLI tools and services where the only fs backend is the
real OS filesystem. Does NOT apply to libraries that must support pluggable
backends (S3, zip, etc.) — there afero's abstraction earns its keep.

### L-2: Fix the root cause, not the symptom — iterate when a fix reveals a deeper issue

**Origin**: Path-traversal finding L2 was first fixed with `validateSlug`
(lexical analysis via `filepath.IsLocal`). This was correct but shallow.

**What happened next**: Questioning "why not os.Root?" exposed that afero was
the root cause blocking the stronger fix. Removing afero made `validateSlug`
unnecessary (os.Root enforces confinement at the kernel level) and deleted
all 8 call sites.

**Rule of thumb**: When a finding's fix feels like a workaround, ask "what
abstraction is forcing this workaround?" The workaround may be treating a
symptom of a deeper design issue. A second pass that removes the root cause
can eliminate the workaround entirely — net less code, stronger guarantees.

### L-3: os.Root method coverage (Go 1.24+)

**Fact**: `*os.Root` provides `ReadFile`, `WriteFile`, `MkdirAll`, `Stat`,
`Open`, `Create` natively — covering most file CRUD. The one gap is `ReadDir`:
use `f, _ := root.Open(name); entries, _ := f.ReadDir(-1); f.Close()`.

**Fact**: `os.Root` is incompatible with `afero.Fs` because `Open` returns
`*os.File` (not `afero.File`). Don't try to adapt one to the other; design
around `*os.Root` directly.

**Fact**: `os.Root.Open` does NOT follow symlinks that escape the root, and
rejects `..` components — kernel-level enforcement via openat(2) on Unix. This
is strictly stronger than `filepath.IsLocal` (lexical only, vulnerable to
symlink/TOCTOU attacks).

Reference: `obsidianNote/go/os.Root 防范路径攻击.md`
