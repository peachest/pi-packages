package tracker

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/pkg/errors"
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
//
// This is a bootstrap function: it runs before an os.Root exists, using regular
// os calls. The caller then opens an os.Root on the returned path to get a
// sandboxed filesystem.
func FindScratchDir(cwd string) (string, error) {
	dir := cwd
	for {
		candidate := filepath.Join(dir, ".scratch")
		fi, err := os.Stat(candidate)
		if err == nil && fi.IsDir() {
			return candidate, nil
		}
		if err != nil && !os.IsNotExist(err) {
			return "", errors.Wrapf(err, "checking for .scratch at %s", candidate)
		}

		parent := filepath.Dir(dir)
		if parent == dir {
			break // reached filesystem root
		}
		dir = parent
	}
	return "", nil
}

// EnsureScratchDir finds or creates the .scratch/ directory.
// If .scratch/ is not found by searching upward: create it at the git root
// (when cwd is in a git repo), otherwise at cwd (S1).
//
// Like FindScratchDir, this is a bootstrap function using regular os calls.
func EnsureScratchDir(cwd string) (string, error) {
	found, err := FindScratchDir(cwd)
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
	if err := os.MkdirAll(scratchDir, 0755); err != nil {
		return "", errors.Wrapf(err, "creating .scratch/ at %s", scratchDir)
	}
	return scratchDir, nil
}

// MapExists checks if a map directory with map.md exists under root.
// The mapSlug is a path relative to root; os.Root enforces that it cannot
// escape the sandbox, so no separate path-traversal validation is needed.
func MapExists(root *os.Root, mapSlug string) (bool, error) {
	mapPath := filepath.Join(mapSlug, "map.md")
	_, err := root.Stat(mapPath)
	if err == nil {
		return true, nil
	}
	if os.IsNotExist(err) {
		return false, nil
	}
	return false, errors.Wrapf(err, "checking map existence at %s", mapPath)
}

// MapDir returns the path to a map's directory, relative to the scratch root.
func MapDir(mapSlug string) string {
	return mapSlug
}

// IssuesDir returns the path to a map's issues directory, relative to root.
func IssuesDir(mapSlug string) string {
	return filepath.Join(mapSlug, "issues")
}

// TicketPath returns the path to a ticket file, relative to root.
func TicketPath(mapSlug, filename string) string {
	return filepath.Join(IssuesDir(mapSlug), filename)
}

// readDirEntries lists directory entries under root.
// os.Root has no direct ReadDir method; this helper opens the directory and
// reads all entries. The directory must be relative to root (sandboxed).
func readDirEntries(root *os.Root, name string) ([]os.DirEntry, error) {
	f, err := root.Open(name)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return f.ReadDir(-1)
}
