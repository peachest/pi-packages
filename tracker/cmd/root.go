package cmd

import (
	"github.com/peachest/pi-packages/tracker/tracker"
	"github.com/spf13/afero"
)

// fs is the filesystem used by commands. Defaults to OS filesystem.
// Tests override it via SetFS.
var fs afero.Fs = afero.NewOsFs()

// cwd is the current working directory. Defaults to OS cwd.
// Tests override it via SetCWD.
var cwd string = "."

// SetFS sets the filesystem used by commands (for testing).
func SetFS(f afero.Fs) { fs = f }

// SetCWD sets the current working directory (for testing).
func SetCWD(c string) { cwd = c }

// resolveScratch finds or creates the .scratch/ directory and returns its path.
func resolveScratch() (string, error) {
	return tracker.EnsureScratchDir(fs, cwd)
}
