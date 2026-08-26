package cmd

import (
	"encoding/json"
	"os"
	"testing"
)

func TestQueryFrontierCommand(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(dir+"/.scratch/m/issues", 0755)
	os.WriteFile(dir+"/.scratch/m/map.md", []byte("# M"), 0644)

	SetCWD(dir)

	// Create tickets: #01 resolved, #02 open (in frontier)
	createTicketViaCmd(t, "m", "resolved-one", "task")
	runCmd(t, []string{"ticket", "review", "--map", "m", "--id", "1"})
	runCmd(t, []string{"ticket", "status", "--map", "m", "--id", "1", "--set", "claimed"})
	runCmd(t, []string{"ticket", "status", "--map", "m", "--id", "1", "--set", "resolved"})

	createTicketViaCmd(t, "m", "open-one", "task")

	// Query frontier
	buf := runCmd(t, []string{"query", "frontier", "--map", "m"})

	var results []map[string]any
	if err := json.Unmarshal([]byte(buf), &results); err != nil {
		t.Fatalf("output not valid JSON array: %v\n%s", err, buf)
	}

	if len(results) != 1 {
		t.Fatalf("got %d frontier tickets, want 1", len(results))
	}
	if results[0]["id"] != "02" {
		t.Errorf("frontier ticket id = %v, want \"02\"", results[0]["id"])
	}
}

func TestQueryFrontierEmpty(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(dir+"/.scratch/m/issues", 0755)
	os.WriteFile(dir+"/.scratch/m/map.md", []byte("# M"), 0644)

	SetCWD(dir)

	buf := runCmd(t, []string{"query", "frontier", "--map", "m"})

	var results []map[string]any
	if err := json.Unmarshal([]byte(buf), &results); err != nil {
		t.Fatalf("output not valid JSON: %v", err)
	}
	if len(results) != 0 {
		t.Errorf("expected empty array, got %d items", len(results))
	}
}

func TestQueryFrontierBlockedByClaimed(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(dir+"/.scratch/m/issues", 0755)
	os.WriteFile(dir+"/.scratch/m/map.md", []byte("# M"), 0644)

	SetCWD(dir)

	// #01 claimed, #02 open blocked by #01 → NOT in frontier
	createTicketViaCmd(t, "m", "claimed-one", "task")
	runCmd(t, []string{"ticket", "review", "--map", "m", "--id", "1"})
	runCmd(t, []string{"ticket", "status", "--map", "m", "--id", "1", "--set", "claimed"})

	createTicketViaCmd(t, "m", "blocked-one", "task")
	runCmd(t, []string{"ticket", "blocking", "--map", "m", "--id", "2", "--by", "1"})

	buf := runCmd(t, []string{"query", "frontier", "--map", "m"})

	var results []map[string]any
	json.Unmarshal([]byte(buf), &results)
	if len(results) != 0 {
		t.Errorf("expected 0 frontier tickets (all blocked), got %d", len(results))
	}
}

func TestQueryFrontierSortedById(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(dir+"/.scratch/m/issues", 0755)
	os.WriteFile(dir+"/.scratch/m/map.md", []byte("# M"), 0644)

	SetCWD(dir)

	// Create 3 open tickets
	createTicketViaCmd(t, "m", "third", "task")
	createTicketViaCmd(t, "m", "first", "task")
	createTicketViaCmd(t, "m", "second", "task")

	buf := runCmd(t, []string{"query", "frontier", "--map", "m"})

	var results []map[string]any
	json.Unmarshal([]byte(buf), &results)
	if len(results) != 3 {
		t.Fatalf("got %d, want 3", len(results))
	}
	if results[0]["id"] != "01" || results[1]["id"] != "02" || results[2]["id"] != "03" {
		t.Errorf("not sorted by id: %v %v %v", results[0]["id"], results[1]["id"], results[2]["id"])
	}
}
