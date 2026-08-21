package tracker

import (
	"testing"
	"time"

	"github.com/google/go-cmp/cmp"
	"github.com/spf13/afero"
)

func TestSetBlocking(t *testing.T) {
	fs := afero.NewMemMapFs()
	setupTestMap(t, fs, "/p/.scratch", "m")

	// Create 3 tickets
	t1 := createTestTicketSimple(t, fs, "/p/.scratch", "m", "first")
	t2 := createTestTicketSimple(t, fs, "/p/.scratch", "m", "second")
	t3 := createTestTicketSimple(t, fs, "/p/.scratch", "m", "third")
	_, _, _ = t1, t2, t3

	// t3 blocked by t1, t2
	err := SetBlocking(fs, "/p/.scratch", "m", t3.ID, []string{"1", "2"})
	if err != nil {
		t.Fatalf("SetBlocking() error = %v", err)
	}

	_, fm, _ := readTicket(fs, "/p/.scratch", "m", t3.ID)
	want := []string{"01", "02"}
	if diff := cmp.Diff(want, fm.BlockedBy); diff != "" {
		t.Errorf("blocked_by mismatch (-want +got):\n%s", diff)
	}
}

func TestSetBlockingClear(t *testing.T) {
	fs := afero.NewMemMapFs()
	setupTestMap(t, fs, "/p/.scratch", "m")

	createTestTicketSimple(t, fs, "/p/.scratch", "m", "first")
	t2 := createTestTicketSimple(t, fs, "/p/.scratch", "m", "second")

	// Set blocking
	SetBlocking(fs, "/p/.scratch", "m", t2.ID, []string{"1"})

	// Clear with empty
	err := SetBlocking(fs, "/p/.scratch", "m", t2.ID, []string{})
	if err != nil {
		t.Fatalf("SetBlocking() error = %v", err)
	}

	_, fm, _ := readTicket(fs, "/p/.scratch", "m", t2.ID)
	if len(fm.BlockedBy) != 0 {
		t.Errorf("blocked_by = %v, want empty", fm.BlockedBy)
	}
}

func TestSetBlockingNonExistentID(t *testing.T) {
	fs := afero.NewMemMapFs()
	setupTestMap(t, fs, "/p/.scratch", "m")
	createTestTicketSimple(t, fs, "/p/.scratch", "m", "first")

	err := SetBlocking(fs, "/p/.scratch", "m", "01", []string{"99"})
	if !isErr(err, ErrInvalidInput) {
		t.Fatalf("expected ErrInvalidInput, got %v", err)
	}
}

func TestSetBlockingSelfBlocking(t *testing.T) {
	fs := afero.NewMemMapFs()
	setupTestMap(t, fs, "/p/.scratch", "m")
	t1 := createTestTicketSimple(t, fs, "/p/.scratch", "m", "first")

	err := SetBlocking(fs, "/p/.scratch", "m", t1.ID, []string{"1"})
	if !isErr(err, ErrCycleDetected) {
		t.Fatalf("expected ErrCycleDetected for self-blocking, got %v", err)
	}
}

func TestSetBlockingCycle(t *testing.T) {
	fs := afero.NewMemMapFs()
	setupTestMap(t, fs, "/p/.scratch", "m")

	t1 := createTestTicketSimple(t, fs, "/p/.scratch", "m", "first")
	t2 := createTestTicketSimple(t, fs, "/p/.scratch", "m", "second")
	t3 := createTestTicketSimple(t, fs, "/p/.scratch", "m", "third")

	// t2 blocked by t1, t3 blocked by t2
	SetBlocking(fs, "/p/.scratch", "m", t2.ID, []string{"1"})
	SetBlocking(fs, "/p/.scratch", "m", t3.ID, []string{"2"})

	// Now try t1 blocked by t3 → cycle: t1 → t3 → t2 → t1
	err := SetBlocking(fs, "/p/.scratch", "m", t1.ID, []string{"3"})
	if !isErr(err, ErrCycleDetected) {
		t.Fatalf("expected ErrCycleDetected, got %v", err)
	}
}

func TestSetBlockingUsesNewEdges(t *testing.T) {
	fs := afero.NewMemMapFs()
	setupTestMap(t, fs, "/p/.scratch", "m")

	t1 := createTestTicketSimple(t, fs, "/p/.scratch", "m", "first")
	t2 := createTestTicketSimple(t, fs, "/p/.scratch", "m", "second")
	createTestTicketSimple(t, fs, "/p/.scratch", "m", "third")

	// Set up: t1 blocked by t2, t2 blocked by t3
	SetBlocking(fs, "/p/.scratch", "m", t1.ID, []string{"2"})
	SetBlocking(fs, "/p/.scratch", "m", t2.ID, []string{"3"})

	// Now change t1's blocking to t3 (removing t2) — this should NOT be a cycle
	// because with new edges, t1 → t3 only, and t3 has no blockers
	err := SetBlocking(fs, "/p/.scratch", "m", t1.ID, []string{"3"})
	if err != nil {
		t.Fatalf("SetBlocking() with new edges should not cycle, got: %v", err)
	}
}

func TestSetBlockingReplaces(t *testing.T) {
	fs := afero.NewMemMapFs()
	setupTestMap(t, fs, "/p/.scratch", "m")

	createTestTicketSimple(t, fs, "/p/.scratch", "m", "first")
	createTestTicketSimple(t, fs, "/p/.scratch", "m", "second")
	t3 := createTestTicketSimple(t, fs, "/p/.scratch", "m", "third")

	// t3 blocked by t1
	SetBlocking(fs, "/p/.scratch", "m", t3.ID, []string{"1"})

	// Replace with t2
	err := SetBlocking(fs, "/p/.scratch", "m", t3.ID, []string{"2"})
	if err != nil {
		t.Fatalf("SetBlocking() error = %v", err)
	}

	_, fm, _ := readTicket(fs, "/p/.scratch", "m", t3.ID)
	want := []string{"02"}
	if diff := cmp.Diff(want, fm.BlockedBy); diff != "" {
		t.Errorf("blocked_by mismatch (-want +got):\n%s", diff)
	}
}

// Avoid unused import
var _ = time.Now
