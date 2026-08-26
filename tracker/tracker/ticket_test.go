package tracker

import (
	"errors"
	"testing"
	"time"

	"github.com/google/go-cmp/cmp"
)

func TestCreateTicket(t *testing.T) {
	root := newTestRoot(t)
	root.MkdirAll("test-map/issues", 0755)
	root.WriteFile("test-map/map.md", []byte("# Test Map"), 0644)

	created := time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC)

	// First create a ticket to block on
	CreateTicket(root, TicketOpts{MapSlug: "test-map", Title: "blocker", Type: "task"}, created)

	opts := TicketOpts{
		MapSlug:   "test-map",
		Title:     "Fix bug #123",
		Type:      "task",
		BlockedBy: []string{"01"},
		Triage:    nil,
	}

	ticket, err := CreateTicket(root, opts, created)
	if err != nil {
		t.Fatalf("CreateTicket() error = %v", err)
	}

	if ticket.ID != "02" {
		t.Errorf("ID = %q, want \"02\"", ticket.ID)
	}
	if ticket.Status != "open" {
		t.Errorf("Status = %q, want \"open\"", ticket.Status)
	}
	if ticket.Title != "Fix bug #123" {
		t.Errorf("Title = %q", ticket.Title)
	}
	if !cmp.Equal(ticket.BlockedBy, []string{"01"}) {
		t.Errorf("BlockedBy = %v, want [\"01\"]", ticket.BlockedBy)
	}

	// Verify file was written
	path := "test-map/issues/02-fix-bug-123.md"
	data, err := root.ReadFile(path)
	if err != nil {
		t.Fatalf("ticket file not written: %v", err)
	}

	// Verify front matter
	fm, err := ParseFrontMatter(data)
	if err != nil {
		t.Fatalf("parsing written front matter: %v", err)
	}
	if fm.ID != "02" {
		t.Errorf("written ID = %q, want \"02\"", fm.ID)
	}
	if fm.Status != "open" {
		t.Errorf("written Status = %q, want \"open\"", fm.Status)
	}

	// Verify body skeleton
	body := string(data)
	if !contains(body, "# Fix bug #123") {
		t.Errorf("body missing title heading")
	}
	if !contains(body, "## Answer") {
		t.Errorf("body missing ## Answer")
	}
	if !contains(body, "## Comments") {
		t.Errorf("body missing ## Comments")
	}
}

func TestCreateTicketNumbering(t *testing.T) {
	root := newTestRoot(t)
	root.MkdirAll("m/issues", 0755)
	root.WriteFile("m/map.md", []byte("# M"), 0644)

	// Pre-create ticket 01 and 02
	now := time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC)
	for _, title := range []string{"first", "second"} {
		_, err := CreateTicket(root, TicketOpts{MapSlug: "m", Title: title, Type: "task"}, now)
		if err != nil {
			t.Fatalf("CreateTicket() error = %v", err)
		}
	}

	// Third ticket should be 03
	ticket, err := CreateTicket(root, TicketOpts{MapSlug: "m", Title: "third", Type: "task"}, now)
	if err != nil {
		t.Fatalf("CreateTicket() error = %v", err)
	}
	if ticket.ID != "03" {
		t.Errorf("ID = %q, want \"03\"", ticket.ID)
	}
}

func TestCreateTicketMapNotFound(t *testing.T) {
	root := newTestRoot(t)

	_, err := CreateTicket(root, TicketOpts{MapSlug: "nonexistent", Title: "test", Type: "task"}, time.Now())
	if err == nil {
		t.Fatal("expected error for nonexistent map")
	}
	if !isErr(err, ErrNotFound) {
		t.Errorf("expected ErrNotFound, got %v", err)
	}
}

func TestCreateTicketInvalidType(t *testing.T) {
	root := newTestRoot(t)
	root.MkdirAll("m/issues", 0755)
	root.WriteFile("m/map.md", []byte("# M"), 0644)

	_, err := CreateTicket(root, TicketOpts{MapSlug: "m", Title: "test", Type: "invalid"}, time.Now())
	if err == nil {
		t.Fatal("expected error for invalid type")
	}
	if !isErr(err, ErrInvalidInput) {
		t.Errorf("expected ErrInvalidInput, got %v", err)
	}
}

