package tracker

import (
	"fmt"
	"slices"
	"strings"

	"github.com/spf13/afero"
)

// Frontier returns all tickets in the map matching frontier conditions:
// status=open + triage=null|ready-for-agent + all blocked_by tickets resolved.
// Only resolved unblocks; wontfix does not unblock.
func Frontier(fs afero.Fs, scratchDir, mapSlug string) ([]TicketSummary, error) {
	tickets, err := ListTickets(fs, scratchDir, mapSlug, ListFilter{Status: "open"})
	if err != nil {
		return nil, fmt.Errorf("listing tickets for frontier: %w", err)
	}

	// Build a map of id → status for blocker lookup
	allTickets, err := ListTickets(fs, scratchDir, mapSlug, ListFilter{})
	if err != nil {
		return nil, fmt.Errorf("listing all tickets for frontier: %w", err)
	}
	statusByID := make(map[string]string, len(allTickets))
	for _, t := range allTickets {
		statusByID[t.ID] = t.Status
	}

	var frontier []TicketSummary
	for _, t := range tickets {
		// Check triage: null or ready-for-agent
		if t.Triage != nil && *t.Triage != "ready-for-agent" {
			continue
		}

		// Check all blockers are resolved
		allBlockersResolved := true
		for _, blockerID := range t.BlockedBy {
			blockerStatus, exists := statusByID[blockerID]
			if !exists || blockerStatus != "resolved" {
				allBlockersResolved = false
				break
			}
		}
		if !allBlockersResolved {
			continue
		}

		frontier = append(frontier, t)
	}

	// Sort by ID ascending
	slices.SortFunc(frontier, func(a, b TicketSummary) int {
		return strings.Compare(a.ID, b.ID)
	})

	return frontier, nil
}

// ComputeFrontierSize returns the number of tickets in the frontier.
func ComputeFrontierSize(fs afero.Fs, scratchDir, mapSlug string) (int, error) {
	frontier, err := Frontier(fs, scratchDir, mapSlug)
	if err != nil {
		return 0, err
	}
	return len(frontier), nil
}
