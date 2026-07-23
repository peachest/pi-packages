# Go Modern Features

Check `go.mod` for the project's `go` directive to see what's available.

## Go 1.21

- **slices package** — `slices.Contains`, `slices.Index`, `slices.Delete`, `slices.Sort`, `slices.Compact`, `slices.BinarySearch`
- **maps package** — `maps.Clone`, `maps.Copy`, `maps.DeleteFunc`, `maps.Keys`, `maps.Values`
- **cmp package** — `cmp.Compare`, `cmp.Less`, `cmp.Or` for ordered comparisons
- **min/max builtins** — `min(a, b, c)`, `max(x, y)` over fixed arguments
- **clear builtin** — `clear(m)` deletes all entries from a map, `clear(s)` zeroes slice elements
- **log/slog** — structured logging replacing `log.Printf`
- **loopvar change** — loop variables are per-iteration; `v := v` copies no longer needed

## Go 1.22

- **range over int** — `for i := range N` instead of `for i := 0; i < N; i++`
- **range over function** — `for v := range seq { ... }` with iter.Seq/Seq2
- **math/rand/v2** — use instead of `math/rand` (faster, cleaner API, no global state seeding)
- **enhanced routing patterns** — `GET /items/{id}`, path wildcards in `net/http`

## Go 1.23

- **iter.Seq / iter.Seq2** — standard iterator types
- **iter.Pull / iter.Pull2** — pull-based iteration
- **unique package** — `unique.Make` for interning comparable values
- **time.Timer / Ticker GC** — unreferenced timers eligible for GC immediately even without Stop

## Go 1.24

- **generic type aliases** — `type List[T any] = []T`
- **weak package** — `weak.Make`, `weak.Ptr` for weak references
- **os.Root** — `os.OpenRoot` for restricted filesystem access
- **runtime.AddCleanup** — preferred over `runtime.SetFinalizer`
- **encoding/json omitzero** — `json:"field,omitzero"` omits zero-value fields during marshal

## Go 1.25

- **testing/synctest** — concurrency testing support
- **encoding/json/v2, encoding/json/jsontext** — new JSON engine

## Go 1.26

- **go fix** — completely revamped, home of Go's "modernizers". Run `go fix ./...` to auto-update code to latest idioms and core library APIs. Includes source-level inliner for user-defined API migrations via `//go:fix inline` directives
- **new(expr)** — `new` builtin now accepts an expression for initialization: `new(yearsSince(born))`
- **self-referencing type constraints** — `type Adder[A Adder[A]] interface { ... }`
- **errors.AsType** — generic version of `errors.As`

## Quick Reference

| Old pattern | Modern replacement | Since |
|---|---|---|
| `for i:=0; i<N; i++` (simple counter) | `for i := range N` | 1.22 |
| `v := v; for _, v := range xs` | remove `v := v` | 1.22 |
| `sort.SearchInts(xs, v)` | `slices.BinarySearch(xs, v)` | 1.21 |
| `append(x[:i], x[i+1:]...)` delete | `slices.Delete(x, i, i+1)` | 1.21 |
| `if a < b { m = a } else { m = b }` | `m = min(a, b)` | 1.21 |
| `log.Printf(...)` | `slog.Info(...)` | 1.21 |
| `math/rand` | `math/rand/v2` | 1.22 |
| `for k, v := range m { keys = append(keys, k) }` | `maps.Keys(m)` | 1.21 |
| `errors.As(err, &target)` | `errors.AsType[Target](err)` | 1.26 |