package cmd

import (
	"bytes"
	"encoding/json"
	"os"
	"testing"
)

func TestTicketStatusCommand(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(dir+"/.scratch/m/issues", 0755)
	os.WriteFile(dir+"/.scratch/m/map.md", []byte("# M"), 0644)

	SetCWD(dir)

	// Create ticket
	createTicketViaCmd(t, "m", "test", "task")

	// Review it (required before claim)
	runCmd(t, []string{"ticket", "review", "--map", "m", "--id", "1"})

	// Claim
	buf := runCmd(t, []string{"ticket", "status", "--map", "m", "--id", "1", "--set", "claimed"})
	var result map[string]any
	json.Unmarshal([]byte(buf), &result)
	if result["status"] != "claimed" {
		t.Errorf("status = %v, want \"claimed\"", result["status"])
	}
}

func TestTicketStatusClaimUnreviewed(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(dir+"/.scratch/m/issues", 0755)
	os.WriteFile(dir+"/.scratch/m/map.md", []byte("# M"), 0644)

	SetCWD(dir)

	createTicketViaCmd(t, "m", "test", "task")

	// Claim without review → error
	root := NewRootCmd()
	root.SetOut(new(bytes.Buffer))
	root.SetErr(new(bytes.Buffer))
	root.SetArgs([]string{"ticket", "status", "--map", "m", "--id", "1", "--set", "claimed"})

	err := root.Execute()
	if err == nil {
		t.Fatal("expected error for unreviewed claim")
	}
}

func TestTicketStatusResolve(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(dir+"/.scratch/m/issues", 0755)
	os.WriteFile(dir+"/.scratch/m/map.md", []byte("# M"), 0644)

	SetCWD(dir)

	createTicketViaCmd(t, "m", "test", "task")
	runCmd(t, []string{"ticket", "review", "--map", "m", "--id", "1"})
	runCmd(t, []string{"ticket", "status", "--map", "m", "--id", "1", "--set", "claimed"})

	// Resolve
	buf := runCmd(t, []string{"ticket", "status", "--map", "m", "--id", "1", "--set", "resolved"})
	var result map[string]any
	json.Unmarshal([]byte(buf), &result)
	if result["status"] != "resolved" {
		t.Errorf("status = %v, want \"resolved\"", result["status"])
	}
}

func TestTicketStatusReopen(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(dir+"/.scratch/m/issues", 0755)
	os.WriteFile(dir+"/.scratch/m/map.md", []byte("# M"), 0644)

	SetCWD(dir)

	createTicketViaCmd(t, "m", "test", "task")
	runCmd(t, []string{"ticket", "review", "--map", "m", "--id", "1"})
	runCmd(t, []string{"ticket", "status", "--map", "m", "--id", "1", "--set", "claimed"})
	runCmd(t, []string{"ticket", "status", "--map", "m", "--id", "1", "--set", "resolved"})

	// Reopen
	buf := runCmd(t, []string{"ticket", "status", "--map", "m", "--id", "1", "--set", "open"})
	var result map[string]any
	json.Unmarshal([]byte(buf), &result)
	if result["status"] != "open" {
		t.Errorf("status = %v, want \"open\"", result["status"])
	}
}

func TestTicketTriageCommand(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(dir+"/.scratch/m/issues", 0755)
	os.WriteFile(dir+"/.scratch/m/map.md", []byte("# M"), 0644)

	SetCWD(dir)

	createTicketViaCmd(t, "m", "test", "task")

	buf := runCmd(t, []string{"ticket", "triage", "--map", "m", "--id", "1", "--set", "ready-for-agent"})
	var result map[string]any
	json.Unmarshal([]byte(buf), &result)
	if result["triage"] != "ready-for-agent" {
		t.Errorf("triage = %v, want \"ready-for-agent\"", result["triage"])
	}
}

func TestTicketTriageInvalid(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(dir+"/.scratch/m/issues", 0755)
	os.WriteFile(dir+"/.scratch/m/map.md", []byte("# M"), 0644)

	SetCWD(dir)

	createTicketViaCmd(t, "m", "test", "task")

	root := NewRootCmd()
	root.SetOut(new(bytes.Buffer))
	root.SetErr(new(bytes.Buffer))
	root.SetArgs([]string{"ticket", "triage", "--map", "m", "--id", "1", "--set", "invalid"})

	err := root.Execute()
	if err == nil {
		t.Fatal("expected error for invalid triage")
	}
}

func TestTicketBlockingCommand(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(dir+"/.scratch/m/issues", 0755)
	os.WriteFile(dir+"/.scratch/m/map.md", []byte("# M"), 0644)

	SetCWD(dir)

	createTicketViaCmd(t, "m", "first", "task")
	createTicketViaCmd(t, "m", "second", "task")
	createTicketViaCmd(t, "m", "third", "task")

	buf := runCmd(t, []string{"ticket", "blocking", "--map", "m", "--id", "3", "--by", "1,2"})
	var result map[string]any
	json.Unmarshal([]byte(buf), &result)
	blockedBy, ok := result["blocked_by"].([]any)
	if !ok || len(blockedBy) != 2 {
		t.Errorf("blocked_by = %v, want 2 items", result["blocked_by"])
	}
}

func TestTicketBlockingSelfBlocking(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(dir+"/.scratch/m/issues", 0755)
	os.WriteFile(dir+"/.scratch/m/map.md", []byte("# M"), 0644)

	SetCWD(dir)

	createTicketViaCmd(t, "m", "first", "task")

	root := NewRootCmd()
	root.SetOut(new(bytes.Buffer))
	root.SetErr(new(bytes.Buffer))
	root.SetArgs([]string{"ticket", "blocking", "--map", "m", "--id", "1", "--by", "1"})

	err := root.Execute()
	if err == nil {
		t.Fatal("expected error for self-blocking")
	}
}

// Helpers

func createTicketViaCmd(t *testing.T, mapSlug, title, ticketType string) {
	t.Helper()
	runCmd(t, []string{"ticket", "create", "--map", mapSlug, "--title", title, "--type", ticketType})
}

func runCmd(t *testing.T, args []string) string {
	t.Helper()
	buf := new(bytes.Buffer)
	root := NewRootCmd()
	root.SetOut(buf)
	root.SetErr(buf)
	root.SetArgs(args)
	if err := root.Execute(); err != nil {
		t.Fatalf("command %v failed: %v", args, err)
	}
	return buf.String()
}
