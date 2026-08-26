package tracker

import (
	"testing"
	"time"

	"github.com/google/go-cmp/cmp"
)

func TestSetBlocking(t *testing.T) {
	root := newTestRoot(t)
	setupTestMap(t, root, "m")

	// Create 3 tickets
	t1 := createTestTicketSimple(t, root, "m", "first")
	t2 := createTestTicketSimple(t, root, "m", "second")
	t3 := createTestTicketSimple(t, root, "m", "third")
	_, _, _ = t1, t2, t3

	// t3 blocked by t1, t2
	err := SetBlocking(root, "m", t3.ID, []string{"1", "2"})
	if err != nil {
		t.Fatalf("SetBlocking() error = %v", err)
	}

	_, fm, _ := readTicket(root, "m", t3.ID)
	want := []string{"01", "02"}
	if diff := cmp.Diff(want, fm.BlockedBy); diff != "" {
		t.Errorf("blocked_by mismatch (-want +got):\n%s", diff)
	}
}

func TestSetBlockingClear(t *testing.T) {
	root := newTestRoot(t)
	setupTestMap(t, root, "m")

	createTestTicketSimple(t, root, "m", "first")
	t2 := createTestTicketSimple(t, root, "m", "second")

	// Set blocking
	SetBlocking(root, "m", t2.ID, []string{"1"})

	// Clear with empty
	err := SetBlocking(root, "m", t2.ID, []string{})
	if err != nil {
		t.Fatalf("SetBlocking() error = %v", err)
	}

	_, fm, _ := readTicket(root, "m", t2.ID)
	if len(fm.BlockedBy) != 0 {
		t.Errorf("blocked_by = %v, want empty", fm.BlockedBy)
	}
}

func TestSetBlockingNonExistentID(t *testing.T) {
	root := newTestRoot(t)
	setupTestMap(t, root, "m")
	createTestTicketSimple(t, root, "m", "first")

	err := SetBlocking(root, "m", "01", []string{"99"})
	if !isErr(err, ErrInvalidInput) {
		t.Fatalf("expected ErrInvalidInput, got %v", err)
	}
}

func TestSetBlockingSelfBlocking(t *testing.T) {
	root := newTestRoot(t)
	setupTestMap(t, root, "m")
	t1 := createTestTicketSimple(t, root, "m", "first")

	err := SetBlocking(root, "m", t1.ID, []string{"1"})
	if !isErr(err, ErrCycleDetected) {
		t.Fatalf("expected ErrCycleDetected for self-blocking, got %v", err)
	}
}

func TestSetBlockingCycle(t *testing.T) {
	root := newTestRoot(t)
	setupTestMap(t, root, "m")

	t1 := createTestTicketSimple(t, root, "m", "first")
	t2 := createTestTicketSimple(t, root, "m", "second")
	t3 := createTestTicketSimple(t, root, "m", "third")

	// t2 blocked by t1, t3 blocked by t2
	SetBlocking(root, "m", t2.ID, []string{"1"})
	SetBlocking(root, "m", t3.ID, []string{"2"})

	// Now try t1 blocked by t3 → cycle: t1 → t3 → t2 → t1
	err := SetBlocking(root, "m", t1.ID, []string{"3"})
	if !isErr(err, ErrCycleDetected) {
		t.Fatalf("expected ErrCycleDetected, got %v", err)
	}
}

func TestSetBlockingUsesNewEdges(t *testing.T) {
	root := newTestRoot(t)
	setupTestMap(t, root, "m")

	t1 := createTestTicketSimple(t, root, "m", "first")
	t2 := createTestTicketSimple(t, root, "m", "second")
	createTestTicketSimple(t, root, "m", "third")

	// Set up: t1 blocked by t2, t2 blocked by t3
	SetBlocking(root, "m", t1.ID, []string{"2"})
	SetBlocking(root, "m", t2.ID, []string{"3"})

	// Now change t1's blocking to t3 (removing t2) — this should NOT be a cycle
	// because with new edges, t1 → t3 only, and t3 has no blockers
	err := SetBlocking(root, "m", t1.ID, []string{"3"})
	if err != nil {
		t.Fatalf("SetBlocking() with new edges should not cycle, got: %v", err)
	}
}

func TestSetBlockingReplaces(t *testing.T) {
	root := newTestRoot(t)
	setupTestMap(t, root, "m")

	createTestTicketSimple(t, root, "m", "first")
	createTestTicketSimple(t, root, "m", "second")
	t3 := createTestTicketSimple(t, root, "m", "third")

	// t3 blocked by t1
	SetBlocking(root, "m", t3.ID, []string{"1"})

	// Replace with t2
	err := SetBlocking(root, "m", t3.ID, []string{"2"})
	if err != nil {
		t.Fatalf("SetBlocking() error = %v", err)
	}

	_, fm, _ := readTicket(root, "m", t3.ID)
	want := []string{"02"}
	if diff := cmp.Diff(want, fm.BlockedBy); diff != "" {
		t.Errorf("blocked_by mismatch (-want +got):\n%s", diff)
	}
}

// Avoid unused import
var _ = time.Now
