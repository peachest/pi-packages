package tracker

import (
	"testing"
	"time"

	"github.com/spf13/afero"
)

func TestSetStatusClaimed(t *testing.T) {
	fs := afero.NewMemMapFs()
	setupTestMap(t, fs, "/p/.scratch", "m")

	// Create ticket (unreviewed)
	ticket := createTestTicketSimple(t, fs, "/p/.scratch", "m", "test")

	// Claim without review → error
	err := SetStatus(fs, "/p/.scratch", "m", ticket.ID, "claimed", time.Now().UTC())
	if !isErr(err, ErrInvalidInput) {
		t.Fatalf("expected ErrInvalidInput for unreviewed claim, got %v", err)
	}

	// Review it
	now := time.Date(2026, 8, 21, 10, 0, 0, 0, time.UTC)
	err = ReviewTicket(fs, "/p/.scratch", "m", ticket.ID, now)
	if err != nil {
		t.Fatalf("ReviewTicket() error = %v", err)
	}

	// Claim now succeeds
	claimTime := now.Add(1 * time.Hour)
	err = SetStatus(fs, "/p/.scratch", "m", ticket.ID, "claimed", claimTime)
	if err != nil {
		t.Fatalf("SetStatus() error = %v", err)
	}

	// Verify front matter
	_, fm, err := readTicket(fs, "/p/.scratch", "m", ticket.ID)
	if err != nil {
		t.Fatalf("readTicket() error = %v", err)
	}
	if fm.Status != "claimed" {
		t.Errorf("status = %q, want \"claimed\"", fm.Status)
	}
	if fm.ClaimedAt == nil || !fm.ClaimedAt.Equal(claimTime) {
		t.Errorf("claimed_at = %v, want %v", fm.ClaimedAt, claimTime)
	}
}

func TestSetStatusOpen(t *testing.T) {
	fs := afero.NewMemMapFs()
	setupTestMap(t, fs, "/p/.scratch", "m")
	ticket := createTestTicketReviewedAndClaimed(t, fs, "/p/.scratch", "m", "test")

	// Release claim
	err := SetStatus(fs, "/p/.scratch", "m", ticket.ID, "open", time.Now().UTC())
	if err != nil {
		t.Fatalf("SetStatus() error = %v", err)
	}

	_, fm, _ := readTicket(fs, "/p/.scratch", "m", ticket.ID)
	if fm.Status != "open" {
		t.Errorf("status = %q, want \"open\"", fm.Status)
	}
	if fm.ClaimedAt != nil {
		t.Errorf("claimed_at = %v, want nil", fm.ClaimedAt)
	}
}

func TestSetStatusResolved(t *testing.T) {
	fs := afero.NewMemMapFs()
	setupTestMap(t, fs, "/p/.scratch", "m")
	ticket := createTestTicketReviewedAndClaimed(t, fs, "/p/.scratch", "m", "test")

	resolveTime := time.Date(2026, 8, 21, 12, 0, 0, 0, time.UTC)
	err := SetStatus(fs, "/p/.scratch", "m", ticket.ID, "resolved", resolveTime)
	if err != nil {
		t.Fatalf("SetStatus() error = %v", err)
	}

	_, fm, _ := readTicket(fs, "/p/.scratch", "m", ticket.ID)
	if fm.Status != "resolved" {
		t.Errorf("status = %q, want \"resolved\"", fm.Status)
	}
	if fm.ResolvedAt == nil || !fm.ResolvedAt.Equal(resolveTime) {
		t.Errorf("resolved_at = %v, want %v", fm.ResolvedAt, resolveTime)
	}
}

func TestSetStatusReopen(t *testing.T) {
	fs := afero.NewMemMapFs()
	setupTestMap(t, fs, "/p/.scratch", "m")
	ticket := createTestTicketReviewedAndClaimed(t, fs, "/p/.scratch", "m", "test")

	// Resolve it first
	SetStatus(fs, "/p/.scratch", "m", ticket.ID, "resolved", time.Now().UTC())

	// Reopen
	reopenTime := time.Date(2026, 8, 21, 14, 0, 0, 0, time.UTC)
	err := SetStatus(fs, "/p/.scratch", "m", ticket.ID, "open", reopenTime)
	if err != nil {
		t.Fatalf("SetStatus() error = %v", err)
	}

	_, fm, _ := readTicket(fs, "/p/.scratch", "m", ticket.ID)
	if fm.Status != "open" {
		t.Errorf("status = %q, want \"open\"", fm.Status)
	}
	if fm.ResolvedAt != nil {
		t.Errorf("resolved_at = %v, want nil (cleared on reopen)", fm.ResolvedAt)
	}
	if fm.ClaimedAt != nil {
		t.Errorf("claimed_at = %v, want nil (cleared on reopen, G-Q3)", fm.ClaimedAt)
	}
}

