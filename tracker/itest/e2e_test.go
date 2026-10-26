//go:build integration

// Package itest holds real-instance integration tests for the remote ticket
// backends. See README.md in this directory for scope, gating and the
// no-mock-server rationale. Compiled only with -tags=integration.
package itest

import (
	"fmt"
	"os/exec"
	"testing"
	"time"

	"github.com/peachest/pi-packages/tracker/tracker"
)

// runID returns a short per-run suffix for map slugs so concurrent runs
// never collide.
func runID() string {
	return fmt.Sprintf("%d", time.Now().UnixMilli()%100000)
}

// retryRunner wraps a Runner with bounded retries. Corporate-proxy paths to
// api.github.com intermittently return 5xx/transport errors for single
// calls; the operation-level retry absorbs that without weakening real
// assertions.
type retryRunner struct {
	inner tracker.Runner
}

func (r retryRunner) Run(env []string, name string, args ...string) ([]byte, error) {
	var lastErr error
	for attempt := 0; attempt < 4; attempt++ {
		if attempt > 0 {
			time.Sleep(time.Duration(attempt) * 2 * time.Second)
		}
		out, err := r.inner.Run(env, name, args...)
		if err == nil {
			return out, nil
		}
		lastErr = err
	}
	return nil, lastErr
}

// requireCLI skips the suite when the CLI is missing or not logged in.
// Auth is the machine's login state, never managed by the tests.
func requireCLI(t *testing.T, name string, args ...string) {
	t.Helper()
	if _, err := exec.LookPath(name); err != nil {
		t.Skipf("%s not installed; skipping", name)
	}
	if out, err := exec.Command(name, args...).CombinedOutput(); err != nil {
		t.Skipf("%s %s not usable (%v): %s", name, args, err, out)
	}
}

// pollList retries ListTickets until all wantIDs are visible. GitHub's issue
// index is eventually consistent: a create-then-list in the same second can
// miss, and later creates can lag earlier ones by seconds.
func pollList(t *testing.T, b tracker.Backend, mapSlug string, wantIDs ...string) []tracker.TicketSummary {
	t.Helper()
	want := map[string]bool{}
	for _, id := range wantIDs {
		want[id] = true
	}
	deadline := time.Now().Add(15 * time.Second)
	for {
		tickets, err := b.ListTickets(mapSlug, tracker.ListFilter{})
		if err != nil {
			t.Fatalf("ListTickets(%q): %v", mapSlug, err)
		}
		seen := map[string]bool{}
		for _, tk := range tickets {
			seen[tk.ID] = true
		}
		allFound := true
		for id := range want {
			if !seen[id] {
				allFound = false
			}
		}
		if allFound {
			return tickets
		}
		if time.Now().After(deadline) {
			t.Fatalf("tickets %v not all visible via list within 15s (got %v)", wantIDs, ids(tickets))
		}
		time.Sleep(500 * time.Millisecond)
	}
}

// eq asserts got == want, naming the field in the failure message.
func eq(t *testing.T, name string, got, want any) {
	t.Helper()
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("%s = %v, want %v", name, got, want)
	}
}

