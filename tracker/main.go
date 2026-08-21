package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/peachest/pi-packages/tracker/cmd"
	"github.com/peachest/pi-packages/tracker/tracker"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := cmd.Execute(ctx); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(exitCodeFor(err))
	}
}

// exitCodeFor maps sentinel errors to exit codes.
//   - ErrNotFound → 2
//   - ErrAlreadyResolved, ErrCycleDetected → 3
//   - others → 1
func exitCodeFor(err error) int {
	switch {
	case errors.Is(err, tracker.ErrNotFound):
		return 2
	case errors.Is(err, tracker.ErrAlreadyResolved), errors.Is(err, tracker.ErrCycleDetected):
		return 3
	default:
		return 1
	}
}
