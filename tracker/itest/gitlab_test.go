//go:build integration

package itest

import (
	"os"
	"os/exec"
	"strings"
	"testing"

	"github.com/peachest/pi-packages/tracker/tracker"
)

// TestIntegrationGitLab targets a self-hosted GitLab instance. Coordinates
// come from env vars only — internal hostnames must never be committed
// (sanitize gate). Without them the suite skips.
//
//	TRACKER_ITEST_GITLAB_HOST=gitlab.blue.example
//	TRACKER_ITEST_GITLAB_REPO=owner/sandbox-repo
func TestIntegrationGitLab(t *testing.T) {
	host := os.Getenv("TRACKER_ITEST_GITLAB_HOST")
	repo := os.Getenv("TRACKER_ITEST_GITLAB_REPO")
	if host == "" || repo == "" {
		t.Skip("TRACKER_ITEST_GITLAB_HOST / TRACKER_ITEST_GITLAB_REPO not set; skipping self-hosted GitLab suite")
	}
	requireCLI(t, "glab", "auth", "status", "--hostname", host)

	b := tracker.NewGitLabBackend(retryRunner{tracker.ExecRunner{}}, repo, host)
	mapSlug := "itest-gl-" + runID()
	runE2E(t, b, mapSlug, func(id string) {
		endpoint := "projects/" + strings.ReplaceAll(repo, "/", "%2F") + "/issues/" + id
		if out, err := execGL(host, "api", endpoint, "-X", "DELETE"); err != nil {
			t.Logf("cleanup: DELETE %s failed: %v: %s", endpoint, err, out)
		}
	})
}

// execGH/execGL wrap the CLIs with error output captured for diagnostics.
func execGH(args ...string) (string, error) {
	out, err := exec.Command("gh", args...).CombinedOutput()
	return string(out), err
}

func execGL(host string, args ...string) (string, error) {
	cmd := exec.Command("glab", args...)
	cmd.Env = append(os.Environ(), "GITLAB_HOST="+host)
	out, err := cmd.CombinedOutput()
	return string(out), err
}
