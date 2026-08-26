package tracker

import (
	"testing"
	"time"
)

func TestSetTriage(t *testing.T) {
	root := newTestRoot(t)
	setupTestMap(t, root, "m")
	ticket := createTestTicketSimple(t, root, "m", "test")

	err := SetTriage(root, "m", ticket.ID, "ready-for-agent")
	if err != nil {
		t.Fatalf("SetTriage() error = %v", err)
	}

	_, fm, _ := readTicket(root, "m", ticket.ID)
	if fm.Triage == nil || *fm.Triage != "ready-for-agent" {
		t.Errorf("triage = %v, want \"ready-for-agent\"", fm.Triage)
	}
}

func TestSetTriageWontfix(t *testing.T) {
	root := newTestRoot(t)
	setupTestMap(t, root, "m")
	ticket := createTestTicketSimple(t, root, "m", "test")
	_ = time.Now()

	err := SetTriage(root, "m", ticket.ID, "wontfix")
	if err != nil {
		t.Fatalf("SetTriage() error = %v", err)
	}

	_, fm, _ := readTicket(root, "m", ticket.ID)
	if fm.Triage == nil || *fm.Triage != "wontfix" {
		t.Errorf("triage = %v, want \"wontfix\"", fm.Triage)
	}

	// wontfix should NOT change status
	if fm.Status != "open" {
		t.Errorf("status = %q, want \"open\" (wontfix is triage, not status)", fm.Status)
	}
}

func TestSetTriageInvalid(t *testing.T) {
	root := newTestRoot(t)
	setupTestMap(t, root, "m")
	ticket := createTestTicketSimple(t, root, "m", "test")

	err := SetTriage(root, "m", ticket.ID, "invalid")
	if !isErr(err, ErrInvalidInput) {
		t.Fatalf("expected ErrInvalidInput, got %v", err)
	}
}
