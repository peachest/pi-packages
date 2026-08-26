package tracker

import (
	"os"
	"testing"
	"time"
)

// milestonesRelDir is the milestones directory relative to the scratch root.
const milestonesRelDir = ".milestones"

func writeMilestoneFile(t *testing.T, root *os.Root, slug, title, state string, closedAt *time.Time) {
	t.Helper()
	root.MkdirAll(milestonesRelDir, 0755)
	now := time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC)
	mfm := MilestoneFrontMatter{
		Title:     title,
		State:     state,
		CreatedAt: now,
		ClosedAt:  closedAt,
	}
	data, err := mfm.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	data = append(data, []byte("\n# "+title+"\n")...)
	if err := root.WriteFile(milestonesRelDir+"/"+slug+".md", data, 0644); err != nil {
		t.Fatal(err)
	}
}

func TestMilestoneSetState(t *testing.T) {
	root := newTestRoot(t)
	writeMilestoneFile(t, root, "m1", "Milestone One", "active", nil)

	// Close
	closeTime := time.Date(2026, 8, 26, 10, 0, 0, 0, time.UTC)
	err := SetMilestoneState(root, "m1", "closed", closeTime)
	if err != nil {
		t.Fatalf("SetMilestoneState() error = %v", err)
	}

	mfm, err := ReadMilestone(root, "m1")
	if err != nil {
		t.Fatalf("ReadMilestone() error = %v", err)
	}
	if mfm.State != "closed" {
		t.Errorf("state = %q, want \"closed\"", mfm.State)
	}
	if mfm.ClosedAt == nil || !mfm.ClosedAt.Equal(closeTime) {
		t.Errorf("closed_at = %v, want %v", mfm.ClosedAt, closeTime)
	}
}

func TestMilestoneSetStateReopen(t *testing.T) {
	root := newTestRoot(t)
	closedAt := time.Date(2026, 8, 25, 0, 0, 0, 0, time.UTC)
	writeMilestoneFile(t, root, "m1", "Milestone One", "closed", &closedAt)

	err := SetMilestoneState(root, "m1", "active", time.Now().UTC())
	if err != nil {
		t.Fatalf("SetMilestoneState() error = %v", err)
	}

	mfm, _ := ReadMilestone(root, "m1")
	if mfm.State != "active" {
		t.Errorf("state = %q, want \"active\"", mfm.State)
	}
	if mfm.ClosedAt != nil {
		t.Errorf("closed_at = %v, want nil", mfm.ClosedAt)
	}
}

func TestMilestoneSetStateNotFound(t *testing.T) {
	root := newTestRoot(t)

	err := SetMilestoneState(root, "nonexistent", "closed", time.Now().UTC())
	if !isErr(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

func TestMilestoneList(t *testing.T) {
	root := newTestRoot(t)
	writeMilestoneFile(t, root, "m1", "Milestone One", "active", nil)
	writeMilestoneFile(t, root, "m2", "Milestone Two", "closed", timePtr(time.Now().UTC()))

	milestones, err := ListMilestones(root)
	if err != nil {
		t.Fatalf("ListMilestones() error = %v", err)
	}

	if len(milestones) != 2 {
		t.Fatalf("got %d milestones, want 2", len(milestones))
	}
	if milestones[0].Slug != "m1" || milestones[1].Slug != "m2" {
		t.Errorf("milestones = %v %v, want m1 m2", milestones[0].Slug, milestones[1].Slug)
	}
}

func TestMilestoneListEmpty(t *testing.T) {
	root := newTestRoot(t)

	// .milestones/ dir doesn't exist
	milestones, err := ListMilestones(root)
	if err != nil {
		t.Fatalf("ListMilestones() error = %v", err)
	}
	if len(milestones) != 0 {
		t.Errorf("got %d milestones, want 0", len(milestones))
	}
}

func TestMilestoneProgress(t *testing.T) {
	root := newTestRoot(t)
	writeMilestoneFile(t, root, "ms1", "Milestone One", "active", nil)

	// Set up: map-a in milestone ms1 (1 ticket), map-b NOT in milestone (1 ticket)
	// Create maps with milestone field
	createMapWithMilestone(t, root, "map-a", "ms1")
	createMapWithMilestone(t, root, "map-b", "ms2")

	// Tickets in maps
	createTicketInMap(t, root, "map-a", "t1")
	createTicketInMap(t, root, "map-b", "t2")

	progress, err := MilestoneProgress(root, "ms1")
	if err != nil {
		t.Fatalf("MilestoneProgress() error = %v", err)
	}

	// Only map-a is in ms1, so 1 ticket total
	if progress.Progress.Total != 1 {
		t.Errorf("total = %d, want 1 (only map-a in ms1)", progress.Progress.Total)
	}
	if progress.Progress.Open != 1 {
		t.Errorf("open = %d, want 1", progress.Progress.Open)
	}
	if len(progress.Maps) != 1 || progress.Maps[0] != "map-a" {
		t.Errorf("maps = %v, want [map-a]", progress.Maps)
	}
}

func TestMilestoneProgressZeroMaps(t *testing.T) {
	root := newTestRoot(t)
	writeMilestoneFile(t, root, "ms1", "Milestone One", "active", nil)

	progress, err := MilestoneProgress(root, "ms1")
	if err != nil {
		t.Fatalf("MilestoneProgress() error = %v", err)
	}

	want := Progress{Open: 0, Claimed: 0, Resolved: 0, Total: 0}
	if progress.Progress != want {
		t.Errorf("progress = %+v, want %+v", progress.Progress, want)
	}
	if len(progress.Maps) != 0 {
		t.Errorf("maps = %v, want []", progress.Maps)
	}
}

func createMapWithMilestone(t *testing.T, root *os.Root, mapSlug, milestoneSlug string) {
	t.Helper()
	root.MkdirAll(mapSlug, 0755)
	mfm := MapFrontMatter{
		Title:     mapSlug,
		State:     "active",
		Milestone: &milestoneSlug,
		CreatedAt: time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC),
	}
	data, err := mfm.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	data = append(data, []byte("\n# "+mapSlug+"\n")...)
	if err := root.WriteFile(mapSlug+"/map.md", data, 0644); err != nil {
		t.Fatal(err)
	}
}

func createTicketInMap(t *testing.T, root *os.Root, mapSlug, title string) {
	t.Helper()
	now := time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC)
	if _, err := CreateTicket(root, TicketOpts{MapSlug: mapSlug, Title: title, Type: "task"}, now); err != nil {
		t.Fatal(err)
	}
}
