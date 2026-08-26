package tracker

import (
	"fmt"
	"os"
	"strings"

	"github.com/pkg/errors"
)

// SetBlocking replaces a ticket's blocked_by array (SET semantics, G5).
// Validates that all IDs exist (G-Q4) and no cycle is created (G-Q6: uses new edges).
func SetBlocking(root *os.Root, mapSlug, ticketID string, blockedBy []string) error {
	// Normalize IDs
	normalizedIDs := normalizeIDs(blockedBy)

	// Get all tickets to validate IDs and build adjacency list
	allTickets, err := ListTickets(root, mapSlug, ListFilter{})
	if err != nil {
		return errors.Wrapf(err, "listing tickets")
	}

	existingIDs := make(map[string]bool, len(allTickets))
	for _, t := range allTickets {
		existingIDs[t.ID] = true
	}

	// Validate each blocked_by ID exists (G-Q4)
	normalizedTargetID := normalizeID(ticketID)
	for _, id := range normalizedIDs {
		if !existingIDs[id] {
			return errors.Wrapf(ErrInvalidInput, "ticket #%s not found in map. Cannot block on a non-existent ticket", id)
		}
	}

	// Build adjacency list with PROPOSED new edges (G-Q6: use new edges, not old)
	adj := make(map[string][]string)
	for _, t := range allTickets {
		if t.ID == normalizedTargetID {
			// Replace this ticket's edges with proposed values
			adj[t.ID] = normalizedIDs
		} else {
			adj[t.ID] = t.BlockedBy
		}
	}

	// Cycle detection via DFS
	if cycle := detectCycle(adj, normalizedTargetID); cycle != "" {
		return errors.Wrapf(ErrCycleDetected, "%s", cycle)
	}

	// Write
	path, fm, err := readTicket(root, mapSlug, ticketID)
	if err != nil {
		return err
	}

	fm.BlockedBy = normalizedIDs
	if fm.BlockedBy == nil {
		fm.BlockedBy = []string{}
	}

	return writeTicket(root, path, fm)
}

// detectCycle runs DFS from the given node and returns an error message if a cycle is found.
func detectCycle(adj map[string][]string, start string) string {
	visited := make(map[string]bool)
	recStack := make(map[string]bool)
	var path []string

	var dfs func(node string) string
	dfs = func(node string) string {
		visited[node] = true
		recStack[node] = true
		path = append(path, node)

		for _, neighbor := range adj[node] {
			if !visited[neighbor] {
				if msg := dfs(neighbor); msg != "" {
					return msg
				}
			} else if recStack[neighbor] {
				// Found cycle — build error message
				path = append(path, neighbor)
				return fmt.Sprintf("ticket #%s creates a cycle: %s", start, formatCyclePath(path))
			}
		}

		path = path[:len(path)-1]
		recStack[node] = false
		return ""
	}

	return dfs(start)
}

// formatCyclePath formats the path as "#03 → #01 → #03" (with self-blocking detection).
func formatCyclePath(path []string) string {
	if len(path) == 2 && path[0] == path[1] {
		return fmt.Sprintf("#%s → #%s (self-blocking). A ticket cannot block itself", path[0], path[1])
	}

	parts := make([]string, len(path))
	for i, p := range path {
		parts[i] = "#" + p
	}
	return strings.Join(parts, " → ")
}
