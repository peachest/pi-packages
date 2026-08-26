package tracker

import (
	"testing"
	"time"

	"github.com/google/go-cmp/cmp"
)

func TestMapFrontMatterRoundTrip(t *testing.T) {
	original := MapFrontMatter{
		Title:     "SLO Testing",
		State:     "active",
		Milestone: strPtr("inference-benchmarking"),
		CreatedAt: time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC),
		ClosedAt:  nil,
	}

	data, err := original.Marshal()
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}

	parsed, err := ParseMapFrontMatter(data)
	if err != nil {
		t.Fatalf("ParseMapFrontMatter() error = %v", err)
	}

	if diff := cmp.Diff(original, parsed); diff != "" {
		t.Errorf("round-trip mismatch (-want +got):\n%s", diff)
	}
}

func TestMapFrontMatterNoMilestone(t *testing.T) {
	fm := MapFrontMatter{
		Title:     "Simple Map",
		State:     "active",
		Milestone: nil,
		CreatedAt: time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC),
		ClosedAt:  nil,
	}

	data, err := fm.Marshal()
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}

	parsed, err := ParseMapFrontMatter(data)
	if err != nil {
		t.Fatalf("ParseMapFrontMatter() error = %v", err)
	}

	if parsed.Milestone != nil {
		t.Errorf("Milestone = %v, want nil", parsed.Milestone)
	}
}

func TestComputeProgress(t *testing.T) {
	root := newTestRoot(t)
	setupTestMap(t, root, "m")

	now := time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC)

	// Create 3 tickets: 1 open, 1 claimed, 1 resolved
	t1 := createTestTicketSimple(t, root, "m", "open-one")
	_ = t1

	t2 := createTestTicketSimple(t, root, "m", "claimed-one")
	ReviewTicket(root, "m", t2.ID, now)
	SetStatus(root, "m", t2.ID, "claimed", now)

	t3 := createTestTicketSimple(t, root, "m", "resolved-one")
	ReviewTicket(root, "m", t3.ID, now)
	SetStatus(root, "m", t3.ID, "claimed", now)
	SetStatus(root, "m", t3.ID, "resolved", now)

	progress, err := ComputeProgress(root, "m")
	if err != nil {
		t.Fatalf("ComputeProgress() error = %v", err)
	}

	want := Progress{Open: 1, Claimed: 1, Resolved: 1, Total: 3}
	if diff := cmp.Diff(want, progress); diff != "" {
		t.Errorf("progress mismatch (-want +got):\n%s", diff)
	}
}

func TestComputeProgressEmpty(t *testing.T) {
	root := newTestRoot(t)
	setupTestMap(t, root, "m")

	progress, err := ComputeProgress(root, "m")
	if err != nil {
		t.Fatalf("ComputeProgress() error = %v", err)
	}

	want := Progress{Open: 0, Claimed: 0, Resolved: 0, Total: 0}
	if diff := cmp.Diff(want, progress); diff != "" {
		t.Errorf("progress mismatch (-want +got):\n%s", diff)
	}
}
