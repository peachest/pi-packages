package tracker

import (
	"slices"
	"time"

	"github.com/pkg/errors"
	"github.com/spf13/afero"
)

var validStatuses = []string{"open", "claimed", "resolved"}

// SetStatus updates a ticket's status and associated timestamps.
func SetStatus(fs afero.Fs, scratchDir, mapSlug, ticketID, newStatus string, now time.Time) error {
	if !slices.Contains(validStatuses, newStatus) {
		return errors.Wrapf(ErrInvalidInput, "invalid status %q, valid values: %v", newStatus, validStatuses)
	}

	path, fm, err := readTicket(fs, scratchDir, mapSlug, ticketID)
	if err != nil {
		return err
	}

	// Check: cannot claim a resolved ticket
	if newStatus == "claimed" && fm.Status == "resolved" {
		return errors.Wrapf(ErrAlreadyResolved, "ticket #%s is already resolved. Use 'tracker ticket status --set open' to reopen first", fm.ID)
	}

	// Check: cannot claim an already claimed ticket (preserves original ClaimedAt)
	if newStatus == "claimed" && fm.Status == "claimed" {
		return errors.Wrapf(ErrAlreadyClaimed, "ticket #%s is already claimed", fm.ID)
	}

	// Check: cannot resolve an already resolved ticket
	if newStatus == "resolved" && fm.Status == "resolved" {
		return errors.Wrapf(ErrAlreadyResolved, "ticket #%s is already resolved", fm.ID)
	}

	// Claim precondition: reviewed_at must be non-null (G-Q12)
	if newStatus == "claimed" && fm.ReviewedAt == nil {
		return errors.Wrapf(ErrInvalidInput, "ticket #%s has not been reviewed. Run /skill:review-spec and 'tracker ticket review --map %s --id %s' before claiming", fm.ID, mapSlug, fm.ID)
	}

	// Apply status transition
	switch newStatus {
	case "claimed":
		fm.Status = "claimed"
		fm.ClaimedAt = &now
	case "open":
		// Idempotent: already open, no-op (avoid clearing timestamps needlessly)
		if fm.Status == "open" {
			return nil
		}
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
