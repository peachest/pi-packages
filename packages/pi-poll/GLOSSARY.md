# pi-poll

A single-tool pi extension that replaces fixed `sleep N; check; sleep N; check` loops with one call that polls a shell condition until it exits 0.

## Domain

**Poll** — wait-on-condition. The condition is any shell command; exit 0 = ready. The tool loops the check at a configurable interval and returns the moment the condition passes, instead of waiting a fixed duration that may be too long (wasted time) or too short (missed readiness, re-poll).

## Why

Observed in 100 recent sessions: the two real wait patterns were `sleep N; ps -p $PID` (background process finished) and `sleep N; glab api .../jobs` (CI pipeline terminal). Each wasted minutes — `sleep 60` after a 20s download, `sleep 120` after a 30s test run. `poll` returns as soon as the condition is met.

## Vocabulary

- **check** — the shell command passed as `command`. Exit 0 means ready.
- **ready** — the check exited 0; polling stops, tool returns success.
- **attempt** — one execution of the check.
- **interval** — seconds between attempts (default 2).
- **timeout** — max seconds before giving up (default 300).

## Tool: poll

```
poll({
  command: "! kill -0 43803"                                  // process exited
  command: "test -f dist/bundle.js"                           // file appeared
  command: "curl -sf http://localhost:3000/health"            // port ready
  command: "glab api .../jobs | jq -e 'all(.[]; .status|IN(\"success\",\"failed\",\"skipped\"))'"
  interval?: 2    // seconds, default 2
  timeout?: 300   // seconds, default 300
})
```

Returns `{ ready, attempts, elapsedMs, exitCode, output }`. `output` is the last check's stdout/stderr — readiness evidence on success, failure reason on timeout.

The check runs in the session cwd with the session env (proxies, KUBECONFIG, PATH carry over from the bash tool's environment). Both the check and the inter-attempt sleep are abortable via Esc (the agent AbortSignal); cancelling during a sleep resolves immediately.

## Decisions

- **Condition = shell exit code, not typed primitives.** Covers both observed patterns with one mechanism; the check command is where the condition logic lives. Typed `port`/`file`/`http` shortcuts were rejected — the real check commands (`ps`, `glab`, `curl`, `test`) are not rtk-intercepted, so a shell command is sufficient and maximally flexible.
- **Return the last check's output.** Scenarios showed users pairing `ps -p $PID` with `tail log` / `ls -lh` — they want the artifact or log alongside the readiness signal, not just "done". The successful check's stdout is returned in the result.
