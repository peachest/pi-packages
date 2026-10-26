package tracker

import (
	"fmt"
	"strings"
	"testing"
)

func glIssueJSON(iid int, state string, labels []string, description string) string {
	lbls := make([]string, len(labels))
	for i, l := range labels {
		lbls[i] = fmt.Sprintf("%q", l)
	}
	return fmt.Sprintf(`{"iid":%d,"title":"t%d","state":%q,"labels":[%s],"description":%q,"created_at":"2026-01-01T00:00:00Z","web_url":"https://gitlab.example/g/p/-/issues/%d"}`,
		iid, iid, state, strings.Join(lbls, ","), description, iid)
}

func TestGitLabProjectPathEncoding(t *testing.T) {
	r := &fakeRunner{responses: map[string]string{
		"glab api projects/g%2Fp/labels?per_page=100": `[{"name":"map/way"},{"name":"bug"}]`,
	}}
	b := NewGitLabBackend(r, "g/p", "")
	maps, err := b.ListMaps()
	if err != nil {
		t.Fatal(err)
	}
	if len(maps) != 1 || maps[0].Slug != "way" {
		t.Errorf("maps = %+v, want [way]", maps)
	}
}

func TestGitLabListTicketsMapping(t *testing.T) {
	r := &fakeRunner{responses: map[string]string{
		"glab api projects/g%2Fp/issues?state=all&per_page=100&labels=map/way": "[" +
			glIssueJSON(1, "opened", []string{"map/way", "type/task"}, "") + "," +
			glIssueJSON(2, "opened", []string{"map/way", "status/claimed", "triage/ready-for-agent"}, "") + "," +
			glIssueJSON(3, "closed", []string{"map/way"}, "Blocked by: #1") +
			"]",
	}}
	b := NewGitLabBackend(r, "g/p", "")
	tickets, err := b.ListTickets("way", ListFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if tickets[0].Status != "open" || tickets[1].Status != "claimed" || tickets[2].Status != "resolved" {
		t.Errorf("status mapping wrong: %s %s %s", tickets[0].Status, tickets[1].Status, tickets[2].Status)
	}
	if tickets[1].Triage == nil || *tickets[1].Triage != "ready-for-agent" {
		t.Errorf("triage mapping wrong: %v", tickets[1].Triage)
	}
	if fmt.Sprint(tickets[2].BlockedBy) != fmt.Sprint([]string{"1"}) {
		t.Errorf("blocked_by = %v", tickets[2].BlockedBy)
	}
}

func TestGitLabCreateTicket(t *testing.T) {
	r := &fakeRunner{responses: map[string]string{
		"glab api projects/g%2Fp/issues -X POST -f title=Fix it -f description=Blocked by: #3 -f labels=map/way,type/task": glIssueJSON(11, "opened", []string{"map/way", "type/task"}, "Blocked by: #3"),
	}}
	b := NewGitLabBackend(r, "g/p", "")
	ticket, err := b.CreateTicket(TicketOpts{MapSlug: "way", Title: "Fix it", Type: "task", BlockedBy: []string{"3"}})
	if err != nil {
		t.Fatal(err)
	}
	if ticket.ID != "11" {
		t.Errorf("ID = %q, want 11", ticket.ID)
	}
}

func TestGitLabSetStatusStateEvents(t *testing.T) {
	t.Run("close", func(t *testing.T) {
		r := &fakeRunner{responses: map[string]string{
			"glab api projects/g%2Fp/issues/5":                             glIssueJSON(5, "opened", []string{"map/way"}, ""),
			"glab api projects/g%2Fp/issues/5/notes?per_page=100&sort=asc": `[]`,
			"glab api projects/g%2Fp/issues/5 -X PUT -f state_event=close": "",
		}}
		b := NewGitLabBackend(r, "g/p", "")
		if err := b.SetStatus("way", "5", "resolved"); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("reopen clears claimed label", func(t *testing.T) {
		r := &fakeRunner{responses: map[string]string{
			"glab api projects/g%2Fp/issues/5":                                        glIssueJSON(5, "opened", []string{"map/way", "status/claimed"}, ""),
			"glab api projects/g%2Fp/issues/5/notes?per_page=100&sort=asc":            `[]`,
			"glab api projects/g%2Fp/issues/5 -X PUT -f remove_labels=status/claimed": "",
		}}
		b := NewGitLabBackend(r, "g/p", "")
		if err := b.SetStatus("way", "5", "open"); err != nil {
			t.Fatal(err)
		}
	})
}

func TestGitLabCloseVerifyDryRun(t *testing.T) {
	mrJSON := `{"iid":3,"title":"feat","state":"merged","description":"Closes #1, #2","web_url":"https://gitlab.example/g/p/-/merge_requests/3"}`
	commitsJSON := `[{"id":"a1","message":"fixes #3"},{"id":"a2","message":"no refs"}]`
	r := &fakeRunner{responses: map[string]string{
		"glab api projects/g%2Fp/merge_requests/3":                      mrJSON,
		"glab api projects/g%2Fp/merge_requests/3/commits?per_page=100": commitsJSON,
		"glab api projects/g%2Fp/issues/1":                              glIssueJSON(1, "closed", []string{}, ""),
		"glab api projects/g%2Fp/issues/2":                              glIssueJSON(2, "opened", []string{}, ""),
		"glab api projects/g%2Fp/issues/3":                              glIssueJSON(3, "opened", []string{}, ""),
		"glab api projects/g%2Fp/issues/1/notes?per_page=100&sort=asc":  `[]`,
		"glab api projects/g%2Fp/issues/2/notes?per_page=100&sort=asc":  `[]`,
		"glab api projects/g%2Fp/issues/3/notes?per_page=100&sort=asc":  `[]`,
	}}
	b := NewGitLabBackend(r, "g/p", "")

	report, err := b.CloseVerify(CloseVerifyOpts{Ref: "3"})
	if err != nil {
		t.Fatal(err)
	}
	if report.Source != "mr !3" {
		t.Errorf("source = %q", report.Source)
	}
	if len(report.Refs) != 3 {
		t.Fatalf("refs = %+v", report.Refs)
	}
	if !report.Refs[0].Closed || report.Refs[1].Closed || report.Refs[2].Closed {
		t.Errorf("closed flags wrong: %+v", report.Refs)
	}
	if len(report.Applied) != 0 {
		t.Errorf("dry-run must not apply")
	}
}

func TestGitLabCloseVerifyBySHA(t *testing.T) {
	r := &fakeRunner{responses: map[string]string{
		"glab api projects/g%2Fp/repository/commits/abc123":            `{"id":"abc123","message":"merge: Resolves #4","web_url":"https://gitlab.example/g/p/-/commit/abc123"}`,
		"glab api projects/g%2Fp/issues/4":                             glIssueJSON(4, "opened", []string{}, ""),
		"glab api projects/g%2Fp/issues/4/notes?per_page=100&sort=asc": `[]`,
	}}
	b := NewGitLabBackend(r, "g/p", "")
	report, err := b.CloseVerify(CloseVerifyOpts{Ref: "abc123"})
	if err != nil {
		t.Fatal(err)
	}
	if report.Source != "commit abc123" || len(report.Refs) != 1 || report.Refs[0].Issue != "4" {
		t.Errorf("unexpected report: %+v", report)
	}
}

func TestGitLabHostEnv(t *testing.T) {
	// Host override must reach the runner as GITLAB_HOST env entry.
	var gotEnv []string
	b := NewGitLabBackend(envRecorder{&gotEnv}, "g/p", "gitlab.blue.example")
	_, _ = b.ListMaps()
	if len(gotEnv) != 1 || gotEnv[0] != "GITLAB_HOST=gitlab.blue.example" {
		t.Errorf("env = %v", gotEnv)
	}
}

type envRecorder struct{ got *[]string }

func (e envRecorder) Run(env []string, _ string, _ ...string) ([]byte, error) {
	*e.got = env
	return []byte("[]"), nil
}
