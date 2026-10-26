package tracker

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/pkg/errors"
)

// defaultRunnerTimeout bounds a single CLI invocation. gh/glab are network
// CLIs: an expired token, a hung network, or a glab interactive prompt can
// block a child process forever — without a deadline the whole command
// freezes (ocr finding M8).
const defaultRunnerTimeout = 5 * time.Minute

// Runner executes an external CLI (gh/glab) and returns stdout. Injected so
// remote-backend logic is testable without network or installed CLIs.
type Runner interface {
	// Run executes name with args. env entries (KEY=VALUE) are appended to
	// the child environment (used for GITLAB_HOST); nil inherits everything.
	Run(env []string, name string, args ...string) ([]byte, error)
}

// StderrRunner is the optional Runner extension returning stderr separately
// (glab api prints the x-next-page pagination header there). Runners that
// cannot capture it return the empty string.
type StderrRunner interface {
	RunStderr(env []string, name string, args ...string) (stdout []byte, stderr string, err error)
}

// AsStderrRunner adapts any Runner: runners implementing StderrRunner pass
// through; others degrade to stderr="".
func AsStderrRunner(r Runner) StderrRunner {
	if sr, ok := r.(StderrRunner); ok {
		return sr
	}
	return plainRunner{r}
}

type plainRunner struct{ inner Runner }

func (p plainRunner) RunStderr(env []string, name string, args ...string) ([]byte, string, error) {
	out, err := p.inner.Run(env, name, args...)
	return out, "", err
}

// ExecRunner runs real processes with a per-call timeout. Stderr is captured
// into the error text: callers match it ("Could not resolve", "404",
// "already exists") to translate CLI failures into sentinel errors — a bare
// "exit status 1" makes those mappings dead code (ocr findings H1/M8).
type ExecRunner struct{}

func (ExecRunner) Run(env []string, name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), defaultRunnerTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, name, args...)
	if len(env) > 0 {
		cmd.Env = append(os.Environ(), env...)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			if ctx.Err() == context.DeadlineExceeded {
				msg = "timed out after " + defaultRunnerTimeout.String()
			} else {
				msg = err.Error()
			}
		}
		return stdout.Bytes(), errors.Wrapf(err, "%s failed: %s", name, msg)
	}
	return stdout.Bytes(), nil
}

// RunStderr returns stdout and the untouched stderr text. glab api prints
// its x-next-page pagination header to stderr — needed by the GitLab
// paginator.
func (ExecRunner) RunStderr(env []string, name string, args ...string) ([]byte, string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), defaultRunnerTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, name, args...)
	if len(env) > 0 {
		cmd.Env = append(os.Environ(), env...)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	return stdout.Bytes(), stderr.String(), err
}
