package tracker

import (
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/spf13/afero"
)

// gitRootFunc detects the git repository root for a directory.
// Injected so tests can stub it; defaults to real git detection.
var gitRootFunc = func(dir string) (string, error) {
	return gitRootDetect(dir)
}

func gitRootDetect(dir string) (string, error) {
	cmd := exec.Command("git", "rev-parse", "--show-toplevel")
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// FindScratchDir searches upward from cwd for a directory containing .scratch/.
// Returns the path to .scratch/ if found, or "" if not found.
func FindScratchDir(fs afero.Fs, cwd string) (string, error) {
	dir := cwd
	for {
		candidate := filepath.Join(dir, ".scratch")
		exists, err := afero.DirExists(fs, candidate)
		if err != nil {
			return "", fmt.Errorf("checking for .scratch at %s: %w", candidate, err)
		}
		if exists {
			return candidate, nil
		}

		parent := filepath.Dir(dir)
		if parent == dir {
			// reached root
			break
		}
		dir = parent
	}
	return "", nil
}

// EnsureScratchDir finds or creates the .scratch/ directory.
// If .scratch/ is not found by searching upward: create it at the git root
// (when cwd is in a git repo), otherwise at cwd (S1).
func EnsureScratchDir(fs afero.Fs, cwd string) (string, error) {
	found, err := FindScratchDir(fs, cwd)
	if err != nil {
		return "", err
	}
	if found != "" {
		return found, nil
	}

	// Not found by upward search — try git root first
	createAt := cwd
	if gitRoot, err := gitRootFunc(cwd); err == nil && gitRoot != "" {
		createAt = gitRoot
	}

	scratchDir := filepath.Join(createAt, ".scratch")
	if err := fs.MkdirAll(scratchDir, 0755); err != nil {
		return "", fmt.Errorf("creating .scratch/ at %s: %w (permission denied)", scratchDir, err)
	}
	return scratchDir, nil
}

// MapExists checks if a map directory with map.md exists under .scratch/.
func MapExists(fs afero.Fs, scratchDir, mapSlug string) bool {
	mapPath := filepath.Join(scratchDir, mapSlug, "map.md")
	exists, err := afero.Exists(fs, mapPath)
	if err != nil {
		return false
	}
	return exists
}

// MapDir returns the path to a map's directory.
func MapDir(scratchDir, mapSlug string) string {
	return filepath.Join(scratchDir, mapSlug)
}

// IssuesDir returns the path to a map's issues directory.
func IssuesDir(scratchDir, mapSlug string) string {
	return filepath.Join(scratchDir, mapSlug, "issues")
}

// TicketPath returns the path to a ticket file.
func TicketPath(scratchDir, mapSlug, filename string) string {
	return filepath.Join(IssuesDir(scratchDir, mapSlug), filename)
}