package cmd

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/peachest/pi-packages/tracker/tracker"
	"github.com/spf13/afero"
)

func TestMapStateCommand(t *testing.T) {
	fs := afero.NewMemMapFs()
	fs.MkdirAll("/test/.scratch/m", 0755)
	writeMapMD(t, fs, "/test/.scratch/m", "Test Map", "active", nil)

	SetFS(fs)
	SetCWD("/test")

	buf := runCmd(t, []string{"map", "state", "--slug", "m", "--set", "closed"})
	var result map[string]any
	json.Unmarshal([]byte(buf), &result)
	if result["state"] != "closed" {
		t.Errorf("state = %v, want \"closed\"", result["state"])
	}
}

func TestMapProgressCommand(t *testing.T) {
	fs := afero.NewMemMapFs()
	fs.MkdirAll("/test/.scratch/m/issues", 0755)
	writeMapMD(t, fs, "/test/.scratch/m", "Test Map", "active", nil)

	SetFS(fs)
	SetCWD("/test")

	// Create 2 tickets, resolve 1
	createTicketViaCmd(t, "m", "first", "task")
	createTicketViaCmd(t, "m", "second", "task")
	runCmd(t, []string{"ticket", "review", "--map", "m", "--id", "1"})
	runCmd(t, []string{"ticket", "status", "--map", "m", "--id", "1", "--set", "claimed"})
	runCmd(t, []string{"ticket", "status", "--map", "m", "--id", "1", "--set", "resolved"})

	buf := runCmd(t, []string{"map", "progress", "--slug", "m"})
	var result map[string]any
	json.Unmarshal([]byte(buf), &result)

	progress, ok := result["progress"].(map[string]any)
	if !ok {
		t.Fatalf("progress not found in output: %s", buf)
	}
	if progress["total"] != float64(2) {
		t.Errorf("total = %v, want 2", progress["total"])
	}
	if progress["resolved"] != float64(1) {
		t.Errorf("resolved = %v, want 1", progress["resolved"])
	}
	// frontier_size should be top-level, not inside progress
	if _, ok := progress["frontier_size"]; ok {
		t.Error("frontier_size should NOT be inside progress")
	}
	if result["frontier_size"] == nil {
		t.Error("frontier_size should be top-level")
	}
}

func TestMapListCommand(t *testing.T) {
	fs := afero.NewMemMapFs()
	fs.MkdirAll("/test/.scratch/map-a", 0755)
	fs.MkdirAll("/test/.scratch/map-b", 0755)
	writeMapMD(t, fs, "/test/.scratch/map-a", "Map A", "active", nil)
	writeMapMD(t, fs, "/test/.scratch/map-b", "Map B", "closed", nil)

	SetFS(fs)
	SetCWD("/test")

	buf := runCmd(t, []string{"map", "list"})
	var results []map[string]any
	json.Unmarshal([]byte(buf), &results)

	if len(results) != 2 {
		t.Fatalf("got %d maps, want 2", len(results))
	}
	if results[0]["slug"] != "map-a" {
		t.Errorf("first slug = %v, want \"map-a\"", results[0]["slug"])
	}
	// map list should NOT have frontier_size
	if _, ok := results[0]["frontier_size"]; ok {
		t.Error("map list should NOT include frontier_size")
	}
}

func TestMapListEmpty(t *testing.T) {
	fs := afero.NewMemMapFs()
	fs.MkdirAll("/test/.scratch", 0755)

	SetFS(fs)
	SetCWD("/test")

	buf := runCmd(t, []string{"map", "list"})
	var results []map[string]any
	json.Unmarshal([]byte(buf), &results)
	if len(results) != 0 {
		t.Errorf("expected empty array, got %d", len(results))
	}
}

func TestMapListFilterMilestone(t *testing.T) {
	fs := afero.NewMemMapFs()
	fs.MkdirAll("/test/.scratch/with-ms", 0755)
	fs.MkdirAll("/test/.scratch/no-ms", 0755)
	ms := "infra"
	writeMapMD(t, fs, "/test/.scratch/with-ms", "With MS", "active", &ms)
	writeMapMD(t, fs, "/test/.scratch/no-ms", "No MS", "active", nil)

	SetFS(fs)
	SetCWD("/test")

	buf := runCmd(t, []string{"map", "list", "--milestone", "infra"})
	var results []map[string]any
	json.Unmarshal([]byte(buf), &results)

	if len(results) != 1 {
		t.Fatalf("got %d maps, want 1", len(results))
	}
	if results[0]["slug"] != "with-ms" {
		t.Errorf("slug = %v, want \"with-ms\"", results[0]["slug"])
	}
}

func writeMapMD(t *testing.T, fs afero.Fs, dir, title, state string, milestone *string) {
	t.Helper()
	mfm := tracker.MapFrontMatter{
		Title:     title,
		State:     state,
		Milestone: milestone,
	}
	// Use time import
	mfm.CreatedAt = time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC)
	data, err := mfm.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	data = append(data, []byte("\n# "+title+"\n")...)
	if err := afero.WriteFile(fs, dir+"/map.md", data, 0644); err != nil {
		t.Fatal(err)
	}
}

