//go:build integration

package itest

import (
	"testing"

	"github.com/peachest/pi-packages/tracker/tracker"
)

// githubSandboxRepo is the dedicated private sandbox. Coordinates are safe to
// commit: public identity, public-facing repo name, no credentials.
const githubSandboxRepo = "peachest/tracker-itest"

func TestIntegrationGitHub(t *testing.T) {
	requireCLI(t, "gh", "auth", "status")
	b := tracker.NewGitHubBackend(retryRunner{tracker.ExecRunner{}}, githubSandboxRepo)
	mapSlug := "itest-gh-" + runID()
	runE2E(t, b, mapSlug, func(id string) {
		if out, err := execGH("issue", "delete", id, "-R", githubSandboxRepo, "--yes"); err != nil {
			t.Logf("cleanup: gh issue delete %s failed: %v: %s", id, err, out)
		}
	})
}
