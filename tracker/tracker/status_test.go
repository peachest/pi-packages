package tracker

import (
	"os"
	"testing"
	"time"
)

func TestSetStatusClaimed(t *testing.T) {
	root := newTestRoot(t)
	setupTestMap(t, root, "m")

	// Create ticket (unreviewed)
	ticket := createTestTicketSimple(t, root, "m", "test")

	// Claim without review → error
	err := SetStatus(root, "m", ticket.ID, "claimed", time.Now().UTC())
	if !isErr(err, ErrInvalidInput) {
		t.Fatalf("expected ErrInvalidInput for unreviewed claim, got %v", err)
	}

	// Review it
	now := time.Date(2026, 8, 21, 10, 0, 0, 0, time.UTC)
	err = ReviewTicket(root, "m", ticket.ID, now)
	if err != nil {
		t.Fatalf("ReviewTicket() error = %v", err)
	}

	// Claim now succeeds
	claimTime := now.Add(1 * time.Hour)
	err = SetStatus(root, "m", ticket.ID, "claimed", claimTime)
	if err != nil {
		t.Fatalf("SetStatus() error = %v", err)
	}

	// Verify front matter
	_, fm, err := readTicket(root, "m", ticket.ID)
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
	root := newTestRoot(t)
	setupTestMap(t, root, "m")
	ticket := createTestTicketReviewedAndClaimed(t, root, "m", "test")

	// Release claim
	err := SetStatus(root, "m", ticket.ID, "open", time.Now().UTC())
	if err != nil {
		t.Fatalf("SetStatus() error = %v", err)
	}

	_, fm, _ := readTicket(root, "m", ticket.ID)
	if fm.Status != "open" {
		t.Errorf("status = %q, want \"open\"", fm.Status)
	}
	if fm.ClaimedAt != nil {
		t.Errorf("claimed_at = %v, want nil", fm.ClaimedAt)
	}
}

func TestSetStatusResolved(t *testing.T) {
	root := newTestRoot(t)
	setupTestMap(t, root, "m")
	ticket := createTestTicketReviewedAndClaimed(t, root, "m", "test")

	resolveTime := time.Date(2026, 8, 21, 12, 0, 0, 0, time.UTC)
	err := SetStatus(root, "m", ticket.ID, "resolved", resolveTime)
	if err != nil {
		t.Fatalf("SetStatus() error = %v", err)
	}

	_, fm, _ := readTicket(root, "m", ticket.ID)
	if fm.Status != "resolved" {
		t.Errorf("status = %q, want \"resolved\"", fm.Status)
	}
	if fm.ResolvedAt == nil || !fm.ResolvedAt.Equal(resolveTime) {
		t.Errorf("resolved_at = %v, want %v", fm.ResolvedAt, resolveTime)
	}
}

func TestSetStatusReopen(t *testing.T) {
	root := newTestRoot(t)
	setupTestMap(t, root, "m")
	ticket := createTestTicketReviewedAndClaimed(t, root, "m", "test")

	// Resolve it first
	SetStatus(root, "m", ticket.ID, "resolved", time.Now().UTC())

	// Reopen
	reopenTime := time.Date(2026, 8, 21, 14, 0, 0, 0, time.UTC)
	err := SetStatus(root, "m", ticket.ID, "open", reopenTime)
	if err != nil {
		t.Fatalf("SetStatus() error = %v", err)
	}

	_, fm, _ := readTicket(root, "m", ticket.ID)
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
	root := newTestRoot(t)
	setupTestMap(t, root, "m")
	ticket := createTestTicketReviewedAndClaimed(t, root, "m", "test")

	// Resolve
	SetStatus(root, "m", ticket.ID, "resolved", time.Now().UTC())

	// Try to claim → error
	err := SetStatus(root, "m", ticket.ID, "claimed", time.Now().UTC())
	if !isErr(err, ErrAlreadyResolved) {
		t.Fatalf("expected ErrAlreadyResolved, got %v", err)
	}
}

