package tracker

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func setupTestMap(t *testing.T, root *os.Root, mapSlug string) {
	t.Helper()
	root.MkdirAll(mapSlug+"/issues", 0755)
	root.WriteFile(mapSlug+"/map.md", []byte("# M"), 0644)
}

// newTestRoot creates a temp directory with a .scratch/ subdir and returns an
// os.Root sandboxed to it. The root is closed automatically when the test ends.
func newTestRoot(t *testing.T) *os.Root {
	t.Helper()
	scratchDir := filepath.Join(t.TempDir(), ".scratch")
	if err := os.MkdirAll(scratchDir, 0755); err != nil {
		t.Fatalf("MkdirAll scratch: %v", err)
	}
	root, err := os.OpenRoot(scratchDir)
	if err != nil {
		t.Fatalf("OpenRoot: %v", err)
	}
	t.Cleanup(func() { root.Close() })
	return root
}

func createTestTicket(t *testing.T, root *os.Root, mapSlug, title string, status string, triage *string, blockedBy []string) {
	t.Helper()
	now := time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC)

	// Create if doesn't exist
	tickets, _ := ListTickets(root, mapSlug, ListFilter{})
	if len(tickets) == 0 && len(blockedBy) > 0 {
		// Need to create blockers first — can't block on non-existent
		t.Fatalf("cannot create ticket with blockers in empty map")
	}

	// Create ticket without blockers first
	opts := TicketOpts{MapSlug: mapSlug, Title: title, Type: "task", Triage: triage}
	ticket, err := CreateTicket(root, opts, now)
	if err != nil {
		t.Fatalf("CreateTicket() error = %v", err)
	}

	// If status != open, manually update
	if status != "open" {
		path := TicketPath(mapSlug, ticket.ID+"-"+Slug(title)+".md")
		data, _ := root.ReadFile(path)
		fm, _ := ParseFrontMatter(data)
		fm.Status = status
		if status == "resolved" {
			rt := now
			fm.ResolvedAt = &rt
		}
		fmData, _ := fm.Marshal()
		body := "\n# " + title + "\n\n## Answer\n\ndone\n\n## Comments\n"
		root.WriteFile(path, append(fmData, []byte(body)...), 0644)
	}

	// If has blockers, update front matter (bypass validation since we created without)
	if len(blockedBy) > 0 {
		path := TicketPath(mapSlug, ticket.ID+"-"+Slug(title)+".md")
		data, _ := root.ReadFile(path)
		fm, _ := ParseFrontMatter(data)
		fm.BlockedBy = blockedBy
		fmData, _ := fm.Marshal()
		body := "\n# " + title + "\n\n## Answer\n\n## Comments\n"
		root.WriteFile(path, append(fmData, []byte(body)...), 0644)
	}
}

func TestFrontier(t *testing.T) {
	root := newTestRoot(t)
	setupTestMap(t, root, "m")

	// #01: resolved, #02: open unblocked → in frontier
	createTestTicket(t, root, "m", "resolved-one", "resolved", nil, nil)
	createTestTicket(t, root, "m", "open-unblocked", "open", nil, nil)

	// #03: open, blocked by resolved #01 → in frontier
	createTestTicket(t, root, "m", "blocked-by-resolved", "open", nil, []string{"01"})

	// #04: open, blocked by open #02 → NOT in frontier
	createTestTicket(t, root, "m", "blocked-by-open", "open", nil, []string{"02"})

	// #05: claimed, unblocked → NOT in frontier (status=claimed)
	createTestTicket(t, root, "m", "claimed-one", "claimed", nil, nil)

	// #06: open, triage=needs-info → NOT in frontier
	needsInfo := "needs-info"
	createTestTicket(t, root, "m", "needs-info-one", "open", &needsInfo, nil)

	frontier, err := Frontier(root, "m")
	if err != nil {
		t.Fatalf("Frontier() error = %v", err)
	}

	// Should be #02 (open, unblocked, no triage) and #03 (open, blocked by resolved)
	if len(frontier) != 2 {
		t.Fatalf("got %d frontier tickets, want 2", len(frontier))
	}

	ids := []string{frontier[0].ID, frontier[1].ID}
	if ids[0] != "02" || ids[1] != "03" {
		t.Errorf("frontier IDs = %v, want [02 03]", ids)
	}
}

func TestFrontierWontfixDoesNotUnblock(t *testing.T) {
	root := newTestRoot(t)
	setupTestMap(t, root, "m")

	// #01: open, triage=wontfix (won't be resolved)
	wontfix := "wontfix"
	createTestTicket(t, root, "m", "wontfix-one", "open", &wontfix, nil)

	// #02: open, blocked by wontfix #01 → NOT in frontier (wontfix doesn't unblock)
	createTestTicket(t, root, "m", "blocked-by-wontfix", "open", nil, []string{"01"})

	frontier, err := Frontier(root, "m")
	if err != nil {
		t.Fatalf("Frontier() error = %v", err)
	}

	// #01 is not in frontier (triage=wontfix, not null/ready-for-agent)
	// #02 is not in frontier (blocked by #01 which is not resolved)
	if len(frontier) != 0 {
		t.Fatalf("got %d frontier tickets, want 0", len(frontier))
	}
}

func TestFrontierEmpty(t *testing.T) {
	root := newTestRoot(t)
	setupTestMap(t, root, "m")

	frontier, err := Frontier(root, "m")
	if err != nil {
		t.Fatalf("Frontier() error = %v", err)
	}
	if len(frontier) != 0 {
		t.Errorf("got %d frontier tickets, want 0", len(frontier))
	}
}

func TestComputeFrontierSize(t *testing.T) {
	root := newTestRoot(t)
	setupTestMap(t, root, "m")

	createTestTicket(t, root, "m", "resolved-one", "resolved", nil, nil)
	createTestTicket(t, root, "m", "open-one", "open", nil, nil)

	size, err := ComputeFrontierSize(root, "m")
	if err != nil {
		t.Fatalf("ComputeFrontierSize() error = %v", err)
	}
	if size != 1 {
		t.Errorf("size = %d, want 1", size)
	}
}
