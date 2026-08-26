package cmd

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/peachest/pi-packages/tracker/tracker"
	"github.com/spf13/afero"
)

func TestMilestoneStateCommand(t *testing.T) {
	fs := afero.NewMemMapFs()
	writeMilestoneMD(t, fs, "m1", "Milestone One", "active")

	SetFS(fs)
	SetCWD("/test")

	buf := runCmd(t, []string{"milestone", "state", "--slug", "m1", "--set", "closed"})
	var result map[string]any
	json.Unmarshal([]byte(buf), &result)
	if result["state"] != "closed" {
		t.Errorf("state = %v, want \"closed\"", result["state"])
	}
}

func TestMilestoneProgressCommand(t *testing.T) {
	fs := afero.NewMemMapFs()
	writeMilestoneMD(t, fs, "m1", "Milestone One", "active")

	// Create map in milestone with 1 ticket
	writeMapMD(t, fs, "/test/.scratch/ref-map", "Ref Map", "active", strPtr("m1"))
	fs.MkdirAll("/test/.scratch/ref-map/issues", 0755)
	SetFS(fs)
	SetCWD("/test")
	createTicketViaCmd(t, "ref-map", "t1", "task")

	buf := runCmd(t, []string{"milestone", "progress", "--slug", "m1"})
	var result map[string]any
	json.Unmarshal([]byte(buf), &result)

	progress, ok := result["progress"].(map[string]any)
	if !ok {
		t.Fatalf("progress not found: %s", buf)
	}
	if progress["total"] != float64(1) {
		t.Errorf("total = %v, want 1", progress["total"])
	}
	if _, ok := progress["frontier_size"]; ok {
		t.Error("frontier_size should NOT be in milestone progress")
	}
}

func TestMilestoneListCommand(t *testing.T) {
	fs := afero.NewMemMapFs()
	writeMilestoneMD(t, fs, "m1", "Milestone One", "active")
	writeMilestoneMD(t, fs, "m2", "Milestone Two", "closed")

	SetFS(fs)
	SetCWD("/test")

	buf := runCmd(t, []string{"milestone", "list"})
	var results []map[string]any
	json.Unmarshal([]byte(buf), &results)

	if len(results) != 2 {
		t.Fatalf("got %d milestones, want 2", len(results))
	}
	if results[0]["slug"] != "m1" {
		t.Errorf("first slug = %v, want \"m1\"", results[0]["slug"])
	}
	if results[0]["map_count"] != float64(0) {
		t.Errorf("map_count = %v, want 0", results[0]["map_count"])
	}
}

func TestMilestoneListEmpty(t *testing.T) {
	fs := afero.NewMemMapFs()
	fs.MkdirAll("/test/.scratch", 0755)

	SetFS(fs)
	SetCWD("/test")

	buf := runCmd(t, []string{"milestone", "list"})
	var results []map[string]any
	json.Unmarshal([]byte(buf), &results)
	if len(results) != 0 {
		t.Errorf("expected empty array, got %d", len(results))
	}
}

func writeMilestoneMD(t *testing.T, fs afero.Fs, slug, title, state string) {
	t.Helper()
	fs.MkdirAll("/test/.scratch/.milestones", 0755)
	mfm := tracker.MilestoneFrontMatter{Title: title, State: state}
	mfm.CreatedAt = fixedTime()
	data, err := mfm.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	data = append(data, []byte("\n# "+title+"\n")...)
	if err := afero.WriteFile(fs, "/test/.scratch/.milestones/"+slug+".md", data, 0644); err != nil {
		t.Fatal(err)
	}
}

func strPtr(s string) *string { return &s }

func fixedTime() time.Time {
	return time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC)
}