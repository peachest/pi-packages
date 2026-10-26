package tracker

import (
	"os"
	"os/exec"
)

// Runner executes an external CLI (gh/glab) and returns stdout. Injected so
// remote-backend logic is testable without network or installed CLIs.
type Runner interface {
	// Run executes name with args. env entries (KEY=VALUE) are appended to
	// the child environment (used for GITLAB_HOST); nil inherits everything.
	Run(env []string, name string, args ...string) ([]byte, error)
}

// ExecRunner runs real processes.
type ExecRunner struct{}

func (ExecRunner) Run(env []string, name string, args ...string) ([]byte, error) {
	cmd := exec.Command(name, args...)
	if len(env) > 0 {
		cmd.Env = append(os.Environ(), env...)
	}
	return cmd.Output()
}