func TestSetStatusClaimOnResolved(t *testing.T) {
	fs := afero.NewMemMapFs()
	setupTestMap(t, fs, "/p/.scratch", "m")
	ticket := createTestTicketReviewedAndClaimed(t, fs, "/p/.scratch", "m", "test")

	// Resolve
	SetStatus(fs, "/p/.scratch", "m", ticket.ID, "resolved", time.Now().UTC())

	// Try to claim → error
	err := SetStatus(fs, "/p/.scratch", "m", ticket.ID, "claimed", time.Now().UTC())
	if !isErr(err, ErrAlreadyResolved) {
		t.Fatalf("expected ErrAlreadyResolved, got %v", err)
	}
}

func TestSetStatusResolveAlreadyResolved(t *testing.T) {
	fs := afero.NewMemMapFs()
	setupTestMap(t, fs, "/p/.scratch", "m")
	ticket := createTestTicketReviewedAndClaimed(t, fs, "/p/.scratch", "m", "test")

	// Resolve
	SetStatus(fs, "/p/.scratch", "m", ticket.ID, "resolved", time.Now().UTC())

	// Resolve again → error
	err := SetStatus(fs, "/p/.scratch", "m", ticket.ID, "resolved", time.Now().UTC())
	if !isErr(err, ErrAlreadyResolved) {
		t.Fatalf("expected ErrAlreadyResolved, got %v", err)
	}
}

func TestSetStatusInvalidStatus(t *testing.T) {
	fs := afero.NewMemMapFs()
	setupTestMap(t, fs, "/p/.scratch", "m")
	ticket := createTestTicketReviewedAndClaimed(t, fs, "/p/.scratch", "m", "test")

	err := SetStatus(fs, "/p/.scratch", "m", ticket.ID, "invalid", time.Now().UTC())
	if !isErr(err, ErrInvalidInput) {
		t.Fatalf("expected ErrInvalidInput, got %v", err)
	}
}

func TestSetStatusTicketNotFound(t *testing.T) {
	fs := afero.NewMemMapFs()
	setupTestMap(t, fs, "/p/.scratch", "m")

	err := SetStatus(fs, "/p/.scratch", "m", "99", "open", time.Now().UTC())
	if !isErr(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

// Helpers

func createTestTicketSimple(t *testing.T, fs afero.Fs, scratchDir, mapSlug, title string) TicketSummary {
	t.Helper()
	now := time.Date(2026, 8, 21, 9, 0, 0, 0, time.UTC)
	ticket, err := CreateTicket(fs, scratchDir, TicketOpts{MapSlug: mapSlug, Title: title, Type: "task"}, now)
	if err != nil {
		t.Fatalf("CreateTicket() error = %v", err)
	}
	return ticket
}

func createTestTicketReviewedAndClaimed(t *testing.T, fs afero.Fs, scratchDir, mapSlug, title string) TicketSummary {
	t.Helper()
	now := time.Date(2026, 8, 21, 9, 0, 0, 0, time.UTC)
	ticket, err := CreateTicket(fs, scratchDir, TicketOpts{MapSlug: mapSlug, Title: title, Type: "task"}, now)
	if err != nil {
		t.Fatalf("CreateTicket() error = %v", err)
	}
	if err := ReviewTicket(fs, scratchDir, mapSlug, ticket.ID, now.Add(30*time.Minute)); err != nil {
		t.Fatalf("ReviewTicket() error = %v", err)
	}
	if err := SetStatus(fs, scratchDir, mapSlug, ticket.ID, "claimed", now.Add(1*time.Hour)); err != nil {
		t.Fatalf("SetStatus(claimed) error = %v", err)
	}
	return ticket
}
