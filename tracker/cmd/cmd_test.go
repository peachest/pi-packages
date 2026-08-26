package cmd

import (
	"bytes"
	"encoding/json"
	"testing"

	"github.com/spf13/afero"
)

func TestTicketCreateCommand(t *testing.T) {
	fs := afero.NewMemMapFs()
	fs.MkdirAll("/test/.scratch/test-map/issues", 0755)
	afero.WriteFile(fs, "/test/.scratch/test-map/map.md", []byte("# Test Map"), 0644)

	buf := new(bytes.Buffer)
	root := NewRootCmd()
	root.SetOut(buf)
	root.SetErr(buf)
	root.SetArgs([]string{"ticket", "create", "--map", "test-map", "--title", "Test ticket", "--type", "task"})

	// Inject the memmap fs
	SetFS(fs)
	SetCWD("/test")

	err := root.Execute()
	if err != nil {
		t.Fatalf("Execute() error = %v", err)
	}

	output := buf.String()
	var result map[string]any
	if err := json.Unmarshal([]byte(output), &result); err != nil {
		t.Fatalf("output is not valid JSON: %v\noutput: %s", err, output)
	}

	if result["id"] != "01" {
		t.Errorf("id = %v, want \"01\"", result["id"])
	}
	if result["status"] != "open" {
		t.Errorf("status = %v, want \"open\"", result["status"])
	}
	if result["type"] != "task" {
		t.Errorf("type = %v, want \"task\"", result["type"])
	}
}

func TestTicketCreateInvalidType(t *testing.T) {
	fs := afero.NewMemMapFs()
	fs.MkdirAll("/test/.scratch/m/issues", 0755)
	afero.WriteFile(fs, "/test/.scratch/m/map.md", []byte("# M"), 0644)

	buf := new(bytes.Buffer)
	root := NewRootCmd()
	root.SetOut(buf)
	root.SetErr(buf)
	root.SetArgs([]string{"ticket", "create", "--map", "m", "--title", "test", "--type", "invalid"})

	SetFS(fs)
	SetCWD("/test")

	err := root.Execute()
	if err == nil {
		t.Fatal("expected error for invalid type")
	}
}

func TestTicketListCommand(t *testing.T) {
	fs := afero.NewMemMapFs()
	fs.MkdirAll("/test/.scratch/m/issues", 0755)
	afero.WriteFile(fs, "/test/.scratch/m/map.md", []byte("# M"), 0644)

	SetFS(fs)
	SetCWD("/test")

	// Create two tickets
	for _, title := range []string{"first", "second"} {
		buf := new(bytes.Buffer)
		root := NewRootCmd()
		root.SetOut(buf)
		root.SetErr(buf)
		root.SetArgs([]string{"ticket", "create", "--map", "m", "--title", title, "--type", "task"})
		if err := root.Execute(); err != nil {
			t.Fatalf("create error = %v", err)
		}
	}

	// List
	buf := new(bytes.Buffer)
	root := NewRootCmd()
	root.SetOut(buf)
	root.SetErr(buf)
	root.SetArgs([]string{"ticket", "list", "--map", "m"})

	if err := root.Execute(); err != nil {
		t.Fatalf("list error = %v", err)
	}

	var results []map[string]any
	if err := json.Unmarshal([]byte(buf.String()), &results); err != nil {
		t.Fatalf("output not valid JSON array: %v\n%s", err, buf.String())
	}

	if len(results) != 2 {
		t.Fatalf("got %d tickets, want 2", len(results))
	}
	if results[0]["id"] != "01" {
		t.Errorf("first id = %v, want \"01\"", results[0]["id"])
	}
}

func TestTicketListFilterStatus(t *testing.T) {
	fs := afero.NewMemMapFs()
	fs.MkdirAll("/test/.scratch/m/issues", 0755)
	afero.WriteFile(fs, "/test/.scratch/m/map.md", []byte("# M"), 0644)

	SetFS(fs)
	SetCWD("/test")

	// Create ticket
	buf := new(bytes.Buffer)
	root := NewRootCmd()
	root.SetOut(buf)
	root.SetErr(buf)
	root.SetArgs([]string{"ticket", "create", "--map", "m", "--title", "only-one", "--type", "task"})
	root.Execute()

	// List with filter that matches none
	buf = new(bytes.Buffer)
	root = NewRootCmd()
	root.SetOut(buf)
	root.SetErr(buf)
	root.SetArgs([]string{"ticket", "list", "--map", "m", "--status", "resolved"})

	if err := root.Execute(); err != nil {
		t.Fatalf("list error = %v", err)
	}

	var results []map[string]any
	if err := json.Unmarshal([]byte(buf.String()), &results); err != nil {
		t.Fatalf("output not valid JSON: %v", err)
	}

	if len(results) != 0 {
		t.Errorf("got %d tickets, want 0 (filter resolved)", len(results))
	}
}

func TestTicketReviewCommand(t *testing.T) {
	fs := afero.NewMemMapFs()
	fs.MkdirAll("/test/.scratch/m/issues", 0755)
	afero.WriteFile(fs, "/test/.scratch/m/map.md", []byte("# M"), 0644)

	SetFS(fs)
	SetCWD("/test")

	// Create a ticket
	buf := new(bytes.Buffer)
	root := NewRootCmd()
	root.SetOut(buf)
	root.SetErr(buf)
	root.SetArgs([]string{"ticket", "create", "--map", "m", "--title", "to-review", "--type", "task"})
	if err := root.Execute(); err != nil {
		t.Fatalf("create error = %v", err)
	}

	// Review it
	buf = new(bytes.Buffer)
	root = NewRootCmd()
	root.SetOut(buf)
	root.SetErr(buf)
	root.SetArgs([]string{"ticket", "review", "--map", "m", "--id", "1"})
	if err := root.Execute(); err != nil {
		t.Fatalf("review error = %v", err)
	}

	var result map[string]any
	if err := json.Unmarshal([]byte(buf.String()), &result); err != nil {
		t.Fatalf("output not valid JSON: %v", err)
	}
	if result["reviewed_at"] == nil {
		t.Error("reviewed_at should not be nil after review")
	}
}

