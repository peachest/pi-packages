# pi-poll

A single-tool [pi](https://github.com/badlogic/pi-mono) extension that replaces fixed `sleep N; check; sleep N; check` loops with one call that polls a shell condition until it exits 0.

Returns the moment the condition is met — no wasted wait. Covers the two real wait patterns that drove its design (observed across 100 sessions):

- **Background process finished:** `poll({ command: "! kill -0 $PID" })`
- **CI pipeline reached terminal state:** `poll({ command: "glab api .../jobs | jq -e 'all(.[]; .status|IN(\"success\",\"failed\",\"skipped\"))'" })`

## Install

```bash
pi install ./packages/pi-poll   # from ~/projects/pi-mypackage
```

## Usage

```
poll({
  command: string,   // shell check; exit 0 = ready, non-zero = not yet
  interval?: number, // seconds between checks, default 2
  timeout?: number,  // max seconds, default 300
})
```

The check runs in the session cwd with the session env — proxies, `KUBECONFIG`, `PATH` all carry over from the bash tool. Both the check and the inter-check sleep are abortable via `Esc` (the agent `AbortSignal`); cancelling during a sleep resolves immediately.

Returns `{ ready, attempts, elapsedMs, exitCode, output }`. `output` is the last check's stdout/stderr — readiness evidence on success, failure reason on timeout.

## Examples

```bash
# background process exited
poll({ command: "! kill -0 43803" })

# file appeared
poll({ command: "test -f dist/bundle.js" })

# port ready
poll({ command: "curl -sf http://localhost:3000/health" })

# CI all jobs terminal
poll({
  command: "glab api projects/24248/pipelines/1423631/jobs | jq -e 'all(.[]; .status|IN(\"success\",\"failed\",\"skipped\"))'",
  timeout: 600,
})
```

## rtk caveat

The check inherits the session environment, where `rtk` intercepts `grep`/`diff`/`helm` and may return false results. A check like `grep -q ready server.log` can silently pass or fail incorrectly. Prefer `test -f`, `curl`, `ps`, `kill -0`, or full binary paths (`/usr/bin/grep`) in the check command.

## License

MIT