func TestSetStatusResolveAlreadyResolved(t *testing.T) {
	root := newTestRoot(t)
	setupTestMap(t, root, "m")
	ticket := createTestTicketReviewedAndClaimed(t, root, "m", "test")

	// Resolve
	SetStatus(root, "m", ticket.ID, "resolved", time.Now().UTC())

	// Resolve again → error
	err := SetStatus(root, "m", ticket.ID, "resolved", time.Now().UTC())
	if !isErr(err, ErrAlreadyResolved) {
		t.Fatalf("expected ErrAlreadyResolved, got %v", err)
	}
}

func TestSetStatusClaimAlreadyClaimed(t *testing.T) {
	root := newTestRoot(t)
	setupTestMap(t, root, "m")
	ticket := createTestTicketReviewedAndClaimed(t, root, "m", "test")

	// ticket is already claimed (by helper). Claim again → error, preserves original ClaimedAt.
	originalClaimTime := time.Date(2026, 8, 21, 10, 0, 0, 0, time.UTC)
	err := SetStatus(root, "m", ticket.ID, "claimed", originalClaimTime.Add(1*time.Hour))
	if !isErr(err, ErrAlreadyClaimed) {
		t.Fatalf("expected ErrAlreadyClaimed, got %v", err)
	}

	// Verify original ClaimedAt is preserved (not overwritten)
	_, fm, _ := readTicket(root, "m", ticket.ID)
	if fm.ClaimedAt == nil || !fm.ClaimedAt.Equal(originalClaimTime) {
		t.Errorf("claimed_at = %v, want %v (original preserved)", fm.ClaimedAt, originalClaimTime)
	}
}

func TestSetStatusOpenIdempotent(t *testing.T) {
	root := newTestRoot(t)
	setupTestMap(t, root, "m")
	ticket := createTestTicketSimple(t, root, "m", "test")

	// Already open; setting open again is a no-op (no error, no timestamp changes)
	err := SetStatus(root, "m", ticket.ID, "open", time.Now().UTC())
	if err != nil {
		t.Fatalf("SetStatus(open) on open ticket should be no-op, got %v", err)
	}
	_, fm, _ := readTicket(root, "m", ticket.ID)
	if fm.Status != "open" {
		t.Errorf("status = %q, want open", fm.Status)
	}
}

func TestSetStatusInvalidStatus(t *testing.T) {
	root := newTestRoot(t)
	setupTestMap(t, root, "m")
	ticket := createTestTicketReviewedAndClaimed(t, root, "m", "test")

	err := SetStatus(root, "m", ticket.ID, "invalid", time.Now().UTC())
	if !isErr(err, ErrInvalidInput) {
		t.Fatalf("expected ErrInvalidInput, got %v", err)
	}
}

func TestSetStatusTicketNotFound(t *testing.T) {
	root := newTestRoot(t)
	setupTestMap(t, root, "m")

	err := SetStatus(root, "m", "99", "open", time.Now().UTC())
	if !isErr(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

// Helpers

func createTestTicketSimple(t *testing.T, root *os.Root, mapSlug, title string) TicketSummary {
	t.Helper()
	now := time.Date(2026, 8, 21, 9, 0, 0, 0, time.UTC)
	ticket, err := CreateTicket(root, TicketOpts{MapSlug: mapSlug, Title: title, Type: "task"}, now)
	if err != nil {
		t.Fatalf("CreateTicket() error = %v", err)
	}
	return ticket
}

func createTestTicketReviewedAndClaimed(t *testing.T, root *os.Root, mapSlug, title string) TicketSummary {
	t.Helper()
	now := time.Date(2026, 8, 21, 9, 0, 0, 0, time.UTC)
	ticket, err := CreateTicket(root, TicketOpts{MapSlug: mapSlug, Title: title, Type: "task"}, now)
	if err != nil {
		t.Fatalf("CreateTicket() error = %v", err)
	}
	if err := ReviewTicket(root, mapSlug, ticket.ID, now.Add(30*time.Minute)); err != nil {
		t.Fatalf("ReviewTicket() error = %v", err)
	}
	if err := SetStatus(root, mapSlug, ticket.ID, "claimed", now.Add(1*time.Hour)); err != nil {
		t.Fatalf("SetStatus(claimed) error = %v", err)
	}
	return ticket
}
