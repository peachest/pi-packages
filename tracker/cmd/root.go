package cmd

import (
	"context"
	"os"
	"time"

	"github.com/peachest/pi-packages/tracker/tracker"
	"github.com/spf13/cobra"
)

// cwd is the current working directory. Defaults to OS cwd.
// Tests override it via SetCWD.
var cwd string = "."

// SetCWD sets the current working directory (for testing).
func SetCWD(c string) { cwd = c }

// nowUTC is the clock used by local-only write paths.
func nowUTC() time.Time { return time.Now().UTC() }

// Execute runs the root command.
func Execute(ctx context.Context) error {
	return NewRootCmd().ExecuteContext(ctx)
}

// NewRootCmd creates the root command tree.
func NewRootCmd() *cobra.Command {
	root := &cobra.Command{
		Use:           "tracker",
		Short:         "Issue tracker CLI (local markdown / GitHub / GitLab backends)",
		SilenceUsage:  true,
		SilenceErrors: true,
	}

	addBackendFlags(root)

	root.AddCommand(newTicketCmd())
	root.AddCommand(newQueryCmd())
	root.AddCommand(newMapCmd())
	root.AddCommand(newMilestoneCmd())

	return root
}

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
