package tracker

import (
	"fmt"
	"slices"
	"time"

	"github.com/spf13/afero"
)

var validStatuses = []string{"open", "claimed", "resolved"}

// SetStatus updates a ticket's status and associated timestamps.
func SetStatus(fs afero.Fs, scratchDir, mapSlug, ticketID, newStatus string, now time.Time) error {
	if !slices.Contains(validStatuses, newStatus) {
		return fmt.Errorf("%w: invalid status %q, valid values: %v", ErrInvalidInput, newStatus, validStatuses)
	}

	path, fm, err := readTicket(fs, scratchDir, mapSlug, ticketID)
	if err != nil {
		return err
	}

	// Check: cannot claim a resolved ticket
	if newStatus == "claimed" && fm.Status == "resolved" {
		return fmt.Errorf("%w: ticket #%s is already resolved. Use 'tracker ticket status --set open' to reopen first", ErrAlreadyResolved, fm.ID)
	}

	// Check: cannot resolve an already resolved ticket
	if newStatus == "resolved" && fm.Status == "resolved" {
		return fmt.Errorf("%w: ticket #%s is already resolved", ErrAlreadyResolved, fm.ID)
	}

	// Claim precondition: reviewed_at must be non-null (G-Q12)
	if newStatus == "claimed" && fm.ReviewedAt == nil {
		return fmt.Errorf("%w: ticket #%s has not been reviewed. Run /skill:review-spec and 'tracker ticket review --map %s --id %s' before claiming", ErrInvalidInput, fm.ID, mapSlug, fm.ID)
	}

	// Apply status transition
	switch newStatus {
	case "claimed":
		fm.Status = "claimed"
		fm.ClaimedAt = &now
	case "open":
		// Reopen from resolved (G-Q1/Q2/Q3): clear both resolved_at and claimed_at
		// Release claim from claimed: clear claimed_at
		fm.Status = "open"
		fm.ClaimedAt = nil
		fm.ResolvedAt = nil
	case "resolved":
		fm.Status = "resolved"
		fm.ResolvedAt = &now
	}

	return writeTicket(fs, path, fm)
}