func TestCreateTicketBlockedByNonExistent(t *testing.T) {
	root := newTestRoot(t)
	root.MkdirAll("m/issues", 0755)
	root.WriteFile("m/map.md", []byte("# M"), 0644)

	_, err := CreateTicket(root, TicketOpts{MapSlug: "m", Title: "test", Type: "task", BlockedBy: []string{"99"}}, time.Now())
	if err == nil {
		t.Fatal("expected error for non-existent blocked_by ID")
	}
	if !isErr(err, ErrInvalidInput) {
		t.Errorf("expected ErrInvalidInput, got %v", err)
	}
}

func TestListTickets(t *testing.T) {
	root := newTestRoot(t)
	root.MkdirAll("m/issues", 0755)
	root.WriteFile("m/map.md", []byte("# M"), 0644)

	now := time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC)
	CreateTicket(root, TicketOpts{MapSlug: "m", Title: "first", Type: "task"}, now)
	CreateTicket(root, TicketOpts{MapSlug: "m", Title: "second", Type: "research"}, now)

	tickets, err := ListTickets(root, "m", ListFilter{})
	if err != nil {
		t.Fatalf("ListTickets() error = %v", err)
	}
	if len(tickets) != 2 {
		t.Fatalf("got %d tickets, want 2", len(tickets))
	}
	if tickets[0].ID != "01" {
		t.Errorf("first ticket ID = %q, want \"01\"", tickets[0].ID)
	}
	if tickets[1].ID != "02" {
		t.Errorf("second ticket ID = %q, want \"02\"", tickets[1].ID)
	}
}

func TestListTicketsFilterStatus(t *testing.T) {
	root := newTestRoot(t)
	root.MkdirAll("m/issues", 0755)
	root.WriteFile("m/map.md", []byte("# M"), 0644)

	now := time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC)
	CreateTicket(root, TicketOpts{MapSlug: "m", Title: "open-one", Type: "task"}, now)

	// Create second ticket and manually set it to resolved
	_, _ = CreateTicket(root, TicketOpts{MapSlug: "m", Title: "resolved-one", Type: "task"}, now)
	path := TicketPath("m", "02-resolved-one.md")
	data, _ := root.ReadFile(path)
	fm, _ := ParseFrontMatter(data)
	fm.Status = "resolved"
	fmData, _ := fm.Marshal()
	root.WriteFile(path, append(fmData, []byte("\n# resolved-one\n\n## Answer\n\ndone\n\n## Comments\n")...), 0644)

	// Filter open only
	open, err := ListTickets(root, "m", ListFilter{Status: "open"})
	if err != nil {
		t.Fatalf("ListTickets() error = %v", err)
	}
	if len(open) != 1 {
		t.Fatalf("got %d open tickets, want 1", len(open))
	}
	if open[0].Title != "open-one" {
		t.Errorf("open ticket title = %q, want \"open-one\"", open[0].Title)
	}

	// Filter resolved only
	resolved, err := ListTickets(root, "m", ListFilter{Status: "resolved"})
	if err != nil {
		t.Fatalf("ListTickets() error = %v", err)
	}
	if len(resolved) != 1 {
		t.Fatalf("got %d resolved tickets, want 1", len(resolved))
	}
}

func TestListTicketsFilterTriageNull(t *testing.T) {
	root := newTestRoot(t)
	root.MkdirAll("m/issues", 0755)
	root.WriteFile("m/map.md", []byte("# M"), 0644)

	now := time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC)
	triage := "ready-for-agent"
	CreateTicket(root, TicketOpts{MapSlug: "m", Title: "with-triage", Type: "task", Triage: &triage}, now)
	CreateTicket(root, TicketOpts{MapSlug: "m", Title: "no-triage", Type: "task"}, now)

	// Filter triage=null
	nullTriage, err := ListTickets(root, "m", ListFilter{TriageNull: true})
	if err != nil {
		t.Fatalf("ListTickets() error = %v", err)
	}
	if len(nullTriage) != 1 {
		t.Fatalf("got %d null-triage tickets, want 1", len(nullTriage))
	}
	if nullTriage[0].Title != "no-triage" {
		t.Errorf("null-triage ticket = %q, want \"no-triage\"", nullTriage[0].Title)
	}
}

func isErr(err, target error) bool {
	return err != nil && (err == target || errors.Is(err, target))
}
