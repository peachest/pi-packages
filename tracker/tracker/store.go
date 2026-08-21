package tracker

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/afero"
)

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
// If .scratch/ is not found by searching upward, it is created at the given cwd.
func EnsureScratchDir(fs afero.Fs, cwd string) (string, error) {
	found, err := FindScratchDir(fs, cwd)
	if err != nil {
		return "", err
	}
	if found != "" {
		return found, nil
	}

	// Not found — create at cwd
	scratchDir := filepath.Join(cwd, ".scratch")
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

// CurrentDir returns the current working directory.
func CurrentDir() (string, error) {
	return os.Getwd()
}
