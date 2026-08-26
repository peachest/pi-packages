package tracker

import (
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/pkg/errors"
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
			return "", errors.Wrapf(err, "checking for .scratch at %s", candidate)
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
		return "", errors.Wrapf(err, "creating .scratch/ at %s", scratchDir)
	}
	return scratchDir, nil
}

// MapExists checks if a map directory with map.md exists under .scratch/.
// Returns an error if the filesystem check itself fails, so callers can
// distinguish "map not found" from an I/O problem.
func MapExists(fs afero.Fs, scratchDir, mapSlug string) (bool, error) {
	if err := validateSlug(mapSlug); err != nil {
		return false, err
	}
	mapPath := filepath.Join(scratchDir, mapSlug, "map.md")
	exists, err := afero.Exists(fs, mapPath)
	if err != nil {
		return false, errors.Wrapf(err, "checking map existence at %s", mapPath)
	}
	return exists, nil
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

// validateSlug rejects slugs that could escape the scratch directory via path
// traversal. It uses filepath.IsLocal (Go 1.20+) which performs lexical
// analysis to reject absolute paths, ".." components, and empty elements.
// This defends against accidental escape (e.g. --map ../etc) for a local CLI;
// for adversarial symlink attacks, os.Root (Go 1.24) would be needed but is
// incompatible with the afero filesystem abstraction used here.
func validateSlug(slug string) error {
	if slug == "" || !filepath.IsLocal(slug) {
		return errors.Wrapf(ErrInvalidInput, "invalid slug %q: must be a relative path without .. or absolute components", slug)
	}
	return nil
}
