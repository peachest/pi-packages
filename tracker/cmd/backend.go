package cmd

import (
	"fmt"

	"github.com/peachest/pi-packages/tracker/tracker"
	"github.com/spf13/cobra"
)

// Backend selection: root persistent flag --backend, plus --repo and
// --gitlab-host for remote backends. local is the default and the only
// backend that touches .scratch/.
func addBackendFlags(cmd *cobra.Command) {
	cmd.PersistentFlags().String("backend", "local", "ticket storage backend (local|github|gitlab)")
	cmd.PersistentFlags().String("repo", "", "remote repository, e.g. owner/name (required for github/gitlab)")
	cmd.PersistentFlags().String("gitlab-host", "", "GitLab host override, sets GITLAB_HOST for glab (gitlab backend only)")
}

// resolveBackend builds the Backend from the parsed flags.
func resolveBackend(cmd *cobra.Command) (tracker.Backend, error) {
	backend, _ := cmd.Flags().GetString("backend")
	repo, _ := cmd.Flags().GetString("repo")
	host, _ := cmd.Flags().GetString("gitlab-host")

	switch backend {
	case "", "local":
		return tracker.NewLocalBackend(cwd), nil
	case "github":
		if repo == "" {
			return nil, fmt.Errorf("--repo is required with --backend github (e.g. --repo owner/name)")
		}
		return tracker.NewGitHubBackend(tracker.ExecRunner{}, repo), nil
	case "gitlab":
		if repo == "" {
			return nil, fmt.Errorf("--repo is required with --backend gitlab (e.g. --repo group/project)")
		}
		return tracker.NewGitLabBackend(tracker.ExecRunner{}, repo, host), nil
	default:
		return nil, fmt.Errorf("unknown backend %q, valid values: local, github, gitlab", backend)
	}
}

// requireLocal guards local-only commands (map state/progress, milestone,
// ticket review) against remote backends with a clear error.
func requireLocal(cmd *cobra.Command) error {
	backend, _ := cmd.Flags().GetString("backend")
	if backend != "" && backend != "local" {
		return fmt.Errorf("command %q is only supported on the local backend (current: %s)", cmd.CalledAs(), backend)
	}
	return nil
}