// runE2E drives the full operation chain against one backend: create → list
// → comment → view → triage → blocking → claimed → resolved, then registers
// deletion of everything it created. deleteIssue performs the
// platform-specific removal (gh issue delete / GitLab DELETE issue API).
func runE2E(t *testing.T, b tracker.Backend, mapSlug string, deleteIssue func(id string)) {
	t.Helper()

	title := "[tracker-itest] " + mapSlug
	a, err := b.CreateTicket(tracker.TicketOpts{
		MapSlug: mapSlug, Title: title + " A", Type: "task", Triage: strPtr("ready-for-agent"),
	})
	if err != nil {
		t.Fatalf("create A: %v", err)
	}
	// Register each deletion immediately after its create succeeds, so a
	// later failure never orphans an already-created ticket.
	t.Cleanup(func() { deleteIssue(a.ID) })

	bside, err := b.CreateTicket(tracker.TicketOpts{
		MapSlug: mapSlug, Title: title + " B", Type: "task",
	})
	if err != nil {
		t.Fatalf("create B: %v", err)
	}
	t.Cleanup(func() { deleteIssue(bside.ID) })

	eq(t, "A.status", a.Status, "open")
	eq(t, "A.triage", deref(a.Triage), "ready-for-agent")
	eq(t, "A.blocked_by", a.BlockedBy, "[]")

	// list: both visible under the run's map label (eventual-consistency retry)
	tickets := pollList(t, b, mapSlug, a.ID, bside.ID)
	if len(tickets) != 2 {
		t.Errorf("list returned %d tickets, want 2", len(tickets))
	}

	// comment → view
	comment := "e2e comment " + mapSlug
	if err := b.AddComment(mapSlug, a.ID, comment); err != nil {
		t.Fatalf("AddComment: %v", err)
	}
	detail, err := b.GetTicket(mapSlug, a.ID)
	if err != nil {
		t.Fatalf("view A: %v", err)
	}
	if len(detail.Comments) != 1 || detail.Comments[0].Body != comment {
		t.Errorf("comments = %+v, want exactly one %q", detail.Comments, comment)
	}

	// triage
	if err := b.SetTriage(mapSlug, a.ID, "needs-info"); err != nil {
		t.Fatalf("SetTriage: %v", err)
	}
	detail, err = b.GetTicket(mapSlug, a.ID)
	if err != nil {
		t.Fatalf("re-view A: %v", err)
	}
	eq(t, "A.triage after set", deref(detail.Triage), "needs-info")

	// blocking: A blocked by B
	if err := b.SetBlocking(mapSlug, a.ID, []string{bside.ID}); err != nil {
		t.Fatalf("SetBlocking: %v", err)
	}
	detail, err = b.GetTicket(mapSlug, a.ID)
	if err != nil {
		t.Fatalf("re-view A: %v", err)
	}
	eq(t, "A.blocked_by after set", detail.BlockedBy, "["+bside.ID+"]")

	// frontier: A is blocked by open B → out; B (open, untriaged) → in.
	frontier, err := b.Frontier(mapSlug)
	if err != nil {
		t.Fatalf("Frontier: %v", err)
	}
	for _, tk := range frontier {
		if tk.ID == a.ID {
			t.Errorf("A must not be on the frontier while blocked by open B")
		}
	}
	if len(frontier) != 1 || frontier[0].ID != bside.ID {
		t.Errorf("frontier = %v, want only B (%s)", ids(frontier), bside.ID)
	}

	// status transitions: claim then resolve
	if err := b.SetStatus(mapSlug, a.ID, "claimed"); err != nil {
		t.Fatalf("SetStatus claimed: %v", err)
	}
	detail, err = b.GetTicket(mapSlug, a.ID)
	if err != nil {
		t.Fatalf("re-view A: %v", err)
	}
	eq(t, "A.status after claim", detail.Status, "claimed")

	if err := b.SetStatus(mapSlug, a.ID, "resolved"); err != nil {
		t.Fatalf("SetStatus resolved: %v", err)
	}
	detail, err = b.GetTicket(mapSlug, a.ID)
	if err != nil {
		t.Fatalf("re-view A: %v", err)
	}
	eq(t, "A.status after resolve", detail.Status, "resolved")
}

func strPtr(s string) *string { return &s }

// deref renders a *string for assertion output (fmt.Sprint of a pointer
// prints an address, not the value).
func deref(s *string) string {
	if s == nil {
		return "<nil>"
	}
	return *s
}

func ids(ts []tracker.TicketSummary) []string {
	out := make([]string, len(ts))
	for i, tk := range ts {
		out[i] = tk.ID
	}
	return out
}
