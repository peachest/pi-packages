package tracker

import (
	"testing"
	"time"

	"github.com/spf13/afero"
)

const milestonesDir = "/p/.scratch/.milestones"

func writeMilestoneFile(t *testing.T, fs afero.Fs, slug, title, state string, closedAt *time.Time) {
	t.Helper()
	fs.MkdirAll(milestonesDir, 0755)
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
	if err := afero.WriteFile(fs, milestonesDir+"/"+slug+".md", data, 0644); err != nil {
		t.Fatal(err)
	}
}

func TestMilestoneSetState(t *testing.T) {
	fs := afero.NewMemMapFs()
	writeMilestoneFile(t, fs, "m1", "Milestone One", "active", nil)

	// Close
	closeTime := time.Date(2026, 8, 26, 10, 0, 0, 0, time.UTC)
	err := SetMilestoneState(fs, "/p/.scratch", "m1", "closed", closeTime)
	if err != nil {
		t.Fatalf("SetMilestoneState() error = %v", err)
	}

	mfm, err := ReadMilestone(fs, "/p/.scratch", "m1")
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
	fs := afero.NewMemMapFs()
	closedAt := time.Date(2026, 8, 25, 0, 0, 0, 0, time.UTC)
	writeMilestoneFile(t, fs, "m1", "Milestone One", "closed", &closedAt)

	err := SetMilestoneState(fs, "/p/.scratch", "m1", "active", time.Now().UTC())
	if err != nil {
		t.Fatalf("SetMilestoneState() error = %v", err)
	}

	mfm, _ := ReadMilestone(fs, "/p/.scratch", "m1")
	if mfm.State != "active" {
		t.Errorf("state = %q, want \"active\"", mfm.State)
	}
	if mfm.ClosedAt != nil {
		t.Errorf("closed_at = %v, want nil", mfm.ClosedAt)
	}
}

func TestMilestoneSetStateNotFound(t *testing.T) {
	fs := afero.NewMemMapFs()
	fs.MkdirAll("/p/.scratch", 0755)

	err := SetMilestoneState(fs, "/p/.scratch", "nonexistent", "closed", time.Now().UTC())
	if !isErr(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

func TestMilestoneList(t *testing.T) {
	fs := afero.NewMemMapFs()
	writeMilestoneFile(t, fs, "m1", "Milestone One", "active", nil)
	writeMilestoneFile(t, fs, "m2", "Milestone Two", "closed", timePtr(time.Now().UTC()))

	milestones, err := ListMilestones(fs, "/p/.scratch")
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
	fs := afero.NewMemMapFs()
	fs.MkdirAll("/p/.scratch", 0755)

	// .milestones/ dir doesn't exist
	milestones, err := ListMilestones(fs, "/p/.scratch")
	if err != nil {
		t.Fatalf("ListMilestones() error = %v", err)
	}
	if len(milestones) != 0 {
		t.Errorf("got %d milestones, want 0", len(milestones))
	}
}

func TestMilestoneProgress(t *testing.T) {
	fs := afero.NewMemMapFs()
	writeMilestoneFile(t, fs, "ms1", "Milestone One", "active", nil)

	// Set up: map-a in milestone ms1 (1 ticket), map-b NOT in milestone (1 ticket)
	_ = "ms1"

	// Create maps with milestone field
	createMapWithMilestone(t, fs, "/p/.scratch/map-a", "ms1")
	createMapWithMilestone(t, fs, "/p/.scratch/map-b", "ms2")

	// Tickets in maps
	createTicketInMap(t, fs, "/p/.scratch", "map-a", "t1")
	createTicketInMap(t, fs, "/p/.scratch", "map-b", "t2")

	progress, err := MilestoneProgress(fs, "/p/.scratch", "ms1")
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
	fs := afero.NewMemMapFs()
	writeMilestoneFile(t, fs, "ms1", "Milestone One", "active", nil)

	progress, err := MilestoneProgress(fs, "/p/.scratch", "ms1")
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

func createMapWithMilestone(t *testing.T, fs afero.Fs, mapDir, milestoneSlug string) {
	t.Helper()
	fs.MkdirAll(mapDir, 0755)
	mfm := MapFrontMatter{
		Title:     mapDir,
		State:     "active",
		Milestone: &milestoneSlug,
		CreatedAt: time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC),
	}
	data, err := mfm.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	data = append(data, []byte("\n# "+mapDir+"\n")...)
	if err := afero.WriteFile(fs, mapDir+"/map.md", data, 0644); err != nil {
		t.Fatal(err)
	}
}

func createTicketInMap(t *testing.T, fs afero.Fs, scratchDir, mapSlug, title string) {
	t.Helper()
	fs.MkdirAll(scratchDir+"/"+mapSlug+"/issues", 0755)
	now := time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC)
	if _, err := CreateTicket(fs, scratchDir, TicketOpts{MapSlug: mapSlug, Title: title, Type: "task"}, now); err != nil {
		t.Fatal(err)
	}
}
