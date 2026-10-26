# tracker integration tests

Real-instance integration tests for the remote ticket backends. They exist to
catch what unit tests with fake runners cannot: CLI drift (gh/glab flag and
output changes), platform API behavior changes, and auth breakage — the
"tracker can no longer connect" class of failure. There is deliberately no
mock server: a mock is written against our understanding of the protocol and
goes stale exactly when the platform drifts.

## What runs where

| Suite | Instance | Sandbox | Gating |
|---|---|---|---|
| `TestIntegrationGitHub` | github.com | `peachest/tracker-itest` (private, dedicated) | skips unless `gh` is logged in |
| `TestIntegrationGitLab` | self-hosted GitLab | repo from env vars | skips unless `TRACKER_ITEST_GITLAB_HOST` + `TRACKER_ITEST_GITLAB_REPO` are set and `glab` is logged in on that host |

Coordinates for the self-hosted instance are env-only (internal hostnames must
not be committed; the sanitize gate enforces this):

```bash
export TRACKER_ITEST_GITLAB_HOST=gitlab.blue.example   # placeholder — use your real host
export TRACKER_ITEST_GITLAB_REPO=owner/sandbox-repo    # any repo with issues enabled
```

Authentication is never managed here: tests use whatever `gh`/`glab` login
state the machine already has (`gh auth status` / `glab auth status` are the
health checks; failures skip the suite, they are not test failures).

## Running

```bash
# both suites (skips what is not reachable)
go test -tags=integration -v ./tracker/itest

# one suite only
go test -tags=integration -v -run TestIntegrationGitHub ./tracker/itest
```

Default `go test ./...` never compiles this package (the `integration` build
tag keeps it out), so CI and plain test runs stay hermetic.

### Troubleshooting: proxy flakiness

On hosts where github.com egress goes through a corporate HTTP proxy that
intermittently returns 5xx/TLS-timeouts, run the GitHub suite with the proxy
env vars unset (direct egress works on such networks):

```bash
env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY \
  go test -tags=integration -v -run TestIntegrationGitHub ./tracker/itest
```

Individual CLI calls inside the suites already retry transient failures
(retryRunner, 4 attempts with backoff); the unset-proxy fallback is for
episodes where the proxy path degrades for minutes.

## Behavior contract

- One end-to-end chain per instance: create → list → comment → view → triage
  → blocking → claimed → resolved, with field-level assertions against the
  backend's JSON vocabulary.
- Tickets live under a `itest-<runid>` map label, so concurrent runs do not
  collide.
- Every created ticket is deleted on test exit (pass or fail). Labels
  accumulated in the sandbox repos are tolerated as inert residue.
- Sandbox repos must exist beforehand; the tests do not create repositories.
