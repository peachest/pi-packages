package tracker

import (
	"fmt"
	"slices"

	"github.com/spf13/afero"
)

// SetTriage updates a ticket's triage field.
// wontfix is a triage role, NOT a status change.
func SetTriage(fs afero.Fs, scratchDir, mapSlug, ticketID, triage string) error {
	if !slices.Contains(validTriages, triage) {
		return fmt.Errorf("%w: invalid triage %q, valid values: %v", ErrInvalidInput, triage, validTriages)
	}

	path, fm, err := readTicket(fs, scratchDir, mapSlug, ticketID)
	if err != nil {
		return err
	}

	fm.Triage = &triage

	return writeTicket(fs, path, fm)
}
