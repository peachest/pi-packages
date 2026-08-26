package tracker

import (
	"os"
	"slices"

	"github.com/pkg/errors"
)

// SetTriage updates a ticket's triage field.
// wontfix is a triage role, NOT a status change.
func SetTriage(root *os.Root, mapSlug, ticketID, triage string) error {
	if !slices.Contains(validTriages, triage) {
		return errors.Wrapf(ErrInvalidInput, "invalid triage %q, valid values: %v", triage, validTriages)
	}

	path, fm, err := readTicket(root, mapSlug, ticketID)
	if err != nil {
		return err
	}

	fm.Triage = &triage

	return writeTicket(root, path, fm)
}
