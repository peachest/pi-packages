package tracker

import (
	"testing"
	"time"

	"github.com/spf13/afero"
)

func TestSetTriage(t *testing.T) {
	fs := afero.NewMemMapFs()
	setupTestMap(t, fs, "/p/.scratch", "m")
	ticket := createTestTicketSimple(t, fs, "/p/.scratch", "m", "test")

	err := SetTriage(fs, "/p/.scratch", "m", ticket.ID, "ready-for-agent")
	if err != nil {
		t.Fatalf("SetTriage() error = %v", err)
	}

	_, fm, _ := readTicket(fs, "/p/.scratch", "m", ticket.ID)
	if fm.Triage == nil || *fm.Triage != "ready-for-agent" {
		t.Errorf("triage = %v, want \"ready-for-agent\"", fm.Triage)
	}
}

func TestSetTriageWontfix(t *testing.T) {
	fs := afero.NewMemMapFs()
	setupTestMap(t, fs, "/p/.scratch", "m")
	ticket := createTestTicketSimple(t, fs, "/p/.scratch", "m", "test")
	_ = time.Now()

	err := SetTriage(fs, "/p/.scratch", "m", ticket.ID, "wontfix")
	if err != nil {
		t.Fatalf("SetTriage() error = %v", err)
	}

	_, fm, _ := readTicket(fs, "/p/.scratch", "m", ticket.ID)
	if fm.Triage == nil || *fm.Triage != "wontfix" {
		t.Errorf("triage = %v, want \"wontfix\"", fm.Triage)
	}

	// wontfix should NOT change status
	if fm.Status != "open" {
		t.Errorf("status = %q, want \"open\" (wontfix is triage, not status)", fm.Status)
	}
}

func TestSetTriageInvalid(t *testing.T) {
	fs := afero.NewMemMapFs()
	setupTestMap(t, fs, "/p/.scratch", "m")
	ticket := createTestTicketSimple(t, fs, "/p/.scratch", "m", "test")

	err := SetTriage(fs, "/p/.scratch", "m", ticket.ID, "invalid")
	if !isErr(err, ErrInvalidInput) {
		t.Fatalf("expected ErrInvalidInput, got %v", err)
	}
}
