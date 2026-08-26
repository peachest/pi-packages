package cmd

import (
	"os"

	"github.com/peachest/pi-packages/tracker/tracker"
)

// cwd is the current working directory. Defaults to OS cwd.
// Tests override it via SetCWD.
var cwd string = "."

// SetCWD sets the current working directory (for testing).
func SetCWD(c string) { cwd = c }

// openScratchRoot finds or creates the .scratch/ directory and returns an
// os.Root sandboxed to it. The caller must close the root when done.
// os.Root enforces path confinement at the kernel level (openat on Unix),
// replacing the afero filesystem abstraction.
func openScratchRoot() (*os.Root, error) {
	scratchDir, err := tracker.EnsureScratchDir(cwd)
	if err != nil {
		return nil, err
	}
	return os.OpenRoot(scratchDir)
}
